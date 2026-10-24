"""Offline text generation checks against the shared plan fixture."""

from copy import deepcopy
import importlib
import json
import logging
from pathlib import Path
from threading import Barrier, Event, Lock

import pytest
from botocore.exceptions import BotoCoreError, ClientError


FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"
LANGS = {"P001": "es", "P002": "en", "P003": "zh", "P004": "en", "P005": "en"}


@pytest.fixture
def inputs(monkeypatch):
    monkeypatch.setenv("BEDROCK_MODEL_FAST", "test-fast")
    return (json.loads((FIXTURES / "plan.v1.json").read_text()),
            json.loads((FIXTURES / "state.json").read_text())["clinics"], LANGS.copy())


def generated(facts):
    messages = {}
    strings = facts["strings"]
    for lang, values in strings.items():
        when, pickup, place = values["when"], values["pickup_time"], facts["clinic_name"]
        own_ride = facts["ride"] in ("self", "family")
        if lang == "en":
            ride = f"Please leave home by {pickup}." if own_ride else f"A ride picks you up at {pickup}."
            messages[lang] = f"{when}, {place}. {{name}}, your treatment is scheduled. {ride}"
        elif lang == "es":
            viaje = f"Salga de casa a las {pickup}." if own_ride else f"Un transporte le recoge a las {pickup}."
            messages[lang] = f"{when}, {place}. {{name}}, su tratamiento está programado. {viaje}"
        else:
            travel = "出发" if own_ride else "等候接送"
            messages[lang] = f"{when}，{place}。{{name}}，请于{pickup}{travel}。"
    return {"patient_id": facts["patient_id"], "reason_text": facts["reason_text"], "messages": messages}


def response(payload):
    value = ({"patients": [generated(row) for row in payload["patients"]]}
             if "patients" in payload else {"summary": payload["summary"]})
    return {"stop_reason": "tool_use", "tool_uses": [{"name": "write_plan_text", "input": value}]}


def install(monkeypatch, change=None):
    module = importlib.import_module("lumen.ai.text")
    calls = []

    def converse(model_id, system, messages, tools=None, tool_choice=None):
        assert model_id == "test-fast"
        assert tool_choice == "write_plan_text"
        assert [tool["toolSpec"]["name"] for tool in tools] == ["write_plan_text"]
        payload = json.loads(messages[0]["content"][0]["text"])
        calls.append(payload)
        result = response(payload)
        return change(payload, result) if change else result

    monkeypatch.setattr(module.bedrock, "converse", converse)
    return module.write_plan_text, calls


def test_clean_three_languages_and_counted_summary(monkeypatch, inputs):
    write, calls = install(monkeypatch)
    plan, clinics, langs = inputs
    result = write(plan, clinics, langs)
    assert len(calls) == 1
    expected = [generated(row) for row in calls[0]["patients"]]
    for row, text in zip(result["patients"], expected):
        assert row["reason_text"] == text["reason_text"]
        assert row["messages"] == text["messages"]
        assert list(row["messages"]) == (["en", langs[row["patient_id"]]]
                                        if langs[row["patient_id"]] != "en" else
                                        (["en"] if row["slot"] else []))
        assert {k: v for k, v in row.items() if k not in ("messages", "reason_text")} == {
            k: v for k, v in plan["patients"][row["rank"] - 1].items()
            if k not in ("messages", "reason_text")}
    assert result["summary"] == ("2 patients dialyze early, 2 move to another clinic, "
                                 "and 1 needs a staff call. Book 1 paratransit ride today.")
    assert result["summary"].count(".") == 2


def test_only_ids_and_input_are_preserved(monkeypatch, inputs):
    write, calls = install(monkeypatch)
    before = deepcopy(inputs)
    result = write(*inputs, only_ids=["P001"])
    assert inputs == before
    assert result is not inputs[0]
    assert len(calls) == 1
    assert [r["patient_id"] for r in calls[0]["patients"]] == ["P001"]
    assert result["summary"] == before[0]["summary"]
    for old, new in zip(before[0]["patients"], result["patients"]):
        if old["patient_id"] != "P001":
            assert new == old
    result["patients"][0]["flags"].append("changed copy")
    assert inputs == before


