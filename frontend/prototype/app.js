/* Lumen app screen: API client, the guided run (scenes), rail, plan panel and controls.
   Calls window.LumenMap (map.js), LumenReview (review.js) and LumenTimeline (timeline.js).
   Contracts: contracts/api.md, CONTRACT-v2 (E1-E10), CONTRACT-v3 (R1-R9), CONTRACT-v4 (plan check, bulk voice notes),
   CONTRACT-v5 section 4 (approve and tell, the done board), CONTRACT-v6 (every step stays on screen, slots, Santa Clara by
   default, what a patient and a clinic get, the no-key replay of one recorded live run). */
(() => {
'use strict';
const CFG = window.LUMEN_CONFIG || {};
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const sleep = ms => new Promise(r => setTimeout(r, reduced.matches ? 0 : ms));
const mem = {};  // blocked storage: keep values for this page only
const store = {
  get(k) { try { return localStorage.getItem(k) ?? mem[k] ?? null; } catch { return mem[k] ?? null; } },
  set(k, v) { mem[k] = v; try { localStorage.setItem(k, v); } catch { /* mem keeps it */ } },
};
const icon = id => `<svg class="i"><use href="#i-${id}"/></svg>`;

// data/seed/notice.txt and data/seed/santaclara/notice.txt, verbatim: POST /alert reads the region's own notice
const NOTICE = {};
NOTICE.santaclara = "PG&E PUBLIC SAFETY POWER SHUTOFF (PSPS) WARNING\nEvent ID: PSPS-DEMO-SC-01\nIssued: Monday, October 26, 2026, 8:30 AM PDT\n\nThis alert goes to customers and critical facilities served by PG&E in the area below. Forecast high winds and very dry conditions may require PG&E to turn off power to your area to reduce the risk of wildfire.\n\nArea: Evergreen, Silver Creek, Santa Teresa and the east foothills of San Jose (Santa Clara County)\n\nEstimated power shutoff: Tuesday, October 27, 2026, 6:00 PM PDT\nEstimated power restoration: Thursday, October 29, 2026, 12:00 PM PDT\n\nRestoration times are estimates. After the weather passes, crews inspect the lines before power comes back.\n\nIf you use power for medical equipment, make a backup plan now. Charge devices and keep a list of emergency contacts.\n\nQuestions: call 555-0199. For a medical emergency, call 911.\n\n(Simulated notice for the Lumen demo. Not issued by PG&E.)\n";
NOTICE.eldorado = "PG&E PUBLIC SAFETY POWER SHUTOFF (PSPS) WARNING\nEvent ID: PSPS-DEMO-01\nIssued: Monday, October 26, 2026, 8:30 AM PDT\n\nThis alert goes to customers and critical facilities served by PG&E in the area below. Forecast high winds and very dry conditions may require PG&E to turn off power to your area to reduce the risk of wildfire.\n\nArea: Cameron Park, Shingle Springs and Placerville (El Dorado County)\n\nEstimated power shutoff: Tuesday, October 27, 2026, 6:00 PM PDT\nEstimated power restoration: Thursday, October 29, 2026, 12:00 PM PDT\n\nRestoration times are estimates. After the weather passes, crews inspect the lines before power comes back.\n\nIf you use power for medical equipment, make a backup plan now. Charge devices and keep a list of emergency contacts.\n\nQuestions: call 555-0199. For a medical emergency, call 911.\n\n(Simulated notice for the Lumen demo. Not issued by PG&E.)\n";
// El Dorado's example changes (the backend's own 400 text names the same two); Santa Clara's come from its plan (suggestions())
const SUGGEST_LIVE = { eldorado: ['DaVita Folsom can only take 4 more', 'Maria Delgado declined'] };
const CALLBACK = '555-0100';  // the fictional clinic line every patient message names (backend text_fallback.CALLBACK)
const VOICE_LANGS = new Set(['en', 'es', 'zh']);  // Amazon Polly voices for POST /voice; other languages play English or show the text
const ROUTES_API = 'https://routes.geo.us-east-2.amazonaws.com/v2/routes';  // Amazon Location Routes v2, called with LUMEN_CONFIG.mapKey
const NO_ROAD = 'Road route not available';

// data/seed/clinics.json, so the map shows the clinics before GET /state answers
const FALLBACK = [
  { id: 'C01', name: 'DaVita Cameron Park Dialysis', kind: 'dialysis', lng: -120.972154, lat: 38.658201, home: true, stations: 23, address: '3311 Coach Ln Ste C, Cameron Park, CA 95682' },
  { id: 'C02', name: 'DaVita Folsom Dialysis', kind: 'dialysis', lng: -121.133386, lat: 38.645225, home: false, stations: 20, address: '2195 Iron Point Rd, Folsom, CA 95630' },
  { id: 'C03', name: 'SHC Folsom', kind: 'dialysis', lng: -121.172951, lat: 38.655766, home: false, stations: 13, address: '210 Blue Ravine Rd Suite 100, Folsom, CA 95630' },
  { id: 'C04', name: 'DaVita Orangevale Dialysis Center', kind: 'dialysis', lng: -121.209671, lat: 38.678281, home: false, stations: 20, address: '9267 Greenback Lane #A2, Orangevale, CA 95662' },
  { id: 'C05', name: 'DaVita Sunset Dialysis Center', kind: 'dialysis', lng: -121.268534, lat: 38.592495, home: false, stations: 24, address: '3071 Gold Canal Drive, Rancho Cordova, CA 95670' },
  { id: 'C06', name: 'DCI Rancho Dialysis Clinic', kind: 'dialysis', lng: -121.307105, lat: 38.573939, home: false, stations: 16, address: '10294 Rockingham Drive, Sacramento, CA 95827' },
  { id: 'H01', name: 'Mercy Hospital of Folsom', kind: 'hospital', lng: -121.145976, lat: 38.670957, home: false, stations: null, address: '1650 Creekside Dr, Folsom, CA 95630' },
];

// v6: all 8 stay on screen with their result lines; step 7 waits for staff, step 8 fills in as the replies land
const PHASES = ['Read the PG&E notice', 'Find who is affected', 'Put the most urgent first', 'Find open slots',
  'Write patient messages', 'Check the plan', 'Approve and tell everyone', 'Everyone told'];
const ACTION = { early_session: 'come in early', transfer: 'move', hospital: 'need a phone call', notify_only: 'keep the usual time' };
// Reasons in plain words, for "Why first: no car, lives alone" (R5)
const REASON = {
  session_in_window: 'treatment during the shutoff', session_within_36h: 'treatment within 36 hours', heart_failure: 'heart failure',
  missed_recently: 'missed a treatment recently', paratransit: 'rides paratransit', home_in_outage: 'home loses power', no_car: 'no car',
  lives_alone: 'lives alone', wheelchair: 'uses a wheelchair', limited_english: 'limited English',
};
const RIDE = { self: 'Drives self', family: 'Family drives', paratransit: 'Paratransit', medical_van: 'Medical van', taxi: 'Taxi', transit: 'Public transit' };
// Plain words (v5): To approve, Told, Said yes, No answer
const STATUS = { draft: 'To approve', approved: 'Approved', confirmed: 'Said yes', declined: 'Said no', no_answer: 'No answer' };
const NOTE_WORD = { sent: 'Told', stale: 'Tell again' };  // queued: "Told at 8 AM"
// The plan check (POST /check): one sentence per warning code; n is the number of patients with it
const pp = (n, verb, verbs = verb + 's') => `${plural(n, 'patient')} ${n === 1 ? verbs : verb}`;
const CHECK_SAY = {
  no_late_shift: n => `${pp(n, 'usually come', 'usually comes')} at night, and the new clinic has no late shift.`,
  hbv_test_missing: n => `${pp(n, 'have', 'has')} no hepatitis B test in the last 30 days. Send the latest result to the new clinic.`,
  early_paratransit_pickup: n => `${pp(n, 'have', 'has')} a paratransit pickup before 6:30 AM.`,
  same_day_paratransit: n => `${pp(n, 'need', 'needs')} a paratransit ride today. Book it now.`,
  long_drive: n => `${pp(n, 'drive')} longer than the limit.`,
  long_gap_after: n => `${pp(n, 'wait', 'waits')} longer than usual for the next treatment.`,
  no_message_in_language: n => `${pp(n, 'have', 'has')} no message in their language.`,
  heart_failure_long_gap: n => `Phone ${plural(n, 'patient')} instead of sending a voice note: heart failure and a long wait after the move.`,
  lives_alone_night_pickup: n => `Phone ${plural(n, 'patient')} instead of sending a voice note: they live alone and leave home in the dark.`,
  wheelchair_long_drive: n => `${pp(n, 'use', 'uses')} a wheelchair and ${n === 1 ? 'drives' : 'drive'} over 30 minutes.`,
  language_unconfirmed: n => `Confirm the new clinic speaks the language of ${plural(n, 'patient')}.`,
};
const CALL = new Set(['lives_alone_night_pickup', 'heart_failure_long_gap']);  // "Call instead": these go to /notify as call_instead
const EVERY_ROW = new Set(['hbv_test_missing', 'language_unconfirmed', 'long_gap_after']);  // on most moved rows: the card groups them, rows show no flag for them
const FIELD = { action: 'action', clinic_id: 'clinic', slot: 'session time', drive_minutes: 'drive time', drive_source: 'drive source',
  pickup_time: 'pickup time', book_today: 'ride booking', flags: 'flags', status: 'status', pinned: 'pin' };
const SHIFT = { 1: [6, 0], 2: [10, 30], 3: [15, 0], 4: [19, 30] };

const S = {
  region: 'santaclara', data: {}, B: null, rec: null,
  clinics: FALLBACK, raw: {}, fac: {}, names: {}, homes: {}, langs: {}, rules: {}, people: {},
  outage: null, event: null, affected: null, plan: null, stage: 0,
  phases: [], running: false, directing: false, paused: false, notice: false,
  diff: null, selected: null,
  rowErr: {}, busy: {}, approving: false, gen: 0, anim: true,
  lang: {}, road: {}, roadFail: false, opener: null, landed: null,
  check: null, checkErr: null, checkP: null,
  // v5: told clinics and their (simulated) confirmations; telling: what approve and tell is doing now (step 7's line), or '';
  // tellErr and tellRetry: step 7's last failure and its Retry; held: the patients staff kept to approve at the last approve and tell
  told: new Set(), clinicOk: new Set(), held: new Set(), telling: '', tellErr: null, tellRetry: null, tellOpts: null, replying: false,
  // v6: the panel view open over the plan ({type: 'patient' | 'clinic', id, back, from}), the voice note playing, the message tab per patient
  view: null, audio: null, msgLang: {},
};
const isReplay = () => !!S.B?.replay;  // Santa Clara without a key: the recorded live run (replayBackend)
const hasKey = () => !!store.get('lumenDemoKey');

/* ---------- words and times ---------- */
const TZ = 'America/Los_Angeles';
const fDT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fWT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const fT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const langDN = new Intl.DisplayNames(['en'], { type: 'language' });
const parts = (f, iso) => Object.fromEntries(f.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
function dt(iso) {
  if (!iso) return '';
  const p = parts(fDT, iso);
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
}
// "Tue 6:00 PM"; short: "Tue 6 PM", "Thu noon"
function dayTime(iso, short) {
  const p = parts(fWT, iso), whole = p.minute === '00';
  const t = short && whole ? (p.hour === '12' ? (p.dayPeriod === 'PM' ? 'noon' : 'midnight') : `${p.hour} ${p.dayPeriod}`) : `${p.hour}:${p.minute} ${p.dayPeriod}`;
  return `${p.weekday} ${t}`;
}
const time = iso => iso ? fT.format(new Date(iso)) : '';
function slotText(s) {
  if (!s) return '';
  const [y, mo, d] = s.date.split('-').map(Number), day = new Date(Date.UTC(y, mo - 1, d));
  const [h, mi] = SHIFT[s.shift] || [0, 0], o = { timeZone: 'UTC' };
  return `${day.toLocaleDateString('en-US', { ...o, weekday: 'short' })} ${day.toLocaleDateString('en-US', { ...o, month: 'short' })} ${d}, ${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
// A slot's start in ms. shortcut: uses the event's UTC offset, so a slot across a DST change is an hour off; use Intl time zones if events ever span one.
function slotStart(s) {
  const [h, mi] = SHIFT[s.shift] || [0, 0], off = /[+-]\d\d:\d\d$/.exec(S.event?.start || '')?.[0] || '-07:00';
  return Date.parse(`${s.date}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00${off}`);
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';
const join = a => a.length < 2 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
function langName(code) { try { return langDN.of(code) || code; } catch { return code; } }
const short = n => String(n || '').replace(/\s+Dialysis(\s+(Center|Clinic))?$/i, '');
const cname = id => id ? short(S.fac[id]?.name || id) : 'no slot';
const pname = id => S.names[id] || id;
const win = () => S.event ? `${dt(S.event.start)} to ${dt(S.event.end)}` : '';
const places = () => String(S.event?.area_name || '').replace(/\s*\(.*\)\s*$/, '').split(/,\s*|\s+and\s+/).filter(Boolean);
const noticeTag = () => 'Simulated PG&E notice';
const nowMs = () => S.affected?.now ? Date.parse(S.affected.now) : Date.parse(S.event.issued_at) + 30 * 60e3;  // the demo clock: issued + 30 min, as the backend
function countdown() {
  if (!S.event) return '';
  const min = Math.max(0, Math.round((Date.parse(S.event.start) - nowMs()) / 60e3));
  return min < 60 ? plural(min, 'minute') : plural(Math.floor(min / 60), 'hour');
}
const rows = () => S.plan ? [...S.plan.patients].sort((a, b) => a.rank - b.rank) : [];
function counts(p) { const c = { early_session: 0, transfer: 0, hospital: 0, notify_only: 0 }; for (const r of p.patients) c[r.action]++; return c; }
// "28 move · 8 come in early · 4 need a phone call" (zero parts left out), in the panel's buckets: a patient who said no needs a call
function moveLine(p) {
  const n = f => p.patients.filter(f).length, mv = n(r => hasChair(r) && r.action === 'transfer'), early = n(r => hasChair(r) && r.action === 'early_session');
  const call = n(needsPhone), keep = n(r => r.action === 'notify_only');
  return [mv && `${mv} move`, early && `${early} come in early`, call && `${call} need${call === 1 ? 's' : ''} a phone call`, keep && `${keep} get a notice`].filter(Boolean).join(' · ');
}
// v5 buckets that add up to every patient: a slot (a move or an early session), a phone call (no slot, or said no), the usual time
const isMove = r => r.action === 'early_session' || r.action === 'transfer';
const hasChair = r => isMove(r) && !!r.slot && r.status !== 'declined';
const needsPhone = r => !hasChair(r) && r.action !== 'notify_only';
const noted = r => r.note?.status === 'sent' || r.note?.status === 'queued';
const homeFac = () => S.clinics.find(c => c.home);

/* ---------- backends: the live API and the no-key replay ---------- */
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
// ?session= gives this tab its own run on the API, so another viewer's Reset or run never deletes this tab's plan.
const SESSION = (() => { const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20); try { return sessionStorage.lumenSession ||= id(); } catch { return id(); } })();
const live = {
  async call(method, path, body) {
    const key = store.get('lumenDemoKey') || '', headers = {};
    if (key) headers['x-demo-key'] = key;
    if (body) headers['content-type'] = 'application/json';
    let res;
    try { res = await fetch(`${String(CFG.api || '').replace(/\/+$/, '')}${path}?session=${SESSION}&region=${S.region}`, { method, headers, body: body && JSON.stringify(body) }); }
    catch { throw new ApiError('Lumen could not reach the API. Check the connection and retry.', 0); }
    const data = await res.json().catch(() => null);
    if (res.status === 401) { openKey('That demo key did not work.'); throw new ApiError('That demo key did not work.', 401); }
    if (!res.ok) throw new ApiError(data?.error || `The API answered ${res.status}. Retry the step.`, res.status);
    return data;
  },
  state: () => live.call('GET', '/state'),
  alert: () => live.call('POST', '/alert', { notice_text: NOTICE[S.region] }),
  plan: id => live.call('POST', '/plan', { event_id: id }),
  approve: b => live.call('POST', '/approve', b),
  voice: b => live.call('POST', '/voice', b),
  replan: b => live.call('POST', '/replan', b),
  check: b => live.call('POST', '/check', b),
  notify: b => live.call('POST', '/notify', b),
  packet: b => live.call('POST', '/packet', b),
  reset: () => live.call('POST', '/reset', {}),
};
/* The no-key demo (CONTRACT-v6 section 5): one recorded live Santa Clara run (data/replay/santaclara.json, made with the demo
   key against the deployed API) answers through the same calls as `live`. /alert, /plan, /check and the two re-plan chips give
   the recorded answers; approve, notify and packet apply to the recorded plan here in the page, so the review list's switches
   still choose who is told; the simulated replies write through approve as they do live. */
const NO_KEY_CHANGE = 'In the demo without a key, try one of the suggestions.';
function replayBackend(rec) {
  let event = null, plan = null;
  const wait = () => new Promise(r => setTimeout(r, reduced.matches ? 0 : 500 + Math.round(Math.random() * 300)));  // so the rail is watchable
  const run = async fn => { await wait(); return fn(); };
  const ts = rec.approve.created_at;  // the recorded run's demo clock
  const byId = p => Object.fromEntries(p.patients.map(r => [r.patient_id, r]));
  const why = list => Object.fromEntries(list.map(s => [s.patient_id, s.reason]));
  const notes = byId(rec.notify.plan), sheets = byId(rec.packet.plan), noteWhy = why(rec.notify.skipped), sheetWhy = why(rec.packet.skipped);
  const say = (p, change) => p.audit.push({ ts, actor: 'Rosa', change });
  const next = () => { const p = structuredClone(plan); p.version++; p.created_at = ts; return p; };  // the next plan version
  const row = (p, id) => p.patients.find(r => r.patient_id === id) || (() => { throw new ApiError(`unknown patient ${id}`, 404); })();
  const words = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  // A recorded chip still tells the truth while nobody it moves has said yes or no: live, a re-plan keeps the slots of
  // patients who said yes, so after the replies "DaVita Tully can only take 4 more" would come out differently.
  const holds = x => { const now = plan ? byId(plan) : {}, to = byId(x.response.plan);
    return x.response.diff.every(({ patient_id: id }) => now[id]?.status !== 'declined' && (now[id]?.status !== 'confirmed' || to[id]?.status === 'declined')); };
  return {
    replay: true,
    chips: () => rec.replan.filter(holds).map(x => x.instruction),
    state: async () => ({ ...(plan ? rec.state_after_plan : rec.state_before), event, plan }),
    alert: () => run(() => { plan = null; return (event = structuredClone(rec.alert)); }),  // a new run starts from the recorded plan again
    plan: () => run(() => (plan = structuredClone(rec.plan))),
    // the recorded check, less the rows that no longer go to a clinic (the backend checks only those)
    check: () => run(() => {
      const c = structuredClone(rec.check), by = plan ? byId(plan) : {};
      c.issues = c.issues.filter(i => !i.patient_id || (by[i.patient_id]?.clinic_id && by[i.patient_id].status !== 'declined'));
      c.counts = { block: c.issues.filter(i => i.severity === 'block').length, warning: c.issues.filter(i => i.severity !== 'block').length };
      return c;
    }),
    approve: b => run(() => {
      const p = next();
      for (const id of b.patient_ids[0] === 'all' ? p.patients.map(r => r.patient_id) : b.patient_ids) {
        const r = row(p, id);
        if (r.status === 'draft') { r.status = 'approved'; say(p, `approved ${id}`); }
      }
      for (const e of b.edits || []) {
        const r = row(p, e.patient_id);
        if (e.status && e.status !== r.status) { r.status = e.status; say(p, `${r.patient_id} status ${e.status}`); }
      }
      return (plan = p);
    }),
    // the CONTRACT-v4 order of reasons; a row the live run sent a note to gets that note
    notify: b => run(() => {
      const p = next(), call = new Set(b.call_instead || []), out = { sent: [], queued: [], skipped: [] };
      for (const id of b.patient_ids[0] === 'all' ? p.patients.map(r => r.patient_id) : b.patient_ids) {
        const r = row(p, id), n = notes[id]?.note;
        const reason = r.status === 'declined' ? 'declined' : r.action === 'hospital' || (r.flags || []).includes('staff_call') ? 'staff_call'
          : !isMove(r) || !Object.keys(r.messages || {}).length ? 'no_message' : r.status === 'draft' ? 'not_approved'
          : !n ? noteWhy[id] || 'no_message' : call.has(id) ? 'call_instead' : noted(r) ? 'already_sent' : '';
        if (reason) { out.skipped.push({ patient_id: id, reason }); continue; }
        r.note = { ...n, version: plan.version };
        out[n.status === 'queued' ? 'queued' : 'sent'].push(id);
      }
      const k = out.sent.length + out.queued.length;
      if (k) { say(p, `voice notes sent to ${plural(k, 'patient')} (simulated)`); plan = p; }
      return { plan, ...out, dry_run: false };
    }),
    packet: b => run(() => {
      const p = next(), out = { sent: [], skipped: [] };
      for (const id of b.patient_ids) {
        const r = row(p, id), was = sheets[id];
        if (!was?.packet || !['transfer', 'hospital'].includes(r.action) || !['approved', 'confirmed'].includes(r.status)) {
          out.skipped.push({ patient_id: id, reason: sheetWhy[id] || 'not approved' }); continue;
        }
        r.packet = { ...was.packet, to: r.clinic_id === was.clinic_id ? was.packet.to : S.fac[r.clinic_id]?.name || r.clinic_id, version: plan.version };
        out.sent.push(id);
      }
      if (out.sent.length) { say(p, `packets sent for ${plural(out.sent.length, 'patient')} (simulated)`); plan = p; }
      return { plan, ...out };
    }),
    // a recorded chip: its changed rows replace these rows, as the backend does (a moved row's sent note and sheet go stale;
    // a row that keeps its slot keeps its status); other words get the hint
    replan: b => run(() => {
      const hit = rec.replan.find(x => words(x.instruction) === words(b.instruction) && holds(x));
      if (!hit) throw new ApiError(NO_KEY_CHANGE, 400);
      const res = structuredClone(hit.response), to = byId(res.plan), changed = new Set(res.diff.map(d => d.patient_id)), p = next();
      say(p, `re-plan: ${b.instruction.trim()}`);
      p.patients = p.patients.map(r => {
        if (!changed.has(r.patient_id)) return r;
        const n = to[r.patient_id], moved = n.action !== r.action || n.clinic_id !== r.clinic_id || JSON.stringify(n.slot) !== JSON.stringify(r.slot);
        if (!moved && n.status !== 'declined') n.status = r.status;
        for (const [k, on] of [['packet', ['sent']], ['note', ['sent', 'queued']]]) if (r[k]) n[k] = moved && on.includes(r[k].status) ? { ...r[k], status: 'stale' } : r[k];
        return n;
      });
      Object.assign(p, { summary: res.summary, overflow: res.plan.overflow }, res.plan.capacity_overrides ? { capacity_overrides: res.plan.capacity_overrides } : {});
      return { plan: (plan = p), diff: res.diff, summary: res.summary, understood: res.understood };
    }),
    // the three recorded voice notes (one Chinese, one Spanish, one English patient)
    voice: b => run(() => rec.voice[`${b.patient_id}|${b.lang}`] ? { url: rec.voice[`${b.patient_id}|${b.lang}`] } : { note: 'Voice notes play in the live demo.' }),
    reset: async () => { event = plan = null; return { ok: true }; },
  };
}

/* ---------- modules: every call is safe when a script is missing or throws ---------- */
const mod = name => (fn, ...a) => {
  try { const m = window[name]; return m && typeof m[fn] === 'function' ? m[fn](...a) : undefined; }
  catch (e) { console.warn(`${name}.${fn}`, e); }
};
const M = mod('LumenMap'), R = mod('LumenReview'), TL = mod('LumenTimeline');
// The clinic each patient's affected session was at: their route starts there (E1).
const usualOf = () => Object.fromEntries((S.affected?.sessions || []).map(s => [s.patient_id, s.clinic_id]));
function facStatus() {
  const st = {};
  for (const f of S.clinics) st[f.id] = f.kind === 'hospital' ? 'hospital' : 'normal';
  if (S.stage >= 2 && S.affected) for (const id of S.affected.closed_clinic_ids) st[id] = 'closed';
  if (S.stage >= 4 && S.plan) for (const r of S.plan.patients) if (r.action === 'transfer' && st[r.clinic_id] === 'normal') st[r.clinic_id] = 'receiving';
  M('setFacilityStatus', st);
}
function mapPatients() {
  if (S.stage < 3) return M('setPatients', null);  // the run shows the homes with their caption (scene 3)
  const by = Object.fromEntries((S.plan?.patients || []).map(r => [r.patient_id, r]));
  const ids = S.affected ? [...new Set(S.affected.sessions.map(s => s.patient_id))] : Object.keys(by);
  // `to` is the destination, so a row with no route (an early session) still shows home -> clinic when selected
  M('setPatients', ids.filter(id => S.homes[id]).map(id => {
    const r = S.stage >= 4 ? by[id] : null, to = S.fac[r?.clinic_id];
    return { id, lng: S.homes[id][0], lat: S.homes[id][1], label: pname(id), action: r?.action ?? null,
      rank: S.stage >= 3 ? by[id]?.rank ?? null : null, to: to ? [to.lng, to.lat] : null };
  }));
}
// One item per moved patient, from the clinic of their affected session to the new facility; map.js draws one road route per pair.
// Early sessions stay at their own clinic, so they have no route (their home dot shows the action).
function mapFlows() {
  if (S.stage < 4 || !S.plan) return M('setFlows', null);
  const usual = usualOf(), home = homeFac()?.id;
  M('setFlows', S.plan.patients.flatMap(r => {
    const from = S.fac[usual[r.patient_id] || home], to = S.fac[r.clinic_id];
    if ((r.action !== 'transfer' && r.action !== 'hospital') || !from || !to) return [];
    return [{ id: r.patient_id, fromId: from.id, toId: to.id, from: [from.lng, from.lat], to: [to.lng, to.lat], action: r.action, changed: !!S.diff?.[r.patient_id] }];
  }));
}

/* ---------- road routes (R7): Amazon Location Routes v2, computed live, cached in memory for this page only ---------- */
const roads = new Map();  // "lng,lat|lng,lat" -> Promise; S.road[k] holds the settled {line, minutes, miles} or null (failed)
const RK = (a, b) => `${a.map(v => v.toFixed(5))}|${b.map(v => v.toFixed(5))}`;
let active = 0; const waiting = [];
async function limited(fn) {  // at most 4 route requests at once
  while (active >= 4) await new Promise(r => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}
async function callRoute(a, b) {
  for (let i = 0; i < 2; i++) {  // one retry on 429, 5xx or a network error
    try {
      const res = await fetch(`${ROUTES_API}?key=${encodeURIComponent(CFG.mapKey)}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ Origin: a, Destination: b, TravelMode: 'Car', LegGeometryFormat: 'Simple' }) });
      if (res.ok) {
        const x = (await res.json())?.Routes?.[0], line = (x?.Legs || []).flatMap(l => l.Geometry?.LineString || []);
        return x?.Summary ? { line: line.length > 1 ? line : null, minutes: Math.round(x.Summary.Duration / 60), miles: +(x.Summary.Distance / 1609.344).toFixed(1) } : null;
      }
      if (res.status !== 429 && res.status < 500) return null;
    } catch { /* retry once */ }
    if (!i) await new Promise(r => setTimeout(r, 600));
  }
  return null;
}
// Road route a -> b ([lng,lat]); resolves to {line, minutes, miles} or null. A failed route is not asked again this session.
function road(a, b) {
  if (!CFG.mapKey || !a || !b) return Promise.resolve(null);
  const k = RK(a, b);
  if (!roads.has(k)) roads.set(k, limited(() => callRoute(a, b)).then(r => (S.road[k] = r)));
  return roads.get(k);
}
// Settled route, undefined while it loads, false when nobody asked for it yet.
const roadNow = (a, b) => { if (!a || !b) return null; const k = RK(a, b); return k in S.road ? S.road[k] : roads.has(k) ? undefined : false; };
const pt = f => f && [f.lng, f.lat];
const patientRoad = r => r?.clinic_id ? roadNow(S.homes[r.patient_id], pt(S.fac[r.clinic_id])) : null;
const destName = r => r.action === 'hospital' ? `${cname(r.clinic_id)} if needed` : cname(r.clinic_id);
// Draws the selected patient's road route home -> destination (E2); asks Amazon Location the first time.
async function showRoute(id, fromMap) {
  const r = S.stage >= 4 ? S.plan?.patients.find(x => x.patient_id === id) : null, f = r && S.fac[r.clinic_id], home = S.homes[id];
  if (!f || !home) { M('showPatientRoute', null); if (!fromMap) M('focus', { patient: id }); return; }
  if (!patientRoad(r)) {  // the caller's render shows "Finding the road route…" meanwhile
    await road(home, pt(f));
    if (S.selected !== id) return;
    syncReview();
  }
  const rd = patientRoad(r);
  M('showPatientRoute', { id, home, to: pt(f), line: rd?.line || null, minutes: r.drive_minutes ?? null, miles: rd?.miles ?? null,
    label: `${pname(id)} → ${destName(r)}${r.drive_minutes != null ? ` · ${r.drive_minutes} min` : ''}${rd ? ` · ${rd.miles} mi` : ''}`, note: NO_ROAD });
}
// R8: one path at a time. Clearing shows every route again and closes the open row.
function clearSel() { S.selected = S.route = null; S.listSel = false; M('selectPatient', null); M('showPatientRoute', null); M('isolate', null); }
// The plan's clinics, the hospital and their road routes (the run's end, a reload, closing a view): the whole-area fit
// ('flows') zooms out so far that close labels hide. The map's padding keeps it clear of what floats over the map.
function planView() {
  const ids = [...new Set(pairs().flatMap(p => [p.fromId, p.toId]))];
  M('focus', ids.length ? { facilities: ids, routes: true } : 'flows');
}
function isoRoute(fromId, toId) {
  clearSel(); S.route = { fromId, toId };
  M('isolate', { type: 'route', fromId, toId });
  renderPanel();
}
// One item per (closed clinic -> destination) the plan uses, largest first; staff calls last.
function pairs() {
  const usual = usualOf(), home = homeFac()?.id, by = new Map();
  for (const r of S.plan?.patients || []) {
    if ((r.action !== 'transfer' && r.action !== 'hospital') || !r.clinic_id) continue;
    const fromId = usual[r.patient_id] || home, k = `${fromId}|${r.clinic_id}|${r.action}`;
    if (!by.has(k)) by.set(k, { fromId, toId: r.clinic_id, action: r.action, count: 0 });
    by.get(k).count++;
  }
  return [...by.values()].filter(p => S.fac[p.fromId] && S.fac[p.toId]).sort((a, b) => (a.action === 'hospital') - (b.action === 'hospital') || b.count - a.count);
}
// Computes every pair's road route live (R7); items as LumenMap.traceRoutes takes them.
async function routeList() {
  const list = await Promise.all(pairs().map(async p => {
    const rd = await road(pt(S.fac[p.fromId]), pt(S.fac[p.toId]));
    const base = p.action === 'hospital' ? plural(p.count, 'phone call') : `+${p.count}`;
    return { ...p, line: rd?.line || null, label: rd?.line ? base : `${base} · ${NO_ROAD}` };
  }));
  S.roadFail = list.some(x => !x.line);
  return list;
}
// Draws the plan's routes at once (reload, re-plan); the guided run traces them instead (scene 4).
let routeTok = 0;
async function drawRoutes() {
  const tok = ++routeTok, list = await routeList();
  if (tok !== routeTok || S.stage < 4) return;
  M('traceRoutes', list, { stagger: 0, duration: 0 });
  M('setCapacity', capacity());
  renderTop(); renderPanel();
  homeRoutes();
}
// R2: the review list's Drive and Leave home columns need each moved patient's road route (home -> new clinic). They load in
// the background, three at a time, so a row someone opens still gets the fourth request slot at once.
let homeTok = 0;
function homeRoutes() {
  const tok = ++homeTok, todo = rows().filter(r => r.slot && patientRoad(r) === false);
  let t = 0;
  const work = async () => {
    for (let r; tok === homeTok && (r = todo.shift());) {
      if (patientRoad(r) !== false) continue;  // someone opened it meanwhile
      await road(S.homes[r.patient_id], pt(S.fac[r.clinic_id]));
      t ||= setTimeout(() => { t = 0; syncReview(); }, 1000);
    }
  };
  for (let i = 0; i < 3; i++) work();
}
function mapStage(stage) {
  S.stage = stage;
  M('showOutage', stage >= 1 ? S.outage : null);
  M('setPower', stage >= 2);
  facStatus(); mapPatients(); mapFlows();
  M('setCapacity', stage >= 4 ? capacity() : {});
  if (stage < 4) { routeTok++; homeTok++; M('traceRoutes', [], { stagger: 0, duration: 0 }); }  // no plan, no routes
}

