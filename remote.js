/* Remote control — the browser half of Auto Skip Remote.
 *
 * OFF BY DEFAULT, and it must stay that way. Auto Skip makes no network
 * requests; turning this on is the user deciding otherwise, for one server they
 * named. Nothing here runs until `remote.enabled` is true and a server URL and
 * token are stored.
 *
 * WHY A STREAMING FETCH, NOT EventSource OR A WEBSOCKET
 *
 * A service worker has no EventSource. It could be held in an offscreen
 * document, but every offscreen `reason` describes a DOM capability we do not
 * need, and declaring one we are not using is a lie in the manifest.
 *
 * So the worker consumes the SSE stream itself with fetch() and a stream
 * reader. An MV3 worker is evicted after 30 seconds idle, and incoming stream
 * chunks count as activity — which is exactly why the server sends a comment
 * frame every 25 seconds. The alarm below is the backstop for the case the
 * stream dies silently: it re-checks once a minute and reconnects.
 *
 * This file also loads under node, so the frame parser is unit-tested. That
 * parser is not incidental — SSE frames arrive split across chunk boundaries,
 * and the `retry:` preamble and `: ping` comments are frames that carry no
 * event. Getting that wrong fails in the most annoying way possible: it works
 * on a fast local connection and drops commands on a slow one.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__autoSkipRemote = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------ frame parser */

  /* Feed it chunks, get back complete events. Holds the partial tail between
   * calls, because a frame is not guaranteed to arrive whole. */
  function createFrameParser() {
    let buffer = '';
    return function push(chunk) {
      buffer += chunk;
      const events = [];
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const parsed = parseFrame(frame);
        if (parsed) events.push(parsed);
      }
      return events;
    };
  }

  /* Returns null for anything that is not an event: comments (`: ping`), the
   * `retry:` preamble, and frames whose data is not JSON. */
  function parseFrame(frame) {
    let event = null;
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (!event) return null;
    let data = null;
    if (dataLines.length) {
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch (_) {
        return null; // a frame we cannot read is a frame we must not act on
      }
    }
    return { event, data };
  }

  /* --------------------------------------------------------------- server url */

  /* The user types this, so it gets the benefit of the doubt about scheme and
   * trailing slashes — but it must end up a real http(s) origin, because it is
   * about to be handed to chrome.permissions.request(). */
  function normalizeServer(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    /* Three cases, and both naive versions of this are wrong:
     *
     *   "starts with http"     turns ftp://pc.local into http://ftp://pc.local,
     *                          which parses — as the host `ftp`.
     *   "contains a colon"     treats pc.local:8787 as the scheme `pc.local`,
     *                          because dots and dashes are legal scheme chars.
     *
     * So: a scheme is a scheme only when followed by `//`. A colon followed by
     * digits is a port on a bare host. Anything else with a colon (`mailto:`,
     * `javascript:`) is refused rather than guessed at. */
    let candidate;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) candidate = text;
    else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return null;
    else candidate = `http://${text}`;

    let url;
    try {
      url = new URL(candidate);
    } catch (_) {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.origin;
  }

  /* --------------------------------------------------------- tab preference */

  /* Which open tab is "the player"? Preferring an app window matters: the
   * Windows Crunchyroll/Netflix/Disney+/Prime apps are Edge PWAs, so the tab
   * the user means is usually the one in a window of type "app", not a tab in
   * the middle of a browsing session. After that, prefer the one that reported
   * a <video>, then the most recently active.
   *
   * Pure, and exported, so the ordering is testable without a browser. */
  function pickPlayerTab(tabs, options = {}) {
    const { preferTabId = null, playingTabIds = [] } = options;
    const playing = new Set(playingTabIds);
    const scored = tabs
      .filter((tab) => tab && typeof tab.id === 'number')
      .map((tab) => {
        let score = 0;
        if (tab.id === preferTabId) score += 1000;
        if (playing.has(tab.id)) score += 500;
        if (tab.windowType === 'app') score += 100;
        if (tab.audible) score += 50;
        if (tab.active) score += 10;
        return { tab, score, at: tab.lastAccessed || 0 };
      });
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score || b.at - a.at);
    return scored[0].tab;
  }

  return { createFrameParser, parseFrame, normalizeServer, pickPlayerTab };
});
