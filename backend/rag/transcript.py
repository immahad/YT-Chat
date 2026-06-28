"""
rag/transcript.py
─────────────────
Fetches YouTube transcripts.

PRIMARY PATH: Browser transcript sent from the Chrome extension sidebar.
  The sidebar reads ytInitialPlayerResponse from the YouTube page and fetches
  the caption URL with fmt=json3. This bypasses all bot-detection entirely.

FALLBACK PATH: youtube-transcript-api 0.6.3 (class-method API).
  Only used when the browser transcript is unavailable (e.g. headless/API use).
  May fail on some networks due to YouTube bot-detection.
"""

from __future__ import annotations
import logging
from dataclasses import dataclass
from langchain_core.documents import Document

logger = logging.getLogger(__name__)


@dataclass
class TranscriptSegment:
    text: str
    start: float
    duration: float


@dataclass
class VideoTranscript:
    video_id: str
    segments: list[TranscriptSegment]
    language: str
    is_generated: bool

    @property
    def full_text(self) -> str:
        return " ".join(seg.text.strip() for seg in self.segments)

    @property
    def num_segments(self) -> int:
        return len(self.segments)

    def to_documents(self) -> list[Document]:
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
    Fallback: fetch transcript via youtube-transcript-api 0.6.3.
    Called only when the browser transcript was not supplied by the extension.
    """
    if not video_id or not video_id.strip():
        raise ValueError("video_id cannot be empty")

    video_id = video_id.strip()
    logger.info(f"[fallback] Fetching transcript via library for: {video_id}")

    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api._errors import TranscriptsDisabled, NoTranscriptFound
    except ImportError as e:
        raise ImportError(
            f"youtube-transcript-api not installed: {e}\n"
            "Run: pip install youtube-transcript-api==0.6.3"
        )

    # List available tracks
    try:
        transcript_list = YouTubeTranscriptApi().list(video_id)
    except Exception as e:
        err = str(e)
        if "429" in err or "Too Many Requests" in err:
            raise ValueError("YouTube is rate-limiting. Wait 30s and retry.")
        if "unavailable" in err.lower() or "private" in err.lower():
            raise ValueError(f"Video '{video_id}' is unavailable or private.")
        raise ValueError(
            f"Could not list transcripts for '{video_id}': {e}\n"
            "YouTube may be blocking server-side requests on your network. "
            "Open the video in Chrome and retry — the extension will read "
            "captions directly from the browser."
        )

    all_tracks = list(transcript_list)
    if not all_tracks:
        raise ValueError(f"No caption tracks found for '{video_id}'.")

    logger.info(f"Available tracks: {[(t.language_code, t.is_generated) for t in all_tracks]}")

    # Pick best track
    chosen = (
        next((t for t in all_tracks if t.language_code.startswith("en") and not t.is_generated), None)
        or next((t for t in all_tracks if not t.is_generated), None)
        or next((t for t in all_tracks if t.language_code.startswith("en")), None)
        or all_tracks[0]
    )
    lang_code = chosen.language_code
    is_gen    = chosen.is_generated
    logger.info(f"Selected: lang={lang_code}, generated={is_gen}")

    try:
        raw_data = chosen.fetch()
    except Exception as e:
        raise ValueError(
            f"Failed to fetch transcript content for '{video_id}': {e}\n"
            "YouTube returned an empty or blocked response. "
            "Open the video in Chrome — the extension reads captions "
            "directly from the page which always works."
        )

    segments = []
    for item in raw_data:
        text  = item.get("text", "") if isinstance(item, dict) else str(getattr(item, "text", "") or "")
        start = float(item.get("start", 0.0) if isinstance(item, dict) else getattr(item, "start", 0.0) or 0.0)
        dur   = float(item.get("duration", 0.0) if isinstance(item, dict) else getattr(item, "duration", 0.0) or 0.0)
        text  = text.strip()
        if text:
            segments.append(TranscriptSegment(text=text, start=start, duration=dur))

    if not segments:
        raise ValueError(f"Transcript for '{video_id}' fetched but was empty.")

    logger.info(f"[fallback] {len(segments)} segments (lang={lang_code}, generated={is_gen})")
    return VideoTranscript(video_id=video_id, segments=segments, language=lang_code, is_generated=is_gen)