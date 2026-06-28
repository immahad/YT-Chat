"""
rag/retriever.py
────────────────
Advanced retrieval pipeline combining:

  1. Multi-Query Generation   — LLM rewrites the user's question into 3 variants,
                                retrieves for each, then deduplicates results.
  2. Hybrid Retrieval         — Dense (ChromaDB vector) + Sparse (BM25 keyword)
                                fused with Reciprocal Rank Fusion (RRF).
  3. MMR                      — Maximal Marginal Relevance to avoid near-duplicate chunks.
  4. Cross-Encoder Reranking  — Local HuggingFace cross-encoder re-scores & reorders.
  5. Contextual Compression   — LLMChainExtractor trims verbose chunks to key passages.

The output is a small, high-quality list of Documents with start_seconds metadata
ready for timestamp citation generation.
"""

from __future__ import annotations
import logging
from typing import TYPE_CHECKING

from langchain_core.documents import Document
from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain.retrievers.contextual_compression import ContextualCompressionRetriever
from langchain.retrievers.document_compressors import LLMChainExtractor
from langchain_community.retrievers import BM25Retriever
from langchain_chroma import Chroma
from sentence_transformers import CrossEncoder

_HAS_COMPRESSION = True  # Available in langchain 0.3.x

if TYPE_CHECKING:
    from langchain_core.language_models import BaseChatModel
    from langchain_core.embeddings import Embeddings

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
TOP_K_DENSE   = 8    # retrieve top-K from vector store per query
TOP_K_BM25    = 8    # retrieve top-K from BM25 per query
TOP_K_FINAL   = 4    # final chunks after reranking + compression
MMR_LAMBDA    = 0.6  # 0 = max diversity, 1 = max relevance

# Local cross-encoder model (downloads ~90MB on first use, cached afterwards)
CROSS_ENCODER_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"

# Lazy-loaded singleton to avoid reloading on every request
_cross_encoder: CrossEncoder | None = None


def _get_cross_encoder() -> CrossEncoder:
    global _cross_encoder
    if _cross_encoder is None:
        logger.info(f"Loading cross-encoder: {CROSS_ENCODER_MODEL}")
        _cross_encoder = CrossEncoder(CROSS_ENCODER_MODEL, max_length=512)
    return _cross_encoder


# ── Multi-Query Generation ────────────────────────────────────────────────────

MULTI_QUERY_PROMPT = PromptTemplate(
    input_variables=["question"],
    template="""You are an expert at reformulating questions to improve document retrieval.
Given the user's question below, generate 3 alternative versions that:
- Rephrase it with different wording
- Focus on different aspects or keywords
- Are concise and search-friendly

Output ONLY the 3 questions, one per line, no numbering, no explanation.

Original question: {question}

3 alternative questions:"""
)


def generate_multi_queries(question: str, llm: "BaseChatModel") -> list[str]:
    """Generate 3 alternative queries using an LLM."""
    chain = MULTI_QUERY_PROMPT | llm | StrOutputParser()
    try:
        result = chain.invoke({"question": question})
        alternatives = [q.strip() for q in result.strip().split("\n") if q.strip()]
        queries = [question] + alternatives[:3]  # original + up to 3 variants
        logger.info(f"Multi-query generated {len(queries)} queries")
        return queries
    except Exception as e:
        logger.warning(f"Multi-query generation failed: {e}. Using original query.")
        return [question]


# ── Reciprocal Rank Fusion ────────────────────────────────────────────────────

def reciprocal_rank_fusion(
    results_lists: list[list[Document]],
    k: int = 60,
) -> list[Document]:
    """
    Merge multiple ranked lists into one using RRF.
    Documents appearing in multiple lists get boosted scores.
    Deduplication is done by page_content hash.
    """
    scores: dict[str, float] = {}
    doc_map: dict[str, Document] = {}

    for results in results_lists:
        for rank, doc in enumerate(results):
            key = hash(doc.page_content[:200])  # use first 200 chars as key
            str_key = str(key)
            scores[str_key] = scores.get(str_key, 0.0) + 1.0 / (rank + k)
            doc_map[str_key] = doc

    # Sort by descending RRF score
    sorted_keys = sorted(scores, key=lambda x: scores[x], reverse=True)
    return [doc_map[k] for k in sorted_keys]


# ── Hybrid Retrieval ──────────────────────────────────────────────────────────

