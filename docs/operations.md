# Operations

How the team deploys Lumen, warms it up before a demo, and finds what went wrong. Judges do not need this page: start at the [README](../README.md).

The demo key is never in the repo. Get it from the team, and keep it out of commits, logs and screenshots.

## Deploy the backend

Deploy only through `scripts/deploy_lambda.sh`. The script refuses to run unless you are on `main`, your working tree is clean, and `main` matches `origin/main`.

1. Tell the team before you deploy, with the short SHA.
2. Have AWS CLI credentials for the team account (`aws sts get-caller-identity` works).
3. Run:

```bash
git switch main && git pull
DEMO_KEY=<demo key> scripts/deploy_lambda.sh
```

The script zips `backend/lambda_function.py` and `backend/lumen/`, stamps the short SHA into `lumen/_version.py`, updates the `lumen-api` function in us-east-2, waits, and prints the `version` from `GET /state`. It changes code only. It never changes the function's environment, permissions or URL.

## Deploy the web app

The web app is the static folder `frontend/prototype/`. Upload it to AWS Amplify as is. There is no build step.

The folder has no `index.html`: the pages are `landing.html` and `console.html`. Make the bare Amplify URL open `landing.html` (a rewrite from `/` to `/landing.html`), or people who type the bare URL see an error. The README links to `landing.html` directly.

## Seed data

`python scripts/validate_seed.py` checks the seed files in `data/seed/`. CI runs it on every pull request to `main`. `scripts/upload_seed.sh` validates the seed again, then uploads it. Only the project lead runs the upload.

## Before a demo

The imported model sleeps when nobody calls it. The first call after a quiet period can take about 2 minutes. Warm it up first:

```bash
DEMO_KEY=<demo key> python scripts/demo_check.py warmup
```

`warmup` calls `GET /state`, runs one throwaway alert and plan, then resets. `python scripts/demo_check.py run 2` runs the whole demo flow twice (reset, alert, plan, approve all, confirm, voice, re-plan) and stops on the first failed step. Both need `LUMEN_URL` set, or AWS CLI credentials so the script can look up the function URL.

## Debugging

Every request writes one JSON log line per pipeline step with milliseconds, and one summary line with `path`, `status`, `version` and `request_id`.

Each model step has a time limit: parse 20 s, text 25 s, re-plan 45 s, check 25 s, intent 20 s. A step that fails or runs past its limit logs `"fallback": true` and the reason, then code does the step instead.

`AI_STEPS` in the function's environment lists the model steps that run. The demo runs `parse,check,intent`. Only the project lead changes it.

CloudWatch Logs Insights, log group `/aws/lambda/lumen-api` (us-east-2). This query finds errors and fallbacks:

```
fields @timestamp, path, status, step, error, reason, fallback, request_id, @message
| filter status >= 400 or ispresent(error) or fallback = 1 or @message like /Task timed out|Traceback/
| sort @timestamp desc
| limit 100
```