/* ---------- slots (R3): open slots in the shutoff window and the slots this plan uses ---------- */
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
// The newest "(clinic) can only take N more" re-plan caps that clinic at N (a later re-plan starts again from the seed counts).
function replanCap() {
  const a = (S.plan?.audit || []).filter(x => /^re-plan/i.test(x.change)).at(-1);
  const m = a && /:\s*(.+?)\s+can only take (\d+|\w+) more/i.exec(a.change);
  const n = m && (/^\d+$/.test(m[2]) ? +m[2] : NUM[m[2].toLowerCase()]);
  const f = n != null && S.clinics.find(c => c.kind === 'dialysis' && c.name.toLowerCase().includes(m[1].trim().toLowerCase()));
  return f ? { id: f.id, n } : null;
}
function openNow() {
  const out = {}, t0 = nowMs(), t1 = Date.parse(S.event.end), cut = replanCap();
  for (const c of Object.values(S.raw)) {
    if (c.kind !== 'dialysis' || c.accepts_visiting === false) continue;
    out[c.id] = (c.slots || []).filter(s => { const t = slotStart(s); return t > t0 && t < t1; }).reduce((n, s) => n + (s.open_chairs || 0), 0);
  }
  if (cut && cut.id in out) out[cut.id] = Math.min(out[cut.id], cut.n);
  return out;
}
// For LumenMap.setCapacity: receiving clinics {open, used, full, n: the plan's total} (the map writes "16 of 18 slots" or "Full"),
// the hospital {used: staff calls}, a closed clinic {early: "8 come in early before 6 PM"}; the map itself says "No power".
// While the run traces routes, S.landed holds what has arrived so far, so the map and the panel count up together.
function capacity() {
  if (!S.plan || !S.affected || !S.event) return {};
  const out = {}, closed = new Set(S.affected.closed_clinic_ids), used = {}, calls = {}, early = {};
  for (const r of S.plan.patients) {
    if (r.slot && r.clinic_id && r.status !== 'declined') used[r.clinic_id] = (used[r.clinic_id] || 0) + 1;
    if (r.action === 'hospital' && r.clinic_id) calls[r.clinic_id] = (calls[r.clinic_id] || 0) + 1;
    if (r.action === 'early_session' && r.clinic_id) early[r.clinic_id] = (early[r.clinic_id] || 0) + 1;
  }
  const open = openNow();
  for (const id of Object.keys(used)) {
    if (closed.has(id) || open[id] == null) continue;
    const u = S.landed ? S.landed[id] || 0 : used[id];
    out[id] = { open: open[id], used: u, full: u >= open[id], n: used[id] };
  }
  for (const [id, n] of Object.entries(calls)) out[id] = { open: null, used: S.landed ? S.landed[id] || 0 : n, full: false };
  for (const [id, n] of Object.entries(early)) if (closed.has(id)) out[id] = { early: `${n} come${n === 1 ? 's' : ''} in early before ${dayTime(S.event.start, true).replace(/^\S+ /, '')}` };
  return out;
}

