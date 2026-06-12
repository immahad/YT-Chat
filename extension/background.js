/**
 * background.js  —  Service Worker
 * ──────────────────────────────────
 * Responsibilities:
 *  1. Open the Side Panel when user clicks the extension action button
 *  2. Relay messages from content.js → sidebar.js
 *  3. Track the current video ID per tab
 *  4. Respond to sidebar's REQUEST_VIDEO_ID ping by injecting content script
 *
 * NOTE: In MV3, background.js is a Service Worker — it can go to sleep!
 * Don't store state in global variables; use chrome.storage.session instead.
 */

// ── Open Side Panel on action click ──────────────────────────────────────────
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// ── Listen for messages ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Content script detected a video
  if (message.type === "VIDEO_DETECTED") {
    const tabId = sender.tab?.id;
    if (tabId) {
      const videoData = {
        videoId:    message.videoId,
        videoTitle: message.videoTitle,
        tabId:      tabId,
      };
      chrome.storage.session.set({ [`tab_${tabId}_video`]: videoData });

      // Forward to sidebar if it's open (ignore errors — sidebar may not be open)
      chrome.runtime.sendMessage({
        type:       "VIDEO_CHANGED",
        videoId:    message.videoId,
        videoTitle: message.videoTitle,
        tabId:      tabId,
      }).catch(() => {});
    }
    sendResponse({ received: true });
    return true;
  }

  // Sidebar is asking: "what video is in the active tab right now?"
  // We inject/re-run the content script so it fires VIDEO_DETECTED fresh.
  if (message.type === "REQUEST_VIDEO_ID") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) { sendResponse(null); return; }

      const tabId = tab.id;

      // First, try session storage (fast path)
      chrome.storage.session.get(`tab_${tabId}_video`, (data) => {
        const stored = data[`tab_${tabId}_video`];
        if (stored && stored.videoId) {
          sendResponse(stored);
          return;
        }

        // If URL is a YouTube watch page, extract directly & inject content script
        if (tab.url && tab.url.includes("youtube.com/watch")) {
          try {
            const url = new URL(tab.url);
            const videoId = url.searchParams.get("v");
            if (videoId) {
              const videoData = { videoId, videoTitle: tab.title?.replace(" - YouTube", "").trim() || "YouTube Video", tabId };
              chrome.storage.session.set({ [`tab_${tabId}_video`]: videoData });
              sendResponse(videoData);

              // Also inject content script to keep things in sync
              chrome.scripting.executeScript({
                target: { tabId },
                files:  ["content.js"],
              }).catch(() => {});
              return;
            }
          } catch (e) { /* ignore parse errors */ }
        }

        sendResponse(null);
      });
    });
    return true; // keep channel open for async sendResponse
  }

  return true;
});

// ── When a tab finishes loading a YouTube watch page ─────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url?.includes("youtube.com/watch")) {
    chrome.scripting.executeScript({
      target: { tabId },
      files:  ["content.js"],
    }).catch(() => {});
  }
});