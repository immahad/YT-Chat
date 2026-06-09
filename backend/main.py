"""
main.py  —  YT Chat FastAPI Backend
────────────────────────────────────
Endpoints:
  GET  /health              — Health check
  GET  /status/{video_id}   — Is video indexed?
  POST /index               — Index a YouTube video
  POST /chat                — Ask a question (streaming SSE)
  DELETE /index/{video_id}  — Delete a video's index
"""

from __future__ import annotations
import json
import logging
import os
import asyncio
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

load_dotenv()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("ytchat")

# ── Import RAG modules ────────────────────────────────────────────────────────
from models import (
    IndexRequest, IndexResponse,
    ChatRequest,
    StatusResponse,
)
from rag import (
    get_chat_llm, get_embeddings,
    fetch_transcript,
    index_video, load_vector_store, is_indexed, delete_index,
    retrieve, route_question,
    stream_rag_answer, stream_general_answer,
    build_citations,
)


# ── App Lifecycle ─────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Warm up the cross-encoder on startup so first request isn't slow."""
    logger.info("🚀 YT Chat backend starting...")
    try:
        from rag.retriever import _get_cross_encoder
        await asyncio.get_event_loop().run_in_executor(None, _get_cross_encoder)
        logger.info("✅ Cross-encoder loaded and ready")
    except Exception as e:
        logger.warning(f"Cross-encoder warm-up failed (will load on first request): {e}")
    yield
    logger.info("👋 YT Chat backend shutting down")


# ── FastAPI App ───────────────────────────────────────────────────────────────

app = FastAPI(
    title="YT Chat — RAG API",
    description="Production RAG backend for the YT Chat Chrome Extension",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS: Allow all origins — the Chrome extension's ID changes per install,
# so we must use wildcard. This is safe since the backend runs locally only.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Accept", "Authorization"],
)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "YT Chat RAG API"}


@app.get("/status/{video_id}", response_model=StatusResponse)
async def get_status(video_id: str):
    """Check if a video is already indexed in ChromaDB."""
    indexed, count = is_indexed(video_id)
    return StatusResponse(
        video_id=video_id,
        is_indexed=indexed,
        num_chunks=count,
    )


@app.post("/index", response_model=IndexResponse)
async def index_video_endpoint(request: IndexRequest):
    """
    Fetch the YouTube transcript, chunk it, embed it, and store in ChromaDB.
    If already cached and force_reindex=False, returns immediately.
    """
    video_id = request.video_id.strip()

    # Check cache first
    if not request.force_reindex:
        already, count = is_indexed(video_id)
        if already:
            logger.info(f"Cache hit: {video_id} already indexed ({count} chunks)")
            return IndexResponse(
                video_id=video_id,
                status="already_cached",
                num_chunks=count,
                message=f"Video already indexed with {count} chunks. Ready to chat!",
            )

    try:
        # 1. Fetch transcript
        logger.info(f"Fetching transcript for: {video_id}")
        transcript = await asyncio.get_event_loop().run_in_executor(
            None, fetch_transcript, video_id
        )

        # 2. Get embeddings model
        embeddings = get_embeddings(request.llm_config)

        # 3. Index (chunk + embed + store)
        _, num_chunks = await asyncio.get_event_loop().run_in_executor(
            None, lambda: index_video(transcript, embeddings, force=request.force_reindex)
        )

        return IndexResponse(
            video_id=video_id,
            status="indexed",
            num_chunks=num_chunks,
            message=f"Successfully indexed {num_chunks} chunks. Ready to chat!",
        )

    except Exception as e:
        logger.error(f"Indexing failed for {video_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to index video: {str(e)}"
        )


@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    """
    Ask a question about the indexed video.
    Returns a Server-Sent Events (SSE) stream for real-time token delivery.

    SSE event format:
      data: {"type": "token", "content": "hello"}
      data: {"type": "citations", "data": [...]}
      data: {"type": "done", "used_rag": true}
      data: [DONE]
    """
    video_id = request.video_id.strip()
    question = request.question.strip()

    # Validate video is indexed
    indexed, _ = is_indexed(video_id)
    if not indexed:
        raise HTTPException(
            status_code=404,
            detail=f"Video '{video_id}' is not indexed. Call /index first."
        )

    async def event_generator():
        try:
            loop = asyncio.get_event_loop()

            # 1. Build LLM and embeddings
            llm        = get_chat_llm(request.llm_config)
            embeddings = get_embeddings(request.llm_config)

            # 2. Load vector store
            vector_store = load_vector_store(video_id, embeddings)

            # 3. Agent router
            route = await loop.run_in_executor(
                None, lambda: route_question(question, llm)
            )

            if route == "GENERAL":
                # Stream general knowledge answer
                yield f"data: {json.dumps({'type': 'route', 'value': 'general'})}\n\n"

                def gen_general():
                    return list(stream_general_answer(
                        question,
                        llm,
                        request.conversation_history,
                    ))

                tokens = await loop.run_in_executor(None, gen_general)
                for token in tokens:
                    yield f"data: {json.dumps({'type': 'token', 'content': token})}\n\n"

                yield f"data: {json.dumps({'type': 'done', 'used_rag': False})}\n\n"
                yield "data: [DONE]\n\n"
                return

            # 4. RAG path: retrieve relevant chunks
            yield f"data: {json.dumps({'type': 'route', 'value': 'rag'})}\n\n"

            # Get all docs for BM25 (needed for hybrid retrieval)
            # langchain-chroma wraps chromadb's get() — returns a dict with
            # 'documents' (list of strings) and 'metadatas' (list of dicts)
            all_docs = []
            try:
                all_docs_raw = vector_store.get()
                doc_texts  = all_docs_raw.get("documents") or []
                doc_metas  = all_docs_raw.get("metadatas") or [{}] * len(doc_texts)
                from langchain_core.documents import Document
                for doc_text, meta in zip(doc_texts, doc_metas):
                    if doc_text:
                        all_docs.append(Document(
                            page_content=doc_text,
                            metadata=meta or {}
                        ))
            except Exception as e:
                logger.warning(f"Could not fetch all docs for BM25: {e}. BM25 disabled.")

            # Retrieve
            retrieved_docs = await loop.run_in_executor(
                None,
                lambda: retrieve(question, vector_store, all_docs, embeddings, llm)
            )

            # 5. Build and send citations before streaming answer
            citations = build_citations(retrieved_docs)
            yield f"data: {json.dumps({'type': 'citations', 'data': citations})}\n\n"

            # 6. Stream answer tokens
            def gen_rag():
                return list(stream_rag_answer(
                    question,
                    retrieved_docs,
                    llm,
                    request.conversation_history,
                ))

            tokens = await loop.run_in_executor(None, gen_rag)
            for token in tokens:
                yield f"data: {json.dumps({'type': 'token', 'content': token})}\n\n"

            yield f"data: {json.dumps({'type': 'done', 'used_rag': True})}\n\n"
            yield "data: [DONE]\n\n"

        except Exception as e:
            logger.error(f"Chat error for {video_id}: {e}", exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.delete("/index/{video_id}")
async def delete_index_endpoint(video_id: str):
    """Remove a video's index from ChromaDB."""
    success = delete_index(video_id)
    if success:
        return {"status": "deleted", "video_id": video_id}
    raise HTTPException(status_code=404, detail=f"No index found for video '{video_id}'")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "localhost"),
        port=int(os.getenv("PORT", 8000)),
        reload=True,
        log_level="info",
    )
