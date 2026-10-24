# Lumen API (contracts v1)

One Lambda function URL. The handler routes on method and path. The JSON schemas in `contracts/schemas/` define every object. The full examples are in `contracts/fixtures/`.

## Every request

* Header `X-Demo-Key: <demo key>`. A missing or wrong key returns `401 {"error": "bad demo key", "step": "auth"}`.
* Header `Content-Type: application/json` on every POST.
* CORS: methods `GET`, `POST`; headers `content-type`, `x-demo-key`.
* Every response body is JSON.

## Conventions

* Timestamps: ISO 8601 with an explicit offset, for example `2026-10-27T18:00:00-07:00`. Dates: `YYYY-MM-DD`.
* Shifts: `1` = 06:00-10:00, `2` = 10:30-14:30, `3` = 15:00-19:00, `4` = late 19:30-23:30 (only at clinics with `late_shift: true`). Local time, America/Los_Angeles.
* IDs: dialysis clinics `C01`, `C02`, ...; hospitals `H01`, ...; patients `P001`, ...; the demo event `PSPS-DEMO-01`.
* Plans never hold patient names. The frontend joins names from `GET /state` by `patient_id`. Messages already have the name filled in.

## Errors

Every error has this shape:

```json
{"error": "no event PSPS-DEMO-99", "step": "plan"}
```

| Status | When |
| -- | -- |
| 400 | Bad JSON or a missing field. `step` names the route, for example `"alert"`. |
| 401 | Missing or wrong `X-Demo-Key`. `step` is `"auth"`. |
| 404 | Unknown route, event or patient. |
| 500 | A pipeline step failed. `step` is that step: `parse`, `affected`, `rank`, `match`, `drive`, `text`, `replan`, `voice`, `store`. |

The frontend shows `error` and never a stack trace.

## GET /state

Seed files (names included), the latest event and plan, and the deployed version.

Request: no body.

Response `200` (fixture: `fixtures/state.json`):

```json
{
  "version": "a1b2c3d",
  "clinics": [{"id": "C01", "name": "DaVita Cameron Park Dialysis", "home": true, "...": "..."}],
  "patients": [{"id": "P001", "name": "Maria Delgado", "...": "..."}],
  "outage_area": {"type": "FeatureCollection", "features": ["..."]},
  "rules": {"label": "Demo assumptions, not clinical guidance", "...": "..."},
  "event": null,
  "plan": null
}
```

`version` is the short commit SHA of the deployed code, or `"dev"`. `event` and `plan` are `null` before the first alert.

## POST /alert

Parses a notice into the event JSON and saves it as `plans/(event_id)/event.json`.

Request:

```json
{"notice_text": "PG&E PUBLIC SAFETY POWER SHUTOFF (PSPS) WARNING\nEvent ID: PSPS-DEMO-01\n..."}
```

Response `200`: the event (fixture: `fixtures/event.json`, schema: `event.schema.json`).

```json
{
  "event_id": "PSPS-DEMO-01",
  "notice_type": "warning",
  "issued_at": "2026-10-26T08:30:00-07:00",
  "start": "2026-10-27T18:00:00-07:00",
  "end": "2026-10-29T12:00:00-07:00",
  "area_name": "Cameron Park, Shingle Springs and Placerville (El Dorado County)",
  "source_text": "PG&E PUBLIC SAFETY POWER SHUTOFF (PSPS) WARNING\n..."
}
```

## POST /plan

Builds plan v1 for an event and saves it as `plans/(event_id)/plan.v1.json`.

Request:

```json
{"event_id": "PSPS-DEMO-01"}
```

Response `200`: plan v1 (fixture: `fixtures/plan.v1.json`, schema: `plan.schema.json`). One row:

```json
{
  "patient_id": "P001",
  "rank": 1,
  "urgency": 55,
  "difficulty": 65,
  "reasons": ["session_in_window", "heart_failure", "paratransit", "home_in_outage", "no_car", "lives_alone", "wheelchair", "limited_english"],
  "reason_text": "Heart failure and a Wednesday session in the shutoff window put this patient first, and paratransit with a wheelchair makes travel hard.",
  "affected_session": "2026-10-28T06:00:00-07:00",
  "action": "early_session",
  "clinic_id": "C01",
  "slot": {"date": "2026-10-27", "shift": 1},
  "drive_minutes": 7,
  "drive_source": "estimate",
  "pickup_time": "2026-10-27T05:33:00-07:00",
  "ride": "paratransit",
  "book_today": true,
  "flags": ["long_gap_after"],
  "messages": {"en": "Maria Delgado, this is DaVita Cameron Park. ...", "es": "Maria Delgado, le habla DaVita Cameron Park. ..."},
  "audio": {},
  "status": "draft",
  "pinned": false
}
```

