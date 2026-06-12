/**
 * sidebar.js  —  YT Chat Sidebar Logic
 * ───────────────────────────────────────
 * Handles:
 *  - Settings persistence (chrome.storage.sync)
 *  - Video detection (messages from background.js + direct tab URL fallback)
 *  - Video indexing (POST /index)
 *  - Chat with streaming SSE (POST /chat)
 *  - Timestamp citation clicks (jump in video)
 *  - Dynamic textarea resize
 *  - Conversation history
 */

"use strict";

const API_BASE = "http://localhost:8000";

// ── Model options per provider (Google & OpenAI only) ────────────────────────
const PROVIDER_MODELS = {
  google: [
    { value: "gemini-2.0-flash",       label: "Gemini 2.0 Flash (Fast, Free)" },
    { value: "gemini-1.5-flash",       label: "Gemini 1.5 Flash" },
    { value: "gemini-1.5-pro",         label: "Gemini 1.5 Pro (Powerful)" },
    { value: "gemini-2.0-flash-lite",  label: "Gemini 2.0 Flash Lite (Fastest)" },
  ],
  openai: [
    { value: "gpt-4o-mini",  label: "GPT-4o Mini (Fast)" },
    { value: "gpt-4o",       label: "GPT-4o (Powerful)" },
    { value: "gpt-4-turbo",  label: "GPT-4 Turbo" },
  ],
};

const API_KEY_LABELS = {
  google: { label: "Google API Key",  hint: "https://aistudio.google.com/apikey" },
  openai: { label: "OpenAI API Key",  hint: "https://platform.openai.com/api-keys" },
};

// ── State ─────────────────────────────────────────────────────────────────────
let currentVideoId      = null;
let currentVideoTitle   = null;
let isIndexed           = false;
let isStreaming         = false;
let conversationHistory = [];
let settings = {
  provider:    "google",
  chatModel:   "gemini-2.0-flash",
  apiKey:      "",
  temperature: 0.2,
};

// ── DOM references ────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const stateNoVideo   = $("state-no-video");
const stateSetup     = $("state-setup");
const stateIndexing  = $("state-indexing");
const stateChat      = $("state-chat");
const videoBar       = $("video-bar");
const videoTitleEl   = $("video-title");
const videoStatusEl  = $("video-status");
const messagesEl     = $("messages");
const chatInput      = $("chat-input");
const sendBtn        = $("btn-send");
const settingsPanel  = $("settings-panel");
const btnSettings    = $("btn-settings");
const btnCloseSettings = $("btn-close-settings");
const btnReindex     = $("btn-reindex");
const charCount      = $("char-count");
const modelBadge     = $("model-badge");
const settingsStatus = $("settings-status");
const tempValueEl    = $("temp-value");
const apiKeyInput    = $("api-key");
const chatModelSelect = $("chat-model");
const indexingDesc   = $("indexing-desc");

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadSettings();
  setupEventListeners();
  listenForVideoChanges();
  await checkCurrentTab();
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get("ytchat_settings", (data) => {
      if (data.ytchat_settings) {
        settings = { ...settings, ...data.ytchat_settings };
        // Migrate away from removed providers
        if (settings.provider === "anthropic" || settings.provider === "grok") {
          settings.provider  = "google";
          settings.chatModel = "gemini-2.0-flash";
        }
      }
      applySettingsToForm();
      resolve();
    });
  });
}

async function saveSettings() {
  const provider    = document.querySelector('input[name="provider"]:checked')?.value || "google";
  const chatModel   = chatModelSelect.value;
  const apiKey      = apiKeyInput.value.trim();
  const temperature = parseFloat($("temperature").value);

  if (!apiKey) {
    showSettingsStatus("Please enter your API key", "error");
    return;
  }

  settings = { provider, chatModel, apiKey, temperature };

  return new Promise((resolve) => {
    chrome.storage.sync.set({ ytchat_settings: settings }, () => {
      showSettingsStatus("✓ Settings saved!", "success");
      modelBadge.textContent = settings.chatModel;
      setTimeout(() => {
        settingsPanel.classList.add("hidden");
        settingsStatus.classList.add("hidden");
        if (currentVideoId && !isIndexed) {
          triggerIndexing(currentVideoId);
        }
      }, 1000);
      resolve();
    });
  });
}

