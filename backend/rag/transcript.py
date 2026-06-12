"""
rag/transcript.py
─────────────────
Fetches YouTube transcripts using youtube-transcript-api==0.6.3

v0.6.3 API (stable, works without po_token):
  - YouTubeTranscriptApi is used as a CLASS (not instantiated)
  - YouTubeTranscriptApi.list_transcripts(video_id) → TranscriptList
  - transcript_object.fetch() → List[Dict]  with keys: text, start, duration
  - Error classes in youtube_transcript_api._errors

WHY NOT v1.x:
  v1.0.3 calls self._http_client.get(url) with NO headers.
  YouTube returns an empty body → XML ParseError: no element found.
  v0.6.3 sends Accept-Language: en-US which YouTube requires.
"""

from __future__ import annotations
import json
import logging
import os
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from langchain_core.documents import Document

logger = logging.getLogger(__name__)

YOUTUBE_HEADERS = {
    "Accept": "text/xml,application/xml,application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.youtube.com",
    "Referer": "https://www.youtube.com/",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
}

YOUTUBE_COOKIES_PATH = os.getenv("YOUTUBE_COOKIES_PATH") or None
YOUTUBE_HTTPS_PROXY = os.getenv("YOUTUBE_HTTPS_PROXY") or None


# ── Data classes ──────────────────────────────────────────────────────────────

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


# ── Public API ────────────────────────────────────────────────────────────────

def fetch_transcript(video_id: str) -> VideoTranscript:
    """
    Fetch the transcript for a YouTube video using v0.6.3 class-method API.

    Preference order:
      1. English manual captions
      2. Any manual captions
      3. English auto-generated captions
      4. Any auto-generated captions
    """
    if not video_id or not video_id.strip():
        raise ValueError("video_id cannot be empty")

    video_id = video_id.strip()
    logger.info(f"Fetching transcript for video: {video_id}")

    # ── Imports ───────────────────────────────────────────────────────────────
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api._errors import (
            TranscriptsDisabled, NoTranscriptFound
        )
    except ImportError as e:
        raise ImportError(
            f"Failed to import youtube-transcript-api: {e}\n"
            "Run: pip install youtube-transcript-api==0.6.3"
        )

    # ── List available tracks ─────────────────────────────────────────────────
    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(
            video_id,
            **_youtube_request_options(),
        )
    except TranscriptsDisabled:
        raise ValueError(
            f"Captions are disabled for video '{video_id}'. "
            "Try a different video that has captions enabled."
        )
    except Exception as e:
        err_str = str(e)
        if "429" in err_str or "Too Many Requests" in err_str:
            raise ValueError(
                "YouTube is rate-limiting requests. Wait 30–60 seconds and try again."
            )
        if "unavailable" in err_str.lower() or "private" in err_str.lower():
            raise ValueError(
                f"Video '{video_id}' is unavailable or private."
            )
        raise ValueError(f"Could not retrieve transcript list: {e}")

    # ── Collect all available tracks ──────────────────────────────────────────
    all_tracks = []
    try:
        for track in transcript_list:
            all_tracks.append(track)
    except Exception as e:
        logger.warning(f"Could not iterate transcript list: {e}")

    if not all_tracks:
        raise ValueError(
            f"No caption tracks found for '{video_id}'. "
            "The video may not have any captions."
        )

    logger.info(f"Available tracks: {[(t.language_code, t.is_generated) for t in all_tracks]}")

    # ── Pick best track ───────────────────────────────────────────────────────
    chosen      = None
    lang_code   = "unknown"
    is_gen      = True

    # Priority 1: English manual
    for t in all_tracks:
        if t.language_code.startswith("en") and not t.is_generated:
            chosen, lang_code, is_gen = t, t.language_code, False
            break

    # Priority 2: Any manual
    if chosen is None:
        for t in all_tracks:
            if not t.is_generated:
                chosen, lang_code, is_gen = t, t.language_code, False
                break

    # Priority 3: English auto-generated
    if chosen is None:
        for t in all_tracks:
            if t.language_code.startswith("en") and t.is_generated:
                chosen, lang_code, is_gen = t, t.language_code, True
                break

    # Priority 4: Any auto-generated
    if chosen is None:
        chosen    = all_tracks[0]
        lang_code = chosen.language_code
        is_gen    = chosen.is_generated

    logger.info(f"Selected track: lang={lang_code}, generated={is_gen}")

    # ── Fetch transcript content ──────────────────────────────────────────────
    try:
        raw_data = chosen.fetch()   # returns List[Dict] in v0.6.3
    except Exception as e:
        logger.warning(f"Default transcript fetch failed for {video_id}: {e}")
        raw_data = _fetch_transcript_with_fallbacks(chosen, video_id, e)

    # ── Parse into segments ───────────────────────────────────────────────────
    segments = []
    for item in raw_data:
        # v0.6.3 returns plain dicts: {"text": ..., "start": ..., "duration": ...}
        if isinstance(item, dict):
            text  = item.get("text", "")
            start = float(item.get("start", 0.0) or 0.0)
            dur   = float(item.get("duration", 0.0) or 0.0)
        else:
            # Defensive: handle object-style items just in case
            text  = str(getattr(item, "text", "") or "")
            start = float(getattr(item, "start", 0.0) or 0.0)
            dur   = float(getattr(item, "duration", 0.0) or 0.0)

        text = text.strip()
        if text:
            segments.append(TranscriptSegment(text=text, start=start, duration=dur))

    if not segments:
        raise ValueError(
            f"Transcript for '{video_id}' was empty. "
            "The captions may contain no text."
        )

    logger.info(
        f"Successfully fetched {len(segments)} segments "
        f"(lang={lang_code}, generated={is_gen})"
    )

    return VideoTranscript(
        video_id=video_id,
        segments=segments,
        language=lang_code,
        is_generated=is_gen,
    )


