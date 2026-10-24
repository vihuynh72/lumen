/* Lumen review and approve dialog (CONTRACT-v2 E4): window.LumenReview.
   app.js builds the row view models and does every write; this file shows them and calls back. */
(() => {
'use strict';
const COLOR = { early_session: '--map-early', transfer: '--map-transfer', hospital: '--map-staff', notify_only: '--mute' };
const ORDER = { early_session: 0, transfer: 1, hospital: 2, notify_only: 3 };
const STATUS_ORDER = { draft: 0, declined: 1, approved: 2, confirmed: 3 };
const FILTERS = [
  ['all', 'All', () => true],
  ['early', 'Early', r => r.action === 'early_session', '--map-early'],
  ['transfer', 'Transfer', r => r.action === 'transfer', '--map-transfer'],
  ['staff', 'Staff call', r => r.action === 'hospital', '--map-staff'],
  ['changed', 'Changed', r => !!r.changed],
  ['todo', 'Not approved', r => r.status === 'draft'],
];
const MON = 'JanFebMarAprMayJunJulAugSepOctNovDec';
const TIME = /(\d{1,2}):(\d{2})\s?([AP]M)/i;
const mins = s => { const m = TIME.exec(s || ''); return m ? (m[1] % 12 + (/p/i.test(m[3]) ? 12 : 0)) * 60 + +m[2] : Infinity; };
// shortcut: ignores the year, so a plan that crosses New Year sorts wrong; give rows a sortable time if that ever happens
const whenKey = s => { const m = /([A-Z][a-z]{2})\s+(\d{1,2})\b/.exec(s || ''), t = mins(s); return m && MON.includes(m[1]) ? MON.indexOf(m[1]) / 3 * 44640 + m[2] * 1440 + (t === Infinity ? 0 : t) : t; };
const COLS = [
  ['rank', 'Rank', r => r.rank ?? Infinity],
  ['name', 'Name', r => r.name || ''],
  ['lang', 'Language', r => r.langName || r.lang || ''],
  ['what', 'What happens', r => `${ORDER[r.action] ?? 9} ${r.what || ''}`],
  ['where', 'Where', r => r.where || ''],
  ['when', 'When', r => whenKey(r.when)],
  ['pickup', 'Pickup and ride', r => `${String(r.pickup || '').replace(TIME, '')} ${String(mins(r.pickup)).padStart(4, '0')}`],
  ['road', 'Road time', r => r.road?.minutes ?? Infinity],
  ['status', 'Status', r => STATUS_ORDER[r.status] ?? 9],
];
const coll = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
let dn = null; try { dn = new Intl.DisplayNames(['en'], { type: 'language' }); } catch { /* old browser: show the code */ }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const icon = id => `<svg class="i" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const SEARCH = '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2l3.3 3.3"/></svg>';
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const join = a => a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
const road = rd => `${Math.round(rd.minutes)} min · ${Math.round(rd.miles * 10) / 10} mi`;

let dlg = null, o = {}, rows = [], byId = new Map(), st = null, opener = null, detFor = null;
const $ = s => dlg.querySelector(s);
const sheet = matchMedia('(max-width: 1439px)');  // below this the detail pane is a sheet over the table
const fresh = () => ({ filter: 'all', q: '', sort: 'rank', dir: 1, sel: null, det: false, checked: new Set(),
  busyAll: '', busy: {}, err: '', rowErr: {}, lang: {}, voice: {} });
const setRows = list => { rows = Array.isArray(list) ? list : []; byId = new Map(rows.map(r => [r.id, r])); };
const say = t => { $('#rvLive').textContent = t; };
const nameBtn = id => $(`tr[data-id="${CSS.escape(id)}"] .rv-nm`);

function cmp(a, b, d) {
  if (a === b) return 0;
  if (a === Infinity) return 1;  // missing values stay last in both directions
  if (b === Infinity) return -1;
  return d * (typeof a === 'number' && typeof b === 'number' ? a - b : coll.compare(String(a), String(b)));
}
function visible() {
  const f = (FILTERS.find(x => x[0] === st.filter) || FILTERS[0])[2], q = fold(st.q.trim());
  const key = (COLS.find(c => c[0] === st.sort) || COLS[0])[2];
  return rows.filter(r => f(r) && (!q || fold(r.name).includes(q))).map(r => [key(r), r])
    .sort(([a, x], [b, y]) => cmp(a, b, st.dir) || (x.rank ?? 0) - (y.rank ?? 0)).map(p => p[1]);
}
function curLang(r) {
  const ls = Object.keys(r.messages || {}), p = st.lang[r.id];
  return ls.includes(p) ? p : ls.includes(r.lang) ? r.lang : ls[0] || r.lang || 'en';
}
function langLabel(code, r) {
  if (r.msgLabels && r.msgLabels[code]) return r.msgLabels[code];  // e.g. "Spanish · Template translation" in the tour
  if (code === r.lang && r.langName) return r.langName;
  try { return dn.of(code) || code; } catch { return code; }
}

function build() {
  dlg = document.createElement('dialog');
  dlg.className = 'rv';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-labelledby', 'rvH');
  dlg.innerHTML = `<header class="rv-h">
      <div><h2 id="rvH" tabindex="-1"><span id="rvT"></span><span class="tag am" id="rvTour" hidden>Illustrative tour</span></h2><p class="rv-sum" id="rvSum"></p></div>
      <button type="button" class="btn q" data-act="close" data-k="close">${icon('x')}Close</button>
    </header>
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
  $('#rvQ').addEventListener('input', e => { st.q = e.target.value; render(true); });
  dlg.addEventListener('cancel', e => { if (sheet.matches && st.det) { e.preventDefault(); back(); } });  // Esc closes the sheet first
  dlg.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); });
  sheet.addEventListener('change', () => { if (dlg.open) render(); });
}

