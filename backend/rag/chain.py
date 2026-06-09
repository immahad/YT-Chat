"""
rag/chain.py
────────────
The main RAG chain orchestrator.

Features:
  - Simple Agent Router: decides RAG (transcript-grounded) vs General Knowledge
  - Timestamp-Grounded Answers: cites specific moments from the video
  - Guard Rails: if no relevant context found, explicitly says so
  - Conversation Memory: maintains chat history per video session
  - Streaming-ready: returns a generator for token-by-token output
"""

from __future__ import annotations
import logging
from typing import TYPE_CHECKING, Generator

from langchain_core.documents import Document
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from langchain_core.output_parsers import StrOutputParser

if TYPE_CHECKING:
    from langchain_core.language_models import BaseChatModel
    from langchain_chroma import Chroma
    from langchain_core.embeddings import Embeddings
    from models.schemas import CitationChunk

logger = logging.getLogger(__name__)

# ── Guard Rail Threshold ──────────────────────────────────────────────────────
# If no docs are retrieved OR all docs have very short content, refuse to answer.
MIN_CONTEXT_LENGTH = 50   # characters


# ── Agent Router Prompt ───────────────────────────────────────────────────────

ROUTER_PROMPT = """You are a routing agent for a YouTube video Q&A assistant.
Decide if the user's question requires searching the video transcript (RAG)
or if it can be answered from general knowledge without the transcript.

Respond with EXACTLY one word: "RAG" or "GENERAL"

Rules:
- RAG: question is about video content, what was said, specific topics discussed, timestamps, speakers
- GENERAL: question is a generic fact not related to this video (e.g. "what is Python?", "who is Einstein?")
- When in doubt, choose RAG

User question: {question}

Answer (RAG or GENERAL):"""


def route_question(question: str, llm: "BaseChatModel") -> str:
    """Returns 'RAG' or 'GENERAL'."""
    from langchain_core.prompts import PromptTemplate
    prompt = PromptTemplate.from_template(ROUTER_PROMPT)
    chain = prompt | llm | StrOutputParser()
    try:
        result = chain.invoke({"question": question}).strip().upper()
        if "GENERAL" in result:
            logger.info(f"Router decision: GENERAL for '{question[:50]}'")
            return "GENERAL"
        logger.info(f"Router decision: RAG for '{question[:50]}'")
        return "RAG"
    except Exception as e:
        logger.warning(f"Router failed: {e}. Defaulting to RAG.")
        return "RAG"


# ── Timestamp Formatting ──────────────────────────────────────────────────────

def seconds_to_timestamp(seconds: float) -> str:
    """Convert 93.5 seconds → '1:33'."""
    total = int(seconds)
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def format_context_with_timestamps(docs: list[Document]) -> str:
    """
    Format retrieved docs into context string with timestamp labels.
    Example:
        [at 1:33] The speaker discussed nuclear fusion...
        [at 4:12] DeepMind collaborated with EPFL...
    """
    parts = []
    for doc in docs:
        start = doc.metadata.get("start_seconds", 0.0)
        ts = seconds_to_timestamp(start)
        parts.append(f"[at {ts}] {doc.page_content.strip()}")
    return "\n\n".join(parts)


# ── RAG System Prompt ─────────────────────────────────────────────────────────

RAG_SYSTEM_PROMPT = """You are YT Chat, an intelligent YouTube video assistant.
You answer questions strictly based on the video transcript provided.

RULES:
1. Answer ONLY from the provided transcript context
2. If the answer is in the context, always cite the timestamp like: (at 1:33) or (at 4:12)
3. If the context doesn't contain enough information, say: "This topic wasn't covered in the video"
4. Be concise but complete. Use bullet points for multi-part answers.
5. Never make up information not present in the transcript
6. Keep answers conversational and helpful

Video transcript context:
{context}"""

GENERAL_SYSTEM_PROMPT = """You are YT Chat, an intelligent YouTube video assistant.
The user's question appears to be a general knowledge question not specific to the video.
Answer it helpfully from your general knowledge.
If you think the question might actually be video-related, mention you can search the transcript if needed."""


# ── Main Chain Functions ──────────────────────────────────────────────────────

