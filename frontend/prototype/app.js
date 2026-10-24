/* Lumen app screen: API client, the guided run (scenes), rail, plan panel and controls.
   Calls window.LumenMap (map.js), LumenTour (tour.js), LumenReview (review.js) and LumenTimeline (timeline.js).
   Contracts: contracts/api.md, CONTRACT-v2 (E1-E10), CONTRACT-v3 (R1-R7). */
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

// data/seed/notice.txt, verbatim
const NOTICE = "PG&E PUBLIC SAFETY POWER SHUTOFF (PSPS) WARNING\nEvent ID: PSPS-DEMO-01\nIssued: Monday, October 26, 2026, 8:30 AM PDT\n\nThis alert goes to customers and critical facilities served by PG&E in the area below. Forecast high winds and very dry conditions may require PG&E to turn off power to your area to reduce the risk of wildfire.\n\nArea: Cameron Park, Shingle Springs and Placerville (El Dorado County)\n\nEstimated power shutoff: Tuesday, October 27, 2026, 6:00 PM PDT\nEstimated power restoration: Thursday, October 29, 2026, 12:00 PM PDT\n\nRestoration times are estimates. After the weather passes, crews inspect the lines before power comes back.\n\nIf you use power for medical equipment, make a backup plan now. Charge devices and keep a list of emergency contacts.\n\nQuestions: call 555-0199. For a medical emergency, call 911.\n\n(Simulated notice for the Lumen demo. Not issued by PG&E.)\n";
const SUGGEST_LIVE = 'DaVita Folsom can only take 4 more';
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

const PHASES = ['Read the PG&E notice', 'Find who is affected', 'Put the most urgent first', 'Find open chairs',
  'Write patient messages', 'Approve the plan', 'Send voice notes'];
const ACTION = {
  early_session: { label: 'Come in early', cls: 'e' }, transfer: { label: 'Move', cls: 'tr' },
  hospital: { label: 'Staff call', cls: 'sc' }, notify_only: { label: 'Notice only', cls: 'n' },
};
// Reasons in plain words, for "Why first: no car, lives alone" (R5)
const REASON = {
  session_in_window: 'treatment during the shutoff', session_within_36h: 'treatment within 36 hours', heart_failure: 'heart failure',
  missed_recently: 'missed a treatment recently', paratransit: 'rides paratransit', home_in_outage: 'home loses power', no_car: 'no car',
  lives_alone: 'lives alone', wheelchair: 'uses a wheelchair', limited_english: 'limited English',
};
const RIDE = { self: 'Drives self', family: 'Family drives', paratransit: 'Paratransit', medical_van: 'Medical van', taxi: 'Taxi', transit: 'Public transit' };
const STATUS = { draft: 'Draft', approved: 'Approved', confirmed: 'Confirmed', declined: 'Declined', no_answer: 'No answer' };
const FIELD = { action: 'action', clinic_id: 'clinic', slot: 'session time', drive_minutes: 'drive time', drive_source: 'drive source',
  pickup_time: 'pickup time', book_today: 'ride booking', flags: 'flags', status: 'status', pinned: 'pin' };
const FILTERS = {
  all: () => true, early: r => r.action === 'early_session', transfer: r => r.action === 'transfer',
  staff: r => r.action === 'hospital', changed: r => !!S.diff?.[r.patient_id],
};
const SHIFT = { 1: [6, 0], 2: [10, 30], 3: [15, 0], 4: [19, 30] };

