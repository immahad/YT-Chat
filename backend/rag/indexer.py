"""
rag/indexer.py
──────────────
Handles chunking, embedding, and ChromaDB vector store management.

Strategy:
  - One ChromaDB *collection* per YouTube video (named "video_{video_id}")
  - Persistent storage → re-visited videos skip re-indexing (cache hit)
  - Text splitting: RecursiveCharacterTextSplitter with timestamp-aware grouping
    (we group segments into windows before splitting, so timestamps stay meaningful)
  - Each chunk stores 'start_seconds' metadata for timestamp citations
"""

from __future__ import annotations
import logging
import os
from typing import TYPE_CHECKING

import chromadb
from langchain_chroma import Chroma
from langchain_core.documents import Document

from .transcript import VideoTranscript

if TYPE_CHECKING:
    from models.schemas import LLMConfig
    from langchain_core.embeddings import Embeddings

logger = logging.getLogger(__name__)

# ChromaDB persistent directory (relative to backend/)
CHROMA_PERSIST_DIR = os.getenv("CHROMA_PERSIST_DIR", "./storage/chroma_db")

# Chunking config
CHUNK_SIZE    = 800    # characters (shorter chunks = more precise citations)
CHUNK_OVERLAP = 150


def _collection_name(video_id: str) -> str:
    """ChromaDB collection names must be alphanumeric + underscores, max 63 chars."""
    safe = "".join(c if c.isalnum() else "_" for c in video_id)
    return f"video_{safe}"[:63]


def _get_chroma_client() -> chromadb.PersistentClient:
    os.makedirs(CHROMA_PERSIST_DIR, exist_ok=True)
    # chromadb v1.x: anonymized_telemetry is a top-level kwarg, not in Settings
    try:
        return chromadb.PersistentClient(
            path=CHROMA_PERSIST_DIR,
            settings=chromadb.Settings(anonymized_telemetry=False),
        )
    except TypeError:
        # Fallback for chromadb v1.x where Settings signature changed
        return chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)


# ── Public API ────────────────────────────────────────────────────────────────

def is_indexed(video_id: str) -> tuple[bool, int]:
    """
    Check if a video's transcript is already stored in ChromaDB.
    Returns (is_indexed, num_chunks).
    """
    try:
        client = _get_chroma_client()
        col = client.get_collection(_collection_name(video_id))
        count = col.count()
        return (count > 0), count
    except Exception:
        return False, 0


def index_video(
    transcript: VideoTranscript,
    embeddings: "Embeddings",
    force: bool = False,
) -> tuple[Chroma, int]:
    """
    Chunk the transcript, generate embeddings, store in ChromaDB.

    Returns:
        (Chroma vector store, num_chunks_stored)
    """
    collection = _collection_name(transcript.video_id)

    # ── Cache check ──────────────────────────────────────────────────────────
    already, count = is_indexed(transcript.video_id)
    if already and not force:
        logger.info(f"Cache hit for {transcript.video_id} ({count} chunks). Skipping indexing.")
        vector_store = Chroma(
            collection_name=collection,
            embedding_function=embeddings,
            persist_directory=CHROMA_PERSIST_DIR,
        )
        return vector_store, count

    # ── Build timestamp-grouped text blocks ──────────────────────────────────
    # Group segments into ~800-char windows, preserving the EARLIEST start_seconds
    # for the group so that each chunk has a meaningful timestamp.
    grouped_docs = _group_segments(transcript)

    # ── Recursive character text splitting ───────────────────────────────────
    from langchain_text_splitters import RecursiveCharacterTextSplitter
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        separators=["\n\n", "\n", ". ", "! ", "? ", " ", ""],
    )
    chunks: list[Document] = splitter.split_documents(grouped_docs)

    # Ensure metadata is propagated (start_seconds, video_id)
    for chunk in chunks:
        chunk.metadata.setdefault("video_id",      transcript.video_id)
        chunk.metadata.setdefault("start_seconds", 0.0)

    logger.info(f"Split into {len(chunks)} chunks for video {transcript.video_id}")

    # ── Delete old collection if force re-indexing ────────────────────────────
    if force and already:
        try:
            client = _get_chroma_client()
            client.delete_collection(collection)
            logger.info(f"Deleted old collection: {collection}")
        except Exception as e:
            logger.warning(f"Could not delete old collection: {e}")

    # ── Embed and store ───────────────────────────────────────────────────────
    vector_store = Chroma.from_documents(
        documents=chunks,
        embedding=embeddings,
        collection_name=collection,
        persist_directory=CHROMA_PERSIST_DIR,
    )

    logger.info(f"Indexed {len(chunks)} chunks into ChromaDB collection '{collection}'")
    return vector_store, len(chunks)


def load_vector_store(video_id: str, embeddings: "Embeddings") -> Chroma:
    """Load an existing ChromaDB collection for a video."""
    return Chroma(
        collection_name=_collection_name(video_id),
        embedding_function=embeddings,
        persist_directory=CHROMA_PERSIST_DIR,
    )


def delete_index(video_id: str) -> bool:
    """Delete a video's ChromaDB collection."""
    try:
        client = _get_chroma_client()
        client.delete_collection(_collection_name(video_id))
        logger.info(f"Deleted index for video {video_id}")
        return True
    except Exception as e:
        logger.error(f"Failed to delete index for {video_id}: {e}")
        return False


# ── Internal helpers ──────────────────────────────────────────────────────────

def _group_segments(
    transcript: VideoTranscript,
    target_chars: int = CHUNK_SIZE,
) -> list[Document]:
    """
    Group small caption segments into larger text blocks (up to ~target_chars).
    Each block's metadata.start_seconds = the first segment's start time.
    This preserves temporal locality so timestamp citations are accurate.
    """
    docs: list[Document] = []
    buffer_texts: list[str] = []
    buffer_start: float = 0.0
    buffer_len: int = 0

    for i, seg in enumerate(transcript.segments):
        text = seg.text.strip()
        if not text:
            continue

        if buffer_len == 0:
            # Start a new buffer
            buffer_start = seg.start

        buffer_texts.append(text)
        buffer_len += len(text) + 1  # +1 for space

        if buffer_len >= target_chars or i == len(transcript.segments) - 1:
            # Flush buffer
            combined = " ".join(buffer_texts)
            docs.append(Document(
                page_content=combined,
                metadata={
                    "video_id":      transcript.video_id,
                    "start_seconds": buffer_start,
                    "language":      transcript.language,
                    "is_generated":  transcript.is_generated,
                }
            ))
            buffer_texts = []
            buffer_start = 0.0
            buffer_len   = 0

    return docs
