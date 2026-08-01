# Auto Skip

A small Chrome/Edge (Manifest V3) extension that clicks a streaming service's own
**Skip Intro** / **Skip Recap** / **Skip Credits** buttons for you the moment they
appear, so you never have to reach for the mouse mid-episode.

It can also jump past the "next episode" countdown and dismiss the
"are you still watching?" prompt.

You pick which services it runs on. Each one keeps its own copy of every setting.

| Service | Host | Notes |
| --- | --- | --- |
| Crunchyroll | `crunchyroll.com` | |
| Netflix | `netflix.com` | |
| Disney+ | `disneyplus.com` | |
| Prime Video | `primevideo.com`, `amazon.com/.co.uk/.de/.co.jp` | |
| HBO Max | `max.com`, `hbomax.com` | |
| Hulu | `hulu.com` | |
| Paramount+ | `paramountplus.com` | |
| Peacock | `peacocktv.com` | |
| Apple TV+ | `tv.apple.com` | |
| YouTube | `youtube.com` | Ad skip button only |

> Not affiliated with, endorsed by, or connected to any of these services. All
> names are trademarks of their respective owners. This extension only clicks
> buttons the player already shows you; it does not bypass ads that have no skip
> button, and it does not touch DRM, playback or accounts.

## Install

Works in Chrome, Edge, Brave, Opera, and other Chromium browsers.

1. Download the latest `auto-skip.zip` from [Releases](../../releases), and unzip
   it somewhere you'll keep it — the browser loads it from that folder, so don't
   delete it afterwards.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder — the one containing
   `manifest.json`.
5. Accept the access prompt for the services listed above.
6. Open an episode. That's it.

Every service is on from the start. The settings page opens once on install so
you can see what that is and switch off anything you don't want.

## Desktop apps

The Windows Store "apps" for Crunchyroll, Netflix, Disney+ and Prime Video are
not native apps. Each one is a **Microsoft Edge PWA** — the package contains no
code at all, only icons and a manifest pointing Edge at the site:

```
Crunchyroll   --app-id=hjlhbeffadgkonmpnblkfmhckmocohah  https://www.crunchyroll.com/
Netflix       --app-id=edhbnieanoeijlkpgkminebadpibapgm  https://www.netflix.com/pwa
Disney+       --app-id=mbjafbmjpcimpkkihihoideiofnoalmh  https://www.disneyplus.com/
Prime Video   --app-id=dfknihiibccbincpokjjfppofbehhbap  https://www.primevideo.com/
```

They run in the Edge **Default** profile, in ordinary renderers. So there is
nothing to port: **install the extension in Edge and it runs inside those app
windows too.** Same content script, same settings, same skip counter.

Check your own with:

```powershell
$p = Get-AppxPackage -Name 15EF7777.Crunchyroll
(Select-String -Path "$($p.InstallLocation)\AppxManifest.xml" -Pattern 'uap10:Parameters=').Line
```

A `uap10:HostId="PWA"` and a dependency on `Microsoft.MicrosoftEdge.Stable`
mean it's an Edge web app and the extension covers it. Notes:

- Install into the **profile the app uses** — the `profile-directory` in that
  same manifest line, `Default` for all four.
- The toolbar icon isn't in a PWA window. Open settings from a normal Edge
  window, or `edge://extensions` → **Details** → **Extension options**.
- Genuinely native apps (iOS, tvOS, smart TVs, consoles) are out of reach; they
  have no extension model at all.

## Choosing services

Each service is a row in the settings page, and every row starts **on**:

- The **switch** on the right turns that service off and on. It's a stored
  setting, so it works from the popup as well as the options page, and the
  content script is unregistered when you switch a service off.
- Clicking the **name** opens that service's settings — the same full set for
  every service, stored separately.
- **Copy these settings to every service** applies the one you're looking at to
  all of them, so you only have to set your preferences once. It copies
  preferences only, never the service switches.

The header switch is a global kill switch and leaves your choices intact.

Site access can also be withheld per service from `chrome://extensions` →
**Details** → **Site access**. A service that is switched on but has no access
is dimmed in the settings page and says so, rather than pretending to run.

