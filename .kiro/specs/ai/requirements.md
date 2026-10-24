# AI lane: requirements

## Introduction

The AI lane owns `backend/lumen/ai/`: the Bedrock Converse wrapper, notice parsing, patient ranking, plan text in three languages, the re-plan loop and a quality-run tool. This document describes what the lane built, taken from the code on `main`. Backend (`lambda_function.py`, `lumen/*.py`) owns the router, the plan edits and the rule-based fallbacks. AI modules never import Backend modules.

Two environment variables name the model: `BEDROCK_MODEL_FAST` (parse and plan text) and `BEDROCK_MODEL_ID` (re-plan and the smoke CLI). Both point at Claude Haiku 4.5 for now (README).

## Safety rules that apply to every module

- WHEN any AI module builds a Bedrock request, THE SYSTEM SHALL send patient IDs and codes only, never a patient name, home location, patient address or patient phone number, except that the operator's typed re-plan instruction goes to Bedrock as written (the router caps it at 500 characters), so a name typed into it would be sent.
- WHEN a model proposes an ID (patient, clinic or slot), THE SYSTEM SHALL accept it only if it appears in the plan or clinics the caller supplied.
- WHEN a model returns structured output, THE SYSTEM SHALL validate it in code before any caller sees it.
- WHEN validation fails, THE SYSTEM SHALL retry once at most, then fall back or raise, so that a bad model reply never reaches the plan.
- THE SYSTEM SHALL leave every approval to a person: AI modules never set a row to `approved` or `confirmed`; only the Backend `/approve` route does.

## Requirement 1: Notice parsing

**User story:** As Rosa, I want a pasted shutoff notice turned into the event JSON, so that the rest of the pipeline runs on correct times.

**Acceptance criteria**

1. WHEN `parse_notice` is called with a non-empty string, THE SYSTEM SHALL make one `bedrock.converse` call with the model in `BEDROCK_MODEL_FAST` and the single forced tool `record_event`.
2. WHEN `BEDROCK_MODEL_FAST` is missing, THE SYSTEM SHALL raise `RuntimeError` naming the variable, without calling Bedrock.
3. WHEN the input is blank or not a string, THE SYSTEM SHALL raise `ValueError` before calling Bedrock.
4. THE SYSTEM SHALL send the notice as the JSON field `notice_text`, so that text inside the notice cannot end the data block.
5. THE SYSTEM SHALL build the tool schema without `$schema`, `$id`, `parse_source` and `source_text`, so that the model never fills what the router sets.
6. WHEN the reply is not exactly one `record_event` call with an object input, THE SYSTEM SHALL treat it as a validation failure.
7. WHEN a required key is missing, `notice_type` is not `watch`, `warning` or `cancel`, or `event_id` or `area_name` is empty, THE SYSTEM SHALL treat it as a validation failure.
8. WHEN `event_id` or `area_name` does not appear in the notice text (case-insensitive, whitespace-normalized), THE SYSTEM SHALL treat it as a validation failure.
9. WHEN `issued_at`, `start` or `end` does not match `YYYY-MM-DDTHH:MM:SS` plus a numeric `+hh:mm` offset exactly, or is not a real date, THE SYSTEM SHALL treat it as a validation failure.
10. WHEN `end` is not after `start`, THE SYSTEM SHALL treat it as a validation failure.
11. WHEN validation fails the first time, THE SYSTEM SHALL make one fresh call that adds the failure reason as `validation_error`, log the retry at INFO with the reason only, and raise `ValueError` if the second reply also fails.
12. WHEN `bedrock.converse` raises (including a `ClientError` or a `ValueError`), THE SYSTEM SHALL let it propagate without a retry, so that the router falls back and logs the reason.
13. THE SYSTEM SHALL return exactly `event_id`, `notice_type`, `issued_at`, `start`, `end`, `area_name` (padding stripped) and `source_text` (the input), and drop any other key.

## Requirement 2: Ranking

**User story:** As Rosa, I want the patient queue ordered by the demo rules, so that the most urgent and hardest-to-move patients are planned first.