def test_no_names_or_home_locations_reach_converse(monkeypatch, inputs):
    module = importlib.import_module("lumen.ai.text")
    inputs[0]["patients"][0].update(name="Private Patient", home={"lat": 38.731234, "lng": -120.791234})
    inputs[0]["audit"] = [{"change": "Private Patient at 38.731234"}]
    seen = []

    def spy(*args, **kwargs):
        seen.append(json.dumps([args, kwargs], ensure_ascii=False))
        return response(json.loads(args[2][0]["content"][0]["text"]))

    monkeypatch.setattr(module.bedrock, "converse", spy)
    module.write_plan_text(*inputs)
    for value in ("Private Patient", "38.731234", "-120.791234", "Maria Delgado", "Chen Wei", "James Whitfield", "Linda Park"):
        assert all(value not in call for call in seen)


def test_client_error_propagates(monkeypatch, inputs):
    error = ClientError({"Error": {"Code": "ThrottlingException", "Message": "quota"}}, "Converse")

    def fail(*_):
        raise error

    write, calls = install(monkeypatch, fail)
    with pytest.raises(ClientError) as caught:
        write(*inputs)
    assert caught.value is error
    assert len(calls) == 1


def test_missing_model_is_clear(monkeypatch, inputs):
    write, calls = install(monkeypatch)
    monkeypatch.delenv("BEDROCK_MODEL_FAST")
    with pytest.raises(ValueError, match="BEDROCK_MODEL_FAST"):
        write(*inputs)
    assert calls == []


def corrupt(result, defect):
    rows = result["tool_uses"][0]["input"]["patients"]
    if defect == "invented_id":
        rows[0]["patient_id"] = "P999"
    elif defect == "missing_row":
        rows.pop()
    elif defect == "duplicate_row":
        rows.append(deepcopy(rows[0]))
    elif defect == "long_en":
        rows[0]["messages"]["en"] += " please" * 40
    elif defect == "long_zh":
        rows[2]["messages"]["zh"] += "请" * 81
    elif defect.startswith("banned:"):
        _, lang, word = defect.split(":")
        row = next(row for row in rows if lang in row["messages"])
        row["messages"][lang] += " " + word
    elif defect == "wrong_time":
        rows[0]["messages"]["en"] = rows[0]["messages"]["en"].replace("5:15 AM", "11:59 PM").replace("05:15", "23:59")
    elif defect == "extra_time":
        rows[0]["messages"]["en"] += " Come at 11:42 PM."
    elif defect == "wrong_language":
        rows[1]["messages"]["es"] = rows[1]["messages"]["en"]
    elif defect == "traditional_zh":
        rows[2]["messages"]["zh"] = rows[2]["messages"]["zh"].replace("请", "請")
    elif defect == "missing_name":
        rows[0]["messages"]["en"] = rows[0]["messages"]["en"].replace("{name}", "")
    elif defect == "extra_name":
        rows[0]["messages"]["en"] += " {name}"
    elif defect == "invented_reason":
        rows[0]["reason_text"] = "The clinic is 99 miles away."
    elif defect == "changed_rank":
        rows[0]["rank"] = 999
    elif defect == "hospital_message":
        rows[3]["messages"] = {"en": rows[0]["messages"]["en"]}
    elif defect == "clock_roles":
        rows[0]["messages"]["en"] = ("2026-10-27 06:00, DaVita Cameron Park Dialysis. "
                                     "{name}, your treatment is at 05:15. A ride picks you up at 06:00.")
    elif defect == "pickup_claimed_as_treatment":
        rows[0]["messages"]["en"] = ("2026-10-27 06:00, DaVita Cameron Park Dialysis. "
                                     "{name}, your treatment is at 05:15.")
    elif defect == "invented_ride":
        rows[0]["messages"]["en"] = rows[0]["messages"]["en"].replace("Please leave home by", "A ride picks you up at")
    elif defect == "missing_ride":
        rows[1]["messages"]["en"] = rows[1]["messages"]["en"].replace("A ride picks you up at", "Please leave home by")