const S = {
  region: 'eldorado', data: {}, B: null, tour: null,
  clinics: FALLBACK, raw: {}, fac: {}, names: {}, homes: {}, langs: {}, rules: {},
  outage: null, event: null, affected: null, plan: null, stage: 0,
  phases: [], running: false, directing: false, paused: false, notice: false,
  diff: null, expanded: null, selected: null, filter: 'all',
  msgLang: {}, audio: {}, rowErr: {}, busy: {}, approving: false, gen: 0, anim: true,
  lang: {}, road: {}, roadFail: false, speak: {}, msgOpen: {}, opener: null, landed: null,
};
const isTour = () => S.region === 'santaclara';
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
const cname = id => id ? short(S.fac[id]?.name || id) : 'no chair';
const pname = id => S.names[id] || id;
const win = () => S.event ? `${dt(S.event.start)} to ${dt(S.event.end)}` : '';
const places = () => String(S.event?.area_name || '').replace(/\s*\(.*\)\s*$/, '').split(/,\s*|\s+and\s+/).filter(Boolean);
const noticeTag = () => isTour() ? 'Simulated outage' : 'Simulated PG&E notice';
const nowMs = () => S.affected?.now ? Date.parse(S.affected.now) : Date.parse(S.event.issued_at) + 30 * 60e3;  // the demo clock: issued + 30 min, as the backend
function countdown() {
  if (!S.event) return '';
  const min = Math.max(0, Math.round((Date.parse(S.event.start) - nowMs()) / 60e3));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h`;
}
const rows = () => S.plan ? [...S.plan.patients].sort((a, b) => a.rank - b.rank) : [];
function counts(p) { const c = { early_session: 0, transfer: 0, hospital: 0, notify_only: 0 }; for (const r of p.patients) c[r.action]++; return c; }
// "28 move · 8 come in early · 4 need a call" (zero parts left out)
function moveLine(p) {
  const c = counts(p);
  return [c.transfer && `${c.transfer} move`, c.early_session && `${c.early_session} come in early`,
    c.hospital && `${c.hospital} need${c.hospital === 1 ? 's' : ''} a call`, c.notify_only && `${c.notify_only} get a notice`].filter(Boolean).join(' · ');
}
const homeFac = () => S.clinics.find(c => c.home);

/* ---------- backends: live API and the in-page tour ---------- */
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
// ?session= gives this tab its own run on the API, so another viewer's Reset or run never deletes this tab's plan.
const SESSION = (() => { const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20); try { return sessionStorage.lumenSession ||= id(); } catch { return id(); } })();
const live = {
  async call(method, path, body) {
    const key = store.get('lumenDemoKey') || '', headers = {};
    if (key) headers['x-demo-key'] = key;
    if (body) headers['content-type'] = 'application/json';
    let res;
    try { res = await fetch(String(CFG.api || '').replace(/\/+$/, '') + path + '?session=' + SESSION, { method, headers, body: body && JSON.stringify(body) }); }
    catch { throw new ApiError('Lumen could not reach the API. Check the connection and retry.', 0); }
    const data = await res.json().catch(() => null);
    if (res.status === 401) { openKey('That demo key did not work.'); throw new ApiError('That demo key did not work.', 401); }
    if (!res.ok) throw new ApiError(data?.error || `The API answered ${res.status}. Retry the step.`, res.status);
    return data;
  },
  state: () => live.call('GET', '/state'),
  alert: () => live.call('POST', '/alert', { notice_text: NOTICE }),
  plan: id => live.call('POST', '/plan', { event_id: id }),
  approve: b => live.call('POST', '/approve', b),
  voice: b => live.call('POST', '/voice', b),
  replan: b => live.call('POST', '/replan', b),
  reset: () => live.call('POST', '/reset', {}),
  speak: b => live.call('POST', '/speak', b),  // the tour uses it too: Polly (and Translate without `translated`), same demo key
};
function tourBackend(data) {
  let t = LumenTour.build(data), event = null, plan = null;
  const wait = () => new Promise(r => setTimeout(r, 600 + Math.round(Math.random() * 300)));  // so the rail is watchable
  const run = async fn => { await wait(); try { return fn(); } catch (e) { throw new ApiError(e.message, 400); } };
  return {
    get tour() { return t; },
    state: async () => ({ patients: t.patients, outage_area: t.outage, event, affected: plan ? t.affected : null, plan }),
    alert: () => run(() => { t = LumenTour.build(data); plan = null; return (event = structuredClone(t.event)); }),  // a new run starts from v1
    plan: () => run(() => (plan = t.plan)),
    approve: b => run(() => (plan = t.approve(b.patient_ids[0] === 'all' ? 'all' : b.patient_ids, b.edits))),
    voice: async () => { throw new ApiError('Voice notes need the live region.', 409); },
    replan: b => run(() => { const r = t.replan(b.instruction); plan = r.plan; return r; }),
    reset: async () => { t = LumenTour.build(data); event = plan = null; return { ok: true }; },
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
    renderList(); syncReview();
  }
  const rd = patientRoad(r);
  M('showPatientRoute', { id, home, to: pt(f), line: rd?.line || null, minutes: r.drive_minutes ?? null, miles: rd?.miles ?? null,
    label: `${pname(id)} → ${destName(r)}${r.drive_minutes != null ? ` · ${r.drive_minutes} min` : ''}${rd ? ` · ${rd.miles} mi` : ''}`, note: NO_ROAD });
}
// R8: one path at a time. Clearing shows every route again and closes the open row.
function clearSel() { S.selected = S.expanded = S.route = null; S.listSel = false; M('selectPatient', null); M('showPatientRoute', null); M('isolate', null); }
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
    const base = p.action === 'hospital' ? plural(p.count, 'staff call') : `+${p.count}`;
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

/* ---------- chairs (R3): open chairs in the shutoff window and the chairs this plan uses ---------- */
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
// The newest "(clinic) can only take N more" re-plan caps that clinic at N (a later re-plan starts again from the seed counts).
function replanCap() {
  const a = (S.plan?.audit || []).filter(x => /^re-plan/i.test(x.change)).at(-1);
  const m = a && /:\s*(.+?)\s+can only take (\d+|\w+) more/i.exec(a.change);
  const n = m && (/^\d+$/.test(m[2]) ? +m[2] : NUM[m[2].toLowerCase()]);
  const f = n != null && S.clinics.find(c => c.kind === 'dialysis' && c.name.toLowerCase().includes(m[1].trim().toLowerCase()));
  return f ? { id: f.id, n } : null;
}
function openLive() {
  const out = {}, t0 = nowMs(), t1 = Date.parse(S.event.end), cut = replanCap();
  for (const c of Object.values(S.raw)) {
    if (c.kind !== 'dialysis' || c.accepts_visiting === false) continue;
    out[c.id] = (c.slots || []).filter(s => { const t = slotStart(s); return t > t0 && t < t1; }).reduce((n, s) => n + (s.open_chairs || 0), 0);
  }
  if (cut && cut.id in out) out[cut.id] = Math.min(out[cut.id], cut.n);
  return out;
}
const openNow = () => isTour() ? Object.fromEntries(Object.entries(S.B.tour?.capacity || {}).map(([id, c]) => [id, c.open])) : openLive();
// For LumenMap.setCapacity: receiving clinics {open, used, full, n: the plan's total} (the map writes "16 of 18 chairs" or "Full"),
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
// Facilities a closed clinic's patients can go to: open dialysis clinics, then the hospital.
function cands() {
  const closed = new Set(S.affected?.closed_clinic_ids || []), open = openNow();
  return S.clinics.filter(f => f.kind === 'hospital' || (!closed.has(f.id) && open[f.id] != null));
}
const crow = (a, b) => Math.hypot((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]);
// LumenMap.searchGraph visits from one closed clinic: road time order once every road route is in, else straight-line order.
function visitsFrom(src, pr) {
  const a = pt(S.fac[src]), open = openNow();
  const near = list => {
    const rd = list.map(f => roadNow(a, pt(f))), road = rd.every(Boolean);
    return list.map((f, i) => [f, road ? rd[i].minutes : crow(a, pt(f))]).sort((x, y) => x[1] - y[1]).map(x => x[0]);
  };
  const c = cands();
  return [...near(c.filter(f => f.kind !== 'hospital')), ...near(c.filter(f => f.kind === 'hospital'))].map(f => {
    const used = pr.filter(p => p.fromId === src && p.toId === f.id).reduce((n, p) => n + p.count, 0);
    return { id: f.id, open: f.kind === 'hospital' ? null : open[f.id], used, accepted: used > 0 };
  });
}

/* ---------- rail ---------- */
const ST_WORD = { pending: '', running: 'Running', waiting: 'Waiting for you', error: 'Failed' };
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
function renderRail() {
  const ol = $('#phases');
  keepFocus(() => keepScroll(ol, () => { ol.innerHTML = S.phases.map((p, i) => {
    const cur = ['running', 'waiting', 'error'].includes(p.status);
    return `<li class="ph ${p.status}"${cur ? ' aria-current="step"' : ''}>
      <span class="d" aria-hidden="true">${p.status === 'done' ? icon('ck') : p.status === 'error' ? icon('x') : ''}</span>
      <div>
        <div class="ph-h"><span class="nm">${esc(p.name)}</span><span class="st">${p.status === 'done' ? '<span class="vh">Done</span>' : p.status === 'pending' ? '<span class="vh">Not started</span>' : esc(ST_WORD[p.status])}</span></div>
        ${p.res ? `<p class="res">${esc(p.res)}</p>` : ''}
        ${p.err ? `<p class="err">${esc(p.err)}</p>${p.retry ? `<button class="btn retry" type="button" data-retry="${i}" data-k="retry-${i}">Retry</button>` : ''}` : ''}
        ${i === 5 && p.status === 'waiting' && canReview() ? '<button class="btn retry" type="button" data-review data-k="rv-rail">Review and approve</button>' : ''}
      </div></li>`;
  }).join(''); }), '#railH');
  $('#railSub').textContent = railSub();
  $('#pause').hidden = !S.directing;
  $('#pause').textContent = S.paused ? 'Resume' : 'Pause';
  // follow the newest event: a running or failed step, else the newest Re-plan step, else the step waiting for you
  const act = ol.querySelector('.ph.running, .ph.error') || (S.phases.length > PHASES.length ? ol.lastElementChild : ol.querySelector('[aria-current]'));
  if (act) railScroll(act);
  // re-plan box
  const ok = S.stage >= 4 && !S.running;
  for (const el of [$('#instr'), $('#sugg'), $('#send')]) setDisabled(el, !ok);
  $('#sugg').textContent = isTour() ? (S.tour?.suggestion || '').replace(/ four more$/, ' 4 more') : SUGGEST_LIVE;
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
function railSub() {
  const n = PHASES.length;
  let k = S.phases.findIndex(p => p.status === 'running' || p.status === 'error');
  if (k < 0 && S.directing) k = S.phases.map(p => p.status).lastIndexOf('done');  // a hold between two steps of the run: the step just shown
  if (k >= 0) {
    const p = S.phases[k];
    return `${S.paused ? 'Paused · ' : ''}${k < n ? `Step ${k + 1} of ${n} · ` : ''}${p.name}${p.status === 'error' ? ' · failed' : ''}`;
  }
  const w = S.phases.find(p => p.status === 'waiting');
  if (w) return `Waiting for you · ${w.name}`;
  if (S.phases.every(p => p.status === 'done')) return 'Done';
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
function voiceWaiting() {
  if (S.phases[6].status === 'done') return;
  setPhase(6, { status: 'waiting', res: isTour() ? 'Open a patient, then play the voice note' : 'Confirm a patient, then play the voice note' });
}
function approveWaiting(n) {
  setPhase(5, { status: 'waiting', res: n < S.plan.patients.length ? `${plural(n, 'patient')} still to approve` : 'Nothing is sent until you approve' });
}
function restorePhases() {
  resetPhases();
  if (S.event) setPhase(0, { status: 'done', res: noticeLine() });
  if (!S.plan) return;
  planPhases(S.plan).forEach((o, k) => setPhase(k + 1, { status: 'done', ...o }));
  const drafts = S.plan.patients.filter(r => r.status === 'draft').length;
  if (!drafts) setPhase(5, { status: 'done', res: 'Every patient is approved' });
  else approveWaiting(drafts);
  if (S.plan.patients.some(r => Object.keys(r.audio || {}).length)) setPhase(6, { status: 'done', res: 'A voice note exists for this plan' });
  else if (!drafts) voiceWaiting();
  const re = (S.plan.audit || []).filter(a => /^re-plan/i.test(a.change));
  re.forEach((a, k) => S.phases.push({ name: `Change: ${a.change.replace(/^re-plan:\s*/i, '')}`, status: 'done', res: k === re.length - 1 ? S.plan.summary || '' : '' }));
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
  restorePhases();
  mapStage(S.plan ? 4 : S.event ? 1 : 0);
  M('focus', S.stage >= 4 ? 'flows' : S.stage ? 'outage' : 'home');
  renderAll();
  if (S.event) TL('set', sceneTime());
  if (S.stage >= 4) drawRoutes();
  syncReview();
}
function indexFac() { S.fac = Object.fromEntries(S.clinics.map(c => [c.id, c])); }
function setPeople(list) {
  S.names = {}; S.homes = {}; S.langs = {}; S.lang = {};
  for (const p of list || []) {
    S.names[p.id] = p.name || p.id;
    S.homes[p.id] = p.home ? [p.home.lng, p.home.lat] : [p.lng, p.lat];
    S.langs[p.id] = p.language_name || (p.language ? langName(p.language) : '');
    S.lang[p.id] = p.language || 'en';
  }
}
async function loadLive(g = S.gen) {
  if (isTour()) return;
  if (!hasKey()) return renderAll();
  try { const st = await live.state(); if (g === S.gen && !isTour()) applyState(st); }  // drop answers from before a region switch
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
  if (!isTour() && !hasKey()) return openKey('Add the demo key to run the live demo.');
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
}
// Scene 1, "Notice received" (Mon 9:00 AM): POST /alert, then the notice card slides in over the map.
async function sceneNotice() {
  S.event = S.plan = S.affected = S.diff = null; S.expanded = null; S.audio = {}; S.speak = {}; S.rowErr = {};
  resetPhases(); mapStage(0); clearSel(); R('close'); M('setScene', null); $('#panel').scrollTo({ top: 0, behavior: 'instant' });
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
  // routes the plan uses trace along the roads while each clinic's chairs count up
  setPhase(3, { status: 'running', res: 'Each patient gets the nearest clinic with a free chair at their time.' });
  caption('Searching nearby clinics, nearest first');
  S.landed = {};  // every count starts at 0
  mapStage(4); renderAll();
  if (window.LumenMap?.searchGraph) {
    const n = closed.length * cands().length, perNode = isTour() ? Math.min(350, Math.floor(10000 / Math.max(1, n))) : 700;  // the tour visits ~88 nodes: about 10 s
    for (const id of closed) await Promise.resolve(M('searchGraph', { sourceId: id, visits: visitsFrom(id, pr), perNode }));
  } else { M('focus', 'flows', { duration: 1050 }); await beat(2650); }
  if (!ready) { setPhase(3, { status: 'running', res: 'Finding road routes…' }); caption('Finding road routes…'); renderRail(); }
  const list = await listP;
  caption('Routes to clinics with open chairs');
  homeRoutes();
  const land = it => { S.landed[it.toId] = (S.landed[it.toId] || 0) + it.count; M('setCapacity', capacity()); renderChairs(); };
  // about 10 s of tracing at most: the live plan has a handful of routes 600 ms apart, the tour about 70
  const stagger = Math.min(600, Math.round(10000 / Math.max(1, list.length - 1))), span = reduced.matches ? 0 : stagger * Math.max(0, list.length - 1) + 1600;
  await Promise.all([Promise.resolve(M('traceRoutes', list, { stagger, duration: 1600, onArrive: land })), tlPlay(funnelAt(), span, span)]);
  S.landed = null;
  M('setCapacity', capacity());
  done(3, res[2]); renderAll();
  await beat(3500);
  // 5 "Messages"
  setPhase(4, { status: 'running', res: 'Writing patient messages' }); caption('Writing patient messages'); renderRail();
  await beat(2500);
  done(4, res[3]);
  // 6 "Approve": the approval list opens (runDemo); nothing is sent until staff approve
  approveWaiting(plan.patients.filter(r => r.status === 'draft').length);
  caption('Waiting for your approval');
  announce('Approve the plan is waiting for you. Nothing is sent until you approve.');
  renderRail();
}
// ids: 'all' (the panel's Approve all) or a list of patient ids (the review's Approve selected). Rejects on failure.
async function approve(ids) {
  if (S.approving || S.running || !S.plan) throw new ApiError('Another change is still saving. Try again in a moment.', 0);
  const all = ids === 'all';
  S.approving = true;
  setPhase(5, { status: 'running', res: all ? 'Approving every patient' : `Approving ${plural(ids.length, 'patient')}` });
  renderRail(); renderPanel();
  let err = null;
  try {
    S.plan = await S.B.approve({ event_id: S.event.event_id, patient_ids: all ? ['all'] : ids, edits: [] });
    const left = S.plan.patients.filter(r => r.status === 'draft').length;
    if (left) approveWaiting(left);
    else { done(5, { res: 'Every patient is approved' }); voiceWaiting(); TL('setMode', 'replay'); caption(''); }
  } catch (e) { err = e; fail(5, e, () => approve(ids).catch(() => {})); }
  S.approving = false;
  renderRail(); renderPanel(); syncReview();
  if (err) throw err;
}
async function edit(id, status) {
  if (S.running || S.busy[id]) return;
  S.busy[id] = true; S.rowErr[id] = null; renderList();
  try {
    S.plan = await S.B.approve({ event_id: S.event.event_id, patient_ids: [], edits: [{ patient_id: id, status }] });
    announce(`${pname(id)}: ${STATUS[status].toLowerCase()}.`);
  } catch (e) { S.rowErr[id] = e.message; if (e.status !== 401) banner(e.message); }
  S.busy[id] = false;
  renderPanel(); renderRail(); syncReview();
}
// The review panel wants a promise that rejects with the reason the write failed.
const editOrThrow = (id, status) => edit(id, status).then(() => { if (S.rowErr[id]) throw new ApiError(S.rowErr[id], 0); });
// Voice for the review panel: live = the Polly voice note (POST /voice), tour = translate and play (POST /speak).
async function voiceFor(id, lang) {
  if (isTour()) return speak(id, lang);
  const first = S.phases[6].status !== 'done';
  if (first) { setPhase(6, { status: 'running', res: `Making a voice note for ${pname(id)}` }); renderRail(); }
  try {
    const { url } = await S.B.voice({ event_id: S.event.event_id, patient_id: id, lang });
    S.audio[id] = url;
    if (first) done(6, { res: `Voice note in ${langName(lang)} for ${pname(id)}` });
    renderRail(); renderList();
    return { url };
  } catch (e) { if (first) fail(6, e, null); throw e; }
}
// E10: POST /speak. Text already in `lang` (English, or a tour template translation written ahead of time) goes with
// translated: true, so Polly reads it as given. Other languages need Amazon Translate first, which this AWS account may block.
const noVoice = lang => `No voice for ${langName(lang)}. Staff read this message aloud.`;
async function speak(id, lang) {
  const r = S.plan?.patients.find(x => x.patient_id === id), own = r?.messages?.[lang], en = r?.messages?.en;
  if (!own && !en) throw new ApiError('This row has no message to read.', 0);
  if (!hasKey()) { openKey('Add the demo key to play voice notes.'); throw new ApiError('Add the demo key to play voice notes.', 401); }
  const k = `${id}|${lang}`;
  if (!S.speak[k]) {
    let res;
    try { res = await live.speak(own ? { text: own.slice(0, 600), lang, translated: true } : { text: en.slice(0, 600), lang }); }
    catch (e) { throw /translate not permitted/i.test(e.message) ? new ApiError('Translation is not turned on for this AWS account.', e.status) : e; }
    S.speak[k] = { url: res.url || null, voice: res.voice || null, machine: !own, text: own ? null : res.text || null, note: res.url ? null : noVoice(lang) };
    if (res.url && S.phases[6].status !== 'done') {
      done(6, { res: `Voice note in ${langName(lang)} for ${pname(id)}` });
      renderRail();
    }
  }
  const sp = S.speak[k];
  return { url: sp.url || undefined, text: sp.text || undefined, note: sp.note || undefined };
}
// The panel's voice button on tour rows: Play voice note, or Translate and play when the row has no template.
async function speakRow(id) {
  if (S.busy[id]) return;
  S.busy[id] = true; S.rowErr[id] = null; renderList();
  try { await speak(id, S.lang[id] || 'en'); } catch (e) { S.rowErr[id] = e.message; }
  S.busy[id] = false; renderList();
  $(`#pts audio[data-id="${id}"]`)?.play().catch(() => { /* the controls stay; press play */ });
}
async function voice(id) {
  if (S.running || S.busy[id]) return;
  const lang = $(`[data-k="vl-${id}"]`)?.value || 'en';
  S.busy[id] = true; S.rowErr[id] = null; renderList();
  const first = S.phases[6].status !== 'done';
  if (first) { setPhase(6, { status: 'running', res: `Making a voice note for ${pname(id)}` }); renderRail(); }
  try {
    const { url } = await S.B.voice({ event_id: S.event.event_id, patient_id: id, lang });
    S.audio[id] = url; S.busy[id] = false; renderList();
    const a = $(`audio[data-id="${id}"]`);
    if (!a) { if (first) { setPhase(6, { status: 'waiting', res: 'Press play on the voice note' }); renderRail(); } return; }
    a.addEventListener('playing', () => {
      if (S.phases[6].status === 'done') return;
      done(6, { res: `Voice note in ${langName(lang)} for ${pname(id)}` }); renderRail();
    }, { once: true });
    a.addEventListener('error', () => { S.rowErr[id] = 'The voice note did not load. Play it again to retry.'; renderList(); }, { once: true });
    a.play().catch(() => { if (first) { setPhase(6, { status: 'waiting', res: 'Press play on the voice note' }); renderRail(); } });
  } catch (e) {
    S.busy[id] = false; S.rowErr[id] = e.message;
    if (first) fail(6, e, () => voice(id)); else if (e.status !== 401) banner(e.message);
    renderList();
  }
}
async function replan(instruction) {
  instruction = instruction.trim();
  if (!instruction || !S.plan || S.running || S.approving || Object.values(S.busy).some(Boolean)) return;
  const ph = { name: `Change: ${instruction}`, status: 'running', res: 'Changing the plan' };
  const at = () => S.phases.indexOf(ph);  // hold the step, not its index: a Retry can remove an earlier one
  S.phases.push(ph);
  setRunning(true); renderPanel();
  try {
    const before = positions();
    const r = await S.B.replan({ event_id: S.event.event_id, instruction });
    S.plan = r.plan;
    S.diff = r.diff.reduce((m, d) => ((m[d.patient_id] ||= []).push(d), m), {});
    const n = Object.keys(S.diff).length;
    done(at(), { res: r.summary || r.plan.summary || `${plural(n, 'patient')} changed` });
    S.phases[3].res = moveLine(r.plan);  // Find open chairs shows the plan as it is now
    if (r.plan.patients.some(x => x.status === 'draft')) {
      setPhase(5, { status: 'waiting', res: `${plural(n, 'patient')} changed · approve them` });
      if (S.phases[6].status !== 'done') setPhase(6, { status: 'pending', res: '' });  // one step waits at a time
    }
    $('#instr').value = '';
    S.running = false; S.expanded = null; clearSel();
    renderPanel(); flip(before);
    facStatus(); mapPatients(); mapFlows(); M('setCapacity', capacity()); M('focus', 'flows');
    drawRoutes();  // any new pair is computed live
    $('#pts > .pt.chg')?.scrollIntoView({ block: 'nearest', behavior: reduced.matches ? 'auto' : 'smooth' });
    announce(`${plural(n, 'patient')} changed.`);
  } catch (e) { fail(at(), e, () => { if (S.running) return; S.phases.splice(at(), 1); replan(instruction); }); }
  setRunning(false);
}
function ack() { S.diff = null; if (S.filter === 'changed') S.filter = 'all'; renderPanel(); mapFlows(); }
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
  Object.assign(S, { event: null, affected: null, plan: null, diff: null, expanded: null, filter: 'all',
    audio: {}, speak: {}, rowErr: {}, busy: {}, msgLang: {}, msgOpen: {}, roadFail: false, landed: null });
  resetPhases(); mapStage(0); clearSel(); R('close'); showNotice(false); TL('setMode', 'replay'); S.ring = false;
  M('setScene', null);  // the map goes back to the real power state
  $('#banner').hidden = true; $('#panel').scrollTo({ top: 0, behavior: 'instant' });
}
async function setRegion(region) {
  const g = ++S.gen;
  S.region = region;
  clearRun();
  try { S.data[region] ||= await (await fetch(`data/${region}.json`)).json(); }
  catch { banner('The map data did not load. Reload the page.'); }
  if (g !== S.gen) return;  // the user switched again while this loaded
  if (isTour()) {
    if (!window.LumenTour) { banner('The tour did not load. Reload the page.'); return renderAll(); }
    S.B = tourBackend(S.data[region]);
    const t = S.tour = S.B.tour;
    S.clinics = t.facilities; S.raw = {}; S.rules = {}; setPeople(t.patients); S.outage = t.outage;  // tour rules: the defaults (40 min cap, 15 min buffer)
  } else {
    S.B = live; S.tour = null; S.clinics = FALLBACK; S.raw = {}; setPeople([]); S.outage = null;
  }
  indexFac();
  M('setRegion', S.data[region], S.clinics);  // regionData carries the county outline when the data has one (E9)
  mapStage(0); M('focus', 'home');
  renderAll();
  if (!isTour()) await loadLive(g);
}