/* ---------- the visible search (R9): what the matcher looks at, nearest first ---------- */
// Facilities a closed clinic's patients can go to: open dialysis clinics with a free slot in the window, then the hospital.
function cands() {
  const closed = new Set(S.affected?.closed_clinic_ids || []), open = openNow();
  return S.clinics.filter(f => f.kind === 'hospital' || (!closed.has(f.id) && open[f.id] > 0));
}
const crow = (a, b) => Math.hypot((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]);
// LumenMap.searchGraph visits from one closed clinic: road time order once every road route is in, else straight-line order.
function visitsFrom(src, pr) {
  const a = pt(S.fac[src]), open = openNow();
  const near = list => {
    const rd = list.map(f => roadNow(a, pt(f))), road = rd.every(Boolean);
    return list.map((f, i) => [f, road ? rd[i].minutes : crow(a, pt(f))]).sort((x, y) => x[1] - y[1]).map(x => x[0]);
  };
  const c = cands(), visit = f => {
    const used = pr.filter(p => p.fromId === src && p.toId === f.id).reduce((n, p) => n + p.count, 0);
    return { id: f.id, open: f.kind === 'hospital' ? null : open[f.id], used, accepted: used > 0 };
  };
  // nearest first, up to the farthest clinic this closed clinic's patients go to (the ones past it never came into play); the hospital last
  const dial = near(c.filter(f => f.kind !== 'hospital')).map(visit), last = dial.findLastIndex(v => v.accepted);
  return [...dial.slice(0, last + 1), ...near(c.filter(f => f.kind === 'hospital')).map(visit)];
}

/* ---------- rail ---------- */
const ST_WORD = { pending: '', running: 'Working', waiting: 'Waiting for you', error: 'Failed' };
function resetPhases() { S.phases = PHASES.map(name => ({ name, status: 'pending' })); }
function setPhase(i, o) { if (S.phases[i]) Object.assign(S.phases[i], { err: null, retry: null }, o); }
function done(i, o) {
  setPhase(i, { status: 'done', ...o });
  if (S.phases[i]) announce(`${S.phases[i].name} done. ${S.phases[i].res || ''}`);
}
function fail(i, e, retry) {
  setPhase(i, { status: 'error', err: e.message, retry });
  announce(`${S.phases[i]?.name || 'A step'} failed. ${e.message}`);
  if (e.status !== 401) banner(e.message);
  renderRail();
}
// R1: each step is its plain name and one result line, nothing else (no source or model labels).
const stepHTML = (p, i, retryAt = i) => {
  const cur = ['running', 'waiting', 'error'].includes(p.status);
  return `<li class="ph ${p.status}"${cur ? ' aria-current="step"' : ''}>
    <span class="d" aria-hidden="true">${p.status === 'done' ? icon('ck') : p.status === 'error' ? icon('x') : ''}</span>
    <div>
      <div class="ph-h"><span class="nm">${esc(p.name)}</span><span class="st">${p.status === 'done' ? '<span class="vh">Done</span>' : p.status === 'pending' ? '<span class="vh">Not started</span>' : esc(ST_WORD[p.status])}</span></div>
      ${p.res ? `<p class="res">${esc(p.res)}</p>` : ''}
      ${p.err ? `<p class="err">${esc(p.err)}</p>${retryAt != null && (p.retry || S.phases[retryAt]?.retry) ? `<button class="btn retry" type="button" data-retry="${retryAt}" data-k="retry-${retryAt}">Retry</button>` : ''}` : ''}
    </div></li>`;
};
// v6: the 8 steps stay on screen after the run too; "Something changed?" waits under them once there is a plan.
const planReady = () => !S.directing && S.stage >= 4 && !!S.plan;
function renderRail() {
  const ol = $('#phases'), ready = planReady();
  if (ready) syncTell();
  keepFocus(() => keepScroll(ol, () => { ol.innerHTML = S.phases.map((p, i) => stepHTML(p, i)).join(''); }), '#railH');
  $('#railSub').textContent = railSub();
  $('#pause').hidden = !S.directing;
  $('#pause').textContent = S.paused ? 'Resume' : 'Pause';
  // follow the newest event: a running or failed step, else the newest Re-plan step, else the step waiting for you
  const cur = S.phases.findIndex((p, i) => p.status === 'running' || (p.status === 'error' && !changeErr(p, i)));
  const act = cur >= 0 ? ol.children[cur] : S.phases.length > PHASES.length ? ol.lastElementChild : ol.querySelector('[aria-current]');
  if (act) railScroll(act);
  // "Something changed?": only once there is a plan, and not while a change or the replies are saving
  const ok = ready && !S.running && !S.approving && !S.replying, sg = suggestions();
  $('#chg').hidden = !ready;
  for (const el of [$('#chgBtn'), $('#instr'), $('#send')]) setDisabled(el, !ok);
  if (!ready) openChange(false);
  document.querySelectorAll('.sugg').forEach((b, k) => { b.textContent = sg[k] || ''; b.hidden = !sg[k]; setDisabled(b, !ok); });
}
function openChange(on) {
  const back = !on && $('#replan').contains(document.activeElement);  // focus was in the box: give it to the button that opens it
  $('#replan').hidden = !on; $('#chgBtn').hidden = on;
  $('#chgBtn').setAttribute('aria-expanded', String(on));
  if (!on) $('#chgErr').hidden = true;
  if (on) $('#instr').focus(); else if (back) $('#chgBtn').focus();
}
// Steps 7 and 8, read from the plan (so a reload shows them too) and from what is running now.
// Step 8 fills in as the replies land: "33 of 36 said yes · 3 to call".
function syncTell() {
  const all = S.plan.patients, drafts = all.filter(r => r.status === 'draft').length, t = toldNow();
  const tell = S.tellErr ? { status: 'error', err: S.tellErr.message, retry: S.tellRetry }
    : S.telling ? { status: 'running', res: S.telling }
    : t.done ? { status: 'done', res: toldLine(t) }
    : { status: 'waiting', res: !drafts ? 'Approved. Nobody is told yet.' : drafts < all.filter(r => r.status !== 'declined').length ? `${plural(drafts, 'patient')} still to approve` : 'Nothing is sent until you approve' };
  const told = all.filter(noted).length, yes = all.filter(r => noted(r) && r.status === 'confirmed').length, need = needsYou().length;
  const busy = S.replying || t.waiting > 0 || [...S.told].some(c => !S.clinicOk.has(c));
  const reply = !t.done || S.telling ? { status: 'pending' }
    : busy ? { status: 'running', res: yes ? `${yes} of ${told} said yes` : 'Waiting for replies' }
    : { status: 'done', res: [told && `${yes} of ${told} said yes`, need ? `${need} to call` : !told && 'Everyone is set'].filter(Boolean).join(' · ') };
  S.phases[6] = { name: PHASES[6], ...tell };
  S.phases[7] = { name: PHASES[7], ...reply };
}
// Two example changes: a clinic limit and a patient who declined. Santa Clara live: its busiest receiving clinic, which stays
// open, and its first moved patient, so both always re-plan. The no-key replay: the two it recorded.
function suggestions() {
  if (isReplay()) return S.B.chips();
  if (SUGGEST_LIVE[S.region]) return SUGGEST_LIVE[S.region].map(limitChip);
  // a used chip moves on to the next patient; the re-plan reads only a name one patient has
  const one = id => Object.values(S.names).filter(n => n === pname(id)).length === 1;
  const p = rows().find(r => r.action === 'transfer' && r.status !== 'declined' && one(r.patient_id));
  return [busiest(), p ? `${pname(p.patient_id)} declined` : ''];
}
// "SHC East San Jose can only take 4 more": the receiving clinic with the most patients, by a name only that clinic has
function busiest() {
  const n = {};
  for (const r of S.plan?.patients || []) if (r.action === 'transfer' && hasChair(r)) n[r.clinic_id] = (n[r.clinic_id] || 0) + 1;
  const id = Object.keys(n).sort((a, b) => n[b] - n[a])[0], f = S.fac[id];
  if (!f) return '';
  const nm = short(f.name), dial = S.clinics.filter(c => c.kind === 'dialysis' && c.name.toLowerCase().includes(nm.toLowerCase()));
  return limitChip(`${dial.length === 1 ? nm : f.name} can only take 4 more`);
}
// A re-plan keeps the slots of patients who said yes, so "(clinic) can only take N more" fails when more of them are there:
// the chip offers that many instead.
function limitChip(s) {
  const m = /^(.+) can only take (\d+) more$/.exec(s), f = m && S.clinics.find(c => c.kind === 'dialysis' && c.name.toLowerCase().includes(m[1].toLowerCase()));
  const yes = f ? rows().filter(r => r.clinic_id === f.id && r.slot && (r.status === 'confirmed' || r.pinned)).length : 0;
  return yes > +m?.[2] ? `${m[1]} can only take ${yes} more` : s;
}
// Like scrollIntoView 'nearest', then snapped so a whole row (never a cut one) sits at the top of the list. Near the end
// of the list that row's top can lie past the last scroll position, so the list gets just enough room below its last row.
function railScroll(el) {
  const ol = $('#phases'), base = ol.getBoundingClientRect().top - ol.scrollTop, y = e => e.getBoundingClientRect().top - base;
  const s = ol.scrollTop, h = ol.clientHeight, a = y(el), b = a + el.offsetHeight;
  const want = a < s ? a : b > s + h ? b - h : s;
  const top = Math.min(a, ...[...ol.children].map(y).filter(v => v >= want - 1));
  const room = top + h - (ol.scrollHeight - (parseFloat(ol.style.paddingBottom) || 0));
  ol.style.paddingBottom = room > 0 ? `${Math.ceil(room)}px` : '';
  if (Math.abs(top - s) >= 1) ol.scrollTo({ top, behavior: reduced.matches ? 'auto' : 'smooth' });
}
// A change that failed left the plan as it was: its row and the change box say so, and the sub line follows the work.
const changeErr = (p, i) => i >= PHASES.length && p.status === 'error';
function railSub() {
  const n = PHASES.length, w = S.phases.find(p => p.status === 'waiting');
  // a late plan check (step 6) runs on in the background: the step that waits for you comes first
  let k = S.phases.findIndex((p, i) => (p.status === 'error' && !changeErr(p, i)) || (p.status === 'running' && !(i === 5 && w)));
  if (k < 0 && S.directing) k = S.phases.map(p => p.status).lastIndexOf('done');  // a hold between two steps of the run: the step just shown
  if (k >= 0) {
    const p = S.phases[k];
    return `${S.paused ? 'Paused · ' : ''}${k < n ? `Step ${k + 1} of ${n} · ` : ''}${p.name}${p.status === 'error' ? ' · failed' : ''}`;
  }
  if (w) return `Waiting for you · ${w.name}`;
  if (S.phases.every((p, i) => p.status === 'done' || changeErr(p, i))) { const need = S.plan ? needsYou().length : 0; return need ? `Done · ${plural(need, 'person', 'people')} to call` : 'Done'; }
  return S.event ? 'Notice read' : 'Not started';
}
// Disabling the focused control drops focus to <body>; park it on the rail heading instead.
function setDisabled(el, dis) {
  if (dis && el === document.activeElement) $('#railH').focus();
  el.disabled = dis;
}
let liveT, liveQ = '';
// Messages that arrive together are joined, so a burst of steps is read in full.
function announce(t) { clearTimeout(liveT); liveQ = liveQ ? `${liveQ} ${t}` : t; $('#live').textContent = ''; liveT = setTimeout(() => { $('#live').textContent = liveQ; liveQ = ''; }, 60); }
function banner(msg) { $('#bannerT').textContent = msg; $('#banner').hidden = false; }

