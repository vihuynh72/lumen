import hashlib
import io

import pytest

from fake_s3 import FakeS3
from lumen import store, voice

ROSTER = {"patients": [{"id": "P001", "name": "Maria Delgado"}]}


class NotFound(Exception):
    response = {"Error": {"Code": "404"}}


class AudioS3(FakeS3):
    def __init__(self):
        super().__init__()
        self.metadata = {}

    def put_object(self, Bucket, Key, Body, ContentType=None, Metadata=None):
        super().put_object(Bucket, Key, Body, ContentType)
        self.metadata[Key] = Metadata or {}

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise NotFound(Key)
        return {"Metadata": self.metadata[Key]}

    def generate_presigned_url(self, ClientMethod, Params, ExpiresIn):
        return f"https://{Params['Bucket']}.s3.example/{Params['Key']}?method={ClientMethod}&expires={ExpiresIn}"


class FakePolly:
    def __init__(self):
        self.calls = []

    def synthesize_speech(self, **kwargs):
        self.calls.append(kwargs)
        return {"AudioStream": io.BytesIO(b"mp3")}


@pytest.fixture(autouse=True)
def fake(monkeypatch):
    monkeypatch.setenv("BUCKET", "test-bucket")
    s3 = AudioS3()
    monkeypatch.setattr(store, "_client", s3)
    monkeypatch.setattr(store, "load_seed", lambda: ROSTER)
    return s3


@pytest.fixture(autouse=True)
def polly(monkeypatch):
    client = FakePolly()
    monkeypatch.setattr(voice, "_client", client)
    return client


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def test_name_filled_from_roster_and_saved(fake, polly):
    key = voice.make_voice("PSPS-DEMO-01", "P001", "es", "{name}, le habla DaVita.")
    assert key == "audio/PSPS-DEMO-01/P001.es.mp3"
    assert polly.calls == [{"Engine": voice.ENGINE, "OutputFormat": "mp3", "Text": "Maria Delgado, le habla DaVita.",
                            "VoiceId": "Lupe", "LanguageCode": "es-US"}]
    assert fake.objects[key][0] == b"mp3"
    assert fake.metadata[key] == {"text-sha256": sha("Maria Delgado, le habla DaVita.")}


def test_same_text_reuses_the_mp3(polly):
    first = voice.make_voice("E1", "P001", "en", "Hello {name}")
    assert voice.make_voice("E1", "P001", "en", "Hello {name}") == first
    assert len(polly.calls) == 1


def test_changed_text_makes_a_new_mp3(fake, polly):
    voice.make_voice("E1", "P001", "en", "Hello {name}")
    voice.make_voice("E1", "P001", "en", "Goodbye {name}")
    assert [c["Text"] for c in polly.calls] == ["Hello Maria Delgado", "Goodbye Maria Delgado"]
    assert fake.metadata["audio/E1/P001.en.mp3"] == {"text-sha256": sha("Goodbye Maria Delgado")}


def test_unknown_lang(polly):
    with pytest.raises(ValueError):
        voice.make_voice("E1", "P001", "fr", "Bonjour")
    assert polly.calls == []


def test_head_error_other_than_missing_raises(fake, monkeypatch):
    class Denied(Exception):
        response = {"Error": {"Code": "403"}}

    def head_object(**_):
        raise Denied()

    monkeypatch.setattr(fake, "head_object", head_object)
    with pytest.raises(Denied):
        voice.make_voice("E1", "P001", "zh", "你好")


def test_presign():
    assert voice.presign("audio/E1/P001.es.mp3") == "https://test-bucket.s3.example/audio/E1/P001.es.mp3?method=get_object&expires=3600"


def row(**kw):
    return {"patient_id": "P004", "action": "transfer", "status": "confirmed", "messages": {"en": "Hi {name}"}, **kw}


@pytest.mark.parametrize("r, lang, reason", [
    (row(), "en", None),
    (row(action="early_session"), "en", None),
    (row(status="approved"), "en", "no confirmed move for P004"),
    (row(action="hospital", messages={}), "en", "no confirmed move for P004"),
    (row(), "es", "no es message for P004"),
])
def test_eligible(r, lang, reason):
    assert voice.eligible(r, lang) == reason
