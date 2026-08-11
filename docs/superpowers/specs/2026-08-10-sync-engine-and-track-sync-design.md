# SmartTube Bridge — Sync Engine, Bidirectional Track Sync, Seek Bar & Collapsible Bar

**Date:** 2026-08-10
**Status:** Approved for implementation
**Target device (validated against):** Acer R4_GTV (`192.168.1.136:5555`), SmartTube `org.smarttube.stable`

---

## Problem

Four user-reported issues:

1. TV and laptop fall out of sync on track change — laptop stays on the old song while the TV
   moves to the next one. Sync should be bidirectional.
2. The extension's custom seek bar has no thumbnail preview or scrub feedback.
3. Playback sync has a persistent delay; the Sync button does not visibly work.
4. The bottom bar is large and always expanded, cluttering the YouTube page.

## Root causes (empirically confirmed on the target device)

### RC1 — Reported TV position is stale

`AdbService.ParsePlaybackPosition` reads only the `position=` field from the
`dumpsys media_session` PlaybackState line. On Android that field is a **snapshot**, valid as of
the `updated=` timestamp (device `elapsedRealtime`, ms). Real position while playing is:

```
realPositionMs = position + (deviceNowMs - updated) * speed
```

Observed live samples on the target device:

| raw `position` | `updated` | device now | staleness | speed |
|---|---|---|---|---|
| 10021 ms | 312846862 | 312929450 | **82 588 ms** | 1.0 |
| 42841 ms | — | — | **3 213 ms** | 1.0 |

An 82-second error explains every symptom in issue 3. This is the primary defect.

`speed=0.0` when paused, so the same formula is correct in the paused case with no special-casing.

### RC2 — TV seek is a full app relaunch

`AdbService.SeekToAsync` seeks by firing an `am start` VIEW intent with `&t=<seconds>`, which
restarts SmartTube's player (2–5 s reload + buffer). Confirmed there is no cheaper path:
`cmd media_session dispatch` supports only `play, pause, play-pause, mute, headsethook, stop,
next, previous, rewind, record, fast-forward` — no `seekTo`, despite the session advertising
`ACTION_SEEK_TO` in its `actions=2360191` mask.

**Consequence for design:** never correct drift by seeking the TV. Correct the laptop instead.

### RC3 — Sync button pushes the wrong direction

`syncNow` reads the laptop position and re-seeks the **TV** to it, incurring RC2's 2–5 s relaunch
on every press. Combined with RC1 it aligns to a stale target, so it appears not to work at all.

### RC4 — Sync poll only runs in one mode

`startSyncPoll` early-returns unless `playbackMode === 'synced'`, and `bindLaptopSeekHandlers`
early-returns for `tvOnly`. In "TV only" mode no sync logic runs whatsoever.

### RC5 — No TV→laptop track detection

Only laptop→TV exists (`handleLaptopEnded` → `goToYouTubeNext`). Nothing observes the TV.

---

## Design

### 1. Sync engine

**1a. Extrapolate position at the service.** Parse `position`, `updated`, and `speed` from the
PlaybackState line. Read the device clock in the *same* ADB round trip via `cat /proc/uptime`
(first field, seconds → ms; same clock domain as `updated`, verified). Return both the raw and
the extrapolated value plus staleness so the client can reason about confidence.

**1b. Dead-reckoning clock in the extension.** Each successful sample sets an anchor
`(tvSec, performance.now())`. Between samples the TV position is predicted locally. This makes a
2 s poll more accurate than the current 1 s poll while halving ADB load.

**1c. Drift correction on the laptop, never the TV** (forced by RC2). When
`|laptopPos − predictedTvPos|` exceeds:
- `> 0.75 s` → silent micro-seek on the laptop
- `> 2.0 s` → hard seek on the laptop

`playbackRate` is never modified — a prior attempt made laptop audio sound slow and was reverted
(see the comment at `applyTimeBridge`). That constraint is preserved.

**1d. Invert the Sync button.** Sync now means *snap the laptop to the TV*: read the predicted TV
position and seek the laptop there. Completes in <100 ms with no TV relaunch. The TV is re-seeked
only on an explicit user drag of the YouTube progress bar.

**1e. Poll in every mode, gate the actions.** The poll always runs while a cast session is active
(track-change detection needs it in all modes). Mode governs what it does:

| Mode | Laptop audio/video | Sync actions |
|---|---|---|
| `synced` ("both") | plays | full mirror: pause/play mirroring + drift correction |
| `tvOnly` ("only TV") | paused + muted | track detection and UI only |
| `independent` ("only laptop") | plays normally | none — zero interference |

### 2. Bidirectional track sync — dynamic master

Arbitration rule (user's): **whichever side advances first is master for that transition.**

```
laptop videoId changes ──┐
                         ├─→ first mover claims master for 8 s
TV metadata changes    ──┘     the other side follows; its own change event is suppressed
```

The 8-second lock prevents ping-pong (each side chasing the other).

- **Laptop wins** → cast the new `videoId` to the TV. Exact, fully reliable.
- **TV wins** → only title/artist are available, not a video ID. Resolve in two steps:
  1. Match the title against the current Mix / Up-Next queue in the page DOM and click it —
     reliable, since both sides draw from the same queue.
  2. Fallback: YouTube search for the title, play the top result.

TV metadata is available and confirmed populated:
`metadata: size=6, description=Aditya Rikhari - Paaro (Official Video), Aditya Rikhari, null`
→ `description=<title>, <artist>, <null>`.

`PlaybackPosition` gains `Title` and `Artist`. A `cmd media_session monitor` push channel was
evaluated and **rejected** — it produced no output through `adb shell` even across a real track
change. Polling remains.

### 3. Seek bar

Remove the custom `Seek` row entirely. YouTube's native progress bar becomes the single control
surface — thumbnail preview, chapters, and hover scrub come free and always match the real video.
The extension listens to `seeked` on the video element and pushes user drags to the TV.

Mode behaviour is preserved exactly as stated in the table in 1e.

### 4. Collapsible bar

- Renders **collapsed by default on every page load**; expanded state is deliberately not persisted.
- Collapsed form: a small pill — `SmartTube ●` + expand chevron.
- Auto-expands when casting starts; auto-collapses when casting stops ("only laptop").
- Manual toggle works and lasts for the current page only.

---

## Component boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `AdbService.GetPlaybackPositionAsync` | One ADB round trip → raw position, `updated`, `speed`, title, artist | adb binary |
| `PlaybackPosition` | Transport model incl. extrapolated position + staleness | — |
| `MediaController.GetPosition` | Exposes extrapolated position and metadata over HTTP | MediaCommandService |
| `tvClock` (extension) | Anchor + dead-reckoning prediction of TV position | position endpoint |
| `driftCorrector` (extension) | Compares laptop vs predicted TV, seeks the laptop | `tvClock` |
| `trackArbiter` (extension) | Dynamic-master race + 8 s lock, resolves TV title → laptop track | `tvClock`, DOM queue |
| `bar` (extension) | Collapsed/expanded rendering and mode UI | — |

## Testing

- Unit-testable at the service: PlaybackState parsing and extrapolation, against captured real
  dump lines from the target device (both PLAYING and PAUSED variants).
- Extension behaviour requires the live TV; verified manually against `192.168.1.136:5555`.

## Non-goals

- Absolute TV seek without app relaunch — not available on this platform (RC2).
- Pushing whole playlists to the TV up front — rejected during design; breaks on shuffle/skip.
- `playbackRate`-based drift correction — previously tried and reverted.
