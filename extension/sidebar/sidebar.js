/**
 * sidebar.js  —  YT Chat Sidebar Logic
 */

"use strict";

const API_BASE = "http://localhost:8000";

const PROVIDER_MODELS = {
  groq: [
    { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile" },
    { value: "llama3-8b-8192", label: "Llama 3 8B" },
    { value: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
    { value: "gemma2-9b-it", label: "Gemma 2 9B" },
  ],
  openai: [
    { value: "gpt-4o-mini", label: "GPT-4o Mini (Fast)" },
    { value: "gpt-4o", label: "GPT-4o (Powerful)" },
    { value: "gpt-4-turbo", label: "GPT-4 Turbo" },
  ],
};

const API_KEY_LABELS = {
  groq: { label: "Groq API Key", hint: "https://console.groq.com/keys" },
  openai: { label: "OpenAI API Key", hint: "https://platform.openai.com/api-keys" },
};

// ── State ─────────────────────────────────────────────────────────────────────
let currentVideoId = null;
let currentVideoTitle = null;
let isIndexed = false;
let isStreaming = false;
let conversationHistory = [];
let settings = {
  provider: "groq",
  chatModel: "llama-3.3-70b-versatile",
  apiKey: "",
  temperature: 0.2,
};

// ── DOM references ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const stateNoVideo = $("state-no-video");
const stateSetup = $("state-setup");
const stateIndexing = $("state-indexing");
const stateChat = $("state-chat");
const videoBar = $("video-bar");
const videoTitleEl = $("video-title");
const videoStatusEl = $("video-status");
const messagesEl = $("messages");
const chatInput = $("chat-input");
const sendBtn = $("btn-send");
const settingsPanel = $("settings-panel");
const btnSettings = $("btn-settings");
const btnCloseSettings = $("btn-close-settings");
const btnReindex = $("btn-reindex");
const charCount = $("char-count");
const modelBadge = $("model-badge");
const settingsStatus = $("settings-status");
const tempValueEl = $("temp-value");
const apiKeyInput = $("api-key");
const chatModelSelect = $("chat-model");
const indexingDesc = $("indexing-desc");

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
        if (settings.provider === "anthropic" || settings.provider === "grok" || settings.provider === "google") {
          settings.provider = "groq";
          settings.chatModel = "llama-3.3-70b-versatile";
        }
      }
      applySettingsToForm();
      resolve();
    });
  });
}

async function saveSettings() {
  const provider = document.querySelector('input[name="provider"]:checked')?.value || "groq";
  const chatModel = chatModelSelect.value;
  const apiKey = apiKeyInput.value.trim();
  const temperature = parseFloat($("temperature").value);

  if (!apiKey) { showSettingsStatus("Please enter your API key", "error"); return; }

  settings = { provider, chatModel, apiKey, temperature };
  return new Promise((resolve) => {
    chrome.storage.sync.set({ ytchat_settings: settings }, () => {
      showSettingsStatus("✓ Settings saved!", "success");
      modelBadge.textContent = settings.chatModel;
      setTimeout(() => {
        settingsPanel.classList.add("hidden");
        settingsStatus.classList.add("hidden");
        if (currentVideoId && !isIndexed) triggerIndexing(currentVideoId);
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
  chatModelSelect.value = settings.chatModel;
  apiKeyInput.value = settings.apiKey || "";
  $("temperature").value = settings.temperature;
  tempValueEl.textContent = settings.temperature;
  modelBadge.textContent = settings.chatModel;
}

function updateProviderUI(provider) {
  const apiLabel = API_KEY_LABELS[provider] || API_KEY_LABELS.groq;
  const labelEl = $("api-key-label");
  labelEl.childNodes[0].textContent = apiLabel.label + " ";
  $("get-key-link").href = apiLabel.hint;
  updateModelOptions(provider);
}

function updateModelOptions(provider) {
  const models = PROVIDER_MODELS[provider] || PROVIDER_MODELS.groq;
  chatModelSelect.innerHTML = models.map(m =>
    `<option value="${m.value}">${m.label}</option>`
  ).join("");
  const match = models.find(m => m.value === settings.chatModel);
  chatModelSelect.value = match ? settings.chatModel : models[0]?.value || "";
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
  if (name === "no-video") stateNoVideo.classList.remove("hidden");
  if (name === "setup") stateSetup.classList.remove("hidden");
  if (name === "indexing") stateIndexing.classList.remove("hidden");
  if (name === "chat") stateChat.classList.remove("hidden");
}

// ── Video Detection ───────────────────────────────────────────────────────────
async function checkCurrentTab() {
  try {
    const videoData = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "REQUEST_VIDEO_ID" }, (response) => {
        resolve(response || null);
      });
    });
    if (videoData && videoData.videoId) { handleVideoChange(videoData.videoId, videoData.videoTitle); return; }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes("youtube.com/watch")) {
      const url = new URL(tab.url);
      const videoId = url.searchParams.get("v");
      if (videoId) handleVideoChange(videoId, tab.title?.replace(" - YouTube", "").trim() || "YouTube Video");
    }
  } catch (e) { console.warn("checkCurrentTab error:", e); }
}

function listenForVideoChanges() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "VIDEO_CHANGED") handleVideoChange(message.videoId, message.videoTitle);
  });
}