/* ---------- step result lines (R1) ---------- */
const noticeLine = () => `${places()[0] || S.event.area_name} loses power ${dayTime(S.event.start, true)} to ${dayTime(S.event.end, true)}`;
const affectedCount = () => new Set((S.affected?.sessions || []).map(s => s.patient_id)).size;
function rankLine() {
  const top = rows()[0];
  return top ? `${pname(top.patient_id)} is first: ${whyWords(top)}` : '';
}
function resText() {
  const withMsg = S.plan.patients.filter(r => Object.keys(r.messages || {}).length);
  const langs = [...new Set(withMsg.flatMap(r => Object.keys(r.messages)))].map(langName);
  return `${plural(withMsg.length, 'message')}${langs.length ? ` in ${join(langs)}` : ''}`;
}
function planPhases(p) {
  return [
    { res: `${plural(affectedCount(), 'patient')} ${affectedCount() === 1 ? 'has' : 'have'} a treatment then` },
    { res: rankLine() },
    { res: moveLine(p) },
    { res: resText() },
  ];
}
function restorePhases() {
  resetPhases();
  if (S.event) setPhase(0, { status: 'done', res: noticeLine() });
  if (!S.plan) return;
  planPhases(S.plan).forEach((o, k) => setPhase(k + 1, { status: 'done', ...o }));
  setPhase(5, S.check ? { status: 'done', res: checkLine() } : { status: 'running', res: 'Checking the plan…' });  // applyState starts the check
  // steps 7 and 8 come from the plan (syncTell)
  const re = (S.plan.audit || []).filter(a => /^re-plan/i.test(a.change));
  re.forEach((a, k) => S.phases.push({ name: `Change: ${a.change.replace(/^re-plan:\s*/i, '')}`, status: 'done', res: k === re.length - 1 ? plainCall(S.plan.summary) : '' }));
}
/* ---------- the plan check (POST /check): runs in the background; step 6 and the panel card show it ---------- */
let checkTok = 0, checkT = 0;
function runCheck() {
  clearTimeout(checkT);
  if (!S.plan || !S.event) return;
  const tok = ++checkTok;
  S.checkP = S.B.check({ event_id: S.event.event_id }).then(
    c => { if (tok === checkTok) { S.check = c; S.checkErr = null; landCheck(); } },
    e => { if (tok === checkTok) { S.checkErr = e; landCheck(); } });  // the last good check still names who to call instead
}
const checkSoon = () => { clearTimeout(checkT); checkT = setTimeout(runCheck, 800); };  // after approvals change statuses
function dropCheck() { checkTok++; clearTimeout(checkT); S.check = S.checkErr = S.checkP = null; }
function retryCheck() { setPhase(5, { status: 'running', res: 'Checking the plan…' }); renderRail(); runCheck(); }
// Step 6 shows the newest check once the run has reached it; a check that lands earlier waits for the run.
function landCheck() {
  const ph = S.phases[5];
  if (!ph || ph.status === 'pending') return;
  if (S.checkErr && !S.check) { setPhase(5, { status: 'error', err: S.checkErr.message, retry: retryCheck }); announce(`Check the plan failed. ${S.checkErr.message}`); }
  else if (S.checkErr) return;  // the last good check stays on screen
  else if (S.check) ph.status === 'done' ? setPhase(5, { res: checkLine() }) : done(5, { res: checkLine() });
  else return;
  renderRail(); renderPanel(); syncReview();
}
// backend sentences say "staff call" and "chairs"; the screen says "phone call" (v5) and "slots" (v6). \b keeps "wheelchair".
const plainCall = t => String(t || '').replace(/Staff call them\./g, 'They need a phone call.').replace(/staff call/gi, 'phone call').replace(/\bchair(s?)\b/g, 'slot$1');
// check texts use patient IDs and 24-hour times ("05:27"); the screen uses names and "5:27 AM"
const named = t => plainCall(t).replace(/\bP\d{3,}\b/g, id => pname(id)).replace(/\b(\d{4}-\d{2}-\d{2}) shift ([1-4])\b/g, (_, date, shift) => slotText({ date, shift: +shift })).replace(/\b([01]\d|2[0-3]):([0-5]\d)\b(?! ?[AP]M)/g, (_, h, m) => `${+h % 12 || 12}:${m} ${+h < 12 ? 'AM' : 'PM'}`);
// Blocks one line each; warnings one line per code (a "look at" is a code, not an issue).
function checkParts() {
  const issues = S.check?.issues || [], groups = {};
  for (const i of issues) if (i.severity !== 'block') (groups[i.code] ||= []).push(i);
  return { blocks: issues.filter(i => i.severity === 'block'), groups: Object.entries(groups) };
}
function checkLine() {
  const { blocks, groups } = checkParts();
  return `${blocks.length ? `${blocks.length} to fix` : 'Nothing to fix'}${groups.length ? ` · ${groups.length} to look at` : ''}`;
}
// The check's issues per row: its own, plus an over-capacity block (no patient) on its clinic and slot. call: the call-instead patients.
function checkIndex() {
  const by = {}, slotBlocks = [], call = new Set();
  for (const i of S.check?.issues || []) {
    if (i.patient_id) (by[i.patient_id] ||= []).push(i); else if (i.severity === 'block') slotBlocks.push(i);
    if (i.patient_id && CALL.has(i.code)) call.add(i.patient_id);
  }
  const of = r => slotBlocks.filter(i => i.facility_id === r.clinic_id && r.slot && i.slot?.date === r.slot.date && i.slot?.shift === r.slot.shift).concat(by[r.patient_id] || []);
  return { of, call };
}
const callThese = (r, ck) => r.action === 'hospital' || (r.flags || []).includes('staff_call') || r.status === 'declined' || r.status === 'no_answer' || ck.call.has(r.patient_id);
// The furthest stage a row has reached: Draft, Approved, its voice note, Confirmed, Declined, No answer, or Call.
function pillOf(r, call) {
  if (['confirmed', 'declined', 'no_answer'].includes(r.status)) return STATUS[r.status];
  if (r.note?.status === 'queued') return `Told at ${time(r.note.send_at).replace(':00', '')}`;
  if (NOTE_WORD[r.note?.status] && !(r.note.status === 'stale' && call)) return NOTE_WORD[r.note.status];  // a move that became a staff call: Call
  return r.status !== 'draft' && call ? 'Phone call' : STATUS[r.status] || r.status;
}
function applyState(st) {
  if (st.clinics) {
    S.clinics = st.clinics.map(c => ({ id: c.id, name: c.name, kind: c.kind, lng: c.lng, lat: c.lat, home: !!c.home, stations: c.stations ?? null, address: c.address || '' }));
    S.raw = Object.fromEntries(st.clinics.map(c => [c.id, c]));
    indexFac();
    M('setRegion', S.data[S.region], S.clinics);
  }
  if (st.rules) S.rules = st.rules;
  setPeople(st.patients);
  S.outage = st.outage_area || S.outage;
  S.event = st.event; S.affected = st.affected; S.plan = st.plan; S.diff = null;
  // a reload after telling: the clinics that got their list have confirmed by now; replies still due play on
  S.told = new Set((S.plan?.patients || []).filter(r => r.packet?.status === 'sent').map(r => r.clinic_id));
  S.clinicOk = new Set(S.told);
  restorePhases();
  runCheck();
  mapStage(S.plan ? 4 : S.event ? 1 : 0);
  if (S.stage >= 4) planView(); else M('focus', S.stage ? 'outage' : 'home');
  renderAll();
  if (S.stage >= 4) drawRoutes();
  syncReview();
  if (toldNow().done) startReplies();
}
function indexFac() { S.fac = Object.fromEntries(S.clinics.map(c => [c.id, c])); }
function setPeople(list) {
  S.names = {}; S.homes = {}; S.langs = {}; S.lang = {}; S.people = {};
  for (const p of list || []) {
    S.people[p.id] = p;
    S.names[p.id] = p.name || p.id;
    S.homes[p.id] = p.home ? [p.home.lng, p.home.lat] : [p.lng, p.lat];
    S.langs[p.id] = p.language_name || (p.language ? langName(p.language) : '');
    S.lang[p.id] = p.language || 'en';
  }
}
async function loadLive(g = S.gen) {
  if (!isReplay() && !hasKey()) return renderAll();
  try {
    const st = await S.B.state();
    if (g !== S.gen) return;  // drop answers from before a region switch
    applyState(st);
  }
  catch (e) { if (g !== S.gen) return; if (e.status !== 401) banner(e.message); renderAll(); }
}

/* ---------- the guided run (R4): six scenes; the timeline is its clock ---------- */
function setRunning(on) { S.running = on; renderTop(); renderRail(); }
let resume = null;
// A beat of the run: waits ms (0 under reduced motion), then holds while the run is paused.
async function beat(ms) {
  await sleep(ms);
  while (S.paused) await new Promise(r => (resume = r));
}
function togglePause() {
  S.paused = !S.paused;
  if (!S.paused) { resume?.(); resume = null; }
  announce(S.paused ? 'The run is paused.' : 'The run goes on.');
  renderRail();
}
const caption = (c, iso = null) => TL('set', iso, { caption: c });
// Moves the clock to `to` over ms with a caption; without a timeline it just waits.
const tlTo = (to, ms, c) => { caption(c); return tlPlay(to, ms, ms); };
function showNotice(on) {
  S.notice = on;
  const el = $('#notice');
  if (on) {
    $('#noticeT').textContent = `Power off ${dayTime(S.event.start)} to ${dayTime(S.event.end)}`;
    $('#noticeA').textContent = places().join(', ');
    $('#noticeS').textContent = noticeTag();
  }
  el.hidden = !on;
}
async function runDemo(from) {
  if (S.running) return;
  if (!isReplay() && !hasKey()) return openKey('Add the demo key to run the live demo.');
  if (from == null && S.plan) {  // a new run deletes the plan: ask first
    if (!$('#runPop').matches(':popover-open')) $('#runPop').showPopover();
    return;
  }
  from ??= S.event && !S.plan ? 2 : 1;
  $('#banner').hidden = true;
  S.directing = true; S.paused = false; S.ring = false;
  TL('setMode', 'run');
  setRunning(true);
  let ok = false;
  try {
    if (from === 1) await sceneNotice();
    await scenesPlan();
    ok = true;
  } catch { /* the failing step shows its error and a Retry button */ }
  S.directing = S.paused = false;
  showNotice(false);
  if (!ok) { TL('setMode', 'replay'); caption(''); }  // scene 6 keeps the run clock and "Waiting for your approval" until every row is approved
  S.ring = ok;  // three calm pulses on "Review and approve"; only a click opens the list
  setRunning(false);
  renderPanel();
  if (ok) planView();  // the camera ends on the whole plan, every clinic and route in view (the timeline bar is gone by now)
}
// Scene 1, "Notice received" (Mon 9:00 AM): POST /alert, then the notice card slides in over the map.
async function sceneNotice() {
  S.event = S.plan = S.affected = S.diff = null; S.rowErr = {};
  S.told = new Set(); S.clinicOk = new Set(); S.held = new Set(); S.tellErr = S.tellRetry = S.tellOpts = null; stopReplies(); seen.clear(); closeView(true);
  dropCheck(); resetPhases(); mapStage(0); clearSel(); R('close'); M('setScene', null); $('#panel').scrollTo({ top: 0, behavior: 'instant' });
  setPhase(0, { status: 'running', res: 'Reading the simulated PG&E notice' });
  renderAll();
  try { S.event = await S.B.alert(); }
  catch (e) { fail(0, e, () => runDemo(1)); throw e; }
  if (!S.outage) try { S.outage = (await S.B.state()).outage_area; } catch { /* the map shows no area; the plan still works */ }
  done(0, { res: noticeLine() });
  renderAll();  // mounts the timeline for this event
  caption('Notice received', new Date(nowMs()).toISOString());
  showNotice(true);
  await beat(5500);
}
// Scenes 2-6. POST /plan runs during scenes 2 and 3, so its answer is ready for scene 3.
async function scenesPlan() {
  setPhase(1, { status: 'running', res: 'Finding who has a treatment during the shutoff' });
  renderRail();
  const planP = S.B.plan(S.event.event_id).then(async plan => ({ plan, st: await S.B.state() }));
  planP.catch(() => { /* handled when scene 3 awaits it */ });
  // 2 "Shutoff area": the area draws in; the clock runs to Tue 6 PM and the area goes dark
  mapStage(1); M('focus', 'outage', { duration: 1050 });  // run camera moves: 0.75 of the map's default 1400 ms
  await tlTo(S.event.start, 5000, 'Shutoff area');
  await beat(2000);
  let plan, st;
  try { ({ plan, st } = await planP); }
  catch (e) { showNotice(false); fail(1, e, () => runDemo(2)); throw e; }
  if (st.patients && !Object.keys(S.names).length) setPeople(st.patients);
  if (st.clinics) S.raw = Object.fromEntries(st.clinics.map(c => [c.id, c]));
  if (st.rules) S.rules = st.rules;
  S.affected = st.affected; S.plan = plan; S.diff = null;
  runCheck();  // in the background, so step 6 usually has it
  const res = planPhases(plan), home = cname(homeFac()?.id), pr = pairs(), closed = S.affected.closed_clinic_ids.filter(id => S.fac[id]);
  // Road routes start now, so scene 4 has them: the plan's routes, then every candidate (the search's nearest-first order, R9)
  const listP = routeList();
  let ready = false; listP.then(() => { ready = true; });
  for (const id of closed) for (const f of cands()) road(pt(S.fac[id]), pt(f));
  // 3 "Zoom in": into the home clinic in 3D; it loses power, then its patients appear
  showNotice(false);
  const fly = window.LumenMap?.flyHome3D ? M('flyHome3D', { hold: 2500, duration: 1350 }) : M('focus', 'home', { duration: 1350 });
  await beat(2050);
  mapStage(2); caption(`${home} loses power`); renderAll();
  await beat(3000);
  // the patients' homes appear with their caption; the camera pulls back so they are in view
  mapStage(3); M('focus', 'outage', { duration: 1050 }); done(1, res[0]); caption(`${plural(affectedCount(), 'patient')} ${affectedCount() === 1 ? 'has' : 'have'} a treatment in this window`); renderAll();
  await Promise.all([Promise.resolve(fly), beat(2650)]);
  done(2, res[1]);
  // 4 "Zoom out and search" (R9): the map visits the clinics nearest first, one closed clinic after another; then the
  // routes the plan uses trace along the roads while each clinic's slots count up
  setPhase(3, { status: 'running', res: 'Each patient gets the nearest clinic with a free slot at their time.' });
  caption('Searching nearby clinics, nearest first');
  S.landed = {};  // every count starts at 0
  mapStage(4); renderAll();
  if (window.LumenMap?.searchGraph) {
    // under about 10 s however many clinics: the slow zoom out (2.25 s; a later dark clinic's 1.1 s), then about 6 s of visits.
    // El Dorado visits a few nodes at 700 ms; Santa Clara's three closed clinics about 20, faster.
    const vs = closed.map(id => [id, visitsFrom(id, pr)]), n = vs.reduce((k, [, v]) => k + v.length, 0);
    const perNode = Math.min(700, Math.floor(6000 / Math.max(1, n)));
    for (const [id, visits] of vs) await Promise.resolve(M('searchGraph', { sourceId: id, visits, perNode }));
  } else { M('focus', 'flows', { duration: 1050 }); await beat(2650); }
  if (!ready) { setPhase(3, { status: 'running', res: 'Finding road routes…' }); caption('Finding road routes…'); renderRail(); }
  const list = await listP;
  caption('Routes to clinics with open slots');
  homeRoutes();
  const land = it => { S.landed[it.toId] = (S.landed[it.toId] || 0) + it.count; M('setCapacity', capacity()); renderWhere(); };
  // about 10 s of tracing at most: a handful of routes 600 ms apart, more of them closer together
  const stagger = Math.min(600, Math.round(10000 / Math.max(1, list.length - 1))), span = reduced.matches ? 0 : stagger * Math.max(0, list.length - 1) + 1600;
  await Promise.all([Promise.resolve(M('traceRoutes', list, { stagger, duration: 1600, onArrive: land })), tlPlay(funnelAt(), span, span)]);
  S.landed = null;
  M('setCapacity', capacity());
  done(3, res[2]); renderAll();
  await beat(2000);
  // 5 "Messages"
  setPhase(4, { status: 'running', res: 'Writing patient messages' }); caption('Writing patient messages'); renderRail();
  await beat(2500);
  done(4, res[3]);
  // 6 "Check the plan": shown about 1.5 s; the run waits for the check 4 s at most, and a late result fills in when it lands
  setPhase(5, { status: 'running', res: 'Checking the plan…' }); caption('Checking the plan'); renderRail();
  await Promise.all([beat(1500), Promise.race([S.checkP, new Promise(r => setTimeout(r, 4000))])]);
  landCheck();
  // 7 "Approve and tell everyone": the run waits for staff (runDemo); nothing is sent until staff approve
  syncTell();
  caption('Waiting for your approval');
  announce('Approve and tell everyone is waiting for you. Nothing is sent until you approve.');
  renderRail();
}
// ids: 'all' or a list of patient ids (the review card's Approve). Rejects on failure.
async function approve(ids) {
  if (S.approving || S.running || !S.plan) throw new ApiError('Another change is still saving. Try again in a moment.', 0);
  const all = ids === 'all';
  S.approving = true; S.tellErr = null;
  S.telling = all ? 'Approving every patient' : `Approving ${plural(ids.length, 'patient')}`;  // step 7's line while it saves
  renderAll();
  let err = null;
  try {
    S.plan = await S.B.approve({ event_id: S.event.event_id, patient_ids: all ? ['all'] : ids, edits: [] });
    checkSoon();
  } catch (e) { err = e; S.tellErr = e; S.tellRetry = () => approve(ids).catch(() => {}); }
  S.approving = false; S.telling = '';
  if (err) fail(6, err);
  renderAll(); syncReview();
  if (err) throw err;
}
// A reply or a call result: confirmed, declined or no_answer. Only a decline changes what the check finds.
async function edit(id, status) {
  if (S.running || S.busy[id]) return;
  S.busy[id] = true; S.rowErr[id] = null;
  try {
    S.plan = await S.B.approve({ event_id: S.event.event_id, patient_ids: [], edits: [{ patient_id: id, status }] });
    announce(`${pname(id)}: ${STATUS[status].toLowerCase()}.`);
    if (status === 'declined') checkSoon();
  } catch (e) { S.rowErr[id] = e.message; if (e.status !== 401) banner(e.message); }
  S.busy[id] = false;
  renderPanel(); renderRail(); syncReview();
}
// The review panel wants a promise that rejects with the reason the write failed.
const editOrThrow = (id, status) => edit(id, status).then(() => { if (S.rowErr[id]) throw new ApiError(S.rowErr[id], 0); });
// The voice note (POST /voice: Polly, live; the replay plays its three recorded notes): {url} or {note} when there is none.
async function voiceFor(id, lang) {
  const { url, note } = await S.B.voice({ event_id: S.event.event_id, patient_id: id, lang });
  return { url, note };
}

