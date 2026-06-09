/**
 * sidebar.js  —  YT Chat Sidebar Logic
 * ───────────────────────────────────────
 * Handles:
 *  - Settings persistence (chrome.storage.sync)
 *  - Video detection (messages from background.js)
 *  - Video indexing (POST /index)
 *  - Chat with streaming SSE (POST /chat)
 *  - Timestamp citation clicks (jump in video)
 *  - Dynamic textarea resize
 *  - Conversation history
 */

"use strict";

const API_BASE = "http://localhost:8000";

// ── Model options per provider ────────────────────────────────────────────────
const PROVIDER_MODELS = {
  google: [
    { value: "gemini-2.0-flash",     label: "gemini-2.0-flash (Fast, Free)" },
    { value: "gemini-1.5-flash",     label: "gemini-1.5-flash" },
    { value: "gemini-1.5-pro",       label: "gemini-1.5-pro (Powerful)" },
  ],
  openai: [
    { value: "gpt-4o-mini",          label: "gpt-4o-mini (Fast)" },
    { value: "gpt-4o",               label: "gpt-4o (Powerful)" },
  ],
  anthropic: [
    { value: "claude-3-5-haiku-20241022",  label: "claude-3-5-haiku (Fast)" },
    { value: "claude-3-5-sonnet-20241022", label: "claude-3-5-sonnet (Powerful)" },
  ],
  grok: [
    { value: "grok-3-mini",          label: "grok-3-mini (Fast)" },
    { value: "grok-3",               label: "grok-3 (Powerful)" },
  ],
};

const API_KEY_LABELS = {
  google:    { label: "Google API Key",    hint: "https://aistudio.google.com/apikey" },
  openai:    { label: "OpenAI API Key",    hint: "https://platform.openai.com/api-keys" },
  anthropic: { label: "Anthropic API Key", hint: "https://console.anthropic.com/keys" },
  grok:      { label: "xAI API Key",       hint: "https://console.x.ai" },
};

// ── State ─────────────────────────────────────────────────────────────────────
let currentVideoId    = null;
let currentVideoTitle = null;
let isIndexed         = false;
let isStreaming       = false;
let conversationHistory = [];
let settings = {
  provider:      "google",
  chatModel:     "gemini-2.0-flash",
  apiKey:        "",
  googleApiKey:  "",
  temperature:   0.2,
};

// ── DOM references ────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const stateNoVideo    = $("state-no-video");
const stateSetup      = $("state-setup");
const stateIndexing   = $("state-indexing");
const stateChat       = $("state-chat");
const videoBar        = $("video-bar");
const videoTitleEl    = $("video-title");
const videoStatusEl   = $("video-status");
const messagesEl      = $("messages");
const chatInput       = $("chat-input");
const sendBtn         = $("btn-send");
const settingsPanel   = $("settings-panel");
const btnSettings     = $("btn-settings");
const btnCloseSettings = $("btn-close-settings");
const btnSave         = $("btn-save");
const btnReindex      = $("btn-reindex");
const charCount       = $("char-count");
const modelBadge      = $("model-badge");
const settingsStatus  = $("settings-status");
const tempValueEl     = $("temp-value");
const googleKeyGroup  = $("google-key-group");
const apiKeyInput     = $("api-key");
const googleKeyInput  = $("google-api-key");
const chatModelSelect = $("chat-model");
const indexingDesc    = $("indexing-desc");

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadSettings();
  setupEventListeners();
  listenForVideoChanges();
  checkCurrentTab();
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get("ytchat_settings", (data) => {
      if (data.ytchat_settings) {
        settings = { ...settings, ...data.ytchat_settings };
      }
      applySettingsToForm();
      resolve();
    });
  });
}

