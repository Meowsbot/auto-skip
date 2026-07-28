# Crunchyroll Auto Skip

A small Chrome/Edge (Manifest V3) extension that clicks Crunchyroll's own
**Skip Intro** / **Skip Recap** / **Skip Credits** buttons for you the moment they
appear, so you never have to reach for the mouse mid-episode.

It can also jump past the "next episode" countdown and dismiss the
"are you still watching?" prompt.

> Not affiliated with, endorsed by, or connected to Crunchyroll or Sony Pictures.
> "Crunchyroll" is a trademark of its respective owner. This extension only
> clicks buttons the Crunchyroll player already shows you.

## Install

Works in Chrome, Edge, Brave, Opera, and other Chromium browsers.

1. Download the latest `crunchyroll-auto-skip.zip` from
   [Releases](../../releases), and unzip it somewhere you'll keep it — the
   browser loads it from that folder, so don't delete it afterwards.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder — the one containing
   `manifest.json`.
5. Open an episode on Crunchyroll. That's it.

Click the toolbar icon for settings. Everything is on by default except
"jump straight to the next episode".

## Privacy

The extension collects nothing and sends nothing anywhere. It has one
permission, `storage`, used to keep your settings and a local skip counter. It
runs only on `crunchyroll.com`, makes no network requests, and contains no
analytics or remote code.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Master toggle | on | Kill switch for everything |
| Intros / openings | on | Clicks "Skip Intro" |
| Recaps | on | Clicks "Skip Recap" |
| Credits / outros | on | Clicks "Skip Credits" / "Skip Ending" |
| Anything else labelled "skip" | on | Catch-all for buttons this extension can't classify |
| Jump to next episode | **off** | Clicks the up-next card instead of waiting out the countdown |
| Dismiss "still watching?" | on | Clears the idle prompt so playback continues (watch pages only) |
| Toast | on | Brief "Intro skipped" pill in the player |
| Wait before skipping | 0.00s | Delay up to 5s, so you have a beat to cancel |

The popup footer shows a running skip count. **Reset** clears it.

## How it works

`content.js` is injected into `https://*.crunchyroll.com/*`. Four times a second
it scans buttons and `[class*="skip"]` elements, matches them against a set of
keywords (`skip`, `intro`, `recap`, `credits`, plus the equivalents in the other
UI languages Crunchyroll ships), checks that the element is actually visible —
the skip button sits in the DOM at `opacity: 0` between segments — and dispatches
a real pointer/mouse/click sequence at its centre.

Crunchyroll renders the player **inline in the watch page**; there is no player
iframe. `all_frames: true` is kept so the extension still works if that ever
changes, and the player is located by finding the `<video>` element rather than
by matching Crunchyroll's class names, which change.

Everything is scoped twice over:

- **Page scope** (`inScope()`): watch pages, and any frame containing a `<video>`.
  Re-checked every tick because Crunchyroll is a SPA and the URL changes without
  a reload.
- **DOM scope** (`searchRoots()`): the search region grows outward from the
  `<video>` — start at its parent, keep climbing while the container holds no
  rail or carousel. A watch page also carries episode lists and recommendation
  rails, and an anime *title* is arbitrary text — it can contain anything. If no
  container can be identified it falls back to the whole document rather than
  doing nothing, because failing closed here is indistinguishable from being
  broken.

Further guards:

- **Identity is trusted; prose is not.** This is the central rule. A skip word in
  `class`/`id`/`data-testid` was put there by Crunchyroll's engineers to name a
  control, so it counts. A skip word in visible text might be an anime title, so
  it counts only if *every* word in the label is a skip word, a segment word, or
  an article — and the label is short enough to be a button's accessible name.
  `Skip Intro` passes. `Skip and Loafer` does not.
- **Whole-word matching, Unicode-aware.** JS `\b` is ASCII-only and useless for
  Cyrillic/Arabic/Devanagari, so `matchers.js` uses lookarounds instead. Labels are
  normalised first (`skipIntroText` → `skip Intro Text`) so identifiers still match
  without loosening the rule.
- **Skip buttons are never links.** If the element wraps *or is wrapped by* an
  `<a href>`, it isn't a skip button, whatever its text says.
- **Never inside a rail, carousel or content card**, even within the player.
- 1.2s global cooldown between clicks, and an 8s repeat block keyed on a stable
  description of the control rather than on node identity — the SPA re-renders
  constantly, and a fresh node for the same button used to defeat the block
  entirely.
