/**
 * AdBlock Pro — Options Page Script
 *
 * Manages all settings panels:
 *  - General toggles
 *  - Filter mode selection
 *  - Whitelist management
 *  - Custom rules management
 *  - Statistics display
 *  - Export / Import
 *  - Reset
 */

'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function msg(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, payload });
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(message, type = 'success') {
  const el = $('toast');
  el.textContent = message;
  el.className   = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2500);
}

// ── Tab Navigation ─────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const tabId = link.dataset.tab;

    // Update nav
    document.querySelectorAll('.nav-item').forEach(l => l.classList.remove('active'));
    link.classList.add('active');

    // Show tab
    document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
    $(`tab-${tabId}`).classList.add('active');

    // Load tab-specific data
    if (tabId === 'stats')     loadStats();
    if (tabId === 'whitelist') loadWhitelist();
    if (tabId === 'rules')     loadRules();
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const manifest = chrome.runtime.getManifest();
  const versionStr = `v${manifest.version}`;
  const vLabel = $('version-label');
  const aVer   = $('about-version');
  if (vLabel) vLabel.textContent = versionStr;
  if (aVer)   aVer.textContent   = versionStr;

  await loadSettings();
  bindEvents();
});

// ── Load & Render Settings ────────────────────────────────────────────────────
async function loadSettings() {
  const s = await msg('GET_SETTINGS');

  // General
  setToggle('s-enabled',     s.enabled         !== false);
  setToggle('s-cosmetic',    s.cosmeticFilter   !== false);
  setToggle('s-popups',      s.blockPopups      !== false);
  setToggle('s-redirect',    s.redirectProtect  !== false);
  setToggle('s-youtube',     s.youtubeBlock     !== false);
  setToggle('s-badge',       s.settings?.showBadge !== false);

  // Filtering
  setToggle('s-trackers',    s.blockTrackers    !== false);
  setToggle('s-scripts',     !!s.scriptBlocking);
  setToggle('s-fingerprint', s.antiFingerprint  !== false);
  setToggle('s-cookies',     !!s.cookieBlocking);

  // Mode radio
  const mode = s.aggressiveMode ? 'aggressive' : s.smartMode ? 'smart' : 'normal';
  const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);
  if (radio) radio.checked = true;

  // Status badge
  const badge = $('status-badge');
  if (s.enabled === false) {
    badge.classList.add('disabled');
    $('status-text').textContent = 'Paused';
  } else {
    badge.classList.remove('disabled');
    $('status-text').textContent = 'Active';
  }
}

function setToggle(id, value) {
  const el = $(id);
  if (el) el.checked = !!value;
}

// ── Bind Events ───────────────────────────────────────────────────────────────
function bindEvents() {
  // ── General toggles ────────────────────────────────────────────────────
  const toggleMap = {
    's-enabled':     'enabled',
    's-cosmetic':    'cosmeticFilter',
    's-popups':      'blockPopups',
    's-redirect':    'redirectProtect',
    's-youtube':     'youtubeBlock',
    's-trackers':    'blockTrackers',
    's-scripts':     'scriptBlocking',
    's-fingerprint': 'antiFingerprint',
    's-cookies':     'cookieBlocking',
  };

  Object.entries(toggleMap).forEach(([elId, settingKey]) => {
    const el = $(elId);
    if (!el) return;
    el.addEventListener('change', async () => {
      await msg('SET_SETTINGS', { [settingKey]: el.checked });

      // Update sidebar status badge for master toggle
      if (settingKey === 'enabled') {
        const badge = $('status-badge');
        if (el.checked) {
          badge.classList.remove('disabled');
          $('status-text').textContent = 'Active';
        } else {
          badge.classList.add('disabled');
          $('status-text').textContent = 'Paused';
        }
      }

      toast('Settings saved');
    });
  });

  // Badge setting (nested in settings object)
  const badgeEl = $('s-badge');
  if (badgeEl) {
    badgeEl.addEventListener('change', async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await msg('SET_SETTINGS', { settings: { ...settings, showBadge: badgeEl.checked } });
      toast('Settings saved');
    });
  }

  // ── Mode radio buttons ─────────────────────────────────────────────────
  document.querySelectorAll('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      const patch = {
        smartMode:       radio.value === 'smart',
        aggressiveMode:  radio.value === 'aggressive',
      };
      await msg('SET_SETTINGS', patch);
      toast(`${radio.value.charAt(0).toUpperCase() + radio.value.slice(1)} mode enabled`);
    });
  });

  // ── Whitelist ──────────────────────────────────────────────────────────
  $('btn-add-whitelist').addEventListener('click', addWhitelistEntry);
  $('whitelist-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addWhitelistEntry();
  });

  // ── Custom Rules ───────────────────────────────────────────────────────
  $('btn-add-rule').addEventListener('click', addCustomRule);
  $('rule-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addCustomRule();
  });

  // ── Stats ──────────────────────────────────────────────────────────────
  $('btn-reset-stats').addEventListener('click', async () => {
    if (!confirm('Reset all statistics? This cannot be undone.')) return;
    await msg('RESET_STATS', {});
    await loadStats();
    toast('Statistics reset');
  });

  // ── Advanced ───────────────────────────────────────────────────────────
  $('btn-export').addEventListener('click', exportSettings);
  $('btn-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', importSettings);

  $('btn-reset-all').addEventListener('click', async () => {
    if (!confirm('Reset ALL settings, rules, whitelist, and stats? This cannot be undone.')) return;
    await chrome.storage.local.clear();
    await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', payload: {
      enabled: true, smartMode: true, cosmeticFilter: true,
      antiFingerprint: true, blockTrackers: true,
      whitelist: [], customRules: [], blockLog: [],
      totalAdsBlocked: 0, totalTrackersBlocked: 0,
      settings: { theme: 'dark', showBadge: true }
    }});
    await loadSettings();
    toast('All settings reset to defaults');
  });
}