async function saveSettings() {
  const provider = document.querySelector('input[name="provider"]:checked')?.value || "google";
  const chatModel  = chatModelSelect.value;
  const apiKey     = apiKeyInput.value.trim();
  const googleKey  = googleKeyInput.value.trim();
  const temperature = parseFloat($("temperature").value);

  if (!apiKey) {
    showSettingsStatus("Please enter your API key", "error");
    return;
  }

  settings = { provider, chatModel, apiKey, googleApiKey: googleKey, temperature };

  return new Promise((resolve) => {
    chrome.storage.sync.set({ ytchat_settings: settings }, () => {
      showSettingsStatus("✓ Settings saved!", "success");
      modelBadge.textContent = settings.chatModel;
      setTimeout(() => {
        settingsPanel.classList.add("hidden");
        settingsStatus.classList.add("hidden");
        // Re-check setup state
        if (currentVideoId && !isIndexed) {
          triggerIndexing(currentVideoId);
        }
      }, 1000);
      resolve();
    });
  });
}

function applySettingsToForm() {
  // Set provider radio
  const radio = document.querySelector(`input[name="provider"][value="${settings.provider}"]`);
  if (radio) radio.checked = true;
  updateProviderUI(settings.provider);

  // Set model
  updateModelOptions(settings.provider);
  chatModelSelect.value = settings.chatModel;

  // Set keys
  apiKeyInput.value     = settings.apiKey || "";
  googleKeyInput.value  = settings.googleApiKey || "";

  // Temperature
  $("temperature").value = settings.temperature;
  tempValueEl.textContent = settings.temperature;

  // Model badge
  modelBadge.textContent = settings.chatModel;
}

function updateProviderUI(provider) {
  const apiLabel = API_KEY_LABELS[provider];
  $("api-key-label").childNodes[0].textContent = apiLabel.label + " ";
  $("get-key-link").href = apiLabel.hint;

  // Show google key group only for anthropic/grok
  googleKeyGroup.style.display =
    (provider === "anthropic" || provider === "grok") ? "flex" : "none";
  googleKeyGroup.style.flexDirection = "column";
  googleKeyGroup.style.gap = "6px";

  updateModelOptions(provider);
}

function updateModelOptions(provider) {
  const models = PROVIDER_MODELS[provider] || [];
  chatModelSelect.innerHTML = models.map(m =>
    `<option value="${m.value}">${m.label}</option>`
  ).join("");
  chatModelSelect.value = settings.chatModel || models[0]?.value || "";
}

function showSettingsStatus(msg, type) {
  settingsStatus.textContent = msg;
  settingsStatus.className = `settings-status ${type}`;
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
async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    chrome.storage.session.get(`tab_${tab.id}_video`, (data) => {
      const videoData = data[`tab_${tab.id}_video`];
      if (videoData) {
        handleVideoChange(videoData.videoId, videoData.videoTitle);
      } else if (tab.url?.includes("youtube.com/watch")) {
        const url = new URL(tab.url);
        const videoId = url.searchParams.get("v");
        if (videoId) handleVideoChange(videoId, "YouTube Video");
      }
    });
  } catch (e) {
    console.warn("Could not check current tab:", e);
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

  currentVideoId    = videoId;
  currentVideoTitle = videoTitle || "YouTube Video";
  conversationHistory = [];

  // Update video bar
  videoBar.classList.remove("hidden");
  videoTitleEl.textContent = currentVideoTitle;
  videoStatusEl.textContent = "Checking...";
  videoStatusEl.className = "video-status";

  // Check if API key is configured
  if (!settings.apiKey) {
    showScreen("setup");
    return;
  }

  triggerIndexing(videoId);
}