## Privacy

The extension collects nothing and sends nothing anywhere. It has two
permissions, `storage` (settings and a local skip counter) and `scripting`
(registering the content script for the services you have on), plus host access
to the services in the table above and nothing else — checked at build time in
both directions, so it cannot ask for a host no service uses. No network
requests, no analytics, no remote code.

## Settings

Every service has all of these, independently.

| Setting | Default | What it does |
| --- | --- | --- |
| Service switch | on | Runs the extension on that service |
| Intros / openings | on | Clicks "Skip Intro" |
| Recaps | on | Clicks "Skip Recap" |
| Credits / outros | on | Clicks "Skip Credits" / "Skip Ending" |
| Anything else labelled "skip" | on | Catch-all, including YouTube's skip-ad button |
| Jump to next episode | **off** | Clicks the up-next card instead of waiting out the countdown |
| Dismiss "still watching?" | on | Clears the idle prompt so playback continues |
| Toast | on | Brief "Intro skipped" pill in the player, in the service's colour |
| Wait before skipping | 0.00s | Delay up to 5s, so you have a beat to cancel |

The footer shows a running skip count, and each service row shows its own.
**Reset** clears them.

## How it works

`background.js` registers `content.js` at runtime, once per service that is on.
Four times a second the content script scans buttons and skip-ish elements,
matches them against a set of keywords (`skip`, `intro`, `recap`, `credits`, plus
the equivalents in the other UI languages these services ship), checks that the
element is actually visible — the skip button usually sits in the DOM at
`opacity: 0` between segments — and dispatches a real pointer/mouse/click
sequence at its centre.

**One matcher, all services.** The keyword engine in `matchers.js` is
service-independent, because every service labels these controls with the same
handful of words. `sites.js` supplies only what no keyword can infer: where the
player lives in the URL space, fallback player containers, and a short list of
curated element hooks (`[data-uia="player-skip-intro"]`,
`.atvwebplayersdk-skipelement-button`, and so on). The player itself is located
by finding the `<video>` element rather than by matching class names, which
change.

Everything is scoped twice over:

- **Page scope** (`inScope()`): the service's watch paths, any frame containing a
  `<video>`, and — for services that play inline over a detail page — anywhere a
  `<video>` exists. Re-checked every tick, because these are all SPAs and the URL
  changes without a reload.
- **DOM scope** (`searchRoots()`): the search region grows outward from the
  `<video>` — start at its parent, keep climbing while the container holds no
  rail or carousel. A watch page also carries episode lists and recommendation
  rails, and a catalogue *title* is arbitrary text — it can contain anything. If
  no container can be identified it falls back to the whole document rather than
  doing nothing, because failing closed here is indistinguishable from being
  broken.

Further guards:

- **Identity is trusted; prose is not.** This is the central rule. A skip word in
  `class`/`id`/`data-testid`/`data-uia`/`data-automationid` was put there by the
  service's engineers to name a control, so it counts. A skip word in visible
  text might be a catalogue title, so it counts only if *every* word in the label
  is a skip word, a segment word, or an article — and the label is short enough
  to be a button's accessible name. `Skip Intro` passes. `Skip and Loafer` does
  not.
- **Whole-word matching, Unicode-aware.** JS `\b` is ASCII-only and useless for
  Cyrillic/Arabic/Devanagari, so `matchers.js` uses lookarounds instead. Labels are
  normalised first (`skipIntroText` → `skip Intro Text`) so identifiers still match
  without loosening the rule.
- **Skip buttons are never links.** If the element wraps *or is wrapped by* an
  `<a href>`, it isn't a skip button, whatever its text says.
- **Never inside a rail, carousel or content card**, except within the container
  that holds the `<video>`, where everything is player chrome by definition.
- 1.2s global cooldown between clicks, and an 8s repeat block keyed on a stable
  description of the control rather than on node identity — these SPAs re-render
  constantly, and a fresh node for the same button used to defeat the block
  entirely.
- Accessibility links like "Skip to main content" are excluded.
- The idle prompt must be a dialog with a short body that asks the *question*,
  including its question mark; the confirm button is then matched by label only,
  never by class name. Services that don't use `role="dialog"` declare their own
  container in `sites.js`.
