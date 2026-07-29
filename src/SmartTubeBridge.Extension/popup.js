const DEFAULTS = {
  playOnClick: false,
  expanded: false,
  castingSession: false,
  playbackMode: 'tvOnly',
  seekDelayMs: 4200,
  manualDelay: false,
  delayCompEnabled: true,
  delayLaptopMs: 1350,
  delayTvMs: 0,
};

/** @type {ReturnType<typeof setInterval>|null} */
let volumeHoldTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const url = tab?.url || '';
  const videoId = extractVideoId(url);

  applyExpanded(!!stored.expanded);
  g('play-on-click').checked = !!stored.playOnClick;
  g('play-on-click-hint').classList.toggle('hidden', !stored.playOnClick);
  g('playback-mode').value = stored.playbackMode || 'tvOnly';
  const delayMs = Math.max(0, Number(stored.seekDelayMs) || 4200);
  g('delay-slider').value = String(delayMs);
  g('delay-label').textContent = `${(delayMs / 1000).toFixed(1)}s`;
  g('manual-delay').checked = !!stored.manualDelay;
  g('delay-comp').checked = stored.delayCompEnabled !== false;
  g('delay-laptop').value = String(Math.max(0, Number(stored.delayLaptopMs) || 1350));
  g('delay-laptop-label').textContent = `${(Number(g('delay-laptop').value) / 1000).toFixed(1)}s`;
  g('delay-tv').value = String(Math.max(0, Number(stored.delayTvMs) || 0));
  g('delay-tv-label').textContent = `${(Number(g('delay-tv').value) / 1000).toFixed(1)}s`;
  setStopCastVisible(!!stored.castingSession);
  updateDelayVisibility();

  if (stored.playOnClick && videoId) {
    const shiftHeld = await getShiftHeld(tab?.id);
    if (!shiftHeld) {
      g('status-msg').textContent = 'Playing…';
      await send('cast', { url, mode: g('playback-mode').value });
      setStopCastVisible(true);
    } else {
      g('status-msg').textContent = 'Bypassed (Shift held)';
    }
  }

  g('playback-mode').onchange = async () => {
    const mode = g('playback-mode').value;
    await chrome.storage.sync.set({ playbackMode: mode });
    g('status-msg').textContent = `Mode: ${mode}`;
    try {
      const tabs2 = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs2[0]?.id) {
        await chrome.tabs.sendMessage(tabs2[0].id, { action: 'applyCastMode', mode });
      }
    } catch { /* */ }
  };

  g('cast-btn').onclick = async () => {
    await send('cast', { url, mode: g('playback-mode').value });
    setStopCastVisible(true);
  };
  g('stop-cast-btn').onclick = async () => {
    await send('stopCast', {});
    setStopCastVisible(false);
  };
  g('sync-btn').onclick = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.tabs.sendMessage(tab.id, { action: 'syncNow' });
      }
    } catch {
      // Fallback: seek TV to last known slider time if content script unavailable
      const sec = Number(g('seek-slider').value) || 0;
      const stored = await chrome.storage.sync.get({ lastCastVideoId: null });
      await send('seek', {
        positionMs: Math.round(sec * 1000),
        videoId: stored.lastCastVideoId || undefined,
      });
    }
  };

  let seeking = false;
  g('seek-slider').oninput = () => {
    seeking = true;
    g('seek-label').textContent = formatTime(Number(g('seek-slider').value));
  };
  const commitSeek = async () => {
    const sec = Number(g('seek-slider').value) || 0;
    try {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (t?.id) {
        await chrome.tabs.sendMessage(t.id, { action: 'alignedSeek', sec });
        seeking = false;
        return;
      }
    } catch { /* fall through */ }
    const storedSeek = await chrome.storage.sync.get({ lastCastVideoId: null });
    await send('seek', {
      positionMs: Math.round(sec * 1000),
      videoId: storedSeek.lastCastVideoId || undefined,
    });
    seeking = false;
  };
  g('seek-slider').onchange = commitSeek;
  g('seek-slider').onmouseup = commitSeek;

  const seekTip = g('seek-tip');
  const showSeekTip = (e) => {
    const slider = g('seek-slider');
    const rect = slider.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const max = Number(slider.max) || 0;
    seekTip.textContent = formatTime(ratio * max);
    seekTip.style.left = `${ratio * 100}%`;
    seekTip.classList.remove('hidden');
  };
  g('seek-slider').addEventListener('mousemove', showSeekTip);
  g('seek-slider').addEventListener('mouseenter', showSeekTip);
  g('seek-slider').addEventListener('mouseleave', () => seekTip.classList.add('hidden'));

  g('delay-slider').oninput = () => {
    const ms = Math.max(0, Number(g('delay-slider').value) || 0);
    g('delay-label').textContent = `${(ms / 1000).toFixed(1)}s`;
  };
  g('delay-slider').onchange = async () => {
    const ms = Math.max(0, Number(g('delay-slider').value) || 0);
    await chrome.storage.sync.set({ seekDelayMs: ms });
    g('status-msg').textContent = `Settle ${(ms / 1000).toFixed(1)}s`;
  };
  g('manual-delay').onchange = async () => {
    const on = g('manual-delay').checked;
    await chrome.storage.sync.set({ manualDelay: on });
    updateDelayVisibility();
    g('status-msg').textContent = on ? 'Manual settle on' : 'Auto settle on';
  };

  async function setDelayComp(on) {
    await chrome.storage.sync.set({ delayCompEnabled: !!on });
    g('delay-comp').checked = !!on;
    updateDelayVisibility();
    g('status-msg').textContent = on ? 'Delays on' : 'Delay Off — raw sync';
  }
  g('delay-off-btn').onclick = () => setDelayComp(!g('delay-comp').checked);
  g('delay-comp').onchange = () => setDelayComp(g('delay-comp').checked);

  g('delay-laptop').oninput = () => {
    g('delay-laptop-label').textContent =
      `${(Number(g('delay-laptop').value) / 1000).toFixed(1)}s`;
  };
  g('delay-laptop').onchange = async () => {
    const ms = Math.max(0, Number(g('delay-laptop').value) || 0);
    await chrome.storage.sync.set({ delayLaptopMs: ms });
    g('status-msg').textContent = `Delay laptop ${(ms / 1000).toFixed(1)}s`;
  };
  g('delay-tv').oninput = () => {
    g('delay-tv-label').textContent =
      `${(Number(g('delay-tv').value) / 1000).toFixed(1)}s`;
  };
  g('delay-tv').onchange = async () => {
    const ms = Math.max(0, Number(g('delay-tv').value) || 0);
    await chrome.storage.sync.set({ delayTvMs: ms });
    g('status-msg').textContent = `Delay TV ${(ms / 1000).toFixed(1)}s`;
  };

  document.querySelectorAll('[data-action]').forEach(btn => {
    const action = btn.dataset.action;
    if (action === 'volume/up' || action === 'volume/down') {
      bindHoldRepeat(btn, action);
      return;
    }
    btn.addEventListener('click', async () => {
      if (action === 'playpause') {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) {
            await chrome.tabs.sendMessage(tab.id, { action: 'syncedPlayPause' });
            return;
          }
        } catch { /* fall through */ }
      }
      send('media', { endpoint: action });
    });
  });

  g('search-go').onclick = () => {
    const q = g('search-input').value.trim();
    if (q) send('search', { query: q });
  };
  g('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') g('search-go').click();
  });

  g('play-on-click').onchange = async () => {
    const enabled = g('play-on-click').checked;
    await chrome.storage.sync.set({ playOnClick: enabled });
    g('play-on-click-hint').classList.toggle('hidden', !enabled);
  };

  g('expand-btn').onclick = async () => {
    const next = !document.body.classList.contains('expanded');
    applyExpanded(next);
    await chrome.storage.sync.set({ expanded: next });
    if (next) {
      await refreshDevices();
      await refreshSettings();
      await refreshLogs();
    }
  };

  g('manual-ip').oninput = () => {
    g('connect-btn').disabled = !g('manual-ip').value.trim();
  };
  g('scan-btn').onclick = () => refreshDevices(true);
  g('connect-btn').onclick = async () => {
    const ip = g('manual-ip').value.trim();
    if (!ip) return;
    await send('connect', { ip, port: 5555 });
    await refreshDevices();
    await updateStatus();
  };
  g('disconnect-btn').onclick = async () => {
    await send('disconnect', {});
    await updateStatus();
    await refreshDevices();
  };
  g('save-settings').onclick = async () => {
    await send('settingsSave', {
      adbPath: g('adb-path').value.trim(),
      packageName: g('package-name').value.trim(),
      wakeDelayMs: Number(g('wake-delay').value),
    });
  };
  g('refresh-logs').onclick = () => refreshLogs();
  g('test-connection').onclick = async () => {
    await updateStatus();
    g('status-msg').textContent = g('status-dot').classList.contains('online')
      ? `OK — ${g('device-name').textContent}`
      : 'Service offline or no device';
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.castingSession) {
      setStopCastVisible(!!changes.castingSession.newValue);
    }
    if (area === 'sync' && changes.playbackMode) {
      g('playback-mode').value = changes.playbackMode.newValue || 'tvOnly';
    }
  });

  await updateStatus();
  if (stored.expanded) {
    await refreshDevices();
    await refreshSettings();
    await refreshLogs();
  }
  setInterval(updateStatus, 5000);

  setInterval(async () => {
    if (g('stop-cast-btn').classList.contains('hidden') || seeking) return;
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'position' });
      const d = resp?.data;
      if (!d?.available) return;
      const sec = Math.floor((d.positionMs || 0) / 1000);
      const dur = Math.max(1, Math.floor((d.durationMs || 0) / 1000));
      const slider = g('seek-slider');
      if (dur > 1) slider.max = String(dur);
      slider.value = String(sec);
      g('seek-label').textContent = formatTime(sec);
    } catch { /* */ }
  }, 2000);
});

