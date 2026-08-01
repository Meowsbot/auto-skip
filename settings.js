/* Settings UI — used both as the toolbar popup and as the options page.
 *
 * Host access is required rather than optional, so every service is granted at
 * install and every service starts on. The switch is therefore a stored flag,
 * `sites[<id>].enabled`, and flipping it is an ordinary storage write — which
 * works from the popup, unlike a permission prompt.
 *
 * The permission is still read, because a user can withhold site access per
 * extension from chrome://extensions. A service that is switched on but has no
 * host access is not running, and the row must not claim otherwise;
 * verifyRegistrations() below turns that case into a visible notice rather than
 * a silent no-op.
 */

const { SITES, SITE_DEFAULTS } = globalThis.__autoSkipSites;

/* `enabled` is the service switch in the row header, not a row in the options
 * panel, and "copy these settings to every service" must not carry it across —
 * that button copies preferences, not which services you run. */
const TOGGLE_KEYS = Object.keys(SITE_DEFAULTS).filter(
  (key) => key !== 'delayMs' && key !== 'enabled'
);

const $ = (id) => document.getElementById(id);
const fmtDelay = (ms) => (ms / 1000).toFixed(2) + 's';

let state = { enabled: true, sites: {} };
let granted = new Set();

/* -------------------------------------------------------------- storage */

const optionsFor = (id) => ({ ...SITE_DEFAULTS, ...(state.sites[id] || {}) });

function saveSite(id, patch) {
  state.sites = { ...state.sites, [id]: { ...optionsFor(id), ...patch } };
  chrome.storage.sync.set({ sites: state.sites });
}

/* ------------------------------------------------------------ rendering */

function buildOptions(site) {
  const node = $('options-template').content.firstElementChild.cloneNode(true);
  for (const input of node.querySelectorAll('[data-key]')) {
    input.id = `${site.id}--${input.dataset.key}`;
  }
  const label = node.querySelector('[data-label="delayMs"]');
  if (label) label.id = `${site.id}--delayLabel`;

  node.addEventListener('change', (event) => {
    const key = event.target.dataset?.key;
    if (!key || key === 'delayMs') return;
    saveSite(site.id, { [key]: event.target.checked });
  });

  /* Debounced: chrome.storage.sync allows 120 writes/minute and silently drops
   * the rest. One drag across the slider fires ~21 input events. */
  let delayTimer;
  const slider = node.querySelector('[data-key="delayMs"]');
  slider.addEventListener('input', (event) => {
    const value = Number(event.target.value);
    label.textContent = fmtDelay(value);
    clearTimeout(delayTimer);
    delayTimer = setTimeout(() => saveSite(site.id, { delayMs: value }), 300);
  });

  node.querySelector('[data-action="copy"]').addEventListener('click', () => {
    const { enabled: _ignored, ...source } = optionsFor(site.id);
    const sites = { ...state.sites };
    // Each service keeps its own switch; only the preferences are copied.
    for (const other of SITES) sites[other.id] = { ...optionsFor(other.id), ...source };
    state.sites = sites;
    chrome.storage.sync.set({ sites }, () => {
      renderOptions();
      flash(`Copied ${site.name}'s settings to every service.`);
    });
  });

  return node;
}

function buildService(site) {
  const row = document.createElement('div');
  row.className = 'service';
  row.dataset.id = site.id;
  row.style.setProperty('--accent', site.accent);

  const head = document.createElement('div');
  head.className = 'head';
  head.innerHTML = `
    <span class="dot"></span>
    <button class="name" type="button" aria-expanded="false">
      ${site.name}<em><span data-role="host"></span></em>
    </button>
    <span class="switch"><input type="checkbox" data-role="enable" /><span class="track"></span></span>
  `;
  head.querySelector('[data-role="host"]').textContent = site.host;

  const name = head.querySelector('.name');
  name.addEventListener('click', () => {
    const open = row.classList.toggle('open');
    name.setAttribute('aria-expanded', String(open));
  });

  head.querySelector('[data-role="enable"]').addEventListener('change', (event) => {
    setService(site, event.target.checked);
  });

  row.append(head, buildOptions(site));
  return row;
}