**Acceptance criteria**

1. THE SYSTEM SHALL rank without calling Bedrock; `rank_patients` is plain Python over `rules.json`.
2. WHEN a patient has an affected session, THE SYSTEM SHALL add the points of each applicable urgency and difficulty rule and list the matching rule keys as `reasons`, urgency reasons first.
3. THE SYSTEM SHALL order patients by higher urgency, then higher difficulty, then earlier first affected session, then longer drive to the nearest open clinic, then patient ID, so that the order does not depend on input order.
4. WHEN a patient has no affected session, THE SYSTEM SHALL leave the patient out of the ranking.
5. THE SYSTEM SHALL number ranks from 1.

## Requirement 3: Plan text in three languages

**User story:** As Rosa, I want a reason, a short message in each patient's language and a plan summary, so that I can review what each patient will hear.

**Acceptance criteria**

1. WHEN `write_plan_text` is called, THE SYSTEM SHALL send name-free facts (patient ID, rank, action, reason codes, clinic name and address, preformatted time strings, ride, language) to Bedrock through the forced tool `write_plan_text`.
2. WHEN `BEDROCK_MODEL_FAST` is missing, THE SYSTEM SHALL raise `ValueError` without calling Bedrock.
3. THE SYSTEM SHALL write `reason_text` in code from the row's reason codes (one sentence of at most 20 words) and accept only that exact text back from the model.
4. THE SYSTEM SHALL give messages only to `early_session` and `transfer` rows, in English plus the patient's own language (`es` or `zh`).
5. WHEN a message arrives, THE SYSTEM SHALL check: exactly one standalone `{name}` placeholder; fewer than 40 words (English, Spanish) or at most 80 characters (Chinese); no emoji, control or invisible characters; no banned word (death, danger, risk and their Spanish and Mandarin equivalents); the supplied treatment and pickup strings used exactly once, in order, starting with the treatment time then the clinic name; no other clock time; the right language; and the right ride wording.
6. WHEN rows fail validation, THE SYSTEM SHALL retry the batch once with the error list, split a batch that stopped at `max_tokens` into halves, and replace rows that still fail with the code template, logging a warning with the patient ID.
7. THE SYSTEM SHALL work in batches of 10 rows, with at most 4 batches in parallel, 30 model attempts and 20 seconds in total.
8. WHEN every Bedrock attempt fails with a provider error and no row succeeded, THE SYSTEM SHALL re-raise the original error, so that the router falls back.
9. WHEN `only_ids` is not set, THE SYSTEM SHALL build the plan summary from code counts; otherwise THE SYSTEM SHALL leave the summary alone.
10. WHEN `template_plan_text` is called, THE SYSTEM SHALL fill the same fields from the code templates without calling Bedrock and without `BEDROCK_MODEL_FAST`, return a copy, and leave a row's messages empty (with a logged warning) if its facts do not fit.
11. THE SYSTEM SHALL never mutate the plan it was given.

## Requirement 4: Re-plan

**User story:** As Rosa, I want to type "(clinic) can only take four more" and see only the affected rows change, so that I can react to a clinic's call in seconds.

**Acceptance criteria**