def _fetch_transcript_with_fallbacks(chosen, video_id: str, original_error: Exception) -> list[dict]:
    """
    Recover from YouTube returning an empty timedtext XML body.

    youtube-transcript-api 0.6.3 parses XML only. YouTube sometimes returns an
    empty XML response for the same caption URL that still works when requested
    as json3 or with fuller browser headers.
    """
    url = getattr(chosen, "_url", "")
    http_client = getattr(chosen, "_http_client", None)
    original_message = str(original_error)

    if not url or http_client is None:
        raise ValueError(
            f"Failed to fetch transcript for '{video_id}': {original_message}\n"
            "The transcript library did not expose a retryable caption URL."
        )

    attempts = [
        ("xml-browser-headers", url),
        ("json3-browser-headers", _with_query_param(url, "fmt", "json3")),
    ]

    last_detail = original_message
    for label, attempt_url in attempts:
        for retry in range(2):
            try:
                if retry:
                    time.sleep(0.8)
                response = http_client.get(attempt_url, headers=YOUTUBE_HEADERS, timeout=15)
                body = response.text or ""
                content_type = response.headers.get("content-type", "")
                last_detail = (
                    f"{label}: status={response.status_code}, "
                    f"content-type={content_type or 'unknown'}, bytes={len(response.content)}"
                )
                logger.info(f"Transcript fallback {last_detail}")

                response.raise_for_status()
                if not body.strip():
                    continue

                parsed = _parse_caption_response(body)
                if parsed:
                    logger.info(f"Transcript fallback '{label}' recovered {len(parsed)} segments")
                    return parsed
            except Exception as e:
                last_detail = f"{label}: {e}"
                logger.warning(f"Transcript fallback failed for {video_id}: {last_detail}")

    if "no element found" in original_message.lower():
        raise ValueError(
            f"Failed to fetch transcript for '{video_id}': YouTube returned an empty caption response. "
            f"Last retry detail: {last_detail}. "
            "This usually means YouTube is blocking or throttling transcript requests from this network. "
            "Wait a minute, try a different video, or try another network/VPN."
        )

    raise ValueError(
        f"Failed to fetch transcript for '{video_id}': {original_message}. "
        f"Last retry detail: {last_detail}"
    )


def _youtube_request_options() -> dict:
    options = {}
    if YOUTUBE_COOKIES_PATH:
        options["cookies"] = YOUTUBE_COOKIES_PATH
    if YOUTUBE_HTTPS_PROXY:
        options["proxies"] = {
            "http": YOUTUBE_HTTPS_PROXY,
            "https": YOUTUBE_HTTPS_PROXY,
        }
    return options


def _with_query_param(url: str, key: str, value: str) -> str:
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query[key] = value
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _parse_caption_response(body: str) -> list[dict]:
    stripped = body.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        return _parse_json3_transcript(body)

    import re
    from defusedxml import ElementTree
    from youtube_transcript_api._html_unescaping import unescape

    html_regex = re.compile(r"<[^>]*>", re.IGNORECASE)
    return [
        {
            "text": re.sub(html_regex, "", unescape(xml_element.text)),
            "start": float(xml_element.attrib["start"]),
            "duration": float(xml_element.attrib.get("dur", "0.0")),
        }
        for xml_element in ElementTree.fromstring(body)
        if xml_element.text is not None
    ]


def _parse_json3_transcript(body: str) -> list[dict]:
    payload = json.loads(body)
    segments = []
    for event in payload.get("events", []):
        pieces = event.get("segs") or []
        text = "".join(piece.get("utf8", "") for piece in pieces).strip()
        if not text:
            continue

        start_ms = float(event.get("tStartMs", 0) or 0)
        duration_ms = float(event.get("dDurationMs", 0) or 0)
        segments.append({
            "text": text,
            "start": start_ms / 1000.0,
            "duration": duration_ms / 1000.0,
        })
    return segments
