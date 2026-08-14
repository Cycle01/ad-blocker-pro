/**
 * AdBlock Pro — YouTube Ad Blocker
 * 
 * Injected only on youtube.com pages.
 * 
 * Strategies:
 *  1. Auto-click "Skip Ad" button as soon as it appears
 *  2. Remove ad overlay containers from the player
 *  3. Mute and fast-forward video ads
 *  4. Remove sponsored card overlays and info cards
 *  5. Remove homepage / sidebar ad cards
 *  6. Intercept ytInitialPlayerResponse to strip ad data (best-effort)
 */
(() => {
  'use strict';

  // ── Selectors ─────────────────────────────────────────────────────────────

  const SKIP_BTN_SELECTORS = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '[class*="skip-ad"]',
    '[class*="skipAd"]',
  ];

  const AD_OVERLAY_SELECTORS = [
    '.ytp-ad-module',
    '.ytp-ad-overlay-container',
    '.ytp-ad-overlay-slot',
    '.ytp-ad-image-overlay',
    '.ytp-ad-text-overlay',
    '.ytp-ad-player-overlay',
    '.ytp-ad-player-overlay-instream-info',
    '.ytp-ad-action-interstitial',
    '.ytp-ad-persistent-progress-bar-container',
    '.ytp-ad-progress',
    '.ytp-ad-progress-list',
    '.video-ads.ytp-ad-module',
    '.ytp-ad-feedback-dialog-container',
    '.ytp-suggested-action',
    'ytd-player-legacy-desktop-watch-ads-renderer',
  ];

  const HOMEPAGE_AD_SELECTORS = [
    'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-video-renderer',
    'ytd-display-ad-renderer',
    'ytd-compact-promoted-video-renderer',
    'ytd-statement-banner-renderer',
    'ytd-brand-video-shelf-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-ad-slot-renderer',
    'yt-mealbar-promo-renderer',
    '#masthead-ad',
    '.ytd-banner-promo-renderer',
    'ytd-merch-shelf-renderer',
    'ytd-banner-promo-renderer',
    '#player-ads',
  ];

  // ── Main Loop ─────────────────────────────────────────────────────────────

  let lastSkipAttempt = 0;

  /**
   * Core ad removal function. Called frequently to catch dynamically injected ads.
   */
  function removeAds() {
    const now = Date.now();

    // 1. Skip ad button (throttled to every 300ms to save CPU)
    if (now - lastSkipAttempt > 300) {
      lastSkipAttempt = now;
      for (const selector of SKIP_BTN_SELECTORS) {
        const btn = document.querySelector(selector);
        if (btn) {
          btn.click();
          reportYouTubeBlock('skip-button');
          break;
        }
      }
    }

    // 2. Fast-forward video ads (set currentTime to near end)
    const video = document.querySelector('video');
    if (video && isAdPlaying()) {
      // Mute ad immediately
      if (!video.muted) video.muted = true;
      // Try to skip to end so "Skip" button appears sooner
      if (video.duration && video.currentTime < video.duration - 0.5) {
        video.currentTime = video.duration - 0.5;
        reportYouTubeBlock('fast-forward');
      }
    }

    // 3. Remove ad overlay HTML elements
    for (const selector of AD_OVERLAY_SELECTORS) {
      document.querySelectorAll(selector).forEach(el => {
        el.style.display = 'none';
      });
    }

    // 4. Remove homepage / sidebar ads
    for (const selector of HOMEPAGE_AD_SELECTORS) {
      document.querySelectorAll(selector).forEach(el => {
        el.remove();
        reportYouTubeBlock('element-removed');
      });
    }

    // 5. Remove sponsored cards
    document.querySelectorAll('.ytp-ad-overlay-container, .ytp-cards-teaser').forEach(el => {
      el.style.display = 'none';
    });
  }

  /**
   * Detect if a video ad is currently playing.
   */
  function isAdPlaying() {
    return !!(
      document.querySelector('.ad-showing') ||
      document.querySelector('.ytp-ad-player-overlay') ||
      document.querySelector('.ytp-ad-progress')
    );
  }

  // ── Intercept ytInitialPlayerResponse ────────────────────────────────────
  /**
   * Best-effort: patch the global ytInitialPlayerResponse to strip ad data
   * before YouTube's JS reads it.
   */
  function patchPlayerResponse() {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        'use strict';
        // Intercept ytInitialPlayerResponse assignment
        let _response = window.ytInitialPlayerResponse;
        Object.defineProperty(window, 'ytInitialPlayerResponse', {
          get() { return _response; },
          set(val) {
            if (val && val.adPlacements) {
              val.adPlacements = [];
              console.log('[AdBlock Pro] Stripped adPlacements from ytInitialPlayerResponse');
            }
            if (val && val.playerAds) {
              val.playerAds = [];
            }
            _response = val;
          },
          configurable: true,
        });

        // Also intercept yt.config_ if available
        try {
          if (window.yt && window.yt.config_) {
            const cfg = window.yt.config_;
            if (cfg.EXPERIMENT_FLAGS) {
              cfg.EXPERIMENT_FLAGS.web_enable_ab_ads = false;
              cfg.EXPERIMENT_FLAGS.web_ads_enabled   = false;
            }
          }
        } catch(e) {}
      })();
    `;
    // Inject into page context (before any YouTube scripts run)
    (document.head || document.documentElement).prepend(script);
    script.remove();
  }

  // ── Observer ──────────────────────────────────────────────────────────────

  /**
   * MutationObserver for efficient detection of dynamically added ad elements.
   */
  function startObserver() {
    const observer = new MutationObserver(() => removeAds());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /**
   * Also poll at 500ms intervals as a fallback (YouTube's SPA navigation
   * can sometimes outpace the observer).
   */
  function startPoller() {
    setInterval(removeAds, 500);
  }

  // ── YouTube SPA Navigation ────────────────────────────────────────────────
  /**
   * YouTube is a Single Page Application.
   * Re-run ad removal on each navigation (yt-navigate-finish event).
   */
  document.addEventListener('yt-navigate-finish', removeAds);
  document.addEventListener('yt-page-data-updated', removeAds);

  // ── Reporting ─────────────────────────────────────────────────────────────

  function reportYouTubeBlock(method) {
    chrome.runtime.sendMessage({
      type: 'REPORT_BLOCK',
      payload: {
        tabId:  null,
        url:    location.href,
        kind:   'youtube',
        domain: 'youtube.com',
        method,
      }
    }).catch(() => {});
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  patchPlayerResponse();
  startObserver();
  startPoller();

  // Run immediately once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', removeAds, { once: true });
  } else {
    removeAds();
  }

  console.log('[AdBlock Pro] YouTube blocker active.');
})();