1. WHEN `replan` is called without clinics, THE SYSTEM SHALL raise `ValueError` before calling Bedrock; WHEN `BEDROCK_MODEL_ID` is missing, THE SYSTEM SHALL raise `ValueError`.
2. THE SYSTEM SHALL offer the model exactly five tools (`set_clinic_capacity`, `pin_patient`, `decline_patient`, `rerun_matching`, `diff_plans`) and run each through the Backend functions in `tools`; the model never edits plan JSON.
3. THE SYSTEM SHALL show the model rows with `patient_id`, `rank`, `action`, `clinic_id`, `slot`, `status` and `pinned` only, clinics with `id`, `name`, `kind`, `home` and slots, and tool results limited to an allow-list of keys.
4. WHEN a tool call has wrong keys, a wrong type or pattern, an ID outside the plan or clinics, or a slot the clinic does not have, THE SYSTEM SHALL return an error result to the model and not run the tool.
5. WHEN a capacity change names a clinic that the instruction does not mention (by name or ID), or a pin or decline names a patient ID that the instruction does not contain, THE SYSTEM SHALL refuse the call.
6. WHEN `chairs` exceeds the slot's original open chairs, THE SYSTEM SHALL refuse the call.
7. WHEN the instruction says "(clinic) can only take N more", THE SYSTEM SHALL check at the end that the clinic's total chairs across all slots is at most N, and raise `RuntimeError` if not.
8. THE SYSTEM SHALL allow at most 6 model calls and raise `RuntimeError` if the model still asks for tools on the sixth.
9. WHEN the model ends its turn, THE SYSTEM SHALL run `rerun_matching` and `diff_plans` itself if the results are missing or stale, so that the returned plan and diff always match.
10. WHEN no mutating call succeeded, THE SYSTEM SHALL raise `ValueError("instruction not understood")`; WHEN every mutating call failed, or one failed and was never repeated successfully, THE SYSTEM SHALL raise `RuntimeError`, so that the router discards the half-edited plan and falls back.
11. THE SYSTEM SHALL build the two-sentence summary in code from the final diff, and return `{plan, diff, summary}` where `plan` holds `patients` and `overflow`.
12. THE SYSTEM SHALL stop within 40 seconds, checked before every model call, tool call and Bedrock attempt.

## Requirement 5: Bedrock wrapper

**User story:** As an AI-lane developer, I want one small place that calls Bedrock, so that logging, retries and limits are the same everywhere.

**Acceptance criteria**

1. THE SYSTEM SHALL make `bedrock.converse` the only place that calls Bedrock Converse.
2. THE SYSTEM SHALL create the client lazily and reuse it, with a 5 second connect timeout, a 20 second read timeout and one SDK attempt.
3. WHEN Bedrock answers `ThrottlingException`, `ServiceUnavailableException`, `InternalServerException` or `ModelNotReadyException`, THE SYSTEM SHALL retry once after 0.25 seconds; any other `ClientError` SHALL propagate.
4. WHEN the request is invalid (`ParamValidationError`), or `tool_choice` is given without tools, THE SYSTEM SHALL raise `ValueError("invalid Converse request")` or the `tool_choice` error, without the original details.
5. THE SYSTEM SHALL log one INFO line per call with the model ID, input tokens, output tokens and milliseconds.
6. WHEN a caller sets `attempt_guard`, THE SYSTEM SHALL run it before each attempt, so that a caller's time budget covers retries.
7. THE SYSTEM SHALL return the stop reason, text, tool uses, usage and the unmodified assistant message.

## Requirement 6: Quality tool

**User story:** As the AI owner, I want to run the whole flow ten times against the deployed app and see defects counted, so that nothing embarrassing reaches the video.

**Acceptance criteria**

1. WHEN `python -m lumen.ai.quality` runs without `LUMEN_URL` or `DEMO_KEY`, THE SYSTEM SHALL exit with a message naming the missing variable.
2. THE SYSTEM SHALL warn before the first call that `POST /reset` clears the shared demo state, and reset again at the end.
3. THE SYSTEM SHALL never print the demo key.
4. WHEN a run executes, THE SYSTEM SHALL call reset, alert (`data/seed/notice.txt`), plan, re-plan ("<clinic> can only take four more") and state, and record each step's HTTP status, the /plan and /replan seconds, `parse_source` and `ai_sources`.
5. THE SYSTEM SHALL count per run: invented patient or clinic IDs, plan schema failures, bad messages (length, leftover `{name}`, banned word, wrong language) and rows without the expected languages.
6. THE SYSTEM SHALL print a markdown table with one row per run and a summary: clean runs, the clean streak at the end, median and maximum /plan and /replan seconds, Bedrock versus fallback counts for parse, text and re-plan, and the event ID and plan version of the fastest clean run where every step used Bedrock (or a statement that none did).
7. THE SYSTEM SHALL state that token counts come from CloudWatch, not from the tool.
