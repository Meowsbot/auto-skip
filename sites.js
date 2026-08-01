/* Site registry — the one place that knows about individual streaming services.
 *
 * Loaded three ways: as a content script (exposes globalThis.__autoSkipSites),
 * via importScripts() in the service worker, and as a CommonJS module under node
 * for the tests.
 *
 * DESIGN NOTE — read before adding a service.
 *
 * The matching engine in matchers.js is deliberately generic: it recognises skip
 * controls by keyword, in any UI language, and it is strict about it. This file
 * does NOT re-implement that per service. A site entry only supplies things that
 * are genuinely site-specific and that no keyword rule can infer:
 *
 *   watchPath / videoIsEnough  where the player lives in the URL space
 *   playerRoots                fallback containers, if the <video> anchor fails
 *   skipSelectors              curated element hooks (data-uia, data-automationid…)
 *   nextEpisodeSelectors       the up-next control, which is rarely labelled
 *   stillWatchingScopes        dialogs that are not role="dialog"
 *   stillWatchingSelectors     the confirm button, when it is unambiguous
 *
 * Everything in a `*Selectors` list is TRUSTED, exactly like a class name
 * containing "skip" is trusted: a human curated it. So keep them narrow. A
 * selector like `[class*="button"]` here would undo every guard in matchers.js.
 *
 * Adding a service is: add an entry, add its match patterns to
 * host_permissions in manifest.json, add a test in test/selftest.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__autoSkipSites = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Per-service settings. Every service gets the full set — the options are
   * identical everywhere, only their values differ. Keep in sync with
   * content.js and settings.js.
   *
   * `enabled` is the service switch. It defaults to true: host access is granted
   * at install for every service in this registry, so a fresh install works on
   * all of them without the user configuring anything. It is excluded from
   * "copy these settings to every service" — that button copies preferences,
   * not which services you run. */
  const SITE_DEFAULTS = Object.freeze({
    enabled: true,
    skipIntro: true,
    skipRecap: true,
    skipOutro: true,
    skipOther: true,
    autoNextEpisode: false,
    dismissStillWatching: true,
    showToast: true,
    debug: false,
    delayMs: 0,
  });

  /* Generic player containers, tried after the <video> anchor. Sites add their
   * own on top of these rather than instead of them. */
  const GENERIC_PLAYER_ROOTS = [
    '[class*="video-player" i]',
    '[class*="videoPlayer" i]',
    '[class*="player-container" i]',
  ];

  const SITES = [
    {
      id: 'crunchyroll',
      name: 'Crunchyroll',
      host: 'crunchyroll.com',
      accent: '#f47521',
      matches: ['https://*.crunchyroll.com/*'],
      hostPattern: /(^|\.)crunchyroll\.com$/i,
      /* Watch pages, with an optional locale prefix: /watch/, /de/watch/,
       * /pt-br/watch/, /es-419/watch/ — the last has a numeric subtag. */
      watchPath: /^\/(?:[a-z]{2,3}(?:-[a-z0-9]{2,4})?\/)?watch\//i,
      videoIsEnough: false,
      playerRoots: ['#velocity-player-package', '[class*="vilos" i]'],
      skipSelectors: [],
      nextEpisodeSelectors: [],
      stillWatchingScopes: [],
      stillWatchingSelectors: [],
    },
    {
      id: 'netflix',
      name: 'Netflix',
      host: 'netflix.com',
      accent: '#e50914',
      matches: ['https://*.netflix.com/*'],
      hostPattern: /(^|\.)netflix\.com$/i,
      watchPath: /^\/watch\//i,
      videoIsEnough: false,
      playerRoots: ['.watch-video', '[data-uia="player"]', '.VideoContainer'],
      /* Netflix names its controls in data-uia, which identityOf() reads, so
       * these mostly just widen the candidate sweep. */
      skipSelectors: [
        '[data-uia="player-skip-intro"]',
        '[data-uia="player-skip-recap"]',
        '[data-uia="player-skip-preplay"]',
        '[data-uia="player-skip-credits"]',
      ],
      nextEpisodeSelectors: [
        '[data-uia="next-episode-seamless-button"]',
        '[data-uia="next-episode-seamless-button-draining"]',
      ],
      stillWatchingScopes: ['.interrupter-actions', '[data-uia="interrupter-title"]'],
      stillWatchingSelectors: ['[data-uia="interrupt-autoplay-continue"]'],
    },
    {
      id: 'disneyplus',
      name: 'Disney+',
      host: 'disneyplus.com',
      accent: '#0063e5',
      matches: ['https://*.disneyplus.com/*'],
      hostPattern: /(^|\.)disneyplus\.com$/i,
      watchPath: /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:video|play|movies|series)\//i,
      videoIsEnough: true,
      playerRoots: ['#hudson-wrapper', '.btm-media-client-element', '.controls__wrapper'],
      skipSelectors: ['.skip__button', '[data-testid="skip-button"]'],
      nextEpisodeSelectors: ['[data-testid="up-next-play-button"]', '.upnext__button'],
      stillWatchingScopes: [],
      stillWatchingSelectors: [],
    },
    {
      id: 'primevideo',
      name: 'Prime Video',
      host: 'primevideo.com / amazon.*',
      accent: '#00a8e1',
      matches: [
        'https://*.primevideo.com/*',
        'https://www.amazon.com/*',
        'https://www.amazon.co.uk/*',
        'https://www.amazon.de/*',
        'https://www.amazon.co.jp/*',
      ],
      hostPattern: /(^|\.)primevideo\.com$|(^|\.)amazon\.(com|co\.uk|de|co\.jp)$/i,
      /* Prime plays inline over the detail page, so the path is not a reliable
       * gate; the <video> is. On amazon.* the path check keeps the extension out
       * of the store entirely until a player exists. */
      watchPath: /\/(?:detail|gp\/video|video\/detail)\//i,
      videoIsEnough: true,
      playerRoots: ['.webPlayerSDKContainer', '.webPlayerUIContainer', '#dv-web-player'],
      skipSelectors: [
        '.atvwebplayersdk-skipelement-button',
        '.skipelement-button',
        '[class*="skipelement" i]',
      ],
      nextEpisodeSelectors: ['.atvwebplayersdk-nextupcard-button', '[class*="nextupcard-button" i]'],
      stillWatchingScopes: [],
      stillWatchingSelectors: [],
    },
    {
      id: 'max',
      name: 'HBO Max',
      host: 'max.com',
      accent: '#8a4ffc',
      matches: ['https://*.max.com/*', 'https://*.hbomax.com/*'],
      hostPattern: /(^|\.)(max|hbomax)\.com$/i,
      watchPath: /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:video|player|play)\//i,
      videoIsEnough: true,
      playerRoots: ['[data-testid="player-container"]', '[class*="PlayerContainer" i]'],
      skipSelectors: ['[data-testid="player-ux-skip-button"]', '[data-testid*="skip" i]'],
      nextEpisodeSelectors: ['[data-testid="player-ux-up-next-button"]', '[data-testid*="up-next" i]'],
      stillWatchingScopes: [],
      stillWatchingSelectors: [],
    },
    {
      id: 'hulu',
      name: 'Hulu',
      host: 'hulu.com',
      accent: '#1ce783',
      matches: ['https://*.hulu.com/*'],
      hostPattern: /(^|\.)hulu\.com$/i,
      watchPath: /^\/watch\//i,
      videoIsEnough: true,
      playerRoots: ['#web-player-app', '[class*="PlayerMain" i]', '[class*="VideoPlayer" i]'],
      skipSelectors: ['.SkipButton', '[data-automationid*="skip" i]'],
      nextEpisodeSelectors: ['[data-automationid*="end-card" i] button', '.EndCardFlipper button'],
      stillWatchingScopes: [],
      stillWatchingSelectors: [],
    },
    {
      id: 'paramountplus',
      name: 'Paramount+',
      host: 'paramountplus.com',
      accent: '#0064ff',
      matches: ['https://*.paramountplus.com/*'],
      hostPattern: /(^|\.)paramountplus\.com$/i,
      watchPath: /\/video\/|^\/live-tv\//i,
      videoIsEnough: true,
      playerRoots: ['.aa-player-container', '[class*="player-ui" i]'],
      skipSelectors: ['.skip-button', '[class*="skip-button" i]'],
      nextEpisodeSelectors: ['[class*="end-card" i] button', '[class*="up-next" i] button'],
      stillWatchingScopes: [],
      stillWatchingSelectors: [],
    },
    {
      id: 'peacock',
      name: 'Peacock',
      host: 'peacocktv.com',
      accent: '#ffc900',
      matches: ['https://*.peacocktv.com/*'],
      hostPattern: /(^|\.)peacocktv\.com$/i,
      watchPath: /^\/watch\//i,
      videoIsEnough: true,
      playerRoots: ['[data-testid="player"]', '[class*="player-container" i]'],
      skipSelectors: ['[data-testid*="skip" i]', '[class*="skip-button" i]'],
      nextEpisodeSelectors: ['[data-testid*="up-next" i] button', '[data-testid="next-episode"]'],
      stillWatchingScopes: [],
      stillWatchingSelectors: [],
    },
    {
      id: 'appletv',
      name: 'Apple TV+',
      host: 'tv.apple.com',
      accent: '#a1a1a6',
      matches: ['https://tv.apple.com/*'],
      hostPattern: /(^|\.)tv\.apple\.com$/i,
      watchPath: /^\/(?:[a-z]{2}\/)?(?:episode|movie|show|play)\//i,
      videoIsEnough: true,
      playerRoots: ['.amp-player', '[class*="video-player" i]'],
      skipSelectors: ['.skip-button', '[class*="skip-intro" i]', '[class*="skip-credits" i]'],
      nextEpisodeSelectors: ['[class*="up-next" i] button'],
      stillWatchingScopes: [],
      stillWatchingSelectors: [],
    },
    {
      id: 'youtube',
      name: 'YouTube',
      host: 'youtube.com — ads only',
      accent: '#ff0033',
      matches: ['https://*.youtube.com/*'],
      hostPattern: /(^|\.)youtube\.com$/i,
      /* Deliberately NOT videoIsEnough: the home page and every channel page
       * autoplay a <video> preview, and the feed is full of arbitrary titles. */
      watchPath: /^\/(?:watch|shorts|live)/i,
      videoIsEnough: false,
      playerRoots: ['#movie_player', '.html5-video-player'],
      /* Ad skip only. The button is classified as "other" (its class contains
       * "ad"), so it follows the "anything else labelled skip" toggle. */
      skipSelectors: [
        '.ytp-ad-skip-button',
        '.ytp-skip-ad-button',
        '.ytp-ad-skip-button-modern',
        '[class*="ytp-ad-skip-button" i]',
      ],
      nextEpisodeSelectors: [],
      /* YouTube's "Video paused. Continue watching?" is a paper-dialog, not a
       * role="dialog". */
      stillWatchingScopes: ['tp-yt-paper-dialog', 'yt-confirm-dialog-renderer', '#confirm-dialog'],
      stillWatchingSelectors: [],
    },
  ];

  const BY_ID = new Map(SITES.map((site) => [site.id, site]));

  function forHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    for (const site of SITES) {
      if (site.hostPattern.test(host)) return site;
    }
    return null;
  }

  const byId = (id) => BY_ID.get(id) || null;

  /* Flat list of every match pattern, for the manifest and for permission
   * bookkeeping. */
  const allMatches = () => SITES.flatMap((site) => site.matches);

  return { SITES, SITE_DEFAULTS, GENERIC_PLAYER_ROOTS, forHost, byId, allMatches };
});
