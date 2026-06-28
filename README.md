# YT Chat — AI YouTube Video Assistant 🎬💬

A production-level Chrome Extension that adds an **AI-powered chat panel** beside any YouTube video. Ask questions about the video content and get **grounded answers with clickable timestamp citations** — powered by an advanced RAG pipeline using LangChain.

---

## ✨ Features

| Feature | Details |
|---|---|
| **Multi-Provider LLM** | Groq (default, free), OpenAI |
| **Advanced RAG** | Multi-query, Hybrid retrieval, MMR, Cross-encoder reranking |
| **Smart Caching** | Video transcripts indexed once, reused forever |
| **Timestamp Citations** | Click a citation chip to jump to that moment in the video |
| **Streaming Responses** | Tokens stream in real-time, like ChatGPT |
| **Agent Router** | Decides RAG vs General Knowledge automatically |
| **Conversation Memory** | Remembers previous questions in the same session |

---

## 🚀 Quick Start

### Step 1: Start the Backend Server

**Double-click `start.bat`** — it will:
1. Create a Python virtual environment
2. Install all dependencies (~5 minutes first time)
3. Ask you to fill in your API key in `.env`
4. Start the server at `http://localhost:8000`

Or manually:
```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

### Step 2: Configure API Key

Edit `backend/.env` (optional, since you can enter it in the extension UI directly):
```env
GROQ_API_KEY=your_groq_api_key_here
```

Get a **free** Groq API key at: https://console.groq.com/keys

### Step 3: Load the Chrome Extension

1. Open Chrome → navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **"Load unpacked"**
4. Select the `extension/` folder
5. The YT Chat icon appears in your toolbar ✅

### Step 4: Use It!

1. Open any YouTube video
2. Click the **YT Chat icon** in your toolbar
3. The side panel opens → video auto-detects and indexes (~3-8 seconds)
4. Ask anything! 💬

---

## 🏗️ Project Structure

```
YT Chat/
├── start.bat                   ← One-click server start
├── extension/                  ← Chrome Extension (load this folder)
│   ├── manifest.json           ← Extension config (MV3)
│   ├── background.js           ← Service worker
│   ├── content.js              ← YouTube page detector
│   ├── sidebar/
│   │   ├── sidebar.html        ← Chat UI
│   │   ├── sidebar.css         ← YouTube-themed styles
│   │   └── sidebar.js          ← Chat logic + streaming
│   └── icons/                  ← Extension icons
└── backend/                    ← Python FastAPI RAG Server
    ├── main.py                 ← FastAPI app + endpoints
    ├── requirements.txt
    ├── .env                    ← Your API keys (create from .env.example)
    ├── rag/
    │   ├── llm_factory.py      ← Multi-provider LLM + embeddings
    │   ├── transcript.py       ← YouTube transcript fetcher
    │   ├── indexer.py          ← ChromaDB + chunking
    │   ├── retriever.py        ← Hybrid + MMR + reranking
    │   └── chain.py            ← RAG chain + streaming
    ├── models/
    │   └── schemas.py          ← Pydantic API models
    └── storage/
        └── chroma_db/          ← Persistent vector store (auto-created)
```

---

## 🔑 API Key Configuration

| Provider | Chat Model | Embedding | Get Key |
|---|---|---|---|
| **Groq** (default, free) | llama-3.3-70b-versatile | HuggingFace (all-MiniLM-L6-v2) | [console.groq.com](https://console.groq.com/keys) |
| OpenAI | gpt-4o-mini | text-embedding-3-small | [platform.openai.com](https://platform.openai.com/api-keys) |

---

## 🧠 Advanced RAG Pipeline

```
User Question
    │
    ▼
[Agent Router] ──── GENERAL ────► LLM General Knowledge Answer
    │
   RAG
    │
    ▼
[Multi-Query Generator]
  Generates 3 alternative queries
    │
    ▼
[Hybrid Retrieval]
  Dense (ChromaDB MMR) + Sparse (BM25)
  → Reciprocal Rank Fusion (RRF)
    │
    ▼
[Cross-Encoder Reranking]
  Local ms-marco-MiniLM cross-encoder
    │
    ▼
[Contextual Compression]
  LLMChainExtractor trims verbose chunks
    │
    ▼
[Answer Generation]
  Grounded answer + timestamp citations
    │
    ▼
[Streaming SSE]
  Token-by-token to the sidebar
```

---

## 🔧 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Server health check |
| GET | `/status/{video_id}` | Is this video indexed? |
| POST | `/index` | Index a video transcript |
| POST | `/chat` | Stream chat response (SSE) |
| DELETE | `/index/{video_id}` | Delete a video's index |

Interactive docs: http://localhost:8000/docs

---

## 📦 Dependencies

**Backend**: FastAPI, LangChain, ChromaDB, sentence-transformers, BM25, youtube-transcript-api, langchain-groq, langchain-openai, langchain-huggingface

**Extension**: Pure HTML/CSS/JavaScript (no build step required!)
