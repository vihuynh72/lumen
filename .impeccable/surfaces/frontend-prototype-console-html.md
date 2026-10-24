---
version: 1
slug: "frontend-prototype-console-html"
primary_target: "frontend/prototype/console.html"
related_targets: []
---

# Lumen console (frontend/prototype/console.html)

Scope: the single working screen of Lumen. Mode: Operate.
Audience and job: the manager of DaVita Cameron Park Dialysis (home clinic C01) plans patient treatment through a PG&E shutoff, then approves it. Secondary: judges watching a recorded run at 1920 x 1080.
Content: live API (El Dorado County) plus an illustrative Santa Clara tour computed in the page. OSM power lines and substations, illustrative feeders, synthetic patients.
Constraints: static files, no build step, Amplify manual upload, demo key in the page, Amazon Location tiles when a key exists, OpenFreeMap otherwise.
Unresolved: Amazon Location API key (needs geo-maps permission for lumen-cli or a console-created key).

## Direction contract

THESIS: The screen is a run sheet. A dark left rail logs the AI run step by step, the map shows what each step changed on the home grid, and the right panel holds the plan the manager approves. It refuses the KPI-tile dashboard and the marketing hero.

OWN-WORLD: The incumbent world: Atkinson Hyperlegible Next for all UI, Atkinson Hyperlegible Mono only for times, counts and IDs. Green-tinted neutrals (paper #FBFCFB, ground #E6EBE8, ink #13201C), a near-black green rail #15211D, amber #E39A1E only for the primary action and the running step, red for power off, blue for transfers, green for powered and confirmed. Light by default (office daylight), dark on toggle. Facilities are extruded real building outlines under pin labels. Live feeders carry a moving current dash. Dead lines turn dashed red-gray.

STORY: The manager sees the home clinic and its grid, presses Run demo, and watches each step land in the rail while the map shows the shutoff area, the dead feeders, the closed clinic, the affected patients and their new destinations. Then the manager reviews the plan, re-plans in plain words, approves, confirms a patient and plays the voice note.

FIRST VIEWPORT: A 56 px top bar holds Lumen, the home clinic with a Home tag, the region select, the event countdown, Run demo (amber) and Reset. A 336 px dark left rail holds "AI run" with seven phases on a connector line, the active phase raised, and an instruction box at the bottom. The map fills the center at full height, with the camera tilted 50 degrees over the home clinic, the legend bottom-left and the controls bottom-right. A 380 px paper right panel holds the home clinic status, then the plan counts, Approve all and the patient rows.

FORM: Run rail, position 1 of my ordered structural list (dealt hand index 1). seed:325b73432be7cf66. Signature move: the rail is the AI run log. Each phase lights when its API answer lands and shows its AWS service, its true source (model, rules fallback or rules) and its server time, and the map camera moves to what that phase changed. Raise from the gate-board challenger: a re-plan reranks plan rows in place, and changed rows hold amber until the manager acknowledges them.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Extension 2 (user feedback, Oct 23 night)

The map stops drawing a web. Patients gather at their closed clinic, and one road route per destination funnels them out (Amazon Location Service routes), each labeled with patients, road minutes and miles. Clicking a patient draws that patient's own road route. A pop-out review panel covering almost the whole screen holds the full patient table for approval. The rail and plan panel resize by drag or keyboard. A timeline at the bottom of the map plays a simulated outage: grid live, power off at Tue 6 PM inside the shutoff area, patients flow out along the roads, power back Thu noon. One county at a time; day and night both first-class. More voice languages through Amazon Translate plus Polly. Binding details: CONTRACT-v2 (E1-E10).

## Extension 3 (user feedback, Oct 23, 11:40 PM)

Simple for daily use. The rail is "Shutoff response" in plain step names with no service, source, model or timing labels anywhere. No version numbers. The run is the timeline: notice received, shutoff area, zoom into the clinic as it loses power, zoom out, routes traced live along the roads to each receiving clinic while its chair count fills, then the run waits for staff, who open the full-screen approval list. A Check the plan step and card show what to fix and what to look at. Voice notes go out in bulk from the list, one per patient, with the skipped patients named before anything is sent. Capacity is visible ("16 of 18 chairs", "Full"). The patient card is one sentence, one leave/drive line and one reason line. Routes are computed live from Amazon Location on every run. Binding details: CONTRACT-v3 (R1-R7).

## Extension 5 (Oct 24): the simple flow

The console moves to console.html; index.html is the landing page. Three stages after the run: Plan made, Approve and tell, Everyone told. One press, "Approve and tell everyone", approves the rows, sends each patient's voice note and tells each receiving clinic and the hospital (all simulated), every patient and clinic switched on by default with per-patient and per-clinic opt-out. A done board with simulated replies and "Needs you now, soonest first". The panel holds one sentence, the check verdict, one button and "Where they go"; the patient list leaves the panel. The map keeps at most 5 kinds of marks after the plan; the grid shows only while the clinic loses power. Santa Clara is a live county. Binding details: CONTRACT-v5 sections 4 to 6.
