"""Voice notes: Polly MP3s for approved and confirmed moves, cached in S3 (master plan section 11)."""

import hashlib

from lumen import store

ENGINE = "standard"  # us-east-2 lists no neural voices for en-US, es-US or cmn-CN (describe-voices, 2026-10-23)
VOICES = {"en": ("Joanna", "en-US"), "es": ("Lupe", "es-US"), "zh": ("Zhiyu", "cmn-CN")}
MOVES = ("early_session", "transfer")
_client = None


def polly():
    global _client
    if _client is None:
        import boto3  # in the Lambda runtime; tests swap in a fake client
        _client = boto3.client("polly")
    return _client


def eligible(row, lang):
    """None when the row may get a voice note in lang, else the reason it may not."""
    if row["action"] not in MOVES or row["status"] not in ("approved", "confirmed"):
        return f"no approved move for {row['patient_id']}"
    if lang not in row["messages"]:
        return f"no {lang} message for {row['patient_id']}"
    return None


def stored_hash(key):
    """The text-sha256 metadata of the object at key, or None when it does not exist."""
    try:
        return store.s3().head_object(Bucket=store.bucket(), Key=key)["Metadata"].get("text-sha256")
    except Exception as exc:  # botocore ClientError; boto3 is not imported here
        if getattr(exc, "response", {}).get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            return None
        raise


def make_voice(event_id, patient_id, lang, text):
    """Save the MP3 of one message and return its S3 key. An MP3 of the same text is reused."""
    if lang not in VOICES:
        raise ValueError(f"no voice for language {lang!r}")
    if "{name}" in text:
        names = {p["id"]: p["name"] for p in store.load_seed()["patients"]}
        text = text.replace("{name}", names[patient_id])
    key = f"audio/{event_id}/{patient_id}.{lang}.mp3"
    sha = hashlib.sha256(text.encode()).hexdigest()
    if stored_hash(key) == sha:
        return key
    voice_id, language_code = VOICES[lang]
    speech = polly().synthesize_speech(Engine=ENGINE, OutputFormat="mp3", Text=text, VoiceId=voice_id, LanguageCode=language_code)
    store.s3().put_object(Bucket=store.bucket(), Key=key, Body=speech["AudioStream"].read(), ContentType="audio/mpeg",
                          Metadata={"text-sha256": sha})
    return key


def presign(key):
    return store.s3().generate_presigned_url("get_object", Params={"Bucket": store.bucket(), "Key": key}, ExpiresIn=3600)
