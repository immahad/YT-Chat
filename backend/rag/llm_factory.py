"""
rag/llm_factory.py
──────────────────
Multi-provider LLM + Embedding factory.

Supported providers:
  - google     → Gemini chat + text-embedding-004  (DEFAULT, free tier)
  - openai     → GPT-4o-mini + text-embedding-3-small
  - anthropic  → Claude chat + Google embeddings (Anthropic has no embeddings)
  - grok       → Grok chat  + Google embeddings (xAI has no embeddings)

Embedding rule:
  - If provider == "google"    → use Google text-embedding-004
  - If provider == "openai"    → use OpenAI text-embedding-3-small
  - If provider == "anthropic" → use Google text-embedding-004 (needs google_api_key)
  - If provider == "grok"      → use Google text-embedding-004 (needs google_api_key)
"""

from __future__ import annotations
from typing import TYPE_CHECKING

from langchain_core.language_models import BaseChatModel
from langchain_core.embeddings import Embeddings

if TYPE_CHECKING:
    from models.schemas import LLMConfig


# ── Default model names per provider ─────────────────────────────────────────
DEFAULT_MODELS: dict[str, str] = {
    "google":    "gemini-2.0-flash",
    "openai":    "gpt-4o-mini",
    "anthropic": "claude-3-5-haiku-20241022",
    "grok":      "grok-3-mini",
}

EMBEDDING_DIMENSIONS: dict[str, int] = {
    "google": 768,
    "openai": 1536,
}


# ── Chat LLM Factory ─────────────────────────────────────────────────────────

def get_chat_llm(config: "LLMConfig") -> BaseChatModel:
    """
    Return a LangChain chat model based on the user's provider choice.
    No API keys are ever hardcoded — all come from the user's config.
    """
    provider  = config.provider
    api_key   = config.api_key
    model     = config.chat_model or DEFAULT_MODELS.get(provider, "gemini-2.0-flash")
    temp      = config.temperature

    if provider == "google":
        from langchain_google_genai import ChatGoogleGenerativeAI
        return ChatGoogleGenerativeAI(
            model=model,
            google_api_key=api_key,
            temperature=temp,
            convert_system_message_to_human=True,  # Gemini quirk
        )

    elif provider == "openai":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model=model,
            openai_api_key=api_key,
            temperature=temp,
            streaming=True,
        )

    elif provider == "anthropic":
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(
            model=model,
            anthropic_api_key=api_key,
            temperature=temp,
        )

    elif provider == "grok":
        # Grok (xAI) uses an OpenAI-compatible API endpoint.
        # langchain-openai 0.2.x uses openai_api_base kwarg.
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model=model,
            openai_api_key=api_key,
            openai_api_base="https://api.x.ai/v1",
            temperature=temp,
            streaming=True,
        )

    else:
        raise ValueError(f"Unsupported provider: '{provider}'. Choose from: google, openai, anthropic, grok")


# ── Embedding Factory ─────────────────────────────────────────────────────────

def get_embeddings(config: "LLMConfig") -> Embeddings:
    """
    Return a LangChain embeddings model.

    - google  → Google text-embedding-004 using the same google api_key
    - openai  → OpenAI text-embedding-3-small using the same openai api_key
    - anthropic/grok → MUST provide google_api_key as fallback (Anthropic/xAI
                       don't offer embedding models)
    """
    provider = config.provider

    if provider == "google":
        from langchain_google_genai import GoogleGenerativeAIEmbeddings
        return GoogleGenerativeAIEmbeddings(
            model="models/text-embedding-004",
            google_api_key=config.api_key,
            task_type="retrieval_document",
        )

    elif provider == "openai":
        from langchain_openai import OpenAIEmbeddings
        return OpenAIEmbeddings(
            model="text-embedding-3-small",
            openai_api_key=config.api_key,
        )

    elif provider in ("anthropic", "grok"):
        # Fallback: use Google embeddings — user must also supply google_api_key
        google_key = config.google_api_key
        if not google_key:
            raise ValueError(
                f"Provider '{provider}' has no native embedding model. "
                "Please also provide a 'google_api_key' in your settings for embeddings."
            )
        from langchain_google_genai import GoogleGenerativeAIEmbeddings
        return GoogleGenerativeAIEmbeddings(
            model="models/text-embedding-004",
            google_api_key=google_key,
            task_type="retrieval_document",
        )

    else:
        raise ValueError(f"Unsupported provider: '{provider}'")


def get_query_embeddings(config: "LLMConfig") -> Embeddings:
    """
    Same as get_embeddings but with task_type='retrieval_query' for
    Google embeddings (important for asymmetric retrieval quality).
    """
    provider = config.provider

    if provider == "google":
        from langchain_google_genai import GoogleGenerativeAIEmbeddings
        return GoogleGenerativeAIEmbeddings(
            model="models/text-embedding-004",
            google_api_key=config.api_key,
            task_type="retrieval_query",
        )

    elif provider == "openai":
        from langchain_openai import OpenAIEmbeddings
        return OpenAIEmbeddings(
            model="text-embedding-3-small",
            openai_api_key=config.api_key,
        )

    elif provider in ("anthropic", "grok"):
        google_key = config.google_api_key
        if not google_key:
            raise ValueError(
                f"Provider '{provider}' needs a 'google_api_key' for embeddings."
            )
        from langchain_google_genai import GoogleGenerativeAIEmbeddings
        return GoogleGenerativeAIEmbeddings(
            model="models/text-embedding-004",
            google_api_key=google_key,
            task_type="retrieval_query",
        )

    else:
        raise ValueError(f"Unsupported provider: '{provider}'")
