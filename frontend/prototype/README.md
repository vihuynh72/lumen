# Lumen demo prototype

A single-file, interactive design prototype for the Lumen frontend. It shows a 3D map of Santa Clara County with an illustrative power grid, then walks through a guided six-step demo, from a PSPS notice to sent texts.

Open `index.html` in a browser. There is no build step. The page loads three.js r128 (cdnjs, jsDelivr) and Google Fonts from CDNs, and everything else is inline.

## What it shows

1. **Read the notice.** Bedrock turns the notice into fields (played back, not a live call).
2. **Find centers that lose power.** The cut circuits go dark, the shutoff area falls into shadow, and 4 centers turn red.
3. **Rank patients by risk.** An additive score from chart facts, with filter chips.
4. **Build the plan.** Each patient goes to the nearest powered center with an open station on their usual day. The plan is computed live in the page.
5. **Write and check texts.** Texts in each patient's language (8 languages), each translated back to English and checked. One text is held so the reviewer can fix it.
6. **Approve and send.** Sending, replies and the call list are simulated.

Other features: click any center for its CMS facts and open capacity, a runway timeline from the notice to estimated restoration, a day and night map (follows the system theme), 2D and 3D views, layer toggles and a phone layout.

## Data

* **Centers.** CMS Dialysis Facility file, Santa Clara County: 31 centers and 642 stations, with addresses, operators, late shifts and star ratings. Map positions are approximate, placed from street addresses and checked against ZIP boundaries.
* **Patients.** 2,568 synthetic patients generated for this prototype, 420 of them at the four affected centers. No real patient data.
* **Map.** Freeways from Natural Earth. County outline and San José neighborhoods from click_that_hood. ZIP code areas from OpenDataDE (Census ZCTA).
* **Illustrative.** The PG&E notice, substations, circuits and hill relief are made up for the demo, and the page labels them.

## Not wired to the backend yet

The prototype does not call the Lambda, and it differs from `contracts/` and `data/seed/`:

| Prototype | Backend contract |
| -- | -- |
| Santa Clara County, 31 CMS centers | El Dorado County demo event `PSPS-DEMO-01`, 6 seed clinics plus Mercy Hospital of Folsom |
| 420 affected patients out of 2,568 synthetic | 40 seed patients |
| Additive risk score (no car, lives alone, potassium, fluid gain, interpreter, missed treatment, wheelchair) | Urgency and difficulty points from `rules.json` |
| Same day, nearest open station | `early_session`, `transfer`, `hospital`, `notify_only` |
| Texts sent through SNS (simulated) | `messages` plus Polly voice notes, approve and confirm statuses |
| No re-plan | `POST /replan` with the manager's instruction |
| Persona: care coordinator | Persona: Rosa, clinic manager |

To turn it into the real frontend: load `GET /state` instead of the embedded data, call `POST /alert` for step 1 and `POST /plan` for steps 2 to 4, show `plan.messages` and `POST /voice` for step 5, call `POST /approve` for step 6, and add a re-plan box for `POST /replan`. The map, panels and timeline can stay as they are.