@pytest.mark.parametrize("defect", [
    "invented_id", "missing_row", "long_en", "long_zh",
    "banned:en:death", "banned:en:danger", "banned:en:risk",
    "banned:es:muerte", "banned:es:peligro", "banned:es:riesgo",
    "banned:zh:死亡", "banned:zh:危险", "banned:zh:风险",
    "wrong_time", "extra_time", "wrong_language", "traditional_zh", "missing_name", "extra_name",
    "invented_reason", "changed_rank", "hospital_message",
    "clock_roles", "pickup_claimed_as_treatment", "invented_ride", "missing_ride",
])
def test_invalid_batch_retries_once(monkeypatch, inputs, defect):
    attempts = []

    def change(payload, result):
        if "patients" in payload:
            attempts.append(payload)
            if len(attempts) == 1:
                corrupt(result, defect)
        return result

    write, _ = install(monkeypatch, change)
    result = write(*inputs)
    assert len(attempts) == 2
    assert attempts[1]["errors"]
    for row, facts in zip(result["patients"], attempts[1]["patients"]):
        assert {k: row[k] for k in ("patient_id", "reason_text", "messages")} == generated(facts)


def test_second_failure_templates_only_bad_row(monkeypatch, inputs, caplog):
    def change(payload, result):
        if "patients" in payload:
            corrupt(result, "wrong_time")
        return result

    write, calls = install(monkeypatch, change)
    result = write(*inputs)
    batches = [call for call in calls if "patients" in call]
    assert len(batches) == 2
    assert "11:59 PM" not in result["patients"][0]["messages"]["en"]
    assert "5:15 AM" in result["patients"][0]["messages"]["en"]
    assert "555-0100" in result["patients"][0]["messages"]["en"]
    for row, facts in zip(result["patients"][1:], batches[-1]["patients"][1:]):
        assert row["messages"] == generated(facts)["messages"]
    assert "P002" in caplog.text
    assert "P001" not in caplog.text
    assert "23:59" not in caplog.text


@pytest.mark.parametrize("count", [0, 1, 2])
def test_summary_uses_only_code_counts_with_plural_agreement(monkeypatch, inputs, count):
    write, calls = install(monkeypatch)
    plan, clinics, langs = inputs
    plan["patients"] = []
    for action in ("early_session", "transfer", "hospital"):
        for i in range(count):
            row = deepcopy(json.loads((FIXTURES / "plan.v1.json").read_text())["patients"][0])
            row.update(patient_id=f"{action}{i}", action=action, book_today=action == "transfer")
            plan["patients"].append(row)
    result = write(plan, clinics, langs)
    plural = count != 1
    assert result["summary"] == (
        f"{count} {'patients dialyze' if plural else 'patient dialyzes'} early, "
        f"{count} {'move' if plural else 'moves'} to another clinic, "
        f"and {count} {'need' if plural else 'needs'} a staff call. "
        f"Book {count} paratransit {'rides' if plural else 'ride'} today.")
    assert all("patients" in call and "summary" not in call for call in calls)


def test_notify_only_never_gets_a_message(monkeypatch, inputs):
    inputs[0]["patients"][0].update(action="notify_only", slot=None, clinic_id=None, pickup_time=None)

    def change(payload, result):
        if "patients" in payload:
            result["tool_uses"][0]["input"]["patients"][0]["messages"] = {"en": "Wrong message"}
        return result

    write, _ = install(monkeypatch, change)
    result = write(*inputs)
    assert result["patients"][0]["messages"] == {}
    assert result["patients"][0]["reason_text"]


def test_max_tokens_batch_splits(monkeypatch, inputs):
    def truncate(payload, result):
        return {"stop_reason": "max_tokens"} if len(payload["patients"]) > 3 else result

    write, calls = install(monkeypatch, truncate)
    result = write(*inputs, only_ids=list(LANGS))
    assert [len(call["patients"]) for call in calls] == [5, 2, 3]
    assert [row["patient_id"] for row in result["patients"]] == [row["patient_id"] for row in inputs[0]["patients"]]


def test_max_tokens_singletons_are_bounded(monkeypatch, inputs):
    inputs[0]["patients"] = inputs[0]["patients"][:2]
    write, calls = install(monkeypatch, lambda *_: {"stop_reason": "max_tokens"})
    result = write(*inputs, only_ids=["P001", "P002"])
    assert [len(call["patients"]) for call in calls] == [2, 1, 1, 1, 1]
    assert all(row["messages"]["en"] for row in result["patients"])


