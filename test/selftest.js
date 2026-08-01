/* Matcher and site-registry tests. Run with: node test/selftest.js
 *
 * These guard the false-positive side hardest: a missed skip is a minor
 * annoyance, a wrong click navigates you out of the episode you were watching.
 *
 * Every shipped bug so far has been a real catalogue title that contains a real
 * UI word. The suite MUST keep testing actual catalogue titles — that is the
 * whole bug class. The matcher is shared by every service, so a title from any
 * of them is a valid negative case for all of them.
 */
const M = require('../matchers.js');
const S = require('../sites.js');

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  if (actual === expected) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// A bare string is the untrusted LABEL path.
const label = (text, expected) =>
  check(`label ${JSON.stringify(text)}`, M.classifySkip(text), expected);

// The trusted IDENTITY path (class / id / data-testid).
const identity = (text, expected) =>
  check(`identity ${JSON.stringify(text)}`, M.classifySkip({ identity: text }), expected);

/* ======================= REGRESSIONS — every shipped bug ================== */

// 1.2.0: "Skip and Loafer" and "Skip Beat!" are real Crunchyroll series, and
// `skip` is a genuine whole word in both. Word boundaries alone cannot fix this.
label('Skip and Loafer', null);
label('Skip Beat!', null);
label('SKIP BEAT!', null);
label('Skip and Loafer: Sparkling-Fresh', null);
label('Play Skip and Loafer', null);
label('Add Skip and Loafer to Watchlist', null);
label('Skip and Loafer - Watch on Crunchyroll', null);
// "Trending" contains "ending" — must not route a rejected title into `outro`.
label('Skip and Loafer Trending Now', null);
label('Skip and Loafer: The Ending', null);
label('Skip Beat! Recap Special', null);
label('Skip and Loafer Opening Theme', null);

// 1.1.0: "Popular" contains "pular" (pt: skip).
label("Rich Girl Caretaker: I'm Secretly the Caregiver of the Most Popular Girl in This Rich Kid School", null);
label('Popular', null);
label('Most Popular This Season', null);

// 1.0.0: the home-page rail is not the idle prompt.
check('prompt("Continue Watching")', M.isStillWatchingPrompt('Continue Watching'), false);
check('prompt("Keep Watching")', M.isStillWatchingPrompt('Keep Watching'), false);

/* ============================ real skip controls ========================= */

label('Skip Intro', 'intro');
label('Skip Recap', 'recap');
label('Skip Credits', 'outro');
label('SKIP OPENING', 'intro');
label('Skip Ending', 'outro');
label('Skip', 'other');
label('Skip!', 'other');

// Real labels the 1.3.0 over-correction rejected. False negatives silently
// disable a whole UI language, so these are regressions too.
label("Passer l'intro", 'intro'); // apostrophe elision, fr
label("Passer l'introduction", 'intro');
label("Ignorer l'intro", 'intro');
label("Passer l'ouverture", 'intro');
label("Salta l'introduzione", 'intro'); // it
label('Passer l’intro', 'intro'); // curly apostrophe
label('छोड़ें', 'other'); // hi — combining marks must survive tokenisation
label('इंट्रो छोड़ें', 'intro');
label('Skip Intro (5)', 'intro'); // countdown
label('Skip Intro 5', 'intro');
label('Skip Ad', 'other');
label('Skip Opening Song', 'intro'); // one unknown token is allowed
label('Skip Recap and Intro', 'recap');
label('Salta i titoli di coda', 'outro'); // it, 5 tokens
label('Пропустить вступление', 'intro'); // ru
label('تخطي المقدمة', 'intro'); // ar
label('Omitir intro', 'intro'); // es-419
label('スキップ', 'other'); // ja — no spaces, so token rules can't apply
label('イントロをスキップ', 'intro');
// ...but the Japanese title of Skip and Loafer must still be rejected.
label('スキップとローファー', null);

// Localised UI.
label('Saltar intro', 'intro');
label('Pular abertura', 'intro');
label('Passer le générique', 'outro');
label('Vorspann überspringen', 'intro');
label('Salta sigla', 'intro');
label('Пропустить заставку', 'intro');

// Identifiers — the trusted path.
identity('skipIntroText', 'intro');
identity('skip-button__text', 'other');
identity('skip-intro__cta', 'intro');
identity('skipCreditsButton', 'outro');
identity('vilos-skip-button skip-button--visible', 'other');
// Concatenated / all-caps class names must still be seen.
identity('skipintro', 'other');
identity('btn-skipbutton', 'other');
identity('SKIPINTRO', 'other');
// but a skip word buried mid-word in a class name must not be.
identity('popular-carousel', null);
identity('most-popular-rail', null);
// ...nor may an identifier that means the opposite of "skip".
identity('no-skip', null);
identity('noSkip', null);
identity('disable-skip', null);
identity('hide-skip', null);
identity('never-skip', null);
identity('skip-disabled', null);
identity('skipped', null);
identity('ad-skipped', null);
identity('skiptranslate', null);
identity('skip-link', null);

