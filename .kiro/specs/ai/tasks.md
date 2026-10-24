# AI lane: tasks

Tasks are listed as done, with the Linear issue and the merged PRs (from `git log` on `main`). One item is open.

## Done

- [x] **Bedrock Converse wrapper and smoke CLI** (`bedrock.py`, `smoke.py`, `test_bedrock.py`). [VI-170](https://linear.app/vihuynh72/issue/VI-170/bedrock-client-wrapper-and-smoke-test): PR #6 (wrapper and CLI), PR #27 (validation errors and transient retries hardened). Requirement 5.
- [x] **Parse the shutoff notice into the event JSON** (`parse.py`, `prompts/parse.md`, `test_parse.py`). [VI-174](https://linear.app/vihuynh72/issue/VI-174/parse-the-shutoff-notice-into-the-event-json): PR #33 (forced `record_event`, validation, one retry), PR #35 (review fixes: retry only on model validation errors, exact timestamp pattern, grounding in the notice, one tool call, notice as a JSON field). Requirement 1.
- [x] **Rank patients with rule points and reason chips** (`rank.py`, `test_rank.py`). VI-176: PR #23 (`rank_patients`), PR #25 (hardening from the post-merge reviews). Requirement 2.
- [x] **Write rank reasons, the plan summary and patient messages in three languages** (`text.py`, `prompts/text.md`, `test_text.py`). [VI-182](https://linear.app/vihuynh72/issue/VI-182/write-rank-reasons-the-plan-summary-and-patient-messages): PR #30 (generate and validate multilingual text), PR #32 (localized text, batch isolation, call budgets), PR #37 (`template_plan_text`, plan text with no Bedrock). Router wiring that tries the template path before the English fallback: PR #38. `ai_sources` in plan responses: contract PR #31. Requirement 3.
- [x] **Re-plan loop and tool schemas** (`replan.py`, `prompts/replan.md`, `test_replan.py`). [VI-188](https://linear.app/vihuynh72/issue/VI-188/re-plan-loop-and-tool-schemas-the-live-re-plan): PR #34 (bounded orchestration over the five tools), PR #38 (router passes the seed clinics), PR #39 (hardening: only requested edits, capacity caps, failure tracking, 40-second budget, code-built summary). Requirement 4.
- [x] **Quality-run tool** (`quality.py`, `test_quality.py`). [VI-193](https://linear.app/vihuynh72/issue/VI-193/quality-runs-10-full-runs-then-fix-the-prompts): PR #36. Requirement 6. The tool is built; the ten live runs it was made for have not been done.

## Open

- [ ] **Live Bedrock verification once quota allows.** The Bedrock quota was zero at build time, so no live reply has been verified. When it clears:
  1. Run `python -m lumen.ai.smoke` from `backend/` with `BEDROCK_MODEL_ID` set.
  2. Parse `data/seed/notice.txt` and compare the result with `contracts/fixtures/event.json`.
  3. Run `python -m lumen.ai.quality --runs 10` against the deployed app (VI-193 acceptance: the last three runs clean, median /plan and /replan under 20 seconds) and post the table on VI-193.
  4. Fix the prompts in `backend/lumen/ai/prompts/` and the validation in `backend/lumen/ai/*.py` from what the runs show.
