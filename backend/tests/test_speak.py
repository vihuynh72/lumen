import hashlib
import io
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

import lambda_function as router
from fake_s3 import FakeS3
from lumen import speak, store, voice

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
SCHEMA = Draft202012Validator(json.loads((CONTRACTS / "schemas" / "speak.schema.json").read_text()))
TEXT = "Your Wednesday session moves to Tuesday at 10:30 AM."


class SpeakS3(FakeS3):
    def generate_presigned_url(self, ClientMethod, Params, ExpiresIn):
        return f"https://{Params['Bucket']}.s3.example/{Params['Key']}?expires={ExpiresIn}"


class FakePolly:
    def __init__(self):
        self.calls = []

    def synthesize_speech(self, **kwargs):
        self.calls.append(kwargs)
        return {"AudioStream": io.BytesIO(b"mp3")}


class FakeTranslate:
    def __init__(self, error=None):
        self.calls, self.error = [], error

    def translate_text(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return {"TranslatedText": f"[{kwargs['TargetLanguageCode']}] {kwargs['Text']}"}


class ClientError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    monkeypatch.setenv("BUCKET", "test-bucket")
    monkeypatch.setenv("DEMO_KEY", "k3y")
    s3, polly, translate = SpeakS3(), FakePolly(), FakeTranslate()
    monkeypatch.setattr(store, "_client", s3)
    monkeypatch.setattr(voice, "_client", polly)
    monkeypatch.setattr(speak, "_client", translate)
    return s3, polly, translate


def call(body):
    event = {"requestContext": {"http": {"method": "POST"}}, "rawPath": "/speak",
             "headers": {"X-Demo-Key": "k3y"}, "body": json.dumps(body)}
    resp = router.lambda_handler(event, None)
    return resp["statusCode"], json.loads(resp["body"])


def key(lang, text=TEXT):
    return "speak/" + hashlib.sha256(f"{lang}\n{text}".encode()).hexdigest()


@pytest.mark.parametrize("lang, voice_id, language_code, target", [
    ("es", "Lupe", "es-US", "es"), ("zh", "Zhiyu", "cmn-CN", "zh"), ("ko", "Seoyeon", "ko-KR", "ko"),
    ("ar", "Zeina", "arb", "ar"), ("hi", "Aditi", "hi-IN", "hi"), ("en", "Joanna", "en-US", None),
])
def test_voiced_lang_translates_speaks_and_saves(fakes, lang, voice_id, language_code, target):
    s3, polly, translate = fakes
    status, body = call({"text": TEXT, "lang": lang})
    spoken = f"[{target}] {TEXT}" if target else TEXT
    assert status == 200 and not list(SCHEMA.iter_errors(body))
    assert body == {"text": spoken, "lang": lang, "voice": voice_id,
                    "url": f"https://test-bucket.s3.example/{key(lang)}.mp3?expires=3600", "note": None}
    assert translate.calls == ([{"Text": TEXT, "SourceLanguageCode": "en", "TargetLanguageCode": target}] if target else [])
    assert polly.calls == [{"Engine": "standard", "OutputFormat": "mp3", "Text": spoken, "VoiceId": voice_id, "LanguageCode": language_code}]
    assert s3.objects[f"{key(lang)}.mp3"][0] == b"mp3"
    assert store.get_json(f"{key(lang)}.json")["text"] == spoken


@pytest.mark.parametrize("lang, name, target", [("vi", "Vietnamese", "vi"), ("tl", "Tagalog", "tl"),
                                                ("yue", "Cantonese", "zh-TW"), ("te", "Telugu", "te")])
def test_lang_without_a_voice_gets_text_and_a_note(fakes, lang, name, target):
    s3, polly, translate = fakes
    status, body = call({"text": TEXT, "lang": lang})
    assert status == 200 and not list(SCHEMA.iter_errors(body))
    assert body == {"text": f"[{target}] {TEXT}", "lang": lang, "voice": None, "url": None, "note": f"Polly has no {name} voice"}
    assert translate.calls[0]["TargetLanguageCode"] == target and polly.calls == []
    assert set(s3.objects) == {f"{key(lang)}.json"}


def test_same_text_and_lang_reuse_the_cache(fakes):
    _, polly, translate = fakes
    first = call({"text": TEXT, "lang": "es"})
    assert call({"text": TEXT, "lang": "es"}) == first
    assert len(translate.calls) == len(polly.calls) == 1
    call({"text": TEXT, "lang": "ko"})
    assert len(translate.calls) == 2  # another lang is another cache entry


def test_translate_access_denied_is_a_500(fakes, monkeypatch):
    s3, polly, _ = fakes
    monkeypatch.setattr(speak, "_client", FakeTranslate(ClientError("AccessDeniedException")))
    assert call({"text": TEXT, "lang": "es"}) == (500, {"error": "translate not permitted", "step": "speak"})
    assert polly.calls == [] and s3.objects == {}


def test_other_translate_errors_name_the_step(monkeypatch):
    monkeypatch.setattr(speak, "_client", FakeTranslate(ClientError("ThrottlingException")))
    status, body = call({"text": TEXT, "lang": "es"})
    assert status == 500 and body["step"] == "speak" and body["error"].startswith("speak failed")


@pytest.mark.parametrize("body", [
    {"lang": "es"}, {"text": "  ", "lang": "es"}, {"text": "x" * 601, "lang": "es"}, {"text": ["hi"], "lang": "es"},
    {"text": TEXT}, {"text": TEXT, "lang": "xx"}, {"text": TEXT, "lang": ["es"]},
])
def test_bad_input_is_a_400(fakes, body):
    status, resp = call(body)
    assert status == 400 and resp["step"] == "speak"
    assert fakes[2].calls == []


def test_600_characters_is_allowed():
    assert call({"text": "x" * 600, "lang": "en"})[0] == 200


def test_fixture_validates():
    fixture = json.loads((CONTRACTS / "fixtures" / "speak.response.json").read_text())
    assert not list(SCHEMA.iter_errors(fixture))
    assert fixture["voice"] == speak.VOICES[fixture["lang"]][0]


def test_pretranslated_text_skips_translate(fakes):
    s3, polly, translate = fakes
    translate.error = ClientError("AccessDeniedException")  # works even while Translate is denied
    text = "Su tratamiento del martes pasa a las 3:00 p. m."
    status, body = call({"text": text, "lang": "es", "translated": True})
    assert status == 200 and body["text"] == text and body["voice"] == "Lupe" and body["url"]
    assert translate.calls == [] and polly.calls[0]["Text"] == text and polly.calls[0]["VoiceId"] == "Lupe"
    assert not list(SCHEMA.iter_errors(body))
    status, body = call({"text": "Xin chào", "lang": "vi", "translated": True})
    assert status == 200 and body["voice"] is None and body["note"] == "Polly has no Vietnamese voice"


def test_translated_must_be_a_boolean():
    assert call({"text": TEXT, "lang": "es", "translated": "yes"})[0] == 400
