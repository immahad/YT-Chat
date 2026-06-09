/**
 * background.js  —  Service Worker
 * ──────────────────────────────────
 * Responsibilities:
 *  1. Open the Side Panel when user clicks the extension action button
 *  2. Relay messages from content.js → sidebar.js
 *  3. Track the current video ID per tab
 *
 * NOTE: In MV3, background.js is a Service Worker — it can go to sleep!
 * Don't store state in global variables; use chrome.storage.session instead.
 */

// ── Open Side Panel on action click ──────────────────────────────────────────
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// ── Listen for messages from content.js ──────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "VIDEO_DETECTED") {
    // Store video info for this tab
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.storage.session.set({
        [`tab_${tabId}_video`]: {
          videoId:    message.videoId,
          videoTitle: message.videoTitle,
          tabId:      tabId,
        }
      });

      // Forward to sidebar if it's open
      chrome.runtime.sendMessage({
        type:       "VIDEO_CHANGED",
        videoId:    message.videoId,
        videoTitle: message.videoTitle,
        tabId:      tabId,
      }).catch(() => {
        // Sidebar might not be open yet — that's fine
      });
    }

    sendResponse({ received: true });
  }

  // Keep message channel open for async
  return true;
});

// ── When a tab updates (navigation) — detect video changes ───────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url?.includes("youtube.com/watch")) {
    // Inject content script to detect new video
    chrome.scripting.executeScript({
      target: { tabId },
      files:  ["content.js"],
    }).catch(() => {
      // May fail if tab doesn't allow injection — ignore
    });
  }
});