- Next-episode requires an up-next/end-card container and rejects anything in the
  control bar, so it can't hit the always-present next-episode control — unless
  the service declares an exact selector for the up-next button, which is
  stronger evidence.

Where a heuristic can't confirm what it's looking at, it does nothing rather than
guessing.

**A service runs when it is switched on and the browser lets it.** Both halves
are re-read on every sync: the stored switch (`sites.<id>.enabled`, default
true) and `chrome.permissions.contains()` — the host permission is required, so
it is normally there, but site access can still be withheld per extension.
Registering a script for a host we can't touch would be a lie, and a switch that
claims to be on while nothing happens is the failure this design exists to
avoid. `background.js` re-syncs on install, on browser startup, on every
permission change, on every settings change and on every service worker wake,
and the settings page reads the registrations back — a service that is on but
failed to register says so instead of silently doing nothing. `content.js`
checks the switch again on every tick, because unregistering cannot stop a
script already running in an open page.

## Tests

```
node test/selftest.js
```

`matchers.js` and `sites.js` load both as content scripts and as CommonJS
modules, so the rules and the registry are unit-testable without a browser. The
suite leans hard on false positives — a missed skip is a minor annoyance, a wrong
click throws you out of the episode you were watching. It also checks that every
site entry is complete and that look-alike hosts (`crunchyroll.com.evil.example`)
don't match.

`package.ps1` refuses to build if `sites.js` and the manifest's
`host_permissions` disagree in either direction — a missing pattern means that
service can never run, and an extra one means asking for access to a host
nothing uses.

## Adding a service

1. Add an entry to `SITES` in **`sites.js`**. Keep the `*Selectors` lists narrow:
   anything in them is trusted outright, so a selector like `[class*="button"]`
   would undo every guard above.
2. Add its match patterns to `host_permissions` in **`manifest.json`**. Adding a
   service widens the install-time permission prompt for everyone, so it should
   be a service people actually use.
3. Add a `forHost` test and a `watchPath` test in **`test/selftest.js`**.

Adding a *keyword* to `matchers.js` is a different matter — see Limitations.

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
manifest.json     MV3 manifest; optional host permissions only
background.js     registers the content script per granted service
sites.js          the service registry; also loads under node for the tests
matchers.js       every text rule; also loads under node for the tests
content.js        DOM scanning, scoping and clicking
settings.html     UI, used as both the popup and the options page
settings.css
settings.js
test/selftest.js  matcher and registry tests
icons/            generated PNGs
```

## Limitations

- Services change their player markup from time to time. The matching is
  keyword-based rather than pinned to exact class names specifically so it
  survives that, but if a skip stops working, the first thing to check is
  whether the button's class/testid still contains a recognisable "skip" word.
  Add patterns to `SKIP_WORDS` / `TYPES` in **`matchers.js`**, or a curated
  selector to that service's `skipSelectors` in **`sites.js`**, and add a test.
- Adding a keyword is a false-positive risk for *every* service, not a free win.
  Before adding one, ask what real catalogue title could contain it, and add that
  title to the test suite as a negative case. All three shipped bugs were this
  mistake. A curated selector in `sites.js` is usually the safer fix, because it
  affects one service only.
- Only skips segments where the service offers a skip button. It doesn't detect
  intros on its own or seek the video, and it can't skip an unskippable ad.
- YouTube support is the skip-ad button only. It deliberately does not treat the
  presence of a `<video>` as enough — the home page and every channel page
  autoplay previews next to a feed full of arbitrary titles.
- Chrome/Edge only as written. For Firefox add a `browser_specific_settings.gecko.id`
  block to the manifest; the rest of the code is compatible.

## Debugging

Turn on **Debug logging** for the service in question, then open the console on
the watch page. It prints every skip-like element in scope and exactly which gate
rejected it, at most once every two seconds. If the player is in an iframe, pick
that frame in the console's frame dropdown first.

If a service is on but nothing happens at all, check the service worker's console
(`chrome://extensions` → **Details** → **service worker**) for a registration
error.