async function triggerIndexing(videoId) {
  // Check if already indexed
  try {
    const res = await fetch(`${API_BASE}/status/${videoId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.is_indexed) {
        isIndexed = true;
        videoStatusEl.textContent = `✓ Ready (${data.num_chunks} chunks cached)`;
        videoStatusEl.className = "video-status indexed";
        btnReindex.classList.remove("hidden");
        showChatScreen();
        return;
      }
    }
  } catch (e) {
    // Backend might not be running
    showBackendError();
    return;
  }

  // Need to index
  isIndexed = false;
  showScreen("indexing");
  videoStatusEl.textContent = "Indexing...";
  videoStatusEl.className = "video-status indexing";
  indexingDesc.textContent = "Fetching transcript and building knowledge base...";

  try {
    const res = await fetch(`${API_BASE}/index`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_id:      videoId,
        force_reindex: false,
        llm_config: buildLLMConfig(),
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Indexing failed");
    }

    const data = await res.json();
    isIndexed = true;
    videoStatusEl.textContent = `✓ Ready (${data.num_chunks} chunks)`;
    videoStatusEl.className = "video-status indexed";
    btnReindex.classList.remove("hidden");
    showChatScreen();

  } catch (e) {
    console.error("Indexing error:", e);
    if (e.message.includes("fetch")) {
      showBackendError();
    } else {
      videoStatusEl.textContent = `✗ Error: ${e.message}`;
      videoStatusEl.className = "video-status";
      showScreen("no-video");
      addErrorMessage(`Failed to index video: ${e.message}`);
    }
  }
}

function showBackendError() {
  showScreen("no-video");
  stateNoVideo.innerHTML = `
    <div class="state-icon">🔌</div>
    <h2 class="state-title">Backend not running</h2>
    <p class="state-desc">Start the Python server first:<br>
    <code style="background:var(--bg-card);padding:4px 8px;border-radius:4px;font-size:12px;margin-top:8px;display:inline-block">
      python main.py
    </code></p>
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

  // Add user message
  addUserMessage(question);

  // Create assistant message placeholder
  const assistantMsgEl = addAssistantMessagePlaceholder();

  isStreaming = true;
  updateSendButton();

  let fullAnswer = "";
  let usedRag    = true;
  let citations  = [];

  try {
    const res = await fetch(`${API_BASE}/chat`, {
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
      const err = await res.json();
      throw new Error(err.detail || "Chat request failed");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    const bubbleEl  = assistantMsgEl.querySelector(".message-bubble");
    const cursorEl  = bubbleEl.querySelector(".streaming-cursor");
    const badgeEl   = assistantMsgEl.querySelector(".route-badge");
    let textNode    = document.createTextNode("");
    bubbleEl.insertBefore(textNode, cursorEl);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const raw = decoder.decode(value, { stream: true });
      const lines = raw.split("\n").filter(l => l.startsWith("data: "));

      for (const line of lines) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") break;

        try {
          const event = JSON.parse(data);

          if (event.type === "route") {
            const isGeneral = event.value === "general";
            usedRag = !isGeneral;
            if (badgeEl) {
              badgeEl.className = `route-badge ${isGeneral ? "general" : "rag"}`;
              badgeEl.textContent = isGeneral ? "🌐 General Knowledge" : "📹 Video Grounded";
            }
          }

          else if (event.type === "citations") {
            citations = event.data;
          }

          else if (event.type === "token") {
            fullAnswer += event.content;
            // Render markdown-ish text
            textNode.textContent = fullAnswer;
            scrollToBottom();
          }

          else if (event.type === "error") {
            throw new Error(event.message);
          }

        } catch (parseErr) {
          // Non-JSON line — ignore
        }
      }
    }

    // Remove cursor, finalize message
    if (cursorEl) cursorEl.remove();

    // Render formatted answer
    const bubble = assistantMsgEl.querySelector(".message-bubble");
    bubble.innerHTML = formatAnswer(fullAnswer);

    // Render citations
    if (citations.length > 0 && usedRag) {
      const citationsEl = renderCitations(citations);
      assistantMsgEl.querySelector(".message-content").appendChild(citationsEl);
    }

    // Update conversation history
    conversationHistory.push({ role: "user",      content: question });
    conversationHistory.push({ role: "assistant",  content: fullAnswer });
    if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);

  } catch (e) {
    console.error("Chat error:", e);
    const bubble = assistantMsgEl.querySelector(".message-bubble");
    bubble.innerHTML = `<div class="error-bubble">⚠️ ${e.message}</div>`;
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
    </div>
  `;
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
    </div>
  `;
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
    </div>
  `;
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
    </div>
  `;
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
    chip.className = "citation-chip";
    chip.textContent = c.timestamp_label;
    chip.title = c.content;
    chip.href = "#";
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      jumpToTimestamp(c.start_seconds);
    });
    div.appendChild(chip);
  });
  return div;
}

