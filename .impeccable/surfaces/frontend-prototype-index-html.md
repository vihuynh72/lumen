---
version: 1
slug: "frontend-prototype-index-html"
primary_target: "frontend/prototype/index.html"
related_targets: []
---

# Lumen landing page (frontend/prototype/index.html)

Scope: the first screen anyone sees; the console is console.html. Mode: Persuade.
Audience and job: hackathon judges and dialysis clinic administrators. In ten seconds they should feel why a power shutoff is dangerous for people who depend on electricity (dialysis, home oxygen, ventilators, cold medicine) and see that Lumen handles it; the demo is a dialysis clinic. Action: Try the live demo.
Proof and content: the real Santa Clara County clinic network (CMS positions): three foothill clinics go dark and 96 synthetic patients funnel to open clinics, synthetic patients labeled as such, two sourced facts (Hurricane Sandy: early dialysis, 28% lower odds of dying within 30 days; 92% of hospitals saw transient patients arrive without records).
Constraints: static files, no build step, CDN libraries allowed, Atkinson faces, Lumen palette, no invented metrics, Request a demo and Sign in open a Coming soon dialog that collects nothing.

## Direction contract

THESIS: One night, seen twice. A seam splits the first viewport: the shutoff night without Lumen (dark, the clinic gone red, a fading list of unreached patients) and the same patients with Lumen (light, routes flowing to clinics with free chairs). It refuses the split hero of copy beside a product screenshot and the centered headline over three feature cards.

OWN-WORLD: Lumen's world. The near-black green #15211D is the night half, paper #F1F4F2 and #FBFCFB the day half, ink #13201C. Amber #E39A1E only for the primary action and the seam handle; red #C2362F for the dark clinic; blue #2457C5 for routes; green #23784A for clinics with chairs. Atkinson Hyperlegible Next 800 for display, Mono for names and times in the call list. The network is drawn from real positions: nodes, edges, flowing dashes.

STORY: The visitor feels an evening of 96 unanswered calls, sees the same night resolved, drags the seam to compare, reads five short bars on how it works, and presses Try the live demo.

FIRST VIEWPORT: Nav (Lumen mark, How it works, For clinics, Request a demo, Sign in). A 76px two-line headline crossing the seam: "When the power goes out," on the night, "some people can't wait." on the day. Under it Try the live demo (amber) and Request a demo. Left: the night lede and the fading call list. Right: the lede and the live network, routes flowing into labeled clinics. The amber seam with a round handle at 50%. The five-bar how-it-works strip anchors the bottom. Signature interaction: drag the seam (pointer and keyboard) to reveal more night or more day. Motion grammar: one entrance (call rows fade in, the clinic turns red, the seam sweeps to center, routes trace), then a calm idle loop of flowing dashes; reduced motion shows the finished frame.

FORM: Dark side, lit side (before and after with a draggable seam), position 5 on the ordered list, dealt as the lead; seed:b4e8883581e5fa8f.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