/* ---------- top bar ---------- */
function renderTop() {
  const h = homeFac();
  $('#homeName').textContent = h ? h.name : '';
  $('#tourTag').hidden = !isTour();
  $('#chip').classList.toggle('on', !!S.event);
  $('#chipT').textContent = S.event ? `Power off in ${countdown()} · ${isTour() ? 'Simulated outage' : 'Simulated notice'}` : 'No shutoff notice';
  for (const id of ['run', 'reset', 'region']) setDisabled($('#' + id), S.running);
  $('#wholeBtn').hidden = S.stage < 4 || !S.plan;
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

/* ---------- outage timeline (E8): LumenTimeline in a bar at the bottom of the map ---------- */
let tlKey = '';  // the event the timeline is mounted for
const funnelAt = () => { const a = Date.parse(S.event.start); return new Date(a + 0.12 * (Date.parse(S.event.end) - a)).toISOString(); };  // funnel is full after ~10% of the off window
const sceneTime = () => S.stage >= 4 ? funnelAt() : S.stage >= 2 ? S.event.start : new Date(nowMs()).toISOString();
function syncTimeline() {
  const ev = S.event, k = ev ? `${S.region}|${ev.event_id}|${ev.issued_at}|${ev.start}|${ev.end}` : '';
  if (k === tlKey || !window.LumenTimeline) return;
  if (tlKey) { TL('destroy'); M('setScene', null); }  // the map goes back to the real power state
  tlKey = k;
  if (!ev) return;
  TL('mount', $('#timeline'), {
    stops: [{ t: ev.issued_at, label: 'Notice' }, { t: ev.start, label: 'Power off' }, { t: ev.end, label: 'Power back' }],
    label: isTour() ? 'Simulated outage' : 'Simulated timeline',
    onChange: st => M('setScene', { power: st.power, funnel: st.funnel }),
  });
  TL('set', sceneTime());
}
// Plays the timeline to `to`; without a timeline it just waits `wait` ms.
const tlPlay = (to, ms, wait = 0) => tlKey ? Promise.resolve(TL('play', { to, ms })).catch(() => {}) : sleep(wait);

/* ---------- right panel ---------- */
// Re-rendering replaces the focused control: focus its new copy, else its row, else the fallback.
function keepFocus(fn, fallback = '#filter') {
  const a = document.activeElement, k = a?.dataset?.k, row = a?.closest?.('.pt')?.dataset.id;
  fn();
  if (!k) return;
  if (a.isConnected) { if (document.activeElement !== a) a.focus({ preventScroll: true }); return; }  // a node put back (keepOpener) lost focus
  const el = $(`[data-k="${k}"]`);
  (el && !el.disabled ? el : (row && $(`[data-k="row-${row}"]`)) || $(fallback))?.focus({ preventScroll: true });
}
// Re-rendering the list would stop a playing voice note: move the same <audio> into the new markup.
function keepAudio(fn) {
  const old = $('#pts audio');
  fn();
  const n = old && $(`#pts audio[data-id="${old.dataset.id}"]`);
  if (n && n.getAttribute('src') === old.getAttribute('src')) n.replaceWith(old);
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
  const el = $('#panel');
  keepFocus(() => keepScroll(el, () => keepAudio(() => {
    el.innerHTML = S.stage >= 4 && S.plan ? planHTML() : keyCard() + (S.event ? eventHTML() : '') + homeHTML();
    keepOpener();
  })));
}
function keyCard() {
  if (isTour() || hasKey()) return '';
  return `<div class="keycard"><p>Add the demo key to load the live plan for El Dorado County. The map works without it.</p>
    <button class="btn sec" type="button" data-act="key" data-k="key">${icon('key')}Add demo key</button></div>`;
}
function homeHTML() {
  const h = homeFac(); if (!h) return '';
  const raw = S.raw[h.id], bp = raw?.backup_power || 'none', sim = !raw || (raw.simulated || []).includes('backup_power');
  const n = S.affected ? new Set(S.affected.sessions.filter(s => s.clinic_id === h.id).map(s => s.patient_id)).size : null;
  const pw = S.affected ? (S.affected.closed_clinic_ids.includes(h.id) ? `<span class="pw off">Loses power ${esc(win())}</span>` : '<span class="pw ok">Stays powered</span>')
    : S.event ? '<span class="pw wait">Not checked yet</span>' : '<span class="pw ok">Powered</span>';
  return `<section class="sec"><h2>Home clinic</h2>
    <p class="hname">${esc(h.name)}</p>${h.address ? `<p class="addr">${esc(h.address)}</p>` : ''}
    <dl class="facts">
      <dt>Stations</dt><dd class="m">${h.stations ?? 'Not listed'}</dd>
      <dt>Backup power</dt><dd>${esc(bp)}${sim ? ' (simulated)' : ''}</dd>
      <dt>Power</dt><dd>${pw}</dd>
      ${n != null ? `<dt>Patients in the window</dt><dd class="m">${n}</dd>` : ''}
    </dl>
    ${S.event ? '' : '<p class="small hint">Press Run demo to see Lumen answer a power shutoff notice. Demo assumptions, not clinical guidance.</p>'}</section>`;
}
function eventHTML() {
  const e = S.event;
  return `<section class="sec"><h2>Shutoff notice<span class="tag n">${noticeTag()}</span></h2>
    <dl class="facts">
      <dt>Area</dt><dd>${esc(e.area_name)}</dd>
      <dt>Power off</dt><dd>${esc(win())}</dd>
      <dt>Starts in</dt><dd class="m">${esc(countdown())}</dd>
    </dl>
    ${e.source_text ? `<details class="notice"><summary>Notice text</summary><pre>${esc(e.source_text)}</pre></details>` : ''}
  </section>`;
}
// R2: the approval list is the way to approve; the panel holds one big button to it, then the success state.
function planHTML() {
  const p = S.plan, c = counts(p), drafts = p.patients.filter(r => r.status === 'draft').length;
  const nd = S.diff ? Object.keys(S.diff).length : 0, dis = S.running || S.approving || !canReview() ? ' disabled' : '';
  const opts = [['all', 'All patients'], ['transfer', 'Move'], ['early', 'Come in early'], ['staff', 'Staff call']].concat(nd ? [['changed', 'Changed']] : []);
  const cell = (label, color, n) => `<div style="--c:var(${color})"><span>${label}</span><b>${n}</b></div>`;
  return `<div class="plan-h"><h2>Patient plan</h2><span class="pstat${drafts ? '' : ' ok'}">${nd ? `${nd} changed` : drafts ? 'Needs your approval' : 'Approved'}</span></div>
    <div class="cnt">${cell('Move', '--map-transfer', c.transfer)}${cell('Come in early', '--map-early', c.early_session)}${cell('Staff call', '--map-staff', c.hospital)}</div>
    ${drafts ? `<div class="acts"><button class="btn pri big${S.ring ? ' ring' : ''}" type="button" data-act="review" data-k="review-panel"${dis}>${S.approving ? 'Approving…' : `Review and approve ${plural(drafts, 'patient')}`}</button></div>
      <p class="note">Nothing is sent until staff approve.</p>`
    : `<div class="okbox" role="status"><p class="okline">${icon('ck')}Every patient is approved</p><p class="okc">${esc(moveLine(p))}</p>
      <p class="okn">Next: send voice notes. ${isTour() ? 'Open a patient' : 'Confirm a patient'}, then play their voice note.</p>
      <button class="btn sec" type="button" data-act="review" data-k="review-panel"${dis}><svg class="i fill"><use href="#i-play"/></svg>Send voice notes</button></div>`}
    ${nd ? `<div class="chgbar"><span>${esc(p.summary || `${plural(nd, 'patient')} changed`)}</span><button class="btn sec sm" type="button" data-act="ack" data-k="ack">Acknowledge changes</button></div>` : ''}
    ${chairsHTML()}
    <div class="lh"><h3>Patients</h3><label class="selw sm"><span class="vh">Show</span><select data-k="filter" id="filter">${opts.map(([v, l]) => `<option value="${v}"${S.filter === v ? ' selected' : ''}>${l}</option>`).join('')}</select>${icon('chev')}</label></div>
    <ul class="pts" id="pts" aria-label="Patients in rank order">${listHTML()}</ul>`;
}
// R3: one row per receiving clinic: chairs this plan uses of the chairs open in the window, and the road time from the closed clinic.
function chairsHTML() {
  // sorted by the plan's totals, so rows keep their place while the run counts up
  const list = Object.entries(capacity()).filter(([, c]) => c.open != null).sort(([, a], [, b]) => (b.n >= b.open) - (a.n >= a.open) || b.n - a.n);
  const calls = counts(S.plan).hospital, pr = pairs();
  if (!list.length && !calls) return '';
  const li = ([id, c]) => {
    const into = pr.filter(x => x.toId === id).sort((a, b) => b.count - a.count), p = into[0], rd = p ? roadNow(pt(S.fac[p.fromId]), pt(S.fac[id])) : false;
    const from = new Set(into.map(x => x.fromId)).size === 1 ? p.fromId : '';  // several closed clinics (tour): every route into this clinic
    const t = rd ? `${rd.minutes} min drive` : rd === null ? 'Drive time not available' : '';
    const body = `<span class="ch1"><span class="cn">${esc(cname(id))}</span>${c.full ? '<span class="fullp">Full</span>' : ''}<span class="m">${c.used} of ${c.open}</span></span>
      <span class="ch2"><span class="bar" aria-hidden="true"><i style="--f:${Math.min(100, Math.round(c.used / Math.max(c.open, 1) * 100))}%"></i></span><span class="sub">${esc(t)}</span></span>`;
    return `<li class="ch">${p ? `<button class="chb" type="button" data-act="route" data-from="${from}" data-to="${id}" data-k="ch-${id}" aria-pressed="${S.route?.toId === id}" aria-label="Show only the route to ${esc(cname(id))}, ${c.used} of ${c.open} chairs">${body}</button>` : body}</li>`;
  };
  const more = list.slice(6);  // the tour has 25 receiving centers: the full and busiest six first
  return `<section class="chairs" aria-labelledby="chH"><h3 id="chH">Chairs</h3>${list.length ? `<ul>${list.slice(0, 6).map(li).join('')}</ul>` : ''}
    ${more.length ? `<details class="more"${S.chMore ? ' open' : ''}><summary data-k="chmore">${plural(more.length, 'more clinic')}${icon('chev')}</summary><ul>${more.map(li).join('')}</ul></details>` : ''}
    ${calls ? `<p class="calls">${plural(calls, 'patient')} need${calls === 1 ? 's' : ''} a staff call: no clinic within ${S.rules.drive_cap_minutes ?? 40} minutes had a free chair at their time.</p>` : ''}</section>`;
}
function renderChairs() { const el = $('#panel .chairs'); if (el) keepFocus(() => { el.outerHTML = chairsHTML(); }); }
function listHTML() {
  const list = rows().filter(FILTERS[S.filter] || FILTERS.all);
  return list.length ? list.map(rowHTML).join('') : '<li class="empty">No patients match this filter.</li>';
}
function renderList() { const ul = $('#pts'); if (ul) keepFocus(() => keepScroll($('#panel'), () => keepAudio(() => { ul.innerHTML = listHTML(); }))); }
function changeWords(entries) {
  const f = Object.fromEntries(entries.map(e => [e.field, e])), out = [];
  const toStaff = f.action?.to === 'hospital';
  if (f.clinic_id) out.push(toStaff ? `Moved from ${cname(f.clinic_id.from)} to the staff call list` : `Moved from ${cname(f.clinic_id.from)} to ${cname(f.clinic_id.to)}`);
  if (f.action && !toStaff) out.push(`now ${ACTION[f.action.to]?.label.toLowerCase() || f.action.to}`);
  if (f.slot && !toStaff) out.push(f.slot.to ? `new time ${slotText(f.slot.to)}` : 'no chair');
  else if (f.pickup_time?.to && !f.clinic_id) out.push('new leave time');
  if (!out.length) out.push(`Updated ${join(entries.map(e => FIELD[e.field] || e.field))}`);
  return cap(out.join(' · '));
}
const rideWord = r => RIDE[r.ride] || cap(String(r.ride || '').replace(/_/g, ' '));
/* ---------- the patient card (R5): one sentence, one leave line from the live road route, one reason line ---------- */
function summaryOf(r) {
  if (r.status === 'declined' && !r.slot) return 'Declined · staff will call';
  if (r.action === 'transfer') return `Moves to ${cname(r.clinic_id)} · ${slotText(r.slot)}`;
  if (r.action === 'early_session') return `Comes in early at ${cname(r.clinic_id)} · ${slotText(r.slot)}`;
  if (r.action === 'hospital') return 'Staff will call · no chair fits';
  return 'Keeps the usual session · gets a notice';
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
function rowHTML(r) {
  const id = r.patient_id, open = S.expanded === id, chg = S.diff?.[id], a = ACTION[r.action] || ACTION.notify_only;
  const dest = r.clinic_id ? cname(r.clinic_id) : r.action === 'notify_only' ? 'Usual clinic' : 'No clinic';
  const when = r.slot ? `<span class="m">${esc(slotText(r.slot))}</span>` : r.action === 'hospital' ? '<span class="nochair">No chair fits</span>' : '';
  const lang = S.langs[id] && S.langs[id] !== 'English' ? S.langs[id] : '';
  return `<li class="pt${chg ? ' chg' : ''}${S.selected === id ? ' sel' : ''}${open ? ' open' : ''}" data-id="${id}">
    <button class="rowb" type="button" data-act="row" data-id="${id}" data-k="row-${id}" aria-expanded="${open}">
      <span class="rk m">${r.rank}</span>
      <span class="rb">
        <span class="r1"><span class="nm">${esc(pname(id))}</span><span class="tag ${a.cls}">${a.label}</span></span>
        <span class="r2"><span>${esc(dest)}</span>${when}</span>
        <span class="r3"><span>${esc(rideWord(r))}</span><span>${lang ? `${esc(lang)} · ` : ''}<span class="s-${r.status}">${STATUS[r.status] || esc(r.status)}</span></span></span>
        ${chg ? `<span class="chgt"><span class="tag">Changed</span><span>${esc(changeWords(chg))}</span></span>` : ''}
      </span>
    </button>
    ${open ? detailHTML(r) : ''}
  </li>`;
}
// Message tabs: the patient's language first, then English. In the tour, a non-English message is a template written ahead of time.
const msgLangs = r => Object.keys(r.messages || {}).filter(l => l === 'en' || l === (S.lang[r.patient_id] || 'en')).sort((a, b) => (a === 'en') - (b === 'en'));
const tabLabel = l => `${langName(l)}${isTour() && l !== 'en' ? ' · Template translation' : ''}`;
function detailHTML(r) {
  const id = r.patient_id, langs = msgLangs(r), leave = leaveLine(r), why = whyLine(r);
  const cur = [S.msgLang[id], S.lang[id]].find(l => langs.includes(l)) || langs[0];
  const move = r.action === 'early_session' || r.action === 'transfer';
  return `<div class="pdet">
    <p class="big">${esc(summaryOf(r))}</p>
    ${leave ? `<p class="leave">${esc(leave)}</p>` : ''}
    ${why ? `<p class="why">${esc(why)}</p>` : ''}
    ${gapOf(r) ? '<p class="small">Long gap after this session</p>' : ''}
    ${langs.length ? `<details class="msg" data-id="${id}"${S.msgOpen[id] ? ' open' : ''}><summary data-k="msg-${id}">Message · ${esc(langs.map(langName).join(', '))}${icon('chev')}</summary>
      <div class="langs" role="group" aria-label="Message language">${langs.map(l => `<button type="button" data-act="lang" data-id="${id}" data-lang="${l}" data-k="lang-${id}-${l}" aria-pressed="${l === cur}">${esc(tabLabel(l))}</button>`).join('')}</div>
      <p class="msgt" lang="${esc(cur)}">${esc(r.messages[cur])}</p></details>` : ''}
    ${move ? actionsHTML(r, langs, cur) : ''}
    ${S.rowErr[id] ? `<p class="err" role="alert">${esc(S.rowErr[id])}</p>` : ''}
  </div>`;
}
function actionsHTML(r, langs, cur) {
  const id = r.patient_id, dis = S.busy[id] || S.running ? ' disabled' : '', ok = r.status === 'confirmed';
  let voiceUI = '', spoken = '';
  if (isTour() && r.messages?.en) {  // E10: the voice in the patient's language; nothing is sent
    const lang = S.lang[id] || 'en', own = !!r.messages[lang], sp = S.speak[`${id}|${lang}`];
    voiceUI = `<button class="btn sec sm" type="button" data-act="speak" data-id="${id}" data-k="spk-${id}"${S.busy[id] ? ' disabled' : ''}><svg class="i fill"><use href="#i-play"/></svg>${
      S.busy[id] ? (own ? 'Making voice note…' : 'Translating…') : own ? 'Play voice note' : 'Translate and play'}</button>`;
    if (sp) spoken = `<div class="spk">${sp.machine && sp.text ? `<p class="small">Machine translation</p><p class="msgt" lang="${esc(lang)}">${esc(sp.text)}</p>` : ''}${
      sp.url ? `<audio controls preload="auto" src="${esc(sp.url)}" data-id="${id}"></audio>` : sp.note ? `<p class="small">${esc(sp.note)}</p>` : ''}</div>`;
  } else if (ok && langs.length) voiceUI = `<label class="selw sm"><span class="vh">Voice note language</span><select data-k="vl-${id}">${langs.map(l => `<option value="${l}"${l === cur ? ' selected' : ''}>${esc(langName(l))}</option>`).join('')}</select>${icon('chev')}</label>
    <button class="btn sec sm" type="button" data-act="voice" data-id="${id}" data-k="voice-${id}"${dis}><svg class="i fill"><use href="#i-play"/></svg>${S.busy[id] ? 'Making voice note…' : 'Play voice note'}</button>`;
  return `<div class="racts">
    ${ok ? '' : r.status === 'draft' ? `<button class="btn sec sm" type="button" disabled>${icon('ck')}Confirm after approval</button>`
      : `<button class="btn sec sm" type="button" data-act="confirm" data-id="${id}" data-k="cf-${id}"${dis}>${icon('ck')}Mark confirmed</button>`}
    ${r.status === 'declined' ? '' : `<button class="btn q sm" type="button" data-act="decline" data-id="${id}" data-k="dc-${id}"${dis}>Decline</button>`}
    ${voiceUI}
  </div>${spoken}${S.audio[id] ? `<audio controls preload="auto" src="${esc(S.audio[id])}" data-id="${id}"></audio>` : ''}`;
}
// FLIP: rows slide from their old place to the new rank order (positions are relative to the list)
function positions() { return Object.fromEntries([...document.querySelectorAll('#pts > .pt')].map(li => [li.dataset.id, li.offsetTop])); }
function flip(before) {
  if (reduced.matches) return;
  const box = $('#panel'), top = box.scrollTop, bottom = top + box.clientHeight;
  for (const li of document.querySelectorAll('#pts > .pt')) {
    const b = before[li.dataset.id], y = li.offsetTop;
    if (b == null || b === y) continue;
    if (Math.max(b, y) < top - 400 || Math.min(b, y) > bottom + 400) continue;  // off screen: no need to animate
    li.animate([{ transform: `translateY(${b - y}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}
function selectRow(id, fromMap) {
  if (S.route) { S.route = null; renderChairs(); }
  S.selected = id; S.expanded = id; S.listSel = false;
  M('selectPatient', id); M('isolate', { type: 'patient', id });
  showRoute(id, fromMap);  // their road route home -> destination; the map fits it
  if (S.stage < 4) return;
  const r = S.plan.patients.find(x => x.patient_id === id);
  if (r && !(FILTERS[S.filter] || FILTERS.all)(r)) { S.filter = 'all'; renderPanel(); } else renderList();
  if (fromMap) openPanel(true);
  $(`#pts > .pt[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: reduced.matches ? 'auto' : 'smooth' });
}

/* ---------- review and approve (E4): window.LumenReview, a pop-out over the whole screen ---------- */
const canReview = () => !!(window.LumenReview && S.plan && S.stage >= 4);
const WHAT = { early_session: r => `Comes in early at ${cname(r.clinic_id)}`, transfer: r => `Moves to ${cname(r.clinic_id)}`,
  hospital: () => 'Staff will call', notify_only: () => 'Gets a notice; the usual session stays' };
// View models for review.js: plain words only, no internal codes.
function viewRows() {
  return rows().map(r => {
    const id = r.patient_id, st = r.status, move = r.action === 'early_session' || r.action === 'transfer', rd = patientRoad(r);
    const lang = S.lang[id] || 'en', hasMsg = Object.keys(r.messages || {}).length > 0, own = !!r.messages?.[lang];
    const messages = Object.fromEntries(msgLangs(r).map(l => [l, r.messages[l]]));
    const canVoice = isTour() ? !!r.messages?.en : move && st === 'confirmed' && hasMsg;
    return {
      id, rank: r.rank, name: pname(id), lang, langName: S.langs[id] || langName(lang), action: r.action,
      what: (WHAT[r.action] || WHAT.notify_only)(r), where: r.clinic_id ? destName(r) : '',
      when: r.slot ? slotText(r.slot) : r.action === 'hospital' ? 'No chair fits' : '',
      pickup: r.slot ? `${rideWord(r)} · ${leaveBy(r)}` : rideWord(r),
      road: r.slot ? { minutes: r.drive_minutes, miles: rd?.miles ?? null, tooFar: r.drive_minutes > (S.rules.drive_cap_minutes ?? 40) } : null,
      summary: summaryOf(r), leave: leaveLine(r), why: whyLine(r), gap: gapOf(r),
      status: st, statusText: STATUS[st] || st, changed: !!S.diff?.[id], changeText: S.diff?.[id] ? changeWords(S.diff[id]) : null,
      messages,
      msgLabels: Object.fromEntries(Object.keys(messages).map(l => [l, tabLabel(l)])),
      canConfirm: move && st !== 'draft' && st !== 'confirmed',
      confirmHint: !move ? (r.action === 'hospital' ? 'A staff member calls this patient' : 'Nothing to confirm: the usual session stays')
        : st === 'draft' ? 'Approve this row first' : st === 'confirmed' ? 'Already confirmed' : '',
      canVoice,
      voiceHint: canVoice ? (!isTour() ? '' : lang === 'en' ? 'Plays the English message. Nothing is sent.'
          : own ? `The ${langName(lang)} message is a template translation, written ahead of time. Nothing is sent.`
          : `No ${langName(lang)} template: the English message is translated first. Nothing is sent.`)
        : isTour() ? 'This row has no message' : !move ? 'Only moves get a voice note' : st !== 'confirmed' ? 'Mark the row confirmed first' : 'This row has no message',
    };
  });
}
function openReview(opener) {
  if (!canReview() || S.running) return;
  S.opener = opener; S.ring = false;
  R('open', {
    title: 'Review and approve', isTour: isTour(), rows: viewRows(), opener, successText: moveLine(S.plan),
    onApprove: ids => approve(ids),
    onDecline: id => editOrThrow(id, 'declined'),
    onConfirm: id => editOrThrow(id, 'confirmed'),
    onVoice: (id, lang) => voiceFor(id, lang),
    onSelect: id => { selectRow(id, false); S.listSel = true; },  // draws the road route; its time reaches the review through update()
    onNext: toVoice,
  });
}
// Step 7 "Send voice notes": the list closes and the first approved move opens in the panel, its confirm or voice button focused.
function toVoice() {
  const r = rows().find(x => (x.action === 'transfer' || x.action === 'early_session') && (x.status === 'approved' || x.status === 'confirmed'));
  if (r) {
    const id = r.patient_id, k = isTour() ? `spk-${id}` : r.status === 'confirmed' ? `voice-${id}` : `cf-${id}`;
    const go = () => ($(`[data-k="${k}"]`) || $(`[data-k="row-${id}"]`))?.focus();
    selectRow(id, false); openPanel(true);
    const dlg = $('dialog.rv[open]');  // the list hands focus back to its opener on close; this runs after that
    if (dlg) dlg.addEventListener('close', go, { once: true }); else go();
  }
  R('close');
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
  const dark = t === 'dark', b = $('#themeTog');
  b.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  b.innerHTML = icon(dark ? 'sun' : 'moon');
  M('setTheme', t);
}
function openPanel(on) {
  if (!matchMedia('(max-width: 1180px)').matches && on) return;
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

function sync3D() { const on = !!M('is3D'); $('#d3').setAttribute('aria-pressed', on); }

/* ---------- events ---------- */
function bind() {
  $('#run').addEventListener('click', () => runDemo());
  $('#resetGo').addEventListener('click', doReset);
  $('#runGo').addEventListener('click', () => { $('#runPop').hidePopover(); runDemo(1); });
  $('#region').addEventListener('change', e => setRegion(e.target.value));
  $('#themeTog').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('#keyTog').addEventListener('click', () => openKey());
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
    loadLive();
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
  $('#d3').addEventListener('click', () => { M('set3D', !M('is3D')); sync3D(); });
  $('#planTog').addEventListener('click', () => openPanel(!$('#panel').classList.contains('open')));
  $('#railTog').addEventListener('click', e => {
    const on = $('#rail').classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', on);
    requestAnimationFrame(() => M('resize'));
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('#panel').classList.contains('open')) { openPanel(false); $('#planTog').focus(); }
  });
  // R8: closing the review list after picking a row there shows every route again (toVoice's row stays open)
  document.addEventListener('close', e => { if (S.listSel && e.target.matches?.('dialog.rv')) { clearSel(); renderPanel(); } }, true);
  $('#phases').addEventListener('click', e => {
    const b = e.target.closest('[data-retry], [data-review]');
    if (b?.dataset.retry) S.phases[b.dataset.retry]?.retry?.(); else if (b) openReview(b);
  });
  $('#pause').addEventListener('click', togglePause);
  $('#replan').addEventListener('submit', e => { e.preventDefault(); replan($('#instr').value); });
  $('#instr').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); replan($('#instr').value); } });
  $('#sugg').addEventListener('click', () => { $('#instr').value = $('#sugg').textContent; $('#instr').focus(); });
  $('#panel').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case 'row': S.expanded === id ? (clearSel(), renderList()) : selectRow(id, false); break;
      case 'route': S.route?.toId === b.dataset.to ? (clearSel(), renderPanel()) : isoRoute(b.dataset.from || null, b.dataset.to); break;
      case 'lang': S.msgLang[id] = b.dataset.lang; renderList(); break;
      case 'confirm': edit(id, 'confirmed'); break;
      case 'decline': edit(id, 'declined'); break;
      case 'voice': voice(id); break;
      case 'review': openReview(b); break;
      case 'speak': speakRow(id); break;
      case 'ack': ack(); break;
      case 'key': openKey(); break;
    }
  });
  $('#panel').addEventListener('change', e => { if (e.target.id === 'filter') { S.filter = e.target.value; renderList(); } });
  $('#panel').addEventListener('animationend', e => { if (e.target.dataset.k === 'review-panel') S.ring = false; });  // pulses once per run
  $('#panel').addEventListener('toggle', e => {
    const d = e.target;
    if (d.matches?.('details.msg')) S.msgOpen[d.dataset.id] = d.open; else if (d.matches?.('details.more')) S.chMore = d.open;
  }, true);
}
function onSelect(sel) {
  if (!sel) { clearSel(); renderPanel(); return; }  // R8: the map's "Show all routes" chip or Esc
  if (sel.type === 'patient') selectRow(sel.id, true);
  else if (sel.type === 'route') isoRoute(sel.fromId, sel.toId);
  else if (sel.type === 'facility') M('focus', { facility: sel.id });
}

async function boot() {
  bind();
  resetPhases();
  const motion = () => { $('#animTog').hidden = reduced.matches; };  // reduced motion already stops the animation
  motion(); reduced.addEventListener('change', motion);
  S.B = live; indexFac();
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  setTheme(theme, false);
  fitWidths();
  renderAll();
  const dataP = fetch('data/eldorado.json').then(r => r.json()).catch(() => null);
  // init creates the map at once and resolves on its first load; the setters below queue until then
  const mapP = window.LumenMap ? Promise.resolve().then(() => LumenMap.init($('#map'), { theme, mapKey: CFG.mapKey || '', onSelect, on3D: sync3D })) : Promise.reject(new Error('map.js missing'));
  mapP.catch(e => { console.warn('LumenMap.init', e); banner('The map did not load. The plan still works.'); });
  S.data.eldorado = await dataP;
  M('set3D', true);  // first view: tilted 50 degrees over the home clinic
  if (S.region === 'eldorado') {
    if (S.data.eldorado) M('setRegion', S.data.eldorado, S.clinics); else banner('The map data did not load. Reload the page.');
    M('focus', 'home');
  }
  sync3D();
  await loadLive();
}
boot();
})();