/* ---------- approve and tell (v5 stage 2): one press approves, sends the voice notes and tells the clinics (all simulated) ---------- */
// The review list calls it with the switches staff turned off: voiceOff (patient IDs), clinicsOff (clinic IDs), hold (IDs it keeps
// as drafts, and whose sheets it keeps back; optional). Order: approve the drafts, /notify the moves, /packet the transfer and hospital rows.
// Resolves to { told: [patient IDs sent or queued], skipped: [{id, name, reason}], clinics: [clinic IDs told] }; rejects with the reason.
async function approveAndTell(o = {}) {
  if (S.approving || S.running || !S.plan) throw new ApiError('Another change is still saving. Try again in a moment.', 0);
  const voiceOff = new Set(o.voiceOff || []), clinicsOff = new Set(o.clinicsOff || []), hold = new Set(o.hold || []);
  const ev = S.event.event_id, ok = r => r.status === 'approved' || r.status === 'confirmed';
  const shown = new Set(checkIndex().call);  // the list showed these as "call instead": one still switched on is staff's choice
  const step = t => { S.telling = t; renderRail(); };  // step 7's line while it runs
  S.approving = true; S.tellErr = null; S.tellOpts = o; S.held = hold; stopReplies();
  S.telling = 'Approving every patient';
  renderAll();
  let n = { sent: [], queued: [], skipped: [] }, pk = { sent: [] };
  try {
    const drafts = S.plan.patients.filter(r => r.status === 'draft' && !hold.has(r.patient_id)).map(r => r.patient_id);
    if (drafts.length) S.plan = await S.B.approve({ event_id: ev, patient_ids: drafts, edits: [] });
    step('Sending voice notes');
    if (S.checkP) await Promise.race([S.checkP, new Promise(r => setTimeout(r, 25e3))]);  // a check still running: wait, so call-instead patients are known
    const notes = S.plan.patients.filter(r => isMove(r) && ok(r) && !voiceOff.has(r.patient_id)).map(r => r.patient_id);
    if (notes.length) { n = await S.B.notify({ event_id: ev, patient_ids: notes, call_instead: [...checkIndex().call].filter(id => !shown.has(id)) }); S.plan = n.plan; }
    step('Telling the clinics');
    const sheets = S.plan.patients.filter(r => (r.action === 'transfer' || r.action === 'hospital') && ok(r) && r.clinic_id
      && !clinicsOff.has(r.clinic_id) && !hold.has(r.patient_id) && r.packet?.status !== 'sent').map(r => r.patient_id);
    if (sheets.length) { pk = await S.B.packet({ event_id: ev, patient_ids: sheets }); S.plan = pk.plan; }
  } catch (e) {
    S.tellErr = e; S.tellRetry = () => approveAndTell(S.tellOpts).catch(() => {}); S.approving = false; S.telling = '';  // step 7 retries from here
    fail(6, e);
    renderAll(); syncReview();
    startReplies();  // the replies an earlier press started go on
    throw e;
  }
  const by = Object.fromEntries(S.plan.patients.map(r => [r.patient_id, r])), clinics = [...new Set(pk.sent.map(id => by[id]?.clinic_id).filter(Boolean))];
  clinics.forEach(c => S.told.add(c));
  S.approving = false; S.telling = ''; S.diff = null;  // the changes are approved and told
  checkSoon();
  renderAll(); syncReview(); mapFlows();
  const told = [...n.sent, ...n.queued];
  announce(`Approved. ${plural(told.length, 'patient')} and ${plural(clinics.length, 'clinic')} told.`);
  $('#panel').scrollTo({ top: 0, behavior: reduced.matches ? 'auto' : 'smooth' });
  startReplies();
  return { told, skipped: n.skipped.map(s => ({ id: s.patient_id, name: pname(s.patient_id), reason: s.reason })), clinics };
}
// Who was told, from the plan (notes) and the clinics told this session (sheets). done: every row is approved (or held at the
// last approve and tell) and someone was told. waiting: told patients who have not replied yet.
function toldNow() {
  const all = S.plan?.patients || [], notes = all.filter(noted).length, waiting = all.filter(r => noted(r) && r.status === 'approved').length;
  return { notes, waiting, clinics: S.told.size, done: !!all.length && all.every(r => r.status !== 'draft' || S.held.has(r.patient_id)) && (notes > 0 || S.told.size > 0) };
}
// "36 patients and 4 clinics told · 3 notes wait until 8 AM"
function toldLine(t) {
  const q = (S.plan?.patients || []).filter(r => r.note?.status === 'queued').length;
  return [t.notes && `${plural(t.notes, 'patient')}`, t.clinics && `${plural(t.clinics, 'clinic')}`].filter(Boolean).join(' and ') + ' told'
    + (q ? ` · ${plural(q, 'note')} wait${q === 1 ? 's' : ''} until 8 AM` : '');
}
// "Needs you now": no answer, no slot, said no, or a move with no voice note (the check says phone, or staff turned the note off)
function needsYou() {
  const ck = checkIndex();
  return (S.plan?.patients || []).filter(r => r.status === 'draft' || r.status === 'no_answer' || r.status === 'declined' || needsPhone(r)
    || (hasChair(r) && r.status === 'approved' && !noted(r))).map(r => {
    const why = r.status === 'draft' ? 'On hold, not approved' : r.status === 'no_answer' ? 'No answer' : r.status === 'declined' ? 'Said no' : needsPhone(r) ? 'No slot yet'
      : ck.call.has(r.patient_id) ? 'Phone, not a voice note' : 'No voice note sent';
    const at = r.slot ? r.pickup_time || null : r.affected_session;
    return { id: r.patient_id, name: pname(r.patient_id), why, at, when: !at ? '' : r.slot ? `${r.ride === 'paratransit' || r.ride === 'medical_van' ? 'Pickup' : 'Leaves'} ${dayTime(at)}` : `Usual treatment ${dayTime(at)}`,
      phone: S.people[r.patient_id]?.callback || '' };
  }).sort((a, b) => (Date.parse(a.at) || Infinity) - (Date.parse(b.at) || Infinity));
}

/* ---------- simulated replies (v5, demo only): patients answer their voice note; told clinics confirm the slots ---------- */
// Deterministic: over about 20 s every patient with a sent note says yes in 3 batches, except those who missed a treatment
// recently or live alone with a pickup before 6 AM, who do not answer. Each clinic confirms 4 to 8 s after its list.
// Reduced motion: everything lands at once.
let replyTok = 0;
const fH = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
const quiet = r => (r.reasons || []).includes('missed_recently')
  || ((r.reasons || []).includes('lives_alone') || S.people[r.patient_id]?.lives_alone) && !!r.pickup_time && +fH.format(new Date(r.pickup_time)) < 6;
function stopReplies() { replyTok++; S.replying = false; }
function startReplies() {
  const tok = ++replyTok, fast = reduced.matches;
  // every told clinic that has not confirmed yet, so a second approve and tell never strands the first one's clinics
  [...S.told].filter(c => !S.clinicOk.has(c)).forEach((c, i) => setTimeout(() => {
    if (tok !== replyTok) return;
    S.clinicOk.add(c); announce(`${cname(c)} confirmed the slots.`); renderPanel(); renderRail();
  }, fast ? 0 : 4000 + (i * 1700) % 4000));
  const due = rows().filter(r => r.note?.status === 'sent' && r.status === 'approved');
  if (!due.length) return renderRail();
  const yes = due.filter(r => !quiet(r)).map(r => r.patient_id), no = due.filter(quiet).map(r => r.patient_id), third = Math.ceil(yes.length / 3);
  const edits = (ids, status) => ids.map(patient_id => ({ patient_id, status }));
  const steps = fast ? [[0, [...edits(yes, 'confirmed'), ...edits(no, 'no_answer')]]]
    : [[5000, edits(yes.slice(0, third), 'confirmed')], [6000, edits(yes.slice(third, 2 * third), 'confirmed')],
      [6000, edits(yes.slice(2 * third), 'confirmed')], [3500, edits(no, 'no_answer')]].filter(([, e]) => e.length);
  S.replying = true; renderRail(); renderPanel();
  let reloaded = false;
  (async () => {
    for (const [ms, list] of steps) {
      await new Promise(r => setTimeout(r, ms));
      while (tok === replyTok && (S.running || S.approving || Object.values(S.busy).some(Boolean))) await new Promise(r => setTimeout(r, 500));  // let a staff change save first
      if (tok !== replyTok) return;
      // a reply never overwrites what staff saved meanwhile (a "said no", a call result): only rows still waiting answer
      const dueOf = () => { const by = Object.fromEntries(S.plan.patients.map(r => [r.patient_id, r])); return list.filter(e => by[e.patient_id]?.status === 'approved' && by[e.patient_id].note?.status === 'sent'); };
      let due = dueOf(), plan = null;
      if (!due.length) continue;
      try { plan = await S.B.approve({ event_id: S.event.event_id, patient_ids: [], edits: due }); }
      catch (e) {
        // another write won the plan version (409): load the plan once, then answer the rows that still wait
        if (e.status === 409 && !reloaded && tok === replyTok) {
          reloaded = true;
          try {
            const st = await S.B.state(); if (tok !== replyTok) return;
            if (st.plan) S.plan = st.plan;
            due = dueOf(); plan = due.length ? await S.B.approve({ event_id: S.event.event_id, patient_ids: [], edits: due }) : S.plan;
          } catch { plan = null; }
        }
        if (!plan) { if (tok === replyTok) { S.replying = false; renderRail(); renderPanel(); } return; }  // the board shows what landed
      }
      if (tok !== replyTok) return;
      S.plan = plan;
      if (!due.length) { renderPanel(); renderRail(); syncReview(); continue; }
      const y = due.filter(e => e.status === 'confirmed').length;
      announce(y ? `${plural(y, 'patient')} said yes.` : `${plural(due.length, 'patient')} did not answer.`);
      renderPanel(); renderRail(); syncReview();
    }
    if (tok === replyTok) { S.replying = false; renderRail(); renderPanel(); }
  })();
}

async function replan(instruction) {
  instruction = instruction.trim();
  if (!instruction || !S.plan || S.running || S.approving || S.replying || Object.values(S.busy).some(Boolean)) return;
  const ph = { name: `Change: ${instruction}`, status: 'running', res: 'Changing the plan' };
  const at = () => S.phases.indexOf(ph);  // hold the step, not its index: a Retry can remove an earlier one
  S.phases.push(ph); $('#chgErr').hidden = true;
  setRunning(true); renderPanel();
  try {
    const r = await S.B.replan({ event_id: S.event.event_id, instruction });
    S.plan = r.plan;
    S.diff = r.diff.reduce((m, d) => ((m[d.patient_id] ||= []).push(d), m), {});
    const n = Object.keys(S.diff).length, read = r.understood?.length ? `Lumen understood: ${plainCall(r.understood.join(' '))}\n` : '';
    done(at(), { res: read + plainCall(r.summary || r.plan.summary || `${plural(n, 'patient')} changed`) });
    S.phases[3].res = moveLine(r.plan);  // Find open slots shows the plan as it is now
    runCheck();  // steps 7 and 8 follow the plan (syncTell): changed patients wait for approval again
    $('#instr').value = ''; openChange(false);
    S.running = false; clearSel();
    renderPanel();
    facStatus(); mapPatients(); mapFlows(); M('setCapacity', capacity()); M('focus', 'flows');
    drawRoutes();  // any new pair is computed live
    announce(`${plural(n, 'patient')} changed.`);
  } catch (e) {
    // the failed change leaves the steps (no Retry there: the box keeps the words to try again)
    setPhase(at(), { status: 'error', err: e.message, res: '' });
    $('#chgErr').textContent = e.message; $('#chgErr').hidden = false;
    announce(`The change did not work. ${e.message}`);
    setRunning(false); $('#instr').focus();
    return;
  }
  setRunning(false);
}
async function doReset() {
  $('#resetPop').hidePopover();
  setRunning(true);
  try { await S.B.reset(); }
  catch (e) { setRunning(false); if (e.status !== 401) banner(e.message); return; }
  clearRun();
  S.running = false;
  M('focus', 'home');
  renderAll();
  announce('The demo is reset.');
}
// Scene 0: powered, no notice, no plan, no timeline.
function clearRun() {
  Object.assign(S, { event: null, affected: null, plan: null, diff: null, rowErr: {}, busy: {}, roadFail: false, landed: null,
    told: new Set(), clinicOk: new Set(), held: new Set(), telling: '', tellErr: null, tellRetry: null, tellOpts: null, msgLang: {} });
  stopReplies(); seen.clear(); closeView(true); dropCheck(); resetPhases(); mapStage(0); clearSel(); R('close'); showNotice(false); TL('setMode', 'replay'); S.ring = false;
  M('setScene', null);  // the map goes back to the real power state
  $('#banner').hidden = true; $('#panel').scrollTo({ top: 0, behavior: 'instant' });
}
async function setRegion(region) {
  const g = ++S.gen;
  S.region = region; store.set('lumenRegion', region);  // the county stays across reloads (v6)
  $('#region').value = region;
  clearRun();
  // Santa Clara without a key plays the recorded live run (CONTRACT-v6 section 5); with a key both counties are live (?region=)
  const replay = region === 'santaclara' && !hasKey();
  try {
    S.data[region] ||= await (await fetch(`data/${region}.json`)).json();
    if (replay) S.rec ||= await (await fetch('data/replay/santaclara.json')).json();
  } catch { banner('The demo data did not load. Reload the page.'); }
  if (g !== S.gen) return;  // the user switched again while this loaded
  S.B = replay && S.rec ? replayBackend(S.rec) : live;
  S.clinics = region === 'eldorado' ? FALLBACK : []; S.raw = {}; setPeople([]); S.outage = null;
  indexFac();
  M('setRegion', S.data[region], S.clinics);  // regionData carries the county outline when the data has one (E9)
  mapStage(0); M('focus', 'home');
  renderAll();
  await loadLive(g);
}

