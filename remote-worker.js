/* Remote control, service worker side. Loaded by background.js.
 *
 * Holds the SSE stream to the local server, carries out commands, and reports
 * playback state back. See remote.js for the pure helpers and the reasoning
 * behind streaming fetch rather than EventSource.
 *
 * Nothing in here runs unless the user turned remote control on and stored a
 * server and token. `stop()` is called on every settings change, so switching
 * it off drops the connection immediately rather than at the next reconnect.
 */

const R = self.__autoSkipRemote;

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const ALARM = 'auto-skip-remote-watchdog';

let abort = null; // AbortController for the live stream
let connected = false;
let backoff = RECONNECT_MIN_MS;
/* The tab a command should act on. Set when a player reports in, cleared when
 * that tab goes away. */
let playerTabId = null;
const playingTabs = new Set();

/* ------------------------------------------------------------------ settings */

async function remoteSettings() {
  try {
    const { remote } = await chrome.storage.sync.get({ remote: {} });
    const server = R.normalizeServer(remote?.server);
    return {
      enabled: !!remote?.enabled && !!server && !!remote?.token,
      server,
      token: remote?.token || '',
    };
  } catch (_) {
    return { enabled: false, server: null, token: '' };
  }
}

const api = (settings, path) => `${settings.server}${path}`;

/* --------------------------------------------------------------- the stream */

async function connect() {
  const settings = await remoteSettings();
  if (!settings.enabled) return stop();
  if (abort) return; // already connected or connecting

  abort = new AbortController();
  const url = `${api(settings, '/api/events')}?token=${encodeURIComponent(settings.token)}`;

  try {
    const response = await fetch(url, { signal: abort.signal, cache: 'no-store' });
    if (!response.ok || !response.body) {
      throw new Error(`server said ${response.status}`);
    }
    connected = true;
    backoff = RECONNECT_MIN_MS;
    console.log('[auto-skip] remote connected to', settings.server);
    report(); // let the phone see the current state straight away

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parse = R.createFrameParser();

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const frame of parse(decoder.decode(value, { stream: true }))) {
        if (frame.event === 'command') {
          handleCommand(frame.data).catch((error) =>
            console.error('[auto-skip] remote command failed:', error)
          );
        }
      }
    }
    throw new Error('stream ended');
  } catch (error) {
    if (abort?.signal.aborted) return; // we closed it on purpose
    console.warn('[auto-skip] remote disconnected:', error.message);
  } finally {
    connected = false;
    abort = null;
  }

  /* Reconnect with backoff. The watchdog alarm covers the case where this
   * worker is evicted before the timer fires. */
  const wait = backoff;
  backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  setTimeout(() => connect().catch(() => {}), wait);
}

function stop() {
  if (abort) {
    const controller = abort;
    abort = null;
    controller.abort();
  }
  connected = false;
}

/* ------------------------------------------------------------------ commands */

const SITE_MATCHES = self.__autoSkipSites.SITES.flatMap((site) => site.matches);

async function findPlayerTab() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: SITE_MATCHES });
  } catch (_) {
    return null;
  }
  /* chrome.tabs.query does not report the window type, and preferring an app
   * window is the whole point on Windows, where these services run as Edge
   * PWAs. So ask about the windows the candidates are actually in. */
  const windowTypes = new Map();
  for (const id of new Set(tabs.map((tab) => tab.windowId))) {
    try {
      const win = await chrome.windows.get(id);
      windowTypes.set(id, win.type);
    } catch (_) {
      /* window closed underneath us */
    }
  }
  const annotated = tabs.map((tab) => ({ ...tab, windowType: windowTypes.get(tab.windowId) }));
  return R.pickPlayerTab(annotated, {
    preferTabId: playerTabId,
    playingTabIds: [...playingTabs],
  });
}

async function toPlayer(message) {
  const tab = await findPlayerTab();
  if (!tab) throw new Error('no streaming tab open');
  playerTabId = tab.id;
  return chrome.tabs.sendMessage(tab.id, message);
}

async function setFullscreen(windowId, on) {
  /* The window API needs no user gesture. A content script calling
   * requestFullscreen() has no transient activation and is refused, and a
   * synthetic click on the player's own button is isTrusted:false and ignored.
   * On a PWA window this is what the user meant by "fullscreen" anyway. */
  try {
    await chrome.windows.update(windowId, { state: on ? 'fullscreen' : 'normal', focused: true });
  } catch (error) {
    console.warn('[auto-skip] could not change window state:', error.message);
  }
}

async function handleCommand(command) {
  if (!command || typeof command.type !== 'string') return;

  switch (command.type) {
    case 'open': {
      const tab = await findPlayerTab();
      let target = tab;
      if (target) {
        await chrome.tabs.update(target.id, { url: command.url, active: true });
      } else {
        target = await chrome.tabs.create({ url: command.url, active: true });
      }
      playerTabId = target.id;
      if (command.fullscreen) {
        // Let the navigation commit first; fullscreening a blank tab is a
        // fullscreen blank tab.
        setTimeout(() => setFullscreen(target.windowId, true), 1200);
      }
      return;
    }

    case 'fullscreen': {
      const tab = await findPlayerTab();
      if (!tab) throw new Error('no streaming tab open');
      return setFullscreen(tab.windowId, command.on);
    }

    case 'refresh':
      return toPlayer({ type: 'auto-skip:harvest' });

    default:
      /* play, pause, playPause, seek, skip, nextEpisode, volume, mute — all of
       * these are things only the page can do. */
      return toPlayer({ type: 'auto-skip:control', command });
  }
}

/* -------------------------------------------------------------------- report */

let lastReport = 0;

async function report(extra = {}) {
  const settings = await remoteSettings();
  if (!settings.enabled) return;
  lastReport = Date.now();
  try {
    await fetch(api(settings, '/api/state'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.token}`,
      },
      body: JSON.stringify(extra),
    });
  } catch (_) {
    /* the server going away is the stream's problem, not the report's */
  }
}

/* Content scripts report their own state; this forwards it and remembers which
 * tab is actually playing so commands land on the right one. */
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'auto-skip:state') return false;
  const tabId = sender.tab?.id;
  if (typeof tabId === 'number') {
    if (message.playing) playingTabs.add(tabId);
    else playingTabs.delete(tabId);
    playerTabId = tabId;
  }
  report(message.state || {});
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  playingTabs.delete(tabId);
  if (playerTabId === tabId) playerTabId = null;
});

/* --------------------------------------------------------------------- wake */

/* Settings changes take effect now, not at the next reconnect. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !('remote' in changes)) return;
  stop();
  connect().catch(() => {});
});

/* The backstop. An evicted worker loses the reconnect timer, and the alarm is
 * what brings it back — one minute is the shortest period MV3 allows. */
chrome.alarms.create(ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  if (!connected) connect().catch(() => {});
});

connect().catch(() => {});

self.__autoSkipRemoteStatus = () => ({ connected, playerTabId, lastReport });