/* ======================== prose must never classify ====================== */

// Substring traps.
label('Passerby', null);
label('Skipper', null);
label('The Skipper of the Boat', null);
label('Saltamontes', null);

// Accessibility links.
label('Skip to main content', null);
label('Skip navigation', null);
identity('skip-to-content-link', null);

// Player and page furniture.
label('Play', null);
label('Pause', null);
label('Full Screen', null);
label('Add to Watchlist', null);
label('Continue Watching', null);
label('Next Episode', null);
label('Episode 1', null);
label('My Hero Academia', null);
label('Attack on Titan Final Season', null);
label('Frieren: Beyond Journey’s End', null);
label('The Rising of the Shield Hero', null);

/* -------------------------------------------------------- label size limits */

check('isButtonLabel("Skip Intro")', M.isButtonLabel('Skip Intro'), true);
check('isButtonLabel(long title)', M.isButtonLabel('Skip and Loafer the Complete Series Collection'), false);
check('isButtonLabel("")', M.isButtonLabel(''), false);

/* ------------------------------------------------------------ next episode */

check('isNextEpisode("Next Episode")', M.isNextEpisode('Next Episode'), true);
check('isNextEpisode("nextEpisodeButton")', M.isNextEpisode('nextEpisodeButton'), true);
check('isNextEpisode("Nächste Folge")', M.isNextEpisode('Nächste Folge'), true);
check('isNextEpisode("Episode 12")', M.isNextEpisode('Episode 12'), false);
check('isNextEpisode("Next")', M.isNextEpisode('Next'), false);
check('isNextEpisode("Previous Episode")', M.isNextEpisode('Previous Episode'), false);

/* ---------------------------------------------------------- still watching */

check('prompt("Are you still watching?")', M.isStillWatchingPrompt('Are you still watching?'), true);
check('prompt("Still watching?")', M.isStillWatchingPrompt('Still watching?'), true);
check('prompt("Bist du noch da?")', M.isStillWatchingPrompt('Bist du noch da?'), true);

// Synopsis prose — matched the old unbounded patterns.
check(
  'prompt(en synopsis)',
  M.isStillWatchingPrompt('He is still watching over the village from the hill.'),
  false
);
check(
  'prompt(en synopsis 2)',
  M.isStillWatchingPrompt('Years later she is still there, waiting at the station.'),
  false
);
check(
  'prompt(de synopsis)',
  M.isStillWatchingPrompt('Nach dem Tod seines Vaters ist Ken noch dabei, sich zu erholen.'),
  false
);
check(
  'prompt(de synopsis 2)',
  M.isStillWatchingPrompt('Und noch dazu muss er die Welt retten.'),
  false
);
check(
  'prompt(it synopsis)',
  M.isStillWatchingPrompt('Non sei ancora pronto ad affrontare il tuo destino.'),
  false
);

check('isConfirmButton("Continue")', M.isConfirmButton('Continue'), true);
check('isConfirmButton("Yes")', M.isConfirmButton('Yes'), true);
check('isConfirmButton("Weiterschauen")', M.isConfirmButton('Weiterschauen'), true);
check('isConfirmButton("Cancel")', M.isConfirmButton('Cancel'), false);
check('isConfirmButton("Continental Breakfast")', M.isConfirmButton('Continental Breakfast'), false);
// CSS fragments must not read as confirmation once normalize() splits hyphens.
check('isConfirmButton("modal-close si-icon")', M.isConfirmButton('modal-close si-icon'), false);
check('isConfirmButton("lang-ja")', M.isConfirmButton('lang-ja'), false);
// Note: a fragment containing a full confirm word ("no-ja-yes" -> "no ja yes")
// is indistinguishable from a label by text alone. content.js never feeds class
// names to isConfirmButton for exactly this reason — the two-letter cases above
// are the ones a text rule can and must reject.
check('isConfirmButton("btn btn--ja")', M.isConfirmButton('btn btn--ja'), false);
check('isConfirmButton("Non si accettano prenotazioni")', M.isConfirmButton('Non si accettano prenotazioni'), false);

/* ==================== other services' real skip controls ================= */

// Netflix names its controls in data-uia; identityOf() reads that attribute.
identity('player-skip-intro', 'intro');
identity('player-skip-recap', 'recap');
identity('player-skip-credits', 'outro');
identity('player-skip-preplay', 'intro'); // Netflix's cold-open skip
// ...but the seamless next-episode control is not a skip control.
identity('next-episode-seamless-button', null);
identity('interrupt-autoplay-continue', null);

