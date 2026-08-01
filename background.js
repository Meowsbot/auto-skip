/* Auto Skip — service worker
 *
 * Host access for every service in sites.js is REQUIRED, so it is granted once
 * at install and the extension works everywhere out of the box, including in
 * the Windows "apps" for these services — those are Edge PWAs, i.e. ordinary
 * browser windows, so the same content script runs in them.
 *
 * A service is on when BOTH are true:
 *   1. its host permission is present, and
 *   2. sites[<id>].enabled is not false in chrome.storage.sync.
 *
 * (1) is not a formality even though the permission is required: the user can
 * still withhold site access per extension from chrome://extensions, and a
 * registration for a host we cannot touch is a lie. (2) is the switch in the
 * settings UI. Both are re-read on every sync, so neither can go stale.
 *
 * sync() is idempotent and runs on install, on browser startup, on every
 * permission change, on every settings change, and on every service worker
 * wake. MV3 workers are evicted constantly and registrations can be lost by a
 * crash or a profile sync; a cheap self-heal on every wake is worth more than
 * saving a few milliseconds. The failure this guards against is the extension
 * going quietly inert, which is indistinguishable from it being broken.
 */
importScripts('sites.js', 'remote.js');

const { SITES, SITE_DEFAULTS } = self.__autoSkipSites;

const SCRIPT_FILES = ['matchers.js', 'sites.js', 'content.js'];
const scriptId = (site) => `auto-skip-${site.id}`;

async function hasHost(site) {
  try {
    return await chrome.permissions.contains({ origins: site.matches });
  } catch (_) {
    return false;
  }
}

/* One read per sync, not one per service — storage.sync is a remote-backed API
 * and SITES is walked twice below. Failing open (defaults) is right here: a
 * storage read that fails must not silently disable every service. */
async function readSettings() {
  try {
    const { sites } = await chrome.storage.sync.get({ sites: {} });
    return sites || {};
  } catch (_) {
    return {};
  }
}

const isSwitchedOn = (settings, site) =>
  ({ ...SITE_DEFAULTS, ...(settings[site.id] || {}) }).enabled !== false;

async function isOn(site, settings) {
  return isSwitchedOn(settings, site) && (await hasHost(site));
}

/* Register for granted services, unregister for revoked ones. Registration is
 * rebuilt rather than patched: the match patterns move when sites.js changes,
 * and an update would otherwise leave a stale registration behind. */
async function sync() {
  let registered = [];
  try {
    registered = await chrome.scripting.getRegisteredContentScripts();
  } catch (error) {
    console.error('[auto-skip] cannot read registered scripts:', error);
    return;
  }
  const existing = new Map(registered.map((script) => [script.id, script]));
  const settings = await readSettings();

  for (const site of SITES) {
    const id = scriptId(site);
    const on = await isOn(site, settings);
    const current = existing.get(id);
    const stale = on && matchesChanged(current, site);

    try {
      if (current && (!on || stale)) {
        await chrome.scripting.unregisterContentScripts({ ids: [id] });
      }
      if (on && (!current || stale)) {
        await chrome.scripting.registerContentScripts([
          {
            id,
            matches: site.matches,
            js: SCRIPT_FILES,
            allFrames: true,
            runAt: 'document_idle',
            persistAcrossSessions: true,
          },
        ]);
      }
    } catch (error) {
      // Loud on purpose: a failed registration means this service silently does
      // nothing, and the settings page reads back registrations to show it.
      console.error(`[auto-skip] registration failed for ${site.id}:`, error);
    }
  }

  // Registrations left over from a service that no longer exists in sites.js.
  const known = new Set(SITES.map(scriptId));
  const orphans = registered.filter(
    (script) => script.id.startsWith('auto-skip-') && !known.has(script.id)
  );
  if (orphans.length) {
    await chrome.scripting
      .unregisterContentScripts({ ids: orphans.map((script) => script.id) })
      .catch(() => {});
  }
}

/* True when an existing registration no longer covers what sites.js says. An
 * extension update that widens a service's match patterns must re-register. */
function matchesChanged(script, site) {
  if (!script) return false;
  const before = [...(script.matches || [])].sort().join('|');
  const after = [...site.matches].sort().join('|');
  return before !== after;
}

/* A service that has just been switched on — or that was just installed —
 * should start working in the tab or app window the user already has open, not
 * after a reload. content.js guards against double injection. */
async function injectOpenTabs() {
  const settings = await readSettings();
  for (const site of SITES) {
    if (!(await isOn(site, settings))) continue;
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: site.matches });
    } catch (_) {
      continue;
    }
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.scripting
        .executeScript({ target: { tabId: tab.id, allFrames: true }, files: SCRIPT_FILES })
        .catch(() => {
          /* restricted or closed tab — the registration covers the next load */
        });
    }
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await sync();
  // Everything is on from here, so an episode that is already open should start
  // skipping now rather than after a reload.
  injectOpenTabs();
  // Shown once so the user knows what was turned on and where to turn it off.
  if (details.reason === 'install') chrome.runtime.openOptionsPage().catch(() => {});
});

chrome.runtime.onStartup.addListener(sync);

chrome.permissions.onAdded.addListener(async () => {
  await sync();
  injectOpenTabs();
});

chrome.permissions.onRemoved.addListener(sync);

/* The service switches live in storage now, so a settings change is a
 * registration change. Only `sites` matters — `enabled` is the global kill
 * switch and content.js honours that itself, without unregistering. */
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync' || !('sites' in changes)) return;
  await sync();
  injectOpenTabs();
});

/* Lets the settings page ask what is actually registered, so "enabled" in the
 * UI reflects reality rather than intent. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'auto-skip:status') return false;
  (async () => {
    await sync();
    let registered = [];
    try {
      registered = await chrome.scripting.getRegisteredContentScripts();
    } catch (_) {
      /* reported as: nothing registered */
    }
    const ids = new Set(registered.map((script) => script.id));
    const active = {};
    for (const site of SITES) active[site.id] = ids.has(scriptId(site));
    sendResponse({ active });
  })();
  return true; // async response
});

/* Runs on every worker wake, including the ones triggered by the listeners
 * above. Cheap, and the only thing that repairs a lost registration. */
sync();

/* Remote control. Loaded last, and inert unless the user turned it on — it
 * registers its own listeners and connects to nothing until then. */
importScripts('remote-worker.js');
