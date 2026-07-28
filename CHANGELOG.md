# Changelog

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
