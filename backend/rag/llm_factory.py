"""
rag/llm_factory.py
──────────────────
Multi-provider LLM + Embedding factory.

Supported providers:
  - google  → Gemini chat  + text-embedding-004         (DEFAULT, free tier)
  - openai  → GPT chat     + text-embedding-3-small

Both providers supply native embedding models, so a single API key is all
that's needed for each provider.
"""

from __future__ import annotations
from typing import TYPE_CHECKING

from langchain_core.language_models import BaseChatModel
from langchain_core.embeddings import Embeddings

if TYPE_CHECKING:
    from models.schemas import LLMConfig


# ── Default model names per provider ─────────────────────────────────────────
DEFAULT_MODELS: dict[str, str] = {
    "google": "gemini-2.0-flash",
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

    else:
        raise ValueError(
            f"Unsupported provider: '{provider}'. Choose from: google, openai"
        )


# ── Embedding Factory ─────────────────────────────────────────────────────────

def get_embeddings(config: "LLMConfig") -> Embeddings:
    """
    Return a LangChain embeddings model using the same API key as the chat LLM.

    - google → Google text-embedding-004  (768-dim, asymmetric retrieval support)
    - openai → OpenAI text-embedding-3-small (1536-dim)
    """
    provider = config.provider
    api_key  = config.api_key

    if provider == "google":
        from langchain_google_genai import GoogleGenerativeAIEmbeddings
        return GoogleGenerativeAIEmbeddings(
            model="models/text-embedding-004",
            google_api_key=api_key,
            task_type="retrieval_document",
        )

    elif provider == "openai":
        from langchain_openai import OpenAIEmbeddings
        return OpenAIEmbeddings(
            model="text-embedding-3-small",
            openai_api_key=api_key,
        )

    else:
        raise ValueError(
            f"Unsupported provider: '{provider}'. Choose from: google, openai"
        )


def get_query_embeddings(config: "LLMConfig") -> Embeddings:
    """
    Same as get_embeddings but with task_type='retrieval_query' for Google
    embeddings — important for asymmetric retrieval quality.
    OpenAI uses the same model for both doc and query embedding.
    """
    provider = config.provider
    api_key  = config.api_key

    if provider == "google":
        from langchain_google_genai import GoogleGenerativeAIEmbeddings
        return GoogleGenerativeAIEmbeddings(
            model="models/text-embedding-004",
            google_api_key=api_key,
            task_type="retrieval_query",
        )

    elif provider == "openai":
        from langchain_openai import OpenAIEmbeddings
        return OpenAIEmbeddings(
            model="text-embedding-3-small",
            openai_api_key=api_key,
        )

    else:
        raise ValueError(
            f"Unsupported provider: '{provider}'. Choose from: google, openai"
        )