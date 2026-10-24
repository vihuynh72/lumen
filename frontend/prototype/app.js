/* Lumen app screen: API client, demo runner, rail, plan panel and controls.
   Calls window.LumenMap (map.js) and window.LumenTour (tour.js). Contract: contracts/api.md. */
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
const TOUR_SVC = 'In this page', TOUR_SRC = 'Illustrative tour';
const NOTICE_TAG = 'Simulated PG&E notice';
const PLAN_LINE = 'Lambda is finding affected sessions, ranking patients, assigning chairs and writing messages';

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

const PHASES = [
  { name: 'Read notice', svc: 'Bedrock or rules', how: 'Lumen reads the simulated PG&E notice and finds the shutoff area and window. Amazon Bedrock does this when it is available, otherwise rules in AWS Lambda.' },
  { name: 'Find affected', svc: 'AWS Lambda', how: 'AWS Lambda finds the clinics that lose power and the sessions in the window.' },
  { name: 'Rank patients', svc: 'AWS Lambda', how: 'Lambda ranks patients by urgency and by how hard they are to move.' },
  { name: 'Assign chairs', svc: 'AWS Lambda', how: 'Lambda gives each patient an early session, a chair at an open clinic or a staff call.' },
  { name: 'Write messages', svc: 'Bedrock or rules', how: "Amazon Bedrock writes a message for each move in the patient's language when it is available. Otherwise Lambda uses an English template." },
  { name: 'Approve', svc: 'Staff', how: 'You review the plan. Nothing goes out until staff approve.' },
  { name: 'Voice notes', svc: 'Amazon Polly', how: "Amazon Polly reads a confirmed patient's message as a voice note." },
];
const ACTION = {
  early_session: { label: 'Early session', cls: 'e' }, transfer: { label: 'Transfer', cls: 'tr' },
  hospital: { label: 'Staff call', cls: 'sc' }, notify_only: { label: 'Notice only', cls: 'n' },
};
const REASON = {
  session_in_window: 'Session in the shutoff window', session_within_36h: 'Session within 36 hours', heart_failure: 'Heart failure',
  missed_recently: 'Missed a session recently', paratransit: 'Rides paratransit', home_in_outage: 'Home loses power', no_car: 'No car',
  lives_alone: 'Lives alone', wheelchair: 'Uses a wheelchair', limited_english: 'Limited English',
};
const RIDE = { self: 'Drives self', family: 'Family drives', paratransit: 'Paratransit', medical_van: 'Medical van', taxi: 'Taxi', transit: 'Public transit' };
const FLAG = { long_gap_after: 'Long gap after this session', staff_call: 'Staff call needed' };
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
  clinics: FALLBACK, raw: {}, fac: {}, names: {}, homes: {}, langs: {},
  outage: null, event: null, affected: null, plan: null, stage: 0,
  phases: [], running: false, alertMs: null, runTotal: null,
  diff: null, expanded: null, selected: null, filter: 'all',
  msgLang: {}, audio: {}, rowErr: {}, busy: {}, approving: false, gen: 0, anim: true,
};
const isTour = () => S.region === 'santaclara';
const hasKey = () => !!store.get('lumenDemoKey');

