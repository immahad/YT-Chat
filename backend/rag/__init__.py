"""
rag/__init__.py
"""
from .llm_factory import get_chat_llm, get_embeddings, get_query_embeddings
from .transcript import fetch_transcript, VideoTranscript
from .indexer import index_video, load_vector_store, is_indexed, delete_index
from .retriever import retrieve
from .chain import (
    route_question,
    answer_with_rag,
    answer_general,
    stream_rag_answer,
    stream_general_answer,
    build_citations,
    seconds_to_timestamp,
)

__all__ = [
    "get_chat_llm", "get_embeddings", "get_query_embeddings",
    "fetch_transcript", "VideoTranscript",
    "index_video", "load_vector_store", "is_indexed", "delete_index",
    "retrieve",
    "route_question", "answer_with_rag", "answer_general",
    "stream_rag_answer", "stream_general_answer",
    "build_citations", "seconds_to_timestamp",
]