// Disney+, Prime Video, Hulu, Max, Peacock, Paramount+, Apple TV+, YouTube.
identity('skip__button', 'other');
identity('atvwebplayersdk-skipelement-button', 'other');
identity('SkipButton', 'other');
identity('player-ux-skip-button', 'other');
identity('skip-button', 'other');
identity('skip-intro', 'intro');
identity('skip-credits', 'outro');
// YouTube's ad skip: "ad" in the class makes it "other", so it follows the
// "anything else labelled skip" toggle rather than the intro/recap ones.
identity('ytp-ad-skip-button ytp-button', 'other');
identity('ytp-skip-ad-button', 'other');
identity('ytp-ad-skip-button-modern', 'other');
// YouTube furniture that must not read as a skip control.
identity('ytp-next-button ytp-button', null);
identity('ytp-ad-preview-container', null);

// Labels these services actually render.
label('Skip Intro', 'intro');
label('SKIP RECAP', 'recap');
label('Skip Credits', 'outro');
label('Skip Ad', 'other');
label('Skip Ads', 'other');
label('Skip Ads (5)', 'other');
// Catalogue titles from the same services, which must not.
label('The Ad Astra Chronicles', null);
label('Adventure Time', null);
label('Skip to My Lou', null);
label('The Recap Show', null);

/* -------------------------------------------------------- site registry */

const site = (host, expected) =>
  check(`forHost(${JSON.stringify(host)})`, S.forHost(host)?.id ?? null, expected);

site('www.crunchyroll.com', 'crunchyroll');
site('beta.crunchyroll.com', 'crunchyroll');
site('www.netflix.com', 'netflix');
site('www.disneyplus.com', 'disneyplus');
site('www.primevideo.com', 'primevideo');
site('www.amazon.com', 'primevideo');
site('www.amazon.co.uk', 'primevideo');
site('play.max.com', 'max');
site('www.hbomax.com', 'max');
site('www.hulu.com', 'hulu');
site('www.paramountplus.com', 'paramountplus');
site('www.peacocktv.com', 'peacock');
site('tv.apple.com', 'appletv');
site('www.youtube.com', 'youtube');
site('m.youtube.com', 'youtube');
// Look-alike hosts must not match.
site('crunchyroll.com.evil.example', null);
site('notnetflix.com', null);
site('apple.com', null);
site('example.com', null);

const watch = (id, path, expected) => {
  const entry = S.byId(id);
  check(`${id} watchPath ${JSON.stringify(path)}`, entry.watchPath.test(path), expected);
};

watch('crunchyroll', '/watch/GRDQ/episode', true);
watch('crunchyroll', '/es-419/watch/GRDQ/episode', true);
watch('crunchyroll', '/videos/popular', false);
watch('netflix', '/watch/80100172', true);
watch('netflix', '/browse', false);
watch('youtube', '/watch?v=abc', true);
watch('youtube', '/feed/subscriptions', false);
watch('hulu', '/watch/abc-123', true);
watch('hulu', '/hub/movies', false);

/* Every entry must be complete and internally consistent — a typo'd field here
 * silently disables a whole service. */
const ids = new Set();
for (const entry of S.SITES) {
  check(`${entry.id} id is unique`, ids.has(entry.id), false);
  ids.add(entry.id);
  check(`${entry.id} has matches`, entry.matches.length > 0, true);
  check(`${entry.id} has a watchPath`, entry.watchPath instanceof RegExp, true);
  check(`${entry.id} matches its own host pattern`, !!S.forHost(hostOf(entry.matches[0])), true);
  for (const pattern of entry.matches) {
    check(`${entry.id} pattern ${pattern} is https`, /^https:\/\/[^/]+\/\*$/.test(pattern), true);
  }
  for (const list of ['skipSelectors', 'nextEpisodeSelectors', 'stillWatchingSelectors']) {
    check(`${entry.id} ${list} is an array`, Array.isArray(entry[list]), true);
  }
}

/* A fresh install must work on every service without being configured, and the
 * switch must be a real setting rather than an implicit one — content.js reads
 * settings.enabled directly, so a missing default would read as undefined and
 * only accidentally behave like "on". */
check('SITE_DEFAULTS has an enabled switch', 'enabled' in S.SITE_DEFAULTS, true);
check('services default to on', S.SITE_DEFAULTS.enabled, true);

function hostOf(matchPattern) {
  return matchPattern.replace(/^https:\/\//, '').replace(/\/\*$/, '').replace(/^\*\./, 'www.');
}

/* ------------------------------------------------------------------ normalize */

check('normalize("skipIntroText")', M.normalize('skipIntroText'), 'skip Intro Text');
check('normalize("skip-button__text")', M.normalize('skip-button__text'), 'skip button text');
check('normalize("Popular")', M.normalize('Popular'), 'Popular');
check('normalize(null)', M.normalize(null), '');

/* --------------------------------------------------------------------- report */

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const failure of failures) console.error('  x ' + failure);
  process.exit(1);
}
console.log(`All ${passed} matcher tests passed.`);
