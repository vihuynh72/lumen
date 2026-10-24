/* Lumen "Approve and tell everyone" list (CONTRACT-v5 section 5; the patient card is CONTRACT-v3 R5 plus CONTRACT-v6 section 4,
   "What {first name} gets"): window.LumenReview.
   app.js builds the row view models and does every write; this file shows them and calls back.
   Switches stay local until the one press. */
(() => {
'use strict';
const COLOR = { early_session: '--map-early', transfer: '--map-transfer', hospital: '--map-staff', notify_only: '--mute' };
const GROUP = { early: ['Come in early here', '--map-early'], call: ['Need a phone call', '--map-staff'], keep: ['Keep their usual session', '--mute'] };
const ORDER = { early: 1, call: 2, keep: 3 };  // clinic groups first, biggest first
const MON = 'JanFebMarAprMayJunJulAugSepOctNovDec';
const TIME = /(\d{1,2}):(\d{2})\s?([AP]M)/i;
const mins = s => { const m = TIME.exec(s || ''); return m ? (m[1] % 12 + (/p/i.test(m[3]) ? 12 : 0)) * 60 + +m[2] : Infinity; };
// shortcut: ignores the year, so a plan that crosses New Year sorts wrong; give rows a sortable time if that ever happens
const whenKey = s => { const m = /([A-Z][a-z]{2})\s+(\d{1,2})\b/.exec(s || ''), t = mins(s); return m && MON.includes(m[1]) ? MON.indexOf(m[1]) / 3 * 44640 + m[2] * 1440 + (t === Infinity ? 0 : t) : t; };
const coll = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
let dn = null; try { dn = new Intl.DisplayNames(['en'], { type: 'language' }); } catch { /* old browser: show the code */ }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const low = s => String(s).charAt(0).toLowerCase() + String(s).slice(1);
const icon = id => `<svg class="i" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const SEARCH = '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2l3.3 3.3"/></svg>';
const DRAWN = '<svg class="i rv-draw" viewBox="0 0 16 16" aria-hidden="true"><path pathLength="1" d="M3.5 8.5l3 3 6-7"/></svg>';
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const and = a => a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// Row rules. Fields the app does not send yet (clinicId, callInstead) read as absent.
const isMove = r => r.action === 'early_session' || r.action === 'transfer';
const told = r => r.note?.status === 'sent' || r.note?.status === 'queued';
const callIn = r => !!(r.callInstead ?? r.flag?.callInstead);
const blocked = r => r.flag?.severity === 'block';
const hasMsg = r => Object.keys(r.messages || {}).length > 0;
// Grouped by destination, like the panel's "Where they go": a patient who did not answer keeps the slot, so stays in that clinic.
const toPhone = r => r.status === 'declined' || (!isMove(r) && r.action !== 'notify_only');
const groupOf = r => toPhone(r) ? 'call' : r.action === 'early_session' ? 'early' : r.action === 'transfer' ? `c:${r.clinicId ?? r.where ?? ''}` : 'keep';
const hospitalOf = r => r.action === 'hospital' && r.status !== 'declined' && r.where ? r.where.replace(/ if needed$/, '') : '';

let dlg = null, o = {}, rows = [], byId = new Map(), st = null, opener = null, detFor = null;
const $ = s => dlg.querySelector(s);
const fresh = () => ({ q: '', sel: null, det: false, voice: new Map(), held: new Set(), off: new Set(),
  busy: {}, busyAll: '', err: '', rowErr: {}, lang: {}, audio: {}, done: '' });
const setRows = list => { rows = Array.isArray(list) ? list : []; byId = new Map(rows.map(r => [r.id, r])); };
const say = t => { $('#rvLive').textContent = t; };
const nameBtn = id => $(`li[data-id="${CSS.escape(id)}"] .rv-nm`);
const held = r => st.held.has(r.id);
// Voice note on: what staff set, else on (off for the patients the plan check says to call instead). Held patients are not told.
const voiceOn = r => !held(r) && (st.voice.has(r.id) ? st.voice.get(r.id) : !callIn(r));
const canNote = r => isMove(r) && !toPhone(r) && r.status !== 'no_answer' && !told(r) && !blocked(r) && hasMsg(r);

function groups() {
  const by = new Map();
  for (const r of rows) { const k = groupOf(r); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  return [...by].map(([k, list]) => {
    list.sort((a, b) => { const x = whenKey(a.when), y = whenKey(b.when); return (x === y ? 0 : x === Infinity ? 1 : y === Infinity ? -1 : x - y) || (a.rank ?? 0) - (b.rank ?? 0); });
    const [name, color] = GROUP[k] || [list[0].where || 'Another clinic', '--map-transfer'], hosp = [...new Set(list.map(hospitalOf).filter(Boolean))];
    const sub = k === 'call' ? `Staff phone these patients.${hosp.length ? ` ${and(hosp)} ${hosp.length > 1 ? 'get' : 'gets'} their patient sheets.` : ''}` : '';
    return { k, list, name, color, sub };
  }).sort((a, b) => (ORDER[a.k] || 0) - (ORDER[b.k] || 0) || b.list.length - a.list.length || coll.compare(a.name, b.name));
}
// What the press will do, in numbers the footer says out loud.
// A clinic hears only about patients whose sheet is still to send: not held, not said no or no answer, not sent at an earlier press.
const sheet = r => !r.sheetSent && !held(r) && r.status !== 'declined' && r.status !== 'no_answer';
function plan() {
  const notes = rows.filter(r => canNote(r) && voiceOn(r)).length;
  const clinics = groups().filter(g => g.k.startsWith('c:') && !st.off.has(g.k) && g.list.some(sheet)).length;
  const hospitals = new Set(rows.filter(sheet).map(hospitalOf).filter(Boolean)).size;
  return { notes, clinics, hospitals };
}
function sayLine() {
  const { notes, clinics, hospitals } = plan(), b = n => `<b>${n}</b>`, parts = [], who = [];
  if (notes) parts.push(`sends ${b(notes)} ${notes === 1 ? "voice note in the patient's" : "voice notes in each patient's"} language`);
  if (clinics) who.push(`${b(clinics)} ${clinics === 1 ? 'clinic' : 'clinics'}`);
  if (hospitals) who.push(`${b(hospitals)} ${hospitals === 1 ? 'hospital' : 'hospitals'}`);
  if (who.length) parts.push(`tells ${who.join(' and ')}`);
  return parts.length ? `Approving ${parts.join(' and ')}.${notes ? ' Notes go out 8 AM to 8 PM.' : ''}` : 'Approving saves the plan. Nobody new is told.';
}

function build() {
  dlg = document.createElement('dialog');
  dlg.className = 'rv';
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-labelledby', 'rvH');
  dlg.innerHTML = `<header class="rv-h">
      <div class="rv-hd"><h2 id="rvH" tabindex="-1">Approve and tell everyone</h2><p class="rv-sum" id="rvSum">Everyone starts switched on. Switch off a patient or a clinic to leave them out.</p></div>
      <label class="rv-q"><span class="vh">Search patients by name</span>${SEARCH}<input type="search" id="rvQ" placeholder="Search by name" autocomplete="off" spellcheck="false"></label>
      <button type="button" class="btn q rv-x" data-act="close" data-k="close">${icon('x')}Close</button>
    </header>
    <div class="rv-body" id="rvBody">
      <div class="rv-tw" id="rvTw">
        <div class="rv-in">
          <div class="rv-colh" aria-hidden="true"><span>Patient</span><span>New day and time</span><span>Leaves home</span><span>Voice note</span></div>
          <div id="rvList"></div>
          <div class="rv-empty" id="rvEmpty" hidden><p>No patients match.</p><button type="button" class="btn sec sm" data-act="showall" data-k="showall">Show everyone</button></div>
        </div>
      </div>
      <aside class="rv-det" id="rvDet" aria-label="Patient details"></aside>
    </div>
    <footer class="rv-foot" id="rvFoot"></footer>
    <p class="vh" id="rvLive" aria-live="polite"></p>`;
  document.body.append(dlg);
  dlg.addEventListener('click', onClick);
  dlg.addEventListener('change', onChange);
  $('#rvQ').addEventListener('input', e => { st.q = e.target.value; render(true); });
  dlg.addEventListener('cancel', e => { if (st.det) { e.preventDefault(); back(); } });  // Esc closes the card, then the list
  dlg.addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation(); });  // and not the plan drawer behind it
  dlg.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); });
}

// Re-rendering replaces the focused control: focus its new copy, else its row, else the card's or the list's title.
function keep(fn) {
  const a = document.activeElement, k = dlg.contains(a) ? a.dataset.k : null, row = a?.closest?.('li[data-id]')?.dataset.id, inDet = $('#rvDet').contains(a);
  const audio = $('#rvDet audio');
  fn();
  const n = audio && $('#rvDet audio');
  if (n && n.getAttribute('src') === audio.getAttribute('src')) n.replaceWith(audio);  // a playing voice note keeps playing
  if (!k || a.isConnected) return;
  const el = $(`[data-k="${CSS.escape(k)}"]`);
  (el && !el.disabled ? el : (row && nameBtn(row)) || (inDet && $('#rvDH')) || $('#rvH')).focus({ preventScroll: true });
}

function render(top) {
  keep(() => {
    const tw = $('#rvTw'), y = top ? 0 : tw.scrollTop, det = $('#rvDet'), dy = detFor === st.sel ? det.scrollTop : 0;
    const q = fold(st.q.trim()), html = groups().map((g, i) => {
      const vis = q ? g.list.filter(r => fold(r.name).includes(q)) : g.list;
      return vis.length ? groupHTML(g, vis, i) : '';
    }).join('');
    $('#rvList').innerHTML = html;
    $('#rvEmpty').hidden = !!html;
    $('.rv-colh').hidden = !html;
    if (tw.scrollTop !== y) tw.scrollTo({ top: y, behavior: 'instant' });
    $('#rvBody').classList.toggle('rv-sheet', st.det && byId.has(st.sel));
    det.innerHTML = detHTML(byId.get(st.sel));
    if (det.scrollTop !== dy) det.scrollTo({ top: dy, behavior: 'instant' });
    detFor = st.sel;
    renderFoot();
  });
}
// Switches only change the footer: the switch itself is already right, and its knob keeps its motion.
function renderFoot() {
  keep(() => {
    const b = st.busyAll === 'go', can = typeof o.onApproveAndTell === 'function' || typeof o.onApprove === 'function';
    $('#rvFoot').innerHTML = st.done ? `<p class="rv-fin">${DRAWN}${esc(st.done)}</p>`
      : `<p class="rv-say">${sayLine()}</p>${st.err ? `<p class="err rv-ferr" role="alert">${esc(st.err)}</p>` : ''}
        <button type="button" class="btn pri rv-go" data-act="go" data-k="go"${can ? (b ? ' aria-disabled="true"' : '') : ' disabled'}>${b ? 'Approving and telling…' : 'Approve and tell everyone'}</button>`;
  });
}

const sw = (act, k, on, text, aria, attrs = '') => `<label class="rv-sw"><input type="checkbox" role="switch" data-act="${act}" data-k="${esc(k)}"${attrs}${on ? ' checked' : ''} aria-label="${esc(aria)}"><span class="rv-trk" aria-hidden="true"></span><span class="rv-swl">${text}</span></label>`;
function groupHTML(g, vis, i) {
  const clinic = g.k.startsWith('c:');
  return `<section class="rv-g" aria-labelledby="rvG${i}" style="--c:var(${g.color});--i:${i}">
    <header class="rv-gh"><span class="rv-gdot" aria-hidden="true"></span><h3 id="rvG${i}">${esc(g.name)}</h3><span class="rv-gn">${count(g.list.length, 'patient', 'patients')}</span>
      ${clinic ? sw('clinic', `cl-${g.k}`, !st.off.has(g.k), 'Tell clinic', `Tell clinic: ${g.name}`, ` data-g="${esc(g.k)}"`) : ''}</header>
    ${g.sub ? `<p class="rv-gs">${esc(g.sub)}</p>` : ''}
    <ul class="rv-rows">${vis.map(r => rowHTML(r, g.k)).join('')}</ul></section>`;
}
function rowHTML(r, k) {
  const id = esc(r.id), sel = st.sel === r.id, moved = k !== 'call' && k !== 'keep';
  const when = k === 'call' ? (r.status === 'declined' ? 'Said no' : r.status === 'no_answer' ? 'No answer' : 'No slot fits') : k === 'keep' ? 'Usual session' : r.when || '';
  const why = blocked(r) ? `<p class="rv-why rv-f-b"><b>Fix first:</b> ${esc(r.flag.text)}</p>`
    : moved && callIn(r) ? `<p class="rv-why rv-f-w"><b>Call instead:</b> ${esc(r.flag?.text || 'The plan check says to phone this patient.')}</p>` : '';
  return `<li class="rv-r${sel ? ' rv-selr' : ''}" data-id="${id}"${sel ? ' aria-current="true"' : ''}>
    <span class="rv-who"><button type="button" class="rv-nm" data-act="sel" data-k="nm-${id}" aria-controls="rvDet">${esc(r.name)}</button>
      <span class="rv-l2">${esc(r.langName || r.lang || '')}${r.changed ? ' · <b class="rv-chg">Changed</b>' : ''}</span></span>
    <span class="rv-when">${esc(when)}</span>
    <span class="rv-lv">${moved ? leaveHTML(r) : ''}</span>
    <span class="rv-v">${moved ? voiceHTML(r) : ''}</span>${why}</li>`;
}
// The leave or pickup time from the plan; phones show the word the column header says on desktop.
function leaveHTML(r) {
  const t = TIME.exec(r.pickup || ''), pick = /pickup/i.test(r.pickup || '');
  return t ? `<span class="rv-k">${pick ? 'Pickup at' : 'Leaves home'} </span>${esc(t[0])}${pick ? '<span class="rv-pk" aria-hidden="true"> pickup</span>' : ''}` : '';
}
function voiceHTML(r) {
  const word = (t, c) => `<span class="rv-w rv-w-${c}">${t}</span>`;
  if (held(r)) return word('On hold', 'hold');
  if (r.status === 'no_answer') return word('No answer', 'hold');
  if (r.status === 'confirmed') return word('Said yes', 'told');
  if (told(r)) return word(r.note.status === 'queued' ? 'Told at 8 AM' : 'Told', 'told');
  if (blocked(r)) return word('Fix first', 'fix');
  if (!hasMsg(r)) return word('No message', 'none');
  return sw('voice', `vo-${r.id}`, voiceOn(r), 'Voice note', `Voice note for ${r.name}`);
}

// The card's status word: the app's own word when it sends one.
function pill(r) {
  const k = held(r) ? 'held' : ['declined', 'no_answer', 'confirmed'].includes(r.status) ? r.status : told(r) ? 'told' : r.status === 'draft' ? 'draft' : r.callThese ? 'call' : 'approved';
  const t = k === 'held' ? 'On hold' : r.statusText || { declined: 'Said no', no_answer: 'No answer', confirmed: 'Said yes', told: 'Told', draft: 'To approve', call: 'Call', approved: 'Approved' }[k];
  return `<span class="rv-pill rv-p-${k}">${esc(t)}</span>`;
}
const msgLangs = r => Object.keys(r.messages || {}).sort((a, b) => (b === r.lang) - (a === r.lang));  // the patient's language first
function curLang(r) {
  const ls = msgLangs(r), p = st.lang[r.id];
  return ls.includes(p) ? p : ls[0] || r.lang || 'en';
}
function shortLang(code, r) {
  if (code === r.lang && r.langName) return r.langName;
  try { return dn.of(code) || code; } catch { return code; }
}
const langLabel = (code, r) => r.msgLabels?.[code] || shortLang(code, r);
const VOICED = new Set(['en', 'es', 'zh']);  // the languages Polly speaks for Lumen; other messages play in English or stay text
const hm = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });  // the plan's clock
const clock = s => { const d = s ? new Date(s) : null; return d && !isNaN(d) ? hm.format(d) : ''; };
// research/patients.md: Chinese-speaking patients keep the family name first; everyone else has the given name first.
const firstName = r => { const w = String(r.name || '').trim().split(/\s+/); return r.lang === 'zh' && w.length > 1 ? w.at(-1) : w[0]; };
// The line under the bubble, [kind, words]: the sent time, then what the patient said. Only moves get a voice note.
function receipt(r) {
  const n = r.note, t = n?.status === 'sent' ? ['Told', clock(n.sentAt)].filter(Boolean).join(' ') : '';
  if (r.status === 'declined') return ['no', [t, 'Said no'].filter(Boolean).join(' · ')];
  if (!isMove(r)) return null;
  if (r.status === 'confirmed') return ['yes', [t, 'Said yes'].filter(Boolean).join(' · ')];
  if (r.status === 'no_answer') return ['wait', [t, 'No answer'].filter(Boolean).join(' · ')];
  if (t) return ['told', t];
  if (n?.status === 'queued') return ['', `Sends at ${clock(n.sendAt) || '8:00 AM'}`];
  if (held(r)) return ['wait', 'On hold. Not sent.'];
  if (n?.status === 'stale') return ['', 'The plan changed. Not sent again yet.'];
  return ['', canNote(r) && voiceOn(r) ? 'Not sent yet' : blocked(r) ? 'Not sent. Fix the problem first.' : 'Not sent. Staff phone instead.'];
}
// R5: one clear card and its actions, then "What {first name} gets" (CONTRACT-v6 section 4): the text message as one bubble
// in the patient's language, its sent time and reply, and the voice note.
function detHTML(r) {
  if (!r) return '';
  const id = r.id, ls = msgLangs(r), cur = curLang(r), b = st.busy[id], dis = b || st.busyAll ? ' aria-disabled="true"' : '';
  const a = st.audio[id], ck = icon('ck'), h = held(r), rc = receipt(r), vl = !ls.length ? '' : VOICED.has(cur) ? cur : r.messages.en ? 'en' : '';
  const big = r.summary || [r.what, r.when].filter(Boolean).join(' · ');
  const why = r.why ? (/^why\b/i.test(r.why) ? r.why : `Why: ${r.why}`) : '';
  const hold = `<button type="button" class="btn q sm" data-act="hold" data-k="hd"${dis}>Hold</button>`;
  const first = h ? `<button type="button" class="btn sec sm" data-act="unhold" data-k="uh">Take off hold</button>`
    : r.status === 'draft' ? `<button type="button" class="btn sec sm" data-act="approve" data-k="ap"${dis}>${ck}${b === 'approve' ? 'Approving…' : 'Approve'}</button>${hold}`
    : `${r.canConfirm ? `<button type="button" class="btn sec sm" data-act="confirm" data-k="cf"${dis}>${ck}${b === 'confirm' ? 'Saving…' : 'Patient said yes'}</button>` : ''}${r.status === 'approved' && !told(r) ? hold : ''}`;
  const voice = vl ? `<button type="button" class="btn sec sm" data-act="voice" data-lang="${esc(vl)}" data-k="vo"${r.canVoice ? (b ? ' aria-disabled="true"' : '') : ' disabled'}${r.voiceHint ? ' aria-describedby="rvVoH"' : ''}><svg class="i fill" aria-hidden="true"><use href="#i-play"/></svg>${b === 'voice' ? 'Making voice note…' : vl === cur ? 'Play voice note' : 'Voice in English'}</button>` : '';
  const decline = r.status === 'declined' ? '' : `<button type="button" class="btn q sm" data-act="decline" data-k="dc"${dis}>${b === 'decline' ? 'Saving…' : 'Patient said no'}</button>`;
  return `<button type="button" class="btn q sm rv-back" data-act="back" data-k="back">${icon('chev')}Back to the list</button>
    <div><h3 id="rvDH" tabindex="-1">${esc(r.name)}</h3>
      <p class="rv-sub">${esc(r.langName || shortLang(r.lang, r))} ${pill(r)}</p></div>
    <div class="rv-card">
      <p class="rv-big"><span class="rv-dot" style="--c:var(${COLOR[r.action] || '--mute'})"></span>${esc(big)}</p>
      ${r.leave ? `<p>${esc(r.leave)}</p>` : ''}
      ${why ? `<p>${esc(why)}</p>` : ''}
      ${r.gap ? '<p class="small">Long gap after this session</p>' : ''}
      ${r.flag?.text ? `<p class="${blocked(r) ? 'rv-f-b' : 'rv-f-w'}"><b>${blocked(r) ? 'Fix first:' : callIn(r) ? 'Call instead:' : 'Look at:'}</b> ${esc(r.flag.text)}</p>` : ''}
      ${r.changed && r.changeText ? `<p class="rv-chgn">Changed: ${esc(low(r.changeText))}</p>` : ''}
    </div>
    <div class="rv-do"><div class="racts">${first}${decline}</div></div>
    <section class="rv-gets" aria-labelledby="rvGetsH"><h4 id="rvGetsH">What ${esc(firstName(r))} gets</h4>
      ${ls.length > 1 ? `<div class="langs" role="group" aria-label="Message language">${ls.map(l => `<button type="button" data-act="lang" data-lang="${esc(l)}" data-k="lg-${esc(l)}" aria-pressed="${l === cur}">${esc(langLabel(l, r))}</button>`).join('')}</div>` : ''}
      ${ls.length ? `<p class="rv-bub${rc && r.note?.status !== 'sent' ? ' rv-unsent' : ''}" lang="${esc(cur)}">${esc(r.messages[cur])}</p>
        ${rc ? `<p class="rv-rc rv-rc-${rc[0] || 'not'}">${rc[0] === 'told' || rc[0] === 'yes' ? ck : ''}${esc(rc[1])}</p>` : ''}`
        : `<p class="small">${toPhone(r) ? `No text message. Staff phone ${esc(firstName(r))}.` : 'No message for this patient yet.'}</p>`}
      ${voice ? `<div class="racts">${voice}</div>` : ''}
      ${voice && r.voiceHint ? `<p class="small" id="rvVoH">${esc(r.voiceHint)}</p>` : ''}
      ${a ? `<div class="rv-voice"><p class="small">${a.url ? 'Voice note' : 'No voice note'} in ${esc(langLabel(a.lang, r))}</p>
        ${a.url ? `<audio controls preload="auto" src="${esc(a.url)}"></audio>` : ''}
        ${a.text && a.text !== r.messages?.[a.lang] ? `<p class="small">${a.url ? 'What it says' : 'Translated message'}</p><p class="msgt" lang="${esc(a.lang)}">${esc(a.text)}</p>` : ''}
        ${a.note ? `<p class="small">${esc(a.note)}</p>` : ''}</div>` : ''}
    </section>
    ${st.rowErr[id] ? `<p class="err" role="alert">${esc(st.rowErr[id])}</p>` : ''}`;
}

function select(id, focus) {
  const same = st.sel === id;
  st.sel = id; st.det = true;
  render();
  if (!same) o.onSelect?.(id);
  if (focus) $('#rvDH')?.focus();
}
function back() {
  const id = st.sel;
  st.det = false;
  render();
  (id && nameBtn(id) || $('#rvH')).focus();
}
async function write(id, kind, fn) {
  const s = st;
  if (id) { s.busy[id] = kind; delete s.rowErr[id]; } else { s.busyAll = kind; s.err = ''; }
  render();
  try { return { ok: true, res: await fn(), s }; } catch (e) {
    const m = e?.message || 'That did not work. Try again.';
    if (id) s.rowErr[id] = m; else s.err = m;
    if (s === st) say(m);
    return { ok: false, s };
  } finally {
    if (id) delete s.busy[id]; else s.busyAll = '';
    if (s === st && dlg.open) render();
  }
}
async function rowWrite(id, kind, fn, msg) {
  const w = await write(id, kind, fn);
  if (w.ok && w.s === st) say(msg);
}
async function voice(id, lang) {
  const r = byId.get(id); if (!r) return;
  const label = langLabel(lang, r), w = await write(id, 'voice', () => o.onVoice(id, lang));
  if (!w.ok || w.s !== st) return;
  st.audio[id] = { lang, ...(w.res || {}) };
  render();
  const a = st.audio[id].url && $('#rvDet audio');
  if (a) a.play().catch(() => { /* autoplay blocked: the controls are there */ });
  say(st.audio[id].url ? `Voice note in ${label} is ready.` : st.audio[id].note || `No voice note in ${label}.`);
}
// The one press. Held patients go in `hold` (app.js keeps them to approve) and in voiceOff, so they get no voice note.
async function go() {
  const tell = typeof o.onApproveAndTell === 'function', live = new Set(groups().map(g => g.k));
  const voiceOff = rows.filter(r => isMove(r) && !voiceOn(r)).map(r => r.id);
  const clinicsOff = [...st.off].filter(k => live.has(k)).map(k => k.slice(2));
  const w = await write(null, 'go', () => tell ? o.onApproveAndTell({ voiceOff, clinicsOff, hold: [...st.held] }) : o.onApprove('all'));
  if (!w.ok || w.s !== st) return;
  const s = st;
  st.done = tell ? 'Done. Lumen is telling everyone.' : 'Done. Every patient is approved.';
  st.det = false;
  render();
  dlg.classList.add('rv-told');  // each destination pings once: the notes and sheets go out
  say(st.done);
  setTimeout(() => { if (st === s && dlg.open) dlg.close(); }, reduced.matches ? 1200 : 1800);
}

function onClick(e) {
  if (e.target.closest('.rv-sw')) return;  // the switch, not the row
  const b = e.target.closest('[data-act]'), id = e.target.closest('li[data-id]')?.dataset.id;
  if (!b) { if (id) select(id, true); return; }
  if (b.disabled || b.getAttribute('aria-disabled') === 'true') return;
  const r = byId.get(st.sel);
  switch (b.dataset.act) {
    case 'close': dlg.close(); break;
    case 'showall': st.q = ''; $('#rvQ').value = ''; render(true); break;
    case 'sel': select(id, true); break;
    case 'back': back(); break;
    case 'lang': st.lang[st.sel] = b.dataset.lang; render(); break;
    case 'go': go(); break;
    case 'approve': if (r) rowWrite(r.id, 'approve', () => o.onApprove([r.id]), `Approved ${r.name}.`); break;
    case 'hold': if (r) { st.held.add(r.id); render(); $('[data-k="uh"]').focus(); say(`${r.name} is on hold. They get no voice note.`); } break;
    case 'unhold': if (r) { st.held.delete(r.id); render(); ($('[data-k="hd"]') || $('#rvDH')).focus(); say(`${r.name} is off hold.`); } break;
    case 'decline': if (r) rowWrite(r.id, 'decline', () => o.onDecline(r.id), `${r.name} said no.`); break;
    case 'confirm': if (r) rowWrite(r.id, 'confirm', () => o.onConfirm(r.id), `${r.name} said yes.`); break;
    case 'voice': if (r) voice(r.id, b.dataset.lang); break;
  }
}
function onChange(e) {
  const t = e.target;
  if (t.dataset.act === 'voice') st.voice.set(t.closest('li').dataset.id, t.checked);
  else if (t.dataset.act === 'clinic') st.off[t.checked ? 'delete' : 'add'](t.dataset.g);
  else return;
  st.err = '';
  renderFoot();
}

window.LumenReview = {
  // opts: {rows, opener, onApproveAndTell({voiceOff, clinicsOff, hold}) -> Promise, onApprove(ids|'all'), onDecline(id), onConfirm(id),
  //   onVoice(id, lang), onSelect(id)}. Without onApproveAndTell the press only approves. title, isTour, onSend, onNext: accepted, not used.
  // Rows: as CONTRACT-v4 2.3, plus optional clinicId (the clinicsOff value; the clinic name stands in without it), callInstead
  //   and sheetSent (the clinic already has this patient's sheet).
  open(opts) {
    o = opts || {};
    opener = o.opener || document.activeElement;
    st = fresh();
    detFor = null;
    setRows(o.rows);
    if (!dlg) build();
    dlg.classList.remove('rv-told');
    $('#rvQ').value = '';
    $('#rvLive').textContent = '';
    render(true);
    if (!dlg.open) dlg.showModal();
    $('#rvH').focus();
  },
  update(list) {
    setRows(list);
    if (!st) return;
    if (st.sel && !byId.has(st.sel)) { st.sel = null; st.det = false; }
    for (const id of [...st.held, ...st.voice.keys()]) if (!byId.has(id)) { st.held.delete(id); st.voice.delete(id); }  // rows that left the plan
    if (dlg?.open) render();
  },
  close() { if (dlg?.open) dlg.close(); },
};
})();
