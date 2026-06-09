"""
rag/transcript.py
─────────────────
Fetches YouTube video transcripts using the youtube-transcript-api library.

Key design decisions:
  - Preserves timestamps (start seconds) on every chunk of text — critical
    for generating clickable citations that jump to the right moment in the video.
  - Returns both a flat plain-text version (for display) and a list of
    timestamped segments (for metadata-enriched Documents).
  - Tries English first, then falls back to any available language, then
    tries auto-generated captions.
"""

from __future__ import annotations
import logging
from dataclasses import dataclass

from youtube_transcript_api import (
    YouTubeTranscriptApi,
    TranscriptsDisabled,
    NoTranscriptFound,
)
from langchain_core.documents import Document

logger = logging.getLogger(__name__)


@dataclass
class TranscriptSegment:
    """One caption segment from YouTube."""
    text: str
    start: float       # seconds from video start
    duration: float    # seconds this segment lasts


@dataclass
class VideoTranscript:
    """Complete transcript for a video."""
    video_id: str
    segments: list[TranscriptSegment]
    language: str
    is_generated: bool   # True = auto-generated captions

    @property
    def full_text(self) -> str:
        """Plain text with no timestamps — used for display."""
        return " ".join(seg.text.strip() for seg in self.segments)

    @property
    def num_segments(self) -> int:
        return len(self.segments)

    def to_documents(self) -> list[Document]:
        """
        Convert each segment into a LangChain Document with metadata.
        These Documents are then chunked by the indexer.
        Each Document carries start_seconds metadata for citation links.
        """
        docs = []
        for seg in self.segments:
            docs.append(Document(
                page_content=seg.text.strip(),
                metadata={
                    "video_id":      self.video_id,
                    "start_seconds": seg.start,
                    "duration":      seg.duration,
                    "language":      self.language,
                    "is_generated":  self.is_generated,
                }
            ))
        return docs


def fetch_transcript(video_id: str) -> VideoTranscript:
    """
    Fetch the transcript for a YouTube video.

    Fallback order:
      1. English manual captions
      2. Any manually-created captions
      3. English auto-generated captions
      4. Any auto-generated captions

    Raises:
        TranscriptsDisabled: If captions are completely disabled for the video.
        NoTranscriptFound: If no caption track can be found in any language.
        ValueError: If video_id is empty.
    """
    if not video_id or not video_id.strip():
        raise ValueError("video_id cannot be empty")

    video_id = video_id.strip()
    logger.info(f"Fetching transcript for video: {video_id}")

    ytt_api = YouTubeTranscriptApi()

    try:
        transcript_list = ytt_api.list(video_id)
    except TranscriptsDisabled:
        logger.error(f"Transcripts disabled for video: {video_id}")
        raise

    # Build preference order
    transcript = None
    language_used = "unknown"
    is_generated = False

    try:
        transcript = transcript_list.find_manually_created_transcript(["en"])
        language_used = "en"
        is_generated = False
        logger.info("Using English manual transcript")
    except NoTranscriptFound:
        pass

    if transcript is None:
        try:
            transcript = transcript_list.find_manually_created_transcript(
                [t.language_code for t in transcript_list]
            )
            language_used = transcript.language_code
            is_generated = False
            logger.info(f"Using manual transcript in: {language_used}")
        except NoTranscriptFound:
            pass

    if transcript is None:
        try:
            transcript = transcript_list.find_generated_transcript(["en"])
            language_used = "en"
            is_generated = True
            logger.info("Using auto-generated English transcript")
        except NoTranscriptFound:
            pass

    if transcript is None:
        try:
            transcript = transcript_list.find_generated_transcript(
                [t.language_code for t in transcript_list]
            )
            language_used = transcript.language_code
            is_generated = True
            logger.info(f"Using auto-generated transcript in: {language_used}")
        except NoTranscriptFound:
            raise ValueError(
                f"No transcript (manual or auto-generated) found for video '{video_id}'. "
                "The video may have captions disabled or no captions in any language."
            )

    # Fetch the actual transcript data
    fetched = transcript.fetch()

    segments = []
    for item in fetched:
        # youtube-transcript-api v1.x returns FetchedTranscriptSnippet objects
        text  = getattr(item, "text",     None) or item.get("text", "")
        start = getattr(item, "start",    None) or item.get("start", 0.0)
        dur   = getattr(item, "duration", None) or item.get("duration", 0.0)
        segments.append(TranscriptSegment(
            text=text,
            start=float(start),
            duration=float(dur),
        ))

    logger.info(f"Fetched {len(segments)} segments for video {video_id}")

    return VideoTranscript(
        video_id=video_id,
        segments=segments,
        language=language_used,
        is_generated=is_generated,
    )
