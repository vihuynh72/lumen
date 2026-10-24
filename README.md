# Lumen

Lumen turns a PG&E Public Safety Power Shutoff notice into an approved, patient-by-patient plan for a dialysis clinic manager.

Spark Hill Hackathon 2026, AWS track.

## Team

| Lane | Owner |
| -- | -- |
| Backend & Data | Vi Huynh |
| AI | Zayd Bashir |
| Frontend A, Pitch & Video | Asthra Meadipudi or Saieesha Marta |
| Frontend B | Asthra Meadipudi or Saieesha Marta |

The plan and the team rules live in the Linear project "Lumen". The repo holds no copy.

## AWS

| Item | Value |
| -- | -- |
| Region | `us-east-2` (Ohio). The team account's organization policy allows Lambda only in us-east-2. |
| Function URL | https://7nkmh6ezx4unlwxzfjh3gy5lci0brirr.lambda-url.us-east-2.on.aws/ |
| Lambda | `lumen-api` (Python 3.12, arm64, 1024 MB, 120 s) |
| IAM role | `lumen-api-role` (S3 on the bucket only, Bedrock on the two models only, Polly, route matrix, CloudWatch Logs) |
| Bucket | `lumen-2e6e7e` (public access blocked; prefixes `seed/`, `plans/`, `audio/`) |
| Strong model (re-plan) | `us.anthropic.claude-haiku-4-5-20251001-v1:0` for now (same as fast: only the Haiku quota is requested; Sonnet 4.6 next, 5.5 is not available to this account) |
| Fast model (parse, messages) | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |

Every request needs the header `X-Demo-Key`. The demo key is in Discord only, never in the repo.
Only Vi changes the Lambda's environment variables, IAM role or function URL settings.

## Deploy the backend

Anyone may deploy, but only through `scripts/deploy_lambda.sh`. The script refuses to run unless you are on `main`, your working tree is clean, and `main` matches `origin/main`.

1. Post "deploying (short SHA)" in Discord first.
2. Have AWS CLI credentials for the team account (`aws sts get-caller-identity` works).
3. Run:

```bash
git switch main && git pull
DEMO_KEY=<demo key from Discord> scripts/deploy_lambda.sh
```

The script zips `backend/lambda_function.py` and `backend/lumen/`, stamps the short SHA into `lumen/_version.py`, updates `lumen-api` in us-east-2, waits, and prints the `version` from `GET /state`. It never touches environment variables, IAM or the function URL.

## Before recording

```bash
DEMO_KEY=<demo key from Discord> python scripts/demo_check.py warmup
```

`warmup` calls GET /state, runs one throwaway alert and plan, then resets. `python scripts/demo_check.py run 2` runs the whole demo flow twice (reset, alert, plan, approve all, confirm, voice, re-plan) and stops on the first failed step.

## Debugging

Every request writes one JSON log line per pipeline step with milliseconds, plus one summary line with `path`, `status`, `version` and `request_id`. A Bedrock step that fails or runs past its time limit (parse 20 s, text 25 s, re-plan 45 s, check 25 s) logs `"fallback": true` and the reason, then uses its rule-based path.

CloudWatch Logs Insights, log group `/aws/lambda/lumen-api` (us-east-2), query for errors and fallbacks:

```
fields @timestamp, path, status, step, error, reason, fallback, request_id, @message
| filter status >= 400 or ispresent(error) or fallback = 1 or @message like /Task timed out|Traceback/
| sort @timestamp desc
| limit 100
```