function renderOptions() {
  for (const site of SITES) {
    const options = optionsFor(site.id);
    for (const key of TOGGLE_KEYS) {
      const input = $(`${site.id}--${key}`);
      if (input) input.checked = !!options[key];
    }
    const slider = $(`${site.id}--delayMs`);
    if (slider) slider.value = options.delayMs;
    const label = $(`${site.id}--delayLabel`);
    if (label) label.textContent = fmtDelay(options.delayMs);
  }
}

const isOn = (id) => optionsFor(id).enabled !== false;

function renderServices() {
  let on = 0;
  for (const site of SITES) {
    const row = document.querySelector(`.service[data-id="${site.id}"]`);
    if (!row) continue;
    const wanted = isOn(site.id);
    if (wanted) on++;
    // The switch shows what you asked for; the row dims when the browser has
    // withheld site access, so "on but not running" is visible at a glance.
    row.classList.toggle('active', wanted && granted.has(site.id));
    row.querySelector('[data-role="enable"]').checked = wanted;
  }
  $('sub').textContent = on
    ? `${on} of ${SITES.length} service${SITES.length === 1 ? '' : 's'} on`
    : 'All services off — turn one on below';
  $('body').classList.toggle('off', !state.enabled);
}

/* ----------------------------------------------------------- permissions */

async function readGranted() {
  granted = new Set();
  for (const site of SITES) {
    try {
      if (await chrome.permissions.contains({ origins: site.matches })) granted.add(site.id);
    } catch (_) {
      /* treated as not granted */
    }
  }
}

function setService(site, wanted) {
  saveSite(site.id, { enabled: wanted });
  renderServices();
  if (wanted && !granted.has(site.id)) {
    // Switched on, but the browser is withholding access to this host.
    flash(
      `${site.name} needs access to ${site.host}. Turn it on in your browser's ` +
        `extensions page → Auto Skip → Details → Site access.`,
      true
    );
    return;
  }
  // background.js re-registers on the storage change; confirm it actually did.
  setTimeout(verifyRegistrations, 300);
}

/* Reads back what the service worker actually registered. A service that is
 * switched on and has host access but is not registered means the extension is
 * inert for it — exactly the failure that must not be silent. */
async function verifyRegistrations() {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'auto-skip:status' });
  } catch (_) {
    return;
  }
  if (!response?.active) return;
  const broken = SITES.filter(
    (site) => isOn(site.id) && granted.has(site.id) && !response.active[site.id]
  );
  if (broken.length) {
    flash(
      `Not running on ${broken.map((site) => site.name).join(', ')} — reload the extension.`,
      true
    );
  }
}

/* ---------------------------------------------------------------- remote */

/* Pairing. The server address is arbitrary — it is a machine on the user's
 * LAN — so its host permission cannot be declared at build time. It is
 * requested here, for that one origin, from the click that saves it. The
 * manifest's broad optional pattern is what makes that request legal; the
 * extension never asks for more than the single origin typed in this box.
 *
 * The token is stored in chrome.storage.sync like every other setting. That
 * means it syncs to the user's other browsers, which is the behaviour they
 * expect from a paired device, and it is no more exposed than any other
 * extension setting on a machine someone already controls. */

const remoteState = () => ({
  enabled: !!state.remote?.enabled,
  server: state.remote?.server || '',
  token: state.remote?.token || '',
});

function renderRemote() {
  const remote = remoteState();
  $('remote-enabled').checked = remote.enabled;
  $('remote-server').value = remote.server;
  $('remote-token').value = remote.token;
  $('remote-status').textContent = remote.enabled ? 'On' : 'Off';
  $('remote-card').classList.toggle('active', remote.enabled);
}

function saveRemote(patch) {
  state.remote = { ...remoteState(), ...patch };
  chrome.storage.sync.set({ remote: state.remote });
  renderRemote();
}

