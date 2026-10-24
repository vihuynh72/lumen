import json
import re
from pathlib import Path

import pytest

from lumen.ai import bedrock
from lumen.ai.intent import hide_names, read_changes

SEED = Path(__file__).resolve().parents[2] / "data" / "seed"
PATIENTS = json.loads((SEED / "patients.json").read_text())
CLINICS = json.loads((SEED / "clinics.json").read_text())
PLAN = {"patients": [{"patient_id": p["id"], "action": "transfer", "clinic_id": "C02", "slot": {"date": "2026-10-28", "shift": 1},
                      "status": "draft", "messages": {"en": "{name}, hello"}, "pinned": False} for p in PATIENTS]}
NAMES = [p["name"] for p in PATIENTS]


@pytest.mark.parametrize("text, hidden", [
    ("Maria Delgado declined", "P001 declined"),
    ("maria  DELGADO declined", "P001 declined"),
    ("Delgado declined, and Chen too", "P001 declined, and P003 too"),
    ("Guadalupe Ríos declined", "P017 declined"),
    ("guadalupe ríos declined", "P017 declined"),
    ("Ríos declined", "P017 declined"),
    ("Guadalupe Rios and Ruben declined", "P017 and P020 declined"),  # typed without accents
    ("Rubén Ochoa canceló mañana", "P020 cancelo manana"),
    ("Linda Park declined; Park cannot come", "P004 declined; P004 cannot come"),
    ("DaVita Cameron Park can only take 2 more", "DaVita Cameron Park can only take 2 more"),  # a clinic, not Linda Park
    ("DaVita Folsom can only take 4 more", "DaVita Folsom can only take 4 more"),
    ("Mariana declined", "Mariana declined"),  # not a whole name part
])
def test_hide_names(text, hidden):
    assert hide_names(text, PATIENTS, CLINICS) == hidden


def test_a_name_part_two_patients_share_stays():
    two = [{"id": "P001", "name": "Ana Cruz"}, {"id": "P002", "name": "Ana Lee"}]
    assert hide_names("Ana Cruz and Ana declined, Lee too", two, CLINICS) == "P001 and Ana declined, P002 too"


def fake_model(monkeypatch, changes):
    seen = {"calls": 0}

    def converse(model_id, system, messages, tools=None, tool_choice=None):
        seen.update(calls=seen["calls"] + 1, model_id=model_id, tool_choice=tool_choice, raw=messages[0]["content"][0]["text"])
        return {"tool_uses": [{"id": "t", "name": "change", "input": {"changes": changes}}]}
    monkeypatch.setattr(bedrock, "converse", converse)
    return seen


def test_the_model_gets_ids_clinics_and_rows_but_no_names(monkeypatch):
    seen = fake_model(monkeypatch, [{"kind": "decline", "patient_id": "P001"}])
    out = read_changes("Maria Delgado declined. Chen Wei goes to Folsom.", PLAN, CLINICS, PATIENTS, "test-fast")
    assert out == [{"kind": "decline", "patient_id": "P001"}]
    assert seen["model_id"] == "test-fast" and seen["tool_choice"] == "change"
    payload = json.loads(seen["raw"])
    sent = json.dumps(payload, ensure_ascii=False)
    words = set(re.findall(r"\w+", sent))
    assert not words & {part for name in NAMES for part in name.split()} - {"Park"}  # Park: DaVita Cameron Park
    assert payload["instruction"] == "P001 declined. P003 goes to Folsom."
    assert {c["id"] for c in payload["clinics"]} == {c["id"] for c in CLINICS if c["kind"] == "dialysis"}
    assert set(payload["clinics"][0]) == {"id", "name", "home", "slots"}
    assert set(payload["patients"][0]) == {"patient_id", "action", "clinic_id", "slot", "status"}


def test_each_kind_passes(monkeypatch):
    changes = [{"kind": "clinic_limit", "clinic_id": "C02", "more": 0},
               {"kind": "decline", "patient_id": "P012"},
               {"kind": "pin", "patient_id": "P007", "clinic_id": "C04", "date": "2026-10-28", "shift": 2}]
    fake_model(monkeypatch, changes)
    assert read_changes("x", PLAN, CLINICS, PATIENTS, "m") == changes


def test_keys_of_other_kinds_are_dropped(monkeypatch):
    fake_model(monkeypatch, [{"kind": "decline", "patient_id": "P001", "clinic_id": None, "more": None, "date": None, "shift": None}])
    assert read_changes("x", PLAN, CLINICS, PATIENTS, "m") == [{"kind": "decline", "patient_id": "P001"}]


@pytest.mark.parametrize("changes", [
    [],
    [{"kind": "decline", "patient_id": f"P00{i}"} for i in range(1, 5)],
    "decline P001",
    [{"kind": "cancel", "patient_id": "P001"}],
    [{"kind": "clinic_limit", "clinic_id": "C99", "more": 4}],
    [{"kind": "clinic_limit", "clinic_id": "H01", "more": 4}],
    [{"kind": "clinic_limit", "clinic_id": "C02", "more": -1}],
    [{"kind": "clinic_limit", "clinic_id": "C02", "more": True}],
    [{"kind": "clinic_limit", "clinic_id": "C02", "more": "4"}],
    [{"kind": "clinic_limit", "clinic_id": "C02"}],
    [{"kind": "decline", "patient_id": "P999"}],
    [{"kind": "pin", "patient_id": "P001", "clinic_id": "C02", "date": "Oct 28", "shift": 1}],
    [{"kind": "pin", "patient_id": "P001", "clinic_id": "C02", "date": "2026-10-28", "shift": 5}],
    ["P001"],
])
def test_bad_changes_raise(monkeypatch, changes):
    fake_model(monkeypatch, changes)
    with pytest.raises(ValueError):
        read_changes("x", PLAN, CLINICS, PATIENTS, "m")


def test_wrong_tool_or_no_model_raises(monkeypatch):
    monkeypatch.setattr(bedrock, "converse", lambda *a, **k: {"tool_uses": [{"id": "t", "name": "explain", "input": {}}]})
    with pytest.raises(ValueError):
        read_changes("x", PLAN, CLINICS, PATIENTS, "m")
    seen = fake_model(monkeypatch, [{"kind": "decline", "patient_id": "P001"}])
    with pytest.raises(ValueError):
        read_changes("x", PLAN, CLINICS, PATIENTS, "")
    assert seen["calls"] == 0