function applySettingsToForm() {
  const radio = document.querySelector(`input[name="provider"][value="${settings.provider}"]`);
  if (radio) radio.checked = true;
  updateProviderUI(settings.provider);
  updateModelOptions(settings.provider);
  chatModelSelect.value     = settings.chatModel;
  apiKeyInput.value         = settings.apiKey || "";
  $("temperature").value    = settings.temperature;
  tempValueEl.textContent   = settings.temperature;
  modelBadge.textContent    = settings.chatModel;
}

function updateProviderUI(provider) {
  const apiLabel = API_KEY_LABELS[provider] || API_KEY_LABELS.google;
  const labelEl  = $("api-key-label");
  // Update label text (first text node) and the link
  labelEl.childNodes[0].textContent = apiLabel.label + " ";
  $("get-key-link").href = apiLabel.hint;
  updateModelOptions(provider);
}

function updateModelOptions(provider) {
  const models = PROVIDER_MODELS[provider] || PROVIDER_MODELS.google;
  chatModelSelect.innerHTML = models.map(m =>
    `<option value="${m.value}">${m.label}</option>`
  ).join("");
  // Restore previously saved model if it belongs to this provider
  const match = models.find(m => m.value === settings.chatModel);
  chatModelSelect.value = match ? settings.chatModel : models[0]?.value || "";
}

function showSettingsStatus(msg, type) {
  settingsStatus.textContent = msg;
  settingsStatus.className   = `settings-status ${type}`;
  settingsStatus.classList.remove("hidden");
}

// ── Screen management ─────────────────────────────────────────────────────────
function showScreen(name) {
  stateNoVideo.classList.add("hidden");
  stateSetup.classList.add("hidden");
  stateIndexing.classList.add("hidden");
  stateChat.classList.add("hidden");
  if (name === "no-video")  stateNoVideo.classList.remove("hidden");
  if (name === "setup")     stateSetup.classList.remove("hidden");
  if (name === "indexing")  stateIndexing.classList.remove("hidden");
  if (name === "chat")      stateChat.classList.remove("hidden");
}

// ── Video Detection ───────────────────────────────────────────────────────────

/**
 * Primary detection: ask background for the current tab's video.
 * Falls back to direct URL parse if background returns nothing.
 */
async function checkCurrentTab() {
  try {
    // Ask background (which may already have it in session storage)
    const videoData = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "REQUEST_VIDEO_ID" }, (response) => {
        resolve(response || null);
      });
    });

    if (videoData && videoData.videoId) {
      handleVideoChange(videoData.videoId, videoData.videoTitle);
      return;
    }

    // Hard fallback: read active tab URL ourselves
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes("youtube.com/watch")) {
      const url     = new URL(tab.url);
      const videoId = url.searchParams.get("v");
      if (videoId) {
        const title = tab.title?.replace(" - YouTube", "").trim() || "YouTube Video";
        handleVideoChange(videoId, title);
      }
    }
  } catch (e) {
    console.warn("checkCurrentTab error:", e);
  }
}

function listenForVideoChanges() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "VIDEO_CHANGED") {
      handleVideoChange(message.videoId, message.videoTitle);
    }
  });
}

async function handleVideoChange(videoId, videoTitle) {
  if (videoId === currentVideoId) return;

  currentVideoId      = videoId;
  currentVideoTitle   = videoTitle || "YouTube Video";
  conversationHistory = [];

  videoBar.classList.remove("hidden");
  videoTitleEl.textContent  = currentVideoTitle;
  videoStatusEl.textContent = "Checking...";
  videoStatusEl.className   = "video-status";

  if (!settings.apiKey) {
    showScreen("setup");
    return;
  }

  triggerIndexing(videoId);
}

