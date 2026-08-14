/**
 * AdBlock Pro — Popup Script (plain script, no ES modules)
 */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
var currentTab    = null;
var currentDomain = '';
var pollTimer     = null;
var lastCounts    = {};   // { ads: 0, trackers: 0, yt: 0 }
var lastFeedKey   = '';

// ── DOM ───────────────────────────────────────────────────────────────────────
function $id(id) { return document.getElementById(id); }
var D = {
  app:         $id('app'),
  shieldBtn:   $id('shield-btn'),
  statusText:  $id('status-text'),
  statusPulse: $id('status-pulse'),
  sCheck:      $id('s-check'),
  sX:          $id('s-x'),
  hostname:    $id('site-hostname'),
  fav:         $id('fav'),
  numAds:      $id('num-ads'),
  numTrackers: $id('num-trackers'),
  numYt:       $id('num-yt'),
  globalTotal: $id('global-total'),
  modeSmart:   $id('mode-smart'),
  modeAggr:    $id('mode-aggressive'),
  modeScript:  $id('mode-script'),
  feed:        $id('feed'),
  btnSettings: $id('btn-settings'),
  btnLog:      $id('btn-log'),
  drawer:      $id('drawer'),
  logList:     $id('log-list'),
  btnClose:    $id('btn-close-log'),
  btnClear:    $id('btn-clear-log'),
};

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    currentTab    = tabs[0];
    currentDomain = currentTab ? extractDomain(currentTab.url) : '';
    renderSite();

    Promise.all([
      msg('GET_SETTINGS',     {}),
      msg('IS_WHITELISTED',   { domain: currentDomain }),
      msg('GET_TAB_STATS',    { tabId: currentTab ? currentTab.id : -1 }),
      msg('GET_GLOBAL_STATS', {}),
    ]).then(function (r) {
      var settings    = r[0] || {};
      var wl          = r[1] || {};
      var tabStats    = r[2] || {};
      var globalStats = r[3] || {};

      setShield(!wl.whitelisted);
      applyModes(settings);
      renderStats(tabStats, globalStats);
    });

    pollTimer = setInterval(poll, 950);
  });

  bindEvents();
});

window.addEventListener('unload', function () { clearInterval(pollTimer); });

// ── Site Info ─────────────────────────────────────────────────────────────────
function renderSite() {
  if (!currentDomain) { D.hostname.textContent = '—'; return; }
  D.hostname.textContent = currentDomain;

  var img   = new Image();
  img.onload = function () {
    D.fav.src          = img.src;
    D.fav.style.display = 'inline-block';
  };
  img.src = 'https://www.google.com/s2/favicons?domain=' + currentDomain + '&sz=32';
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch (_) { return ''; }
}

// ── Shield State ──────────────────────────────────────────────────────────────
/**
 * protected = true  → class "on",  green shield, checkmark, "PROTECTED"
 * protected = false → class "off", grey shield,  X,         "DISABLED"
 */
function setShield(isProtected) {
  D.app.classList.toggle('on',  isProtected);
  D.app.classList.toggle('off', !isProtected);
  D.statusText.textContent = isProtected ? 'PROTECTED' : 'DISABLED';
}

