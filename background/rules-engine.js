/**
 * RulesEngine
 * 
 * Manages dynamic declarativeNetRequest rules:
 *  - Custom user-defined rules (block/allow)
 *  - Whitelist (allow) rules
 *  - Aggressive mode extra rules
 * 
 * Static rules are defined in rules/*.json.
 * Dynamic rules are added at runtime via this engine.
 */

// Rule ID ranges:
//  100000–109999 : Whitelist (allow) rules
//  110000–119999 : Custom user block rules
//  120000–129999 : Aggressive mode rules
const WHITELIST_BASE    = 100000;
const CUSTOM_BASE       = 110000;
const AGGRESSIVE_BASE   = 120000;

/** Extra rules added in aggressive mode */
const AGGRESSIVE_RULES = [
  // Block all 3rd-party scripts
  {
    id: AGGRESSIVE_BASE + 1,
    priority: 3,
    action: { type: 'block' },
    condition: {
      resourceTypes: ['script'],
      domainType: 'thirdParty',
      excludedInitiatorDomains: [
        'google.com','youtube.com','github.com','stackoverflow.com',
        'wikipedia.org','reddit.com','twitter.com','x.com',
        'cloudflare.com','cdn.jsdelivr.net','unpkg.com',
        'cdnjs.cloudflare.com','ajax.googleapis.com'
      ]
    }
  },
  // Block WebSocket connections to known tracker domains
  {
    id: AGGRESSIVE_BASE + 2,
    priority: 3,
    action: { type: 'block' },
    condition: {
      urlFilter: '||hotjar.com^',
      resourceTypes: ['websocket']
    }
  },
  {
    id: AGGRESSIVE_BASE + 3,
    priority: 3,
    action: { type: 'block' },
    condition: {
      urlFilter: '||fullstory.com^',
      resourceTypes: ['websocket']
    }
  },
  // Block ping/XHR requests to analytics endpoints
  {
    id: AGGRESSIVE_BASE + 4,
    priority: 3,
    action: { type: 'block' },
    condition: {
      urlFilter: '*/collect?v=*tid=UA-*',
      resourceTypes: ['xmlhttprequest','ping','image']
    }
  },
  {
    id: AGGRESSIVE_BASE + 5,
    priority: 3,
    action: { type: 'block' },
    condition: {
      urlFilter: '*/collect?v=*tid=G-*',
      resourceTypes: ['xmlhttprequest','ping','image']
    }
  },
];

export class RulesEngine {
  /**
   * Load custom rules from storage and re-apply all dynamic rules.
   * Called on install, update, and periodic alarm.
   */
  async applyStoredCustomRules() {
    const {
      customRules    = [],
      whitelist      = [],
      aggressiveMode = false,
    } = await chrome.storage.local.get(['customRules','whitelist','aggressiveMode']);

    // Gather all dynamic rule IDs to remove first
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing.map(r => r.id);

    const addRules = [];

    // ── Whitelist rules ────────────────────────────────────────────────────
    whitelist.forEach((domain, i) => {
      addRules.push({
        id: WHITELIST_BASE + i,
        priority: 10, // Highest priority: allow overrides all blocks
        action: { type: 'allow' },
        condition: {
          initiatorDomains: [domain],
          resourceTypes: [
            'main_frame','sub_frame','script','image','xmlhttprequest',
            'stylesheet','font','media','object','csp_report',
            'ping','websocket','webtransport','webbundle','other'
          ]
        }
      });
    });

    // ── Custom user rules ──────────────────────────────────────────────────
    customRules.forEach((rule, i) => {
      const dnrRule = this._parseCustomRule(rule, CUSTOM_BASE + i);
      if (dnrRule) addRules.push(dnrRule);
    });

    // ── Aggressive mode extra rules ────────────────────────────────────────
    if (aggressiveMode) {
      addRules.push(...AGGRESSIVE_RULES);
    }

    // Apply all at once
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules,
    });

    console.log(`[RulesEngine] Applied ${addRules.length} dynamic rules (removed ${removeIds.length})`);
  }

  /**
   * Parse a user-defined custom rule into a DNR rule.
   * Supports:
   *   "||example.com^"      — block domain
   *   "@@||example.com^"    — allow/whitelist domain
   *   "/regex/"             — regex block
   */
  _parseCustomRule(rule, id) {
    if (!rule || !rule.pattern) return null;
    const pattern = rule.pattern.trim();
    const isAllow = pattern.startsWith('@@');
    const clean   = isAllow ? pattern.slice(2) : pattern;

    const dnr = {
      id,
      priority: isAllow ? 9 : 1,
      action: { type: isAllow ? 'allow' : 'block' },
      condition: {
        resourceTypes: rule.resourceTypes || [
          'main_frame','sub_frame','script','image','xmlhttprequest','object','media','font'
        ]
      }
    };

    if (clean.startsWith('/') && clean.endsWith('/')) {
      // Regex rule
      dnr.condition.regexFilter = clean.slice(1, -1);
    } else {
      // URL filter rule (EasyList-style anchors supported by DNR)
      dnr.condition.urlFilter = clean;
    }

    return dnr;
  }

  /**
   * Add a single custom rule and persist + re-apply.
   */
  async addCustomRule(rule) {
    const { customRules = [] } = await chrome.storage.local.get('customRules');
    rule.id = `rule_${Date.now()}`;
    customRules.push(rule);
    await chrome.storage.local.set({ customRules });
    await this.applyStoredCustomRules();
  }

  /**
   * Remove a custom rule by its user-assigned ID string.
   */
  async removeCustomRule(ruleId) {
    const { customRules = [] } = await chrome.storage.local.get('customRules');
    const updated = customRules.filter(r => r.id !== ruleId);
    await chrome.storage.local.set({ customRules: updated });
    await this.applyStoredCustomRules();
  }

  /** Get all custom rules from storage */
  async getCustomRules() {
    const { customRules = [] } = await chrome.storage.local.get('customRules');
    return customRules;
  }
}
