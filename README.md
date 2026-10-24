# Lumen

**Lumen turns a PG&E power shutoff notice into a plan for every dialysis patient. Staff approve it with one press, and Lumen tells everyone.**

Spark Hill Hackathon 2026 · AWS track

## Why it matters

People on dialysis cannot skip a treatment. When a planned shutoff closes their clinic, staff must find each patient another chair before the power goes off.

* After Hurricane Sandy, patients who got dialysis early had **28% lower odds of dying** within 30 days.
* **92% of hospitals** said dialysis patients from other clinics arrived without their records.

<sub>Source: [ASPR TRACIE, Dialysis lessons learned from Hurricane Sandy](https://files.asprtracie.hhs.gov/documents/aspr-tracie-ta-dialysis-hurricane-sandy-lessons-learned-07015-508.pdf).</sub>

## How it works

<img src="docs/how-it-works.svg" width="100%" alt="How Lumen works, in five steps before the power goes off: PG&E notice arrives. Lumen finds every patient. Nearest open chair. You approve once. Everyone is told.">

Lumen reads, finds and matches. A person approves. Then Lumen tells everyone and shows who still needs a phone call.

## Try it

**[main.d1eh2uukook6ji.amplifyapp.com](https://main.d1eh2uukook6ji.amplifyapp.com/landing.html)**

1. Press **Try the live demo**.
2. Pick a county and press **Run demo**. You see the notice, the shutoff area, the clinic losing power, the search for chairs and the routes. Then the run waits for you.
3. Press **Review and approve**, then **Approve and tell everyone**.

The live run asks for a demo key. Ask the team for one.

## How it is built on AWS

**AWS Lambda.** One Python function behind a function URL is the whole API. It reads the notice, finds who is affected, ranks patients, matches chairs, checks the plan, and records every approval and send. Every request needs the demo key.

**Amazon S3.** Holds the seed data and every plan version, so each change is a new version you can trace. Each browser tab works in its own session, so one viewer's run never touches another's.

**Amazon Bedrock.** Runs Qwen2.5-7B-Instruct, which we brought in with Custom Model Import. It reads the PG&E notice, explains the plan check in plain sentences, and turns a typed change ("DaVita Folsom can only take 4 more") into edits that code checks before it applies them. When the model is slow or fails, code does the step.

**Amazon Polly.** Reads each patient's message aloud as a voice note in English, Spanish or Chinese.

**Amazon Location Service.** Draws the map and traces real road routes from the closed clinic to each receiving clinic, in the browser.

**AWS Amplify.** Hosts the web app: static files, no build step.

## What the AI does and does not do

**The model reads.** It reads the notice, explains the plan check, points out patients who may need a call, and reads re-plan requests.

**Rules decide.** Code ranks patients, gives each one the nearest clinic with a free chair at their time, and finds the problems in the plan. Code keeps a model flag only when the patient's facts match it. The model cannot remove a problem or make it less serious.

**People approve.** Nothing goes out until staff approve. Patient names never reach the model: code swaps them for IDs first.

## Honest data

* **Patients are synthetic.** Names, homes and health details are made up.
* **The PG&E notice is simulated,** and so are the voice notes, clinic sheets and replies. Nothing leaves Lumen.
* **Dialysis clinics are real.** Names, addresses and stations come from public CMS data. Open chairs are simulated.
* Power lines and substations come from OpenStreetMap. Feeders and the shutoff area are illustrative.
* The rules are demo assumptions, not clinical guidance.

## Run it locally

```bash
python3 -m http.server 5173 -d frontend/prototype
```

Open http://localhost:5173/landing.html. Use `localhost`, not `127.0.0.1`: the map key works only there. Add the demo key from the team in the console's **Demo** menu.

Backend tests:

```bash
pip install -r backend/requirements-dev.txt
cd backend && python -m pytest -q
```

The API is in [contracts/api.md](contracts/api.md). Deploy and debugging steps are in [docs/operations.md](docs/operations.md).

## Team

Vi Huynh · Zayd Bashir · Asthra Meadipudi · Saieesha Marta