/* ---------- words and times ---------- */
const TZ = 'America/Los_Angeles';
const fDT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const langDN = new Intl.DisplayNames(['en'], { type: 'language' });
function dt(iso) {
  if (!iso) return '';
  const p = Object.fromEntries(fDT.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
}
const time = iso => iso ? fT.format(new Date(iso)) : '';
function slotText(s) {
  if (!s) return '';
  const [y, mo, d] = s.date.split('-').map(Number), day = new Date(Date.UTC(y, mo - 1, d));
  const [h, mi] = SHIFT[s.shift] || [0, 0], o = { timeZone: 'UTC' };
  return `${day.toLocaleDateString('en-US', { ...o, weekday: 'short' })} ${day.toLocaleDateString('en-US', { ...o, month: 'short' })} ${d}, ${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const fms = ms => ms == null ? '' : ms < 1 ? '<1 ms' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';
const low = s => s ? s[0].toLowerCase() + s.slice(1) : '';
const join = a => a.length < 2 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
function langName(code) { try { return langDN.of(code) || code; } catch { return code; } }
const reasonWord = k => REASON[k] || cap(String(k).replace(/_/g, ' '));
const short = n => String(n || '').replace(/\s+Dialysis(\s+(Center|Clinic))?$/i, '');
const cname = id => id ? short(S.fac[id]?.name || id) : 'no chair';
const pname = id => S.names[id] || id;
const win = () => S.event ? `${dt(S.event.start)} to ${dt(S.event.end)}` : '';
function countdown() {
  const ev = S.event; if (!ev) return '';
  const now = S.affected?.now ? Date.parse(S.affected.now) : Date.parse(ev.issued_at) + 30 * 60e3;
  const min = Math.max(0, Math.round((Date.parse(ev.start) - now) / 60e3));
  return `${Math.floor(min / 60)} h ${min % 60} m`;
}
const rows = () => S.plan ? [...S.plan.patients].sort((a, b) => a.rank - b.rank) : [];
function counts(p) { const c = { early_session: 0, transfer: 0, hospital: 0, notify_only: 0 }; for (const r of p.patients) c[r.action]++; return c; }
const homeFac = () => S.clinics.find(c => c.home);
// The chip names the service that did the work; the source says how (API parse_source / ai_sources).
function aiSrc(v, rules) {
  if (isTour()) return { svc: TOUR_SVC, src: TOUR_SRC };
  if (v === 'bedrock') return { svc: 'Amazon Bedrock', src: 'Claude Haiku 4.5' };
  if (v === 'fallback') return { svc: 'AWS Lambda', src: `${rules} fallback · Bedrock unavailable` };
  return { svc: 'AWS Lambda', src: 'Source not reported' };
}
const rulesSrc = () => isTour() ? { svc: TOUR_SVC, src: TOUR_SRC } : { svc: 'AWS Lambda', src: 'Rules · one request' };

/* ---------- backends: live API and the in-page tour ---------- */
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
const live = {
  async call(method, path, body) {
    const key = store.get('lumenDemoKey') || '', headers = {};
    if (key) headers['x-demo-key'] = key;
    if (body) headers['content-type'] = 'application/json';
    let res;
    try { res = await fetch(String(CFG.api || '').replace(/\/+$/, '') + path, { method, headers, body: body && JSON.stringify(body) }); }
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

/* ---------- map: every call is safe when map.js is missing or throws ---------- */
function M(fn, ...a) {
  try { const m = window.LumenMap; return m && typeof m[fn] === 'function' ? m[fn](...a) : undefined; }
  catch (e) { console.warn('LumenMap.' + fn, e); }
}
function facStatus() {
  const st = {};
  for (const f of S.clinics) st[f.id] = f.kind === 'hospital' ? 'hospital' : 'normal';
  if (S.stage >= 2 && S.affected) for (const id of S.affected.closed_clinic_ids) st[id] = 'closed';
  if (S.stage >= 4 && S.plan) for (const r of S.plan.patients) if (r.action === 'transfer' && st[r.clinic_id] === 'normal') st[r.clinic_id] = 'receiving';
  M('setFacilityStatus', st);
}
function mapPatients() {
  if (S.stage < 2) return M('setPatients', null);
  const by = Object.fromEntries((S.plan?.patients || []).map(r => [r.patient_id, r]));
  const ids = S.affected ? [...new Set(S.affected.sessions.map(s => s.patient_id))] : Object.keys(by);
  // `to` is the destination, so a row with no route (an early session) still shows home -> clinic when selected
  M('setPatients', ids.filter(id => S.homes[id]).map(id => {
    const r = S.stage >= 4 ? by[id] : null, to = S.fac[r?.clinic_id];
    return { id, lng: S.homes[id][0], lat: S.homes[id][1], label: pname(id), action: r?.action ?? null,
      rank: S.stage >= 3 ? by[id]?.rank ?? null : null, to: to ? [to.lng, to.lat] : null };
  }));
}
// One item per moved patient, from the clinic of their affected session to the new facility; map.js merges equal routes.
// Early sessions stay at their own clinic, so they have no route (their home dot shows the action).
function mapFlows() {
  if (S.stage < 4 || !S.plan) return M('setFlows', null);
  const usual = Object.fromEntries((S.affected?.sessions || []).map(s => [s.patient_id, s.clinic_id])), home = homeFac()?.id;
  M('setFlows', S.plan.patients.flatMap(r => {
    const from = S.fac[usual[r.patient_id] || home], to = S.fac[r.clinic_id];
    if ((r.action !== 'transfer' && r.action !== 'hospital') || !from || !to) return [];
    return [{ id: r.patient_id, from: [from.lng, from.lat], to: [to.lng, to.lat], action: r.action, changed: !!S.diff?.[r.patient_id] }];
  }));
}
function mapStage(stage) {
  S.stage = stage;
  M('showOutage', stage >= 1 ? S.outage : null);
  M('setPower', stage >= 2);
  facStatus(); mapPatients(); mapFlows();
}

/* ---------- rail ---------- */
const ST_WORD = { pending: '', queued: 'Queued', running: 'Running', waiting: 'Waiting for you', error: 'Failed' };
function resetPhases() {
  S.phases = PHASES.map(p => ({ name: p.name, svc: isTour() && p.svc !== 'Staff' && p.svc !== 'Amazon Polly' ? TOUR_SVC : p.svc, status: 'pending' }));
}
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
function renderRail() {
  const ol = $('#phases');
  keepFocus(() => { ol.innerHTML = S.phases.map((p, i) => {
    const cur = ['running', 'waiting', 'error'].includes(p.status);
    const st = p.status === 'done' ? fms(p.ms) : ST_WORD[p.status];
    const res = !p.res ? '' : p.det
      ? `<details class="det res" data-i="${i}"${p.open ? ' open' : ''}><summary data-k="det-${i}"><span>${esc(p.res)}</span>${icon('chev')}</summary><p>${esc(p.det)}</p></details>`
      : `<p class="res">${esc(p.res)}</p>`;
    return `<li class="ph ${p.status}"${cur ? ' aria-current="step"' : ''}>
      <span class="d" aria-hidden="true">${p.status === 'done' ? icon('ck') : p.status === 'error' ? icon('x') : ''}</span>
      <div>
        <div class="ph-h"><span class="nm">${esc(p.name)}</span><span class="st m">${p.status === 'done' ? '<span class="vh">Done, </span>' : p.status === 'pending' ? '<span class="vh">Not started</span>' : ''}${esc(st)}</span></div>
        <div class="meta"><span class="svc">${esc(p.svc)}</span>${p.src ? `<span title="${esc(p.src)}">${esc(p.src)}</span>` : ''}</div>
        ${res}
        ${p.err ? `<p class="err">${esc(p.err)}</p>${p.retry ? `<button class="btn retry" type="button" data-retry="${i}" data-k="retry-${i}">Retry</button>` : ''}` : ''}
      </div></li>`;
  }).join(''); }, '#railH');
  $('#railSub').textContent = railSub();
  // follow the newest event: a running or failed step, else the newest Re-plan step, else the step waiting for you
  const act = ol.querySelector('.ph.running, .ph.error') || (S.phases.length > PHASES.length ? ol.lastElementChild : ol.querySelector('[aria-current]'));
  if (act) railScroll(act);
  // re-plan box
  const ok = S.stage >= 4 && !S.running;
  for (const el of [$('#instr'), $('#sugg'), $('#send')]) setDisabled(el, !ok);
  $('#sugg').textContent = isTour() ? (S.tour?.suggestion || '').replace(/ four more$/, ' 4 more') : SUGGEST_LIVE;
}
// Like scrollIntoView 'nearest', then snapped so a whole row (never a cut one) sits at the top of the list.
function railScroll(el) {
  const ol = $('#phases'), base = ol.getBoundingClientRect().top - ol.scrollTop, y = e => e.getBoundingClientRect().top - base;
  const s = ol.scrollTop, h = ol.clientHeight, a = y(el), b = a + el.offsetHeight;
  if (a >= s && b <= s + h) return;
  const want = a < s ? a : b - h;
  ol.scrollTo({ top: Math.min(a, ...[...ol.children].map(y).filter(v => v >= want)), behavior: reduced.matches ? 'auto' : 'smooth' });
}
function railSub() {
  const n = PHASES.length;
  let k = S.phases.findIndex(p => ['running', 'queued', 'error'].includes(p.status));
  if (k < 0) k = S.phases.findIndex(p => p.status === 'waiting');
  if (k >= 0) {
    const p = S.phases[k];
    return `${k < n ? `Step ${k + 1} of ${n} · ` : ''}${p.name}${p.status === 'error' ? ' · failed' : p.status === 'waiting' ? ' · waiting for you' : ''}`;
  }
  if (S.plan) return `Plan v${S.plan.version}${S.plan.version === 1 && S.runTotal != null ? ` · ${fms(S.runTotal)} total` : ''}`;
  return S.event ? 'Notice read · no plan yet' : `Not started · ${n} steps`;
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

/* ---------- restore from GET /state ---------- */
function resAffected() {
  if (!S.affected) return '';
  const n = S.affected.closed_clinic_ids.length;
  return `${plural(n, 'clinic')} lose${n === 1 ? 's' : ''} power · ${S.affected.sessions.length} sessions in the window`;
}
function resRank() {
  const top = rows()[0]; if (!top) return '';
  return top.reason_text || `${pname(top.patient_id)} ranks first: ${join(top.reasons.slice(0, 2).map(k => low(reasonWord(k))))}`;
}
function resAssign() {
  const c = counts(S.plan);
  return `${c.early_session} early · ${c.transfer} transfer · ${c.hospital} staff call${c.notify_only ? ` · ${c.notify_only} notice only` : ''}`;
}
function resText() {
  const withMsg = S.plan.patients.filter(r => Object.keys(r.messages || {}).length);
  const langs = [...new Set(withMsg.flatMap(r => Object.keys(r.messages)))].map(langName);
  return `${plural(withMsg.length, 'message')}${langs.length ? ` in ${join(langs)}` : ''}`;
}
const detNotice = () => `${NOTICE_TAG} · event ${S.event.event_id} · ${S.event.notice_type || 'notice'} · issued ${dt(S.event.issued_at)}`;
function detAffected() {
  if (!S.affected) return '';
  const homes = Object.values(S.affected.home_in_outage || {}).filter(Boolean).length;
  return `Closed: ${S.affected.closed_clinic_ids.map(cname).join(', ') || 'none'}. Patient homes in the shutoff area: ${homes}.`;
}
const detRank = () => `First three: ${rows().slice(0, 3).map(r => pname(r.patient_id)).join(', ')}.`;
const detAssign = () => S.plan.summary || `${plural(S.plan.overflow.length, 'patient')} with no chair get a staff call.`;
function planPhases(p) {
  const tm = p.version === 1 ? p.timing_ms || {} : {}, r = rulesSrc();  // later versions carry other requests' timings
  const one = isTour() ? '' : `Steps 2 to 5 ran in one AWS Lambda request (POST /plan${tm.total != null ? `, ${fms(tm.total)} in all` : ''}). `;
  return [
    { ms: tm.affected, ...r, res: resAffected(), det: one + detAffected() },
    { ms: tm.rank, ...r, res: resRank(), det: one + detRank() },
    { ms: tm.match, ...r, res: resAssign(), det: one + detAssign() },
    { ms: tm.text, ...aiSrc(p.ai_sources?.text, 'Template'), res: resText() },
  ];
}
function voiceWaiting() {
  if (S.phases[6].status === 'done') return;
  setPhase(6, { status: isTour() ? 'pending' : 'waiting', res: isTour() ? 'Voice notes need the live region.' : 'Confirm a patient to make one' });
}
function restorePhases() {
  resetPhases();
  if (S.event) setPhase(0, { status: 'done', ...aiSrc(S.event.parse_source, 'Rules'), res: `${win()} · ${S.event.area_name}`, det: detNotice() });
  if (!S.plan) return;
  planPhases(S.plan).forEach((o, k) => setPhase(k + 1, { status: 'done', ...o }));
  const drafts = S.plan.patients.filter(r => r.status === 'draft').length, approved = !drafts;
  if (approved) setPhase(5, { status: 'done', src: 'You', res: 'Approved by you' });
  else setPhase(5, { status: 'waiting', res: drafts < S.plan.patients.length ? `${plural(drafts, 'row')} still to approve` : 'Review the plan, then approve it' });
  if (S.plan.patients.some(r => Object.keys(r.audio || {}).length)) setPhase(6, { status: 'done', src: 'Polly standard voice', res: 'A voice note exists for this plan' });
  else if (approved) voiceWaiting();
  // ai_sources describes only the request that made the current version, so only the newest re-plan can use it
  const audit = S.plan.audit || [], re = audit.filter(a => /^re-plan/i.test(a.change)), lastRe = /^re-plan/i.test(audit.at(-1)?.change || '');
  re.forEach((a, k) => S.phases.push({ name: 'Re-plan', status: 'done', res: a.change.replace(/^re-plan:\s*/i, ''),
    ...aiSrc(k === re.length - 1 && lastRe ? S.plan.ai_sources?.replan : undefined, 'Rules') }));
}
function applyState(st) {
  if (st.clinics) {
    S.clinics = st.clinics.map(c => ({ id: c.id, name: c.name, kind: c.kind, lng: c.lng, lat: c.lat, home: !!c.home, stations: c.stations ?? null, address: c.address || '' }));
    S.raw = Object.fromEntries(st.clinics.map(c => [c.id, c]));
    indexFac();
    M('setRegion', S.data[S.region], S.clinics);
  }
  setPeople(st.patients);
  S.outage = st.outage_area || S.outage;
  S.event = st.event; S.affected = st.affected; S.plan = st.plan; S.diff = null;
  S.alertMs = null; S.runTotal = S.plan?.version === 1 ? S.plan.timing_ms?.total ?? null : null;
  restorePhases();
  mapStage(S.plan ? 4 : S.event ? 1 : 0);
  M('focus', S.stage >= 4 ? 'flows' : S.stage ? 'outage' : 'home');
  renderAll();
}
function indexFac() { S.fac = Object.fromEntries(S.clinics.map(c => [c.id, c])); }
function setPeople(list) {
  S.names = {}; S.homes = {}; S.langs = {};
  for (const p of list || []) {
    S.names[p.id] = p.name || p.id;
    S.homes[p.id] = p.home ? [p.home.lng, p.home.lat] : [p.lng, p.lat];
    S.langs[p.id] = p.language_name || (p.language ? langName(p.language) : '');
  }
}
async function loadLive(g = S.gen) {
  if (isTour()) return;
  if (!hasKey()) return renderAll();
  try { const st = await live.state(); if (g === S.gen && !isTour()) applyState(st); }  // drop answers from before a region switch
  catch (e) { if (g !== S.gen) return; if (e.status !== 401) banner(e.message); renderAll(); }
}

/* ---------- the run ---------- */
function setRunning(on) { S.running = on; renderTop(); renderRail(); }
async function runDemo(from) {
  if (S.running) return;
  if (!isTour() && !hasKey()) return openKey('Add the demo key to run the live demo.');
  if (from == null && S.plan) {  // a new run deletes the plan: ask first
    $('#runQ').textContent = `Start over? This deletes plan v${S.plan.version}, its approvals and voice notes.`;
    if (!$('#runPop').matches(':popover-open')) $('#runPop').showPopover();
    return;
  }
  from ??= S.event && !S.plan ? 2 : 1;
  $('#banner').hidden = true;
  setRunning(true);
  try {
    if (from === 1) await stepAlert();
    await stepPlan();
  } catch { /* the failing step shows its error and a Retry button */ }
  setRunning(false);
  renderPanel();
}
async function stepAlert() {
  S.plan = S.affected = S.diff = null; S.expanded = S.selected = null; S.audio = {}; S.rowErr = {};
  resetPhases(); mapStage(0); M('selectPatient', null); $('#panel').scrollTop = 0;
  setPhase(0, { status: 'running', res: 'Reading the simulated PG&E notice' });
  renderAll();
  const t0 = performance.now();
  try { S.event = await S.B.alert(); }
  catch (e) { fail(0, e, () => runDemo(1)); throw e; }
  S.alertMs = isTour() ? null : Math.round(performance.now() - t0);  // the tour's wait is pacing, not work
  if (!S.outage) try { S.outage = (await S.B.state()).outage_area; } catch { /* the map shows no area; the plan still works */ }
  done(0, { ms: S.alertMs, ...aiSrc(S.event.parse_source, 'Rules'), res: `${win()} · ${S.event.area_name}`, det: detNotice() });
  mapStage(1); M('focus', 'outage');
  renderAll();
  await sleep(700);
}
async function stepPlan() {
  setPhase(1, { status: 'running', res: isTour() ? 'Finding affected sessions, ranking patients, assigning chairs and writing messages' : PLAN_LINE });
  for (const k of [2, 3, 4]) setPhase(k, { status: 'queued', res: '' });
  renderRail();
  let plan, st;
  try { plan = await S.B.plan(S.event.event_id); st = await S.B.state(); }
  catch (e) { for (const k of [2, 3, 4]) setPhase(k, { status: 'pending' }); fail(1, e, () => runDemo(2)); throw e; }
  if (st.patients && !Object.keys(S.names).length) setPeople(st.patients);
  S.affected = st.affected; S.plan = plan; S.diff = null;
  S.runTotal = (S.alertMs || 0) + (plan.timing_ms?.total || 0);
  const res = planPhases(plan);
  done(1, res[0]); mapStage(2); M('focus', 'home'); renderAll();
  await sleep(2600);  // hold the home grid in 3D so the dead feeder and the closed clinic read
  done(2, res[1]); mapStage(3); renderRail();
  await sleep(900);
  done(3, res[2]); mapStage(4); M('focus', 'flows'); renderAll();
  await sleep(900);
  done(4, res[3]);
  setPhase(5, { status: 'waiting', res: 'Review the plan, then approve it' });
  announce('Approve is waiting for you. Review the plan, then approve it.');
  renderRail();
}
async function approveAll() {
  if (S.approving || S.running || !S.plan) return;
  S.approving = true;
  setPhase(5, { status: 'running', res: 'Approving every row' });
  renderRail(); renderPanel();
  try {
    S.plan = await S.B.approve({ event_id: S.event.event_id, patient_ids: ['all'], edits: [] });
    done(5, { ms: S.plan.timing_ms?.total, src: 'You', res: `Approved by you · plan v${S.plan.version}` });
    voiceWaiting();
  } catch (e) { fail(5, e, approveAll); }
  S.approving = false;
  renderRail(); renderPanel();
}
async function edit(id, status) {
  if (S.running || S.busy[id]) return;
  S.busy[id] = true; S.rowErr[id] = null; renderList();
  try {
    S.plan = await S.B.approve({ event_id: S.event.event_id, patient_ids: [], edits: [{ patient_id: id, status }] });
    announce(`${pname(id)}: ${STATUS[status].toLowerCase()}. Plan v${S.plan.version}.`);
  } catch (e) { S.rowErr[id] = e.message; if (e.status !== 401) banner(e.message); }
  S.busy[id] = false;
  renderPanel(); renderRail();
}
async function voice(id) {
  if (S.running || S.busy[id]) return;
  const lang = $(`[data-k="vl-${id}"]`)?.value || 'en';
  S.busy[id] = true; S.rowErr[id] = null; renderList();
  const first = S.phases[6].status !== 'done';
  if (first) { setPhase(6, { status: 'running', res: `Making a voice note for ${pname(id)}` }); renderRail(); }
  const t0 = performance.now();
  try {
    const { url } = await S.B.voice({ event_id: S.event.event_id, patient_id: id, lang });
    const ms = Math.round(performance.now() - t0);
    S.audio[id] = url; S.busy[id] = false; renderList();
    const a = $(`audio[data-id="${id}"]`);
    if (!a) { if (first) { setPhase(6, { status: 'waiting', res: 'Press play on the voice note' }); renderRail(); } return; }
    a.addEventListener('playing', () => {
      if (S.phases[6].status === 'done') return;
      done(6, { ms, src: 'Polly standard voice', res: `Voice note in ${langName(lang)} for ${pname(id)}` }); renderRail();
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
  const ph = { name: `Re-plan · v${S.plan.version + 1}`, svc: isTour() ? TOUR_SVC : 'Bedrock or rules', status: 'running', res: instruction };
  const at = () => S.phases.indexOf(ph);  // hold the step, not its index: a Retry can remove an earlier one
  S.phases.push(ph);
  setRunning(true); renderPanel();
  try {
    const before = positions();
    const r = await S.B.replan({ event_id: S.event.event_id, instruction });
    S.plan = r.plan;
    S.diff = r.diff.reduce((m, d) => ((m[d.patient_id] ||= []).push(d), m), {});
    const n = Object.keys(S.diff).length;
    done(at(), { name: `Re-plan · v${r.plan.version}`, ms: r.plan.timing_ms?.total, ...aiSrc(r.plan.ai_sources?.replan, 'Rules'),
      res: r.summary || r.plan.summary, det: `${plural(n, 'patient')} changed. Instruction: “${instruction}”` });
    if (r.plan.patients.some(x => x.status === 'draft')) {
      setPhase(5, { status: 'waiting', ms: null, src: '', res: `${plural(n, 'row')} changed · approve them` });
      if (S.phases[6].status !== 'done') setPhase(6, { status: 'pending', res: '' });  // one step waits at a time
    }
    $('#instr').value = '';
    S.running = false; S.expanded = S.selected = null; M('selectPatient', null);
    renderPanel(); flip(before);
    facStatus(); mapPatients(); mapFlows(); M('focus', 'flows');
    $('#pts > .pt.chg')?.scrollIntoView({ block: 'nearest', behavior: reduced.matches ? 'auto' : 'smooth' });
    announce(`${plural(n, 'patient')} changed in plan v${r.plan.version}.`);
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
  M('selectPatient', null); M('focus', 'home');
  renderAll();
  announce('The demo is reset.');
}
function clearRun() {
  Object.assign(S, { event: null, affected: null, plan: null, diff: null, expanded: null, selected: null, filter: 'all',
    alertMs: null, runTotal: null, audio: {}, rowErr: {}, busy: {}, msgLang: {} });
  resetPhases(); mapStage(0);
  $('#banner').hidden = true; $('#panel').scrollTop = 0;
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
    S.clinics = t.facilities; S.raw = {}; setPeople(t.patients); S.outage = t.outage;
  } else {
    S.B = live; S.tour = null; S.clinics = FALLBACK; S.raw = {}; setPeople([]); S.outage = null;
  }
  indexFac();
  M('setRegion', S.data[region], S.clinics);
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
  $('#chipId').textContent = S.event ? `${S.event.event_id} · ` : '';
  $('#chipT').textContent = S.event ? `Starts in ${countdown()} · ${NOTICE_TAG}` : 'No shutoff notice';
  for (const id of ['run', 'reset', 'region']) setDisabled($('#' + id), S.running);
  $('#wholeBtn').hidden = S.stage < 4 || !S.plan;
}

/* ---------- right panel ---------- */
// Re-rendering replaces the focused control: focus its new copy, else its row, else the fallback.
function keepFocus(fn, fallback = '#filter') {
  const a = document.activeElement, k = a?.dataset?.k, row = a?.closest?.('.pt')?.dataset.id;
  fn();
  if (!k || a.isConnected) return;
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
function renderAll() { renderTop(); renderRail(); renderPanel(); }
function renderPanel() {
  keepFocus(() => keepAudio(() => {
    const el = $('#panel');
    if (S.stage >= 4 && S.plan) { el.innerHTML = planHTML(); return; }
    el.innerHTML = keyCard() + (S.event ? eventHTML() : '') + homeHTML() + (S.event ? '' : howHTML());
  }));
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
      ${n != null ? `<dt>Patients with sessions in the window</dt><dd class="m">${n}</dd>` : ''}
    </dl></section>`;
}
function howHTML() {
  const note = isTour() ? 'The tour computes every step in this page. It makes no AWS call.' : 'Steps 2 to 5 run in one AWS Lambda request; the rail replays them with their real times.';
  return `<section class="sec how"><h2>How the run works</h2><ol>
    ${PHASES.map((p, i) => `<li><span class="n m">${i + 1}</span><div><b>${esc(p.name)}</b><span class="svc2">${esc(p.svc)}</span><p>${esc(p.how)}</p></div></li>`).join('')}
    </ol><p class="small">${note} Press Run demo to start. Every step shows the service that did the work, its source and its time. Demo assumptions, not clinical guidance.</p></section>`;
}
function eventHTML() {
  const e = S.event, by = aiSrc(e.parse_source, 'Rules');
  return `<section class="sec"><h2>Shutoff notice<span class="tag n">${NOTICE_TAG}</span></h2>
    <dl class="facts">
      <dt>Event</dt><dd class="m">${esc(e.event_id)}</dd>
      <dt>Area</dt><dd>${esc(e.area_name)}</dd>
      <dt>Window</dt><dd>${esc(win())}</dd>
      <dt>Starts in</dt><dd class="m">${esc(countdown())}</dd>
      <dt>Issued</dt><dd>${esc(dt(e.issued_at))}</dd>
      <dt>Parsed by</dt><dd>${esc(`${by.svc} · ${by.src}`)}</dd>
    </dl>
    ${e.source_text ? `<details class="notice"><summary>Notice text</summary><pre>${esc(e.source_text)}</pre></details>` : ''}
  </section>`;
}
function planHTML() {
  const p = S.plan, c = counts(p), draft = p.patients.some(r => r.status === 'draft');
  const nd = S.diff ? Object.keys(S.diff).length : 0, waiting = S.phases[5]?.status === 'waiting';
  const opts = [['all', 'All patients'], ['early', 'Early session'], ['transfer', 'Transfer'], ['staff', 'Staff call']].concat(nd ? [['changed', 'Changed']] : []);
  const cell = (label, color, n) => `<div style="--c:var(${color})"><span>${label}</span><b>${n}</b></div>`;
  return `<div class="plan-h"><h2>Plan v${p.version} · ${draft ? 'draft' : 'approved'}</h2><span class="mute">${plural(p.patients.length, 'patient')}</span></div>
    <div class="cnt">${cell('Early session', '--green', c.early_session)}${cell('Transfer', '--blue', c.transfer)}${cell('Staff call', '--map-staff', c.hospital)}</div>
    ${p.summary ? `<p class="sum">${esc(p.summary)}</p>` : ''}
    <div class="acts">
      ${draft || S.approving ? `<button class="btn pri${waiting ? ' pulse' : ''}" type="button" data-act="approve" data-k="approve"${S.approving || S.running ? ' disabled' : ''}>${S.approving ? 'Approving…' : 'Approve all'}</button>`
        : `<p class="okline">${icon('ck')}Every row is approved</p>`}
      <label class="selw"><span class="vh">Show</span><select data-k="filter" id="filter">${opts.map(([v, l]) => `<option value="${v}"${S.filter === v ? ' selected' : ''}>${l}</option>`).join('')}</select>${icon('chev')}</label>
    </div>
    ${draft ? '<p class="note">Nothing goes out until staff approve.</p>' : ''}
    ${nd ? `<div class="chgbar"><span>${nd} changed in v${p.version}</span><button class="btn sec sm" type="button" data-act="ack" data-k="ack">Acknowledge changes</button></div>` : ''}
    <ul class="pts" id="pts" aria-label="Patients in rank order">${listHTML()}</ul>`;
}
function listHTML() {
  const list = rows().filter(FILTERS[S.filter] || FILTERS.all);
  return list.length ? list.map(rowHTML).join('') : '<li class="empty">No patients match this filter.</li>';
}
function renderList() { const ul = $('#pts'); if (ul) keepFocus(() => keepAudio(() => { ul.innerHTML = listHTML(); })); }
function changeWords(entries) {
  const f = Object.fromEntries(entries.map(e => [e.field, e])), out = [];
  const toStaff = f.action?.to === 'hospital';
  if (f.clinic_id) out.push(toStaff ? `Moved from ${cname(f.clinic_id.from)} to the staff call list` : `Moved from ${cname(f.clinic_id.from)} to ${cname(f.clinic_id.to)}`);
  if (f.action && !toStaff) out.push(`now ${ACTION[f.action.to]?.label.toLowerCase() || f.action.to}`);
  if (f.slot && !toStaff) out.push(f.slot.to ? `new time ${slotText(f.slot.to)}` : 'no chair');
  else if (f.pickup_time?.to && !f.clinic_id) out.push(`new pickup ${time(f.pickup_time.to)}`);
  if (!out.length) out.push(`Updated ${join(entries.map(e => FIELD[e.field] || e.field))}`);
  return cap(out.join(' · '));
}
function rowHTML(r) {
  const id = r.patient_id, open = S.expanded === id, chg = S.diff?.[id], a = ACTION[r.action] || ACTION.notify_only;
  const dest = r.clinic_id ? cname(r.clinic_id) : r.action === 'notify_only' ? 'Usual clinic' : 'No clinic';
  const when = r.slot ? `<span class="m">${esc(slotText(r.slot))}</span>` : r.action === 'hospital' ? '<span class="nochair">No chair fits</span>' : '';
  const ride = RIDE[r.ride] || cap(String(r.ride || '').replace(/_/g, ' '));
  const rideLine = r.pickup_time ? `${ride} · ${r.ride === 'self' ? 'leave by' : 'pickup'} ${time(r.pickup_time)}` : ride;
  const lang = S.langs[id] && S.langs[id] !== 'English' ? S.langs[id] : '';
  return `<li class="pt${chg ? ' chg' : ''}${S.selected === id ? ' sel' : ''}" data-id="${id}">
    <button class="rowb" type="button" data-act="row" data-id="${id}" data-k="row-${id}" aria-expanded="${open}">
      <span class="rk m">${r.rank}</span>
      <span class="rb">
        <span class="r1"><span class="nm">${esc(pname(id))}</span><span class="tag ${a.cls}">${a.label}</span></span>
        <span class="r2"><span>${esc(dest)}</span>${when}</span>
        <span class="r3"><span>${esc(rideLine)}</span><span>${lang ? `${esc(lang)} · ` : ''}<span class="s-${r.status}">${STATUS[r.status] || esc(r.status)}</span></span></span>
        ${chg ? `<span class="chgt"><span class="tag">Changed</span><span>${esc(changeWords(chg))}</span></span>` : ''}
      </span>
    </button>
    ${open ? detailHTML(r) : ''}
  </li>`;
}
function detailHTML(r) {
  const id = r.patient_id, langs = Object.keys(r.messages || {});
  const cur = langs.includes(S.msgLang[id]) ? S.msgLang[id] : langs.find(l => langName(l) === S.langs[id]) || langs[0];
  const move = r.action === 'early_session' || r.action === 'transfer';
  const drive = r.drive_minutes != null ? `${r.drive_minutes} min drive, ${r.drive_source === 'location_service' ? 'Amazon Location' : 'estimate'}` : '';
  const flags = (r.flags || []).map(f => FLAG[f] || cap(f.replace(/_/g, ' ')));
  return `<div class="pdet">
    ${r.reason_text ? `<p class="why">${esc(r.reason_text)}</p>` : ''}
    ${r.reasons?.length ? `<ul class="chips" aria-label="Reasons">${r.reasons.map(k => `<li>${esc(reasonWord(k))}</li>`).join('')}</ul>` : ''}
    <dl class="facts">
      ${r.affected_session ? `<dt>Affected session</dt><dd>${esc(dt(r.affected_session))}</dd>` : ''}
      ${r.slot ? `<dt>New session</dt><dd>${esc(slotText(r.slot))}, ${esc(cname(r.clinic_id))}</dd>` : ''}
      ${r.action === 'hospital' ? `<dt>Next step</dt><dd>A staff member calls this patient. Last resort: ${esc(cname(r.clinic_id))}.</dd>` : ''}
      ${drive ? `<dt>Drive</dt><dd>${esc(drive)}</dd>` : ''}
      ${r.book_today ? '<dt>Ride</dt><dd>Book the ride today</dd>' : ''}
      ${flags.length ? `<dt>Flags</dt><dd>${esc(flags.join(', '))}</dd>` : ''}
    </dl>
    ${langs.length ? `<div class="msg">
      <div class="langs" role="group" aria-label="Message language">${langs.map(l => `<button type="button" data-act="lang" data-id="${id}" data-lang="${l}" data-k="lang-${id}-${l}" aria-pressed="${l === cur}">${esc(langName(l))}</button>`).join('')}</div>
      <p class="msgt" lang="${esc(cur)}">${esc(r.messages[cur])}</p></div>` : ''}
    ${move ? actionsHTML(r, langs, cur) : ''}
    ${S.rowErr[id] ? `<p class="err" role="alert">${esc(S.rowErr[id])}</p>` : ''}
  </div>`;
}
function actionsHTML(r, langs, cur) {
  const id = r.patient_id, dis = S.busy[id] || S.running ? ' disabled' : '', ok = r.status === 'confirmed';
  let voiceUI = '';
  if (ok && isTour()) voiceUI = '<p class="small">Voice notes need the live region.</p>';
  else if (ok && langs.length) voiceUI = `<label class="selw sm"><span class="vh">Voice note language</span><select data-k="vl-${id}">${langs.map(l => `<option value="${l}"${l === cur ? ' selected' : ''}>${esc(langName(l))}</option>`).join('')}</select>${icon('chev')}</label>
    <button class="btn sec sm" type="button" data-act="voice" data-id="${id}" data-k="voice-${id}"${dis}><svg class="i fill"><use href="#i-play"/></svg>${S.busy[id] ? 'Making voice note…' : 'Play voice note'}</button>`;
  return `<div class="racts">
    ${ok ? '' : r.status === 'draft' ? `<button class="btn sec sm" type="button" disabled>${icon('ck')}Confirm after approval</button>`
      : `<button class="btn sec sm" type="button" data-act="confirm" data-id="${id}" data-k="cf-${id}"${dis}>${icon('ck')}Mark confirmed</button>`}
    ${r.status === 'declined' ? '' : `<button class="btn q sm" type="button" data-act="decline" data-id="${id}" data-k="dc-${id}"${dis}>Decline</button>`}
    ${voiceUI}
  </div>${S.audio[id] ? `<audio controls preload="auto" src="${esc(S.audio[id])}" data-id="${id}"></audio>` : ''}`;
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
  S.selected = id; S.expanded = id;
  M('selectPatient', id);
  if (!fromMap) M('focus', { patient: id });
  if (S.stage < 4) return;
  const r = S.plan.patients.find(x => x.patient_id === id);
  if (r && !(FILTERS[S.filter] || FILTERS.all)(r)) { S.filter = 'all'; renderPanel(); } else renderList();
  if (fromMap) openPanel(true);
  $(`#pts > .pt[data-id="${id}"]`)?.scrollIntoView({ block: fromMap ? 'center' : 'nearest', behavior: reduced.matches ? 'auto' : 'smooth' });
}

/* ---------- popovers, theme, drawers ---------- */
function openKey(msg) {
  $('#keyMsg').textContent = msg || ''; $('#keyMsg').hidden = !msg;
  $('#keyInput').value = store.get('lumenDemoKey') || '';
  const p = $('#keyPop');
  if (!p.matches(':popover-open')) p.showPopover();
  $('#keyInput').focus();
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set('lumenTheme', t);
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
  const lg = over($('#legend')), ctl = over($('.ctl')), pn = $('#panel').classList.contains('open') && over($('#panel'));
  if (lg) {  // the legend pads the side that costs the map less area
    const w = Math.round(lg.right - m.left) + 8, h = Math.round(m.bottom - lg.top) + 8;
    if (w / m.width < h / m.height) p.left = w; else p.bottom = h;
  }
  if (ctl) p.right = Math.round(m.right - ctl.left) + 8;
  if (pn) {  // a drawer or sheet that would leave under 160 px of map is left out, so fits still have room
    const sheet = pn.width >= m.width - 1, side = sheet ? 'bottom' : 'right';
    const v = Math.round(sheet ? m.bottom - pn.top : m.right - pn.left) + 8;
    if ((sheet ? m.height : m.width) - v >= 160) p[side] = Math.max(p[side], v);
  }
  const k = JSON.stringify(p);
  if (k !== padKey) { padKey = k; M('setPadding', p); }
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
  $('#wholeBtn').addEventListener('click', () => { S.selected = null; M('selectPatient', null); M('focus', 'flows', { all: true }); renderList(); });
  $('#animTog').addEventListener('click', e => {
    S.anim = !S.anim; M('setAnimation', S.anim);
    e.currentTarget.textContent = S.anim ? 'Pause animation' : 'Play animation';
  });
  $('#panel').addEventListener('transitionend', e => { if (e.target === e.currentTarget) padMap(); });
  const ro = new ResizeObserver(() => padMap());  // the legend and the controls change size too (toggle, Whole plan)
  for (const el of [$('#main'), $('#legend'), $('.ctl')]) ro.observe(el);
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
  $('#phases').addEventListener('click', e => { const b = e.target.closest('[data-retry]'); if (b) S.phases[b.dataset.retry]?.retry?.(); });
  $('#phases').addEventListener('toggle', e => { const d = e.target.closest?.('details[data-i]'); if (d) S.phases[d.dataset.i].open = d.open; }, true);
  $('#replan').addEventListener('submit', e => { e.preventDefault(); replan($('#instr').value); });
  $('#instr').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); replan($('#instr').value); } });
  $('#sugg').addEventListener('click', () => { $('#instr').value = $('#sugg').textContent; $('#instr').focus(); });
  $('#panel').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case 'row': S.expanded === id ? (S.expanded = null, renderList()) : selectRow(id, false); break;
      case 'lang': S.msgLang[id] = b.dataset.lang; renderList(); break;
      case 'confirm': edit(id, 'confirmed'); break;
      case 'decline': edit(id, 'declined'); break;
      case 'voice': voice(id); break;
      case 'approve': approveAll(); break;
      case 'ack': ack(); break;
      case 'key': openKey(); break;
    }
  });
  $('#panel').addEventListener('change', e => { if (e.target.id === 'filter') { S.filter = e.target.value; renderList(); } });
}
function onSelect(sel) {
  if (!sel) return;
  if (sel.type === 'patient') selectRow(sel.id, true);
  else if (sel.type === 'facility') M('focus', { facility: sel.id });
}

async function boot() {
  bind();
  resetPhases();
  $('#legend').open = $('#main').clientWidth >= 900;  // open only when the map has room for it
  const motion = () => { $('#animTog').hidden = reduced.matches; };  // reduced motion already stops the animation
  motion(); reduced.addEventListener('change', motion);
  S.B = live; indexFac();
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  setTheme(theme);
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