def test_parallel_batches_are_bounded_and_ordered(monkeypatch, inputs):
    original = inputs[0]["patients"][0]
    inputs[0]["patients"] = [{**deepcopy(original), "patient_id": f"P{i:03}", "rank": i}
                             for i in range(1, 43)]
    inputs = (inputs[0], inputs[1], {f"P{i:03}": "en" for i in range(1, 43)})
    barrier, later_finished, lock = Barrier(4, timeout=3), Event(), Lock()
    active = peak = 0

    def finish_out_of_order(payload, result):
        nonlocal active, peak
        rows = payload["patients"]
        assert len(rows) <= 10
        with lock:
            active += 1
            peak = max(peak, active)
        if rows[0]["rank"] <= 31:
            barrier.wait()
        if rows[0]["rank"] == 1:
            assert later_finished.wait(3)
        else:
            later_finished.set()
        with lock:
            active -= 1
        result["tool_uses"][0]["input"]["patients"].reverse()
        return result

    write, calls = install(monkeypatch, finish_out_of_order)
    result = write(*inputs, only_ids=list(inputs[2]))
    assert peak == 4
    assert sorted(len(call["patients"]) for call in calls) == [2, 10, 10, 10, 10]
    assert [row["patient_id"] for row in result["patients"]] == list(inputs[2])
    for row in result["patients"]:
        assert row["reason_text"]


@pytest.mark.parametrize("extra", ["unknown", "duplicate", "lookalike"])
def test_extra_ids_are_dropped_without_poisoning_good_rows(monkeypatch, inputs, extra):
    def change(payload, result):
        rows = result["tool_uses"][0]["input"]["patients"]
        extra_row = deepcopy(rows[0])
        extra_row["patient_id"] = {"unknown": "P999", "duplicate": rows[0]["patient_id"],
                                   "lookalike": rows[0]["patient_id"] + " "}[extra]
        extra_row["messages"] = {"en": "unsafe duplicate"}
        rows.append(extra_row)
        return result

    write, calls = install(monkeypatch, change)
    result = write(*inputs, only_ids=list(LANGS))
    assert len(calls) == 1
    assert result["patients"][0]["messages"] == generated(calls[0]["patients"][0])["messages"]


def test_lookalike_id_errors_only_missing_row(monkeypatch, inputs, caplog):
    def change(payload, result):
        result["tool_uses"][0]["input"]["patients"][0]["patient_id"] += " "
        return result

    write, calls = install(monkeypatch, change)
    result = write(*inputs, only_ids=list(LANGS))
    missing = inputs[0]["patients"][0]["patient_id"]
    assert calls[1]["errors"] == {missing: "missing_row"}
    assert result["patients"][1]["messages"] == generated(calls[0]["patients"][1])["messages"]
    assert caplog.text.count("text fallback") == 1
    assert f"patient_id={missing} error=missing_row" in caplog.text


@pytest.mark.parametrize("bad", ["{{name}}", "{name}your", "your{name}", "{name}_", "a\u0301{name}", "{name}\u0301your"])
def test_placeholder_must_be_standalone(monkeypatch, inputs, bad):
    def change(payload, result):
        row = result["tool_uses"][0]["input"]["patients"][0]
        row["messages"]["en"] = row["messages"]["en"].replace("{name}", bad)
        return result

    write, calls = install(monkeypatch, change)
    result = write(*inputs, only_ids=list(LANGS))
    assert len(calls) == 2
    assert calls[1]["errors"] == {"P002": "name_placeholder"}
    assert bad not in result["patients"][0]["messages"]["en"]


@pytest.mark.parametrize("lang,word", [("es", "murió"), ("es", "morirá"), ("en", "lethal"),
                                      ("zh", "致命"), ("zh", "丧命"), ("zh", "亡")])
def test_added_banned_words_have_explicit_error(monkeypatch, inputs, lang, word):
    def change(payload, result):
        corrupt(result, f"banned:{lang}:{word}")
        return result

    write, calls = install(monkeypatch, change)
    result = write(*inputs, only_ids=list(LANGS))
    assert len(calls) == 2
    assert set(calls[1]["errors"].values()) == {"banned_word"}
    assert all(word not in r["messages"].get(lang, "") for r in result["patients"])


