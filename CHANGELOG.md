# Changelog

## 2.2.0

Remote control, off by default. A phone on your network can pick what plays on
this PC; the server and phone apps are in
[auto-skip-remote](https://github.com/Meowsbot/auto-skip-remote).

- **`remote.js` / `remote-worker.js`.** The worker holds an SSE stream from the
  local server with a streaming `fetch()` — a service worker has no
  `EventSource`, and holding one in an offscreen document would mean declaring
  a `reason` describing a DOM capability this does not use. Stream chunks count
  as worker activity, which is why the server heartbeat is 25s against the 30s
  eviction timer; an `alarms` watchdog reconnects if the stream dies anyway.
- **Commands:** open, fullscreen, play/pause, seek, skip now, next episode,
  volume, mute, refresh. Transport acts on the `<video>` directly rather than
  on the player's controls — `video.play()` cannot click the wrong thing.
- **Fullscreen is window-level** (`chrome.windows.update`). `requestFullscreen()`
  from a content script has no transient activation and is refused, and a
  synthetic click on the player's control is `isTrusted: false`.
- **Continue-watching is harvested from the logged-in page** and reported to the
  server. No credentials leave the machine, no private API is called.
- **The privacy claim changed and the README says so.** With remote control off
  the extension still makes no network requests; with it on it talks to the one
  origin you named. Its host permission is optional and requested for that
  single origin from the click that saves it.
- Two bugs found by the new tests before shipping: `normalizeServer` turned
  `ftp://pc.local` into the origin `http://ftp`, and the fix for that then read
  `pc.local:8787` as a scheme. A scheme is now only a scheme when followed by
  `//`; a colon before digits is a port.

## 2.1.0

On everywhere by default, and that now includes the Windows desktop apps.

- **Every service is on at install.** Host access moved from
  `optional_host_permissions` to `host_permissions`, so it is granted once when
  you accept the install prompt and there is nothing to configure afterwards.
  The service switch is now a stored setting (`sites.<id>.enabled`, default
  true) rather than the presence of a permission.
- **Works in the Crunchyroll, Netflix, Disney+ and Prime Video desktop apps.**
  No new code: those Store packages ship no code either. Each is an Edge PWA —
  `uap10:HostId="PWA"`, a dependency on `Microsoft.MicrosoftEdge.Stable`, and an
  `--app-id` pointing at the site — so they are Edge windows in the `Default`
  profile and the existing content script runs in them. Install the extension in
  Edge and the apps are covered. See the *Desktop apps* section of the README.
- Switching a service off is now a storage write instead of a permission
  revoke, so it works from the toolbar popup. The old "Chrome needs a full tab
  to ask for access" detour is gone, along with `chrome.tabs.getCurrent()`.
- `background.js` re-syncs registrations on settings changes as well, and
  injects into already-open tabs on install so an episode you have open starts
  skipping without a reload. `content.js` re-checks the switch every tick, since
  unregistering cannot stop a script already running in an open page.
- Site access withheld from `chrome://extensions` is still handled: the service
  reads as on but not running, dimmed, with a notice saying where to fix it —
  rather than a switch that claims to work.
- "Copy these settings to every service" no longer copies the service switches,
  only the preferences.
- `package.ps1` now checks `sites.js` against `host_permissions` in both
  directions, so the manifest cannot ask for a host no service uses.

## 2.0.0

Renamed from **Crunchyroll Auto Skip** to **Auto Skip**, and extended to nine
more services: Netflix, Disney+, Prime Video, HBO Max, Hulu, Paramount+,
Peacock, Apple TV+ and YouTube (skip-ad button only).

- **Pick your services.** Nothing runs until you turn one on. Each service is an
  optional host permission granted from the settings page, so the extension asks
  for no site access at install time and holds access only to the services you
  chose. Turning one off revokes it.
- **Every service gets the full option set**, stored independently — the same
  intro/recap/credits/other toggles, next episode, "still watching?", toast,
  debug logging and delay that Crunchyroll had. "Copy these settings to every
  service" applies one service's choices to all of them.
- **One source of truth for what's enabled.** A service is on exactly when its
  host permission is granted; there is no second flag to drift out of sync.
  `background.js` re-syncs content script registrations on install, on startup,
  on every permission change and on every service worker wake, and the settings
  page reads them back — a granted service that failed to register now says so
  instead of going quietly inert.
- **The matcher is unchanged and shared.** Every service labels these controls
  with the same words, so one keyword engine covers all of them. `sites.js` adds
  only what no keyword can infer: watch paths, fallback player containers, and
  narrow curated selectors (`[data-uia="player-skip-intro"]`,
  `.atvwebplayersdk-skipelement-button`, `.SkipButton`, `.ytp-ad-skip-button`…).
  Those selectors are trusted exactly like a class name containing "skip".
- Identity is now also read from `data-uia`, `data-automationid` and
  `data-automation-id`, which is how Netflix and Hulu name their controls.
- `preplay` classifies as an intro (Netflix's cold-open skip). "Continue
  watching?" and "Keep watching?" now count as idle prompts — but only with the
  question mark, so the *Continue Watching* rail on every home page still can't
  match. YouTube's paper-dialog is declared as a prompt container since it
  carries no `role="dialog"`.
- Per-service skip counts in the settings page; the toast takes the service's
  colour.
- `package.ps1` refuses to build if a match pattern in `sites.js` is missing from
  `optional_host_permissions`, which would leave that service impossible to
  enable.

Upgrading from 1.x: your Crunchyroll settings are not carried over — the storage
layout is now per service. Turn Crunchyroll on in the settings page and set it up
once.

## 1.6.1

First version confirmed working end to end on a real episode.

- The rail/card exclusion was being applied to the player's own UI. It had been
  written assuming the player lived in an iframe, so it only applied "in the top
  frame" — but Crunchyroll renders the player inline in the watch page, making
  the top frame *the player*. Any class containing `card`, `rail` or `collection`
  above the skip button silently blocked every skip. It now applies only outside
  the container holding the `<video>`.
- If `matchers.js` fails to load, that is now logged as an error instead of going
  quietly inert.

## 1.6.0

- If no player container can be identified, search the whole document rather than
  nothing. Failing closed there was indistinguishable from the extension being
  broken.

## 1.5.0

- Locate the player by finding the `<video>` element instead of matching
  Crunchyroll's hostnames and class names. 1.3.0 required the player to be an
  iframe served from `static.crunchyroll.com` with `vilos` in the path; when that
  assumption failed the extension silently did nothing at all.
- The search region now grows outward from the `<video>`, climbing while the
  container holds no rail or carousel.
- Added a **Debug logging** toggle: prints every skip-like element in scope and
  exactly which gate rejected it.

## 1.4.0

- Fixed an over-correction in 1.3.0 that silently disabled skipping for whole UI
  languages. `normalize()` never split apostrophes, so French `Passer l'intro`
  tokenised as `lintro`; token cleanup stripped combining marks, so Hindi
  `छोड़ें` became `छड`. 18 of 53 real localised labels were being rejected. The
  rule now allows one unrecognised word alongside a segment word, keeps combining
  marks, splits elisions, and has a separate path for CJK.
- A countdown in a label (`Skip Intro 5`) minted a fresh repeat-block key every
  second, reopening the click loop. Digits are now collapsed before hashing.
- Key truncation at 80 chars could collide two distinct controls.
- `/es-419/watch/` was not recognised as a watch page.

## 1.3.0

- **Separated trusted identity from untrusted label.** *Skip and Loafer* and
  *Skip Beat!* are real Crunchyroll series in which `skip` is a genuine whole
  word, so 1.2.0's word boundaries did not help. A skip word in `class`/`id`/
  `data-testid` is trusted; a skip word in visible text is trusted only alongside
  a segment word in a short enough label.
- The 8s repeat block was keyed on DOM node identity and deleted on disconnect,
  so an SPA re-render defeated it — one stray match became a click *loop*.
- `delayMs` held the cooldown for only 1.2s, so a second candidate could fire
  inside the user's cancel window.
- `navigatesAway` missed descendant links and same-path router hrefs.
- `isVisible` gave up after 8 ancestors.
- The settings slider wrote to `chrome.storage.sync` on every input event.

## 1.2.0

- `pular` (pt: "skip") matched inside "**Po**pular", so any title containing
  "popular" looked like a skip button and navigated to episode 1. Substring
  matching with no word boundaries.

## 1.1.0

- The "still watching?" dismissal matched the home page's *Continue Watching*
  rail and clicked the first card.

## 1.0.0

- Initial release.