async function triggerIndexing(videoId) {
  // ── Step 1: Check if already indexed ─────────────────────────────────────
  try {
    const res = await safeFetch(`${API_BASE}/status/${videoId}`);
    if (res.ok) {
      const data = await safeJson(res);
      if (data && data.is_indexed) {
        isIndexed = true;
        videoStatusEl.textContent = `✓ Ready (${data.num_chunks} chunks cached)`;
        videoStatusEl.className   = "video-status indexed";
        btnReindex.classList.remove("hidden");
        showChatScreen();
        return;
      }
    }
  } catch (e) {
    if (isNetworkError(e)) { showBackendError(); return; }
  }

  // ── Step 2: Index the video ───────────────────────────────────────────────
  isIndexed = false;
  showScreen("indexing");
  videoStatusEl.textContent = "Indexing...";
  videoStatusEl.className   = "video-status indexing";
  indexingDesc.textContent  = "Collecting transcript from the browser tab...";

  try {
    const data = await indexCurrentVideo(videoId, false);

    isIndexed = true;
    videoStatusEl.textContent = `✓ Ready (${data.num_chunks} chunks)`;
    videoStatusEl.className   = "video-status indexed";
    btnReindex.classList.remove("hidden");
    showChatScreen();

  } catch (e) {
    console.error("Indexing error:", e);
    if (isNetworkError(e)) {
      showBackendError();
    } else {
      // Show error screen with the actual backend message + a retry button
      videoStatusEl.textContent = `✗ Indexing failed`;
      videoStatusEl.className   = "video-status";
      showIndexingError(e.message);
    }
  }
}

function showIndexingError(msg) {
  showScreen("no-video");
  stateNoVideo.innerHTML = `
    <div class="state-icon">⚠️</div>
    <h2 class="state-title">Indexing failed</h2>
    <p class="state-desc" style="color:#ff6666;word-break:break-word;max-width:280px">${escapeHtml(msg)}</p>
    <button class="primary-btn" id="btn-retry-index" style="margin-top:8px">↻ Retry</button>
    <button class="secondary-btn" id="btn-retry-settings" style="margin-top:6px">⚙ Check Settings</button>
  `;
  document.getElementById("btn-retry-index").addEventListener("click", () => {
    if (currentVideoId) triggerIndexing(currentVideoId);
  });
  document.getElementById("btn-retry-settings").addEventListener("click", () => {
    settingsPanel.classList.remove("hidden");
  });
}

// ── Safe fetch helpers ────────────────────────────────────────────────────────

/**
 * Wraps fetch() — lets TypeError (network down) propagate naturally.
 * Callers use isNetworkError(e) in their catch to detect backend-down state.
 */
async function safeFetch(url, options) {
  return fetch(url, options); // throws TypeError on network failure
}

/** Parse JSON safely — returns null instead of throwing on bad JSON. */
async function safeJson(res) {
  const text = await res.text();
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Backend returned non-JSON (HTML error page, plain text, etc.)
    // Extract a useful message if possible
    const snip = text.slice(0, 200).replace(/<[^>]+>/g, " ").trim();
    return { detail: snip || "Server returned a non-JSON response" };
  }
}