@pytest.mark.parametrize("char", ["😀", "⚠", "❤", "1️⃣", "\u202e", "\u2066", "\u200b", "\ufe0f"])
def test_emoji_and_format_characters_are_rejected(monkeypatch, inputs, char):
    def change(payload, result):
        result["tool_uses"][0]["input"]["patients"][0]["messages"]["en"] += char
        return result

    write, calls = install(monkeypatch, change)
    result = write(*inputs, only_ids=list(LANGS))
    assert len(calls) == 2
    assert set(calls[1]["errors"].values()) == {"unsupported_character"}
    assert char not in result["patients"][0]["messages"]["en"]


def test_fallback_log_codes_and_per_call_counts(monkeypatch, inputs, caplog):
    caplog.set_level(logging.INFO, logger="lumen.ai.text")

    def change(payload, result):
        corrupt(result, "wrong_time")
        return result

    write, _ = install(monkeypatch, change)
    write(*inputs)
    lines = [r.getMessage() for r in caplog.records if r.name == "lumen.ai.text"]
    assert "text fallback patient_id=P002 error=time_strings" in lines
    assert lines.count("text generation bedrock_rows=4 template_rows=1") == 1
    assert all("23:59" not in line and "DaVita" not in line for line in lines)


@pytest.mark.parametrize("lang,when,pickup", [
    ("en", "Wednesday, October 28 at 6:00 AM", "5:15 AM"),
    ("es", "miércoles 28 de octubre a las 6:00 a. m.", "5:15 a. m."),
    ("zh", "10月28日 周三 上午6:00", "凌晨5:15"),
])
def test_human_readable_strings_are_preformatted_by_language(monkeypatch, inputs, lang, when, pickup):
    row = inputs[0]["patients"][0]
    row["slot"] = {"date": "2026-10-28", "shift": 1}
    inputs[2][row["patient_id"]] = lang
    write, calls = install(monkeypatch)
    result = write(*inputs, only_ids=[row["patient_id"]])
    facts = calls[0]["patients"][0]
    assert facts.get("strings", {}).get(lang) == {"when": when, "pickup_time": pickup}
    assert result["patients"][0]["messages"][lang].startswith(when)
    assert pickup in result["patients"][0]["messages"][lang]
    assert result["patients"][0]["messages"] == generated(facts)["messages"]


@pytest.mark.parametrize("clock,en,es,zh", [
    ("00:00", "12:00 AM", "12:00 a. m.", "凌晨12:00"),
    ("12:00", "12:00 PM", "12:00 p. m.", "中午12:00"),
    ("15:07", "3:07 PM", "3:07 p. m.", "下午3:07"),
])
def test_pickup_noon_midnight_and_minutes(monkeypatch, inputs, clock, en, es, zh):
    for lang, expected in (("en", en), ("es", es), ("zh", zh)):
        inputs[0]["patients"][0]["pickup_time"] = f"2026-10-27T{clock}:00-07:00"
        inputs[2]["P002"] = lang
        write, calls = install(monkeypatch)
        write(*inputs, only_ids=["P002"])
        assert calls[0]["patients"][0].get("strings", {}).get(lang, {}).get("pickup_time") == expected


def test_address_amador_is_not_a_clock(monkeypatch, inputs):
    row = inputs[0]["patients"][0]
    clinic = next(c for c in inputs[1] if c["id"] == row["clinic_id"])
    clinic.update(name="SHC", address="12 Amador Way")

    def change(payload, result):
        message = result["tool_uses"][0]["input"]["patients"][0]["messages"]
        message["en"] = message["en"].replace("SHC.", "SHC, 12 Amador Way.")
        return result

    write, calls = install(monkeypatch, change)
    result = write(*inputs, only_ids=[row["patient_id"]])
    assert len(calls) == 1
    assert "12 Amador Way" in result["patients"][0]["messages"]["en"]


@pytest.mark.parametrize("extra", ["12 AM", "12:30", "12 a. m.", "五点", "12：30", "12.30"])
def test_extra_clock_forms_are_rejected(monkeypatch, inputs, extra):
    def change(payload, result):
        result["tool_uses"][0]["input"]["patients"][0]["messages"]["en"] += " " + extra
        return result

    write, calls = install(monkeypatch, change)
    write(*inputs, only_ids=["P002"])
    assert len(calls) == 2
    assert calls[1]["errors"] == {"P002": "time_strings"}


