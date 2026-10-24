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
| Strong model (re-plan) | `us.anthropic.claude-sonnet-4-6` (5.5 is not available to this account) |
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