function g(id) { return document.getElementById(id); }

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function setStopCastVisible(on) {
  g('stop-cast-btn').classList.toggle('hidden', !on);
  g('sync-btn').classList.toggle('hidden', !on);
  g('delay-row').classList.toggle('hidden', !on);
  g('seek-row').classList.toggle('hidden', !on);
  updateDelayVisibility();
}

function updateDelayVisibility() {
  const casting = !g('stop-cast-btn').classList.contains('hidden');
  const compOn = g('delay-comp').checked;
  const manual = g('manual-delay').checked;
  g('comp-sliders').classList.toggle('hidden', !(casting && compOn));
  g('delay-slider-row').classList.toggle('hidden', !(casting && manual));
  g('delay-off-btn').textContent = compOn ? 'Delay Off' : 'Delay On';
}

function bindHoldRepeat(btn, endpoint) {
  const start = (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ action: 'media', endpoint });
    clearInterval(volumeHoldTimer);
    volumeHoldTimer = setInterval(() => {
      chrome.runtime.sendMessage({ action: 'media', endpoint });
    }, 180);
  };
  const stop = () => {
    clearInterval(volumeHoldTimer);
    volumeHoldTimer = null;
  };
  btn.addEventListener('mousedown', start);
  btn.addEventListener('touchstart', start, { passive: false });
  ['mouseup', 'mouseleave', 'touchend', 'touchcancel', 'blur'].forEach(ev =>
    btn.addEventListener(ev, stop));
  window.addEventListener('mouseup', stop);
}