def test_all_seed_clinic_templates_fit_localized_limits(monkeypatch, inputs):
    clinics = json.loads((FIXTURES.parents[1] / "data" / "seed" / "clinics.json").read_text())
    plan, _, _ = inputs
    row = plan["patients"][0]
    for clinic in clinics:
        for lang in ("en", "es", "zh"):
            row.update(clinic_id=clinic["id"], ride="paratransit", slot={"date": "2026-09-30", "shift": 4})
            write, _ = install(monkeypatch, lambda *_: {"stop_reason": "max_tokens"})
            result = write(plan, clinics, {row["patient_id"]: lang}, only_ids=[row["patient_id"]])
            for code, message in result["patients"][0]["messages"].items():
                assert len(message) <= 80 if code == "zh" else len(message.split()) < 40
                assert message.count("{name}") == 1
                assert "2026-" not in message


# Ported from the review's test_adv_text.py, updated for localized facts.
ADV_FACTS = {
    "patient_id": "P1", "reason_text": "Session during shutoff.", "language": "en", "ride": "paratransit",
    "clinic_name": "SHC Folsom", "clinic_address": "210 Blue Ravine Rd Suite 100, Folsom, CA 95630",
    "action": "transfer", "rank": 1, "reasons": ["session_in_window"],
    "strings": {"en": {"when": "Wednesday, October 28 at 6:00 AM", "pickup_time": "5:06 AM"}},
}
F_EN = ADV_FACTS
F_ES = {**F_EN, "language": "es", "ride": "self", "strings": {
    **F_EN["strings"], "es": {"when": "miércoles 28 de octubre a las 6:00 a. m.", "pickup_time": "5:06 a. m."}}}
F_ZH = {**F_EN, "language": "zh", "ride": "family", "clinic_name": "DaVita Orangevale Dialysis Center",
        "strings": {**F_EN["strings"], "zh": {"when": "10月28日 周三 上午6:00", "pickup_time": "上午5:06"}}}
EN = generated(F_EN)["messages"]["en"].replace("is scheduled", "has moved")
ES = generated(F_ES)["messages"]["es"].replace("está programado", "cambio")
ZH = generated(F_ZH)["messages"]["zh"].replace("请于", "治疗已调整；")
REJECT = [
    ("en", EN.replace("6:00 AM", "06:00 AM"), "changed supplied clock"),
    ("en", EN.replace("6:00 AM", "06:00"), "24-hour clock"),
    ("en", EN.replace("moved.", "moved. Arrive 05:30."), "extra clock time"),
    ("en", EN.replace("{name}", ""), "missing name"),
    ("en", EN.replace("{name},", "{name}, {name},"), "duplicate name"),
    ("en", EN.replace("{name}", "{ name }"), "spaced placeholder"),
    ("en", EN.replace("{name}", "{Name}"), "capitalised placeholder"),
    ("en", EN.replace("moved.", "moved." + " the" * 25), "40+ words"),
    ("en", EN.replace("moved.", "moved. Danger."), "Danger"),
    ("en", EN.replace("moved.", "moved. ＲＩＳＫ."), "full-width RISK"),
    ("en", EN.replace("moved.", "moved. dan​ger."), "zero-width split danger"),
    ("en", EN.replace("moved.", "moved. dаnger."), "Cyrillic a in danger"),
    ("en", EN.replace("moved.", "moved. This is unsafe."), "unsafe"),
    ("en", EN.replace("moved.", "moved. Emergency."), "emergency"),
    ("en", EN.replace("your treatment has moved", "su tratamiento cambio"), "Spanish in en slot"),
    ("en", EN.replace("A ride picks you up at", "Please leave home by"), "own-ride wording for paratransit"),
    ("en", EN.replace("SHC Folsom", "DaVita Folsom Dialysis"), "wrong clinic"),
    ("en", EN.replace("October 28", "October 29"), "wrong day"),
    ("en", "{name}, " + EN.replace("{name}, ", ""), "name before time"),
    ("es", ES.replace("cambio.", "cambio. Peligro."), "peligro"),
    ("es", ES.replace("cambio.", "cambio. RIESGO."), "RIESGO"),
    ("es", ES.replace("cambio.", "cambio. Nadie morirá."), "morirá"),
    ("es", ES.replace("cambio.", "cambio. muerte."), "muerte"),
    ("es", ES.replace("su tratamiento cambio", "your treatment has moved"), "English in es slot"),
    ("es", ES.replace("cambio.", "cambio. Call now."), "English tail in es"),
    ("zh", ZH.replace("治疗已调整", "治疗已调整，无危险"), "危险"),
    ("zh", ZH.replace("治疗已调整", "治疗已调整，无风险"), "风险"),
    ("zh", ZH.replace("治疗已调整", "治療已調整"), "Traditional characters"),
    ("zh", ZH.replace("治疗已调整", "治療を調整"), "Japanese kana"),
    ("zh", ZH.replace("治疗已调整", "su tratamiento"), "Spanish in zh slot"),
    ("zh", ZH.replace("治疗已调整", "治疗已调整五点"), "zh numeral time"),
    ("zh", ZH.replace("治疗已调整", "治疗已调整" + "请" * 40), "zh over 80 characters"),
]
ACCEPT = [
    ("en", EN.replace("moved.", "moved." + " the" * (39 - len(EN.split()))), "exactly 39 words"),
    ("zh", ZH.replace("治疗已调整", "治疗已调整" + "请" * (80 - len(ZH))), "exactly 80 characters"),
]


