(function () {
  'use strict';

  const BAR_ID = 'smarttube-player-bar';
  const STYLE_ID = 'smarttube-player-bar-style';
  /** @typedef {'tvOnly'|'synced'|'independent'} PlaybackMode */

  /** @type {PlaybackMode} */
  let playbackMode = 'tvOnly';
  let castingSession = false;
  let castInFlight = false;
  let lastVideoId = null;
  let syncingFromTv = false;
  let seekingUi = false;
  let lastSeekPushMs = 0;
  /** Prevents double next-video handling for one ending. */
  let endHandled = false;
  /** TV paused near end so SmartTube does not autoplay its own queue. */
  let tvHeldAtEnd = false;
  /** Shared paused flag in synced mode (either side initiated). */
  let syncedPaused = false;
  /** Ignore pause/play events we caused programmatically. */
  let applyingRemotePause = false;

  /** @type {ReturnType<typeof setInterval>|null} */
  let volumeHoldTimer = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let keepPauseTimer = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let syncPollTimer = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let seekUiTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let seekDebounce = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let nextVideoTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let seekAlignTimer = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let navTickTimer = null;

  /** TV seek settle delay (ms). Used when manualDelay is on; otherwise auto-calibrated. */
  let seekDelayMs = 4200;
  let seekAlignInProgress = false;
  /** When false, auto-wait for TV + continuous bridge (hide delay slider). */
  let manualDelay = false;
  /** Smoothed auto-measured TV seek settle time. */
  let autoDelayMs = 4200;
  let lastBridgeSnapMs = 0;
  /**
   * Lag compensation (no slow-motion — both always 1.0x).
   * delayLaptopMs: hold laptop after TV starts (TV was behind).
   * delayTvMs: hold TV after laptop starts (laptop was behind).
   * delayCompEnabled: Delay Off turns this off to test raw sync.
   */
  let delayCompEnabled = true;
  let delayLaptopMs = 1350;
  let delayTvMs = 0;

  function reportShift(held) {
    try { chrome.runtime.sendMessage({ action: 'shiftState', held: !!held }); } catch { /* */ }
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') reportShift(true); }, true);
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') reportShift(false); }, true);
  window.addEventListener('blur', () => reportShift(false));

  function extractVideoId(url = location.href) {
    const m = String(url).match(
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function isWatchPage() {
    return !!extractVideoId();
  }

  /** Playlist id of the tab, or null when watching a standalone video. */
  function currentPlaylistId() {
    try {
      const list = new URL(location.href).searchParams.get('list');
      return list && list.trim() ? list.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * Cast URL carrying the playlist when there is one, so SmartTube queues the same
   * songs the laptop has rather than its own Related list.
   */
  function buildCastUrl(videoId) {
    const list = currentPlaylistId();
    return list
      ? `https://www.youtube.com/watch?v=${videoId}&list=${encodeURIComponent(list)}`
      : `https://www.youtube.com/watch?v=${videoId}`;
  }

  function getLaptopVideo() {
    return document.querySelector('#movie_player video.html5-main-video')
      || document.querySelector('#movie_player video')
      || document.querySelector('ytd-player video');
  }

  function getYtPlayer() {
    return document.getElementById('movie_player');
  }

  function restoreLaptopAudio() {
    const v = getLaptopVideo();
    try {
      const p = getYtPlayer();
      if (p?.unMute) p.unMute();
      if (p?.isMuted?.() && p.unMute) p.unMute();
      if (typeof p?.getVolume === 'function' && typeof p?.setVolume === 'function') {
        if (p.getVolume() === 0) p.setVolume(100);
      }
    } catch { /* */ }
    if (!v) return;
    try {
      v.muted = false;
      if (!(v.volume > 0)) v.volume = 1;
    } catch { /* */ }
  }

  function resetLaptopRate() {
    try {
      const v = getLaptopVideo();
      if (v) v.playbackRate = 1;
    } catch { /* */ }
  }

  function pauseLaptop({ mute = null } = {}) {
    try {
      const p = getYtPlayer();
      if (p?.pauseVideo) p.pauseVideo();
    } catch { /* */ }
    const v = getLaptopVideo();
    if (!v) return;
    try {
      if (!v.paused) v.pause();
      // Only mute in TV-only mode. Synced uses both speakers — never leave mute stuck.
      const shouldMute = mute != null ? mute : (playbackMode === 'tvOnly' && castingSession);
      if (shouldMute) v.muted = true;
    } catch { /* */ }
  }

  function playLaptop() {
    try {
      const p = getYtPlayer();
      if (p?.playVideo) p.playVideo();
    } catch { /* */ }
    const v = getLaptopVideo();
    if (!v) return;
    try {
      v.loop = false;
      v.playbackRate = 1;
      if (playbackMode === 'tvOnly' && castingSession) {
        v.muted = true;
      } else {
        restoreLaptopAudio();
      }
      if (v.paused) {
        const p = v.play();
        if (p?.catch) p.catch(() => {});
      }
    } catch { /* */ }
  }

  /** Ignore YouTube seeked events after we programmatically move the playhead. */
  let ignoreUserSeekUntil = 0;

  function blockUserSeekEvents(ms = 3500) {
    ignoreUserSeekUntil = Date.now() + Math.max(0, ms);
    syncingFromTv = true;
    setTimeout(() => { syncingFromTv = false; }, Math.min(ms, 1200));
  }

  /**
   * blockMs must stay just long enough to swallow the `seeked` events this call
   * itself generates. Drift corrections run every 2s, so a long block here would
   * make genuine user seeks undetectable — that is exactly what broke seeking.
   */
  function seekLaptopSeconds(sec, { force = false, blockMs = 3500 } = {}) {
    // Never rewind the laptop from TV near the start — that causes the end→0 loop.
    if (!force) {
      const local = laptopPositionSec();
      const dur = laptopDurationSec();
      if (sec < 2 && local > 8) return;
      if (dur > 0 && local > dur - 5) return;
    }

    blockUserSeekEvents(blockMs);
    try {
      const p = getYtPlayer();
      if (p?.seekTo) p.seekTo(sec, true);
      const v = getLaptopVideo();
      if (v && Number.isFinite(sec)) v.currentTime = sec;
    } catch { /* */ }
  }

  function pauseTv() {
    return api('media', { endpoint: 'pause' }).catch(() => {});
  }

  function playTv() {
    return api('media', { endpoint: 'play' }).catch(() => {});
  }

  function withRemotePauseGuard(fn) {
    applyingRemotePause = true;
    try { fn(); } finally {
      setTimeout(() => { applyingRemotePause = false; }, 600);
    }
  }

  function goToYouTubeNext() {
    try {
      const p = getYtPlayer();
      if (typeof p?.nextVideo === 'function') {
        p.nextVideo();
        return true;
      }
    } catch { /* */ }

    const btn =
      document.querySelector('.ytp-next-button:not([disabled])') ||
      document.querySelector('a.ytp-next-button') ||
      document.querySelector('button.ytp-next-button');
    if (btn) {
      btn.click();
      return true;
    }

    // Fall back: click Autoplays / Up Next card if visible.
    const upNext =
      document.querySelector('ytd-compact-autoplay-renderer a#thumbnail') ||
      document.querySelector('ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer a#thumbnail') ||
      document.querySelector('#related ytd-compact-video-renderer a#thumbnail');
    if (upNext) {
      upNext.click();
      return true;
    }
    return false;
  }

  async function handleLaptopEnded() {
    if (!(castingSession && playbackMode === 'synced') || endHandled) return;
    // The TV already claimed this transition and we're following it — don't also
    // drive a next-track from this side, or the two chase each other.
    if (masterLockHeldBy('laptop')) return;
    claimMaster('laptop');
    endHandled = true;
    tvHeldAtEnd = true;
    setStatus('Playing next (YouTube Up Next)…', 'busy');
    await pauseTv();

    // Let YouTube autoplay fire; if it does not, force next.
    clearTimeout(nextVideoTimer);
    nextVideoTimer = setTimeout(() => {
      if (!castingSession || playbackMode !== 'synced') return;
      const stillSame = extractVideoId() === lastVideoId;
      if (stillSame) goToYouTubeNext();
    }, 900);

    // Extra nudge if still stuck on same video.
    setTimeout(() => {
      if (!castingSession || playbackMode !== 'synced') return;
      if (extractVideoId() === lastVideoId) goToYouTubeNext();
    }, 2500);
  }

  function bindSyncedEndHandlers(v) {
    if (!v || v.dataset.stbSyncedBound === '1') return;
    v.dataset.stbSyncedBound = '1';
    v.loop = false;

    v.addEventListener('ended', () => { handleLaptopEnded(); });

    v.addEventListener('timeupdate', () => {
      if (!(castingSession && playbackMode === 'synced') || endHandled) return;
      const dur = v.duration;
      if (!Number.isFinite(dur) || dur < 8) return;
      const left = dur - v.currentTime;
      // Pause TV before SmartTube reaches its own autoplay / Related.
      if (left <= 3 && !tvHeldAtEnd) {
        tvHeldAtEnd = true;
        pauseTv();
      }
      // Some builds never fire `ended` cleanly — treat near-end as ended.
      if (left <= 0.35) handleLaptopEnded();
    });

    // Laptop pause/play → TV (spacebar, click, etc.)
    v.addEventListener('pause', () => {
      if (!(castingSession && playbackMode === 'synced')) return;
      if (applyingRemotePause || endHandled || tvHeldAtEnd || seekAlignInProgress || v.ended) return;
      syncedPaused = true;
      pauseTv();
      setStatus('Paused (both)', 'ok');
    });
    v.addEventListener('play', () => {
      if (!(castingSession && playbackMode === 'synced')) return;
      if (applyingRemotePause || endHandled || tvHeldAtEnd || seekAlignInProgress) return;
      syncedPaused = false;
      playTv();
      setStatus('Playing (both)', 'ok');
    });
  }

  function laptopDurationSec() {
    try {
      const p = getYtPlayer();
      if (p?.getDuration) {
        const d = p.getDuration();
        if (d > 0) return d;
      }
    } catch { /* */ }
    const v = getLaptopVideo();
    return v && v.duration > 0 ? v.duration : 0;
  }

  function laptopPositionSec() {
    try {
      const p = getYtPlayer();
      if (p?.getCurrentTime) return p.getCurrentTime() || 0;
    } catch { /* */ }
    return getLaptopVideo()?.currentTime || 0;
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  /**
   * True once this content script has been orphaned — i.e. the extension was
   * reloaded/updated while this tab kept running the old script. Every
   * chrome.runtime call then throws "Extension context invalidated", and the
   * 2s poll turns that into an endless stream of uncaught promise rejections.
   */
  let contextDead = false;

  function extensionAlive() {
    try {
      return !contextDead && !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  /** Stop every timer and tell the user, exactly once. */
  function handleDeadContext() {
    if (contextDead) return;
    contextDead = true;

    stopSyncPoll();
    stopKeepPaused();
    clearInterval(volumeHoldTimer);
    clearTimeout(seekDebounce);
    clearTimeout(nextVideoTimer);
    clearTimeout(seekAlignTimer);
    clearInterval(tvBarTimer);
    clearInterval(volumeRefreshTimer);
    if (navTickTimer) clearInterval(navTickTimer);

    // Leave the tab in a sane state rather than half-controlled.
    try { resetLaptopRate(); restoreLaptopAudio(); } catch { /* */ }
    setStatus('Extension reloaded — refresh this page (F5)', 'error');
  }

  async function api(action, payload = {}) {
    if (!extensionAlive()) {
      handleDeadContext();
      return null;
    }
    try {
      return await chrome.runtime.sendMessage({ action, ...payload });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('Extension context invalidated') ||
          msg.includes('Receiving end does not exist') ||
          msg.includes('message port closed')) {
        handleDeadContext();
        return null;
      }
      throw e;
    }
  }

  async function pushSeekToTv(sec) {
    const videoId = extractVideoId();
    if (!videoId) return;
    const ms = Math.max(0, Math.round(sec * 1000));
    lastSeekPushMs = Date.now();
    return api('seek', { positionMs: ms, videoId });
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      seekAlignTimer = setTimeout(resolve, Math.max(0, ms));
    });
  }

  function effectiveSeekDelay() {
    return manualDelay ? Math.max(0, Number(seekDelayMs) || 0) : Math.max(500, Number(autoDelayMs) || 4200);
  }

  /**
   * Wait until SmartTube is playing near the target (auto lag calibration).
   * Falls back to effectiveSeekDelay() timeout.
   */
  async function waitForTvReady(targetSec) {
    const started = Date.now();
    const maxWait = Math.max(effectiveSeekDelay() + 2000, 8000);
    let sawNear = false;

    while (Date.now() - started < maxWait) {
      if (!castingSession) break;
      try {
        const resp = await api('position', {});
        const d = resp?.data;
        if (d?.available) {
          const tvSec = (d.positionMs || 0) / 1000;
          const near = Math.abs(tvSec - targetSec) <= 4 || (tvSec >= targetSec - 1 && tvSec <= targetSec + 10);
          if (near) sawNear = true;
          if (near && d.isPlaying && tvSec >= Math.max(0, targetSec - 1.5)) {
            const elapsed = Date.now() - started;
            // EMA so one slow seek doesn't permanently inflate delay
            autoDelayMs = Math.round(autoDelayMs * 0.65 + elapsed * 0.35);
            autoDelayMs = Math.min(10000, Math.max(800, autoDelayMs));
            if (!manualDelay) {
              seekDelayMs = autoDelayMs;
              updateDelayUi();
              chrome.storage.sync.set({ autoDelayMs, seekDelayMs }).catch(() => {});
            }
            return elapsed;
          }
        }
      } catch { /* */ }
      await sleep(250);
    }
    const elapsed = Date.now() - started;
    if (sawNear && !manualDelay) {
      autoDelayMs = Math.round(autoDelayMs * 0.7 + elapsed * 0.3);
      autoDelayMs = Math.min(10000, Math.max(800, autoDelayMs));
    }
    return elapsed;
  }

  // Note: drift is corrected by seeking the laptop (see correctDrift), never by
  // changing playbackRate — that made songs sound slow on the laptop while the TV
  // stayed at normal speed.

  /** Read TV clock; return seconds or null. */
  async function readTvSeconds() {
    const s = await sampleTv();
    return s ? s.tvSec : null;
  }

  // ── TV clock (dead reckoning) ──────────────────────────────────────────────
  // The service now extrapolates the dumpsys snapshot to "now", but samples still
  // cost an ADB round trip. Anchoring each sample and predicting locally between
  // them gives better accuracy at half the polling rate.
  let tvAnchorSec = null;
  let tvAnchorAt = 0;
  let tvAnchorPlaying = false;

  /** One position sample; also refreshes the anchor and feeds the track arbiter. */
  async function sampleTv() {
    try {
      const resp = await api('position', {});
      const d = resp?.data;
      if (!d?.available || !Number.isFinite(d.positionMs)) return null;

      const tvSec = Math.max(0, d.positionMs / 1000);
      tvAnchorSec = tvSec;
      tvAnchorAt = performance.now();
      tvAnchorPlaying = d.isPlaying === true;

      detectTvTransition(tvSec, tvAnchorPlaying, d.title, d.artist);

      return {
        tvSec,
        isPlaying: tvAnchorPlaying,
        title: d.title || null,
        artist: d.artist || null,
        stalenessMs: Number(d.stalenessMs) || 0,
      };
    } catch {
      return null;
    }
  }

  /** Predicted TV position right now, or null if we have no anchor yet. */
  function predictedTvSec() {
    if (tvAnchorSec == null) return null;
    if (!tvAnchorPlaying) return tvAnchorSec;
    return tvAnchorSec + (performance.now() - tvAnchorAt) / 1000;
  }

  function resetTvClock() {
    tvAnchorSec = null;
    tvAnchorAt = 0;
    tvAnchorPlaying = false;
    // Forget the previous position too, or the jump to a new track's 0:00 would
    // register as a rewind and fire a second, spurious transition.
    lastTvSampleSec = null;
  }

  // ── Track arbiter (dynamic master) ─────────────────────────────────────────
  // Whichever side advances first owns the transition. An 8s lock stops the two
  // sides from chasing each other into a ping-pong loop.
  const MASTER_LOCK_MS = 8000;
  let masterSide = null;      // 'laptop' | 'tv'
  let masterUntil = 0;
  let lastTvTitle = null;
  /** While set, page navigations are TV-driven and must not trigger a re-cast. */
  let followingTvUntil = 0;
  /**
   * Set when a mid-track change on the TV shows the user picked a song by hand.
   * While true the laptop playlist stops asserting itself. Any deliberate action on
   * the laptop side — cast, recast, sync, or manually opening another video — hands
   * authority back to the playlist.
   */
  let tvManualOverride = false;

  function restoreLaptopAuthority(reason) {
    if (!tvManualOverride) return;
    tvManualOverride = false;
    if (reason) setStatus(reason, 'ok');
  }

  function masterLockHeldBy(side) {
    return Date.now() < masterUntil && masterSide !== side;
  }

  let laptopPriorityTimer = null;

  function claimMaster(side) {
    masterSide = side;
    masterUntil = Date.now() + MASTER_LOCK_MS;
    if (side === 'laptop') armLaptopPriorityFallback();
  }

  /**
   * The laptop gets first refusal on every transition. But if it never actually
   * starts playing — autoplay blocked, queue exhausted, tab throttled — holding the
   * lock would leave the two sides stuck on different songs. So if the laptop has
   * not started within 6s, hand the transition to the TV and follow whatever it
   * moved on to.
   */
  function armLaptopPriorityFallback() {
    clearTimeout(laptopPriorityTimer);
    laptopPriorityTimer = setTimeout(async () => {
      if (!castingSession || contextDead) return;
      if (masterSide !== 'laptop') return;

      const v = getLaptopVideo();
      const laptopPlaying = !!v && !v.paused && !v.ended && v.currentTime > 0;
      // In TV-only the laptop is paused by design — never treat that as a stall.
      if (laptopPlaying || playbackMode === 'tvOnly') return;

      const s = await sampleTv();
      if (!s?.title) return;

      masterSide = null;
      masterUntil = 0;
      setStatus('Laptop did not start — following TV', 'busy');
      claimMaster('tv');
      lastTvTitle = s.title;
      followTvTrack(s.title, s.artist);
    }, 6000);
  }

  function normalizeTitle(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\((official|lyrical|full)?\s*(video|audio|song|music video|visualizer)\)/g, '')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/[|].*$/, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** Last position we saw, used to spot the rewind that means "new track". */
  let lastTvSampleSec = null;
  let lastTransitionAt = 0;

  /**
   * Decide whether the TV moved to a different track.
   *
   * Metadata cannot be relied on: this SmartTube build reports
   * `description=null, null, null` indefinitely, so a title-only trigger never
   * fires. A large backwards jump in position while playing is the signal that
   * actually works — a track can only rewind that far by restarting.
   */
  function detectTvTransition(tvSec, isPlaying, title, artist) {
    const prev = lastTvSampleSec;
    lastTvSampleSec = tvSec;

    const titleChanged = !!title && lastTvTitle !== null && title !== lastTvTitle;
    if (title) lastTvTitle = title;

    // A rewind we did not ask for = the TV started something new. Measured on the
    // real device, a track change lands as 10021ms -> 0ms, so a fixed 15s threshold
    // misses changes that happen early in a track. Treat "snapped back to the top"
    // as a transition in its own right.
    const rewound = prev != null && isPlaying && (
      (tvSec < 5 && prev > 7) ||   // restarted from the beginning
      tvSec < prev - 15            // jumped a long way back
    );

    if (!titleChanged && !rewound) return;
    // Our own seeks rewind the TV too — those are not track changes.
    if (userIsDrivingSeek() || seekAlignInProgress) return;
    // One transition at a time; SmartTube emits several samples per change.
    if (Date.now() - lastTransitionAt < 6000) return;
    lastTransitionAt = Date.now();

    onTvTrackChanged(title, artist, prev);
  }

  /**
   * Was the TV close enough to the end that this transition is a natural
   * auto-advance rather than someone picking a different song on the remote?
   *
   * SponsorBlock cuts outros, so the TV can legitimately finish well before the
   * nominal duration — hence a proportional threshold rather than "within N seconds
   * of the end". A mid-track jump is what identifies a deliberate manual change.
   */
  function looksLikeNaturalEnd(prevSec) {
    if (prevSec == null) return true;          // no history — assume auto-advance
    const dur = laptopDurationSec();
    if (!(dur > 0)) return true;               // can't judge — don't fight the playlist
    return prevSec >= dur * 0.6;
  }

  /**
   * The TV advanced. Who supplies the next song depends on whether the laptop has a
   * playlist:
   *  - playlist present -> the laptop's queue is the source of truth, so advance it
   *    and cast that. This is what makes SponsorBlock's early endings work: the TV
   *    finishing early is simply the cue to move the laptop on.
   *  - no playlist -> nothing to advance, so follow whatever the TV picked (needs a
   *    title; without one there is no way to know what is playing).
   */
  function onTvTrackChanged(title, artist, prevSec) {
    if (!castingSession || playbackMode === 'independent') return;

    const hasPlaylist = !!currentPlaylistId();

    if (hasPlaylist && !tvManualOverride) {
      if (looksLikeNaturalEnd(prevSec)) {
        // Natural end (including a SponsorBlock-shortened one): the laptop playlist
        // decides what comes next, and casting it brings the TV along.
        claimMaster('laptop');
        setStatus('TV finished — next from laptop playlist…', 'busy');
        endHandled = true;
        tvHeldAtEnd = false;
        if (!goToYouTubeNext()) {
          setStatus('Could not advance laptop playlist', 'error');
        }
        return;
      }

      // Mid-track jump: someone chose a different song on the remote. Hand control
      // over rather than yanking the TV back to the playlist and fighting the user.
      tvManualOverride = true;
      setStatus('TV changed manually — playlist paused', 'busy');
    }

    if (title) {
      claimMaster('tv');
      followTvTrack(title, artist);
    } else {
      setStatus('TV changed track (title unavailable)', 'busy');
    }
  }

  /**
   * TV moved to a new track on its own. Only title/artist are available (no video
   * id), so match against the on-page queue first — both sides draw from the same
   * Mix, which makes that match exact in practice — and fall back to search.
   */
  function followTvTrack(title, artist) {
    setStatus(`TV changed track — following…`, 'busy');
    const want = normalizeTitle(title);
    if (!want) return;

    // Marks the navigation we are about to trigger as TV-driven, so onVideoChanged
    // does not bounce the same video straight back at the TV.
    followingTvUntil = Date.now() + 12000;

    const candidates = document.querySelectorAll(
      'ytd-playlist-panel-video-renderer a#wc-endpoint, ' +
      'ytd-compact-video-renderer a#thumbnail, ' +
      'ytd-playlist-panel-video-renderer #video-title'
    );

    for (const el of candidates) {
      const label = el.getAttribute('title') || el.textContent || '';
      const got = normalizeTitle(label);
      if (!got) continue;
      if (got === want || got.includes(want) || want.includes(got)) {
        const clickable = el.closest('a') || el;
        endHandled = true;          // suppress our own end-of-track handler
        tvHeldAtEnd = false;
        clickable.click();
        setStatus(`Following TV: ${title}`, 'ok');
        return;
      }
    }

    // Not in the visible queue — search, then open the top hit. The results page is
    // a fresh document, so the intent has to survive navigation; sessionStorage is
    // per-tab and cleared when the tab closes, which is exactly the lifetime we want.
    const query = artist ? `${title} ${artist}` : title;
    try {
      sessionStorage.setItem(PENDING_FOLLOW_KEY, JSON.stringify({
        title,
        at: Date.now(),
      }));
    } catch { /* private mode — search page will just sit there */ }

    setStatus(`Searching laptop for: ${title}`, 'busy');
    location.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  }

  const PENDING_FOLLOW_KEY = 'stb-pending-follow';

  /**
   * Runs on the search-results page after followTvTrack navigated here: opens the
   * first real video hit so the track actually plays, instead of leaving the user
   * staring at a list of results.
   */
  function resumePendingFollow() {
    if (!location.pathname.startsWith('/results')) return;

    let pending = null;
    try {
      const raw = sessionStorage.getItem(PENDING_FOLLOW_KEY);
      if (!raw) return;
      pending = JSON.parse(raw);
    } catch {
      return;
    }
    // Stale intent (tab left open, user searched something else later).
    if (!pending?.title || Date.now() - (pending.at || 0) > 60000) {
      try { sessionStorage.removeItem(PENDING_FOLLOW_KEY); } catch { /* */ }
      return;
    }

    const deadline = Date.now() + 10000;
    const tryClick = () => {
      if (Date.now() > deadline) {
        try { sessionStorage.removeItem(PENDING_FOLLOW_KEY); } catch { /* */ }
        return;
      }
      // Skip ads/shelves — take the first genuine video renderer.
      const hit = document.querySelector('ytd-video-renderer a#video-title[href*="/watch?v="]')
        || document.querySelector('a#video-title[href*="/watch?v="]')
        || document.querySelector('ytd-video-renderer a#thumbnail[href*="/watch?v="]');
      if (hit) {
        try { sessionStorage.removeItem(PENDING_FOLLOW_KEY); } catch { /* */ }
        followingTvUntil = Date.now() + 12000;
        hit.click();
        return;
      }
      setTimeout(tryClick, 400);
    };
    tryClick();
  }

  /**
   * Start both at 1.0x with optional hold delays (never playbackRate tricks).
   */
  async function startMatchedPlayback(fallbackSec) {
    resetLaptopRate();
    restoreLaptopAudio();

    const holdLaptop = delayCompEnabled ? Math.max(0, Number(delayLaptopMs) || 0) : 0;
    const holdTv = delayCompEnabled ? Math.max(0, Number(delayTvMs) || 0) : 0;

    // Delay Off — start together immediately.
    if (!delayCompEnabled || (holdLaptop === 0 && holdTv === 0)) {
      withRemotePauseGuard(() => {
        seekLaptopSeconds(fallbackSec, { force: true });
        pauseLaptop({ mute: false });
      });
      await playTv();
      await sleep(80);
      syncedPaused = false;
      withRemotePauseGuard(() => playLaptop());
      restoreLaptopAudio();
      return fallbackSec;
    }

    // Laptop is behind → start laptop first, delay TV.
    if (holdTv > 0 && holdTv >= holdLaptop) {
      withRemotePauseGuard(() => {
        seekLaptopSeconds(fallbackSec, { force: true });
      });
      restoreLaptopAudio();
      syncedPaused = false;
      withRemotePauseGuard(() => playLaptop());
      setStatus(`Delaying TV ${(holdTv / 1000).toFixed(1)}s…`, 'busy');
      await sleep(holdTv);
      if (!castingSession) return fallbackSec;
      await playTv();
      return fallbackSec;
    }

    // TV is behind → start TV first, delay laptop, then lock to TV clock.
    withRemotePauseGuard(() => {
      seekLaptopSeconds(fallbackSec, { force: true });
      pauseLaptop({ mute: false });
    });
    await playTv();
    setStatus(`Delaying laptop ${(holdLaptop / 1000).toFixed(1)}s…`, 'busy');
    await sleep(holdLaptop);
    if (!castingSession) return fallbackSec;

    let tvNow = await readTvSeconds();
    if (tvNow == null || (fallbackSec > 5 && tvNow < 2)) tvNow = fallbackSec;

    withRemotePauseGuard(() => {
      seekLaptopSeconds(tvNow, { force: true });
      pauseLaptop({ mute: false });
    });
    restoreLaptopAudio();
    await playTv();
    await sleep(80);
    syncedPaused = false;
    withRemotePauseGuard(() => playLaptop());
    restoreLaptopAudio();
    return tvNow;
  }

  /**
   * Seek both devices so they land together.
   * Auto mode: wait until TV is actually playing at target (no fixed lag guess).
   * Manual mode: use the delay slider.
   */
  async function alignedSeek(sec, { label = 'Seek' } = {}) {
    if (!castingSession) {
      setStatus('Cast first', 'error');
      return;
    }
    clearTimeout(seekAlignTimer);
    seekAlignInProgress = true;
    seekingUi = true;
    syncedPaused = true;
    resetLaptopRate();
    blockUserSeekEvents(8000);

    const target = Math.max(0, Number(sec) || 0);

    withRemotePauseGuard(() => {
      seekLaptopSeconds(target, { force: true });
      pauseLaptop({ mute: false });
    });
    restoreLaptopAudio();
    updateSeekUi(target, laptopDurationSec());
    setStatus(
      manualDelay
        ? `${label}: waiting ${(effectiveSeekDelay() / 1000).toFixed(1)}s…`
        : `${label}: waiting for TV…`,
      'busy'
    );

    try {
      await pushSeekToTv(target);
    } catch (e) {
      seekAlignInProgress = false;
      seekingUi = false;
      restoreLaptopAudio();
      setStatus(e.message || 'Seek failed', 'error');
      return;
    }

    if (manualDelay) {
      await sleep(effectiveSeekDelay());
    } else {
      await waitForTvReady(target);
    }

    if (!castingSession) {
      seekAlignInProgress = false;
      seekingUi = false;
      restoreLaptopAudio();
      return;
    }

    withRemotePauseGuard(() => {
      seekLaptopSeconds(target, { force: true });
      pauseLaptop({ mute: false });
    });
    restoreLaptopAudio();

    if (!castingSession) {
      seekAlignInProgress = false;
      seekingUi = false;
      restoreLaptopAudio();
      return;
    }

    const matched = await startMatchedPlayback(target);

    blockUserSeekEvents(4000);
    lastSeekPushMs = Date.now();
    seekingUi = false;
    seekAlignInProgress = false;
    updateSeekUi(matched, laptopDurationSec());
    const tip = !delayCompEnabled
      ? 'delay off'
      : `L+${(delayLaptopMs / 1000).toFixed(1)}s TV+${(delayTvMs / 1000).toFixed(1)}s`;
    setStatus(`Matched @ ${formatTime(matched)} (${tip})`, 'ok');
  }

  function updateDelayUi() {
    const settleSlider = document.getElementById('stb-delay');
    const settleLabel = document.getElementById('stb-delay-label');
    const settleWrap = document.querySelector(`#${BAR_ID} .stb-settle-controls`);
    const settleCheck = document.getElementById('stb-manual-delay');
    const compCheck = document.getElementById('stb-delay-comp');
    const compWrap = document.querySelector(`#${BAR_ID} .stb-comp-controls`);
    const lapSlider = document.getElementById('stb-delay-laptop');
    const lapLabel = document.getElementById('stb-delay-laptop-label');
    const tvSlider = document.getElementById('stb-delay-tv');
    const tvLabel = document.getElementById('stb-delay-tv-label');
    const offBtn = document.getElementById('stb-delay-off');

    if (settleSlider) settleSlider.value = String(seekDelayMs);
    if (settleLabel) settleLabel.textContent = `${(seekDelayMs / 1000).toFixed(1)}s`;
    if (settleCheck) settleCheck.checked = !!manualDelay;
    if (settleWrap) settleWrap.classList.toggle('stb-hidden', !manualDelay);

    if (compCheck) compCheck.checked = !!delayCompEnabled;
    if (compWrap) compWrap.classList.toggle('stb-hidden', !delayCompEnabled);
    if (lapSlider) lapSlider.value = String(delayLaptopMs);
    if (lapLabel) lapLabel.textContent = `${(delayLaptopMs / 1000).toFixed(1)}s`;
    if (tvSlider) tvSlider.value = String(delayTvMs);
    if (tvLabel) tvLabel.textContent = `${(delayTvMs / 1000).toFixed(1)}s`;
    if (offBtn) {
      offBtn.textContent = delayCompEnabled ? 'Delay Off' : 'Delay On';
      offBtn.classList.toggle('stb-delay-off-active', !delayCompEnabled);
    }
  }

  function applyModeBehavior() {
    stopKeepPaused();
    stopSyncPoll();

    if (!castingSession) return;

    if (playbackMode === 'tvOnly') {
      pauseLaptop();
      startKeepPaused();
      // The laptop stays silent, but dragging YouTube's bar is still the way to
      // seek the TV — so seek handling is bound here too.
      bindLaptopSeekHandlers();
      // Poll in TV-only too: we still need to notice when SmartTube moves to a new
      // track so the tab can follow it.
      startSyncPoll();
    } else if (playbackMode === 'synced') {
      // Both have audio; bridge keeps timelines glued.
      const v = getLaptopVideo();
      if (v) v.loop = false;
      restoreLaptopAudio();
      playLaptop();
      bindLaptopSeekHandlers();
      bindSyncedEndHandlers(getLaptopVideo());
      startSyncPoll();
    } else {
      // Independent: no force pause, no laptop control. The poll still runs, but
      // only to keep the TV seek bar alive — see startSyncPoll's independent branch.
      resetLaptopRate();
      restoreLaptopAudio();
      const v = getLaptopVideo();
      if (v) v.loop = false;
      bindLaptopSeekHandlers(false);
      startSyncPoll();
    }
    updateModeUi();
  }

  function bindVideoPauseGuards(v) {
    if (!v || v.dataset.stbPauseBound === '1') return;
    v.dataset.stbPauseBound = '1';
    const block = (e) => {
      if (!(castingSession && playbackMode === 'tvOnly')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      pauseLaptop();
    };
    v.addEventListener('play', block, true);
    v.addEventListener('playing', block, true);
  }

  function startKeepPaused() {
    stopKeepPaused();
    pauseLaptop();
    bindVideoPauseGuards(getLaptopVideo());
    keepPauseTimer = setInterval(() => {
      if (!(castingSession && playbackMode === 'tvOnly')) return;
      bindVideoPauseGuards(getLaptopVideo());
      pauseLaptop();
    }, 1000);
  }

  function stopKeepPaused() {
    if (keepPauseTimer) {
      clearInterval(keepPauseTimer);
      keepPauseTimer = null;
    }
  }

  /**
   * The user dragged YouTube's progress bar. The laptop is left exactly where they
   * put it — we never fight the gesture — and the TV is sent after it.
   *
   * Seeking the TV means an `am start` VIEW intent, which restarts SmartTube's
   * player (2-5s reload + buffer). So drift correction stays suppressed until the
   * TV actually arrives near the target, then the guard is released early.
   */
  async function followUserSeek(targetSec) {
    userSeekGuardUntil = Date.now() + 15000;
    setStatus(`Seeking TV to ${formatTime(targetSec)}…`, 'busy');

    try {
      await pushSeekToTv(targetSec);
    } catch (e) {
      userSeekGuardUntil = 0;
      setStatus(e?.message || 'TV seek failed', 'error');
      return;
    }

    // Wait for SmartTube to come back up near the target, then resume drift work.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!castingSession) { userSeekGuardUntil = 0; return; }
      await sleep(700);
      const s = await sampleTv();
      if (!s) continue;
      if (Math.abs(s.tvSec - targetSec) <= 4) {
        userSeekGuardUntil = 0;   // TV is here — normal sync may resume
        setStatus(`TV synced @ ${formatTime(s.tvSec)}`, 'ok');
        return;
      }
    }

    // Never leave the guard latched on; fall back to normal drift correction.
    userSeekGuardUntil = 0;
    setStatus('TV seek timed out — will re-sync', 'error');
  }

  function bindLaptopSeekHandlers(enableLiveSync = true) {
    const v = getLaptopVideo();
    if (!v || v.dataset.stbSeekBound === '1') return;
    v.dataset.stbSeekBound = '1';

    let lastUserSeekPos = -1;

    const onUserSeek = () => {
      if (!castingSession || syncingFromTv || seekingUi || seekAlignInProgress) return;
      if (Date.now() < ignoreUserSeekUntil) return;
      // Independent means "only laptop" — the TV is not ours to move.
      if (playbackMode === 'independent') return;

      const sec = laptopPositionSec();
      // Ignore tiny / duplicate seek events (YouTube fires many during buffer).
      if (lastUserSeekPos >= 0 && Math.abs(sec - lastUserSeekPos) < 1.25) return;
      lastUserSeekPos = sec;

      // Hold off drift correction immediately — before the debounce — so a drag
      // that spans several seconds never gets yanked back mid-gesture.
      userSeekGuardUntil = Date.now() + 15000;

      clearTimeout(seekDebounce);
      seekDebounce = setTimeout(() => {
        if (!castingSession || seekAlignInProgress) return;
        const now = laptopPositionSec();
        followUserSeek(now);
      }, 400);
    };

    v.addEventListener('seeking', onUserSeek);
    v.addEventListener('seeked', onUserSeek);
  }

  // Drift thresholds for correcting the laptop against the predicted TV clock.
  // playbackRate is never touched — a previous attempt made laptop audio sound
  // slow while the TV ran at normal speed, and was reverted.
  const DRIFT_NUDGE_SEC = 0.75;
  const DRIFT_HARD_SEC = 2.0;

  /**
   * While the user is driving the timeline the TV is the follower, not the master —
   * correcting toward the TV here would drag the playhead straight back and make
   * seeking impossible. Set by onUserSeek, cleared once the TV has caught up.
   */
  let userSeekGuardUntil = 0;

  function userIsDrivingSeek() {
    return Date.now() < userSeekGuardUntil;
  }

  /** Pull the laptop back onto the TV's clock. Cheap: the laptop is the local side. */
  function correctDrift(localSec) {
    if (userIsDrivingSeek()) return;

    const tvSec = predictedTvSec();
    if (tvSec == null || !tvAnchorPlaying) return;

    const delta = localSec - tvSec;
    const mag = Math.abs(delta);
    if (mag < DRIFT_NUDGE_SEC) return;
    if (mag > 90) return;   // different track, not drift — leave it to the arbiter

    // Short block: only enough to ignore the `seeked` this very call emits.
    withRemotePauseGuard(() => seekLaptopSeconds(tvSec, { force: true, blockMs: 600 }));
    if (mag >= DRIFT_HARD_SEC) {
      setStatus(`Re-synced (${delta > 0 ? '+' : ''}${delta.toFixed(1)}s)`, 'ok');
    }
  }

  function startSyncPoll() {
    stopSyncPoll();
    // Runs in every mode while casting — track-change detection needs it even in
    // "TV only". What it *does* is gated by mode below.
    syncPollTimer = setInterval(async () => {
      if (!castingSession || seekingUi || seekAlignInProgress) return;

      // TV only: laptop stays paused and muted, but its playhead is dragged along
      // with the TV so YouTube's own progress bar shows where the TV actually is.
      // Without this the bar sits frozen at 0:00 and gives no feedback at all.
      if (playbackMode === 'tvOnly') {
        const v0 = getLaptopVideo();
        if (v0 && !v0.paused) withRemotePauseGuard(() => pauseLaptop({ mute: true }));
        await sampleTv();

        if (!userIsDrivingSeek()) {
          const tvSec = predictedTvSec();
          const local = laptopPositionSec();
          if (tvSec != null && Math.abs(local - tvSec) > 1.5) {
            withRemotePauseGuard(() => seekLaptopSeconds(tvSec, { force: true, blockMs: 600 }));
            // seekTo can resume playback on some builds — keep it silent.
            const v1 = getLaptopVideo();
            if (v1 && !v1.paused) withRemotePauseGuard(() => pauseLaptop({ mute: true }));
          }
        }
        return;
      }

      // Independent: the laptop is nobody's business but YouTube's. Still sample the
      // TV so the TV seek bar stays live — read-only, no laptop control at all.
      if (playbackMode === 'independent') {
        await sampleTv();
        return;
      }

      if (playbackMode !== 'synced') return;

      const local = laptopPositionSec();
      const dur = laptopDurationSec();
      const nearEnd = dur > 0 && (dur - local) <= 5;
      const v = getLaptopVideo();

      if (!seekingUi) updateSeekUi(local, dur);
      bindSyncedEndHandlers(getLaptopVideo());
      // Keep audio alive — seeking/pause paths used to leave mute stuck.
      if (v && v.muted) restoreLaptopAudio();
      // Always normal speed on laptop (never leave a slowed playbackRate stuck).
      if (v && v.playbackRate !== 1) v.playbackRate = 1;

      if (nearEnd && !tvHeldAtEnd) {
        tvHeldAtEnd = true;
        resetLaptopRate();
        await pauseTv();
        return;
      }

      if (Date.now() - lastSeekPushMs < 2000) return;

      try {
        const d = await sampleTv();
        if (!d) return;
        const tvSec = d.tvSec;

        // SmartTube jumped to Related at t≈0 — hold TV, never rewind browser.
        if (!nearEnd && !tvHeldAtEnd && !endHandled && local > 12 && tvSec < 4) {
          resetLaptopRate();
          await pauseTv();
          return;
        }

        if (nearEnd || tvHeldAtEnd || endHandled || applyingRemotePause) return;

        const laptopPaused = !!v?.paused;

        // TV paused → pause laptop
        if (d.isPlaying === false && !laptopPaused) {
          syncedPaused = true;
          resetLaptopRate();
          withRemotePauseGuard(() => pauseLaptop({ mute: false }));
          setStatus('Paused (both)', 'ok');
          return;
        }

        // TV resumed → resume laptop
        if (d.isPlaying === true && laptopPaused && syncedPaused) {
          syncedPaused = false;
          withRemotePauseGuard(() => playLaptop());
          restoreLaptopAudio();
          setStatus('Playing (both)', 'ok');
          return;
        }

        // Both playing → keep the laptop pinned to the TV's clock.
        if (d.isPlaying && !laptopPaused && !syncedPaused) {
          resetLaptopRate();
          correctDrift(local);
        }
      } catch { /* */ }
    }, 2000);
  }

  function stopSyncPoll() {
    if (syncPollTimer) {
      clearInterval(syncPollTimer);
      syncPollTimer = null;
    }
  }

  async function castCurrent({ fromAuto = false } = {}) {
    if (castInFlight) return;
    const videoId = extractVideoId();
    if (!videoId) return;

    castInFlight = true;
    castingSession = true;
    lastVideoId = videoId;
    // An explicit cast/recast is the user speaking from the laptop side.
    if (!fromAuto) restoreLaptopAuthority('Playlist control restored');
    ensureSingleBar();
    updateBarCastingUi(true);
    applyModeBehavior();
    setStatus(fromAuto ? 'Auto-casting…' : 'Casting…', 'busy');

    try {
      // Pass the playlist through. Without &list= SmartTube has no queue context and
      // falls back to its own "Related" autoplay — which is why the TV drifted onto
      // different songs than the laptop's playlist. With it, both sides share a queue.
      const cleanUrl = buildCastUrl(videoId);
      const resp = await api('cast', { url: cleanUrl, mode: playbackMode });
      if (resp?.success === false) {
        setStatus(resp.message || 'Cast failed', 'error');
        return;
      }
      await chrome.storage.sync.set({ castingSession: true, lastCastVideoId: videoId, playbackMode });
      endHandled = false;
      tvHeldAtEnd = false;
      syncedPaused = false;
      applyModeBehavior();
      if (playbackMode === 'synced') {
        const sec = fromAuto ? 0 : laptopPositionSec();
        // alignedSeek includes the 1.35s TV lag compensation.
        await alignedSeek(Math.max(0, sec), { label: fromAuto ? 'Next' : 'Cast' });
      } else {
        const labels = {
          tvOnly: 'TV only — laptop paused',
          independent: 'Independent — both free',
        };
        setStatus(labels[playbackMode] || 'Casting', 'ok');
      }
    } catch (e) {
      setStatus(e.message || 'Cast failed', 'error');
    } finally {
      castInFlight = false;
    }
  }

  async function stopCasting() {
    setStatus('Stopping cast…', 'busy');
    try { await api('stopCast', {}); } catch { /* */ }
    castingSession = false;
    await chrome.storage.sync.set({ castingSession: false });
    stopKeepPaused();
    stopSyncPoll();
    resetTvClock();
    lastTvTitle = null;
    masterSide = null;
    masterUntil = 0;
    resetLaptopRate();
    restoreLaptopAudio();
    updateBarCastingUi(false);
    setStatus('Casting stopped', 'ok');
  }

  /**
   * Sync = snap the LAPTOP to the TV, not the other way round.
   *
   * Seeking the TV means firing a VIEW intent, which restarts SmartTube's player
   * (2-5s reload + buffer) — that is why the old direction felt broken. Seeking the
   * laptop is local and completes in well under 100ms, so this is the cheap side to
   * move. The TV is only ever re-seeked on an explicit drag of the YouTube bar.
   */
  async function syncNow() {
    if (!castingSession) {
      setStatus('Cast first, then Sync', 'error');
      return;
    }

    setStatus('Syncing to TV…', 'busy');
    const sample = await sampleTv();
    if (!sample) {
      setStatus('TV position unavailable', 'error');
      return;
    }

    const target = predictedTvSec() ?? sample.tvSec;
    blockUserSeekEvents(2500);
    withRemotePauseGuard(() => seekLaptopSeconds(target, { force: true }));
    restoreLaptopAudio();

    // Match the TV's play/pause state too, so "synced" really means synced.
    if (playbackMode === 'synced') {
      const v = getLaptopVideo();
      if (sample.isPlaying && v?.paused) {
        syncedPaused = false;
        withRemotePauseGuard(() => playLaptop());
      } else if (!sample.isPlaying && v && !v.paused) {
        syncedPaused = true;
        withRemotePauseGuard(() => pauseLaptop({ mute: false }));
      }
    }

    setStatus(`Synced to TV @ ${formatTime(target)}`, 'ok');
  }

  function setStatus(text, kind) {
    const el = document.getElementById('stb-status');
    if (!el) return;
    el.textContent = text || '';
    el.dataset.kind = kind || '';
  }

  // null until the first paint, so the initial state is always applied once.
  let lastCastingUiState = null;

  function updateBarCastingUi(on) {
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    bar.classList.toggle('stb-casting', !!on);

    // Default state follows the casting state: expanded while casting, collapsed on
    // "only laptop" — applied on the first paint of a page and on each real change.
    // It must NOT re-apply on every refresh tick (this runs every 1.5s), or a manual
    // collapse would spring back open a moment later.
    if (lastCastingUiState !== !!on) {
      lastCastingUiState = !!on;
      setBarCollapsed(!on);
    }
    const castBtn = bar.querySelector('[data-stb="cast"]');
    const stopBtn = bar.querySelector('[data-stb="stop"]');
    const syncBtn = bar.querySelector('[data-stb="sync"]');
    const delayWrap = bar.querySelector('.stb-delay-wrap');
    if (castBtn) castBtn.textContent = on ? '↻ Recast' : '📺 Play on TV';
    if (stopBtn) stopBtn.classList.toggle('stb-hidden', !on);
    if (syncBtn) syncBtn.classList.toggle('stb-hidden', !on);
    if (delayWrap) delayWrap.classList.toggle('stb-hidden', !on);
    updateDelayUi();
  }

  function updateModeUi() {
    const sel = document.getElementById('stb-mode');
    if (sel && sel.value !== playbackMode) sel.value = playbackMode;
  }

  /**
   * Collapsed by default on every load. Casting expands it; stopping ("only laptop")
   * collapses it again. Manual toggles last for the current page only.
   */
  function setBarCollapsed(collapsed) {
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    bar.classList.toggle('stb-collapsed', !!collapsed);
    const btn = bar.querySelector('[data-stb="toggle"]');
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.title = collapsed ? 'Expand SmartTube controls' : 'Collapse SmartTube controls';
      const chev = btn.querySelector('.stb-chevron');
      if (chev) chev.textContent = collapsed ? '▸' : '▾';
    }
  }

  // ── TV seek bar ────────────────────────────────────────────────────────────
  // Reflects the TV's own clock (dead-reckoned between samples) and seeks the TV.
  let tvBarTimer = null;
  let tvBarDragging = false;
  let tvBarDurationSec = 0;

  function bindTvSeekBar(bar) {
    const slider = bar.querySelector('#stb-tvseek');
    const tip = bar.querySelector('#stb-tvseek-tip');
    if (!slider) return;

    const valueToSec = () => (Number(slider.value) / 1000) * (tvBarDurationSec || 0);

    const startDrag = () => { tvBarDragging = true; };
    slider.addEventListener('mousedown', startDrag);
    slider.addEventListener('touchstart', startDrag, { passive: true });

    slider.addEventListener('input', () => {
      tvBarDragging = true;
      const label = document.getElementById('stb-tvseek-label');
      if (label) label.textContent = `${formatTime(valueToSec())} / ${formatTime(tvBarDurationSec)}`;
    });

    const commit = async () => {
      if (!tvBarDragging) return;
      tvBarDragging = false;
      if (!castingSession) { setStatus('Cast first', 'error'); return; }

      const target = valueToSec();
      // Keep the laptop aligned too when both are meant to play together.
      if (playbackMode === 'synced') {
        blockUserSeekEvents(2000);
        withRemotePauseGuard(() => seekLaptopSeconds(target, { force: true, blockMs: 1200 }));
      }
      await followUserSeek(target);
    };
    slider.addEventListener('change', commit);
    slider.addEventListener('mouseup', commit);
    slider.addEventListener('touchend', commit);

    const showTip = (e) => {
      if (!tip) return;
      const rect = slider.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      tip.textContent = formatTime(ratio * (tvBarDurationSec || 0));
      tip.style.left = `${ratio * 100}%`;
      tip.classList.remove('stb-hidden');
    };
    slider.addEventListener('mousemove', showTip);
    slider.addEventListener('mouseenter', showTip);
    slider.addEventListener('mouseleave', () => tip?.classList.add('stb-hidden'));

    startTvBarTicker();
  }

  /**
   * Repaints from the predicted TV clock at 4Hz. This is local arithmetic, not an
   * ADB round trip — the bar stays smooth while the poll stays at 2s.
   */
  function startTvBarTicker() {
    clearInterval(tvBarTimer);
    tvBarTimer = setInterval(() => {
      if (contextDead) return;
      const slider = document.getElementById('stb-tvseek');
      const label = document.getElementById('stb-tvseek-label');
      if (!slider || tvBarDragging) return;

      // SmartTube's media session does not report duration, so use the laptop's
      // copy of the same video — the two are the same media.
      const dur = laptopDurationSec();
      if (dur > 0) tvBarDurationSec = dur;

      const tvSec = predictedTvSec();
      if (tvSec == null || !tvBarDurationSec) {
        if (label) label.textContent = castingSession ? '—:— / —:—' : '0:00 / 0:00';
        return;
      }

      const clamped = Math.min(tvBarDurationSec, Math.max(0, tvSec));
      slider.value = String(Math.round((clamped / tvBarDurationSec) * 1000));
      if (label) label.textContent = `${formatTime(clamped)} / ${formatTime(tvBarDurationSec)}`;
    }, 250);
  }

  // ── TV volume slider ───────────────────────────────────────────────────────
  // The TV ignores absolute volume set, so the service steps VOLUME_UP/DOWN to
  // reach the target. A 30-point move takes several seconds on the device, so the
  // slider only commits on release — never while dragging — and refreshes its
  // reading afterwards rather than assuming the write landed.
  let volumeBusy = false;
  let volumeRefreshTimer = null;
  /** Newest slider target awaiting a send; null when nothing is queued. */
  let pendingVolumeTarget = null;

  function bindVolumeSlider(bar) {
    const slider = bar.querySelector('#stb-vol');
    const label = bar.querySelector('#stb-vol-label');
    if (!slider) return;

    slider.addEventListener('input', () => {
      if (label) label.textContent = `${slider.value}%`;
    });

    /**
     * Latest target wins. Moving the slider again while a set is still stepping
     * must not be dropped — it records the new target and the running loop picks it
     * up on its next pass. The service cancels its in-flight key stepping when the
     * newer request arrives, so the TV never finishes travelling to a stale level.
     */
    const commit = async () => {
      pendingVolumeTarget = Number(slider.value);
      if (label) label.textContent = `${pendingVolumeTarget}%`;
      if (volumeBusy) return;   // the active loop will consume the new target

      volumeBusy = true;
      try {
        while (pendingVolumeTarget !== null && !contextDead) {
          const target = pendingVolumeTarget;
          pendingVolumeTarget = null;

          const resp = await api('volume', { level: target });

          // Moved again mid-flight — go round with the newer value instead of
          // painting this now-stale result.
          if (pendingVolumeTarget !== null) continue;

          const d = resp?.data;
          if (d && Number.isFinite(d.level)) {
            slider.value = String(d.level);
            if (label) label.textContent = `${d.level}%`;
          } else if (label) {
            label.textContent = `${target}%`;
          }
        }
      } catch {
        if (label) label.textContent = '!';
      } finally {
        volumeBusy = false;
      }
    };
    slider.addEventListener('change', commit);

    refreshVolume();
    // The physical remote changes volume too — resync periodically so the slider
    // is not lying about the TV's actual level.
    clearInterval(volumeRefreshTimer);
    volumeRefreshTimer = setInterval(refreshVolume, 15000);
  }

  async function refreshVolume() {
    if (contextDead || volumeBusy || !castingSession) return;
    const slider = document.getElementById('stb-vol');
    const label = document.getElementById('stb-vol-label');
    if (!slider || document.activeElement === slider) return;

    try {
      const resp = await api('volumeGet', {});
      const d = resp?.data;
      if (!d?.available) return;
      slider.min = String(d.min ?? 0);
      slider.max = String(d.max ?? 100);
      slider.value = String(d.level);
      if (label) label.textContent = `${d.level}%`;
    } catch { /* leave the last known reading */ }
  }

  function injectCollapseStyles() {
    if (document.getElementById('stb-collapse-styles')) return;
    const style = document.createElement('style');
    style.id = 'stb-collapse-styles';
    style.textContent = `
      #${BAR_ID} .stb-toggle {
        display: inline-flex; align-items: center; gap: 6px;
        background: transparent; border: 1px solid rgba(255,255,255,.25);
        border-radius: 999px; color: inherit; cursor: pointer;
        padding: 2px 8px; font-size: 12px; line-height: 1.6;
      }
      #${BAR_ID} .stb-toggle:hover { background: rgba(255,255,255,.10); }
      #${BAR_ID} .stb-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: #888; display: inline-block;
      }
      #${BAR_ID}.stb-casting .stb-dot { background: #3ea6ff; }
      #${BAR_ID}.stb-collapsed { padding-top: 4px; padding-bottom: 4px; }
      #${BAR_ID}.stb-collapsed > *:not(.stb-toggle):not(.stb-title) { display: none !important; }

      #${BAR_ID} .stb-tvseek-wrap {
        display: flex; align-items: center; gap: 8px;
        flex: 1 1 100%; min-width: 240px; margin-top: 6px;
      }
      #${BAR_ID} .stb-tvseek-tag {
        font-size: 11px; font-weight: 600; letter-spacing: .04em;
        opacity: .8; min-width: 20px;
      }
      #${BAR_ID} .stb-tvseek-track { position: relative; flex: 1; display: flex; }
      #${BAR_ID} .stb-tvseek-track input { width: 100%; flex: 1; cursor: pointer; }
      #${BAR_ID} .stb-tvseek-tip {
        position: absolute; bottom: 20px; transform: translateX(-50%);
        background: rgba(0,0,0,.9); color: #fff; font-size: 11px;
        padding: 2px 6px; border-radius: 3px; pointer-events: none; white-space: nowrap;
      }
      #${BAR_ID} .stb-tvseek-label {
        font-size: 11px; opacity: .85; min-width: 84px; text-align: right;
        font-variant-numeric: tabular-nums;
      }
      /* Nothing to seek until a cast session exists. */
      #${BAR_ID}:not(.stb-casting) .stb-tvseek-wrap { opacity: .45; pointer-events: none; }

      #${BAR_ID} .stb-vol-wrap { display: inline-flex; align-items: center; gap: 6px; }
      #${BAR_ID} .stb-vol-wrap input { width: 92px; cursor: pointer; }
      #${BAR_ID} .stb-vol-label {
        font-size: 11px; opacity: .85; min-width: 34px;
        font-variant-numeric: tabular-nums;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * The custom seek slider was removed in favour of YouTube's native progress bar
   * (thumbnail preview, chapters, hover scrub — all free, and always in step with
   * the real video). Kept as a no-op so the many existing call sites stay valid.
   */
  function updateSeekUi(_posSec, _durSec) { /* no-op — YouTube owns the seek bar */ }

  function bindHoldRepeat(btn, endpoint) {
    const start = (e) => {
      e.preventDefault();
      api('media', { endpoint });
      clearInterval(volumeHoldTimer);
      volumeHoldTimer = setInterval(() => api('media', { endpoint }), 180);
    };
    const stop = () => {
      clearInterval(volumeHoldTimer);
      volumeHoldTimer = null;
    };
    btn.addEventListener('mousedown', start);
    btn.addEventListener('touchstart', start, { passive: false });
    ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(ev =>
      btn.addEventListener(ev, stop));
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BAR_ID} {
        display: none !important;
        flex-wrap: wrap; align-items: center; gap: 6px;
        margin: 8px 0 12px; padding: 8px 10px; border-radius: 10px;
        background: rgba(15, 23, 42, 0.95); border: 1px solid rgba(255,255,255,0.1);
        color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px; position: relative; z-index: 40; width: 100%;
        box-sizing: border-box;
      }
      #${BAR_ID}.stb-visible { display: flex !important; }
      #${BAR_ID}.stb-casting { border-color: #38bdf8; }
      #${BAR_ID} .stb-title { font-weight: 600; color: #7dd3fc; margin-right: 4px; }
      #${BAR_ID} .stb-btn {
        appearance: none; border: none; border-radius: 7px; background: #334155;
        color: #f8fafc; padding: 6px 10px; cursor: pointer; font-size: 13px;
      }
      #${BAR_ID} .stb-btn:hover { background: #475569; }
      #${BAR_ID} .stb-btn.stb-primary { background: #0284c7; }
      #${BAR_ID} .stb-btn.stb-danger { background: #b91c1c; }
      #${BAR_ID} .stb-btn.stb-sync { background: #0f766e; }
      #${BAR_ID} .stb-btn.stb-sync:hover { background: #0d9488; }
      #${BAR_ID} .stb-sep { width: 1px; height: 22px; background: rgba(255,255,255,0.12); }
      #${BAR_ID} .stb-status { flex: 1 1 120px; font-size: 11px; color: #94a3b8; }
      #${BAR_ID} .stb-status[data-kind="ok"] { color: #86efac; }
      #${BAR_ID} .stb-status[data-kind="error"] { color: #fca5a5; }
      #${BAR_ID} .stb-status[data-kind="busy"] { color: #fde68a; }
      #${BAR_ID} .stb-hidden { display: none !important; }
      #${BAR_ID} .stb-mode-wrap, #${BAR_ID} .stb-seek-wrap, #${BAR_ID} .stb-delay-wrap {
        display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 4px;
      }
      #${BAR_ID} select, #${BAR_ID} input[type="range"] {
        accent-color: #38bdf8; background: #0f172a; color: #e2e8f0;
        border: 1px solid #334155; border-radius: 6px;
      }
      #${BAR_ID} select { padding: 4px 6px; font-size: 12px; }
      #${BAR_ID} input[type="range"] { flex: 1; }
      #${BAR_ID} .stb-check {
        display: flex; align-items: center; gap: 6px; font-size: 12px; color: #cbd5e1;
        white-space: nowrap;
      }
      #${BAR_ID} .stb-settle-controls, #${BAR_ID} .stb-comp-controls {
        display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: 1; width: 100%;
      }
      #${BAR_ID} .stb-comp-row {
        display: flex; align-items: center; gap: 6px; flex: 1; min-width: 180px;
      }
      #${BAR_ID} .stb-btn.stb-delay-off-active { background: #b45309; }
      #${BAR_ID} .stb-btn.stb-delay-off-active:hover { background: #d97706; }
      #${BAR_ID} .stb-seek-track {
        position: relative; flex: 1; display: flex; align-items: center;
      }
      #${BAR_ID} .stb-seek-track input { width: 100%; flex: 1; }
      #${BAR_ID} .stb-seek-tip {
        position: absolute; bottom: calc(100% + 4px); transform: translateX(-50%);
        background: #0f172a; border: 1px solid #38bdf8; color: #e2e8f0;
        font-size: 11px; padding: 2px 6px; border-radius: 4px; pointer-events: none;
        white-space: nowrap; z-index: 50;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function createBar() {
    let bar = document.getElementById(BAR_ID);
    if (bar) return bar;

    bar = document.createElement('div');
    bar.id = BAR_ID;
    // Always start collapsed — expanded state is deliberately not persisted, so
    // every page load / refresh comes up as a small pill.
    bar.classList.add('stb-collapsed');
    bar.innerHTML = `
      <button type="button" class="stb-toggle" data-stb="toggle" title="Expand SmartTube controls" aria-expanded="false">
        <span class="stb-dot"></span><span class="stb-chevron">▸</span>
      </button>
      <span class="stb-title">SmartTube</span>
      <button type="button" class="stb-btn stb-primary" data-stb="cast">📺 Play on TV</button>
      <button type="button" class="stb-btn stb-danger stb-hidden" data-stb="stop">■ Stop Casting</button>
      <button type="button" class="stb-btn stb-sync stb-hidden" data-stb="sync" title="Align laptop video to TV time">🔄 Sync</button>
      <span class="stb-sep"></span>
      <button type="button" class="stb-btn" data-stb-media="playpause">⏯</button>
      <button type="button" class="stb-btn" data-stb-media="rewind">⏪</button>
      <button type="button" class="stb-btn" data-stb-media="forward">⏩</button>
      <button type="button" class="stb-btn" data-stb-hold="volume/down">🔉</button>
      <button type="button" class="stb-btn" data-stb-media="volume/mute">🔇</button>
      <button type="button" class="stb-btn" data-stb-hold="volume/up">🔊</button>
      <div class="stb-vol-wrap">
        <input id="stb-vol" type="range" min="0" max="100" value="50" title="TV volume">
        <span class="stb-vol-label" id="stb-vol-label">–</span>
      </div>
      <span class="stb-sep"></span>
      <button type="button" class="stb-btn" data-stb-media="power/on" title="Turn TV on / wake">⏻</button>
      <button type="button" class="stb-btn" data-stb-media="power/off" title="Put TV to sleep">⏼</button>
      <span class="stb-status" id="stb-status"></span>
      <div class="stb-mode-wrap">
        <label for="stb-mode">Mode</label>
        <select id="stb-mode">
          <option value="tvOnly">TV only (laptop paused)</option>
          <option value="synced">Synced (laptop leads + Up Next)</option>
          <option value="independent">Independent</option>
        </select>
      </div>
      <div class="stb-delay-wrap stb-hidden">
        <button type="button" class="stb-btn" id="stb-delay-off" title="Turn lag delays off to test raw sync">Delay Off</button>
        <label class="stb-check">
          <input type="checkbox" id="stb-delay-comp" checked>
          Use delays
        </label>
        <div class="stb-comp-controls">
          <div class="stb-comp-row">
            <span title="Hold laptop after TV starts (TV was behind)">Delay laptop</span>
            <input id="stb-delay-laptop" type="range" min="0" max="5000" step="50" value="1350">
            <span class="stb-delay-label" id="stb-delay-laptop-label">1.4s</span>
          </div>
          <div class="stb-comp-row">
            <span title="Hold TV after laptop starts (laptop was behind)">Delay TV</span>
            <input id="stb-delay-tv" type="range" min="0" max="5000" step="50" value="0">
            <span class="stb-delay-label" id="stb-delay-tv-label">0.0s</span>
          </div>
        </div>
        <label class="stb-check">
          <input type="checkbox" id="stb-manual-delay">
          Manual settle
        </label>
        <div class="stb-settle-controls stb-hidden">
          <input id="stb-delay" type="range" min="0" max="10000" step="100" value="4200">
          <span class="stb-delay-label" id="stb-delay-label">4.2s</span>
        </div>
      </div>
      <div class="stb-tvseek-wrap">
        <span class="stb-tvseek-tag">TV</span>
        <div class="stb-tvseek-track">
          <input id="stb-tvseek" type="range" min="0" max="1000" value="0" step="1">
          <div id="stb-tvseek-tip" class="stb-tvseek-tip stb-hidden">0:00</div>
        </div>
        <span class="stb-tvseek-label" id="stb-tvseek-label">0:00 / 0:00</span>
      </div>
    `;

    // In synced mode YouTube's own bar drives both sides (it has thumbnail preview,
    // chapters and hover scrub). In TV-only / independent the laptop video is not the
    // reference, so this bar mirrors the TV clock and seeks the TV directly.
    injectCollapseStyles();
    bindTvSeekBar(bar);
    bindVolumeSlider(bar);
    const toggleBtn = bar.querySelector('[data-stb="toggle"]');
    toggleBtn.addEventListener('click', () => setBarCollapsed(!bar.classList.contains('stb-collapsed')));

    bar.querySelector('[data-stb="cast"]').addEventListener('click', () => castCurrent());
    bar.querySelector('[data-stb="stop"]').addEventListener('click', () => stopCasting());
    bar.querySelector('[data-stb="sync"]').addEventListener('click', () => syncNow());
    bar.querySelectorAll('[data-stb-media]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const endpoint = btn.getAttribute('data-stb-media');
        if (endpoint === 'playpause' && castingSession && playbackMode === 'synced') {
          const vid = getLaptopVideo();
          if (vid?.paused || syncedPaused) {
            syncedPaused = false;
            withRemotePauseGuard(() => playLaptop());
            await playTv();
            setStatus('Playing (both)', 'ok');
          } else {
            syncedPaused = true;
            withRemotePauseGuard(() => pauseLaptop());
            await pauseTv();
            setStatus('Paused (both)', 'ok');
          }
          return;
        }
        api('media', { endpoint });
      });
    });
    bar.querySelectorAll('[data-stb-hold]').forEach(btn => {
      bindHoldRepeat(btn, btn.getAttribute('data-stb-hold'));
    });

    const modeSel = bar.querySelector('#stb-mode');
    modeSel.value = playbackMode;
    modeSel.addEventListener('change', async () => {
      playbackMode = /** @type {PlaybackMode} */ (modeSel.value);
      await chrome.storage.sync.set({ playbackMode });
      if (castingSession) applyModeBehavior();
      setStatus(`Mode: ${playbackMode}`, 'ok');
    });

    const delaySlider = bar.querySelector('#stb-delay');
    const manualCheck = bar.querySelector('#stb-manual-delay');
    const compCheck = bar.querySelector('#stb-delay-comp');
    const offBtn = bar.querySelector('#stb-delay-off');
    const lapSlider = bar.querySelector('#stb-delay-laptop');
    const tvSlider = bar.querySelector('#stb-delay-tv');
    updateDelayUi();

    async function setDelayComp(on) {
      delayCompEnabled = !!on;
      await chrome.storage.sync.set({ delayCompEnabled });
      updateDelayUi();
      setStatus(delayCompEnabled ? 'Delays on (1.0x both)' : 'Delay Off — raw sync', 'ok');
    }
    offBtn.addEventListener('click', () => setDelayComp(!delayCompEnabled));
    compCheck.addEventListener('change', () => setDelayComp(compCheck.checked));

    lapSlider.addEventListener('input', () => {
      delayLaptopMs = Math.max(0, Number(lapSlider.value) || 0);
      updateDelayUi();
    });
    lapSlider.addEventListener('change', async () => {
      delayLaptopMs = Math.max(0, Number(lapSlider.value) || 0);
      await chrome.storage.sync.set({ delayLaptopMs });
      setStatus(`Delay laptop ${(delayLaptopMs / 1000).toFixed(1)}s`, 'ok');
    });
    tvSlider.addEventListener('input', () => {
      delayTvMs = Math.max(0, Number(tvSlider.value) || 0);
      updateDelayUi();
    });
    tvSlider.addEventListener('change', async () => {
      delayTvMs = Math.max(0, Number(tvSlider.value) || 0);
      await chrome.storage.sync.set({ delayTvMs });
      setStatus(`Delay TV ${(delayTvMs / 1000).toFixed(1)}s`, 'ok');
    });

    manualCheck.addEventListener('change', async () => {
      manualDelay = !!manualCheck.checked;
      await chrome.storage.sync.set({ manualDelay });
      updateDelayUi();
      setStatus(manualDelay ? 'Manual settle on' : 'Auto settle (TV wait)', 'ok');
    });
    delaySlider.addEventListener('input', () => {
      seekDelayMs = Math.max(0, Number(delaySlider.value) || 0);
      updateDelayUi();
    });
    delaySlider.addEventListener('change', async () => {
      seekDelayMs = Math.max(0, Number(delaySlider.value) || 0);
      await chrome.storage.sync.set({ seekDelayMs });
      setStatus(`Settle ${(seekDelayMs / 1000).toFixed(1)}s`, 'ok');
    });

    // Seek controls intentionally absent — YouTube's native progress bar is the
    // single seek surface. User drags reach the TV via bindLaptopSeekHandlers().

    return bar;
  }

  /** Keep exactly one bar, always under the video player. */
  function ensureSingleBar() {
    ensureStyles();

    // Nuke duplicates from older buggy mounts (YouTube SPA can leave clones around).
    const all = [...document.querySelectorAll(`#${BAR_ID}`)];
    for (let i = 1; i < all.length; i++) all[i].remove();

    const bar = createBar();
    const watch = isWatchPage();
    bar.classList.toggle('stb-visible', watch);
    updateBarCastingUi(castingSession);
    updateModeUi();
    if (!watch) return;

    // Preferred anchors: immediately after the player block — never page/masthead top.
    const player =
      document.querySelector('#player-container-outer') ||
      document.querySelector('#player-container-inner') ||
      document.querySelector('ytd-player#ytd-player') ||
      document.querySelector('ytd-player') ||
      document.querySelector('#player');

    const below =
      document.querySelector('ytd-watch-flexy #below') ||
      document.querySelector('#below');

    bar.style.cssText = '';

    if (player) {
      if (bar.previousElementSibling !== player) {
        player.insertAdjacentElement('afterend', bar);
      }
    } else if (below) {
      if (below.firstElementChild !== bar) {
        below.insertBefore(bar, below.firstChild);
      }
    } else if (!bar.isConnected) {
      document.body.appendChild(bar);
    }

    if (!seekUiTimer) {
      seekUiTimer = setInterval(() => {
        if (!castingSession || seekingUi || playbackMode === 'synced') return;
        updateSeekUi(laptopPositionSec(), laptopDurationSec());
      }, 1000);
    }
  }

  async function onVideoChanged(videoId) {
    ensureSingleBar();
    if (!videoId) {
      setStatus('', '');
      return;
    }
    lastVideoId = videoId;
    endHandled = false;
    tvHeldAtEnd = false;
    syncedPaused = false;
    clearTimeout(nextVideoTimer);
    // Reset bind flags so the new <video> gets handlers.
    document.querySelectorAll(
      'video[data-stb-seek-bound],video[data-stb-pause-bound],video[data-stb-synced-bound]'
    ).forEach(v => {
      delete v.dataset.stbSeekBound;
      delete v.dataset.stbPauseBound;
      delete v.dataset.stbSyncedBound;
    });
    if (castingSession) {
      // If this navigation happened *because* we are following the TV, the TV is
      // already on this video. Re-casting would fire a VIEW intent and restart
      // SmartTube's player for no reason — just re-anchor and let it play.
      if (Date.now() < followingTvUntil) {
        setStatus('Following TV', 'ok');
        resetTvClock();
        applyModeBehavior();
        return;
      }
      // Pause TV briefly so SmartTube cannot keep playing its own Related during nav.
      if (playbackMode === 'synced') await pauseTv();
      await castCurrent({ fromAuto: true });
    } else {
      setStatus('Ready to cast', '');
    }
  }

  function watchNavigation() {
    const tick = () => {
      const id = extractVideoId();
      if (id !== lastVideoId) {
        lastVideoId = id;
        // Laptop moved to a new track. If the TV already owns this transition we're
        // only following it — otherwise the laptop claims master and drives the TV.
        // A navigation the user made themselves (not one we triggered to follow the
        // TV) means they are driving from the laptop again.
        if (Date.now() >= followingTvUntil) restoreLaptopAuthority();
        if (!masterLockHeldBy('laptop')) claimMaster('laptop');
        resetTvClock();
        // A new video counts as a new page: re-apply the default collapse state.
        lastCastingUiState = null;
        onVideoChanged(id);
      } else {
        ensureSingleBar();
      }
    };
    tick();
    navTickTimer = setInterval(tick, 1500);
    const onNav = () => tick();
    document.addEventListener('yt-navigate-finish', onNav);
    window.addEventListener('yt-navigate-finish', onNav);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' && area !== 'local') return;
    if (changes.seekDelayMs) {
      seekDelayMs = Math.max(0, Number(changes.seekDelayMs.newValue) || 0);
      updateDelayUi();
    }
    if (changes.manualDelay) {
      manualDelay = !!changes.manualDelay.newValue;
      updateDelayUi();
    }
    if (changes.delayCompEnabled) {
      delayCompEnabled = !!changes.delayCompEnabled.newValue;
      updateDelayUi();
    }
    if (changes.delayLaptopMs) {
      delayLaptopMs = Math.max(0, Number(changes.delayLaptopMs.newValue) || 0);
      updateDelayUi();
    }
    if (changes.delayTvMs) {
      delayTvMs = Math.max(0, Number(changes.delayTvMs.newValue) || 0);
      updateDelayUi();
    }
    if (changes.playbackMode) {
      playbackMode = changes.playbackMode.newValue || 'tvOnly';
      updateModeUi();
      if (castingSession) applyModeBehavior();
    }
    if (changes.castingSession) {
      castingSession = !!changes.castingSession.newValue;
      updateBarCastingUi(castingSession);
      if (castingSession) applyModeBehavior();
      else {
        stopKeepPaused();
        stopSyncPoll();
        resetLaptopRate();
        restoreLaptopAudio();
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action === 'pauseLocal' || msg?.action === 'applyCastMode') {
      castingSession = true;
      if (msg.mode) playbackMode = msg.mode;
      ensureSingleBar();
      applyModeBehavior();
      updateBarCastingUi(true);
      sendResponse({ success: true });
      return false;
    }
    if (msg?.action === 'alignedSeek') {
      alignedSeek(Number(msg.sec) || 0, { label: 'Seek' })
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, message: e.message }));
      return true;
    }
    if (msg?.action === 'syncNow') {
      syncNow().then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, message: e.message }));
      return true;
    }
    if (msg?.action === 'syncedPlayPause') {
      (async () => {
        if (castingSession && playbackMode === 'synced') {
          const vid = getLaptopVideo();
          if (vid?.paused || syncedPaused) {
            syncedPaused = false;
            withRemotePauseGuard(() => playLaptop());
            await playTv();
            setStatus('Playing (both)', 'ok');
          } else {
            syncedPaused = true;
            withRemotePauseGuard(() => pauseLaptop());
            await pauseTv();
            setStatus('Paused (both)', 'ok');
          }
        } else {
          await api('media', { endpoint: 'playpause' });
        }
        sendResponse({ success: true });
      })().catch(e => sendResponse({ success: false, message: e.message }));
      return true;
    }
    if (msg?.action === 'stopLocalCastUi') {
      castingSession = false;
      stopKeepPaused();
      stopSyncPoll();
      resetLaptopRate();
      restoreLaptopAudio();
      updateBarCastingUi(false);
      setStatus('Casting stopped', 'ok');
      sendResponse({ success: true });
      return false;
    }
  });

  async function init() {
    // Search-results pages carry no player bar, but they may be the landing point of
    // a TV-follow that still needs its top hit opened.
    resumePendingFollow();

    const stored = await chrome.storage.sync.get({
      castingSession: false,
      playbackMode: 'tvOnly',
      seekDelayMs: 4200,
      manualDelay: false,
      autoDelayMs: 4200,
      delayCompEnabled: true,
      delayLaptopMs: 1350,
      delayTvMs: 0,
      tvLagCompMs: 1350, // legacy → delayLaptopMs
    });
    castingSession = !!stored.castingSession;
    playbackMode = stored.playbackMode || 'tvOnly';
    seekDelayMs = Math.max(0, Number(stored.seekDelayMs) || 4200);
    manualDelay = !!stored.manualDelay;
    autoDelayMs = Math.max(800, Number(stored.autoDelayMs) || seekDelayMs || 4200);
    delayCompEnabled = stored.delayCompEnabled !== false;
    delayLaptopMs = Math.max(
      0,
      Number(stored.delayLaptopMs ?? stored.tvLagCompMs) || 1350
    );
    delayTvMs = Math.max(0, Number(stored.delayTvMs) || 0);
    if (castingSession) applyModeBehavior();
    watchNavigation();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