async function handleVideoChange(videoId, videoTitle) {
  if (videoId === currentVideoId) {
    if (videoTitle && videoTitle !== currentVideoTitle && videoTitle !== "YouTube Video") {
      currentVideoTitle = videoTitle;
      videoTitleEl.textContent = currentVideoTitle;
    }
    return;
  }
  currentVideoId = videoId;
  currentVideoTitle = videoTitle || "YouTube Video";
  conversationHistory = [];
  messagesEl.innerHTML = "";
  videoBar.classList.remove("hidden");
  videoTitleEl.textContent = currentVideoTitle;
  videoStatusEl.textContent = "Checking...";
  videoStatusEl.className = "video-status";
  if (!settings.apiKey) { showScreen("setup"); return; }
  triggerIndexing(videoId);
}

// ── Indexing ──────────────────────────────────────────────────────────────────
async function triggerIndexing(videoId) {
  try {
    const res = await safeFetch(`${API_BASE}/status/${videoId}`);
    if (res.ok) {
      const data = await safeJson(res);
      if (data && data.is_indexed) {
        isIndexed = true;
        videoStatusEl.textContent = `✓ Ready (${data.num_chunks} chunks cached)`;
        videoStatusEl.className = "video-status indexed";
        btnReindex.classList.remove("hidden");
        showChatScreen();
        return;
      }
    }
  } catch (e) {
    if (isNetworkError(e)) { showBackendError(); return; }
  }

  isIndexed = false;
  showScreen("indexing");
  videoStatusEl.textContent = "Indexing...";
  videoStatusEl.className = "video-status indexing";
  indexingDesc.textContent = "Reading transcript from YouTube player...";

  try {
    const data = await indexCurrentVideo(videoId, false);
    isIndexed = true;
    videoStatusEl.textContent = `✓ Ready (${data.num_chunks} chunks)`;
    videoStatusEl.className = "video-status indexed";
    btnReindex.classList.remove("hidden");
    showChatScreen();
  } catch (e) {
    console.error("Indexing error:", e);
    if (isNetworkError(e)) { showBackendError(); return; }
    videoStatusEl.textContent = "✗ Indexing failed";
    videoStatusEl.className = "video-status";
    showIndexingError(e.message);
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

// ── Browser Transcript Collection ─────────────────────────────────────────────
/**
 * Runs inside the YouTube tab via executeScript.
 * Reads ytInitialPlayerResponse (always present on YouTube watch pages),
 * picks the best caption track, fetches it as json3 (reliable JSON format),
 * and returns the segments.
 *
 * KEY FIX:
   Use browser context + json3.
   YouTube may reject bare timedtext requests.
 */
function _browserTranscriptScript() {
  /* --- helper: get playerResponse from page --- */
  function getPlayerResponse() {
    // Primary: live window object (always current in SPA navigation)
    if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === "object") {
      return window.ytInitialPlayerResponse;
    }
    // Fallback: parse from script tags (first load)
    for (const script of Array.from(document.scripts)) {
      const text = script.textContent || "";
      if (!text.includes("ytInitialPlayerResponse")) continue;
      const idx = text.indexOf("ytInitialPlayerResponse");
      const start = text.indexOf("{", idx);
      if (start === -1) continue;
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) { esc = !esc && c === "\\"; if (!esc && c === '"') inStr = false; continue; }
        if (c === '"') { inStr = true; continue; }
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { break; } } }
      }
    }
    return null;
  }

  /* --- helper: pick best track --- */
  function pickTrack(tracks) {
    const enManual = tracks.find(t => t.languageCode?.startsWith("en") && t.kind !== "asr");
    const anyManual = tracks.find(t => t.kind !== "asr");
    const enAuto = tracks.find(t => t.languageCode?.startsWith("en") && t.kind === "asr");
    return enManual || anyManual || enAuto || tracks[0] || null;
  }

  /* --- helper: parse json3 response --- */
  function parseJson3(data) {
    const segments = [];
    for (const event of (data.events || [])) {
      const text = (event.segs || []).map(s => s.utf8 || "").join("").trim();
      if (!text || text === "\n") continue;
      segments.push({
        text,
        start: (event.tStartMs || 0) / 1000,
        duration: (event.dDurationMs || 0) / 1000,
      });
    }
    return segments;
  }

  /* --- main --- */
  return (async () => {
    const pr = getPlayerResponse();
    if (!pr) return { error: "ytInitialPlayerResponse not found on page" };

    const tracks = (pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [])
      .filter(t => t && t.baseUrl);

    if (!tracks.length) return { error: "No caption tracks found in playerResponse" };

    const track = pickTrack(tracks);
    if (!track) return { error: "Could not select a caption track" };

    // Build json3 URL — append fmt=json3 to get structured JSON instead of XML
    const url = new URL(track.baseUrl);
    url.searchParams.set("fmt", "json3");

    let response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        credentials: "omit",
        headers: {
          "Accept": "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9"
        }
      });
    } catch (e) {
      return { error: `Fetch failed: ${e.message}` };
    }

    if (!response.ok) return { error: `HTTP ${response.status} from timedtext API` };

    let body;

    const contentType = response.headers.get("content-type") || "";

    try {

      const text = await response.text();

      console.log(
        "YT transcript response:",
        contentType,
        text.slice(0, 200)
      );


      if (!text || !text.trim()) {
        return {
          error:
            `Empty transcript response. Content-Type=${contentType}`
        };
      }


      const trimmed = text.trim();

      // Handle XML response (YouTube default format for some tracks)
      if (trimmed.startsWith("<") || trimmed.startsWith("<?xml")) {
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, "text/xml");
        if (!xml.querySelector("parsererror")) {
          const xmlSegs = Array.from(xml.getElementsByTagName("text"))
            .map(n => ({
              text: (n.textContent || "")
                .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">").replace(/&#39;/g, "'")
                .replace(/&quot;/g, '"').trim(),
              start:    parseFloat(n.getAttribute("start")   || "0"),
              duration: parseFloat(n.getAttribute("dur")     || "0"),
            }))
            .filter(s => s.text);
          if (xmlSegs.length) {
            return {
              segments:    xmlSegs,
              language:    track.languageCode || "unknown",
              is_generated: track.kind === "asr",
              source:      "browser",
            };
          }
        }
        return { error: `XML returned but contained no segments. Content: ${text.slice(0,100)}` };
      }

      if (!trimmed.startsWith("{")) {
        return {
          error: `YouTube returned unexpected format. Content-Type=${contentType} Body=${text.slice(0, 150)}`
        };
      }

      body = JSON.parse(text);


    } catch (e) {

      return {
        error:
          `Transcript parsing failed: ${e.message}`
      };

    }

    const segments = parseJson3(body);
    if (!segments.length) return { error: "Parsed 0 segments from json3 response" };

    return {
      segments,
      language: track.languageCode || "unknown",
      is_generated: track.kind === "asr",
      source: "browser",
    };
  })();
}