def check(lang, message):
    facts = {"en": F_EN, "es": F_ES, "zh": F_ZH}[lang]
    row = generated(facts)
    row["messages"][lang] = message
    return importlib.import_module("lumen.ai.text")._row_error(row, facts)


@pytest.mark.parametrize("lang, message, label", REJECT, ids=[r[2] for r in REJECT])
def test_validator_rejects(lang, message, label):
    assert check(lang, message), f"accepted: {label}: {message!r}"


@pytest.mark.parametrize("lang, message, label", ACCEPT, ids=[r[2] for r in ACCEPT])
def test_validator_accepts_boundaries(lang, message, label):
    assert check(lang, message) is None, label



def expanded_inputs(inputs, size):
    plan, clinics, _ = inputs
    original = plan["patients"][0]
    plan["patients"] = [{**deepcopy(original), "patient_id": f"P{i:03}", "rank": i}
                        for i in range(1, size + 1)]
    return plan, clinics, {row["patient_id"]: "es" for row in plan["patients"]}


def provider_error(kind):
    if kind == "ClientError":
        return ClientError({"Error": {"Code": "AccessDeniedException", "Message": "PRIVATE prompt content"}}, "Converse")
    if kind == "BotoCoreError":
        return BotoCoreError()
    return TimeoutError("PRIVATE prompt content")


@pytest.mark.parametrize("kind", ["ClientError", "BotoCoreError", "TimeoutError"])
def test_failed_batch_preserves_successful_batches(monkeypatch, inputs, caplog, kind):
    caplog.set_level(logging.INFO, logger="lumen.ai.text")
    inputs = expanded_inputs(inputs, 21)
    error = provider_error(kind)

    def change(payload, result):
        if payload["patients"][0]["rank"] > 10:
            raise error
        return result

    write, calls = install(monkeypatch, change)
    result = write(*inputs)
    first = next(p for p in calls if p["patients"][0]["rank"] == 1)
    for row, facts in zip(result["patients"][:10], first["patients"]):
        assert row["messages"] == generated(facts)["messages"]
    assert all("555-0100" in row["messages"]["en"] for row in result["patients"][10:])
    assert caplog.text.count("text fallback") == 11
    assert f"error={kind}" in caplog.text
    assert "bedrock_rows=10 template_rows=11" in caplog.text
    assert "PRIVATE" not in caplog.text


@pytest.mark.parametrize("kind", ["ClientError", "BotoCoreError", "TimeoutError"])
def test_all_failed_batches_reraise_original_error(monkeypatch, inputs, kind):
    inputs = expanded_inputs(inputs, 21)
    error = provider_error(kind)

    def fail(*_):
        raise error

    write, calls = install(monkeypatch, fail)
    with pytest.raises(type(error)) as caught:
        write(*inputs)
    assert caught.value is error
    assert len(calls) == 3


def test_failed_split_child_preserves_successful_sibling(monkeypatch, inputs):
    inputs = expanded_inputs(inputs, 4)

    def change(payload, result):
        rows = payload["patients"]
        if len(rows) > 2:
            return {"stop_reason": "max_tokens"}
        if rows[0]["rank"] > 2:
            raise TimeoutError("private")
        return result

    write, calls = install(monkeypatch, change)
    result = write(*inputs)
    assert len(calls) == 3
    assert result["patients"][0]["messages"] == generated(calls[1]["patients"][0])["messages"]
    assert "555-0100" in result["patients"][2]["messages"]["en"]


