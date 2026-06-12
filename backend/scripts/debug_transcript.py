import os
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

HERE = os.path.dirname(os.path.dirname(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from rag.transcript import YOUTUBE_HEADERS, fetch_transcript


def with_query_param(url, key, value):
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query[key] = value
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def request_options():
    options = {}
    cookies = os.getenv("YOUTUBE_COOKIES_PATH")
    proxy = os.getenv("YOUTUBE_HTTPS_PROXY")
    if cookies:
        options["cookies"] = cookies
    if proxy:
        options["proxies"] = {"http": proxy, "https": proxy}
    return options


def main():
    video_id = sys.argv[1] if len(sys.argv) > 1 else "6VquSiCBVJs"

    import youtube_transcript_api as yta
    from youtube_transcript_api import YouTubeTranscriptApi
    import youtube_transcript_api._errors as errors

    print("python:", sys.executable)
    print("python_version:", sys.version.replace("\n", " "))
    print("youtube_transcript_api:", getattr(yta, "__file__", "unknown"))
    print("youtube_transcript_api_version:", getattr(yta, "__version__", "unknown"))
    print("has_TooManyRequests:", hasattr(errors, "TooManyRequests"))
    print("cookies:", os.getenv("YOUTUBE_COOKIES_PATH") or "(not set)")
    print("proxy:", os.getenv("YOUTUBE_HTTPS_PROXY") or "(not set)")
    print("video:", video_id)

    transcript_list = YouTubeTranscriptApi.list_transcripts(video_id, **request_options())
    tracks = list(transcript_list)
    print("tracks:", [(t.language_code, t.is_generated) for t in tracks])

    for track in tracks[:3]:
        print("track:", track.language_code, "generated=", track.is_generated)
        for label, url in [
            ("xml", getattr(track, "_url", "")),
            ("json3", with_query_param(getattr(track, "_url", ""), "fmt", "json3")),
        ]:
            response = track._http_client.get(url, headers=YOUTUBE_HEADERS, timeout=15)
            body = response.text or ""
            print(
                label,
                "status=", response.status_code,
                "content_type=", response.headers.get("content-type", ""),
                "bytes=", len(response.content),
                "sample=", repr(body[:160]),
            )

    transcript = fetch_transcript(video_id)
    print("fetch_transcript: OK", transcript.language, transcript.is_generated, transcript.num_segments)
    print("first_segment:", transcript.segments[0])


if __name__ == "__main__":
    main()
