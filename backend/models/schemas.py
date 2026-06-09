"""
Pydantic request/response models for the YT Chat API.
"""
from pydantic import BaseModel, Field
from typing import Literal, Optional


# ── Provider & Model Configs ──────────────────────────────────────────────────

class LLMConfig(BaseModel):
    """User's LLM configuration sent from the Chrome extension."""
    provider: Literal["google", "openai", "anthropic", "grok"] = "google"
    api_key: str = Field(..., description="The user's API key for the chosen provider")
    # Optional second key needed for Anthropic/Grok (which have no embeddings)
    google_api_key: Optional[str] = Field(
        None,
        description="Google API key for embeddings (required if provider is anthropic or grok)"
    )
    chat_model: str = Field(
        "gemini-2.0-flash",
        description="Chat model name. Defaults to Gemini 2.0 Flash."
    )
    temperature: float = Field(0.2, ge=0.0, le=1.0)


# ── Index Endpoint ────────────────────────────────────────────────────────────

class IndexRequest(BaseModel):
    """Request to index a YouTube video's transcript."""
    video_id: str = Field(..., description="YouTube video ID (e.g. 'Gfr50f6ZBvo')")
    llm_config: LLMConfig
    force_reindex: bool = Field(
        False,
        description="If True, re-index even if video is already cached"
    )


class IndexResponse(BaseModel):
    video_id: str
    status: Literal["indexed", "already_cached", "error"]
    num_chunks: int = 0
    message: str = ""


# ── Chat Endpoint ─────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    """Request to chat about a YouTube video."""
    video_id: str
    question: str = Field(..., min_length=1)
    llm_config: LLMConfig
    conversation_history: list[dict] = Field(
        default_factory=list,
        description="Previous turns: [{'role': 'user'|'assistant', 'content': '...'}]"
    )


class CitationChunk(BaseModel):
    """A retrieved transcript chunk with its timestamp."""
    content:         str
    start_seconds:   float = 0.0    # timestamp in seconds (for jump-to link)
    timestamp_label: str   = ""     # human-readable label e.g. "1:33"
    relevance_score: float = 0.0


class ChatResponse(BaseModel):
    answer:     str
    citations:  list[CitationChunk] = []
    used_rag:   bool = True         # False if routed to general knowledge
    tokens_used: int = 0


# ── Status Endpoint ───────────────────────────────────────────────────────────

class StatusResponse(BaseModel):
    video_id: str
    is_indexed: bool
    num_chunks: int = 0


# ── Evaluate Endpoint ─────────────────────────────────────────────────────────

class EvalSample(BaseModel):
    question: str
    ground_truth: str


class EvaluateRequest(BaseModel):
    video_id: str
    samples: list[EvalSample]
    llm_config: LLMConfig


class EvaluateResponse(BaseModel):
    faithfulness: float = 0.0
    answer_relevancy: float = 0.0
    context_precision: float = 0.0
    context_recall: float = 0.0
