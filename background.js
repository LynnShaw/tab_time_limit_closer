/**
 * Tab Time Limiter - Background Service Worker
 *
 * Time tracking is fully event-driven:
 *   - Tab activated / window focused  → start session (record startTime)
 *   - Tab deactivated / closed / navigated / window blurred → end session
 *     (compute elapsed = now - startTime, add to usage)
 *
 * The alarm (every 30 s) is only used for two things:
 *   1. Process pendingClose entries (2-minute grace period countdowns)
 *   2. Recover a session that was lost when Chrome killed the Service Worker
 */

const ALARM_NAME = 'ttl_tracker';
const ALARM_PERIOD_MINUTES = 0.5; // 30 s – minimum Chrome allows
const GRACE_MS = 2 * 60 * 1000;  // grace period before closing a blocked tab

// ─── In-memory state ──────────────────────────────────────────────────────────

// tabId → timestamp when it should be closed
const pendingClose = new Map();

// Currently tracked session (also persisted to storage to survive SW restarts)
// Shape: { tabId: number, siteId: string, startTime: number } | null
let activeSession = null;

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(onInit);
chrome.runtime.onStartup.addListener(onInit);

async function onInit() {
  const data = await chrome.storage.local.get(['sites', 'usage']);
  if (!data.sites) {
    await chrome.storage.local.set({ sites: [], usage: {}, activeSession: null });
  }
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  await recoverAndStartSession();
  console.log('[TTL] Initialized');
}

// ─── Tab / window events ──────────────────────────────────────────────────────

// User switches to a different tab
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await endSession();
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) await tryStartSession(tab.id, tab.url);
  } catch (_) {}
});

// Tab navigates to a new URL
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return; // ignore load-progress events, only URL changes
  if (activeSession?.tabId === tabId) await endSession();
  // Only start a new session if this tab is the active one in the focused window
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused?.id === tabId) await tryStartSession(tabId, changeInfo.url);
});

// User switches browser windows (or all windows lose focus)
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await endSession();
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab?.url) await tryStartSession(tab.id, tab.url);
});

// Tab closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (activeSession?.tabId === tabId) await endSession();
  pendingClose.delete(tabId);
});

// ─── Alarm ────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  // SW may have been killed and restarted – recover any lost session
  if (!activeSession) await recoverAndStartSession();
  // Sweep all open tabs so newly-opened blocked tabs get scheduled
  await enforceAllOpenTabs();
  // Close tabs whose 2-minute grace period has elapsed
  await processPendingCloses();
});

// ─── Session management ───────────────────────────────────────────────────────

/**
 * Start tracking a session for tabId/url.
 * If the site is already over-limit, schedule the tab for closure instead.
 */
async function tryStartSession(tabId, url) {
  const { sites = [], usage = {} } = await chrome.storage.local.get(['sites', 'usage']);
  const site = matchSite(sites, url);
  if (!site) return;

  const now = Date.now();

  // Reset window if it has expired
  const reset = maybeResetWindow(usage[site.id], site, now);
  if (reset) {
    usage[site.id] = reset;
    await chrome.storage.local.set({ usage });
  }

  // Already over limit → schedule close, do not track
  if (isOverLimit(usage[site.id], site)) {
    schedulePendingClose(tabId, site);
    return;
  }

  // Avoid restarting an identical session that's already running
  if (activeSession?.tabId === tabId && activeSession?.siteId === site.id) return;

  activeSession = { tabId, siteId: site.id, startTime: now };
  await chrome.storage.local.set({ activeSession });
}

/**
 * End the active session: flush elapsed seconds into usage, check limit.
 */
async function endSession() {
  if (!activeSession) return;

  const { sites = [], usage = {} } = await chrome.storage.local.get(['sites', 'usage']);
  const now = Date.now();
  const elapsed = (now - activeSession.startTime) / 1000;
  const { siteId } = activeSession;

  // Clear before any async work so re-entrant calls don't double-count
  activeSession = null;
  await chrome.storage.local.set({ activeSession: null });

  if (elapsed <= 0) return;

  const siteRule = sites.find((s) => s.id === siteId);
  if (!siteRule) return;

  usage[siteId] = accrueUsage(usage[siteId], siteRule, elapsed, now);
  await chrome.storage.local.set({ usage });

  if (isOverLimit(usage[siteId], siteRule)) {
    await scheduleAllTabsForSite(sites, siteId, siteRule);
  }
}

/**
 * Called on SW restart (when activeSession is null in memory).
 * Flushes any session that was persisted to storage before the SW died,
 * then starts a fresh session from the current active tab.
 */
