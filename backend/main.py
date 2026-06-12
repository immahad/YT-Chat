"""
main.py  —  YT Chat FastAPI Backend
"""

from __future__ import annotations
import json
import logging
import os
import asyncio
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.exceptions import RequestValidationError

load_dotenv()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("ytchat")

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
from rag.transcript import TranscriptSegment, VideoTranscript


# ── App Lifecycle ─────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("🚀 YT Chat backend starting...")
    try:
        from rag.retriever import _get_cross_encoder
        await asyncio.get_event_loop().run_in_executor(None, _get_cross_encoder)
        logger.info("✅ Cross-encoder loaded and ready")
    except Exception as e:
        logger.warning(f"Cross-encoder warm-up failed: {e}")
    yield
    logger.info("👋 YT Chat backend shutting down")


# ── FastAPI App ───────────────────────────────────────────────────────────────

app = FastAPI(title="YT Chat — RAG API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Accept", "Authorization"],
)


# ── Global error handlers — always return JSON ────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception on {request.url}: {exc}", exc_info=True)
    return JSONResponse(status_code=500, content={"detail": str(exc)})

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    logger.warning(f"Validation error on {request.url}: {exc}")
    return JSONResponse(status_code=422, content={"detail": str(exc)})

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "YT Chat RAG API"}


@app.get("/status/{video_id}", response_model=StatusResponse)
async def get_status(video_id: str):
    indexed, count = is_indexed(video_id)
    return StatusResponse(video_id=video_id, is_indexed=indexed, num_chunks=count)


@app.post("/index", response_model=IndexResponse)
async def index_video_endpoint(request: IndexRequest):
    video_id = request.video_id.strip()

    # Cache hit
    if not request.force_reindex:
        already, count = is_indexed(video_id)
        if already:
            logger.info(f"Cache hit: {video_id} ({count} chunks)")
            return IndexResponse(
                video_id=video_id, status="already_cached", num_chunks=count,
                message=f"Already indexed with {count} chunks. Ready to chat!",
            )

    try:
        # ── Path A: Browser transcript supplied by extension (always preferred) ──
        if request.transcript and request.transcript.segments:
            logger.info(f"Using browser transcript for {video_id} "
                        f"({len(request.transcript.segments)} segments)")
            transcript = VideoTranscript(
                video_id=video_id,
                segments=[
                    TranscriptSegment(
                        text=seg.text.strip(),
                        start=float(seg.start or 0.0),
                        duration=float(seg.duration or 0.0),
                    )
                    for seg in request.transcript.segments
                    if seg.text and seg.text.strip()
                ],
                language=request.transcript.language or "unknown",
                is_generated=bool(request.transcript.is_generated),
            )
            if not transcript.segments:
                raise ValueError("Browser transcript contained no usable text segments.")

        # ── Path B: Fallback — library fetch (may fail on some networks) ─────────
        else:
            logger.info(f"No browser transcript — using library fallback for {video_id}")
            transcript = await asyncio.get_event_loop().run_in_executor(
                None, fetch_transcript, video_id
            )

        logger.info(f"Transcript ready: {transcript.num_segments} segments for {video_id}")

        embeddings = get_embeddings(request.llm_config)
        _, num_chunks = await asyncio.get_event_loop().run_in_executor(
            None, lambda: index_video(transcript, embeddings, force=request.force_reindex)
        )

        return IndexResponse(
            video_id=video_id, status="indexed", num_chunks=num_chunks,
            message=f"Indexed {num_chunks} chunks. Ready to chat!",
        )

    except Exception as e:
        logger.error(f"Indexing failed for {video_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to index video: {str(e)}")


@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    video_id = request.video_id.strip()
    question = request.question.strip()

    indexed, _ = is_indexed(video_id)
    if not indexed:
        raise HTTPException(status_code=404,
            detail=f"Video '{video_id}' is not indexed. Call /index first.")

    async def event_generator():
        try:
            loop        = asyncio.get_event_loop()
            llm         = get_chat_llm(request.llm_config)
            embeddings  = get_embeddings(request.llm_config)
            vector_store = load_vector_store(video_id, embeddings)

            route = await loop.run_in_executor(None, lambda: route_question(question, llm))

            if route == "GENERAL":
                yield f"data: {json.dumps({'type': 'route', 'value': 'general'})}\n\n"
                tokens = await loop.run_in_executor(
                    None, lambda: list(stream_general_answer(question, llm, request.conversation_history))
                )
                for token in tokens:
                    yield f"data: {json.dumps({'type': 'token', 'content': token})}\n\n"
                yield f"data: {json.dumps({'type': 'done', 'used_rag': False})}\n\n"
                yield "data: [DONE]\n\n"
                return

            yield f"data: {json.dumps({'type': 'route', 'value': 'rag'})}\n\n"

            all_docs = []
            try:
                raw = vector_store.get()
                from langchain_core.documents import Document
                for txt, meta in zip(raw.get("documents") or [], raw.get("metadatas") or [{}] * len(raw.get("documents") or [])):
                    if txt:
                        all_docs.append(Document(page_content=txt, metadata=meta or {}))
            except Exception as e:
                logger.warning(f"BM25 doc fetch failed: {e}")

            retrieved = await loop.run_in_executor(
                None, lambda: retrieve(question, vector_store, all_docs, embeddings, llm)
            )

            yield f"data: {json.dumps({'type': 'citations', 'data': build_citations(retrieved)})}\n\n"

            tokens = await loop.run_in_executor(
                None, lambda: list(stream_rag_answer(question, retrieved, llm, request.conversation_history))
            )
            for token in tokens:
                yield f"data: {json.dumps({'type': 'token', 'content': token})}\n\n"

            yield f"data: {json.dumps({'type': 'done', 'used_rag': True})}\n\n"
            yield "data: [DONE]\n\n"

        except Exception as e:
            logger.error(f"Chat stream error for {video_id}: {e}", exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete("/index/{video_id}")
async def delete_index_endpoint(video_id: str):
    if delete_index(video_id):
        return {"status": "deleted", "video_id": video_id}
    raise HTTPException(status_code=404, detail=f"No index found for '{video_id}'")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=os.getenv("HOST", "localhost"),
                port=int(os.getenv("PORT", 8000)), reload=True, log_level="info")