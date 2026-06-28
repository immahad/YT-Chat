"""
rag/llm_factory.py
──────────────────
Multi-provider LLM + Embedding factory.

Supported providers:
  - groq    → Groq chat    + HuggingFace embeddings
  - openai  → GPT chat     + text-embedding-3-small

Groq uses HuggingFace embeddings locally since it doesn't provide a native embedding API.
"""

from __future__ import annotations
from typing import TYPE_CHECKING

from langchain_core.language_models import BaseChatModel
from langchain_core.embeddings import Embeddings

if TYPE_CHECKING:
    from models.schemas import LLMConfig


# ── Default model names per provider ─────────────────────────────────────────
DEFAULT_MODELS: dict[str, str] = {
    "groq": "llama-3.3-70b-versatile",
    "openai": "gpt-4o-mini",
}


# ── Chat LLM Factory ─────────────────────────────────────────────────────────

def get_chat_llm(config: "LLMConfig") -> BaseChatModel:
    """
    Return a LangChain chat model based on the user's provider choice.
    No API keys are ever hardcoded — all come from the user's config.
    """
    provider = config.provider
    api_key  = config.api_key
    model    = config.chat_model or DEFAULT_MODELS.get(provider, "gemini-2.0-flash")
    temp     = config.temperature

    if provider == "groq":
        from langchain_groq import ChatGroq
        return ChatGroq(
            model=model,
            api_key=api_key,
            temperature=temp,
            max_retries=6,
        )

    elif provider == "openai":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model=model,
            openai_api_key=api_key,
            temperature=temp,
            streaming=True,
        )

    else:
        raise ValueError(
            f"Unsupported provider: '{provider}'. Choose from: groq, openai"
        )


# ── Embedding Factory ─────────────────────────────────────────────────────────

def get_embeddings(config: "LLMConfig") -> Embeddings:
    """
    Return a LangChain embeddings model using the same API key as the chat LLM.

    - groq   → HuggingFace 'all-MiniLM-L6-v2' (384-dim, local)
    - openai → OpenAI text-embedding-3-small (1536-dim)
    """
    provider = config.provider
    api_key  = config.api_key

    if provider == "groq":
        from langchain_huggingface import HuggingFaceEmbeddings
        return HuggingFaceEmbeddings(
            model_name="all-MiniLM-L6-v2"
        )

    elif provider == "openai":
        from langchain_openai import OpenAIEmbeddings
        return OpenAIEmbeddings(
            model="text-embedding-3-small",
            openai_api_key=api_key,
        )

    else:
        raise ValueError(
            f"Unsupported provider: '{provider}'. Choose from: groq, openai"
        )


def get_query_embeddings(config: "LLMConfig") -> Embeddings:
    """
    Same as get_embeddings but for queries.
    """
    provider = config.provider
    api_key  = config.api_key

    if provider == "groq":
        from langchain_huggingface import HuggingFaceEmbeddings
        return HuggingFaceEmbeddings(
            model_name="all-MiniLM-L6-v2"
        )

    elif provider == "openai":
        from langchain_openai import OpenAIEmbeddings
        return OpenAIEmbeddings(
            model="text-embedding-3-small",
            openai_api_key=api_key,
        )

    else:
        raise ValueError(
            f"Unsupported provider: '{provider}'. Choose from: groq, openai"
        )