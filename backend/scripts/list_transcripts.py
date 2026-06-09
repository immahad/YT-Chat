from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled, NoTranscriptFound
import traceback

video_id = 'yC36gN-rqjo'
try:
    tl = YouTubeTranscriptApi.list_transcripts(video_id)
    print('Tracks available:')
    for t in tl:
        try:
            print(' -', t.language_code, 'generated=', getattr(t, 'is_generated', False))
        except Exception:
            print(' - (unknown)')
    # Try to find generated transcript and translate to English
    try:
        t = tl.find_generated_transcript([t.language_code for t in tl])
        print('Found transcript language:', t.language_code, 'generated=', getattr(t, 'is_generated', False))
        try:
            trans_en = t.translate('en')
            data = trans_en.fetch()
            print('Translated fetch length:', len(data))
            print(data[:3])
        except Exception as e:
            print('Translation to English failed:', e)
    except NoTranscriptFound:
        print('No transcript found via list_transcripts().')
except Exception:
    traceback.print_exc()