/* ---------- top bar ---------- */
function renderTop() {
  const h = homeFac();
  $('#homeName').textContent = h ? h.name : '';
  $('#chip').classList.toggle('on', !!S.event);
  $('#chipT').textContent = S.event ? `Power off in ${countdown()}` : 'No shutoff notice';
  for (const id of ['run', 'reset', 'region']) setDisabled($('#' + id), S.running || S.approving);  // approving writes to this region's plan
  $('#wholeBtn').hidden = S.stage < 4 || !S.plan;
  $('#legend').hidden = planReady();  // after the plan the map keeps a few plain marks: no key needed
  legend();
  syncTimeline();
}
// R6: the legend lists only what the map shows now (data-s = the first stage that draws it, data-x = the stage that replaces it).
function legend() {
  const show = { county: !!S.data[S.region]?.county, changed: !!S.diff, straight: S.roadFail && S.stage >= 4,
    notice: S.stage >= 4 && !!S.plan?.patients.some(r => r.action === 'notify_only') };
  for (const el of document.querySelectorAll('#legend [data-s]')) {
    const w = el.dataset.w;
    el.hidden = S.stage < +el.dataset.s || (el.dataset.x && S.stage >= +el.dataset.x) || (w && !show[w]);
  }
}

/* ---------- outage timeline (E8): LumenTimeline in a bar at the bottom of the map, only while the run plays (v5) ---------- */
let tlKey = '';  // the event the timeline is mounted for
const funnelAt = () => { const a = Date.parse(S.event.start); return new Date(a + 0.12 * (Date.parse(S.event.end) - a)).toISOString(); };  // funnel is full after ~10% of the off window
const sceneTime = () => S.stage >= 4 ? funnelAt() : S.stage >= 2 ? S.event.start : new Date(nowMs()).toISOString();
function syncTimeline() {
  const ev = S.directing ? S.event : null, k = ev ? `${S.region}|${ev.event_id}|${ev.issued_at}|${ev.start}|${ev.end}` : '';
  if (k === tlKey || !window.LumenTimeline) return;
  if (tlKey) { TL('destroy'); M('setScene', null); }  // the map goes back to the real power state
  tlKey = k;
  if (!ev) return;
  TL('mount', $('#timeline'), {
    stops: [{ t: ev.issued_at, label: 'Notice' }, { t: ev.start, label: 'Power off' }, { t: ev.end, label: 'Power back' }],
    label: 'Simulated timeline',
    onChange: st => M('setScene', { power: st.power, funnel: st.funnel }),
  });
  TL('set', sceneTime());
}
// Plays the timeline to `to`; without a timeline it just waits `wait` ms.
const tlPlay = (to, ms, wait = 0) => tlKey ? Promise.resolve(TL('play', { to, ms })).catch(() => {}) : sleep(wait);

