import os
import sys
import traceback

# Ensure backend/ is on sys.path so `rag` package imports correctly
HERE = os.path.dirname(os.path.dirname(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from rag.transcript import fetch_transcript

video_id = 'yC36gN-rqjo'
try:
    t = fetch_transcript(video_id)
    print('OK: segments=', len(t.segments))
    for i, seg in enumerate(t.segments[:5]):
        print(i, seg.start, seg.duration, seg.text[:80])
except Exception:
    print('ERROR fetching transcript for', video_id)
    traceback.print_exc()