def build_chat_history(conversation_history: list[dict]) -> list:
    """Convert dict history to LangChain message objects."""
    messages = []
    for turn in conversation_history:
        role = turn.get("role", "user")
        content = turn.get("content", "")
        if role == "user":
            messages.append(HumanMessage(content=content))
        elif role == "assistant":
            messages.append(AIMessage(content=content))
    return messages


def answer_with_rag(
    question: str,
    docs: list[Document],
    llm: "BaseChatModel",
    conversation_history: list[dict],
) -> tuple[str, list[Document]]:
    """
    Generate a grounded answer from retrieved docs.
    Returns (answer_text, used_docs).
    """
    # Guard rail: check if context is sufficient
    total_context = " ".join(doc.page_content for doc in docs)
    if len(total_context.strip()) < MIN_CONTEXT_LENGTH:
        return "This topic wasn't covered in the video.", []

    context = format_context_with_timestamps(docs)
    history = build_chat_history(conversation_history)

    prompt = ChatPromptTemplate.from_messages([
        SystemMessage(content=RAG_SYSTEM_PROMPT.format(context=context)),
        MessagesPlaceholder(variable_name="history"),
        HumanMessage(content=question),
    ])

    chain = prompt | llm | StrOutputParser()

    try:
        answer = chain.invoke({"history": history})
        return answer, docs
    except Exception as e:
        logger.error(f"RAG answer generation failed: {e}")
        raise


def answer_general(
    question: str,
    llm: "BaseChatModel",
    conversation_history: list[dict],
) -> str:
    """Generate a general knowledge answer (no RAG)."""
    history = build_chat_history(conversation_history)

    prompt = ChatPromptTemplate.from_messages([
        SystemMessage(content=GENERAL_SYSTEM_PROMPT),
        MessagesPlaceholder(variable_name="history"),
        HumanMessage(content=question),
    ])

    chain = prompt | llm | StrOutputParser()
    return chain.invoke({"history": history})


def stream_rag_answer(
    question: str,
    docs: list[Document],
    llm: "BaseChatModel",
    conversation_history: list[dict],
) -> Generator[str, None, None]:
    """
    Streaming version of answer_with_rag.
    Yields tokens one by one for real-time display in the sidebar.
    """
    total_context = " ".join(doc.page_content for doc in docs)
    if len(total_context.strip()) < MIN_CONTEXT_LENGTH:
        yield "This topic wasn't covered in the video."
        return

    context = format_context_with_timestamps(docs)
    history = build_chat_history(conversation_history)

    prompt = ChatPromptTemplate.from_messages([
        SystemMessage(content=RAG_SYSTEM_PROMPT.format(context=context)),
        MessagesPlaceholder(variable_name="history"),
        HumanMessage(content=question),
    ])

    chain = prompt | llm | StrOutputParser()

    try:
        for chunk in chain.stream({"history": history}):
            yield chunk
    except Exception as e:
        logger.error(f"Streaming RAG failed: {e}")
        yield f"\n\n[Error generating response: {str(e)}]"


def stream_general_answer(
    question: str,
    llm: "BaseChatModel",
    conversation_history: list[dict],
) -> Generator[str, None, None]:
    """Streaming general knowledge answer."""
    history = build_chat_history(conversation_history)

    prompt = ChatPromptTemplate.from_messages([
        SystemMessage(content=GENERAL_SYSTEM_PROMPT),
        MessagesPlaceholder(variable_name="history"),
        HumanMessage(content=question),
    ])

    chain = prompt | llm | StrOutputParser()

    try:
        for chunk in chain.stream({"history": history}):
            yield chunk
    except Exception as e:
        logger.error(f"Streaming general answer failed: {e}")
        yield f"\n\n[Error: {str(e)}]"


# ── Citation Builder ──────────────────────────────────────────────────────────

def build_citations(docs: list[Document]) -> list[dict]:
    """
    Build citation objects from retrieved documents.
    These are sent to the frontend so it can render clickable timestamp chips.
    """
    citations = []
    seen_starts = set()

    for doc in docs:
        start = doc.metadata.get("start_seconds", 0.0)
        # Deduplicate by rounded timestamp (within 2 seconds)
        key = round(start / 2) * 2
        if key in seen_starts:
            continue
        seen_starts.add(key)

        citations.append({
            "content":         doc.page_content[:200] + "..." if len(doc.page_content) > 200 else doc.page_content,
            "start_seconds":   start,
            "timestamp_label": seconds_to_timestamp(start),
        })

    return citations