// Re-rendering replaces the focused control: focus its new copy, else its row, else the title.
function keep(fn) {
  const a = document.activeElement, k = dlg.contains(a) ? a.dataset.k : null, row = a?.closest?.('tr[data-id]')?.dataset.id;
  const audio = $('#rvDet audio');
  fn();
  const n = audio && $('#rvDet audio');
  if (n && n.getAttribute('src') === audio.getAttribute('src')) n.replaceWith(audio);  // a playing voice note keeps playing
  if (!k || a.isConnected) return;
  const el = $(`[data-k="${CSS.escape(k)}"]`);
  (el && !el.disabled ? el : (row && nameBtn(row)) || $('#rvH')).focus({ preventScroll: true });
}

function render(top) {
  keep(() => {
    const vis = visible(), tw = $('#rvTw'), y = top ? 0 : tw.scrollTop, det = $('#rvDet'), dy = detFor === st.sel ? det.scrollTop : 0;
    const drafts = vis.filter(r => r.status === 'draft'), nOn = drafts.filter(r => st.checked.has(r.id)).length;
    $('#rvSum').textContent = summary();
    $('#rvChips').innerHTML = FILTERS.map(([k, l, f, c]) => `<button type="button" class="rv-chip${c ? ' dot' : ''}" data-act="filter" data-f="${k}" data-k="f-${k}" aria-pressed="${st.filter === k}"${c ? ` style="--c:var(${c})"` : ''}>${l}<span class="m">${rows.filter(f).length}</span></button>`).join('');
    $('#rvActs').innerHTML = actsHTML();
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
  const n = a => rows.filter(r => r.action === a).length, d = rows.filter(r => r.status === 'draft').length;
  const parts = [[n('early_session'), 'comes in early', 'come in early'], [n('transfer'), 'moves to another clinic', 'move to another clinic'],
    [n('hospital'), 'gets a staff call', 'get a staff call'], [n('notify_only'), 'gets a notice only', 'get a notice only']]
    .filter(p => p[0]).map(([k, one, many]) => `${k} ${k === 1 ? one : many}`);
  return `${count(rows.length, 'patient', 'patients')}: ${join(parts)}. ${d ? `${count(d, 'row', 'rows')} not approved yet.` : 'No rows wait for approval.'} Nothing goes out until staff approve.`;
}
function actsHTML() {
  const n = st.checked.size, b = st.busyAll, busy = b ? ' aria-disabled="true"' : '';
  const sel = `<button type="button" class="btn sec" data-act="apsel" data-k="apsel"${n ? busy : ' disabled'}>${b === 'sel' ? 'Approving…' : `Approve selected (${n})`}</button>`;
  return sel + (rows.some(r => r.status === 'draft')
    ? `<button type="button" class="btn pri" data-act="apall" data-k="apall"${busy}>${b === 'all' ? 'Approving…' : 'Approve all'}</button>`
    : `<p class="rv-ok">${icon('ck')}No rows wait for approval</p>`);
}
function headHTML(nd, nOn) {
  return `<tr role="row"><th role="columnheader" class="rv-c0"><input type="checkbox" data-act="ckall" data-k="ckall" aria-label="Select every shown row that needs approval"${nd && nOn === nd ? ' checked' : ''}${nd ? '' : ' disabled'}></th>${
    COLS.map(([k, l], i) => `<th role="columnheader"${i < 2 ? ` class="rv-c${i + 1}"` : ''}${st.sort === k ? ` aria-sort="${st.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button type="button" class="rv-sort" data-act="sort" data-sort="${k}" data-k="so-${k}">${k === 'rank' ? '<span aria-hidden="true">#</span><span class="vh">Rank</span>' : l}${icon('chev')}</button></th>`).join('')}</tr>`;
}
function rowHTML(r) {
  const id = esc(r.id), nm = esc(r.name), dis = st.busy[r.id] || st.busyAll ? ' aria-disabled="true"' : '';
  const rd = r.road ? `<span class="m">${Math.round(r.road.minutes)} min</span>${r.road.tooFar ? ' <span class="rv-far">Too far</span>' : ''}<br><span class="m mute">${Math.round(r.road.miles * 10) / 10} mi</span>` : '<span class="mute">Select to see</span>';
  return `<tr role="row" class="${r.changed ? 'rv-chgr' : ''}${st.sel === r.id ? ' rv-selr' : ''}" data-id="${id}"${st.sel === r.id ? ' aria-current="true"' : ''}>`
    + `<td role="cell" class="rv-c0 rv-f">${r.status === 'draft' ? `<input type="checkbox" data-act="ck" data-k="ck-${id}" aria-label="Select ${nm}"${st.checked.has(r.id) ? ' checked' : ''}>` : ''}</td>`
    + `<td role="cell" class="rv-c1 m rv-rk">${esc(r.rank)}</td>`
    + `<td role="cell" class="rv-c2 rv-f rv-col"><button type="button" class="rv-nm" data-act="sel" data-k="nm-${id}" aria-controls="rvDet">${nm}</button>${r.changed ? '<span class="tag rv-chg">Changed</span>' : ''}</td>`
    + `<td role="cell">${esc(r.langName || r.lang)}</td>`
    + `<td role="cell" title="${esc(r.what)}"><span class="rv-dot" style="--c:var(${COLOR[r.action] || '--mute'})"></span>${esc(r.what)}</td>`
    + `<td role="cell" title="${esc(r.where)}">${esc(r.where)}</td>`
    + `<td role="cell"${/\d/.test(r.when) ? ' class="m"' : ''}>${esc(r.when)}</td>`
    + `<td role="cell" title="${esc(r.pickup)}">${esc(r.pickup)}</td>`
    + `<td role="cell"${r.road ? ` title="${esc(road(r.road))} by road${r.road.tooFar ? ', over 40 min' : ''}"` : ''}>${rd}</td>`
    + `<td role="cell" class="rv-f rv-col"><span class="s-${esc(r.status)}">${esc(r.statusText)}</span>${r.status === 'declined' ? '' : `<button type="button" class="rv-dec" data-act="decline" data-k="dc-${id}"${dis}>${st.busy[r.id] === 'decline' ? 'Declining…' : `Decline<span class="vh"> ${nm}</span>`}</button>`}</td></tr>`;
}
function detHTML(r) {
  if (!r) return '<p class="rv-none">Select a patient to see why Lumen chose this plan, their message and their road route.</p>';
  const id = r.id, ls = Object.keys(r.messages || {}), cur = curLang(r), b = st.busy[id], dis = b || st.busyAll ? ' aria-disabled="true"' : '';
  const v = st.voice[id], rd = r.road, ck = icon('ck');
  const confirm = r.status === 'confirmed' ? `<p class="rv-ok">${ck}Confirmed</p>`
    : `<button type="button" class="btn sec sm" data-act="confirm" data-k="cf"${r.canConfirm ? dis : ' disabled aria-describedby="rvCfH"'}>${ck}${b === 'confirm' ? 'Saving…' : 'Mark confirmed'}</button>`;
  const voice = `<button type="button" class="btn sec sm" data-act="voice" data-k="vo"${r.canVoice ? (b ? ' aria-disabled="true"' : '') : ' disabled'}${r.voiceHint ? ' aria-describedby="rvVoH"' : ''}><svg class="i fill" aria-hidden="true"><use href="#i-play"/></svg>${b === 'voice' ? 'Making voice note…' : `Play voice note in ${esc(langLabel(cur, r))}`}</button>`;
  return `<button type="button" class="btn q sm rv-back" data-act="back" data-k="back">${icon('chev')}Back to the list</button>
    <div><h3 id="rvDH" tabindex="-1">${esc(r.name)}</h3>
      <p class="small"><span class="m">#${esc(r.rank)}</span> · ${esc(r.langName || r.lang)} · <span class="s-${esc(r.status)}">${esc(r.statusText)}</span></p></div>
    <div><p class="rv-dwhat"><span class="rv-dot" style="--c:var(${COLOR[r.action] || '--mute'})"></span>${esc(r.what)}</p>
      ${r.when ? `<p class="rv-when${/\d/.test(r.when) ? ' m' : ''}">${esc(r.when)}</p>` : ''}
      ${r.changed && r.changeText ? `<p class="chgt"><span class="tag">Changed</span><span>${esc(r.changeText)}</span></p>` : ''}</div>
    ${r.where ? `<div class="rv-route"><p class="rv-rt">${esc(r.name)} <span aria-hidden="true">→</span><span class="vh">to</span> ${esc(r.where)}</p>
      <p>${rd ? `<span class="m">${road(rd)}</span> by road` : 'Road time pending'}${r.pickup ? ` · ${esc(r.pickup)}` : ''}</p>
      ${rd?.tooFar ? '<p class="rv-far">Too far: over 40 min by road</p>' : ''}</div>` : ''}
    ${r.reasons?.length ? `<section><h4>Why this plan</h4><ul class="rv-why">${r.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
    <section><h4>Message to the patient</h4>${ls.length
      ? `${ls.length > 1 ? `<div class="langs" role="group" aria-label="Message language">${ls.map(l => `<button type="button" data-act="lang" data-lang="${esc(l)}" data-k="lg-${esc(l)}" aria-pressed="${l === cur}">${esc(langLabel(l, r))}</button>`).join('')}</div>` : ''}
        <p class="msgt" lang="${esc(cur)}">${esc(r.messages[cur])}</p>`
      : '<p class="small">No message for this patient yet.</p>'}</section>
    <div class="racts">${confirm}${voice}</div>
    ${!r.canConfirm && r.status !== 'confirmed' && r.confirmHint ? `<p class="small" id="rvCfH">${esc(r.confirmHint)}</p>` : ''}
    ${r.voiceHint ? `<p class="small" id="rvVoH">${esc(r.voiceHint)}</p>` : ''}
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
  say(`Approved ${count(n, 'patient', 'patients')}.`);
  if (dlg.open) render();
}
async function rowWrite(id, kind, fn, done) {
  const w = await write(id, kind, fn);
  if (w.ok && w.s === st) say(done);
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
  if (id && act === 'decline' && st.sel !== id) select(id, false);  // its result or error shows in the detail pane
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
    case 'decline': rowWrite(id, 'decline', () => o.onDecline(id), `Declined ${byId.get(id)?.name || ''}.`); break;
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
