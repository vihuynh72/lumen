import json
from pathlib import Path

import pytest

from fake_s3 import FakeS3
from lumen import store

SEED = Path(__file__).resolve().parents[2] / "data" / "seed"


@pytest.fixture(autouse=True)
def fake(monkeypatch):
    monkeypatch.setenv("BUCKET", "test-bucket")
    s3 = FakeS3()
    monkeypatch.setattr(store, "_client", s3)
    return s3


def upload_seed(s3):
    for file in store.SEED_FILES.values():
        s3.put_object(Bucket="b", Key=f"seed/{file}", Body=(SEED / file).read_bytes())


def test_load_seed(fake):
    upload_seed(fake)
    seed = store.load_seed()
    assert len(seed["patients"]) == 40 and seed["rules"]["drive_cap_minutes"] == 60


def test_load_seed_missing_file_raises(fake):
    with pytest.raises(LookupError):
        store.load_seed()


def test_event_and_plan_versions():
    assert store.load_event("E1") is None and store.latest_plan("E1") is None
    store.save_event({"event_id": "E1"})
    for v in (1, 2, 10):
        store.save_plan({"event_id": "E1", "version": v})
    assert store.load_event("E1") == {"event_id": "E1"}
    assert store.latest_plan("E1")["version"] == 10  # numeric, not text order
    assert store.delete_plans("E1") == 3 and store.latest_plan("E1") is None


def test_latest_event_is_the_newest():
    store.save_event({"event_id": "E1"})
    store.save_event({"event_id": "E2"})
    assert store.latest_event() == {"event_id": "E2"}


def test_reset_keeps_seed(fake):
    upload_seed(fake)
    store.save_event({"event_id": "E1"})
    store.save_plan({"event_id": "E1", "version": 1})
    fake.put_object(Bucket="b", Key="audio/E1/P001.es.mp3", Body=b"mp3")
    assert store.reset() == 3
    assert all(k.startswith("seed/") for k in fake.objects)


def test_real_client_presigns_on_the_regional_host(monkeypatch):
    monkeypatch.setattr(store, "_client", None)
    monkeypatch.setenv("AWS_REGION", "us-east-2")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")
    url = store.s3().generate_presigned_url("get_object", Params={"Bucket": "lumen-test", "Key": "audio/x.mp3"}, ExpiresIn=60)
    assert url.startswith("https://lumen-test.s3.us-east-2.amazonaws.com/audio/x.mp3?") and "us-east-2" in url