Row rules:

* `action` is `early_session`, `transfer`, `hospital` or `notify_only`.
* `hospital`: no chair fits. `clinic_id` is the hospital, `slot`, `drive_minutes`, `drive_source` and `pickup_time` are `null`, `flags` has `staff_call`, and the patient is in `overflow`.
* `notify_only`: the usual slot stays. `affected_session`, `clinic_id`, `slot`, `drive_minutes`, `drive_source` and `pickup_time` are `null`.
* `reason_text` is `null`, `messages` is `{}` and `summary` is `""` until the text step runs.
* `flags`: `long_gap_after` (the next usual session comes more than `gap_limit_days` after the new slot), `staff_call` (a person must call this patient).

## POST /replan

Applies one instruction from Rosa and returns the next plan version, the diff and a two-sentence summary.

Request:

```json
{"event_id": "PSPS-DEMO-01", "instruction": "DaVita Folsom Dialysis can only take one more"}
```

Response `200` (fixture: `fixtures/replan.response.json`):

```json
{
  "plan": {"event_id": "PSPS-DEMO-01", "version": 2, "...": "..."},
  "diff": [
    {"patient_id": "P004", "field": "action", "from": "transfer", "to": "hospital"},
    {"patient_id": "P004", "field": "clinic_id", "from": "C02", "to": "H01"},
    {"patient_id": "P004", "field": "slot", "from": {"date": "2026-10-29", "shift": 1}, "to": null}
  ],
  "summary": "DaVita Folsom can take only one more patient, so P004 moves from Folsom to the staff call list. Two patients now need a staff call."
}
```

`diff` is a flat list, one entry per changed field per patient. The diff covers these fields: `action`, `clinic_id`, `slot`, `drive_minutes`, `drive_source`, `pickup_time`, `book_today`, `flags`. Text fields are not in the diff.

The 5-patient fixture uses "can only take one more", so the cut changes a row. The demo line on the full roster is "(receiving clinic name) can only take four more".

## POST /approve

Approves rows, pins or declines a row, or records a call result. Returns the updated plan as a new version, with one audit entry per change.

Request:

```json
{"event_id": "PSPS-DEMO-01", "patient_ids": ["all"], "edits": []}
```

```json
{"event_id": "PSPS-DEMO-01", "patient_ids": [], "edits": [{"patient_id": "P003", "pinned": true}, {"patient_id": "P004", "status": "declined"}]}
```

* `patient_ids`: `["all"]` or a list of IDs. Each one gets `status: "approved"`.
* `edits`: each edit has `patient_id` and optionally `pinned` (boolean) and `status` (`approved`, `confirmed`, `declined`, `no_answer`).

Response `200`: the updated plan (schema: `plan.schema.json`). Audit entry example:

```json
{"ts": "2026-10-26T09:05:00-07:00", "actor": "Rosa", "change": "approved all"}
```

## POST /voice

Makes (or reuses) the voice note for one patient and language. Returns a presigned MP3 URL valid for 1 hour.

Request:

```json
{"event_id": "PSPS-DEMO-01", "patient_id": "P001", "lang": "es"}
```

Response `200` (fixture: `fixtures/voice.response.json`):

```json
{"url": "https://example.com/audio.mp3"}
```

Voice notes exist only for confirmed moves. The MP3 is saved as `audio/(event_id)/(patient_id).(lang).mp3`, and the plan row's `audio` gets that key.

## POST /reset

Deletes `plans/` and `audio/` for the demo event, so the demo starts clean.

Request: no body (or `{}`).

Response `200`:

```json
{"ok": true, "deleted": 4}
```

## Fixtures

| File | What it holds |
| -- | -- |
| `state.json` | `GET /state` after `/alert` and `/plan` on seed v0 (3 clinics, 5 patients) |
| `event.json` | The demo notice, parsed |
| `affected.json` | `find_affected` output for seed v0 (team rules, Rule 3) |
| `plan.v1.json` | Plan v1: early_session, two transfers, hospital, notify_only |
| `plan.v2.json` | Plan v2 after "DaVita Folsom Dialysis can only take one more" |
| `replan.response.json` | `POST /replan` response for that instruction |
| `voice.response.json` | `POST /voice` response |