async function collectBrowserTranscript() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url || !tab.url.includes("youtube.com/watch")) {
    return null;
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      function extractJsonObject(text, anchor) {
        const anchorIndex = text.indexOf(anchor);
        if (anchorIndex === -1) return null;

        const startIndex = text.indexOf("{", anchorIndex);
        if (startIndex === -1) return null;

        let depth = 0;
        let inString = false;
        let escape = false;

        for (let i = startIndex; i < text.length; i += 1) {
          const char = text[i];

          if (inString) {
            if (escape) {
              escape = false;
            } else if (char === "\\") {
              escape = true;
            } else if (char === '"') {
              inString = false;
            }
            continue;
          }

          if (char === '"') {
            inString = true;
          } else if (char === "{") {
            depth += 1;
          } else if (char === "}") {
            depth -= 1;
            if (depth === 0) {
              return text.slice(startIndex, i + 1);
            }
          }
        }

        return null;
      }

      function parseCaptionBody(body) {
        const text = (body || "").trim();
        if (!text) return [];

        if (text.startsWith("{") || text.startsWith("[")) {
          const payload = JSON.parse(text);
          const events = Array.isArray(payload.events) ? payload.events : [];
          const segments = [];

          for (const event of events) {
            const pieces = Array.isArray(event && event.segs) ? event.segs : [];
            const captionText = pieces.map((piece) => piece.utf8 || "").join("").trim();
            if (!captionText) continue;

            segments.push({
              text: captionText,
              start: Number((event && event.tStartMs) || 0) / 1000,
              duration: Number((event && event.dDurationMs) || 0) / 1000,
            });
          }

          return segments;
        }

        const parser = new DOMParser();
        const xml = parser.parseFromString(text, "text/xml");
        if (xml.querySelector("parsererror")) return [];

        return Array.from(xml.getElementsByTagName("text"))
          .map((node) => ({
            text: (node.textContent || "").replace(/<[^>]*>/g, "").trim(),
            start: Number(node.getAttribute("start") || 0),
            duration: Number(node.getAttribute("dur") || 0),
          }))
          .filter((segment) => segment.text);
      }

      function chooseTrack(tracks) {
        const isManual = (track) => track && track.kind !== "asr";
        const isGenerated = (track) => track && track.kind === "asr";
        const isEnglish = (track) => String((track && track.languageCode) || "").toLowerCase().startsWith("en");

        return (
          tracks.find((track) => isEnglish(track) && isManual(track)) ||
          tracks.find((track) => isManual(track)) ||
          tracks.find((track) => isEnglish(track) && isGenerated(track)) ||
          tracks[0] ||
          null
        );
      }

      const scripts = Array.from(document.scripts || []);
      let playerResponse = null;

      for (const script of scripts) {
        const text = script && script.textContent ? script.textContent : "";
        if (!text.includes("ytInitialPlayerResponse")) continue;

        const jsonText = extractJsonObject(text, "ytInitialPlayerResponse");
        if (!jsonText) continue;

        try {
          playerResponse = JSON.parse(jsonText);
          break;
        } catch {
          continue;
        }
      }

      if (!playerResponse && window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === "object") {
        playerResponse = window.ytInitialPlayerResponse;
      }

      const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const tracks = captionTracks.filter((track) => track && track.baseUrl);
      if (!tracks.length) return null;

      const selectedTrack = chooseTrack(tracks);
      if (!selectedTrack) return null;

      const response = await fetch(selectedTrack.baseUrl, { credentials: "include" });
      if (!response.ok) return null;

      const body = await response.text();
      const segments = parseCaptionBody(body);
      if (!segments.length) return null;

      return {
        segments,
        language: selectedTrack.languageCode || "unknown",
        is_generated: selectedTrack.kind === "asr",
        source: "browser",
      };
    },
  });

  return results?.[0]?.result || null;
}

