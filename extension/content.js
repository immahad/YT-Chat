/**
 * content.js  —  Injected into YouTube pages
 * ────────────────────────────────────────────
 * Detects the current YouTube video ID and title,
 * then sends them to the background service worker.
 *
 * Handles:
 *  - Initial page load
 *  - YouTube's SPA navigation (yt-navigate-finish event)
 *  - URL polling fallback
 */

(function () {
  "use strict";

  let lastVideoId = null;

  function extractVideoId(url) {
    try {
      const u = new URL(url);
      return u.searchParams.get("v") || null;
    } catch {
      return null;
    }
  }

  function getVideoTitle() {
    // Try multiple selectors (YouTube changes these sometimes)
    const selectors = [
      "h1.ytd-video-primary-info-renderer yt-formatted-string",
      "#title h1 yt-formatted-string",
      "ytd-video-primary-info-renderer h1",
      "#above-the-fold #title h1",
      "h1.style-scope.ytd-watch-metadata",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }
    return document.title.replace(" - YouTube", "").trim() || "YouTube Video";
  }

  function notifyVideoDetected() {
    const videoId = extractVideoId(window.location.href);
    if (!videoId || videoId === lastVideoId) return;

    lastVideoId = videoId;

    // Small delay to let YouTube finish rendering the title
    setTimeout(() => {
      const title = getVideoTitle();
      chrome.runtime.sendMessage({
        type:       "VIDEO_DETECTED",
        videoId:    videoId,
        videoTitle: title,
      }).catch(() => {});
    }, 1000);
  }

  // ── Initial detection ─────────────────────────────────────────────────────
  notifyVideoDetected();

  // ── YouTube SPA navigation events ─────────────────────────────────────────
  window.addEventListener("yt-navigate-finish", notifyVideoDetected);
  window.addEventListener("popstate",           notifyVideoDetected);

  // ── Polling fallback (YouTube sometimes doesn't fire events) ──────────────
  setInterval(() => {
    const videoId = extractVideoId(window.location.href);
    if (videoId && videoId !== lastVideoId) {
      notifyVideoDetected();
    }
  }, 3000);
})();