async function connectRemote() {
  const typed = $('remote-server').value;
  const server = globalThis.__autoSkipRemote.normalizeServer(typed);
  const token = $('remote-token').value.trim();

  if (!server) return flash('That server address is not a valid http address.', true);
  if (!token) return flash('Paste the token the server printed on startup.', true);

  /* Ask for access to that one origin. Must come from this click — a
   * permission request outside a user gesture is refused. */
  let allowed = false;
  try {
    allowed = await chrome.permissions.request({ origins: [`${server}/*`] });
  } catch (error) {
    return flash(`Could not ask for access to ${server}: ${error.message}`, true);
  }
  if (!allowed) return flash(`Auto Skip needs access to ${server} to reach it.`, true);

  $('remote-status').textContent = 'Checking…';
  try {
    const response = await fetch(`${server}/health`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`server said ${response.status}`);
  } catch (error) {
    $('remote-status').textContent = 'Off';
    return flash(`No server at ${server} — is it running? (${error.message})`, true);
  }

  saveRemote({ enabled: true, server, token });
  flash(`Connected to ${server}.`);
}

/* ---------------------------------------------------------------- notice */

let flashTimer;
function flash(message, sticky = false) {
  const notice = $('notice');
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(flashTimer);
  if (!sticky) flashTimer = setTimeout(() => (notice.hidden = true), 4000);
}

/* ----------------------------------------------------------------- stats */

const KIND_LABELS = [
  ['intro', 'intro'],
  ['recap', 'recap'],
  ['outro', 'credits'],
  ['other', 'other'],
];

function renderStats(stats = {}) {
  const total = stats.total || 0;
  if (!total) {
    $('stats').textContent = 'No skips yet';
  } else {
    const parts = KIND_LABELS.filter(([key]) => stats[key]).map(
      ([key, label]) => `${stats[key]} ${label}`
    );
    $('stats').textContent =
      `${total} skip${total === 1 ? '' : 's'}` + (parts.length ? ` · ${parts.join(', ')}` : '');
  }

  const bySite = stats.sites || {};
  for (const site of SITES) {
    const row = document.querySelector(`.service[data-id="${site.id}"] [data-role="host"]`);
    if (!row) continue;
    const count = bySite[site.id]?.total || 0;
    row.textContent = count ? `${site.host} · ${count} skip${count === 1 ? '' : 's'}` : site.host;
  }
}

/* ------------------------------------------------------------------ init */

async function init() {
  const list = $('services');
  for (const site of SITES) list.append(buildService(site));

  state = await chrome.storage.sync.get({ enabled: true, sites: {}, remote: {} });
  $('enabled').checked = state.enabled !== false;

  await readGranted();
  renderOptions();
  renderServices();
  renderRemote();

  $('remote-save').addEventListener('click', () => {
    connectRemote().catch((error) => flash(String(error.message || error), true));
  });
  $('remote-enabled').addEventListener('change', (event) => {
    if (event.target.checked) {
      // Turning it on means pairing; do the whole check rather than trusting
      // a stored address that may never have worked.
      event.target.checked = false;
      connectRemote().catch((error) => flash(String(error.message || error), true));
    } else {
      saveRemote({ enabled: false });
      flash('Remote control off. The extension makes no network requests again.');
    }
  });

  chrome.storage.local.get({ stats: {} }, ({ stats }) => renderStats(stats));
  verifyRegistrations();

  $('enabled').addEventListener('change', (event) => {
    state.enabled = event.target.checked;
    chrome.storage.sync.set({ enabled: state.enabled });
    $('body').classList.toggle('off', !state.enabled);
  });

  $('reset').addEventListener('click', () => {
    chrome.storage.local.set({ stats: {} }, () => renderStats({}));
  });

  // The popup and the options page can be open at once, site access can be
  // withheld from chrome://extensions, and settings sync across devices.
  const refresh = async () => {
    await readGranted();
    renderServices();
  };
  chrome.permissions.onAdded.addListener(refresh);
  chrome.permissions.onRemoved.addListener(refresh);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if ('sites' in changes) {
      state.sites = changes.sites.newValue || {};
      renderOptions();
      renderServices();
    }
    if ('enabled' in changes) {
      state.enabled = changes.enabled.newValue !== false;
      $('enabled').checked = state.enabled;
      $('body').classList.toggle('off', !state.enabled);
    }
    if ('remote' in changes) {
      state.remote = changes.remote.newValue || {};
      renderRemote();
    }
  });
}

init();
