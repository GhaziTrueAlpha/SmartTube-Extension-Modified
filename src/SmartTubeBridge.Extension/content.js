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

  function seekLaptopSeconds(sec, { force = false } = {}) {
    // Never rewind the laptop from TV near the start — that causes the end→0 loop.
    if (!force) {
      const local = laptopPositionSec();
      const dur = laptopDurationSec();
      if (sec < 2 && local > 8) return;
      if (dur > 0 && local > dur - 5) return;
    }

    blockUserSeekEvents(3500);
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

  async function api(action, payload = {}) {
    return chrome.runtime.sendMessage({ action, ...payload });
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

  /**
   * Do NOT change playbackRate — that made songs sound slow on the laptop
   * while the TV stayed at normal speed. Keep rate at 1; use Sync/seek lag
   * compensation only for alignment.
   */
  function applyTimeBridge(_local, _tvSec, _tvPlaying) {
    resetLaptopRate();
  }

  /** Read TV clock; return seconds or null. */
  async function readTvSeconds() {
    try {
      const resp = await api('position', {});
      const d = resp?.data;
      if (!d?.available || !Number.isFinite(d.positionMs)) return null;
      return Math.max(0, d.positionMs / 1000);
    } catch {
      return null;
    }
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
      // Independent: no force pause / no sync loop.
      resetLaptopRate();
      restoreLaptopAudio();
      const v = getLaptopVideo();
      if (v) v.loop = false;
      bindLaptopSeekHandlers(false);
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

  function bindLaptopSeekHandlers(enableLiveSync = true) {
    const v = getLaptopVideo();
    if (!v || v.dataset.stbSeekBound === '1') return;
    v.dataset.stbSeekBound = '1';

    let lastUserSeekPos = -1;

    const onUserSeek = () => {
      if (!castingSession || syncingFromTv || seekingUi || seekAlignInProgress) return;
      if (Date.now() < ignoreUserSeekUntil) return;
      if (playbackMode === 'tvOnly') return;

      const sec = laptopPositionSec();
      // Ignore tiny / duplicate seek events (YouTube fires many during buffer).
      if (lastUserSeekPos >= 0 && Math.abs(sec - lastUserSeekPos) < 1.25) return;
      lastUserSeekPos = sec;

      clearTimeout(seekDebounce);
      seekDebounce = setTimeout(() => {
        if (!castingSession || seekAlignInProgress || Date.now() < ignoreUserSeekUntil) return;
        const now = laptopPositionSec();
        if (playbackMode === 'synced') {
          // Block the seeked storms that alignedSeek itself generates.
          blockUserSeekEvents(5000);
          alignedSeek(now, { label: 'Seek' });
        } else {
          pushSeekToTv(now);
          updateSeekUi(now, laptopDurationSec());
        }
      }, 400);
    };

    v.addEventListener('seeking', onUserSeek);
    v.addEventListener('seeked', onUserSeek);
  }

  function startSyncPoll() {
    stopSyncPoll();
    // Synced mode: pause mirror + continuous time bridge to TV.
    syncPollTimer = setInterval(async () => {
      if (!(castingSession && playbackMode === 'synced') || seekingUi || seekAlignInProgress) return;

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
        const resp = await api('position', {});
        const d = resp?.data;
        if (!d?.available) return;
        const tvSec = (d.positionMs || 0) / 1000;

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

        // Constant bridge while both playing
        if (d.isPlaying && !laptopPaused && !syncedPaused) {
          applyTimeBridge(local, tvSec, true);
        }
      } catch { /* */ }
    }, 1000);
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
    ensureSingleBar();
    updateBarCastingUi(true);
    applyModeBehavior();
    setStatus(fromAuto ? 'Auto-casting…' : 'Casting…', 'busy');

    try {
      const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
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
    resetLaptopRate();
    restoreLaptopAudio();
    updateBarCastingUi(false);
    setStatus('Casting stopped', 'ok');
  }

  /**
   * Re-align after drift: pause laptop at current spot, re-seek TV there,
   * wait for TV settle delay, then start both together.
   */
  async function syncNow() {
    if (!castingSession) {
      setStatus('Cast first, then Sync', 'error');
      return;
    }
    const sec = laptopPositionSec();
    await alignedSeek(sec, { label: 'Sync' });
  }

  function setStatus(text, kind) {
    const el = document.getElementById('stb-status');
    if (!el) return;
    el.textContent = text || '';
    el.dataset.kind = kind || '';
  }

  function updateBarCastingUi(on) {
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    bar.classList.toggle('stb-casting', !!on);
    const castBtn = bar.querySelector('[data-stb="cast"]');
    const stopBtn = bar.querySelector('[data-stb="stop"]');
    const syncBtn = bar.querySelector('[data-stb="sync"]');
    const seekWrap = bar.querySelector('.stb-seek-wrap');
    const delayWrap = bar.querySelector('.stb-delay-wrap');
    if (castBtn) castBtn.textContent = on ? '↻ Recast' : '📺 Play on TV';
    if (stopBtn) stopBtn.classList.toggle('stb-hidden', !on);
    if (syncBtn) syncBtn.classList.toggle('stb-hidden', !on);
    if (seekWrap) seekWrap.classList.toggle('stb-hidden', !on);
    if (delayWrap) delayWrap.classList.toggle('stb-hidden', !on);
    updateDelayUi();
  }

  function updateModeUi() {
    const sel = document.getElementById('stb-mode');
    if (sel && sel.value !== playbackMode) sel.value = playbackMode;
  }

  function updateSeekUi(posSec, durSec) {
    const slider = document.getElementById('stb-seek');
    const label = document.getElementById('stb-seek-label');
    if (!slider || seekingUi) return;
    const dur = Math.max(1, Math.floor(durSec || Number(slider.max) || 1));
    slider.max = String(dur);
    slider.value = String(Math.floor(Math.min(dur, Math.max(0, posSec || 0))));
    if (label) label.textContent = `${formatTime(posSec)} / ${formatTime(dur)}`;
  }

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
    bar.innerHTML = `
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
      <div class="stb-seek-wrap stb-hidden">
        <span>Seek</span>
        <div class="stb-seek-track">
          <input id="stb-seek" type="range" min="0" max="100" value="0">
          <div id="stb-seek-tip" class="stb-seek-tip stb-hidden">0:00</div>
        </div>
        <span class="stb-seek-label" id="stb-seek-label">0:00 / 0:00</span>
      </div>
    `;

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

    const seek = bar.querySelector('#stb-seek');
    const tip = bar.querySelector('#stb-seek-tip');
    const commitSeek = async () => {
      const sec = Number(seek.value) || 0;
      updateSeekUi(sec, Number(seek.max) || laptopDurationSec());
      clearTimeout(seekDebounce);
      seekDebounce = setTimeout(async () => {
        if (playbackMode === 'synced') {
          await alignedSeek(sec, { label: 'Seek' });
        } else {
          await pushSeekToTv(sec);
          seekingUi = false;
        }
      }, 80);
    };
    seek.addEventListener('mousedown', () => { seekingUi = true; });
    seek.addEventListener('touchstart', () => { seekingUi = true; }, { passive: true });
    seek.addEventListener('input', () => {
      seekingUi = true;
      updateSeekUi(Number(seek.value), Number(seek.max));
    });
    seek.addEventListener('change', commitSeek);
    seek.addEventListener('mouseup', commitSeek);
    seek.addEventListener('touchend', commitSeek);

    const showTip = (e) => {
      if (!tip) return;
      const rect = seek.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const max = Number(seek.max) || laptopDurationSec() || 0;
      const sec = ratio * max;
      tip.textContent = formatTime(sec);
      tip.style.left = `${ratio * 100}%`;
      tip.classList.remove('stb-hidden');
    };
    seek.addEventListener('mousemove', showTip);
    seek.addEventListener('mouseenter', showTip);
    seek.addEventListener('mouseleave', () => tip?.classList.add('stb-hidden'));

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
        onVideoChanged(id);
      } else {
        ensureSingleBar();
      }
    };
    tick();
    setInterval(tick, 1500);
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
