/* Text matchers, shared by the content script and by test/selftest.js.
 *
 * Loaded as a plain content script (exposes globalThis.__autoSkipMatchers)
 * and as a CommonJS module under node, so the rules can be unit-tested.
 *
 * These rules are service-independent on purpose. Every streaming service
 * labels its skip controls with the same handful of words in the same handful
 * of languages, so one keyword engine covers all of them; sites.js supplies
 * only the per-service hooks that no keyword can infer. That also means a rule
 * loosened for one service is loosened for all of them — see below.
 *
 * DESIGN NOTE — read before changing anything here.
 *
 * Three shipped bugs came from matching prose as if it were a UI label:
 *   1.0.0  a button labelled "Continue Watching" is also a home-page rail
 *   1.1.0  "pular" (pt: skip) matched INSIDE "Popular"
 *   1.2.0  "Skip and Loafer" and "Skip Beat!" are real series; `skip` is a
 *          genuine whole word in both, so word boundaries do not save you
 *
 * The conclusion is that a skip word in free text proves nothing. So:
 *
 *   - IDENTITY (class / id / data-testid / data-uia / data-automationid) is
 *     authored by the service's engineers to name a control. A skip word
 *     there is trustworthy.
 *   - LABEL (aria-label / title / text) can be a catalogue title. A skip word
 *     there is trusted only alongside a segment word, with at most one
 *     unrecognised word, in a string short enough to be a button's name.
 *
 * Both directions cost something: a wrong click throws the user out of the
 * episode they were watching, but an over-strict rule silently stops skipping
 * for a whole UI language. v1.3.0 erred the second way and broke French,
 * Italian and Hindi, so the token rule allows one unknown word rather than
 * demanding a closed vocabulary.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__autoSkipMatchers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WORD_CHAR = '[\\p{L}\\p{N}]';

  /* Whole-word match, Unicode-aware. \b is ASCII-only in JS, which is no use for
   * Cyrillic/Arabic/Devanagari, so we use lookarounds. Combining marks are
   * excluded from WORD_CHAR on purpose, so Devanagari "छोड़" matches inside
   * "छोड़ें" — anything that strips marks later undoes this. */
  const words = (list) =>
    new RegExp(`(?<!${WORD_CHAR})(?:${list.join('|')})(?!${WORD_CHAR})`, 'iu');

  /* Matches at a word START, allowing any suffix: "credit" catches "credits",
   * "intro" catches "introduction". Crucially "ending" does NOT match inside
   * "Trending", which an unbounded substring would. */
  const wordStarts = (list) => new RegExp(`(?<!${WORD_CHAR})(?:${list.join('|')})`, 'iu');

  /* Splits the camelCase and kebab-case identifiers we read off class names and
   * data-testids, and the elisions that appear in real labels:
   *   "skipIntroText"       -> "skip Intro Text"
   *   "skip-button__text"   -> "skip button text"
   *   "Passer l'intro"      -> "Passer l intro"
   * Ordinary prose is left alone: "Popular" stays "Popular".
   *
   * The apostrophes matter: without them "l'intro" is one token "lintro", and
   * the word-start anchor then refuses to see "intro" — which silently disabled
   * every French and Italian skip button in 1.3.0. */
  function normalize(text) {
    return String(text == null ? '' : text)
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
      .replace(/[_\-/.:'’ʼ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const SKIP_WORDS = [
    'skip',
    'saltar', 'salta', 'omitir', // es / es-419 / it
    'pular', 'pule', // pt
    'passer', 'ignorer', // fr
    'überspringen', 'uberspringen', // de
    'пропустить', 'пропуск', // ru
    'تخطي', 'تخطى', // ar
    'छोड़', // hi
  ];

  const SKIP_WORD = words(SKIP_WORDS);

  /* Class names and testids are English and often concatenated ("skipintro",
   * "btn-skipbutton"), so in IDENTITY only we also accept "skip" as a word
   * prefix. Safe because identity strings are machine names — the "Popular"
   * class of false positive needs a skip word mid-word, which the word-start
   * anchor still rejects. */
  const SKIP_IDENTITY = new RegExp(`(?<!${WORD_CHAR})skip`, 'iu');

  /* Accessibility links, and identifiers that mean the opposite of "skip":
   * "no-skip", "skip-disabled", "skipped", and Google Translate's injected
   * "skiptranslate" must not read as skip controls. */
  const NOT_A_SKIP = new RegExp(
    [
      `(?<!${WORD_CHAR})skip\\s+(to|nav|link)`,
      `(?<!${WORD_CHAR})(?:no|non|not|dis|disable[d]?|un|hide|hidden|never)\\s+skip`,
      `(?<!${WORD_CHAR})skip\\s+(?:disabled|hidden)`,
      `(?<!${WORD_CHAR})skipped(?!${WORD_CHAR})`,
      `(?<!${WORD_CHAR})skiptranslate`,
    ].join('|'),
    'iu'
  );

  const TYPES = [
    ['outro', wordStarts([
      'credit', 'outro', 'ending', 'coda', 'crédito', 'credito', 'générique', 'generique',
      'abspann', 'titoli', 'титр', 'النهاية', 'क्रेडिट',
    ])],
    ['recap', wordStarts([
      'recap', 'resumen', 'resumo', 'résumé', 'rückblick', 'ruckblick', 'riassunto',
      'повтор', 'ملخص',
    ])],
    ['intro', wordStarts([
      'intro', 'opening', 'abertura', 'apertura', 'ouverture', 'vorspann', 'sigla',
      'заставк', 'вступлени', 'المقدمة', 'مقدمة', 'इंट्रो',
      // Netflix names the cold-open skip "player-skip-preplay". Identifier-only
      // in practice, and no catalogue title contains it.
      'preplay',
    ])],
    // Ads: whole-word only, or "ad" would match the start of "Adventure".
    ['other', words(['ad', 'ads', 'anuncio', 'anúncio', 'publicidad', 'werbung', 'pubblicità', 'annonce', 'реклам'])],
  ];

  /* CJK has no spaces, so token rules do not apply. Handled separately below. */
  const CJK_SKIP = /(?:スキップ|飛ばす|とばす|跳过|跳過|건너뛰기)/;
  const CJK_SKIP_G = new RegExp(CJK_SKIP.source, 'g');
  const CJK_TYPES = [
    ['outro', /(?:エンディング|クレジット|片尾|엔딩)/],
    ['recap', /(?:あらすじ|回顾|回顧)/],
    ['intro', /(?:イントロ|オープニング|片头|片頭|오프닝)/],
  ];

  // Articles and prepositions that sit between the two content words.
  const FILLER = words([
    'the', 'le', 'la', 'les', 'el', 'los', 'il', 'lo',
    'der', 'die', 'das', 'den', 'dem', 'de', 'du', 'di', 'des',
  ]);

  /* Countdowns ("Skip Intro 5") and shortcut hints ("Skip Intro (S)") are not
   * evidence either way. */
  const IGNORABLE = /^(?:\p{N}+|\p{L})$/u;

  /* A button's accessible name is short. An anime title is not. */
  const MAX_LABEL_CHARS = 36;
  const MAX_LABEL_WORDS = 5;

  function isButtonLabel(normalized) {
    if (!normalized || normalized.length > MAX_LABEL_CHARS) return false;
    return normalized.split(' ').filter(Boolean).length <= MAX_LABEL_WORDS;
  }

  function segmentType(normalized) {
    for (const [type, pattern] of TYPES) {
      if (pattern.test(normalized)) return type;
    }
    return null;
  }

  function cjkSegmentType(text) {
    for (const [type, pattern] of CJK_TYPES) {
      if (pattern.test(text)) return type;
    }
    return null;
  }

  /* Keep combining marks: stripping them turns "छोड़ें" into "छड" and makes the
   * skip word unrecognisable, which broke Hindi in 1.3.0. */
  function tokenize(normalized) {
    return normalized
      .split(' ')
      .map((token) => token.replace(/[^\p{L}\p{N}\p{M}]/gu, ''))
      .filter(Boolean);
  }

  /* The untrusted path. Requires a skip word, and then either a segment word
   * with at most one unrecognised token ("Skip Opening Song", "Salta i titoli di
   * coda") or nothing unrecognised at all ("Skip"). "Skip and Loafer" fails for
   * want of a segment word; "Skip Beat! Recap Special" has a segment word but
   * two unknown tokens. */
  function labelType(text) {
    if (CJK_SKIP.test(text)) {
      const type = cjkSegmentType(text);
      if (type) return type;
      const rest = text.replace(CJK_SKIP_G, '').replace(/[^\p{L}\p{N}\p{M}]/gu, '');
      return rest === '' ? 'other' : null; // "スキップ" yes, "スキップとローファー" no
    }

    if (!SKIP_WORD.test(text)) return null;
    if (!isButtonLabel(text)) return null;

    let sawSkip = false;
    let type = null;
    let unknown = 0;

    for (const token of tokenize(text)) {
      if (IGNORABLE.test(token)) continue;
      if (SKIP_WORD.test(token)) {
        sawSkip = true;
        continue;
      }
      if (FILLER.test(token)) continue;
      const segment = segmentType(token);
      if (segment) {
        type = type || segment;
        continue;
      }
      unknown++;
    }

    if (!sawSkip) return null;
    if (type) return unknown <= 1 ? type : null;
    return unknown === 0 ? 'other' : null;
  }

  /**
   * @param {string|{identity?: string, label?: string}} input
   *   A bare string is treated as a LABEL, i.e. the untrusted path.
   * @returns {'intro'|'recap'|'outro'|'other'|null}
   */
  function classifySkip(input) {
    const { identity = '', label = '' } =
      typeof input === 'string' ? { label: input } : input || {};

    const id = normalize(identity);
    const text = normalize(label);
    if (NOT_A_SKIP.test(id) || NOT_A_SKIP.test(text)) return null;

    // Trusted path: the service named this element a skip control.
    if (SKIP_IDENTITY.test(id) || SKIP_WORD.test(id)) {
      return segmentType(id) || segmentType(text) || cjkSegmentType(text) || 'other';
    }

    return labelType(text);
  }

  const NEXT_EPISODE =
    /(next episode|siguiente episodio|próximo episódio|proximo episodio|épisode suivant|episode suivant|nächste folge|nachste folge|prossimo episodio|следующ(ая|ий) (серия|эпизод))/i;

  /* The idle prompt is identified by the QUESTION, including its question mark.
   * Without the "?" this matches ordinary synopsis prose — "He is still watching
   * over the village" — and German "noch da" matches inside "noch dabei". The
   * caller additionally requires a real dialog and a short body. */
  const STILL_WATCHING_PROMPT = new RegExp(
    '(?:' +
      [
        'still watching',
        'still there',
        'are you there',
        // YouTube: "Video paused. Continue watching?". The question mark is
        // what separates it from the Continue Watching rail on every home page.
        'continue watching',
        'keep watching',
        'sigues ah[ií]',
        'ainda est[áa] a[íi]',
        'bist du noch da',
        'sei ancora l[iì]',
        'вы (?:ещё|еще) здесь',
      ].join('|') +
      ')\\s*[?？]',
    'iu'
  );

  /* Only ever applied to a button's LABEL inside an already-confirmed prompt
   * dialog — never to class names. Two-letter words ("si", "ja", "da") are
   * excluded: after normalize() turns hyphens into spaces, a class like
   * "modal-close si-icon" would otherwise read as a confirmation. */
  const CONFIRM_BUTTON = words([
    'continue', 'continuar', 'continuer', 'continua',
    'resume', 'reprendre', 'reanudar',
    'yes', 'oui', 'да',
    'weiterschauen', 'weiter',
    'seguir', 'продолжить',
  ]);

  const isNextEpisode = (raw) => NEXT_EPISODE.test(normalize(raw));
  const isStillWatchingPrompt = (raw) => STILL_WATCHING_PROMPT.test(normalize(raw));
  const isConfirmButton = (raw) => {
    const text = normalize(raw);
    return isButtonLabel(text) && CONFIRM_BUTTON.test(text);
  };

  return {
    normalize,
    isButtonLabel,
    classifySkip,
    isNextEpisode,
    isStillWatchingPrompt,
    isConfirmButton,
  };
});
