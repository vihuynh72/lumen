"""POST /speak: English text translated by Amazon Translate and read by a Polly standard voice, cached in S3 (contracts/api.md)."""

import hashlib

from lumen import store, voice

MAX_CHARS = 600
LANGS = {"en": "English", "es": "Spanish", "zh": "Chinese", "ko": "Korean", "vi": "Vietnamese", "tl": "Tagalog",
         "yue": "Cantonese", "ja": "Japanese", "ar": "Arabic", "pt": "Portuguese", "fr": "French", "ru": "Russian",
         "hi": "Hindi", "te": "Telugu"}
# Standard voices that us-east-2 lists (describe-voices, 2026-10-23). It has no Vietnamese, Tagalog, Cantonese or Telugu voice.
VOICES = {**voice.VOICES, "ko": ("Seoyeon", "ko-KR"), "ja": ("Mizuki", "ja-JP"), "ar": ("Zeina", "arb"),
          "pt": ("Camila", "pt-BR"), "fr": ("Celine", "fr-FR"), "ru": ("Tatyana", "ru-RU"), "hi": ("Aditi", "hi-IN")}
TRANSLATE_CODES = {"yue": "zh-TW"}  # Translate has no Cantonese, and Cantonese readers in the US read Traditional Chinese
_client = None


class TranslateDenied(Exception):
    """The Lambda role may not call translate:TranslateText."""


def translator():
    global _client
    if _client is None:
        import boto3  # in the Lambda runtime; tests swap in a fake client
        _client = boto3.client("translate")
    return _client


def translate(text, lang):
    if lang == "en":
        return text
    try:
        out = translator().translate_text(Text=text, SourceLanguageCode="en", TargetLanguageCode=TRANSLATE_CODES.get(lang, lang))
    except Exception as exc:  # botocore ClientError; boto3 is not imported here
        if getattr(exc, "response", {}).get("Error", {}).get("Code") in ("AccessDeniedException", "AccessDenied"):
            raise TranslateDenied() from exc
        raise
    return out["TranslatedText"]


def speak(text, lang, translated=False):
    """{text, lang, voice, url, note} for English text in lang. The same lang and text reuse the saved translation and MP3.
    translated=True: text is already in lang (a template translation), so Translate is skipped."""
    key = "speak/" + hashlib.sha256((f"{lang}\npre\n{text}" if translated else f"{lang}\n{text}").encode()).hexdigest()
    saved = store.get_json(f"{key}.json")
    if saved is None:
        voice_id, language_code = VOICES.get(lang, (None, None))
        saved = {"text": text if translated else translate(text, lang), "lang": lang, "voice": voice_id,
                 "note": None if voice_id else f"Polly has no {LANGS[lang]} voice"}
        if voice_id:
            speech = voice.polly().synthesize_speech(Engine=voice.ENGINE, OutputFormat="mp3", Text=saved["text"],
                                                     VoiceId=voice_id, LanguageCode=language_code)
            store.s3().put_object(Bucket=store.bucket(), Key=f"{key}.mp3", Body=speech["AudioStream"].read(), ContentType="audio/mpeg")
        store.put_json(f"{key}.json", saved)  # written after the MP3: a saved JSON means its MP3 exists
    return {"text": saved["text"], "lang": lang, "voice": saved["voice"],
            "url": voice.presign(f"{key}.mp3") if saved["voice"] else None, "note": saved["note"]}