/* ---------- right panel ---------- */
// Re-rendering replaces the focused control: focus its new copy, else the fallback.
function keepFocus(fn, fallback = '#panelH') {
  const a = document.activeElement, k = a?.dataset?.k;
  fn();
  if (!k) return;
  if (a.isConnected) { if (document.activeElement !== a) a.focus({ preventScroll: true }); return; }  // a node put back (keepOpener) lost focus
  const el = $(`[data-k="${k}"]`);
  (el && !el.disabled ? el : $(fallback))?.focus({ preventScroll: true });
}
// Re-renders keep the scroll position; an instant scroll, since the panels scroll smoothly (E6).
function keepScroll(el, fn) {
  const top = el.scrollTop;
  fn();
  if (el.scrollTop !== top) el.scrollTo({ top, behavior: 'instant' });
}
// The review panel returns focus to its opener: when a re-render replaced that button, put the original node back.
function keepOpener() {
  const o = S.opener; if (!o || o.isConnected) return;
  const n = $(`[data-k="${o.dataset.k}"]`);
  if (n) { o.className = n.className; o.disabled = n.disabled; o.innerHTML = n.innerHTML; n.replaceWith(o); }
}
function renderAll() { renderTop(); renderRail(); renderPanel(); }
function renderPanel() {
  const el = $('#panel'), plan = S.stage >= 4 && S.plan;
  if (!plan) S.view = null;  // reset or a new run: the plan the view showed is gone
  keepFocus(() => keepScroll(el, () => {
    el.innerHTML = !plan ? keyCard() + (S.event ? eventHTML() : '') + homeHTML() : S.view ? viewHTML() : toldNow().done ? doneHTML() : planHTML();
    keepOpener();
  }));
}
function keyCard() {
  if (isReplay() || hasKey()) return '';
  return `<div class="keycard"><p>Add the demo key to load the live plan. The map works without it.</p>
    <button class="btn sec" type="button" data-act="key" data-k="key">${icon('key')}Add demo key</button></div>`;
}
function homeHTML() {
  const h = homeFac(); if (!h) return '';
  const raw = S.raw[h.id], bp = raw?.backup_power || 'none', sim = !raw || (raw.simulated || []).includes('backup_power');
  const n = S.affected ? new Set(S.affected.sessions.filter(s => s.clinic_id === h.id).map(s => s.patient_id)).size : null;
  const pw = S.affected ? (S.affected.closed_clinic_ids.includes(h.id) ? `<span class="pw off">Loses power ${esc(win())}</span>` : '<span class="pw ok">Stays powered</span>')
    : S.event ? '<span class="pw wait">Not checked yet</span>' : '<span class="pw ok">Powered</span>';
  return `<section class="sec"><h2 id="panelH" tabindex="-1">Your clinic</h2>
    <p class="hname">${esc(h.name)}</p>${h.address ? `<p class="addr">${esc(h.address)}</p>` : ''}
    <dl class="facts">
      <dt>Slots per shift</dt><dd class="num">${h.stations ?? 'Not listed'}</dd>
      <dt>Backup generator</dt><dd>${esc(bp)}${sim ? ' (simulated)' : ''}</dd>
      <dt>Power</dt><dd>${pw}</dd>
      ${n != null ? `<dt>Treatments during the shutoff</dt><dd class="num">${plural(n, 'patient')}</dd>` : ''}
    </dl>
    ${S.event ? '' : '<p class="small hint">Press Run demo to see Lumen answer a power shutoff notice. Demo assumptions, not clinical guidance.</p>'}</section>`;
}
function eventHTML() {
  const e = S.event;
  return `<section class="sec"><h2>Shutoff notice<span class="tag n">${noticeTag()}</span></h2>
    <dl class="facts">
      <dt>Area</dt><dd>${esc(e.area_name)}</dd>
      <dt>Power off</dt><dd>${esc(win())}</dd>
      <dt>Starts in</dt><dd class="num">${esc(countdown())}</dd>
    </dl>
    ${e.source_text ? `<details class="notice"><summary>Notice text</summary><pre>${esc(e.source_text)}</pre></details>` : ''}
  </section>`;
}
// v5 stage 1 and 2: one sentence, the check verdict, one button, then where everyone goes. The patient list lives in the review.
function planHTML() {
  const p = S.plan, chair = p.patients.filter(hasChair).length, phone = p.patients.filter(needsPhone).length, keep = counts(p).notify_only;
  const dis = S.running || S.approving || !canReview() ? ' disabled' : '';
  return `<div class="plan">
    <h2 class="lead" id="panelH" tabindex="-1">${plural(chair, 'patient')} ${chair === 1 ? 'has' : 'have'} a slot.${phone ? ` <span>${phone} need${phone === 1 ? 's' : ''} a phone call from you.</span>` : ''}${keep ? ` <span>${keep} keep${keep === 1 ? 's' : ''} the usual time.</span>` : ''}</h2>
    ${verdictHTML()}
    <div class="acts"><button class="btn pri big${S.ring ? ' ring' : ''}" type="button" data-act="review" data-k="review-panel"${dis}>${S.telling ? `${S.telling}…` : 'Review and approve'}</button></div>
    <p class="note">Nothing is sent until you approve.</p>
    ${whereHTML()}
  </div>`;
}
// The check verdict (POST /check): a verdict first, then at most 3 one-sentence items. Blocks win: "Fix before approving: …".
function verdictHTML() {
  if (S.checkErr && !S.check) return `<section class="verdict bad" role="status"><h3>${icon('x')}The plan check did not run.</h3>
    <p class="vd-n">You can still approve. ${esc(S.checkErr.message)}</p><button class="btn sec sm" type="button" data-act="recheck" data-k="recheck">Check again</button></section>`;
  if (!S.check || S.phases[5]?.status !== 'done') return S.directing ? '' : '<section class="verdict wait" role="status"><h3><i class="spin" aria-hidden="true"></i>Checking the plan…</h3></section>';
  const { blocks, groups } = checkParts();
  if (blocks.length) return `<section class="verdict bad" role="status"><h3>${icon('x')}Plan checked. Not ready yet.</h3>
    <ul>${blocks.slice(0, 3).map(i => `<li><b>Fix before approving:</b> ${esc(named(i.text))}</li>`).join('')}</ul></section>`;
  const rank = ([c]) => CALL.has(c) ? 0 : EVERY_ROW.has(c) ? 2 : 1;
  const items = groups.sort((a, b) => rank(a) - rank(b)).slice(0, 3).map(([code, list]) => {
    const n = new Set(list.map(i => i.patient_id || i.facility_id)).size;
    return list.length === 1 ? named(list[0].text) : (CHECK_SAY[code] || (k => `${plural(k, 'patient')}: ${cap(code.replace(/_/g, ' '))}.`))(n);
  });
  return `<section class="verdict ok" role="status"><h3>${icon('ck')}Plan checked. Ready to approve.</h3>${items.length ? `<ul>${items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</section>`;
}
// "Where they go": each receiving clinic (patients · slots left), then early and phone. A clinic row, and the phone row when a
// hospital gets sheets, opens what that place gets (v6) and shows only its route on the map.
function whereHTML() {
  const cp = capacity(), list = Object.entries(cp).filter(([, c]) => c.open != null).sort(([, a], [, b]) => b.n - a.n);
  const early = S.plan.patients.filter(r => r.action === 'early_session' && hasChair(r)).length, phone = S.plan.patients.filter(needsPhone).length;
  const hosp = mostOf(S.plan.patients.filter(r => r.action === 'hospital' && r.status !== 'declined').map(r => r.clinic_id));
  const li = ([id, c]) => {
    const left = c.open - c.used, v = `${plural(c.used, 'patient')} · ${left > 0 ? `${plural(left, 'slot')} left` : 'Full'}`;
    return `<li><button class="wrow" type="button" data-act="clinic" data-id="${id}" data-k="wh-${id}" aria-label="${esc(cname(id))}: ${esc(v)}. See what this clinic gets.">
      <span class="wn">${esc(cname(id))}</span><span class="wv num">${esc(v)}</span>${icon('chev')}</button></li>`;
  };
  const call = `<span class="wn">Need a phone call</span><span class="wv num">${plural(phone, 'patient')}</span>`;
  const top = list.length > 7 ? 6 : list.length, more = list.slice(top);  // many receiving clinics: the busiest six first (a fold for one row saves nothing)
  return `<section class="where" aria-labelledby="whH"><h3 id="whH">Where they go</h3>
    <ul>${list.slice(0, top).map(li).join('')}
      ${early ? `<li><span class="wrow e"><span class="wn">Come in early here</span><span class="wv num">${plural(early, 'patient')}</span></span></li>` : ''}
      ${phone ? `<li>${hosp ? `<button class="wrow c" type="button" data-act="clinic" data-id="${hosp}" data-k="wh-${hosp}" aria-label="Need a phone call: ${plural(phone, 'patient')}. See what ${esc(cname(hosp))} gets.">${call}${icon('chev')}<span class="ws">${esc(cname(hosp))} gets their sheets</span></button>`
        : `<span class="wrow c">${call}</span>`}</li>` : ''}</ul>
    ${more.length ? `<details class="more"${S.chMore ? ' open' : ''}><summary data-k="chmore">${plural(more.length, 'more clinic')}${icon('chev')}</summary><ul>${more.map(li).join('')}</ul></details>` : ''}
  </section>`;
}
function renderWhere() { const el = $('#panel .where'); if (el) keepFocus(() => { el.outerHTML = whereHTML(); }); }
// v5 stage 3: the done board fills in as the (simulated) replies land; "Needs you now" lists who staff still phone, soonest first.
const seen = new Set();  // board rows and people already shown, so a check draws and a row slides in only once
function doneHTML() {
  const all = S.plan.patients, need = needsYou(), t = toldNow();
  const told = all.filter(noted), yes = told.filter(r => r.status === 'confirmed').length, na = told.filter(r => r.status === 'no_answer').length, no = told.filter(r => r.status === 'declined').length;
  const wait = told.filter(r => r.status === 'approved').length, phone = all.filter(needsPhone).length, drafts = all.filter(r => r.status === 'draft').length;
  const want = [...new Set(all.filter(r => (r.action === 'transfer' || r.action === 'hospital') && r.clinic_id && r.status !== 'draft' && r.status !== 'declined').map(r => r.clinic_id))];
  const tc = want.filter(c => S.told.has(c)), okc = tc.filter(c => S.clinicOk.has(c)).length;
  const row = (k, st, label, value, extra = '') => {
    const fresh = st === 'ok' && !seen.has(k); if (st === 'ok') seen.add(k);
    return `<div class="brow ${st}${fresh ? ' fresh' : ''}"><dt><i class="bi" aria-hidden="true">${st === 'ok' ? icon('ck') : ''}</i>${label}</dt><dd class="num">${esc(value)}</dd>${extra ? `<dd class="bx">${extra}</dd>` : ''}</div>`;
  };
  // each place opens what it gets (v6): a check once it confirmed the slots, struck through when staff turned it off
  const clinicList = want.length ? `<ul class="cl">${want.map(c => { const st = S.clinicOk.has(c) ? 'ok' : S.told.has(c) ? '' : 'off';
    return `<li class="${st}"><button type="button" data-act="clinic" data-id="${c}" data-k="cl-${c}">${st === 'ok' ? icon('ck') : ''}${esc(cname(c))}<span class="vh">: ${st === 'ok' ? 'confirmed' : st ? 'not told' : 'told'}. See what it gets.</span></button></li>`; }).join('')}</ul>` : '';
  const needLi = n => {
    const fresh = !seen.has(`n-${n.id}-${n.why}`); seen.add(`n-${n.id}-${n.why}`);
    return `<li class="${fresh ? 'fresh' : ''}"><button class="nn" type="button" data-act="patient" data-id="${n.id}" data-k="nd-${n.id}" aria-label="${esc(n.name)}: ${esc(n.why)}. See what they get.">${esc(n.name)}</button>${n.phone ? `<a class="np num" href="tel:${esc(n.phone)}">${esc(n.phone)}</a>` : ''}
      <span class="nw">${esc(n.why)}${n.when ? ` · ${esc(n.when)}` : ''}</span></li>`;
  };
  const enter = !seen.has('board'); seen.add('board');  // the board rises in once, when telling is done
  return `<section class="doneb${enter ? ' enter' : ''}" aria-labelledby="panelH">
    <p class="print-only">Lumen · ${esc(homeFac()?.name || '')} · printed ${esc(dt(new Date().toISOString()))}</p>
    <h2 class="lead" id="panelH" tabindex="-1">${need.length ? `Almost done: ${plural(need.length, 'person', 'people')} to call` : wait ? 'Almost done' : 'Everyone is set'}</h2>
    <p class="lead-s">${S.replying ? 'Replies are coming in.' : wait ? 'Waiting for replies.' : need.length ? 'Everything else is ready.' : 'Every patient and clinic has been told.'}</p>
    <dl class="board">
      ${row('slots', drafts ? 'todo' : 'ok', 'Slots', `${all.length - drafts} of ${all.length}${phone ? ` · ${phone} by phone` : ''}`)}
      ${row('told', wait ? 'wait' : 'ok', 'Patients told', !told.length ? 'No voice notes sent' : wait === told.length ? `${told.length} · waiting for replies` : [told.length, yes && `${yes} said yes`, no && `${no} said no`, na && `${na} no answer`, wait && `${wait} waiting`].filter(Boolean).join(' · '))}
      ${row('clinics', tc.length < want.length ? 'todo' : okc < tc.length ? 'wait' : 'ok', 'Clinics told', `${tc.length} of ${want.length}${!tc.length ? '' : okc === tc.length ? ' · all confirmed' : okc ? ` · ${okc} confirmed` : ' · waiting to confirm'}`, clinicList)}
    </dl>
    ${need.length ? `<h3 class="needs-h">Needs you now, soonest first</h3><ol class="needs">${need.map(needLi).join('')}</ol>` : ''}
    <div class="acts">${need.length ? `<button class="btn sec" type="button" data-act="print" data-k="print">${icon('print')}Print the list</button>` : ''}
      <button class="btn q" type="button" data-act="review" data-k="review-panel"${S.running || S.approving || !canReview() ? ' disabled' : ''}>See every patient</button></div>
    <p class="note">${t.notes || t.clinics ? 'The replies here are simulated for the demo. Nothing leaves Lumen.' : ''}</p>
  </section>`;
}
const mostOf = ids => { const n = {}; for (const id of ids) if (id) n[id] = (n[id] || 0) + 1; return Object.keys(n).sort((a, b) => n[b] - n[a])[0] || ''; };

/* ---------- what a patient and a clinic get (v6 section 4): one panel view over the plan; Back or Esc closes it ---------- */
// S.view: {type: 'patient' | 'clinic', id, back: the view to return to (a patient opened from a clinic's list), k: its opener's data-k}
function openView(v, opener) {
  stopVoice();
  S.view = { ...v, k: opener?.dataset?.k || v.k || '' };
  if (v.type === 'patient') selectRow(v.id, true);  // only this patient's road route on the map
  else {
    const into = pairs().filter(p => p.toId === v.id), from = new Set(into.map(p => p.fromId));
    clearSel();
    if (into.length) { S.route = { fromId: from.size === 1 ? into[0].fromId : null, toId: v.id }; M('isolate', { type: 'route', ...S.route }); }
  }
  openPanel(true);
  renderPanel();
  $('#panel').scrollTo({ top: 0, behavior: 'instant' });
  $('#panelH')?.focus({ preventScroll: true });
  announce($('#panelH')?.textContent || '');
}
// silent: the plan is going away (reset, a new run); else back to the clinic's list or the plan, focus on what opened the view
function closeView(silent) {
  const v = S.view; if (!v) return;
  stopVoice();
  S.view = null;
  if (silent) return;
  if (v.back) { openView(v.back); $(`[data-k="cv-${v.id}"]`)?.focus(); return; }
  clearSel(); planView(); renderPanel();  // the map goes back to the whole plan too
  ($(`[data-k="${v.k}"]`) || $('#panelH'))?.focus();
}
function viewHTML() {
  const v = S.view, back = v.back ? `Back to ${cname(v.back.id)}` : 'Back to the plan';
  return `<section class="view" aria-labelledby="panelH">
    <button class="back" type="button" data-act="back" data-k="back">${icon('chev')}${esc(back)}</button>
    ${v.type === 'patient' ? patientView(v.id) : clinicView(v.id)}</section>`;
}
// research/patients.md: Chinese-speaking patients keep the family name first (as review.js reads it); everyone else the given name
const firstName = id => { const w = pname(id).trim().split(/\s+/); return S.lang[id] === 'zh' && w.length > 1 ? w.at(-1) : w[0]; };
// The line under the bubble, [kind, words], worded as the review card words it: "Told 9:02 AM · Said yes"
function receipt(r) {
  if (r.status === 'declined') return ['no', 'Said no'];
  const n = r.note, t = n?.status === 'sent' ? `Told ${time(n.sent_at)}` : '';
  if (r.status === 'confirmed') return ['yes', [t, 'Said yes'].filter(Boolean).join(' · ')];
  if (r.status === 'no_answer') return ['wait', [t, 'No answer'].filter(Boolean).join(' · ')];
  if (t) return ['told', t];
  if (n?.status === 'queued') return ['', `Sends at ${time(n.send_at)}`];
  if (n?.status === 'stale') return ['', 'The plan changed. Not sent again yet.'];
  return ['', r.status === 'draft' ? 'Not sent yet. It goes out when you approve.' : toldNow().done ? 'Not sent. Staff phone instead.' : 'Not sent yet'];
}
// "Oct 6" from "2026-10-06"
const shortDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
// The patient: their message as one text-message bubble in their language (a tab for English too), when it went out, the reply,
// and the voice note (Polly speaks English, Spanish and Chinese; other languages play the English note, or show the text only).
function patientView(id) {
  const r = S.plan.patients.find(x => x.patient_id === id), first = esc(firstName(id)), h = `<h2 class="lead" id="panelH" tabindex="-1">What ${esc(pname(id))} gets</h2>`;
  if (!r) return `${h}<p class="note">This patient is no longer in the plan.</p>`;
  const langs = msgLangs(r), lang = langs.includes(S.msgLang[id]) ? S.msgLang[id] : langs[0], msg = lang && r.messages[lang];
  const phone = S.people[id]?.callback, call = phone ? ` at <a class="num" href="tel:${esc(phone)}">${esc(phone)}</a>` : '';
  const head = `${h}<p class="vsub">${esc(summaryOf(r))}</p>`;
  if (!msg) return `${head}<p class="vnone">No text message. Staff phone ${first}${call}.</p>`;
  const tabs = langs.length > 1 ? `<div class="langs" role="group" aria-label="Message language">${langs.map(l =>
    `<button type="button" data-act="lang" data-id="${id}" data-lang="${l}" data-k="lang-${l}" aria-pressed="${l === lang}">${esc(langName(l))}</button>`).join('')}</div>` : '';
  const [kind, said] = receipt(r);
  // the voice note: the tab's language when Polly speaks it, else English; live needs an approved move (POST /voice)
  // (a draft shows the button, off, until approval; a "no answer" or "said no" has no note to play)
  const vl = VOICE_LANGS.has(lang) ? lang : r.messages.en ? 'en' : null, can = isMove(r) && ['approved', 'confirmed'].includes(r.status);
  const a = S.audio?.k === `${id}|${vl}` ? S.audio : null;
  const voice = !vl || (!can && r.status !== 'draft') ? '' : `<div class="vrow"><button class="btn sec" type="button" data-act="voice" data-id="${id}" data-lang="${vl}" data-k="voice"${can ? '' : ' disabled'}>
      ${icon(a?.state === 'playing' ? 'stop' : 'play')}${a?.state === 'loading' ? 'Loading the voice note…' : a?.state === 'playing' ? 'Stop' : vl === lang ? 'Play voice note' : 'Voice in English'}</button>
      ${!can ? '<span class="small">Plays once you approve.</span>' : ''}</div>${a?.state === 'error' ? `<p class="err" role="alert">${esc(a.err)}</p>` : ''}`;
  const once = k => seen.has(k) ? '' : (seen.add(k), ' fresh');  // the bubble rises in, and a new reply pops, once (not on every re-render)
  return `${head}${tabs}
    <div class="bubble${once(`b-${id}-${lang}`)}" lang="${lang}">${esc(msg)}</div>
    <p class="bmeta${kind ? ` ${kind}` : ''}${kind ? once(`rc-${id}-${said}`) : ''}">${kind === 'yes' || kind === 'told' ? icon('ck') : ''}${esc(said)}</p>
    ${r.status === 'no_answer' && call ? `<p class="vnone">Phone ${first}${call}.</p>` : voice}`;
}
// The clinic or hospital: the list Lumen sends it (simulated), one row per patient, the reply it is asked for, and where that stands.
function clinicView(id) {
  const f = S.fac[id], hosp = f?.kind === 'hospital', home = homeFac(), addr = S.raw[id]?.address || f?.address || '';
  const at = r => r.slot ? slotStart(r.slot) : Date.parse(r.affected_session) || 0;
  const list = rows().filter(r => r.clinic_id === id && r.status !== 'declined' && r.action === (hosp ? 'hospital' : 'transfer')).sort((a, b) => at(a) - at(b));
  const sent = list.filter(r => r.packet?.status === 'sent');
  const first = sent.map(r => r.packet?.sent_at).filter(Boolean).sort()[0], ok = sent.length && S.clinicOk.has(id);
  const status = sent.length ? `${first ? `Told ${time(first)}` : 'Told'} · ${ok ? (hosp ? 'Confirmed' : `Confirmed ${plural(sent.length, 'slot')}`) : 'Waiting to confirm'}`
    : S.tellOpts?.clinicsOff?.includes(id) ? 'Not told. You turned this clinic off.' : 'Not told yet. Approve and tell everyone sends this list.';
  const hbv = pid => { const d = S.people[pid]?.hbv_tested; return d ? `Hepatitis B test ${shortDate(d)}` : 'No hepatitis B test on file'; };
  const li = r => `<li><button class="cvp" type="button" data-act="patient" data-id="${r.patient_id}" data-k="cv-${r.patient_id}">
      <span class="cvn">${esc(pname(r.patient_id))}</span><span class="cvw num">${esc(r.slot ? slotText(r.slot) : `Usual treatment ${dayTime(r.affected_session)}`)}</span>
      <span class="cvd">${esc([rideWord(r), hbv(r.patient_id), S.langs[r.patient_id] || 'English'].join(' · '))}</span>${icon('chev')}</button></li>`;
  return `<h2 class="lead" id="panelH" tabindex="-1">What ${esc(cname(id))} gets</h2>
    <div class="sheet">
      <dl class="tf"><dt>To</dt><dd>${esc(f?.name || id)}${addr ? `<span>${esc(addr)}</span>` : ''}</dd>
        <dt>From</dt><dd>${esc(home?.name || '')}<span class="num">Callback ${CALLBACK}</span></dd></dl>
      <p class="arr">${plural(list.length, 'patient')} ${hosp ? 'may arrive' : 'arriving'}</p>
      <ul class="cv">${list.map(li).join('')}</ul>
      <p class="reply">${hosp ? 'Reply YES if you can take them.' : 'Reply YES to confirm these slots.'}</p>
    </div>
    <p class="cvs${ok ? ' ok' : sent.length ? ' wait' : ''}">${ok ? icon('ck') : ''}${esc(status)}</p>
    <p class="note">Simulated for the demo. Nothing leaves Lumen.</p>`;
}
// The voice note in the patient view: one at a time; a second press stops it.
async function playVoice(id, lang) {
  const k = `${id}|${lang}`;
  if (S.audio?.k === k && S.audio.state !== 'error') return stopVoice(true);
  stopVoice();
  const a = S.audio = { k, state: 'loading' };
  renderPanel();
  try {
    const { url, note } = await voiceFor(id, lang);
    if (S.audio !== a) return;
    if (!url) throw new ApiError(note || 'No voice note for this language.', 0);
    a.el = new Audio(url);
    a.el.onended = () => { if (S.audio === a) { S.audio = null; renderPanel(); } };
    await a.el.play();
    a.state = 'playing'; announce('Playing the voice note.');
  } catch (e) {
    if (S.audio !== a) return;
    a.el?.pause(); a.el = null; a.state = 'error'; a.err = e.name === 'NotAllowedError' ? 'The browser did not let the note play. Press Play again.' : e.message;
  }
  renderPanel();
}
function stopVoice(render) { S.audio?.el?.pause(); S.audio = null; if (render) renderPanel(); }
function changeWords(entries) {
  const f = Object.fromEntries(entries.map(e => [e.field, e])), out = [];
  if (f.status?.to === 'declined') return 'Said no · needs a phone call';  // the slot and the time are gone too; say it once
  const toStaff = f.action?.to === 'hospital';
  if (f.clinic_id) out.push(toStaff ? `Moved from ${cname(f.clinic_id.from)} to the phone call list` : `Moved from ${cname(f.clinic_id.from)} to ${cname(f.clinic_id.to)}`);
  if (f.action && !toStaff) out.push(`now ${ACTION[f.action.to] || f.action.to}`);
  if (f.slot && !toStaff) out.push(f.slot.to ? `new time ${slotText(f.slot.to)}` : 'no slot');
  else if (f.pickup_time?.to && !f.clinic_id) out.push('new leave time');
  if (!out.length) out.push(`Updated ${join(entries.map(e => FIELD[e.field] || e.field))}`);
  return cap(out.join(' · '));
}
const rideWord = r => RIDE[r.ride] || cap(String(r.ride || '').replace(/_/g, ' '));
/* ---------- the patient card (R5): one sentence, one leave line from the live road route, one reason line ---------- */
function summaryOf(r) {
  if (r.status === 'declined' && !r.slot) return 'Said no · needs a phone call';
  if (r.action === 'transfer') return `Moves to ${cname(r.clinic_id)} · ${slotText(r.slot)}`;
  if (r.action === 'early_session') return `Comes in early at ${cname(r.clinic_id)} · ${slotText(r.slot)}`;
  if (r.action === 'hospital') return 'Needs a phone call · no slot fits';
  return 'Keeps the usual time · gets a notice';
}
// "Leave home by 5:28 AM · 21 min drive · 15.1 mi": the plan's own time and drive minutes, the same ones the patient's message
// says; only the miles come from the road route.
function leaveLine(r) {
  if (!r.slot) return '';
  const rd = patientRoad(r);
  return `${leaveBy(r)} · ${r.drive_minutes} min drive${rd ? ` · ${rd.miles} mi` : ''}`;
}
const leaveBy = r => `${r.ride === 'paratransit' || r.ride === 'medical_van' ? 'Pickup by' : 'Leave home by'} ${time(r.pickup_time)}`;
// Up to three reasons in plain words; "treatment during the shutoff" only when it is the only one (every affected patient has it).
function whyWords(r) {
  const w = (r.reasons || []).map(k => REASON[k] || String(k).replace(/_/g, ' '));
  return (w.length > 1 ? w.filter(x => x !== REASON.session_in_window) : w).slice(0, 3).join(', ');
}
const whyLine = r => whyWords(r) ? `Why ${r.rank === 1 ? 'first' : `number ${r.rank}`}: ${whyWords(r)}` : '';
const gapOf = r => (r.flags || []).includes('long_gap_after');
// Message tabs: the patient's language first, then English.
const msgLangs = r => Object.keys(r.messages || {}).filter(l => l === 'en' || l === (S.lang[r.patient_id] || 'en')).sort((a, b) => (a === 'en') - (b === 'en'));
// A patient picked on the map or in the review list: the map shows only their road route.
function selectRow(id, fromMap) {
  if (S.route) { S.route = null; renderWhere(); }
  S.selected = id; S.listSel = false;
  M('selectPatient', id); M('isolate', { type: 'patient', id });
  showRoute(id, fromMap);  // their road route home -> destination; the map fits it
}

/* ---------- review and approve (E4): window.LumenReview, a pop-out over the whole screen ---------- */
const canReview = () => !!(window.LumenReview && S.plan && S.stage >= 4);
const WHAT = { early_session: r => `Comes in early at ${cname(r.clinic_id)}`, transfer: r => `Moves to ${cname(r.clinic_id)}`,
  hospital: () => 'Needs a phone call', notify_only: () => 'Gets a notice; the usual time stays' };
// View models for review.js: plain words only, no internal codes.
// flag: the row's most useful check issue (blocks, then call instead, then the rest; the every-row warnings last).
const flagRank = i => i.severity === 'block' ? 0 : CALL.has(i.code) ? 1 : EVERY_ROW.has(i.code) ? 3 : 2;
function viewRows() {
  const ck = checkIndex();
  return rows().map(r => {
    const id = r.patient_id, st = r.status, move = isMove(r), rd = patientRoad(r);
    const lang = S.lang[id] || 'en', hasMsg = Object.keys(r.messages || {}).length > 0;
    const messages = Object.fromEntries(msgLangs(r).map(l => [l, r.messages[l]]));
    const okd = st === 'approved' || st === 'confirmed', canVoice = move && okd && hasMsg;
    const issues = ck.of(r).filter(i => !EVERY_ROW.has(i.code)).sort((a, b) => flagRank(a) - flagRank(b)), top = issues[0], call = callThese(r, ck);
    return {
      note: r.note ? { status: r.note.status, sentAt: r.note.sent_at, sendAt: r.note.send_at } : null,
      flag: top ? { severity: top.severity, text: named(top.text), callInstead: CALL.has(top.code) } : null,
      callThese: call,
      // v5 approve and tell: group by destination; the voice note switch starts off for call-instead rows; a sent sheet is not sent again
      clinicId: r.clinic_id || null, callInstead: ck.call.has(id), sheetSent: r.packet?.status === 'sent',
      id, rank: r.rank, name: pname(id), lang, langName: S.langs[id] || langName(lang), action: r.action,
      what: (WHAT[r.action] || WHAT.notify_only)(r), where: r.clinic_id ? destName(r) : '',
      when: r.slot ? slotText(r.slot) : r.action === 'hospital' ? 'No slot fits' : '',
      pickup: r.slot ? `${rideWord(r)} · ${leaveBy(r)}` : rideWord(r),
      road: r.slot ? { minutes: r.drive_minutes, miles: rd?.miles ?? null, tooFar: r.drive_minutes > (S.rules.drive_cap_minutes ?? 40) } : null,
      summary: summaryOf(r), leave: leaveLine(r), why: whyLine(r), gap: gapOf(r),
      status: st, statusText: pillOf(r, call), changed: !!S.diff?.[id], changeText: S.diff?.[id] ? changeWords(S.diff[id]) : null,
      messages,
      msgLabels: Object.fromEntries(Object.keys(messages).map(l => [l, langName(l)])),
      canConfirm: move && st !== 'draft' && st !== 'confirmed',
      confirmHint: !move ? (r.action === 'hospital' ? 'Staff phone this patient' : 'Nothing to confirm: the usual time stays')
        : st === 'draft' ? 'Approve this row first' : st === 'confirmed' ? 'Already said yes' : '',
      canVoice,
      voiceHint: canVoice ? '' : !move ? 'Only moves get a voice note' : st === 'draft' ? 'Approve this row first'
          : !okd ? `${STATUS[st] || st}: no voice note` : 'This row has no message',
    };
  });
}
function openReview(opener) {
  if (!canReview() || S.running) return;
  S.opener = opener; S.ring = false;
  R('open', {
    title: 'Review and approve', rows: viewRows(), opener, successText: moveLine(S.plan),
    onApprove: ids => approve(ids),
    onApproveAndTell: o => approveAndTell(o),
    onDecline: id => editOrThrow(id, 'declined'),
    onConfirm: id => editOrThrow(id, 'confirmed'),
    onVoice: (id, lang) => voiceFor(id, lang),
    onSelect: id => { selectRow(id, false); S.listSel = true; },  // draws the road route; its time reaches the review through update()
  });
}
// After each write, and when a road route arrives, the review gets fresh rows (it keeps its filters, search, scroll and selection).
function syncReview() { if (canReview()) R('update', viewRows()); }

/* ---------- popovers, theme, drawers ---------- */
function openKey(msg) {
  $('#keyMsg').textContent = msg || ''; $('#keyMsg').hidden = !msg;
  $('#keyInput').value = store.get('lumenDemoKey') || '';
  const p = $('#keyPop');
  if (!p.matches(':popover-open')) p.showPopover();
  $('#keyInput').focus();
}
// save: the toggle's choice persists; the first visit only follows prefers-color-scheme (E7)
function setTheme(t, save = true) {
  document.documentElement.dataset.theme = t;
  if (save) store.set('lumenTheme', t);
  const dark = t === 'dark';
  $('#themeTog').innerHTML = `${icon(dark ? 'sun' : 'moon')}${dark ? 'Light theme' : 'Dark theme'}`;
  M('setTheme', t);
}
const isPhone = () => matchMedia('(max-width: 760px)').matches;
// Phone: the steps (top sheet) and the plan (bottom sheet) take turns, so the plan never hides the steps' controls.
function openRail(on) {
  $('#rail').classList.toggle('open', on);
  $('#railTog').setAttribute('aria-expanded', on);
  if (on && isPhone()) openPanel(false);
  requestAnimationFrame(() => M('resize'));
}
function openPanel(on) {
  if (!matchMedia('(max-width: 1180px)').matches && on) return;
  if (on && isPhone() && $('#rail').classList.contains('open')) openRail(false);
  $('#panel').classList.toggle('open', on);
  $('#planTog').setAttribute('aria-expanded', on);
  requestAnimationFrame(padMap);
}
// Map fits avoid what floats over the map: the legend (bottom left), the controls (right), an open drawer or bottom sheet.
let padKey = '';
function padMap() {
  const m = $('#main').getBoundingClientRect(), p = { top: 0, right: 0, bottom: 0, left: 0 };
  const over = el => { const r = el.getBoundingClientRect(); return r.width && r.left < m.right && r.right > m.left && r.top < m.bottom && r.bottom > m.top ? r : null; };
  const lg = over($('#legend')), ctl = over($('.ctl')), tl = over($('#timeline')), pn = $('#panel').classList.contains('open') && over($('#panel'));
  const tlPad = tl ? Math.round(m.bottom - tl.top) + 8 : 0;
  if (lg) {  // the legend pads the side that costs the map less area; the timeline already pads the bottom
    const w = Math.round(lg.right - m.left) + 8, h = Math.round(m.bottom - lg.top) + 8;
    if (w / m.width < (h - tlPad) / m.height) p.left = w; else p.bottom = h;
  }
  if (ctl) p.right = Math.round(m.right - ctl.left) + 8;
  p.bottom = Math.max(p.bottom, tlPad);
  if (pn) {  // a drawer or sheet that would leave under 160 px of map is left out, so fits still have room
    const sheet = pn.width >= m.width - 1, side = sheet ? 'bottom' : 'right';
    const v = Math.round(sheet ? m.bottom - pn.top : m.right - pn.left) + 8;
    if ((sheet ? m.height : m.width) - v >= 160) p[side] = Math.max(p[side], v);
  }
  const k = JSON.stringify(p);
  if (k !== padKey) { padKey = k; M('setPadding', p); }
}
// The legend, the controls and the map's own corner controls sit above the timeline bar.
function tlHeight() { const h = $('#timeline').offsetHeight; $('#main').style.setProperty('--tl-h', h ? `${h + 12}px` : '0px'); }

/* ---------- resizable rail and panel (E5): wide layout only ---------- */
const SIZES = { rail: { min: 280, max: 480, key: 'lumenRailW', v: '--rail-user', el: '#rail' }, panel: { min: 340, max: 640, key: 'lumenPanelW', v: '--panel-user', el: '#panel' } };
const MAP_MIN = 420, wide = matchMedia('(min-width: 1181px)');
// Clamps to the side's limits and to what leaves the map 420 px; returns the width it set.
function setWidth(side, w) {
  const o = SIZES[side], other = SIZES[side === 'rail' ? 'panel' : 'rail'];
  const max = Math.max(o.min, Math.min(o.max, $('.app').clientWidth - $(other.el).offsetWidth - MAP_MIN));
  w = Math.round(Math.max(o.min, Math.min(max, w)));
  $('.app').style.setProperty(o.v, `${w}px`);
  const sep = $(`.rsz[data-side="${side}"]`);
  sep.setAttribute('aria-valuemax', max); sep.setAttribute('aria-valuenow', w);
  M('resize');
  return w;
}
function resetWidth(side) {
  $('.app').style.removeProperty(SIZES[side].v); store.set(SIZES[side].key, '');
  $(`.rsz[data-side="${side}"]`).setAttribute('aria-valuenow', $(SIZES[side].el).offsetWidth);
  M('resize');
}
// Window resize: keep saved widths inside the limits, without saving the clamped value.
function fitWidths() {
  if (!wide.matches) return;
  for (const side of ['rail', 'panel']) {
    const saved = +store.get(SIZES[side].key);
    if (saved) setWidth(side, saved); else $(`.rsz[data-side="${side}"]`).setAttribute('aria-valuenow', $(SIZES[side].el).offsetWidth);
  }
}
function bindResize(sep) {
  const side = sep.dataset.side, o = SIZES[side], save = w => store.set(o.key, String(w));
  let raf = 0, x = 0, moved = false;
  sep.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); sep.setPointerCapture(e.pointerId); document.body.classList.add('resizing'); moved = false;
  });
  sep.addEventListener('pointermove', e => {
    if (!sep.hasPointerCapture(e.pointerId)) return;
    x = e.clientX; moved = true;
    raf ||= requestAnimationFrame(() => { raf = 0; const a = $('.app').getBoundingClientRect(); setWidth(side, side === 'rail' ? x - a.left : a.right - x); });
  });
  sep.addEventListener('lostpointercapture', () => { document.body.classList.remove('resizing'); if (moved) save(+sep.getAttribute('aria-valuenow')); });
  sep.addEventListener('keydown', e => {
    const step = e.shiftKey ? 64 : 16, dir = side === 'rail' ? 1 : -1, w = $(o.el).offsetWidth;  // the plan panel grows to the left
    const n = { ArrowRight: w + step * dir, ArrowLeft: w - step * dir, Home: o.min, End: o.max }[e.key];
    if (n == null) return;
    e.preventDefault(); save(setWidth(side, n));
  });
  sep.addEventListener('dblclick', () => resetWidth(side));
}

/* ---------- events ---------- */
function bind() {
  $('#run').addEventListener('click', () => runDemo());
  $('#resetGo').addEventListener('click', doReset);
  $('#runGo').addEventListener('click', () => { $('#runPop').hidePopover(); runDemo(1); });
  $('#region').addEventListener('change', e => setRegion(e.target.value));
  // the Demo menu: reset, demo key, theme
  $('#demoMenu').addEventListener('toggle', e => {
    $('#demoBtn').setAttribute('aria-expanded', String(e.newState === 'open'));
    if (e.newState === 'open') $('#demoMenu .mi:not(:disabled)')?.focus();
  });
  $('#themeTog').addEventListener('click', () => { $('#demoMenu').hidePopover(); setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); });
  $('#keyTog').addEventListener('click', () => { $('#demoMenu').hidePopover(); openKey(); });
  $('#keyShow').addEventListener('click', e => {
    const show = $('#keyInput').type === 'password';
    $('#keyInput').type = show ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-pressed', show);
    e.currentTarget.setAttribute('aria-label', show ? 'Hide the key' : 'Show the key');
  });
  $('#keyForm').addEventListener('submit', e => {
    e.preventDefault();
    store.set('lumenDemoKey', $('#keyInput').value.trim());
    $('#keyPop').hidePopover();
    if (S.region === 'santaclara') setRegion('santaclara'); else loadLive();  // with a key Santa Clara is live too
  });
  $('#bannerX').addEventListener('click', () => { $('#banner').hidden = true; });
  $('#homeBtn').addEventListener('click', () => M('focus', 'home'));
  $('#wholeBtn').addEventListener('click', () => { clearSel(); M('focus', 'flows', { all: true }); renderPanel(); });
  $('#animTog').addEventListener('click', e => {
    S.anim = !S.anim; M('setAnimation', S.anim);
    e.currentTarget.textContent = S.anim ? 'Pause animation' : 'Play animation';
  });
  $('#panel').addEventListener('transitionend', e => { if (e.target === e.currentTarget) padMap(); });
  const ro = new ResizeObserver(() => { tlHeight(); padMap(); });  // the legend, the controls and the timeline change size too
  for (const el of [$('#main'), $('#legend'), $('.ctl'), $('#timeline')]) ro.observe(el);
  document.querySelectorAll('.rsz').forEach(bindResize);
  addEventListener('resize', fitWidths);
  $('#planTog').addEventListener('click', () => openPanel(!$('#panel').classList.contains('open')));
  $('#railTog').addEventListener('click', () => openRail(!$('#rail').classList.contains('open')));
  // Esc closes the panel view first (bound before the map's own Esc, which then leaves the map as the view set it), then the drawer
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open], :popover-open')) return;
    if (S.view) { e.preventDefault(); closeView(); }
    else if ($('#panel').classList.contains('open')) { openPanel(false); $('#planTog').focus(); }
  });
  // R8: closing the review list after picking a row there shows every route again
  document.addEventListener('close', e => { if (S.listSel && e.target.matches?.('dialog.rv')) { clearSel(); planView(); renderPanel(); } }, true);
  $('#railBody').addEventListener('click', e => { const b = e.target.closest('[data-retry]'); if (b) S.phases[b.dataset.retry]?.retry?.(); });
  $('#chgBtn').addEventListener('click', () => openChange(true));
  $('#chgX').addEventListener('click', () => openChange(false));
  $('#replan').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); openChange(false); } });
  $('#pause').addEventListener('click', togglePause);
  $('#replan').addEventListener('submit', e => { e.preventDefault(); replan($('#instr').value); });
  $('#instr').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); replan($('#instr').value); } });
  $('#suggs').addEventListener('click', e => { const b = e.target.closest('.sugg'); if (!b || b.disabled) return; $('#instr').value = b.textContent; $('#instr').focus(); });
  $('#panel').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case 'clinic': openView({ type: 'clinic', id }, b); break;
      case 'patient': openView({ type: 'patient', id, back: S.view?.type === 'clinic' ? S.view : null }, b); break;
      case 'back': closeView(); break;
      case 'lang': S.msgLang[id] = b.dataset.lang; stopVoice(); renderPanel(); break;
      case 'voice': playVoice(id, b.dataset.lang); break;
      case 'review': openReview(b); break;
      case 'recheck': S.checkErr = null; retryCheck(); renderPanel(); break;
      case 'print': window.print(); break;
      case 'key': openKey(); break;
    }
  });
  $('#panel').addEventListener('animationend', e => { if (e.target.dataset.k === 'review-panel') S.ring = false; });  // pulses once per run
  $('#panel').addEventListener('toggle', e => { if (e.target.matches?.('details.more')) S.chMore = e.target.open; }, true);
}
// After the plan a patient or a receiving place picked on the map opens what it gets (v6); before it, the map only focuses.
const gets = id => S.stage >= 4 && S.plan?.patients.some(r => r.patient_id === id || (r.clinic_id === id && (r.action === 'transfer' || r.action === 'hospital')));
function onSelect(sel) {
  if (!sel) { S.view = null; stopVoice(); clearSel(); renderPanel(); return; }  // R8: the map's "Show all routes" chip or Esc
  if (sel.type === 'patient') gets(sel.id) ? openView({ type: 'patient', id: sel.id }) : selectRow(sel.id, true);
  else if (sel.type === 'route') isoRoute(sel.fromId, sel.toId);
  else if (sel.type === 'facility') gets(sel.id) && !S.affected?.closed_clinic_ids.includes(sel.id) ? openView({ type: 'clinic', id: sel.id }) : M('focus', { facility: sel.id });
}

async function boot() {
  bind();
  resetPhases();
  const motion = () => { $('#animTog').hidden = reduced.matches; };  // reduced motion already stops the animation
  motion(); reduced.addEventListener('change', motion);
  // v6: Santa Clara by default; the county chosen in the menu stays across reloads
  S.region = store.get('lumenRegion') === 'eldorado' ? 'eldorado' : 'santaclara';
  $('#region').value = S.region;
  S.B = live; S.clinics = S.region === 'eldorado' ? FALLBACK : []; indexFac();
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  setTheme(theme, false);
  fitWidths();
  renderAll();
  // init creates the map at once and resolves on its first load; the setters below queue until then
  const mapP = window.LumenMap ? Promise.resolve().then(() => LumenMap.init($('#map'), { theme, mapKey: CFG.mapKey || '', onSelect })) : Promise.reject(new Error('map.js missing'));
  mapP.catch(e => { console.warn('LumenMap.init', e); banner('The map did not load. The plan still works.'); });
  M('set3D', true);  // first view: tilted 50 degrees over the home clinic
  await setRegion(S.region);  // the region's map data, then the live plan (or the no-key replay)
}
boot();
})();
