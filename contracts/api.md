# Lumen API (contracts v1)

One Lambda function URL. The handler routes on method and path. The JSON schemas in `contracts/schemas/` define every object. The full examples are in `contracts/fixtures/`.

## Every request

* Header `X-Demo-Key: <demo key>`. A missing or wrong key returns `401 {"error": "bad demo key", "step": "auth"}`.
* Header `Content-Type: application/json` on every POST.
* CORS: methods `GET`, `POST`; headers `content-type`, `x-demo-key`.
* Every response body is JSON.
* Optional query `?session=<8 to 40 lowercase letters or digits>`. Each session has its own events and plans, so one viewer's run or Reset does not change another viewer's plan. Without it, the request uses the shared space (scripts and `demo_check`). A bad value returns `400`, `step` `"router"`.

## Conventions

* Timestamps: ISO 8601 with an explicit offset, for example `2026-10-27T18:00:00-07:00`. Dates: `YYYY-MM-DD`.
* Shifts: `1` = 06:00-10:00, `2` = 10:30-14:30, `3` = 15:00-19:00, `4` = late 19:30-23:30 (only at clinics with `late_shift: true`). Local time, America/Los_Angeles.
* IDs: dialysis clinics `C01`, `C02`, ...; hospitals `H01`, ...; patients `P001`, ...; the demo event `PSPS-DEMO-01`.
* A session runs from the shift start for the patient's `hours`. It is affected when it is at a closed clinic, starts before the window end and ends after the window start.
* Names: plan rows have no name field. The frontend joins names from `GET /state` by `patient_id`. Stored plan files keep the `{name}` placeholder in `messages`. The router fills names only in HTTP responses, so the fixtures show names. AI modules get stored plans. No model ever sees names: the re-plan intent step replaces names in the instruction with patient IDs before its model call.
* Schemas: `clinic`, `patient`, `event`, `rules`, `affected` (find_affected output), `plan`, `replan` (POST /replan response), `speak` (POST /speak response), `check` (POST /check response).

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
| 409 | The request does not fit the plan state, for example a voice note for a row with no approved move. |
| 500 | A pipeline step failed. `step` is that step: `parse`, `affected`, `rank`, `match`, `drive`, `text`, `replan`, `voice`, `speak`, `check`, `notify`, `store`. |

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
  "affected": null,
  "plan": null
}
```

`version` is the short commit SHA of the deployed code, or `"dev"`. `event`, `affected` and `plan` are `null` before the first alert and plan. `affected` (schema `affected.schema.json`) gives the map the closed clinics and the homes in the outage area, so the frontend does not repeat the geometry.

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

`parse_source` (optional, event schema v2) says how the notice was parsed: `bedrock`, or `fallback` when the Bedrock parse failed and the router parsed the PG&E notice layout with rules. The router sets it; the model never does. Show a "Parsed by fallback rules" tag when it is `fallback`.

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
  "rank": 2,
  "urgency": 55,
  "difficulty": 65,
  "reasons": ["session_in_window", "heart_failure", "paratransit", "home_in_outage", "no_car", "lives_alone", "wheelchair", "limited_english"],
  "reason_text": "Heart failure, a Wednesday session in the window, paratransit and a wheelchair make this patient urgent and hard to move.",
  "affected_session": "2026-10-28T06:00:00-07:00",
  "action": "early_session",
  "clinic_id": "C01",
  "slot": {"date": "2026-10-27", "shift": 2},
  "drive_minutes": 6,
  "drive_source": "estimate",
  "pickup_time": "2026-10-27T10:04:00-07:00",
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
* `notify_only` exists for a patient with no affected session. With the demo window, every roster patient has one, so the fixtures have no `notify_only` row.
* `messages` is `{}` on `hospital` and `notify_only` rows. Automated messages go only to moves (early_session, transfer).
* `reason_text` is one sentence of 20 words or fewer. It is `null`, `messages` is `{}` and `summary` is `""` until the text step runs.
* `early_session`: a home-clinic slot that starts after the demo clock, ends before the window start, and falls on a later date than the patient's previous regular session before the affected one. Derive that date from `days`, not from `last_session`. Example: a Tue/Thu/Sat patient whose Thursday session is affected cannot get a Tuesday early session.
* `status: "declined"`: on the next re-run the patient gets no chair. `clinic_id`, `slot`, `drive_minutes`, `drive_source` and `pickup_time` become `null`, `flags` has `staff_call`, and the patient is in `overflow`. `action` keeps its last value.
* `flags`: `long_gap_after` (the next usual session date minus the new slot date, in calendar days, is more than `gap_limit_days`), `staff_call` (a person must call this patient).
* `timing_ms`: `total` is the wall time of the request that made this version, at least the sum of its steps. Parse is timed in `POST /alert`.

`ai_sources` (optional, plan schema v2) says who did each AI step of the request that made this version: `bedrock`, or `fallback` when the Bedrock step failed or ran past its time limit and the router used its rule-based path. Only the steps that ran have a key. `POST /plan` sets `text`, for example `{"text": "fallback"}`. Rank uses rules only, so it has no key. `POST /approve` runs no AI step, so it sets `{}`. The router sets it. The model never does. Show a fallback tag on each step that has `fallback`.

## POST /replan

Applies one instruction from Rosa and returns the next plan version, the diff, a two-sentence summary and the changes that Lumen read from the instruction.

Request:

```json
{"event_id": "PSPS-DEMO-01", "instruction": "DaVita Folsom Dialysis can only take one more"}
```

Response `200` (fixture: `fixtures/replan.response.json`):

```json
{
  "plan": {"event_id": "PSPS-DEMO-01", "version": 2, "ai_sources": {"replan": "bedrock", "text": "bedrock"}, "...": "..."},
  "diff": [
    {"patient_id": "P004", "field": "action", "from": "transfer", "to": "hospital"},
    {"patient_id": "P004", "field": "clinic_id", "from": "C02", "to": "H01"},
    {"patient_id": "P004", "field": "slot", "from": {"date": "2026-10-29", "shift": 1}, "to": null}
  ],
  "summary": "DaVita Folsom can take only one more patient, so P004 moves from Folsom to the staff call list. Two patients now need a staff call.",
  "understood": ["DaVita Folsom Dialysis takes at most 1 more patient."]
}
```

Schema: `replan.schema.json` (the `plan` inside follows `plan.schema.json`). `diff` is a flat list, one entry per changed field per patient. The diff covers these fields: `action`, `clinic_id`, `slot`, `drive_minutes`, `drive_source`, `pickup_time`, `book_today`, `flags`, `status`, `pinned`. Text fields are not in the diff.

The router tries three steps in this order. The first step that works makes the change:

1. The Bedrock tool loop (`BEDROCK_MODEL_ID`), when `AI_STEPS` has `replan`. Limit 45 s.
2. The intent step (`BEDROCK_MODEL_FAST`), when `AI_STEPS` has `intent`. Limit 20 s. One model call reads the instruction into 1 to 3 changes. Code checks each change, applies it with the re-plan tools, re-runs matching and writes the summary.
3. The rules: only "(clinic name) can only take N more".

When all three fail, the route returns `400 {"error": "Lumen could not read that change. Try 'DaVita Folsom can only take 4 more' or 'Maria Delgado declined'.", "step": "replan"}`.

`AI_STEPS` is a comma list in the Lambda env. The default is `parse,text,replan,check,intent`. The demo Lambda uses `parse,check,intent`.

The intent step:

* Before the call, code replaces each patient name in the instruction with the patient ID: the full name, and a first or last name that exactly one patient has. Case does not matter. Accents do. Two words of a clinic name stay, so "Cameron Park" is not Linda Park. The model never sees names or addresses.
* The model gets the instruction, the dialysis clinics (`id`, `name`, `home`, `slots` with `date`, `shift`, `open_chairs`, after earlier cuts) and the plan rows (`patient_id`, `action`, `clinic_id`, `slot`, `status`).
* The model calls the tool `change` with `{"changes": [...]}`. Each change is one of:
  * `{"kind": "clinic_limit", "clinic_id": "C02", "more": 4}`: the clinic takes at most `more` visiting patients, with the same algorithm as the rules.
  * `{"kind": "decline", "patient_id": "P012"}`: the patient will not come (`decline_patient`).
  * `{"kind": "pin", "patient_id": "P012", "clinic_id": "C02", "date": "2026-10-28", "shift": 1}`: the patient goes to that slot (`pin_patient`).
* Code rejects the whole reply, and the router tries the rules, when the list is empty or has more than 3 changes, a kind is unknown, a change has a missing or extra key, an ID is not in the plan or not a dialysis clinic, `more` is below 0, or a tool rejects the change (for example a pin to a slot the clinic does not have).

`understood` is one plain sentence per applied change. Code writes it from the change, with patient names. It is in the response only, never in the stored plan:

| Change | Sentence |
| -- | -- |
| `clinic_limit` | "DaVita Folsom Dialysis takes at most 4 more patients." |
| `decline` | "Maria Delgado will not come. Staff call them." |
| `pin` | "Maria Delgado goes to DaVita Folsom Dialysis, Wed Oct 28, 6:00 AM." |

The rules path returns the `clinic_limit` sentence. The Bedrock tool loop returns `[]`. `summary` has no patient names: the stored plan keeps it.

`plan.ai_sources` has `replan` and `text`, for example `{"replan": "fallback", "text": "bedrock"}`. `replan` is `bedrock` when the tool loop or the intent step made the change, and `fallback` when the rules made it. `text` covers only the rows that the re-plan changed.

"(clinic) can only take N more" means: at most N visiting patients at that clinic across all slots of the event. Chairs go in rank order. The orchestrator calls `set_clinic_capacity` once per slot to get this result.

The 5-patient fixture uses "can only take one more", so the cut changes a row. The demo line on the full roster is "(receiving clinic name) can only take four more". The demo runs one re-plan.

`plan.capacity_overrides` (optional, plan schema v3) saves each chair cut that a re-plan applied: `[{"clinic_id": "C02", "date": "2026-10-29", "shift": 1, "open_chairs": 1}]`. Every later version keeps the cuts. A second re-plan starts from the seed chair counts with these cuts applied. A later cut of the same slot replaces the earlier cut. A plan with no cut has no `capacity_overrides`.

A re-plan that changes the `action`, `clinic_id` or `slot` of a row with a sent packet sets `packet.status` to `stale`. `sent_at` stays. The row goes back to `draft`. Show a "Stale" tag and tell staff to inform the old facility.

The same re-plan sets `note.status` to `stale` on a row with a `sent` or `queued` voice note. The row can get a new note after approval (see POST /notify).

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

Response `200`: the updated plan (fixture: `fixtures/approve.response.json`, schema: `plan.schema.json`). Audit entry example:

```json
{"ts": "2026-10-26T09:05:00-07:00", "actor": "Rosa", "change": "approved all"}
```

## POST /check

Checks the latest plan version. Code finds every issue. Bedrock only writes each issue again as one plain sentence. The route saves nothing.

Request:

```json
{"event_id": "PSPS-DEMO-01"}
```

Response `200` (fixture: `fixtures/check.response.json`, schema: `check.schema.json`):

```json
{
  "issues": [
    {"patient_id": null, "facility_id": "C02", "severity": "block", "code": "over_capacity", "text": "DaVita Folsom Dialysis has one open chair on Thursday morning, but two patients are booked there.", "slot": {"date": "2026-10-29", "shift": 1}, "source": "bedrock"},
    {"patient_id": "P003", "facility_id": "C02", "severity": "warning", "code": "hbv_test_missing", "text": "No HBV test date on file for P003: receiver tests on intake, result within 7 days.", "source": "template"},
    {"patient_id": "P003", "facility_id": "C02", "severity": "warning", "code": "language_unconfirmed", "text": "Confirm that DaVita Folsom Dialysis can speak Chinese with P003.", "source": "template", "soft": true}
  ],
  "counts": {"block": 1, "warning": 5},
  "explained_by": "bedrock"
}
```

How code checks the plan:

* From each row, the check reads only `action`, `clinic_id`, `slot`, `status`, `messages` and `affected_session`. It calculates the drive, the pickup time and the gap again from the seed. It counts chairs from the seed slots with `capacity_overrides` applied.
* The check skips `notify_only` rows and `declined` rows.
* Blocks come first. Warnings come next. Soft warnings come last.
* Texts use patient IDs, never names.

| Code | Severity | When |
| -- | -- | -- |
| `hbv_no_isolation` | block | An HBsAg-positive patient goes to a facility with no isolation station. |
| `over_capacity` | block | A clinic has more patients than open chairs on one date and shift. `patient_id` is `null`. `slot` gives the date and shift. |
| `clinic_closed` | block | A transfer goes to a clinic in the outage area with no full backup power. |
| `no_visitors` | block | A transfer goes to a clinic with `accepts_visiting: false`. |
| `no_late_shift` | warning | A patient with usual shift 4 goes to a clinic with no late shift. |
| `hbv_test_missing` | warning | A transfer or hospital row has no HBV test date. The seed has no test dates, so every transfer and hospital row gets this warning. |
| `same_day_paratransit` | warning | A paratransit patient has a new session on the date of the plan's `created_at`, or earlier. |
| `early_paratransit_pickup` | warning | A paratransit pickup is before 6:30 AM. |
| `long_drive` | warning | A transfer drive is longer than `drive_cap_minutes`. |
| `long_gap_after` | warning | The next usual session is more than `gap_limit_days` after the new slot. |
| `no_message_in_language` | warning | An `early_session` or `transfer` row has no message in the patient's language. |

`clinic_closed`, `no_visitors`, `no_late_shift` and `long_drive` apply to transfers only. Hospital rows are staff calls.

What Bedrock does:

* The router calls `BEDROCK_MODEL_FAST` with the issues and the facts of each moved row. The facts have patient IDs and no names.
* The model returns one sentence per issue. The router keeps a sentence only when it is not empty and has 30 words or fewer. That issue gets `source: "bedrock"`. Every other issue keeps its template sentence and gets `source: "template"`.
* The model cannot change a severity or a code. It cannot remove an issue. A block stays a block.
* The model can add soft warnings, but only from the list below. Code keeps a soft warning only when the row facts make it true. A soft warning has `soft: true` and a template sentence.
* The model has 25 s. When it fails or runs past 25 s, every issue keeps its template sentence.
* `explained_by` is `bedrock` when at least one issue has `source: "bedrock"`. Otherwise it is `template`.

| Soft warning | Code keeps it when |
| -- | -- |
| `heart_failure_long_gap` | The patient has the heart failure flag and a long gap after the new slot. |
| `lives_alone_night_pickup` | The patient lives alone and the pickup is before 06:00 or at 19:00 or later. |
| `wheelchair_long_drive` | The patient uses a wheelchair and the drive is more than 30 minutes. |
| `language_unconfirmed` | The patient's language is not `en` and the row is a transfer or hospital row. |

Show an AI tag on each sentence with `source: "bedrock"` and on each soft warning.

## POST /packet

Records a SIMULATED send of the transfer packet for each listed row. Nothing leaves Lumen. Returns the next plan version with `packet` on each sent row and one audit entry for each send.

Request:

```json
{"event_id": "PSPS-DEMO-01", "patient_ids": ["P003", "P004", "P005", "P001"]}
```

* `patient_ids`: a list of one or more patient IDs. An empty list or a value that is not a list returns `400`. An unknown ID returns `404`.

Response `200` (fixture: `fixtures/packet.response.json`, the `plan` follows `plan.schema.json`):

```json
{
  "plan": {"event_id": "PSPS-DEMO-01", "version": 3, "...": "..."},
  "sent": ["P003", "P004", "P005"],
  "skipped": [{"patient_id": "P001", "reason": "early_session rows get no packet"}]
}
```

A sent row gets `packet` (optional, plan schema v3):

```json
{"status": "sent", "sent_at": "2026-10-26T09:10:00-07:00", "channel": "simulated fax", "to": "DaVita Folsom Dialysis (279) 278-9702", "version": 2}
```

Audit entry example:

```json
{"ts": "2026-10-26T09:10:00-07:00", "actor": "Rosa", "change": "P003 packet sent (simulated fax to (279) 278-9702)"}
```

* Only a `transfer` or `hospital` row with status `approved` or `confirmed` gets a packet. Every other row is in `skipped` with the reason.
* The route runs the plan check first. A row with a block is skipped. Its reason starts with `blocked:` and gives the block sentence.
* A row with a `sent` packet is skipped. A row with a `stale` packet can be sent again.
* `packet.version` is the plan version that the packet was built from. `sent_at` is the demo clock.
* When the route sends no row, it makes no new version. `plan` is then the latest version.
* Two requests on the same version return `409`, as on POST /approve.
* A later re-plan can set `packet.status` to `stale` (see POST /replan).

Show "Simulated sends. No data leaves Lumen." near every send button.

## POST /notify

Records a SIMULATED voice note for each listed row. Nothing leaves Lumen and no audio is made (POST /voice makes audio on demand). Each patient gets one note, in their own language.

Request:

```json
{"event_id": "PSPS-DEMO-01", "patient_ids": ["P001", "P007"], "call_instead": ["P012"], "dry_run": true}
```

* `patient_ids`: `["all"]` (every row) or a list of one or more patient IDs. An empty list, a value that is not a list, or `"all"` with IDs returns `400`. An unknown ID returns `404`.
* `call_instead` (optional, default `[]`): IDs that the plan check says to call instead. The frontend sends the patient IDs of the latest `/check` issues with the codes `lives_alone_night_pickup` or `heart_failure_long_gap`. An ID that is not in the plan returns `400`.
* `dry_run` (optional, default `false`): `true` returns what would happen, saves nothing and makes no new version. A value that is not `true` or `false` returns `400`.

Response `200` (fixture: `fixtures/notify.response.json`, the `plan` follows `plan.schema.json`):

```json
{"plan": {"event_id": "PSPS-DEMO-01", "version": 3, "...": "..."}, "sent": ["P002", "P001", "P003"], "queued": [],
 "skipped": [{"patient_id": "P005", "reason": "staff_call"}, {"patient_id": "P004", "reason": "call_instead"}], "dry_run": false}
