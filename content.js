/* Auto Skip — content script
 *
 * Registered at runtime by background.js, and only for the services the user has
 * granted. It only acts inside a video player, and only clicks controls the
 * service itself renders: "Skip Intro", "Skip Recap", "Skip Credits", the
 * up-next card, and the "still watching?" prompt.
 *
 * Everything service-specific lives in sites.js. This file is the engine.
 */
(() => {
  'use strict';

  if (window.__autoSkipActive) return;
  window.__autoSkipActive = true;

  const M = globalThis.__autoSkipMatchers;
  const S = globalThis.__autoSkipSites;
  if (!M || !S) {
    // Unconditional: this is a genuine fault, and silence here looks identical
    // to "the extension is running fine but nothing matched".
    console.error('[auto-skip] matchers.js/sites.js did not load — extension is inert.');
    return;
  }

  const SITE = S.forHost(location.hostname);
  if (!SITE) {
    // Registered for a host no site entry claims: a manifest/registry mismatch.
    console.error(`[auto-skip] no site entry for ${location.hostname} — extension is inert.`);
    return;
  }

  // Keep in sync with sites.js SITE_DEFAULTS and settings.js.
  const DEFAULTS = S.SITE_DEFAULTS;

  let enabled = true; // master switch, shared by every service
  let settings = { ...DEFAULTS };

  const TICK_MS = 250;
  const REPEAT_BLOCK_MS = 8000; // don't click the same control again for this long
  const GLOBAL_COOLDOWN_MS = 1200; // min gap between two clicks

  const IS_SUBFRAME = window !== window.top;

  const list = (items) => items.filter(Boolean).join(',');

  /* Attributes a service's engineers use to NAME a control. Read as identity,
   * i.e. trusted — see the design note in matchers.js. Netflix uses data-uia,
   * Hulu uses data-automationid, most of the rest use data-testid. */
  const IDENTITY_ATTRS = [
    'data-testid',
    'data-test-id',
    'data-uia',
    'data-automationid',
    'data-automation-id',
  ];

  // Elements worth looking at each tick. Cheap enough to run 4x/second.
  const CANDIDATE_SELECTOR = list([
    'button',
    '[role="button"]',
    '[class*="skip" i]',
    '[id*="skip" i]',
    '[aria-label*="skip" i]',
    '[title*="skip" i]',
    ...IDENTITY_ATTRS.map((attr) => `[${attr}*="skip" i]`),
    ...SITE.skipSelectors,
  ]);

  /* Curated per-service hooks. Matching one of these is treated exactly like a
   * class name containing "skip": a human named this control, so it counts.
   * classifySkip() still decides WHICH segment it is, and the per-segment
   * toggles still apply. */
  const SITE_SKIP_SELECTOR = list(SITE.skipSelectors);

  /* In the top frame we search only inside the player. A watch page also carries
   * episode lists and recommendation rails, and a catalogue title is arbitrary
   * text — it can say anything, including things that look like UI labels. */
  const PLAYER_ROOT = list([...SITE.playerRoots, ...S.GENERIC_PLAYER_ROOTS]);

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
  const SITE_NEXT_SELECTOR = list(SITE.nextEpisodeSelectors);
  const CONTROL_BAR =
    '[class*="control" i], [class*="toolbar" i], [class*="scrubber" i], [class*="header" i], nav';
  /* Strict: a real prompt is a modal dialog, not any element with "overlay" in
   * its class. Sites may add their own container when they don't use ARIA. */
  const STILL_WATCHING_SCOPE = list([
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]',
    ...SITE.stillWatchingScopes,
  ]);
  const SITE_CONFIRM_SELECTOR = list(SITE.stillWatchingSelectors);
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
   * these are all SPAs that re-render the player constantly, and a fresh node
   * for the same button used to defeat the repeat block entirely. */
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
    if (!selector) return [];
    try {
      return root.querySelectorAll(selector);
    } catch (_) {
      return [];
    }
  }

  function matches(el, selector) {
    if (!selector) return false;
    try {
      return el.matches(selector);
    } catch (_) {
      return false;
    }
  }

  /* Only act on a watch page, inside a frame that is actually playing video, or
   * — for services that play inline over a detail page — anywhere a <video>
   * exists. Anchoring on a <video> element rather than on a hostname and URL
   * shape is the point: v1.3.0 pinned the player iframe to a specific host and
   * path, and when that stopped being true the extension silently did nothing.
   *
   * Re-checked every tick because these are all SPAs and the URL changes
   * without a reload. */
  function inScope() {
    if (SITE.watchPath && SITE.watchPath.test(location.pathname)) return true;
    if (!document.querySelector('video')) return false;
    return IS_SUBFRAME || !!SITE.videoIsEnough;
  }

  /* Where we're allowed to look. Grown outward from the <video>: start at its
   * parent and keep climbing while the container holds no rail or carousel. That
   * gives the largest region that is unambiguously player, without needing to
   * know what the service calls its wrapper this month. Selector matches are
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
    const seen = new Set();
    for (const root of searchRoots()) {
      for (const el of query(root, CANDIDATE_SELECTOR)) {
        if (seen.has(el)) continue;
        seen.add(el);
        found.push(el);
      }
    }
    /* Curated hooks are searched document-wide as well: some services render the
     * skip button in a portal outside the player subtree, and these selectors
     * are specific enough that scoping buys nothing. */
    for (const el of query(document, SITE_SKIP_SELECTOR)) {
      if (!seen.has(el)) {
        seen.add(el);
        found.push(el);
      }
    }
    return found;
  }

  /* Class / id / testid: names the service's engineers gave the element. A
   * curated site selector is appended as the literal word "skip" so that the
   * trusted-identity path in classifySkip() picks it up — the selector list in
   * sites.js is hand-written, which is the same warrant a class name has. */
  function identityOf(el) {
    const cls = typeof el.className === 'string' ? el.className : '';
    const parts = [el.id, cls];
    for (const attr of IDENTITY_ATTRS) parts.push(el.getAttribute(attr));
    if (matches(el, SITE_SKIP_SELECTOR)) parts.push('skip');
    return parts.filter(Boolean).join(' ');
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
       * container. Several of these services render the player inline in the
       * page — there is no player iframe — so this check was being applied to
       * the player's own UI, where a single class containing "card" or "rail"
       * would silently block every skip. Inside the container that holds the
       * <video>, everything is player chrome by definition. A curated site
       * selector is exempt outright. */
      if (
        !(anchored && anchored.contains(el)) &&
        !matches(el, SITE_SKIP_SELECTOR) &&
        el.closest(NEVER_SKIP_WITHIN)
      ) continue;
      // isLinked() scans the subtree, so check it last, after the cheap filters.
      if (isVisible(el) && !isLinked(el)) return { el, type };
    }
    return null;
  }

  /* The up-next card at the end of an episode. A curated selector is enough on
   * its own; otherwise it requires an actual up-next container and rejects
   * anything in the control bar, so it can't hit the next-episode control that
   * sits there for the whole episode. */
  function findNextEpisode() {
    for (const el of query(document, SITE_NEXT_SELECTOR)) {
      if (handled.has(keyOf(el, 'next'))) continue;
      if (isVisible(el)) return el;
    }
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
   * merely quotes a synopsis from qualifying.
   *
   * A curated confirm selector skips the text test entirely — it names the
   * control, which is stronger evidence than any wording rule. */
  function findStillWatching() {
    for (const el of query(document, SITE_CONFIRM_SELECTOR)) {
      if (handled.has(keyOf(el, 'stillWatching'))) continue;
      if (isVisible(el)) return el;
    }
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

  /* Counted per service as well as in total, so the settings page can show which
   * services are actually doing anything. */
  function bumpStat(key) {
    safe(() => {
      chrome.storage.local.get({ stats: {} }, ({ stats }) => {
        stats[key] = (stats[key] || 0) + 1;
        stats.total = (stats.total || 0) + 1;
        stats.sites = stats.sites || {};
        const site = (stats.sites[SITE.id] = stats.sites[SITE.id] || {});
        site[key] = (site[key] || 0) + 1;
        site.total = (site.total || 0) + 1;
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
    // settings.enabled is this service's own switch. background.js unregisters
    // the script when it goes off, but that is asynchronous and cannot touch a
    // page where the script is already running — so it is enforced here too.
    if (!enabled || settings.enabled === false || pending) return;

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

  /* Turned on per service from the popup. Prints, at most every 2s, every
   * skip-looking element in scope and exactly which gate rejected it — so a
   * report of "it stopped skipping" can be settled by looking rather than by
   * guessing. */
  const DEBUG_SELECTOR = list([
    '[class*="skip" i]',
    '[id*="skip" i]',
    '[aria-label*="skip" i]',
    '[title*="skip" i]',
    ...IDENTITY_ATTRS.map((attr) => `[${attr}*="skip" i]`),
    ...SITE.skipSelectors,
    'button',
    '[role="button"]',
  ]);
  let lastReportAt = 0;

  function report(now, why) {
    if (now - lastReportAt < 2000) return;
    lastReportAt = now;

    const where = `${SITE.id} ${IS_SUBFRAME ? 'subframe' : 'top'} ${location.pathname}`;
    if (why === 'out of scope') {
      const onWatchPath = !!(SITE.watchPath && SITE.watchPath.test(location.pathname));
      console.log(
        `[auto-skip] ${why}: ${where} — watchPath=${onWatchPath} video=${!!document.querySelector('video')} videoIsEnough=${!!SITE.videoIsEnough}`
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
              : !(anchored && anchored.contains(el)) &&
                  !matches(el, SITE_SKIP_SELECTOR) &&
                  el.closest(NEVER_SKIP_WITHIN)
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

  const TOAST_ID = 'auto-skip-toast';

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
          `border-left:3px solid ${SITE.accent}`,
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

  function applyStored(stored) {
    enabled = stored.enabled !== false;
    settings = { ...DEFAULTS, ...((stored.sites || {})[SITE.id] || {}) };
  }

  safe(() => {
    chrome.storage.sync.get({ enabled: true, sites: {} }, applyStored);
  });

  safe(() => {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if ('enabled' in changes) enabled = changes.enabled.newValue !== false;
      if ('sites' in changes) {
        settings = { ...DEFAULTS, ...((changes.sites.newValue || {})[SITE.id] || {}) };
      }
    });
  });

  setInterval(tick, TICK_MS);
})();