async function indexCurrentVideo(videoId, forceReindex) {
  let transcript = null;

  try {
    transcript = await collectBrowserTranscript();
    if (transcript && transcript.segments && transcript.segments.length) {
      indexingDesc.textContent = "Transcript captured from the browser tab.";
    }
  } catch (e) {
    console.warn("Browser transcript collection failed:", e);
  }

  const payload = {
    video_id: videoId,
    force_reindex: forceReindex,
    llm_config: buildLLMConfig(),
  };

  if (transcript && transcript.segments && transcript.segments.length) {
    payload.transcript = transcript;
  }

  const res = await safeFetch(`${API_BASE}/index`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await safeJson(res);
  if (!res.ok) {
    const detail = data?.detail || `HTTP ${res.status}`;
    throw new Error(detail);
  }

  return data;
}

function isNetworkError(e) {
  return e instanceof TypeError && (
    e.message.includes("fetch") ||
    e.message.includes("network") ||
    e.message.includes("Failed to fetch") ||
    e.message.includes("NetworkError")
  );
}

function showBackendError() {
  showScreen("no-video");
  stateNoVideo.innerHTML = `
    <div class="state-icon">🔌</div>
    <h2 class="state-title">Backend not running</h2>
    <p class="state-desc">
      Start the Python server first:<br>
      <code style="background:var(--bg-card);padding:4px 8px;border-radius:4px;font-size:12px;margin-top:8px;display:inline-block">
        double-click start.bat
      </code>
      <br><br>
      Then reload this panel.
    </p>
  `;
}

function showChatScreen() {
  showScreen("chat");
  if (messagesEl.children.length === 0) {
    renderWelcomeMessage();
  }
  chatInput.focus();
  updateSendButton();
}

// ── Chat ──────────────────────────────────────────────────────────────────────
async function sendMessage() {
  const question = chatInput.value.trim();
  if (!question || isStreaming) return;

  chatInput.value = "";
  chatInput.style.height = "auto";
  updateSendButton();
  updateCharCount();

  addUserMessage(question);
  const assistantMsgEl = addAssistantMessagePlaceholder();

  isStreaming = true;
  updateSendButton();

  let fullAnswer = "";
  let usedRag    = true;
  let citations  = [];

  // Hoist DOM refs outside try so catch/finally can always access them
  const bubbleEl = assistantMsgEl.querySelector(".message-bubble");
  const cursorEl = bubbleEl.querySelector(".streaming-cursor");
  const badgeEl  = assistantMsgEl.querySelector(".route-badge");

  try {
    const res = await safeFetch(`${API_BASE}/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_id:             currentVideoId,
        question:             question,
        llm_config:           buildLLMConfig(),
        conversation_history: conversationHistory,
      }),
    });

    if (!res.ok) {
      const data = await safeJson(res);
      throw new Error(data?.detail || `Server error ${res.status}`);
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    const textNode = document.createTextNode("");
    bubbleEl.insertBefore(textNode, cursorEl);

    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") break;

        let event;
        try { event = JSON.parse(raw); } catch { continue; } // skip non-JSON lines

        if (event.type === "route") {
          const isGeneral = event.value === "general";
          usedRag = !isGeneral;
          if (badgeEl) {
            badgeEl.className   = `route-badge ${isGeneral ? "general" : "rag"}`;
            badgeEl.textContent = isGeneral ? "🌐 General Knowledge" : "📹 Video Grounded";
          }
        } else if (event.type === "citations") {
          citations = event.data;
        } else if (event.type === "token") {
          fullAnswer += event.content;
          textNode.textContent = fullAnswer;
          scrollToBottom();
        } else if (event.type === "error") {
          throw new Error(event.message); // propagates to outer catch correctly now
        }
      }
    }

    // Finalize
    if (cursorEl) cursorEl.remove();
    bubbleEl.innerHTML = formatAnswer(fullAnswer);

    if (citations.length > 0 && usedRag) {
      assistantMsgEl.querySelector(".message-content").appendChild(renderCitations(citations));
    }

    conversationHistory.push({ role: "user",      content: question });
    conversationHistory.push({ role: "assistant",  content: fullAnswer });
    if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);

  } catch (e) {
    console.error("Chat error:", e);
    if (cursorEl) cursorEl.remove();
    bubbleEl.innerHTML = `<div class="error-bubble">⚠️ ${escapeHtml(e.message)}</div>`;
  } finally {
    isStreaming = false;
    updateSendButton();
    scrollToBottom();
  }
}

// ── Message Rendering ─────────────────────────────────────────────────────────
function addUserMessage(text) {
  const el = document.createElement("div");
  el.className = "message user";
  el.innerHTML = `
    <div class="message-avatar">👤</div>
    <div class="message-content">
      <div class="message-bubble">${escapeHtml(text)}</div>
    </div>`;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function addAssistantMessagePlaceholder() {
  const el = document.createElement("div");
  el.className = "message assistant";
  el.innerHTML = `
    <div class="message-avatar">✨</div>
    <div class="message-content">
      <div class="route-badge rag">📹 Video Grounded</div>
      <div class="message-bubble">
        <span class="streaming-cursor"></span>
      </div>
    </div>`;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function addErrorMessage(text) {
  const el = document.createElement("div");
  el.className = "message assistant";
  el.innerHTML = `
    <div class="message-avatar">⚠️</div>
    <div class="message-content">
      <div class="message-bubble error-bubble">${escapeHtml(text)}</div>
    </div>`;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function renderWelcomeMessage() {
  const el = document.createElement("div");
  el.className = "welcome-message";
  el.innerHTML = `
    <span class="welcome-icon">💬</span>
    <strong>Ask anything about this video</strong>
    <span>I'll find the exact moment and cite the timestamp</span>
    <div class="suggestion-chips">
      <div class="chip" data-q="Summarize this video">Summarize video</div>
      <div class="chip" data-q="What are the main topics discussed?">Main topics</div>
      <div class="chip" data-q="What are the key takeaways?">Key takeaways</div>
      <div class="chip" data-q="List any resources or links mentioned">Resources mentioned</div>
    </div>`;
  messagesEl.appendChild(el);
  el.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      chatInput.value = chip.dataset.q;
      updateSendButton();
      updateCharCount();
      sendMessage();
    });
  });
}

function renderCitations(citations) {
  const div = document.createElement("div");
  div.className = "citations";
  citations.forEach(c => {
    const chip = document.createElement("a");
    chip.className   = "citation-chip";
    chip.textContent = c.timestamp_label;
    chip.title       = c.content;
    chip.href        = "#";
    chip.addEventListener("click", (e) => { e.preventDefault(); jumpToTimestamp(c.start_seconds); });
    div.appendChild(chip);
  });
  return div;
}

function formatAnswer(text) {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/`(.*?)`/g, "<code style='background:var(--bg-input);padding:1px 4px;border-radius:3px'>$1</code>")
    .replace(/^• (.*?)$/gm, "<li>$1</li>")
    .replace(/^\d+\. (.*?)$/gm, "<li>$1</li>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^/, "<p>").replace(/$/, "</p>")
    .replace(/<p><\/p>/g, "");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Timestamp Jump ────────────────────────────────────────────────────────────
async function jumpToTimestamp(seconds) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (s) => {
        const video = document.querySelector("video");
        if (video) { video.currentTime = s; video.play().catch(() => {}); }
      },
      args: [seconds],
    });
  } catch (e) {
    console.warn("Could not jump to timestamp:", e);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildLLMConfig() {
  return {
    provider:    settings.provider,
    api_key:     settings.apiKey,
    chat_model:  settings.chatModel,
    temperature: settings.temperature,
    // google_api_key not needed — provider always has native embeddings now
  };
}

function updateSendButton() {
  const canSend    = chatInput.value.trim().length > 0 && !isStreaming && isIndexed && !!settings.apiKey;
  sendBtn.disabled = !canSend;
}

function updateCharCount() {
  const len = chatInput.value.length;
  charCount.textContent = `${len}/500`;
  charCount.className   = len > 400 ? "char-count warn" : "char-count";
}

function scrollToBottom() {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
}

// ── Event Listeners ───────────────────────────────────────────────────────────
function setupEventListeners() {
  btnSettings.addEventListener("click",      () => settingsPanel.classList.remove("hidden"));
  btnCloseSettings.addEventListener("click", () => settingsPanel.classList.add("hidden"));
  // Setup screen "Open Settings" button — no inline onclick (CSP violation)
  $("btn-open-settings-setup").addEventListener("click", () => settingsPanel.classList.remove("hidden"));

  $("settings-form").addEventListener("submit", (e) => { e.preventDefault(); saveSettings(); });

  document.querySelectorAll('input[name="provider"]').forEach(radio => {
    radio.addEventListener("change", () => {
      settings.provider = radio.value;
      updateProviderUI(radio.value);
    });
  });

  $("temperature").addEventListener("input", (e) => {
    tempValueEl.textContent = parseFloat(e.target.value).toFixed(1);
  });

  $("btn-toggle-key").addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  });

  $("btn-clear-history").addEventListener("click", () => {
    conversationHistory = [];
    messagesEl.innerHTML = "";
    renderWelcomeMessage();
  });

  btnReindex.addEventListener("click", async () => {
    if (!currentVideoId) return;
    isIndexed = false;
    btnReindex.classList.add("hidden");
    conversationHistory = [];
    messagesEl.innerHTML = "";
    showScreen("indexing");
    videoStatusEl.textContent = "Re-indexing...";
    videoStatusEl.className   = "video-status indexing";
    indexingDesc.textContent  = "Collecting transcript from the browser tab...";
    try {
      const data = await indexCurrentVideo(currentVideoId, true);
      isIndexed = true;
      videoStatusEl.textContent = `✓ Re-indexed (${data.num_chunks} chunks)`;
      videoStatusEl.className   = "video-status indexed";
      btnReindex.classList.remove("hidden");
      showChatScreen();
    } catch (e) {
      videoStatusEl.textContent = `✗ ${e.message}`;
      videoStatusEl.className   = "video-status";
    }
  });

  chatInput.addEventListener("input", () => {
    updateSendButton();
    updateCharCount();
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  });

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  sendBtn.addEventListener("click", sendMessage);

  settingsPanel.addEventListener("click", (e) => {
    if (e.target === settingsPanel) settingsPanel.classList.add("hidden");
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
init();