async function collectBrowserTranscript() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes("youtube.com/watch")) return null;

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   _browserTranscriptScript,
      world:  "MAIN",  // CRITICAL: access page's window + YouTube cookies
    });
  } catch (e) {
    console.warn("executeScript failed:", e);
    return null;
  }

  const result = results?.[0]?.result;
  if (!result) { console.warn("executeScript returned no result"); return null; }
  if (result.error) { console.warn("Browser transcript error:", result.error); return null; }
  if (!result.segments?.length) { console.warn("Browser transcript: 0 segments"); return null; }

  console.log(`Browser transcript: ${result.segments.length} segments, lang=${result.language}`);
  return result;
}

async function indexCurrentVideo(videoId, forceReindex) {
  // Step 1: Try to collect transcript from the browser tab (bypasses bot detection)
  indexingDesc.textContent = "Reading captions from YouTube player...";
  let transcript = null;
  try {
    transcript = await collectBrowserTranscript();
  } catch (e) {
    console.warn("collectBrowserTranscript threw:", e);
  }

  if (transcript?.segments?.length) {
    indexingDesc.textContent = `Got ${transcript.segments.length} caption segments. Indexing...`;
  } else {
    // Step 2: No browser transcript — fall back to backend fetch
    console.warn("Browser transcript unavailable, letting backend try");
    indexingDesc.textContent = "Fetching transcript via backend...";
    transcript = null; // send nothing, backend will try youtube-transcript-api
  }

  const payload = {
    video_id: videoId,
    force_reindex: forceReindex,
    llm_config: buildLLMConfig(),
  };
  if (transcript) payload.transcript = transcript;

  const res = await safeFetch(`${API_BASE}/index`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
  return data;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function safeFetch(url, options) { return fetch(url, options); }

async function safeJson(res) {
  const text = await res.text();
  if (!text?.trim()) return null;
  try { return JSON.parse(text); }
  catch { return { detail: text.slice(0, 200).replace(/<[^>]+>/g, " ").trim() }; }
}

function isNetworkError(e) {
  return e instanceof TypeError && /fetch|network|Failed to fetch|NetworkError/i.test(e.message);
}

function showBackendError() {
  showScreen("no-video");
  stateNoVideo.innerHTML = `
    <div class="state-icon">🔌</div>
    <h2 class="state-title">Backend not running</h2>
    <p class="state-desc">Start the server first:<br>
    <code style="background:var(--bg-card);padding:4px 8px;border-radius:4px;font-size:12px;margin-top:8px;display:inline-block">double-click start.bat</code>
    <br><br>Then reload this panel.</p>
  `;
}

function showChatScreen() {
  showScreen("chat");
  if (messagesEl.children.length === 0) renderWelcomeMessage();
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

  let fullAnswer = "", usedRag = true, citations = [];
  const bubbleEl = assistantMsgEl.querySelector(".message-bubble");
  const cursorEl = bubbleEl.querySelector(".streaming-cursor");
  const loadingIndicator = bubbleEl.querySelector("#loading-indicator");
  const badgeEl = assistantMsgEl.querySelector(".route-badge");

  try {
    const res = await safeFetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_id: currentVideoId,
        question,
        llm_config: buildLLMConfig(),
        conversation_history: conversationHistory,
      }),
    });
    if (!res.ok) { const d = await safeJson(res); throw new Error(d?.detail || `Server error ${res.status}`); }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const textNode = document.createTextNode("");
    bubbleEl.insertBefore(textNode, cursorEl);
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") break;
        let event;
        try { event = JSON.parse(raw); } catch { continue; }
        if (event.type === "route") {
          const isGeneral = event.value === "general";
          usedRag = !isGeneral;
          if (badgeEl) { badgeEl.className = `route-badge ${isGeneral ? "general" : "rag"}`; badgeEl.textContent = isGeneral ? "🌐 General Knowledge" : "📹 Video Grounded"; }
        } else if (event.type === "citations") {
          citations = event.data;
        } else if (event.type === "token") {
          if (loadingIndicator && loadingIndicator.parentNode) {
            loadingIndicator.remove();
            cursorEl.classList.remove("hidden");
          }
          fullAnswer += event.content;
          textNode.textContent = fullAnswer;
          scrollToBottom();
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    }

    if (cursorEl) cursorEl.remove();
    bubbleEl.innerHTML = formatAnswer(fullAnswer);
    if (citations.length > 0 && usedRag)
      assistantMsgEl.querySelector(".message-content").appendChild(renderCitations(citations));
    conversationHistory.push({ role: "user", content: question });
    conversationHistory.push({ role: "assistant", content: fullAnswer });
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
  el.innerHTML = `<div class="message-avatar">👤</div><div class="message-content"><div class="message-bubble">${escapeHtml(text)}</div></div>`;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function addAssistantMessagePlaceholder() {
  const el = document.createElement("div");
  el.className = "message assistant";
  el.innerHTML = `<div class="message-avatar">✨</div><div class="message-content"><div class="route-badge rag">📹 Video Grounded</div><div class="message-bubble"><div class="typing-indicator" id="loading-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div><span class="streaming-cursor hidden"></span></div></div>`;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
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
      updateSendButton(); updateCharCount(); sendMessage();
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
    chip.addEventListener("click", (e) => { e.preventDefault(); jumpToTimestamp(c.start_seconds); });
    div.appendChild(chip);
  });
  return div;
}

