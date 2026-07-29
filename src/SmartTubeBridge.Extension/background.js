const API = 'http://localhost:8765/api';

/** @type {Map<number, boolean>} */
const shiftByTab = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'play-smarttube',
      title: 'Play on SmartTube',
      contexts: ['page', 'link'],
      documentUrlPatterns: ['*://*.youtube.com/*', '*://youtu.be/*'],
    });
    chrome.contextMenus.create({
      id: 'stop-smarttube',
      title: 'Stop Casting to TV',
      contexts: ['page'],
      documentUrlPatterns: ['*://*.youtube.com/*', '*://youtu.be/*'],
    });
    chrome.contextMenus.create({
      id: 'search-smarttube',
      title: 'Search on SmartTube',
      contexts: ['selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'play-smarttube') {
    const url = info.linkUrl || info.pageUrl;
    if (url) await castWithMode(url, tab?.id);
  }
  if (info.menuItemId === 'stop-smarttube') {
    await stopCasting(tab?.id);
  }
  if (info.menuItemId === 'search-smarttube' && info.selectionText) {
    await apiPost('/cast/search', { query: info.selectionText });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender).then(sendResponse).catch(err => {
    sendResponse({ success: false, message: err.message || String(err) });
  });
  return true;
});

async function handleMessage(request, sender) {
  switch (request.action) {
    case 'shiftState': {
      const tabId = sender.tab?.id;
      if (tabId != null) shiftByTab.set(tabId, !!request.held);
      return { success: true };
    }
    case 'getShiftState': {
      const tabId = request.tabId;
      return { success: true, shiftHeld: !!(tabId != null && shiftByTab.get(tabId)) };
    }
    case 'cast':
      return castWithMode(request.url, sender.tab?.id, request.mode);
    case 'stopCast':
      return stopCasting(sender.tab?.id);
    case 'media':
      return apiPost(`/media/${request.endpoint}`, {});
    case 'volume':
      return apiPost('/media/volume', { level: Number(request.level) || 0 });
    case 'seek':
      return apiPost('/media/seek', {
        positionMs: Number(request.positionMs) || 0,
        videoId: request.videoId || undefined,
      });
    case 'position':
      return apiGet('/media/position');
    case 'status':
      return apiGet('/status');
    case 'search':
      return apiPost('/cast/search', { query: request.query });
    case 'scan':
      return apiPost('/device/scan', {});
    case 'devices': {
      const scanned = await apiPost('/device/scan', {});
      if (scanned?.success) return scanned;
      return apiGet('/device');
    }
    case 'connect':
      return apiPost('/device/connect', {
        ip: request.ip,
        port: request.port || 5555,
        serial: request.serial,
      });
    case 'disconnect': {
      const status = await apiGet('/status');
      const serial = status?.data?.currentDevice?.serial;
      if (!serial) return { success: false, message: 'No device connected' };
      return apiPost('/device/disconnect', { serial });
    }
    case 'settingsGet':
      return apiGet('/settings');
    case 'settingsSave': {
      const current = await apiGet('/settings');
      const cfg = {
        ...(current?.data || {}),
        adbPath: request.adbPath,
        packageName: request.packageName,
        wakeDelayMs: request.wakeDelayMs,
      };
      return apiPost('/settings', cfg);
    }
    case 'logs':
      return apiGet('/logs?max=40');
    default:
      return { success: false, message: 'Unknown action' };
  }
}

async function castWithMode(url, tabId, mode) {
  try {
    const stored = await chrome.storage.sync.get({ playbackMode: 'tvOnly' });
    const playbackMode = mode || stored.playbackMode || 'tvOnly';
    const result = await apiPost('/cast', { url });
    if (result?.success !== false) {
      const m = String(url || '').match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
        String(url || '').match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
      const lastCastVideoId = m ? m[1] : undefined;
      await chrome.storage.sync.set({
        castingSession: true,
        playbackMode,
        ...(lastCastVideoId ? { lastCastVideoId } : {}),
      });
      const msg = { action: 'applyCastMode', mode: playbackMode };
      await notifyTab(tabId, msg);
      await notifyYouTubeTabs(msg, tabId);
    }
    return result;
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function stopCasting(tabId) {
  try {
    await apiPost('/media/pause', {});
    await apiPost('/media/stop', {});
    await chrome.storage.sync.set({ castingSession: false });
    await notifyTab(tabId, { action: 'stopLocalCastUi' });
    await notifyYouTubeTabs({ action: 'stopLocalCastUi' }, tabId);
    return { success: true, message: 'Casting stopped' };
  } catch (e) {
    await chrome.storage.sync.set({ castingSession: false });
    return { success: false, message: e.message };
  }
}

async function notifyTab(tabId, message) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch { /* content script may not be ready */ }
}

async function notifyYouTubeTabs(message, excludeTabId) {
  try {
    const tabs = await chrome.tabs.query({ url: ['*://*.youtube.com/*', '*://youtu.be/*'] });
    await Promise.all(tabs.map(async (t) => {
      if (excludeTabId != null && t.id === excludeTabId) return;
      try { await chrome.tabs.sendMessage(t.id, message); } catch { /* */ }
    }));
  } catch { /* */ }
}

async function apiGet(path) {
  try {
    const resp = await fetch(`${API}${path}`);
    return await resp.json();
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function apiPost(path, body) {
  try {
    const resp = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return await resp.json();
  } catch (e) {
    return { success: false, message: e.message };
  }
}