// ── Whitelist Management ──────────────────────────────────────────────────────
async function loadWhitelist() {
  const { whitelist } = await chrome.storage.local.get('whitelist');
  renderList('whitelist-list', whitelist || [], removeWhitelistEntry, 'domain');
}

async function addWhitelistEntry() {
  const input  = $('whitelist-input');
  const domain = input.value.trim().replace(/^https?:\/\//,'').replace(/\/.*/,'');
  if (!domain) return;

  const { whitelist = [] } = await chrome.storage.local.get('whitelist');
  if (whitelist.includes(domain)) {
    toast('Domain already whitelisted', 'error');
    return;
  }

  whitelist.push(domain);
  await chrome.storage.local.set({ whitelist });
  input.value = '';
  await loadWhitelist();
  toast(`${domain} whitelisted`);
}

async function removeWhitelistEntry(domain) {
  const { whitelist = [] } = await chrome.storage.local.get('whitelist');
  await chrome.storage.local.set({ whitelist: whitelist.filter(d => d !== domain) });
  await loadWhitelist();
  toast(`${domain} removed`);
}

// ── Custom Rules Management ───────────────────────────────────────────────────
async function loadRules() {
  const { rules } = await msg('GET_CUSTOM_RULES', {});
  renderList('rules-list', rules || [], removeRule, 'pattern');
}

async function addCustomRule() {
  const input   = $('rule-input');
  const pattern = input.value.trim();
  if (!pattern) return;

  await msg('ADD_CUSTOM_RULE', { pattern });
  input.value = '';
  await loadRules();
  toast('Rule added');
}

async function removeRule(ruleId) {
  await msg('REMOVE_CUSTOM_RULE', { id: ruleId });
  await loadRules();
  toast('Rule removed');
}

// ── Generic List Renderer ─────────────────────────────────────────────────────
function renderList(containerId, items, removeFn, displayKey) {
  const container = $(containerId);
  if (!container) return;

  if (!items || items.length === 0) {
    container.innerHTML = '<div class="empty-list">No entries</div>';
    return;
  }

  container.innerHTML = '';
  items.forEach(item => {
    const display = typeof item === 'string' ? item : item[displayKey] || JSON.stringify(item);
    const key     = typeof item === 'string' ? item : item.id || display;

    const row = document.createElement('div');
    row.className = 'list-item';
    row.innerHTML = `
      <span class="list-item-domain" title="${escapeHtml(display)}">${escapeHtml(display)}</span>
      <button class="list-item-remove" data-key="${escapeHtml(key)}" title="Remove">✕</button>
    `;
    row.querySelector('.list-item-remove').addEventListener('click', () => removeFn(key));
    container.appendChild(row);
  });
}

// ── Statistics ────────────────────────────────────────────────────────────────
async function loadStats() {
  const stats = await msg('GET_GLOBAL_STATS', {});
  const ads      = stats.totalAdsBlocked      || 0;
  const trackers = stats.totalTrackersBlocked  || 0;
  const total    = ads + trackers;

  $('gs-ads').textContent      = formatNumber(ads);
  $('gs-trackers').textContent = formatNumber(trackers);
  $('gs-total').textContent    = formatNumber(total);
}

// ── Export / Import ───────────────────────────────────────────────────────────
async function exportSettings() {
  const { data } = await msg('EXPORT_SETTINGS', {});
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `adblock-pro-settings-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Settings exported');
}

async function importSettings(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await msg('IMPORT_SETTINGS', { data });
    await loadSettings();
    toast('Settings imported successfully');
  } catch (err) {
    toast('Import failed — invalid file', 'error');
  }

  // Reset file input so the same file can be re-selected
  e.target.value = '';
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}