function formatAnswer(text) {
  let html = String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    
  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  
  // Code
  html = html.replace(/`(.*?)`/g, "<code style='background:var(--bg-input);padding:1px 4px;border-radius:3px'>$1</code>");

  // Lists (bullet points and numbers)
  html = html.replace(/^([ \t]*)([\*\-\+]|\d+\.) (.+)$/gm, (match, indent, marker, content) => {
      let margin = indent.length * 8 + 12;
      let symbol = ['*', '-', '+'].includes(marker) ? '•' : marker;
      return `</div><div style="margin-left: ${margin}px; display: flex; gap: 8px; margin-bottom: 6px;"><span style="min-width: 12px; flex-shrink: 0; color: var(--text-muted);">${symbol}</span><span>${content}</span></div><div class="text-block">`;
  });

  // Wrap in text blocks to isolate list styles from paragraphs
  html = `<div class="text-block">${html}</div>`;
  html = html.replace(/<div class="text-block">\s*<\/div>/g, "");
  
  // Convert newlines to <br> inside regular text blocks
  html = html.replace(/<div class="text-block">([\s\S]*?)<\/div>/g, (match, content) => {
      return `<div class="text-block" style="margin-bottom: 8px;">${content.trim().replace(/\n/g, '<br>')}</div>`;
  });

  return html;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function jumpToTimestamp(seconds) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (s) => { const v = document.querySelector("video"); if (v) { v.currentTime = s; v.play().catch(() => { }); } },
      args: [seconds],
    });
  } catch (e) { console.warn("jumpToTimestamp:", e); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildLLMConfig() {
  return { provider: settings.provider, api_key: settings.apiKey, chat_model: settings.chatModel, temperature: settings.temperature };
}

function updateSendButton() {
  sendBtn.disabled = !(chatInput.value.trim().length > 0 && !isStreaming && isIndexed && settings.apiKey);
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
  btnSettings.addEventListener("click", () => settingsPanel.classList.remove("hidden"));
  btnCloseSettings.addEventListener("click", () => settingsPanel.classList.add("hidden"));
  $("btn-open-settings-setup").addEventListener("click", () => settingsPanel.classList.remove("hidden"));
  $("settings-form").addEventListener("submit", (e) => { e.preventDefault(); saveSettings(); });
  document.querySelectorAll('input[name="provider"]').forEach(radio => {
    radio.addEventListener("change", () => { settings.provider = radio.value; updateProviderUI(radio.value); });
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
    videoStatusEl.className = "video-status indexing";
    try {
      const data = await indexCurrentVideo(currentVideoId, true);
      isIndexed = true;
      videoStatusEl.textContent = `✓ Re-indexed (${data.num_chunks} chunks)`;
      videoStatusEl.className = "video-status indexed";
      btnReindex.classList.remove("hidden");
      showChatScreen();
    } catch (e) {
      videoStatusEl.textContent = `✗ ${e.message}`;
      videoStatusEl.className = "video-status";
    }
  });
  chatInput.addEventListener("input", () => {
    updateSendButton(); updateCharCount();
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