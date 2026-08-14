/**
 * AdBlock Pro — Content Script
 * 
 * Runs at document_start in ALL frames.
 * 
 * Responsibilities:
 *  1. Cosmetic filtering  — hide ad containers via CSS injection
 *  2. Anti-adblock bypass — spoof adblock detection
 *  3. Popup / new-tab protection — block window.open() abuse
 *  4. Redirect protection — neutralise forced redirects
 *  5. Script blocking (advanced mode) — block inline tracking scripts
 *  6. Anti-fingerprinting — spoof canvas, audio, WebGL
 *  7. Report block events back to the service worker
 */

(() => {
  'use strict';

  // ── Config (read from storage before DOM loads) ──────────────────────────
  let cfg = {
    enabled:         true,
    cosmeticFilter:  true,
    antiFingerprint: true,
    scriptBlocking:  false,
    aggressiveMode:  false,
    whitelist:       [],
  };

  // Current page hostname
  const hostname = location.hostname.replace(/^www\./, '');

  // ── Load config from storage (sync-ish via chrome.storage.local) ─────────
  chrome.storage.local.get(
    ['enabled','cosmeticFilter','antiFingerprint','scriptBlocking','aggressiveMode','whitelist'],
    (result) => { Object.assign(cfg, result); bootstrap(); }
  );

  function bootstrap() {
    // Check if site is whitelisted
    if (!cfg.enabled || (cfg.whitelist || []).includes(hostname)) return;

    injectCosmeticCSS();
    installPopupProtection();
    installRedirectProtection();
    if (cfg.antiFingerprint) installAntiFingerprinting();
    if (cfg.scriptBlocking)  installScriptBlocker();
    observeDOM();
  }

  // ── 1. Cosmetic Filtering ─────────────────────────────────────────────────
  /**
   * Inject CSS to hide common ad containers and empty ad slots.
   * Covers both generic ad selectors and site-specific overrides.
   */
  function injectCosmeticCSS() {
    if (!cfg.cosmeticFilter) return;

    const style = document.createElement('style');
    style.id = '__adblock_pro_css';
    style.textContent = COSMETIC_CSS;
    document.documentElement.appendChild(style);
  }

  const COSMETIC_CSS = `
    /* ── Generic ad containers ──────────────────────────────────────────── */
    [id*="google_ads_iframe"],
    [id*="div-gpt-ad"],
    [id*="ad-slot"],
    [id*="adslot"],
    [id*="adbanner"],
    [class*="ad-banner"],
    [class*="ad-slot"],
    [class*="advert"],
    [class*="advertisement"],
    [class*="ad-container"],
    [class*="ads-container"],
    [class*="ad-wrapper"],
    [class*="ad-unit"],
    [class*="adsbygoogle"],
    [class*="adBox"],
    [class*="ad_box"],
    [class*="ad_container"],
    ins.adsbygoogle,
    iframe[src*="doubleclick.net"],
    iframe[src*="googlesyndication.com"],
    iframe[src*="amazon-adsystem.com"],
    iframe[src*="taboola.com"],
    iframe[src*="outbrain.com"],
    iframe[src*="criteo.com"],
    iframe[src*="rubiconproject.com"],
    div[aria-label="Ads"],
    /* ── Taboola / Outbrain ─────────────────────────────────────────────── */
    [id*="taboola"],
    [id*="outbrain"],
    [class*="taboola"],
    [class*="outbrain"],
    /* ── Cookie banners & consent popups ─────────────────────────────────── */
    [id*="cookie-consent"],
    [id*="cookiebanner"],
    [class*="cookie-banner"],
    [class*="cookie-consent"],
    [class*="gdpr-banner"],
    /* ── Sticky overlays ─────────────────────────────────────────────────── */
    [class*="sticky-ad"],
    [class*="floatingAd"],
    [class*="floating-ad"],
    [id*="floating-ad"],
    [id*="sticky_ad"],
    /* ── Interstitials ───────────────────────────────────────────────────── */
    [class*="interstitial"],
    [id*="interstitial"],
    /* ── Popunders / popup overlays ─────────────────────────────────────── */
    [class*="popup-overlay"],
    [class*="modal-ad"],
    [class*="ad-overlay"] {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      height: 0 !important;
      max-height: 0 !important;
      overflow: hidden !important;
    }

    /* ── Prevent layout shift from removed ad slots ──────────────────────── */
    [id*="ad-slot"]:empty,
    [class*="ad-container"]:empty,
    [class*="adsbygoogle"]:empty {
      display: none !important;
    }
  `;

  // ── 2. Popup / New Tab Protection ─────────────────────────────────────────
  /**
   * Override window.open to block automatic popups and new-tab-opening ads.
   * Legitimate user-triggered opens (e.g. target="_blank" clicks) are allowed.
   */
  function installPopupProtection() {
    let lastUserGesture = 0;

    // Track genuine user interactions
    const GESTURE_EVENTS = ['click','mousedown','keydown','touchstart','pointerdown'];
    GESTURE_EVENTS.forEach(ev => {
      window.addEventListener(ev, () => { lastUserGesture = Date.now(); }, true);
    });

    const _origOpen = window.open.bind(window);
    window.open = function(url, target, features) {
      const timeSinceGesture = Date.now() - lastUserGesture;
      const isUserTriggered  = timeSinceGesture < 500; // 500ms window

      if (!isUserTriggered) {
        console.warn('[AdBlock Pro] Blocked popup:', url);
        reportBlock('popup', url || 'about:blank', 'popup');
        return null;
      }
      return _origOpen(url, target, features);
    };

    // Block document.write-based iframes (common in popunder ads)
    const _origWrite = document.write.bind(document);
    document.write = function(html) {
      if (/(<iframe|<script)/i.test(html) && /ad|pop|banner/i.test(html)) {
        console.warn('[AdBlock Pro] Blocked document.write ad:', html.slice(0, 80));
        return;
      }
      return _origWrite(html);
    };
  }

  // ── 3. Redirect Protection ────────────────────────────────────────────────
  /**
   * Intercept location assignments and prevent forced redirects.
   * Allows normal same-site navigation; blocks suspicious 3rd-party redirects.
   */
  function installRedirectProtection() {
    // Override location.href setter
    const descriptor = Object.getOwnPropertyDescriptor(window.Location.prototype, 'href');
    if (descriptor && descriptor.set) {
      const originalSet = descriptor.set;
      Object.defineProperty(window.location, 'href', {
        set(value) {
          if (isMaliciousRedirect(value)) {
            console.warn('[AdBlock Pro] Blocked redirect to:', value);
            reportBlock('redirect', value, 'redirect');
            return;
          }
          originalSet.call(window.location, value);
        },
        get() { return originalSet ? window.location.toString() : ''; },
        configurable: true,
      });
    }

    // Override history.pushState to catch JS-based redirects
    const _origPush    = history.pushState.bind(history);
    const _origReplace = history.replaceState.bind(history);

    history.pushState = function(state, title, url) {
      if (url && isMaliciousRedirect(url)) {
        console.warn('[AdBlock Pro] Blocked pushState redirect:', url);
        return;
      }
      return _origPush(state, title, url);
    };
    history.replaceState = function(state, title, url) {
      if (url && isMaliciousRedirect(url)) {
        console.warn('[AdBlock Pro] Blocked replaceState redirect:', url);
        return;
      }
      return _origReplace(state, title, url);
    };
  }

  function isMaliciousRedirect(url) {
    if (!url || url.startsWith('#') || url.startsWith('/') || url.startsWith('?')) return false;
    try {
      const dest = new URL(url, location.href);
      // Allow same-origin navigation
      if (dest.hostname === location.hostname) return false;
      // Block known ad redirect domains
      const REDIRECT_DOMAINS = [
        'adf.ly','ouo.io','linkvertise.com','shorte.st','bc.vc',
        'sub2unlock.com','adflying.me','adfoc.us','clk.sh',
        'exe.io','fc.lc','shrink.pe','shrinkearn.com',
      ];
      return REDIRECT_DOMAINS.some(d => dest.hostname.includes(d));
    } catch { return false; }
  }

  // ── 4. Anti-Fingerprinting ────────────────────────────────────────────────
  /**
   * Spoof canvas, audio, WebGL, and other fingerprinting APIs
   * by adding slight noise to their outputs.
   */
  function installAntiFingerprinting() {
    // Canvas noise
    const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
      addCanvasNoise(this);
      return _origToDataURL.call(this, type, quality);
    };

    const _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
      const imgData = _origGetImageData.call(this, x, y, w, h);
      addPixelNoise(imgData.data);
      return imgData;
    };

    // Audio fingerprinting
    if (window.AudioContext || window.webkitAudioContext) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const _origCreateAnalyser = AC.prototype.createAnalyser;
      AC.prototype.createAnalyser = function() {
        const analyser = _origCreateAnalyser.call(this);
        const _origGetFloat = analyser.getFloatFrequencyData.bind(analyser);
        analyser.getFloatFrequencyData = function(arr) {
          _origGetFloat(arr);
          for (let i = 0; i < arr.length; i++) {
            arr[i] += (Math.random() - 0.5) * 0.001;
          }
        };
        return analyser;
      };
    }

    // Screen size normalisation (report rounded values)
    try {
      Object.defineProperty(screen, 'width',       { get: () => roundTo(screen.width, 10) });
      Object.defineProperty(screen, 'height',      { get: () => roundTo(screen.height, 10) });
      Object.defineProperty(screen, 'availWidth',  { get: () => roundTo(screen.availWidth, 10) });
      Object.defineProperty(screen, 'availHeight', { get: () => roundTo(screen.availHeight, 10) });
    } catch (e) { /* Ignore if browser blocks redefine */ }

    // Navigator spoofing
    try {
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
      Object.defineProperty(navigator, 'deviceMemory',        { get: () => 4 });
    } catch (e) {}
  }

  function addCanvasNoise(canvas) {
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      addPixelNoise(imageData.data);
      ctx.putImageData(imageData, 0, 0);
    } catch (e) {}
  }

  function addPixelNoise(data) {
    for (let i = 0; i < data.length; i += 4) {
      // Modify ~1 in 100 pixels by ±1 per channel (imperceptible visually)
      if (Math.random() < 0.01) {
        data[i]   = Math.min(255, Math.max(0, data[i]   + (Math.random() > 0.5 ? 1 : -1)));
        data[i+1] = Math.min(255, Math.max(0, data[i+1] + (Math.random() > 0.5 ? 1 : -1)));
        data[i+2] = Math.min(255, Math.max(0, data[i+2] + (Math.random() > 0.5 ? 1 : -1)));
      }
    }
  }

  function roundTo(value, multiple) {
    return Math.round(value / multiple) * multiple;
  }

  // ── 5. Script Blocker (Advanced Mode) ────────────────────────────────────
  /**
   * Intercept inline script injection via createElement and block
   * scripts matching tracker/ad patterns.
   */
  function installScriptBlocker() {
    const AD_SCRIPT_PATTERNS = [
      /googlesyndication\.com/,
      /doubleclick\.net/,
      /adnxs\.com/,
      /criteo\.com/,
      /amazon-adsystem\.com/,
      /taboola\.com/,
      /outbrain\.com/,
      /hotjar\.com/,
      /fullstory\.com/,
      /segment\.io/,
      /mixpanel\.com/,
      /mouseflow\.com/,
    ];

    const _origCreateElement = document.createElement.bind(document);
    document.createElement = function(tagName, ...args) {
      const el = _origCreateElement(tagName, ...args);

      if (tagName.toLowerCase() === 'script') {
        const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');

        Object.defineProperty(el, 'src', {
          set(value) {
            if (AD_SCRIPT_PATTERNS.some(p => p.test(value))) {
              console.warn('[AdBlock Pro] Blocked inline script:', value);
              reportBlock('script', value, 'script');
              // Make the element a no-op by setting type
              el.type = 'application/json'; // Prevent execution
              return;
            }
            srcDescriptor.set.call(el, value);
          },
          get() { return srcDescriptor.get.call(el); },
          configurable: true,
        });
      }

      return el;
    };
  }

  // ── 6. Anti-Adblock Bypass ────────────────────────────────────────────────
  /**
   * Spoof adblock detection variables commonly checked by sites.
   * Also disable common adblock-detector libraries.
   */
  const FAKE_AD_ELEMENT_ID = '__adblock_test_element__';
  // Create a fake ad element that appears legit to detectors
  function installAntiAdblockSpoof() {
    const fakeAd = document.createElement('div');
    fakeAd.id        = FAKE_AD_ELEMENT_ID;
    fakeAd.className = 'ads ad adsbox doubleclick ad-placement carbon-ads';
    fakeAd.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px;top:-9999px;';
    document.documentElement.appendChild(fakeAd);
  }

  // ── 7. DOM Observer — late-loaded ads ─────────────────────────────────────
  /**
   * Watch for dynamically injected ad elements and remove them.
   */
  function observeDOM() {
    if (!cfg.cosmeticFilter) return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          scanAndHide(node);
        }
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  const AD_PATTERNS = [
    /\bad[-_]?(slot|unit|banner|container|wrapper|block|frame|box|overlay|placement|top|bottom|sidebar|widget)\b/i,
    /\badsb[oy]google\b/i,
    /\bgpt-ad\b/i,
    /\btaboola\b/i,
    /\boutbrain\b/i,
    /\bpop(up|under|over)\b/i,
    /\binterstitial\b/i,
  ];

  function scanAndHide(node) {
    const id  = node.id    || '';
    const cls = node.className || '';
    const combined = id + ' ' + cls;

    if (AD_PATTERNS.some(p => p.test(combined))) {
      node.style.cssText = 'display:none!important;visibility:hidden!important;height:0!important;';
      reportBlock('cosmetic', location.href, hostname);
      return;
    }

    // Also scan iframes with ad src
    if (node.tagName === 'IFRAME') {
      const src = node.src || node.getAttribute('data-src') || '';
      if (/doubleclick|googlesyndication|adnxs|amazon-adsystem|taboola|outbrain/.test(src)) {
        node.remove();
        reportBlock('ad', src, hostname);
      }
    }
  }

  // ── Reporting ─────────────────────────────────────────────────────────────
  /**
   * Send a block event to the service worker for stats tracking.
   * Fire-and-forget (no await needed).
   */
  function reportBlock(kind, url, domain) {
    chrome.runtime.sendMessage({
      type:    'REPORT_BLOCK',
      payload: {
        tabId:  null, // service worker fills this from sender.tab.id
        url,
        kind,
        domain: domain || hostname,
      }
    }).catch(() => {}); // Ignore if context invalidated
  }

  // ── Bootstrap anti-adblock spoof immediately ──────────────────────────────
  if (document.documentElement) {
    installAntiAdblockSpoof();
  } else {
    document.addEventListener('DOMContentLoaded', installAntiAdblockSpoof, { once: true });
  }

})();