function applyExpanded(on) {
  document.body.classList.toggle('expanded', on);
  g('expand-panel').classList.toggle('hidden', !on);
  g('expand-btn').textContent = on ? '▴' : '↕';
}

function extractVideoId(url) {
  const m = String(url).match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function getShiftHeld(tabId) {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getShiftState', tabId });
    return !!resp?.shiftHeld;
  } catch {
    return false;
  }
}

async function updateStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'status' });
    if (resp?.success && resp.data) {
      const s = resp.data;
      const connected = s.isConnected;
      g('status-dot').className = 'dot ' + (connected ? 'online' : 'offline');
      g('device-name').textContent = connected
        ? (s.currentDevice?.friendlyName || s.currentDevice?.serial || 'Connected')
        : 'Not connected';
      g('device-info').className = 'device-row ' + (connected ? 'connected' : 'disconnected');
    } else setOffline();
  } catch { setOffline(); }
}

function setOffline() {
  g('status-dot').className = 'dot offline';
  g('device-name').textContent = 'Service offline';
  g('device-info').className = 'device-row disconnected';
}

async function refreshDevices(doScan = false) {
  try {
    const resp = await chrome.runtime.sendMessage({ action: doScan ? 'scan' : 'devices' });
    const list = g('device-list');
    list.innerHTML = '';
    const devices = resp?.data || [];
    if (!devices.length) {
      list.innerHTML = '<li><span>No devices</span></li>';
      return;
    }
    for (const d of devices) {
      const li = document.createElement('li');
      const transport = d.transport === 'tcpip' ? (d.ipAddress || d.serial) : 'USB';
      li.innerHTML = `<span>${escapeHtml(d.friendlyName || d.serial)}</span><span class="meta">${escapeHtml(String(d.state))} · ${escapeHtml(transport)}</span>`;
      li.onclick = async () => {
        if (d.ipAddress) {
          g('manual-ip').value = d.ipAddress;
          g('connect-btn').disabled = false;
          await send('connect', { ip: d.ipAddress, port: d.port || 5555 });
        } else if (d.serial) {
          await send('connect', { serial: d.serial });
        }
        await updateStatus();
      };
      list.appendChild(li);
    }
  } catch (e) { showError(e.message); }
}

async function refreshSettings() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'settingsGet' });
    const cfg = resp?.data;
    if (!cfg) return;
    g('adb-path').value = cfg.adbPath || '';
    g('package-name').value = cfg.packageName || 'org.smarttube.stable';
    const wake = String(cfg.wakeDelayMs || 500);
    const sel = g('wake-delay');
    if ([...sel.options].some(o => o.value === wake)) sel.value = wake;
  } catch (e) { showError(e.message); }
}

async function refreshLogs() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'logs' });
    const logs = resp?.data || [];
    g('log-list').textContent = logs.length
      ? logs.slice(0, 40).map(l => {
          const t = l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : '';
          return `[${t}] [${l.level}] [${l.source}] ${l.message}`;
        }).join('\n')
      : 'No logs';
  } catch (e) { g('log-list').textContent = e.message; }
}

async function send(action, payload) {
  hideError();
  g('status-msg').textContent = 'Sending…';
  try {
    const resp = await chrome.runtime.sendMessage({ action, ...payload });
    if (resp?.success !== false) {
      g('status-msg').textContent = resp?.message || 'Done';
      if (action === 'cast') setStopCastVisible(true);
      if (action === 'stopCast') setStopCastVisible(false);
      return resp;
    }
    g('status-msg').textContent = 'Failed';
    showError(resp?.message || 'Unknown error');
    return resp;
  } catch (e) {
    showError(e.message);
    g('status-msg').textContent = 'Error';
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function showError(m) { g('error').textContent = m; g('error').classList.remove('hidden'); }
function hideError() { g('error').classList.add('hidden'); }
