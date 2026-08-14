/**
 * AdBlock Pro — Service Worker (Background Script)
 * 
 * Handles:
 *  - Dynamic declarativeNetRequest rule management
 *  - Per-tab statistics tracking
 *  - Whitelist / per-site toggle management
 *  - Alarm-based filter list refresh
 *  - Message routing between popup, options, and content scripts
 */

import { StatsManager } from './stats-manager.js';
import { RulesEngine }  from './rules-engine.js';

// ─── Initialization ───────────────────────────────────────────────────────────

const stats   = new StatsManager();
const rules   = new RulesEngine();

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[AdBlock Pro] Installed/Updated:', details.reason);

  // Set default settings on first install
  if (details.reason === 'install') {
    await chrome.storage.local.set({
      enabled:         true,
      aggressiveMode:  false,
      smartMode:       true,
      scriptBlocking:  false,
      cosmeticFilter:  true,
      antiFingerprint: true,
      cookieBlocking:  false,
      whitelist:       [],
      customRules:     [],
      blockLog:        [],
      totalAdsBlocked: 0,
      totalTrackersBlocked: 0,
      settings: {
        theme: 'dark',
        showBadge: true,
        notifyOnBlock: false,
      }
    });
  }

  // Apply any stored custom rules
  await rules.applyStoredCustomRules();
  console.log('[AdBlock Pro] Ready.');
});

// ─── Tab Badge Counter ────────────────────────────────────────────────────────

/**
 * Update the extension badge with the per-tab block count.
 * Called whenever a content script reports a block event.
 */
async function updateBadge(tabId, count) {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings?.showBadge) return;

  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#e74c3c', tabId });
}

// Reset badge when navigating to a new page
chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId }) => {
  if (frameId !== 0) return; // Only top-level frames
  stats.resetTab(tabId);
  updateBadge(tabId, 0);
});

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    console.error('[AdBlock Pro] Message error:', err);
    sendResponse({ error: err.message });
  });
  return true; // Keep message channel open for async response
});

async function handleMessage(message, sender) {
  const { type, payload } = message;

  switch (type) {

    // ── Stats reporting from content scripts ──────────────────────────────────
    case 'REPORT_BLOCK': {
      const { url, kind, domain } = payload;
      // Always use the real tab ID from the sender — payload.tabId is null
      const tabId = sender?.tab?.id;
      if (!tabId) return { ok: true }; // background page or unknown sender

      stats.record(tabId, kind, domain, url);

      // Increment persistent global counters
      await StatsManager.increment(kind);

      const tabStats = stats.getTab(tabId);
      await updateBadge(tabId, tabStats.total);

      // Append to block log (capped at 500 entries)
      appendToLog({ tabId, url, kind, domain, ts: Date.now() });

      return { ok: true };
    }

    // ── Popup requests stats for active tab ──────────────────────────────────
    case 'GET_TAB_STATS': {
      const { tabId } = payload;
      return stats.getTab(tabId);
    }

    // ── Popup requests global stats ──────────────────────────────────────────
    case 'GET_GLOBAL_STATS': {
      const stored = await chrome.storage.local.get(['totalAdsBlocked','totalTrackersBlocked']);
      return stored;
    }

    // ── Toggle extension on/off for a specific domain ─────────────────────────
    case 'TOGGLE_SITE': {
      const { domain, enabled } = payload;
      await toggleSiteWhitelist(domain, enabled);
      return { ok: true };
    }

    // ── Check if site is whitelisted ──────────────────────────────────────────
    case 'IS_WHITELISTED': {
      const { domain } = payload;
      return { whitelisted: await isSiteWhitelisted(domain) };
    }

    // ── Add a custom blocking rule ────────────────────────────────────────────
    case 'ADD_CUSTOM_RULE': {
      await rules.addCustomRule(payload);
      return { ok: true };
    }

    // ── Remove a custom rule ──────────────────────────────────────────────────
    case 'REMOVE_CUSTOM_RULE': {
      await rules.removeCustomRule(payload.id);
      return { ok: true };
    }

    // ── Get list of custom rules ──────────────────────────────────────────────
    case 'GET_CUSTOM_RULES': {
      return { rules: await rules.getCustomRules() };
    }

    // ── Get block log ─────────────────────────────────────────────────────────
    case 'GET_BLOCK_LOG': {
      const { blockLog } = await chrome.storage.local.get('blockLog');
      return { log: blockLog || [] };
    }

    // ── Clear block log ───────────────────────────────────────────────────────
    case 'CLEAR_BLOCK_LOG': {
      await chrome.storage.local.set({ blockLog: [] });
      return { ok: true };
    }

    // ── Get/Set global settings ───────────────────────────────────────────────
    case 'GET_SETTINGS': {
      return chrome.storage.local.get(null); // Return everything
    }
    case 'SET_SETTINGS': {
      await chrome.storage.local.set(payload);
      // Re-apply rules if aggressive mode changed
      if ('aggressiveMode' in payload || 'scriptBlocking' in payload) {
        await rules.applyStoredCustomRules();
      }
      return { ok: true };
    }

    // ── Export / Import settings ──────────────────────────────────────────────
    case 'EXPORT_SETTINGS': {
      const data = await chrome.storage.local.get(null);
      return { data };
    }
    case 'IMPORT_SETTINGS': {
      await chrome.storage.local.set(payload.data);
      await rules.applyStoredCustomRules();
      return { ok: true };
    }

    // ── Reset all stats ───────────────────────────────────────────────────────
    case 'RESET_STATS': {
      stats.resetAll();
      await chrome.storage.local.set({
        totalAdsBlocked: 0,
        totalTrackersBlocked: 0,
        blockLog: []
      });
      return { ok: true };
    }

    default:
      return { error: 'Unknown message type: ' + type };
  }
}

// ─── Whitelist Helpers ────────────────────────────────────────────────────────

async function isSiteWhitelisted(domain) {
  const { whitelist } = await chrome.storage.local.get('whitelist');
  return (whitelist || []).includes(domain);
}

async function toggleSiteWhitelist(domain, shouldEnable) {
  const { whitelist } = await chrome.storage.local.get('whitelist');
  const list = whitelist || [];

  if (shouldEnable) {
    // Remove from whitelist (re-enable blocking)
    const updated = list.filter(d => d !== domain);
    await chrome.storage.local.set({ whitelist: updated });
  } else {
    // Add to whitelist (disable blocking for this site)
    if (!list.includes(domain)) list.push(domain);
    await chrome.storage.local.set({ whitelist: list });
  }
}

// ─── Block Log ────────────────────────────────────────────────────────────────

async function appendToLog(entry) {
  const { blockLog } = await chrome.storage.local.get('blockLog');
  const log = blockLog || [];
  log.unshift(entry);
  if (log.length > 500) log.length = 500; // Cap at 500 entries
  await chrome.storage.local.set({ blockLog: log });
}

// ─── Periodic filter update (every 24h) ──────────────────────────────────────

chrome.alarms.create('filter-refresh', { periodInMinutes: 24 * 60 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'filter-refresh') {
    console.log('[AdBlock Pro] Refreshing dynamic rules...');
    await rules.applyStoredCustomRules();
  }
});
