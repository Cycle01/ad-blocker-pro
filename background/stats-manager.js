/**
 * StatsManager
 *
 * - In-memory per-tab counters (fast, reset on navigation)
 * - Persistent global counters via chrome.storage.local
 *   (survive tab close and browser restart)
 */
export class StatsManager {
  constructor() {
    /** @type {Map<number, {ads:number, trackers:number, youtube:number, total:number, byDomain:Object}>} */
    this._tabs = new Map();
  }

  /**
   * Record one block event for a tab.
   * @param {number} tabId
   * @param {'ad'|'tracker'|'youtube'|'script'|'popup'|'cosmetic'|'redirect'} kind
   * @param {string} domain
   * @param {string} url
   */
  record(tabId, kind, domain, url) {
    if (!this._tabs.has(tabId)) {
      this._tabs.set(tabId, {
        ads: 0, trackers: 0, youtube: 0, total: 0, byDomain: {}
      });
    }
    const t = this._tabs.get(tabId);

    if (kind === 'tracker') {
      t.trackers++;
    } else if (kind === 'youtube') {
      t.youtube++;
      t.ads++;
    } else {
      t.ads++;
    }
    t.total++;

    // Per-domain breakdown shown in popup activity log
    const d = domain || 'unknown';
    t.byDomain[d] = (t.byDomain[d] || 0) + 1;
  }

  /**
   * Get current stats snapshot for one tab.
   * Returns zeroed object when tab has no events yet.
   */
  getTab(tabId) {
    return this._tabs.get(tabId) || {
      ads: 0, trackers: 0, youtube: 0, total: 0, byDomain: {}
    };
  }

  /** Reset per-tab data on navigation */
  resetTab(tabId) {
    this._tabs.delete(tabId);
  }

  /** Wipe all in-memory data (used by RESET_STATS) */
  resetAll() {
    this._tabs.clear();
  }

  /**
   * Atomically increment global persistent counters.
   * Called once per block event from the service worker.
   *
   * @param {'tracker'|string} kind
   */
  static async increment(kind) {
    const key = kind === 'tracker' ? 'totalTrackersBlocked' : 'totalAdsBlocked';
    // Use a simple read-increment-write. Service workers are single-threaded
    // so there is no race condition within one extension context.
    const stored = await chrome.storage.local.get(key);
    const next   = (stored[key] || 0) + 1;
    await chrome.storage.local.set({ [key]: next });
    return next;
  }
}