@pytest.mark.parametrize("truncated", [False, True])
def test_deadline_prevents_retry_and_split_calls(monkeypatch, inputs, truncated, caplog):
    module = importlib.import_module("lumen.ai.text")
    clock = [0.0]
    monkeypatch.setattr(module, "monotonic", lambda: clock[0], raising=False)

    def change(payload, result):
        clock[0] = 20.0
        if truncated:
            return {"stop_reason": "max_tokens"}
        for row in result["tool_uses"][0]["input"]["patients"]:
            row["reason_text"] = "Wrong"
        return result

    write, calls = install(monkeypatch, change)
    result = write(*inputs)
    assert len(calls) == 1
    assert all(row["reason_text"] != "Wrong" for row in result["patients"])
    assert "error=deadline" in caplog.text


def test_deadline_prevents_queued_batches(monkeypatch, inputs, caplog):
    module = importlib.import_module("lumen.ai.text")
    inputs = expanded_inputs(inputs, 60)
    clock = [0.0]
    monkeypatch.setattr(module, "monotonic", lambda: clock[0], raising=False)
    barrier = Barrier(4, timeout=3)

    def change(payload, result):
        assert clock[0] < 20
        barrier.wait()
        clock[0] = 20.0
        return result

    write, calls = install(monkeypatch, change)
    result = write(*inputs)
    assert len(calls) == 4
    assert len(result["patients"]) == 60
    assert caplog.text.count("error=deadline") == 20


def test_total_call_budget_includes_splits_and_retries(monkeypatch, inputs, caplog):
    inputs = expanded_inputs(inputs, 80)
    write, calls = install(monkeypatch, lambda *_: {"stop_reason": "max_tokens"})
    result = write(*inputs)
    assert len(calls) == 30
    assert "error=call_limit" in caplog.text
    assert len(result["patients"]) == 80
    assert all(row["messages"]["es"] for row in result["patients"])


def test_non_provider_error_is_not_hidden(monkeypatch, inputs):
    error = ValueError("programming error")

    def fail(*_):
        raise error

    write, _ = install(monkeypatch, fail)
    with pytest.raises(ValueError) as caught:
        write(*inputs)
    assert caught.value is error


def test_sdk_retries_share_the_total_attempt_budget(monkeypatch, inputs, caplog):
    module = importlib.import_module("lumen.ai.text")
    inputs = expanded_inputs(inputs, 80)
    attempts, lock = [], Lock()

    class Client:
        def converse(self, **request):
            with lock:
                attempts.append(request)
                number = len(attempts)
            if number % 2:
                raise ClientError({"Error": {"Code": "ThrottlingException", "Message": "private"}}, "Converse")
            return {"stopReason": "max_tokens", "usage": {"inputTokens": 1, "outputTokens": 1},
                    "output": {"message": {"role": "assistant", "content": []}}}

    monkeypatch.setattr(module.bedrock, "_get_client", lambda: Client())
    monkeypatch.setattr(module.bedrock, "sleep", lambda _: None)
    result = module.write_plan_text(*inputs)
    assert len(attempts) == 30
    assert "error=call_limit" in caplog.text
    assert len(result["patients"]) == 80


@pytest.mark.parametrize("expires_during_setup", [False, True])
def test_sdk_boundary_rechecks_deadline(monkeypatch, inputs, caplog, expires_during_setup):
    module = importlib.import_module("lumen.ai.text")
    clock, attempts = [0.0], []
    monkeypatch.setattr(module, "monotonic", lambda: clock[0])
    monkeypatch.setattr(module.bedrock, "sleep", lambda _: None)

    class Client:
        def converse(self, **request):
            attempts.append(request)
            clock[0] = 20.0
            raise ClientError({"Error": {"Code": "ThrottlingException", "Message": "private"}}, "Converse")

    def client():
        if expires_during_setup:
            clock[0] = 20.0
        return Client()

    monkeypatch.setattr(module.bedrock, "_get_client", client)
    result = module.write_plan_text(*inputs)
    assert len(attempts) == (0 if expires_during_setup else 1)
    assert "error=deadline" in caplog.text
    assert all(row["reason_text"] for row in result["patients"])