function formatAnswer(text) {
  // Convert basic markdown to HTML
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/`(.*?)`/g, "<code style='background:var(--bg-input);padding:1px 4px;border-radius:3px'>$1</code>")
    .replace(/^• (.*?)$/gm, "<li>$1</li>")
    .replace(/^\d+\. (.*?)$/gm, "<li>$1</li>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^/, "<p>")
    .replace(/$/, "</p>")
    .replace(/<p><\/p>/g, "");
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Timestamp Jump ────────────────────────────────────────────────────────────
async function jumpToTimestamp(seconds) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (seconds) => {
        const video = document.querySelector("video");
        if (video) {
          video.currentTime = seconds;
          video.play().catch(() => {});
        }
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
    provider:      settings.provider,
    api_key:       settings.apiKey,
    google_api_key: settings.googleApiKey || null,
    chat_model:    settings.chatModel,
    temperature:   settings.temperature,
  };
}

function updateSendButton() {
  const hasText    = chatInput.value.trim().length > 0;
  const canSend    = hasText && !isStreaming && isIndexed && settings.apiKey;
  sendBtn.disabled = !canSend;
}

function updateCharCount() {
  const len = chatInput.value.length;
  charCount.textContent = `${len}/500`;
  charCount.className = len > 400 ? "char-count warn" : "char-count";
}

function scrollToBottom() {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
}

// ── Event Listeners ───────────────────────────────────────────────────────────
function setupEventListeners() {
  // Settings open/close
  btnSettings.addEventListener("click", () => settingsPanel.classList.remove("hidden"));
  btnCloseSettings.addEventListener("click", () => settingsPanel.classList.add("hidden"));

  // Settings form
  $("settings-form").addEventListener("submit", (e) => { e.preventDefault(); saveSettings(); });

  // Provider radio changes
  document.querySelectorAll('input[name="provider"]').forEach(radio => {
    radio.addEventListener("change", () => {
      settings.provider = radio.value;
      updateProviderUI(radio.value);
    });
  });

  // Temperature slider
  $("temperature").addEventListener("input", (e) => {
    tempValueEl.textContent = e.target.value;
  });

  // Toggle key visibility
  $("btn-toggle-key").addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  });
  $("btn-toggle-google-key").addEventListener("click", () => {
    googleKeyInput.type = googleKeyInput.type === "password" ? "text" : "password";
  });

  // Clear history
  $("btn-clear-history").addEventListener("click", () => {
    conversationHistory = [];
    messagesEl.innerHTML = "";
    renderWelcomeMessage();
  });

  // Re-index
  btnReindex.addEventListener("click", async () => {
    if (!currentVideoId) return;
    isIndexed = false;
    btnReindex.classList.add("hidden");
    conversationHistory = [];
    messagesEl.innerHTML = "";
    showScreen("indexing");
    videoStatusEl.textContent = "Re-indexing...";
    videoStatusEl.className = "video-status indexing";

    try {
      const res = await fetch(`${API_BASE}/index`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_id:      currentVideoId,
          force_reindex: true,
          llm_config:    buildLLMConfig(),
        }),
      });
      const data = await res.json();
      isIndexed = true;
      videoStatusEl.textContent = `✓ Re-indexed (${data.num_chunks} chunks)`;
      videoStatusEl.className = "video-status indexed";
      btnReindex.classList.remove("hidden");
      showChatScreen();
    } catch (e) {
      videoStatusEl.textContent = "✗ Re-index failed";
      videoStatusEl.className = "video-status";
    }
  });

  // Chat input
  chatInput.addEventListener("input", () => {
    updateSendButton();
    updateCharCount();
    // Auto-resize
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  });

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Send button
  sendBtn.addEventListener("click", sendMessage);

  // Close settings on overlay click
  settingsPanel.addEventListener("click", (e) => {
    if (e.target === settingsPanel) settingsPanel.classList.add("hidden");
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
init();
