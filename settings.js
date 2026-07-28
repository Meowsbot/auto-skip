/* Settings UI — used both as the toolbar popup and as the options page. */

// Keep in sync with content.js
const DEFAULTS = {
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
};

const TOGGLES = Object.keys(DEFAULTS).filter((key) => key !== 'delayMs');

const $ = (id) => document.getElementById(id);

function render(settings) {
  for (const key of TOGGLES) $(key).checked = !!settings[key];
  $('delayMs').value = settings.delayMs;
  $('delayLabel').textContent = (settings.delayMs / 1000).toFixed(2) + 's';
  $('body').classList.toggle('off', !settings.enabled);
}

function save(patch) {
  chrome.storage.sync.set(patch);
}

function renderStats(stats = {}) {
  const total = stats.total || 0;
  if (!total) {
    $('stats').textContent = 'No skips yet';
    return;
  }
  const parts = [
    ['intro', 'intro'],
    ['recap', 'recap'],
    ['outro', 'credits'],
  ]
    .filter(([key]) => stats[key])
    .map(([key, label]) => `${stats[key]} ${label}`);

  $('stats').textContent =
    `${total} skip${total === 1 ? '' : 's'}` + (parts.length ? ` · ${parts.join(', ')}` : '');
}

chrome.storage.sync.get(DEFAULTS, render);
chrome.storage.local.get({ stats: {} }, ({ stats }) => renderStats(stats));

for (const key of TOGGLES) {
  $(key).addEventListener('change', (event) => {
    save({ [key]: event.target.checked });
    if (key === 'enabled') $('body').classList.toggle('off', !event.target.checked);
  });
}

/* Debounced: chrome.storage.sync allows 120 writes/minute and silently drops the
 * rest. One drag across the slider fires ~21 input events. */
let delayWriteTimer;
$('delayMs').addEventListener('input', (event) => {
  const value = Number(event.target.value);
  $('delayLabel').textContent = (value / 1000).toFixed(2) + 's';
  clearTimeout(delayWriteTimer);
  delayWriteTimer = setTimeout(() => save({ delayMs: value }), 300);
});

$('reset').addEventListener('click', () => {
  chrome.storage.local.set({ stats: {} }, () => renderStats({}));
});
