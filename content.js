/* Crunchyroll Auto Skip — content script
 *
 * Injected into crunchyroll.com and into the Vilos player iframe (all_frames: true).
 * It only acts inside the video player on a watch page, and only clicks controls
 * Crunchyroll itself renders: "Skip Intro", "Skip Recap", "Skip Credits", the
 * up-next card, and the "still watching?" prompt.
 */
(() => {
  'use strict';

  if (window.__crAutoSkipActive) return;
  window.__crAutoSkipActive = true;

  const M = globalThis.__crAutoSkipMatchers;
  if (!M) {
    // Unconditional: this is a genuine fault, and silence here looks identical
    // to "the extension is running fine but nothing matched".
    console.error('[auto-skip] matchers.js did not load — extension is inert.');
    return;
  }

  // Keep in sync with settings.js
  const DEFAULTS = Object.freeze({
    enabled: true,
    skipIntro: true,
    skipRecap: true,
    skipOutro: true,
    skipOther: true,
    delayMs: 0,
    autoNextEpisode: false,
    dismissStillWatching: true,
    showToast: true,
    debug: false,
  });

  let settings = { ...DEFAULTS };

  const TICK_MS = 250;
  const REPEAT_BLOCK_MS = 8000; // don't click the same control again for this long
  const GLOBAL_COOLDOWN_MS = 1200; // min gap between two clicks

  const IS_SUBFRAME = window !== window.top;

  /* Watch pages, with an optional locale prefix: /watch/, /de/watch/,
   * /pt-br/watch/, /es-419/watch/ — the last has a numeric subtag. */
  const WATCH_PATH = /^\/(?:[a-z]{2,3}(?:-[a-z0-9]{2,4})?\/)?watch\//i;

  // Elements worth looking at each tick. Cheap enough to run 4x/second.
  const CANDIDATE_SELECTOR = [
    'button',
    '[role="button"]',
    '[class*="skip" i]',
    '[data-testid*="skip" i]',
    '[id*="skip" i]',
    '[aria-label*="skip" i]',
    '[title*="skip" i]',
  ].join(',');

  /* In the top frame we search only inside the player. A watch page also carries
   * episode lists and recommendation rails, and an anime title is arbitrary text
   * — it can say anything, including things that look like UI labels. */
  const PLAYER_ROOT = [
    '#velocity-player-package',
    '[class*="vilos" i]',
    '[class*="video-player" i]',
    '[class*="videoPlayer" i]',
  ].join(',');

  /* Belt and braces for the above: even inside a player root, never treat
   * anything within a rail, carousel or content card as a skip control. */
  const NEVER_SKIP_WITHIN = [
    '[class*="carousel" i]',
    '[class*="rail" i]',
    '[class*="collection" i]',
    '[class*="recommend" i]',
    '[class*="similar" i]',
    '[class*="playlist" i]',
    '[class*="card" i]',
    '[class*="episode-list" i]',
    '[class*="watchlist" i]',
  ].join(',');

  const UP_NEXT_CONTAINER =
    '[class*="up-next" i], [class*="upnext" i], [class*="endcard" i], [class*="end-card" i], [class*="next-episode" i]';
  const CONTROL_BAR =
    '[class*="control" i], [class*="toolbar" i], [class*="scrubber" i], [class*="header" i], nav';
  // Strict: a real prompt is a modal dialog, not any element with "overlay" in its class.
  const STILL_WATCHING_SCOPE = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const MAX_PROMPT_CHARS = 200;

  const LABELS = {
    intro: 'Intro skipped',
    recap: 'Recap skipped',
    outro: 'Credits skipped',
    other: 'Skipped',
    next: 'Next episode',
    stillWatching: 'Dismissed "still watching?"',
  };

  /* Keyed by a stable description of the control rather than by node identity:
   * the SPA re-renders the player constantly, and a fresh node for the same
   * button used to defeat the repeat block entirely. */
  const handled = new Map(); // key -> timestamp
  let lastActionAt = 0;
  let pending = false;

  /* ------------------------------------------------------------------ utils */

  function safe(fn) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return; // extension reloaded
      fn();
    } catch (_) {
      /* context invalidated — nothing useful to do */
    }
  }

  function query(root, selector) {
    try {
      return root.querySelectorAll(selector);
    } catch (_) {
      return [];
    }
  }

  /* Only act on a watch page or inside a frame that is actually playing video.
   * Anchoring on a <video> element rather than on Crunchyroll's hostname and URL
   * shape is the point: v1.3.0 required the player iframe to be served from
   * static.crunchyroll.com with "vilos" in the path, and if that ever stops being
   * true the extension silently does nothing at all. A frame with a <video> in it
   * is the player, wherever it is served from.
   *
   * Re-checked every tick because Crunchyroll is a SPA and the URL changes
   * without a reload. */
  function inScope() {
    if (WATCH_PATH.test(location.pathname)) return true;
    return IS_SUBFRAME && !!document.querySelector('video');
  }

  /* Where we're allowed to look. Grown outward from the <video>: start at its
   * parent and keep climbing while the container holds no rail or carousel. That
   * gives the largest region that is unambiguously player, without needing to
   * know what Crunchyroll calls its wrapper this month. Selector matches are
   * added as a fallback for a skip button rendered outside the video's subtree. */
  function playerRoot() {
    const video = document.querySelector('video');
    if (!video) return null;
    let root = video.parentElement || video;
    for (let node = root.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      if (node.querySelector(NEVER_SKIP_WITHIN)) break;
      root = node;
    }
    return root;
  }

  function searchRoots() {
    const roots = [];
    const anchored = playerRoot();
    if (anchored) roots.push(anchored);
    for (const el of query(document, PLAYER_ROOT)) {
      if (!roots.includes(el)) roots.push(el);
    }
    /* Last resort: search the whole document rather than nothing at all. Failing
     * closed here is what made v1.4.0 silently stop skipping — if no selector
     * matches, the extension has no idea where the player is, and doing nothing
     * looks exactly like being broken. The strict matcher and the rail/card
     * exclusion are the real defence; DOM scoping is only an optimisation on top
     * of them, so it must never be the thing that disables everything. */
    if (!roots.length) roots.push(document);
    return roots;
  }

  function candidates() {
    const found = [];
    for (const root of searchRoots()) {
      for (const el of query(root, CANDIDATE_SELECTOR)) found.push(el);
    }
    return found;
  }

  // Class / id / data-testid: names Crunchyroll's engineers gave the element.
  function identityOf(el) {
    const cls = typeof el.className === 'string' ? el.className : '';
    return [el.id, cls, el.getAttribute('data-testid')].filter(Boolean).join(' ');
  }

  // Text nodes belonging to this element directly, excluding descendants.
  function ownText(el) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue;
    }
    return text.trim();
  }

  /* The element's accessible name. Falls back to full text only when it is short
   * enough to be a label rather than a card's worth of prose. */
  function labelOf(el) {
    const explicit = [el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean);
    if (explicit.length) return explicit.join(' ');
    const own = ownText(el);
    if (own) return own;
    const all = (el.textContent || '').trim();
    return all.length <= 40 ? all : '';
  }

  // FNV-1a. Hashing rather than truncating: 80 chars of emotion/styled-components
  // class name is easy to exceed, and two distinct controls sharing a prefix
  // would then share a key and block each other.
  function hash(text) {
    let value = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value.toString(36);
  }

  /* Digits are collapsed because a countdown in the label ("Skip Intro 5", the
   * up-next card's timer) otherwise mints a fresh key every second and defeats
   * the repeat block entirely — the same failure that node-identity keying had. */
  function keyOf(el, kind) {
    const text = M.normalize(identityOf(el) + ' ' + labelOf(el)).replace(/\p{N}+/gu, '#');
    return kind + '|' + hash(text);
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;

    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity) < 0.1) return false;
      if (style.pointerEvents === 'none' && node === el) return false;
    }
    return true;
  }

  /* A skip button seeks within the current video; it is never a link and never
   * wraps one. Checking descendants as well as ancestors matters because card
   * overlays put the <a> inside the clickable element. */
  function isLinked(el) {
    return !!(el.closest('a[href]') || el.querySelector('a[href]'));
  }

  /* --------------------------------------------------------------- matching */

  function wants(type) {
    switch (type) {
      case 'intro': return settings.skipIntro;
      case 'recap': return settings.skipRecap;
      case 'outro': return settings.skipOutro;
      default: return settings.skipOther;
    }
  }

  function findSkipButton() {
    const anchored = playerRoot();
    for (const el of candidates()) {
      const type = M.classifySkip({ identity: identityOf(el), label: labelOf(el) });
      if (!type || !wants(type)) continue;
      if (handled.has(keyOf(el, type))) continue;
      /* The rail/card exclusion applies only OUTSIDE the video-anchored player
       * container. Crunchyroll renders the player inline in the watch page — there
       * is no player iframe — so this check was being applied to the player's own
       * UI, where a single class containing "card" or "rail" would silently block
       * every skip. Inside the container that holds the <video>, everything is
       * player chrome by definition. */
      if (!(anchored && anchored.contains(el)) && el.closest(NEVER_SKIP_WITHIN)) continue;
      // isLinked() scans the subtree, so check it last, after the cheap filters.
      if (isVisible(el) && !isLinked(el)) return { el, type };
    }
    return null;
  }

  /* The up-next card at the end of an episode. Requires an actual up-next
   * container and rejects anything in the control bar, so it can't hit the
   * next-episode control that sits there for the whole episode. */
  function findNextEpisode() {
    for (const el of candidates()) {
      if (handled.has(keyOf(el, 'next'))) continue;
      if (!M.isNextEpisode(labelOf(el)) && !M.isNextEpisode(identityOf(el))) continue;
      if (el.closest(CONTROL_BAR)) continue;
      if (!el.closest(UP_NEXT_CONTAINER)) continue;
      if (isVisible(el)) return el;
    }
    return null;
  }

  /* The idle prompt: a modal dialog that asks the question, then the confirm
   * button inside that same dialog. The body length cap keeps a dialog that
   * merely quotes a synopsis from qualifying. */
  function findStillWatching() {
    for (const scope of query(document, STILL_WATCHING_SCOPE)) {
      const body = (scope.textContent || '').trim();
      if (body.length > MAX_PROMPT_CHARS) continue;
      if (!M.isStillWatchingPrompt(body)) continue;
      for (const btn of query(scope, 'button, [role="button"]')) {
        if (handled.has(keyOf(btn, 'stillWatching'))) continue;
        if (!M.isConfirmButton(labelOf(btn))) continue; // label only, never class names
        if (isLinked(btn)) continue;
        if (isVisible(btn)) return btn;
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- clicking */

  /* Climb to the real clickable element, but only into an ancestor that is itself
   * recognisably a skip control — a <span class="skip-icon"> inside
   * <button aria-label="Add to Watchlist"> must not click the watchlist button.
   * An ancestor with no accessible name at all isn't trusted either: the same
   * "does it merely contain a skip word" test that this rewrite exists to
   * abolish must not survive one level up. */
  function clickTarget(el) {
    let node = el;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      if (!node.matches('button, [role="button"]')) continue;
      if (node === el) return node;
      const own = node.getAttribute('aria-label') || node.getAttribute('title') || '';
      if (!own) return el;
      return M.classifySkip({ label: own }) ? node : el;
    }
    return el;
  }

  function fireClick(el) {
    const target = clickTarget(el);
    if (isLinked(target)) return false;

    const rect = target.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
    };
    const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const hasPointer = typeof PointerEvent === 'function';

    const events = [];
    if (hasPointer) events.push(new PointerEvent('pointerover', pointer));
    events.push(new MouseEvent('mouseover', base));
    if (hasPointer) events.push(new PointerEvent('pointerdown', pointer));
    events.push(new MouseEvent('mousedown', base));
    if (hasPointer) events.push(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));
    events.push(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    events.push(new MouseEvent('click', { ...base, buttons: 0 }));

    for (const event of events) target.dispatchEvent(event);
    return true;
  }

  function bumpStat(key) {
    safe(() => {
      chrome.storage.local.get({ stats: {} }, ({ stats }) => {
        stats[key] = (stats[key] || 0) + 1;
        stats.total = (stats.total || 0) + 1;
        safe(() => chrome.storage.local.set({ stats }));
      });
    });
  }

  function act(el, kind) {
    // Re-check at click time: the delay may have outlived the button, or the SPA
    // may have navigated somewhere we shouldn't be touching.
    if (!el.isConnected || !inScope() || !isVisible(el)) return;
    if (!fireClick(el)) return;
    bumpStat(kind);
    toast(LABELS[kind] || 'Skipped');
  }

  /* The cooldown is held for the whole delay, not just GLOBAL_COOLDOWN_MS —
   * otherwise a 5s "time to cancel" delay still let a second candidate fire
   * 1.2s in, and the user's cancel window applied to the first click only. */
  function schedule(el, kind) {
    handled.set(keyOf(el, kind), Date.now());
    pending = true;
    const run = () => {
      try {
        act(el, kind);
      } finally {
        pending = false;
        lastActionAt = Date.now();
      }
    };
    if (settings.delayMs > 0) setTimeout(run, settings.delayMs);
    else run();
  }

  /* -------------------------------------------------------------------- loop */

  function prune(now) {
    for (const [key, at] of handled) {
      if (now - at > REPEAT_BLOCK_MS) handled.delete(key);
    }
  }

  function tick() {
    if (!settings.enabled || pending) return;

    const now = Date.now();
    if (!inScope()) {
      if (settings.debug) report(now, 'out of scope');
      return;
    }

    prune(now);
    if (now - lastActionAt < GLOBAL_COOLDOWN_MS) return;

    const skip = findSkipButton();
    if (skip) {
      schedule(skip.el, skip.type);
      return;
    }
    if (settings.debug) report(now, 'no skip button matched');

    if (settings.autoNextEpisode) {
      const next = findNextEpisode();
      if (next) {
        schedule(next, 'next');
        return;
      }
    }

    if (settings.dismissStillWatching) {
      const confirmButton = findStillWatching();
      if (confirmButton) schedule(confirmButton, 'stillWatching');
    }
  }

  /* ------------------------------------------------------------------- debug */

  /* Turned on from the popup. Prints, at most every 2s, every skip-looking
   * element in scope and exactly which gate rejected it — so a report of "it
   * stopped skipping" can be settled by looking rather than by guessing. */
  const DEBUG_SELECTOR =
    '[class*="skip" i], [data-testid*="skip" i], [id*="skip" i], [aria-label*="skip" i], [title*="skip" i], button, [role="button"]';
  let lastReportAt = 0;

  function report(now, why) {
    if (now - lastReportAt < 2000) return;
    lastReportAt = now;

    const where = (IS_SUBFRAME ? 'subframe ' : 'top ') + location.pathname;
    if (why === 'out of scope') {
      console.log(
        `[auto-skip] ${why}: ${where} — watchPath=${WATCH_PATH.test(location.pathname)} video=${!!document.querySelector('video')}`
      );
      return;
    }

    const roots = searchRoots();
    const anchored = playerRoot();
    const rows = [];
    for (const root of roots) {
      for (const el of query(root, DEBUG_SELECTOR)) {
        const identity = identityOf(el);
        const label = labelOf(el);
        const type = M.classifySkip({ identity, label });
        // Keep the output small: only things that look at all skip-related.
        if (!type && !/skip/i.test(identity + ' ' + label)) continue;
        rows.push({
          identity: identity.slice(0, 80),
          label: label.slice(0, 60),
          classifiedAs: type,
          rejectedBy: !type
            ? 'classifySkip'
            : !wants(type)
              ? 'setting off'
              : !(anchored && anchored.contains(el)) && el.closest(NEVER_SKIP_WITHIN)
                ? 'inside rail/card'
                : !isVisible(el)
                  ? 'not visible'
                  : isLinked(el)
                    ? 'is/contains a link'
                    : handled.has(keyOf(el, type))
                      ? 'repeat block'
                      : '(would click)',
          el,
        });
      }
    }
    console.log(`[auto-skip] ${why}: ${where} — roots=${roots.length}, skip-ish=${rows.length}`);
    if (rows.length) console.table(rows.map(({ el, ...row }) => row));
    if (rows.length) console.log(rows.map((row) => row.el));
  }

  /* ------------------------------------------------------------------- toast */

  const TOAST_ID = 'cr-auto-skip-toast';

  function toast(message) {
    if (!settings.showToast) return;
    try {
      let node = document.getElementById(TOAST_ID);
      if (!node) {
        node = document.createElement('div');
        node.id = TOAST_ID;
        node.style.cssText = [
          'position:fixed',
          'left:50%',
          'bottom:14%',
          'transform:translateX(-50%)',
          'z-index:2147483647',
          'pointer-events:none',
          'padding:7px 14px',
          'border-radius:999px',
          'background:rgba(0,0,0,.78)',
          'color:#fff',
          'font:600 13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif',
          'letter-spacing:.2px',
          'box-shadow:0 2px 10px rgba(0,0,0,.4)',
          'border-left:3px solid #f47521',
          'opacity:0',
          'transition:opacity .25s ease',
        ].join(';');
        (document.body || document.documentElement).appendChild(node);
      }
      node.textContent = message;
      node.style.opacity = '1';
      clearTimeout(node.__hideTimer);
      node.__hideTimer = setTimeout(() => {
        node.style.opacity = '0';
      }, 1600);
    } catch (_) {
      /* toast is cosmetic */
    }
  }

  /* ------------------------------------------------------------------- start */

  safe(() => {
    chrome.storage.sync.get(DEFAULTS, (stored) => {
      settings = { ...DEFAULTS, ...stored };
    });
  });

  safe(() => {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (key in DEFAULTS) settings[key] = newValue;
      }
    });
  });

  setInterval(tick, TICK_MS);
})();