async function recoverAndStartSession() {
  const { activeSession: saved, sites = [], usage = {} } =
    await chrome.storage.local.get(['activeSession', 'sites', 'usage']);

  if (saved) {
    const now = Date.now();
    // Cap at the window size as a sanity guard
    const siteRule = sites.find((s) => s.id === saved.siteId);
    const maxSecs = siteRule ? siteRule.windowHours * 3600 : 7200;
    const elapsed = Math.min((now - saved.startTime) / 1000, maxSecs);

    if (siteRule && elapsed > 0) {
      usage[saved.siteId] = accrueUsage(usage[saved.siteId], siteRule, elapsed, now);
      await chrome.storage.local.set({ usage, activeSession: null });

      if (isOverLimit(usage[saved.siteId], siteRule)) {
        await scheduleAllTabsForSite(sites, saved.siteId, siteRule);
        return; // site is blocked, no point starting a new session
      }
    } else {
      await chrome.storage.local.set({ activeSession: null });
    }
  }

  // Try to start a fresh session from whatever tab is currently active
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.url) await tryStartSession(tab.id, tab.url);
}

// ─── Pending-close (grace period) ────────────────────────────────────────────

/**
 * Register a tab for closure after GRACE_MS.
 * If the tab is already registered the original countdown is preserved.
 */
function schedulePendingClose(tabId, site) {
  if (pendingClose.has(tabId)) return;
  pendingClose.set(tabId, Date.now() + GRACE_MS);
  fireWarningNotification(site);
}

/** Schedule all open tabs of a site id for deferred closure. */
async function scheduleAllTabsForSite(sites, siteId, site) {
  const allTabs = await chrome.tabs.query({});
  for (const tab of allTabs) {
    if (!tab.url) continue;
    if (matchSite(sites, tab.url)?.id === siteId) schedulePendingClose(tab.id, site);
  }
}

/** Close every tab whose grace period has elapsed. */
async function processPendingCloses() {
  const now = Date.now();
  for (const [tabId, closeAt] of pendingClose.entries()) {
    if (now >= closeAt) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
      pendingClose.delete(tabId);
    }
  }
}

/**
 * Sweep all open tabs and schedule any that belong to a currently-blocked site.
 * Lightweight – does not add time, only triggers close scheduling.
 */
async function enforceAllOpenTabs() {
  const { sites = [], usage = {} } = await chrome.storage.local.get(['sites', 'usage']);
  if (!sites.length) return;
  const now = Date.now();
  const allTabs = await chrome.tabs.query({});
  for (const tab of allTabs) {
    if (!tab.url) continue;
    const site = matchSite(sites, tab.url);
    if (!site) continue;
    const su = usage[site.id];
    if (!su) continue;
    if (now > su.windowStart + site.windowHours * 3600 * 1000) continue; // window expired
    if (isOverLimit(su, site)) schedulePendingClose(tab.id, site);
  }
}

// ─── Usage helpers ────────────────────────────────────────────────────────────

function accrueUsage(existing, site, elapsed, now) {
  let su = existing || { windowStart: now, secondsUsed: 0 };
  if (now > su.windowStart + site.windowHours * 3600 * 1000) {
    su = { windowStart: now, secondsUsed: 0 };
  }
  su.secondsUsed += elapsed;
  return su;
}

function maybeResetWindow(existing, site, now) {
  if (!existing) return null;
  if (now > existing.windowStart + site.windowHours * 3600 * 1000) {
    return { windowStart: now, secondsUsed: 0 };
  }
  return null;
}

function isOverLimit(su, site) {
  return su && su.secondsUsed >= site.limitMinutes * 60;
}

// ─── URL matching ─────────────────────────────────────────────────────────────

function matchSite(sites, url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return (
      sites.find((site) => {
        const pattern = site.hostname.toLowerCase();
        return hostname === pattern || hostname.endsWith('.' + pattern);
      }) ?? null
    );
  } catch (_) {
    return null;
  }
}

// ─── Notifications ────────────────────────────────────────────────────────────

function fireWarningNotification(site) {
  const windowDesc = site.windowHours === 24 ? '今日' : `${site.windowHours} 小时内`;
  chrome.notifications.create(`ttl_warn_${site.id}_${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    title: '⏰ 时间限额已用完',
    message: `${site.hostname} 的${windowDesc}使用时间（${site.limitMinutes} 分钟）已用完，标签页将在 2 分钟后关闭。`,
    priority: 2,
  });
}