```

Each listed row gets exactly one outcome. Code decides, in this order. The first match wins:

| `reason` | When |
| -- | -- |
| `declined` | `status` is `declined`. |
| `staff_call` | `action` is `hospital`, or `flags` has `staff_call`. |
| `no_message` | `action` is not `early_session` or `transfer`, or the row has no message. |
| `not_approved` | `status` is `draft`. |
| `blocked` | A `/check` block stops the row (as on POST /packet). |
| `call_instead` | The ID is in `call_instead`. |
| `already_sent` | `note.status` is `sent` or `queued`. One note per patient per change. |

Every other row is sent and gets `note` (optional, plan schema v4):

```json
{"status": "sent", "sent_at": "2026-10-26T09:12:00-07:00", "send_at": null, "lang": "es", "channel": "simulated voice note", "version": 2}
```

* `lang` is the patient's language, or `en` when the row has no message in that language.
* `version` is the plan version the note was sent from. `sent_at` is the demo clock.
* Quiet hours: when the demo clock is before 08:00 or at 20:00 or later (America/Los_Angeles), the note is queued instead: `status` `queued`, `sent_at` `null`, `send_at` the next 08:00 local time. Its ID is in `queued`, not `sent`.
* `note.status` `stale`: a later re-plan moved the row (see POST /replan). A stale row can be sent again.

When it is not a dry run and at least one note is sent or queued, the route saves a new version with one audit entry:

```json
{"ts": "2026-10-26T09:12:00-07:00", "actor": "Rosa", "change": "voice notes sent to 3 patients (simulated)"}
```

A queued send logs `"voice notes queued for 08:00 for 3 patients (simulated)"`. Otherwise `plan` is the latest version. Two requests on the same version return `409`, as on POST /approve.

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

Voice notes exist for approved moves: an `early_session` or `transfer` row with `status` `approved` or `confirmed`. Any other row returns `409 {"error": "no approved move for P005", "step": "voice"}`. The MP3 is saved as `audio/(event_id)/(patient_id).(lang).mp3`, and the plan row's `audio` gets that key.

## POST /speak

Translates English text into one language with Amazon Translate and reads it with a Polly standard voice. Returns the text and a presigned MP3 URL valid for 1 hour.

Request:

```json
{"text": "Your Wednesday session moves to Tuesday at 10:30 AM.", "lang": "es"}
```

* `text`: 1 to 600 characters of English.
* `lang`: `en`, `es`, `zh`, `ko`, `vi`, `tl`, `yue`, `ja`, `ar`, `pt`, `fr`, `ru`, `hi` or `te`. Any other value returns `400`.
* `translated` (optional, default `false`): `true` means `text` is already in `lang`, for example a template translation. The route skips Translate and only reads the text. Up to 600 characters in any script.

Response `200` (fixture: `fixtures/speak.response.json`, schema: `speak.schema.json`):

```json
{"text": "Su sesión del miércoles pasa al martes a las 10:30 a. m.", "lang": "es", "voice": "Lupe", "url": "https://example.com/speak.mp3", "note": null}
```

Polly in us-east-2 has no Vietnamese, Tagalog, Cantonese or Telugu voice. For those, `voice` and `url` are `null` and `note` says why:

```json
{"text": "Buổi lọc thận thứ Tư của bạn chuyển sang thứ Ba lúc 10:30 sáng.", "lang": "vi", "voice": null, "url": null, "note": "Polly has no Vietnamese voice"}
```

| lang | Polly voice |
| -- | -- |
| `en` | Joanna (en-US) |
| `es` | Lupe (es-US) |
| `zh` | Zhiyu (cmn-CN) |
| `ko` | Seoyeon (ko-KR) |
| `ja` | Mizuki (ja-JP) |
| `ar` | Zeina (arb) |
| `pt` | Camila (pt-BR) |
| `fr` | Celine (fr-FR) |
| `ru` | Tatyana (ru-RU) |
| `hi` | Aditi (hi-IN) |

* `en` skips Translate. `yue` is translated to Traditional Chinese (`zh-TW`), because Translate has no Cantonese.
* The route saves the MP3 and the text as `speak/(sha256 of lang and text).mp3` and `.json`. The same `lang` and `text` reuse them.
* Until the Lambda role may call Translate, the route returns `500 {"error": "translate not permitted", "step": "speak"}`. Show that error inline.

## POST /reset

Deletes the events and plans of this session, so the demo starts clean. Without `?session=`, it deletes the shared `plans/` and the `audio/` cache.

Request: no body (or `{}`).

Response `200` (fixture: `fixtures/reset.response.json`):

```json
{"ok": true, "deleted": 4}
```

## Fixtures

| File | What it holds |
| -- | -- |
| `state.json` | `GET /state` after `/alert` and `/plan` on seed v0 (3 clinics, 5 patients) |
| `event.json` | The demo notice, parsed |
| `affected.json` | `find_affected` output for seed v0, with `now` and `window` (team rules, Rule 3) |
| `plan.v1.json` | Plan v1: two early_session, two transfers, one hospital |
| `plan.v2.json` | Plan v2 after "DaVita Folsom Dialysis can only take one more" |
| `replan.response.json` | `POST /replan` response for that instruction, with `understood` |
| `approve.response.json` | `POST /approve` with `["all"]` on plan v1 |
| `check.response.json` | `POST /check` on the approved plan with a cut of C02 2026-10-29 shift 1 to 1 chair. The 2 `bedrock` sentences are examples, not a recorded model reply. |
| `packet.response.json` | `POST /packet` for P003, P004, P005 and P001 on the approved plan |
| `notify.response.json` | `POST /notify` with `["all"]` and `call_instead: ["P004"]` on the approved plan, at 09:12 |
| `voice.response.json` | `POST /voice` response |
| `speak.response.json` | `POST /speak` response for `es` |
| `reset.response.json` | `POST /reset` response |