def hybrid_retrieve(
    queries: list[str],
    vector_store: Chroma,
    all_docs: list[Document],
    embeddings: "Embeddings",
) -> list[Document]:
    """
    For each query:
      - Dense retrieval: ChromaDB MMR search
      - Sparse retrieval: BM25 keyword search
    Fuse results with RRF.
    """
    # BM25 retriever (keyword-based, uses all indexed docs)
    bm25_retriever = BM25Retriever.from_documents(all_docs)
    bm25_retriever.k = TOP_K_BM25

    all_result_lists: list[list[Document]] = []

    for query in queries:
        # Dense: MMR from ChromaDB
        try:
            dense_results = vector_store.max_marginal_relevance_search(
                query,
                k=TOP_K_DENSE,
                fetch_k=TOP_K_DENSE * 3,
                lambda_mult=MMR_LAMBDA,
            )
        except Exception as e:
            logger.warning(f"MMR search failed: {e}")
            dense_results = vector_store.similarity_search(query, k=TOP_K_DENSE)

        # Sparse: BM25
        try:
            sparse_results = bm25_retriever.invoke(query)
        except Exception as e:
            logger.warning(f"BM25 search failed: {e}")
            sparse_results = []

        all_result_lists.append(dense_results)
        if sparse_results:
            all_result_lists.append(sparse_results)

    # Fuse with RRF
    fused = reciprocal_rank_fusion(all_result_lists)
    logger.info(f"Hybrid retrieval: {len(fused)} unique docs after RRF")
    return fused


# ── Cross-Encoder Reranking ───────────────────────────────────────────────────

def rerank_documents(
    question: str,
    docs: list[Document],
    top_k: int = TOP_K_FINAL,
) -> list[Document]:
    """
    Re-score documents with a local cross-encoder and return top_k.
    Cross-encoders jointly encode question+doc for much better relevance scoring.
    """
    if not docs:
        return []

    import os
    if os.getenv("DISABLE_CROSS_ENCODER", "false").lower() == "true" or os.getenv("RENDER", "false").lower() == "true":
        logger.info("Running on Render (or cross-encoder disabled). Skipping reranking.")
        return docs[:top_k]

    cross_encoder = _get_cross_encoder()
    pairs = [(question, doc.page_content) for doc in docs]

    try:
        scores = cross_encoder.predict(pairs)
        scored = sorted(zip(scores, docs), key=lambda x: x[0], reverse=True)
        reranked = [doc for _, doc in scored[:top_k]]
        logger.info(f"Cross-encoder reranked to top {len(reranked)} docs")
        return reranked
    except Exception as e:
        logger.warning(f"Reranking failed: {e}. Using original order.")
        return docs[:top_k]


# ── Contextual Compression ────────────────────────────────────────────────────

def compress_documents(
    question: str,
    docs: list[Document],
    llm: "BaseChatModel",
) -> list[Document]:
    """
    Use LLMChainExtractor to extract ONLY the relevant sentence(s)
    from each retrieved chunk. Reduces noise and saves tokens.
    Falls back to uncompressed docs on any error.
    """
    if not docs:
        return []

    try:
        compressor = LLMChainExtractor.from_llm(llm)
        compressed = []
        for doc in docs:
            try:
                result = compressor.compress_documents([doc], question)
                compressed.extend(result if result else [doc])
            except Exception as e:
                logger.warning(f"Compression failed for a doc: {e}. Keeping original.")
                compressed.append(doc)
        logger.info(f"Contextual compression: {len(docs)} → {len(compressed)} docs")
        return compressed
    except Exception as e:
        logger.warning(f"Compression pipeline failed: {e}. Using uncompressed docs.")
        return docs


# ── Main Retrieval Pipeline ───────────────────────────────────────────────────

def retrieve(
    question: str,
    vector_store: Chroma,
    all_docs: list[Document],
    embeddings: "Embeddings",
    llm: "BaseChatModel",
    use_compression: bool = True,
) -> list[Document]:
    """
    Full advanced retrieval pipeline:
      1. Multi-query generation
      2. Hybrid retrieval (Dense MMR + BM25) + RRF fusion
      3. Cross-encoder reranking
      4. Contextual compression (optional, adds latency)

    Returns a list of highly relevant Documents with metadata intact.
    """
    # Step 1: Multi-query
    queries = generate_multi_queries(question, llm)

    # Step 2: Hybrid retrieval + RRF
    candidate_docs = hybrid_retrieve(queries, vector_store, all_docs, embeddings)

    # Step 3: Cross-encoder reranking
    reranked_docs = rerank_documents(question, candidate_docs, top_k=TOP_K_FINAL + 2)

    # Step 4: Contextual compression
    if use_compression and reranked_docs:
        final_docs = compress_documents(question, reranked_docs, llm)
        final_docs = final_docs[:TOP_K_FINAL]
    else:
        final_docs = reranked_docs[:TOP_K_FINAL]

    logger.info(f"Final retrieval: {len(final_docs)} docs for question: '{question[:60]}...'")
    return final_docs
