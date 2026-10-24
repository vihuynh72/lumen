/* Lumen review and approve list (CONTRACT-v3 R2, R5): window.LumenReview.
   app.js builds the row view models and does every write; this file shows them and calls back. */
(() => {
'use strict';
const COLOR = { early_session: '--map-early', transfer: '--map-transfer', hospital: '--map-staff', notify_only: '--mute' };
const DO = { early_session: 'Comes in early', transfer: 'Moves', hospital: 'Staff will call', notify_only: 'Keeps usual session' };
const ORDER = { early_session: 0, transfer: 1, hospital: 2, notify_only: 3 };
const STATUS_ORDER = { draft: 0, declined: 1, approved: 2, confirmed: 3 };
const FILTERS = [
  ['all', 'All', () => true],
  ['todo', 'Needs approval', r => r.status === 'draft'],
  ['early', 'Comes in early', r => r.action === 'early_session', '--map-early'],
  ['transfer', 'Moves', r => r.action === 'transfer', '--map-transfer'],
  ['staff', 'Staff call', r => r.action === 'hospital', '--map-staff'],
  ['changed', 'Changed', r => !!r.changed],
];
const MON = 'JanFebMarAprMayJunJulAugSepOctNovDec';
const TIME = /(\d{1,2}):(\d{2})\s?([AP]M)/i;
const mins = s => { const m = TIME.exec(s || ''); return m ? (m[1] % 12 + (/p/i.test(m[3]) ? 12 : 0)) * 60 + +m[2] : Infinity; };
// shortcut: ignores the year, so a plan that crosses New Year sorts wrong; give rows a sortable time if that ever happens
const whenKey = s => { const m = /([A-Z][a-z]{2})\s+(\d{1,2})\b/.exec(s || ''), t = mins(s); return m && MON.includes(m[1]) ? MON.indexOf(m[1]) / 3 * 44640 + m[2] * 1440 + (t === Infinity ? 0 : t) : t; };
const RANK = r => r.rank ?? Infinity;  // the default order; no column shows it
const COLS = [
  ['name', 'Name', r => r.name || ''],
  ['lang', 'Language', r => r.langName || r.lang || ''],
  ['what', 'What happens', r => ORDER[r.action] ?? 9],
  ['where', 'Where', r => r.where || ''],
  ['when', 'When', r => whenKey(r.when)],
  ['pickup', 'Leave home / pickup', r => `${String(r.pickup || '').replace(TIME, '')} ${String(mins(r.pickup)).padStart(4, '0')}`],
  ['road', 'Drive', r => r.road?.minutes ?? Infinity],
  ['status', 'Status', r => STATUS_ORDER[r.status] ?? 9],
];
const coll = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
let dn = null; try { dn = new Intl.DisplayNames(['en'], { type: 'language' }); } catch { /* old browser: show the code */ }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const low = s => String(s).charAt(0).toLowerCase() + String(s).slice(1);
const icon = id => `<svg class="i" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const SEARCH = '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2l3.3 3.3"/></svg>';
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const dot = r => `<span class="rv-dot" style="--c:var(${COLOR[r.action] || '--mute'})"></span>`;

let dlg = null, o = {}, rows = [], byId = new Map(), st = null, opener = null, detFor = null;
const $ = s => dlg.querySelector(s);
const sheet = matchMedia('(max-width: 1799px)');  // below this the details are a sheet over the table, so the table keeps its full width
const fresh = () => ({ filter: 'all', q: '', sort: 'rank', dir: 1, sel: null, det: false, checked: new Set(), msgOpen: new Set(),
  busyAll: '', busy: {}, err: '', rowErr: {}, lang: {}, voice: {} });
const setRows = list => { rows = Array.isArray(list) ? list : []; byId = new Map(rows.map(r => [r.id, r])); };
const say = t => { $('#rvLive').textContent = t; };
const nameBtn = id => $(`tr[data-id="${CSS.escape(id)}"] .rv-nm`);
const done = () => rows.length > 0 && !rows.some(r => r.status === 'draft');

function cmp(a, b, d) {
  if (a === b) return 0;
  if (a === Infinity) return 1;  // missing values stay last in both directions
  if (b === Infinity) return -1;
  return d * (typeof a === 'number' && typeof b === 'number' ? a - b : coll.compare(String(a), String(b)));
}
function visible() {
  const f = (FILTERS.find(x => x[0] === st.filter) || FILTERS[0])[2], q = fold(st.q.trim());
  const key = (COLS.find(c => c[0] === st.sort) || [0, 0, RANK])[2];
  return rows.filter(r => f(r) && (!q || fold(r.name).includes(q))).map(r => [key(r), r])
    .sort(([a, x], [b, y]) => cmp(a, b, st.dir) || (x.rank ?? 0) - (y.rank ?? 0)).map(p => p[1]);
}
// The patient's language first, then English.
const msgLangs = r => Object.keys(r.messages || {}).sort((a, b) => (b === r.lang) - (a === r.lang));
function curLang(r) {
  const ls = msgLangs(r), p = st.lang[r.id];
  return ls.includes(p) ? p : ls[0] || r.lang || 'en';
}
function shortLang(code, r) {
  if (code === r.lang && r.langName) return r.langName;
  try { return dn.of(code) || code; } catch { return code; }
}
const langLabel = (code, r) => r.msgLabels?.[code] || shortLang(code, r);  // e.g. "Spanish · Template translation" in the tour

function build() {
  dlg = document.createElement('dialog');
  dlg.className = 'rv';
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-labelledby', 'rvH');
  dlg.innerHTML = `<header class="rv-h">
      <div><h2 id="rvH" tabindex="-1"><span id="rvT"></span><span class="tag am" id="rvTour" hidden>Illustrative tour</span></h2><p class="rv-sum" id="rvSum"></p></div>
      <button type="button" class="btn q" data-act="close" data-k="close">${icon('x')}Close</button>
    </header>
    <div class="rv-done" id="rvDone" hidden></div>
    <div class="rv-bar">
      <div class="rv-chips" id="rvChips" role="group" aria-label="Show"></div>
      <label class="rv-q"><span class="vh">Search patients by name</span>${SEARCH}<input type="search" id="rvQ" placeholder="Search by name" autocomplete="off" spellcheck="false"></label>
      <div class="rv-acts" id="rvActs"></div>
    </div>
    <p class="err rv-err" id="rvErr" role="alert" hidden></p>
    <div class="rv-body" id="rvBody">
      <div class="rv-tw" id="rvTw">
        <table class="rv-t" role="table" aria-labelledby="rvT" aria-describedby="rvSum"><thead role="rowgroup" id="rvHead"></thead><tbody role="rowgroup" id="rvRows"></tbody></table>
        <div class="rv-empty" id="rvEmpty" hidden><p>No patients match.</p><button type="button" class="btn sec sm" data-act="showall" data-k="showall">Show everyone</button></div>
      </div>
      <aside class="rv-det" id="rvDet" aria-label="Patient details"></aside>
    </div>
    <p class="vh" id="rvLive" aria-live="polite"></p>`;
  document.body.append(dlg);
  dlg.addEventListener('click', onClick);
  dlg.addEventListener('change', onChange);
  // toggle does not bubble: capture it so the message stays open across re-renders
  dlg.addEventListener('toggle', e => { const d = e.target; if (d.matches?.('.rv-msg')) st.msgOpen[d.open ? 'add' : 'delete'](d.dataset.id); }, true);
  $('#rvQ').addEventListener('input', e => { st.q = e.target.value; render(true); });
  dlg.addEventListener('cancel', e => { if (sheet.matches && st.det) { e.preventDefault(); back(); } });  // Esc closes the sheet first
  dlg.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); });
  sheet.addEventListener('change', () => { if (dlg.open) render(); });
}

// Re-rendering replaces the focused control: focus its new copy, else its row, else the card's or the list's title.
function keep(fn) {
  const a = document.activeElement, k = dlg.contains(a) ? a.dataset.k : null, row = a?.closest?.('tr[data-id]')?.dataset.id, inDet = $('#rvDet').contains(a);
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
    const vis = visible(), tw = $('#rvTw'), y = top ? 0 : tw.scrollTop, det = $('#rvDet'), dy = detFor === st.sel ? det.scrollTop : 0;
    const drafts = vis.filter(r => r.status === 'draft'), nOn = drafts.filter(r => st.checked.has(r.id)).length, ok = done();
    $('#rvSum').textContent = summary();
    $('#rvSum').hidden = ok;
    $('#rvDone').hidden = !ok;
    $('#rvDone').innerHTML = ok ? doneHTML() : '';
    // a filter with nobody in it is hidden, unless it is the one in use
    $('#rvChips').innerHTML = FILTERS.map(([k, l, f, c]) => [k, l, rows.filter(f).length, c])
      .filter(([k, , n]) => n || k === 'all' || k === st.filter)
      .map(([k, l, n, c]) => `<button type="button" class="rv-chip${c ? ' dot' : ''}" data-act="filter" data-f="${k}" data-k="f-${k}" aria-pressed="${st.filter === k}"${c ? ` style="--c:var(${c})"` : ''}>${l}<span class="m">${n}</span></button>`).join('');
    $('#rvActs').innerHTML = ok ? '' : actsHTML();
    $('#rvErr').textContent = st.err;
    $('#rvErr').hidden = !st.err;
    $('#rvHead').innerHTML = headHTML(drafts.length, nOn);
    $('#rvHead input').indeterminate = nOn > 0 && nOn < drafts.length;
    $('#rvRows').innerHTML = vis.map(rowHTML).join('');
    $('#rvEmpty').hidden = vis.length > 0;
    if (tw.scrollTop !== y) tw.scrollTo({ top: y, behavior: 'instant' });
    $('#rvBody').classList.toggle('rv-sheet', st.det && byId.has(st.sel));
    det.innerHTML = detHTML(byId.get(st.sel));
    if (det.scrollTop !== dy) det.scrollTo({ top: dy, behavior: 'instant' });
    detFor = st.sel;
  });
}
function summary() {
  if (!rows.length) return 'No patients in this plan.';
  const d = rows.filter(r => r.status === 'draft').length;
  return `${d} of ${rows.length} ${d === 1 ? 'needs' : 'need'} your approval. Nothing is sent until you approve.`;
}
function counts() {
  const n = f => rows.filter(f).length;
  return [[n(r => r.action === 'transfer'), 'moves', 'move'], [n(r => r.action === 'early_session'), 'comes in early', 'come in early'],
    [n(r => r.action === 'hospital'), 'needs a call', 'need a call'], [n(r => r.action === 'notify_only'), 'keeps their session', 'keep their session'],
    [n(r => r.status === 'declined'), 'declined', 'declined']]
    .filter(p => p[0]).map(([k, one, many]) => `${k} ${k === 1 ? one : many}`).join(' · ');
}
function doneHTML() {
  const dec = rows.some(r => r.status === 'declined'), b = st.busyAll === 'next';
  return `<span class="rv-done-i">${icon('ck')}</span>
    <div><p class="rv-done-h">${dec ? 'Every patient is reviewed' : 'Every patient is approved'}</p><p class="rv-done-c">${esc(o.successText || counts())}</p></div>
    ${typeof o.onNext === 'function' ? `<button type="button" class="btn pri" data-act="next" data-k="next"${b ? ' aria-disabled="true"' : ''}>${icon('send')}${b ? 'Sending voice notes…' : 'Send voice notes'}</button>` : ''}`;
}
function actsHTML() {
  const n = st.checked.size, b = st.busyAll, busy = b ? ' aria-disabled="true"' : '';
  return `<button type="button" class="btn sec" data-act="apsel" data-k="apsel"${n ? busy : ' disabled'}>${b === 'sel' ? 'Approving…' : `Approve selected (${n})`}</button>`
    + `<button type="button" class="btn pri" data-act="apall" data-k="apall"${busy}>${b === 'all' ? 'Approving…' : 'Approve all'}</button>`;
}
function headHTML(nd, nOn) {
  return `<tr role="row"><th role="columnheader" class="rv-c0"><input type="checkbox" data-act="ckall" data-k="ckall" aria-label="Select every shown patient who needs approval"${nd && nOn === nd ? ' checked' : ''}${nd ? '' : ' disabled'}></th>${
    COLS.map(([k, l], i) => `<th role="columnheader"${i ? '' : ' class="rv-c1"'}${st.sort === k ? ` aria-sort="${st.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button type="button" class="rv-sort" data-act="sort" data-sort="${k}" data-k="so-${k}">${l}${icon('chev')}</button></th>`).join('')}</tr>`;
}
function driveCell(r) {
  if (!r.where) return '';
  return r.road ? `<span class="m">${Math.round(r.road.minutes)} min</span>${r.road.tooFar ? '<span class="rv-far">Too far</span>' : ''}`
    : '<span aria-hidden="true">—</span><span class="vh">drive time not computed yet</span>';
}
function rowHTML(r) {
  const id = esc(r.id), sel = st.sel === r.id;
  return `<tr role="row" class="${r.changed ? 'rv-chgr' : ''}${sel ? ' rv-selr' : ''}" data-id="${id}"${sel ? ' aria-current="true"' : ''}>`
    + `<td role="cell" class="rv-c0">${r.status === 'draft' ? `<input type="checkbox" data-act="ck" data-k="ck-${id}" aria-label="Select ${esc(r.name)}"${st.checked.has(r.id) ? ' checked' : ''}>` : ''}</td>`
    + `<td role="cell" class="rv-c1"><button type="button" class="rv-nm" data-act="sel" data-k="nm-${id}" aria-controls="rvDet">${esc(r.name)}</button>${r.changed ? '<span class="rv-chg">Changed</span>' : ''}</td>`
    + `<td role="cell">${esc(r.langName || r.lang)}</td>`
    + `<td role="cell">${dot(r)}${esc(DO[r.action] || r.what)}</td>`
    + `<td role="cell" title="${esc(r.where)}">${esc(r.where)}</td>`
    + `<td role="cell"${/\d/.test(r.when) ? ' class="m"' : ''}>${esc(r.when)}</td>`
    + `<td role="cell" title="${esc(r.pickup)}">${esc(r.pickup)}</td>`
    + `<td role="cell">${driveCell(r)}</td>`
    + `<td role="cell"><span class="s-${esc(r.status)}">${esc(r.statusText)}</span></td></tr>`;
}
// R5: one clear card. Older row models without summary/leave/why still read (built from what, when, pickup, road, reasons).
function detHTML(r) {
  if (!r) return '<p class="rv-none">Select a patient to see their plan and their message.</p>';
  const id = r.id, ls = msgLangs(r), cur = curLang(r), b = st.busy[id], dis = b || st.busyAll ? ' aria-disabled="true"' : '';
  const v = st.voice[id], rd = r.road, ck = icon('ck');
  const big = r.summary || [r.what, r.when].filter(Boolean).join(' · ');
  const leave = r.leave ?? [r.pickup, rd && `${Math.round(rd.minutes)} min drive · ${Math.round(rd.miles * 10) / 10} mi`].filter(Boolean).join(' · ');
  const whyIs = `Why ${r.rank === 1 ? 'first' : `number ${r.rank}`}: `;  // app.js sends the whole line ("Why number 2: ..."); older rows send reasons
  const why = r.why ? (/^why\b/i.test(r.why) ? r.why : whyIs + r.why) : r.reasons?.length ? whyIs + r.reasons.slice(0, 3).map(low).join(', ') : '';
  const confirm = r.status === 'confirmed' ? `<p class="rv-ok">${ck}Confirmed</p>`
    : `<button type="button" class="btn sec sm" data-act="confirm" data-k="cf"${r.canConfirm ? dis : ' disabled aria-describedby="rvCfH"'}>${ck}${b === 'confirm' ? 'Saving…' : 'Mark confirmed'}</button>`;
  const voice = `<button type="button" class="btn sec sm" data-act="voice" data-k="vo"${r.canVoice ? (b ? ' aria-disabled="true"' : '') : ' disabled'}${r.voiceHint ? ' aria-describedby="rvVoH"' : ''}><svg class="i fill" aria-hidden="true"><use href="#i-play"/></svg>${b === 'voice' ? 'Making voice note…' : `Play voice note in ${esc(shortLang(cur, r))}`}</button>`;
  const decline = r.status === 'declined' ? '' : `<button type="button" class="btn q sm" data-act="decline" data-k="dc"${dis}>${b === 'decline' ? 'Declining…' : 'Decline'}</button>`;
  return `<button type="button" class="btn q sm rv-back" data-act="back" data-k="back">${icon('chev')}Back to the list</button>
    <div><h3 id="rvDH" tabindex="-1">${esc(r.name)}</h3>
      <p class="rv-sub">${esc(r.langName || shortLang(r.lang, r))} · <span class="s-${esc(r.status)}">${esc(r.statusText)}</span></p></div>
    <div class="rv-card">
      <p class="rv-big">${dot(r)}${esc(big)}</p>
      ${leave ? `<p>${esc(leave)}</p>` : ''}
      ${why ? `<p>${esc(why)}</p>` : ''}
      ${r.gap ? '<p class="small">Long gap after this session</p>' : ''}
      ${r.changed && r.changeText ? `<p class="rv-chgn">Changed: ${esc(low(r.changeText))}</p>` : ''}
    </div>
    ${ls.length ? `<details class="rv-msg" data-id="${esc(id)}"${st.msgOpen.has(id) ? ' open' : ''}><summary data-k="msg">${icon('chev')}Message · ${esc(ls.map(l => shortLang(l, r)).join(', '))}</summary>
      ${ls.length > 1 ? `<div class="langs" role="group" aria-label="Message language">${ls.map(l => `<button type="button" data-act="lang" data-lang="${esc(l)}" data-k="lg-${esc(l)}" aria-pressed="${l === cur}">${esc(langLabel(l, r))}</button>`).join('')}</div>` : ''}
      <p class="msgt" lang="${esc(cur)}">${esc(r.messages[cur])}</p></details>`
      : '<p class="small">No message for this patient yet.</p>'}
    <div class="rv-do"><div class="racts">${confirm}${voice}${decline}</div>
    ${!r.canConfirm && r.status !== 'confirmed' && r.confirmHint ? `<p class="small" id="rvCfH">${esc(r.confirmHint)}</p>` : ''}
    ${r.voiceHint ? `<p class="small" id="rvVoH">${esc(r.voiceHint)}</p>` : ''}</div>
    ${v ? `<div class="rv-voice"><p class="small">${v.url ? 'Voice note' : 'No voice note'} in ${esc(langLabel(v.lang, r))}</p>
      ${v.url ? `<audio controls preload="auto" src="${esc(v.url)}"></audio>` : ''}
      ${v.text && v.text !== r.messages?.[v.lang] ? `<p class="small">${v.url ? 'What it says' : 'Translated message'}</p><p class="msgt" lang="${esc(v.lang)}">${esc(v.text)}</p>` : ''}
      ${v.note ? `<p class="small">${esc(v.note)}</p>` : ''}</div>` : ''}
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
async function approve(ids) {
  const n = ids === 'all' ? rows.filter(r => r.status === 'draft').length : ids.length;
  const w = await write(null, ids === 'all' ? 'all' : 'sel', () => o.onApprove(ids));
  if (!w.ok || w.s !== st) return;
  st.checked.clear();
  if (done() && st.filter === 'todo') st.filter = 'all';  // nobody left to show there
  if (dlg.open) render();
  if (!done()) return say(`Approved ${count(n, 'patient', 'patients')}.`);
  say(`Every patient is ${rows.some(r => r.status === 'declined') ? 'reviewed' : 'approved'}.`);
  $('[data-k="next"]')?.focus();  // the next step
}
async function rowWrite(id, kind, fn, msg) {
  const w = await write(id, kind, fn);
  if (w.ok && w.s === st) say(msg);
}
async function voice(id) {
  const r = byId.get(id); if (!r) return;
  const lang = curLang(r), label = langLabel(lang, r), w = await write(id, 'voice', () => o.onVoice(id, lang));
  if (!w.ok || w.s !== st) return;
  st.voice[id] = { lang, ...(w.res || {}) };
  render();
  const a = st.voice[id].url && $('#rvDet audio');
  if (a) a.play().catch(() => { /* autoplay blocked: the controls are there */ });
  say(st.voice[id].url ? `Voice note in ${label} is ready.` : st.voice[id].note || `No voice note in ${label}.`);
}

function onClick(e) {
  const b = e.target.closest('[data-act]'), id = e.target.closest('tbody tr[data-id]')?.dataset.id;
  if (!b) { if (id) select(id, sheet.matches); return; }
  const act = b.dataset.act;
  if (act === 'ck' || act === 'ckall' || b.disabled || b.getAttribute('aria-disabled') === 'true') return;
  const r = byId.get(st.sel);
  switch (act) {
    case 'close': dlg.close(); break;
    case 'filter': st.filter = b.dataset.f; render(true); say(`Showing ${count(visible().length, 'patient', 'patients')}.`); break;
    case 'sort': st.dir = st.sort === b.dataset.sort ? -st.dir : 1; st.sort = b.dataset.sort; render(true); break;
    case 'showall': st.filter = 'all'; st.q = ''; $('#rvQ').value = ''; render(true); break;
    case 'sel': select(id, e.detail === 0 || sheet.matches); break;  // keyboard or sheet: move focus into the details
    case 'back': back(); break;
    case 'lang': st.lang[st.sel] = b.dataset.lang; render(); break;
    case 'apsel': approve([...st.checked]); break;
    case 'apall': approve('all'); break;
    case 'next': write(null, 'next', () => o.onNext()); break;
    case 'decline': if (r) rowWrite(r.id, 'decline', () => o.onDecline(r.id), `Declined ${r.name}.`); break;
    case 'confirm': if (r) rowWrite(r.id, 'confirm', () => o.onConfirm(r.id), `Confirmed ${r.name}.`); break;
    case 'voice': if (r) voice(r.id); break;
  }
}
function onChange(e) {
  const t = e.target, act = t.dataset.act;
  if (act === 'ck') { const id = t.closest('tr').dataset.id; if (t.checked) st.checked.add(id); else st.checked.delete(id); render(); }
  if (act === 'ckall') {
    const d = visible().filter(r => r.status === 'draft'), all = d.every(r => st.checked.has(r.id));
    for (const r of d) { if (all) st.checked.delete(r.id); else st.checked.add(r.id); }
    render();
  }
}

window.LumenReview = {
  // opts: {title, isTour, rows, opener, successText, onApprove(ids|'all'), onDecline(id), onConfirm(id), onVoice(id, lang), onSelect(id), onNext()}
  open(opts) {
    o = opts || {};
    opener = o.opener || document.activeElement;
    st = fresh();
    detFor = null;
    setRows(o.rows);
    if (!dlg) build();
    $('#rvT').textContent = o.title || 'Review and approve';
    $('#rvTour').hidden = !o.isTour;
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
    for (const id of st.checked) if (byId.get(id)?.status !== 'draft') st.checked.delete(id);
    if (dlg?.open) render();
  },
  close() { if (dlg?.open) dlg.close(); },
};
})();