- Accessibility links like "Skip to main content" are excluded.
- The idle prompt must be a real `role="dialog"` with a short body that asks the
  *question*, including its question mark; the confirm button is then matched by
  label only, never by class name.
- Next-episode requires an up-next/end-card container and rejects anything in the
  control bar, so it can't hit the always-present next-episode control.

Where a heuristic can't confirm what it's looking at, it does nothing rather than
guessing.

## Tests

```
node test/selftest.js
```

`matchers.js` holds every text rule and loads both as a content script and as a
CommonJS module, so the rules are unit-testable without a browser. The suite
leans hard on false positives — a missed skip is a minor annoyance, a wrong click
throws you out of the episode you were watching.

## Bugs fixed

Three shipped bugs, all the same class: matching prose as if it were a UI label.
The fourth entry is the over-correction that followed.

- **1.4.0** — 1.3.0's rule demanded that *every* word in a label be a known skip
  word, segment word or article. That silently disabled skipping for whole UI
  languages: `normalize()` never split apostrophes, so French `Passer l'intro`
  tokenised as `lintro` and failed; token cleanup stripped combining marks, so
  Hindi `छोड़ें` became `छड` and failed. 18 of 53 real localised labels were
  rejected. The rule now allows one unrecognised word alongside a segment word,
  keeps combining marks, splits elisions, and has a separate path for CJK (which
  has no spaces to tokenise). Also fixed: a countdown in a label (`Skip Intro 5`)
  minted a fresh repeat-block key every second and reopened the click loop; the
  80-char key truncation could collide two controls; `/es-419/watch/` was not
  recognised as a watch page.
- **1.3.0** — *Skip and Loafer* and *Skip Beat!* are real Crunchyroll series, and
  `skip` is a genuine whole word in both, so 1.2.0's word boundaries would not
  have helped. Fixed by separating trusted identity from untrusted label (above).
  Also fixed in the same pass: the 8s repeat block was keyed on node identity and
  deleted on disconnect, so an SPA re-render defeated it and a stray click became
  a click *loop*; `delayMs` held the cooldown for only 1.2s, so a second candidate
  fired inside the user's cancel window; `navigatesAway` missed descendant links
  and same-path router hrefs; `isVisible` gave up after 8 ancestors; `inScope`
  accepted `/watch/` anywhere in the path; and the settings slider wrote to
  `chrome.storage.sync` on every input event.
- **1.2.0** — `pular` (pt: "skip") matched inside "**Po**pular", so any title
  containing "popular" — e.g. *Rich Girl Caretaker: I'm Secretly the Caregiver of
  the Most Popular Girl in This Rich Kid School* — looked like a skip button and
  navigated to episode 1. Substring matching with no word boundaries.
- **1.1.0** — the "still watching?" dismissal matched the home page's *Continue
  Watching* rail and clicked the first card.

Settings live in `chrome.storage.sync` and apply live — no page reload needed.

## Files

```
manifest.json     MV3 manifest
matchers.js       every text rule; also loads under node for the tests
content.js        DOM scanning, scoping and clicking
settings.html     UI, used as both the popup and the options page
settings.css
settings.js
test/selftest.js  matcher tests
icons/            generated PNGs
```

## Limitations

- Crunchyroll changes its player markup from time to time. The matching is
  keyword-based rather than pinned to exact class names specifically so it
  survives that, but if a skip stops working, the first thing to check is
  whether the button's class/testid still contains a recognisable "skip" word.
  Add patterns to `SKIP_WORDS` / `TYPES` in **`matchers.js`**, and add a test.
- Adding a keyword is a false-positive risk, not a free win. Before adding one,
  ask what real anime title could contain it, and add that title to the test
  suite as a negative case. All three shipped bugs were this mistake.
- Only skips segments where Crunchyroll offers a skip button. It doesn't detect
  intros on its own or seek the video.
- Chrome/Edge only as written. For Firefox add a `browser_specific_settings.gecko.id`
  block to the manifest; the rest of the code is compatible.

## Debugging

Right-click the player → **Inspect**, then in the console's frame dropdown pick
the `player.html` frame. `document.querySelectorAll('[class*="skip" i]')` shows
what the extension is looking at.