// ── Poll ──────────────────────────────────────────────────────────────────────
function poll() {
  Promise.all([
    msg('GET_TAB_STATS',    { tabId: currentTab ? currentTab.id : -1 }),
    msg('GET_GLOBAL_STATS', {}),
  ]).then(function (r) { renderStats(r[0] || {}, r[1] || {}); });
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats(tab, global) {
  tick(D.numAds,      'ads',      tab.ads      || 0);
  tick(D.numTrackers, 'trackers', tab.trackers  || 0);
  tick(D.numYt,       'yt',       tab.youtube   || 0);

  var total = (global.totalAdsBlocked || 0) + (global.totalTrackersBlocked || 0);
  D.globalTotal.textContent = fmt(total);

  renderFeed(tab.byDomain || {});
}

function tick(el, key, val) {
  var prev = lastCounts[key] || 0;
  if (prev === val) return;
  lastCounts[key]  = val;
  el.textContent   = fmt(val);
  if (val > prev) {
    el.classList.add('pop');
    setTimeout(function () { el.classList.remove('pop'); }, 280);
  }
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// ── Feed ──────────────────────────────────────────────────────────────────────
function renderFeed(byDomain) {
  var entries = Object.keys(byDomain)
    .map(function (d) { return { d: d, n: byDomain[d] }; })
    .sort(function (a, b) { return b.n - a.n; })
    .slice(0, 12);

  var key = JSON.stringify(entries);
  if (key === lastFeedKey) return;
  lastFeedKey = key;

  D.feed.innerHTML = '';
  if (!entries.length) {
    D.feed.innerHTML = '<div class="feed-empty">No activity on this page</div>';
    return;
  }
  entries.forEach(function (e) {
    var row        = document.createElement('div');
    row.className  = 'feed-row';
    row.innerHTML  =
      '<span class="feed-tag ad">AD</span>' +
      '<span class="feed-domain">' + esc(e.d) + '</span>' +
      '<span class="feed-count">×' + e.n + '</span>';
    D.feed.appendChild(row);
  });
}

// ── Modes ─────────────────────────────────────────────────────────────────────
function applyModes(s) {
  D.modeSmart.classList.toggle('on',  !!s.smartMode);
  D.modeAggr.classList.toggle('on',   !!s.aggressiveMode);
  D.modeScript.classList.toggle('on', !!s.scriptBlocking);
}

function toggleMode(mode) {
  msg('GET_SETTINGS', {}).then(function (s) {
    var patch = {};
    if (mode === 'smart') {
      patch.smartMode = !s.smartMode;
    } else if (mode === 'aggressive') {
      patch.aggressiveMode = !s.aggressiveMode;
      if (patch.aggressiveMode) patch.smartMode = false;
    } else {
      patch.scriptBlocking = !s.scriptBlocking;
    }
    msg('SET_SETTINGS', patch).then(function () {
      applyModes(Object.assign({}, s, patch));
    });
  });
}

// ── Log Drawer ────────────────────────────────────────────────────────────────
function openDrawer() {
  msg('GET_BLOCK_LOG', {}).then(function (res) {
    var log = (res || {}).log || [];
    renderLog(log);
    D.drawer.classList.add('open');
  });
}

function renderLog(log) {
  if (!log.length) {
    D.logList.innerHTML = '<div class="feed-empty">No entries</div>';
    return;
  }
  D.logList.innerHTML = '';
  log.forEach(function (e) {
    var row       = document.createElement('div');
    row.className = 'log-row';
    var t         = new Date(e.ts).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    row.innerHTML =
      '<span class="log-tag ' + esc(e.kind) + '">' + esc(e.kind).toUpperCase() + '</span>' +
      '<span class="log-url" title="' + esc(e.url) + '">' + esc(trunc(e.url, 40)) + '</span>' +
      '<span class="log-time">' + t + '</span>';
    D.logList.appendChild(row);
  });
}

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  // Shield toggle
  D.shieldBtn.addEventListener('click', function () {
    var nowOn = D.app.classList.contains('on');
    // nowOn = currently protected → clicking disables (adds to whitelist)
    msg('TOGGLE_SITE', { domain: currentDomain, enabled: !nowOn }).then(function () {
      setShield(!nowOn);
    });
  });

  D.modeSmart.addEventListener('click',  function () { toggleMode('smart'); });
  D.modeAggr.addEventListener('click',   function () { toggleMode('aggressive'); });
  D.modeScript.addEventListener('click', function () { toggleMode('script'); });

  D.btnSettings.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  D.btnLog.addEventListener('click',   openDrawer);
  D.btnClose.addEventListener('click', function () { D.drawer.classList.remove('open'); });
  D.btnClear.addEventListener('click', function () {
    msg('CLEAR_BLOCK_LOG', {}).then(function () {
      D.logList.innerHTML = '<div class="feed-empty">No entries</div>';
    });
  });
}

// ── Messaging ─────────────────────────────────────────────────────────────────
function msg(type, payload) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage({ type: type, payload: payload || {} }, function (res) {
      resolve(res || {});
    });
  });
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function trunc(url, max) {
  if (!url) return '';
  try {
    var u = new URL(url);
    var s = u.hostname + u.pathname;
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch (_) {
    return url.length > max ? url.slice(0, max) + '…' : url;
  }
}
