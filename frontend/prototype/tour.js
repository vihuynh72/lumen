/* Lumen Santa Clara tour (window.LumenTour): the plan pipeline computed in the page, in the live API shapes
   (contracts/schemas). Ports backend/lumen affected, rank_fallback, match, text_fallback, replan_tools and approve. */
(function () {
  'use strict';

  // Copy of data/seed/rules.json points; reasons use these keys.
  const URGENCY = { session_in_window: 40, session_within_36h: 20, heart_failure: 15, missed_recently: 10 };
  const DIFFICULTY = { paratransit: 15, home_in_outage: 15, no_car: 10, lives_alone: 10, wheelchair: 10, limited_english: 5 };
  const EVENT = {
    event_id: 'PSPS-TOUR-SC', notice_type: 'warning', issued_at: '2026-10-26T08:30:00-07:00',
    start: '2026-10-27T18:00:00-07:00', end: '2026-10-29T12:00:00-07:00', area_name: 'East San José (Santa Clara County)',
    source_text: 'ILLUSTRATIVE PUBLIC SAFETY POWER SHUTOFF WARNING (Lumen tour, not a real utility notice)\n' +
      'Event ID: PSPS-TOUR-SC\nIssued: Monday, October 26, 2026, 8:30 AM PDT\nArea: East San José (Santa Clara County)\n' +
      'Estimated shutoff: Tuesday, October 27, 2026, 6:00 PM PDT\nEstimated restoration: Thursday, October 29, 2026, 12:00 PM PDT',
    parse_source: 'tour',
  };
  const HOSPITAL = { id: 'SCH1', name: 'Santa Clara Valley Medical Center', kind: 'hospital', lng: -121.9330, lat: 37.3140,
    home: false, stations: null, address: '751 S Bascom Ave' };
  const MIN = 60e3, PDT = 7 * 60 * MIN;  // every tour time falls in PDT (DST ends Nov 1, 2026)
  const NOW = Date.parse(EVENT.issued_at) + 30 * MIN;  // demo clock: issued_at + 30 min, as in the backend
  const SHIFT_MIN = { 1: 360, 2: 630, 3: 900, 4: 1170 };
  const PREF = { 1: [1, 2, 3, 4], 2: [2, 3, 1, 4], 3: [3, 4, 2, 1], 4: [4, 3, 2, 1] };  // same shift first, then nearest shifts (old prototype)
  const DAYS = { MWF: ['Mon', 'Wed', 'Fri'], TTS: ['Tue', 'Thu', 'Sat'] };
  const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const OPEN_SHARE = 0.125, DRIVE_CAP = 40, BUFFER = 15, CALLBACK = '555-0100';
  const LANG = { English: 'en', Spanish: 'es', Mandarin: 'zh', Cantonese: 'yue', Vietnamese: 'vi', Korean: 'ko', Tagalog: 'tl', Telugu: 'te' };
  const PHRASE = { missed_recently: 'recently missed a treatment', paratransit: 'rides paratransit', home_in_outage: 'lives inside the shutoff area',
    no_car: 'has no car', lives_alone: 'lives alone', wheelchair: 'uses a wheelchair', limited_english: 'needs an interpreter' };
  const DIFF_FIELDS = ['action', 'clinic_id', 'slot', 'drive_minutes', 'drive_source', 'pickup_time', 'book_today', 'flags', 'status', 'pinned'];
  const DECISION = ['action', 'clinic_id', 'slot'];
  const NUMBERS = { no: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const EDIT_STATUSES = ['approved', 'confirmed', 'declined', 'no_answer'];

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const iso = t => new Date(t - PDT).toISOString().slice(0, 19) + '-07:00';
  const local = t => new Date(t - PDT);  // read with getUTC*
  const at = (date, shift) => Date.parse(date + 'T00:00:00-07:00') + SHIFT_MIN[shift] * MIN;
  const clock = t => { const d = local(t), h = d.getUTCHours(); return `${(h + 11) % 12 + 1}:${pad(d.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`; };
  const weekday = t => WEEK[local(t).getUTCDay()];
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const words = s => s.split(/\s+/).length;
  const list = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];

  function km(a, b) {
    const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(x));
  }

  function inside(lng, lat, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  function build(data) {
    const t0 = performance.now(), timing = {};
    const step = (name, fn) => { const t = performance.now(); const out = fn(); timing[name] = Math.round(performance.now() - t); return out; };
    const centers = data.centers.features;
    const facilities = centers.map(f => ({ id: f.properties.id, name: f.properties.name, kind: 'dialysis', lng: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1], home: false, stations: f.properties.stations, address: f.properties.address }));
    const closedIds = centers.filter(f => f.properties.affected).map(f => f.properties.id);  // data order = the old prototype's AFF order
    facilities.find(f => f.id === closedIds[0]).home = true;
    facilities.push({ ...HOSPITAL });
    const fac = Object.fromEntries(facilities.map(f => [f.id, f]));
    const byIndex = Object.fromEntries(centers.map(f => [f.properties.index, f.properties]));  // patients name their center by index
    const props = Object.fromEntries(centers.map(f => [f.properties.id, f.properties]));
    const ring = data.outage.geometry.coordinates[0];  // shortcut: outer ring of one Polygon; upgrade if the tour gets a MultiPolygon

    const patients = data.patients.features.map((f, i) => {
      const p = f.properties, h = hash(p.id), center = byIndex[p.center];
      return { id: 'P' + pad(i + 1, 3), name: `${p.first_name} ${'ABCDEFGHJKLMNPRSTVW'[h % 19]}.`, lng: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1], language: LANG[p.language] || 'en', language_name: p.language, center_id: center.id,
        days: DAYS[h & 1 ? 'MWF' : 'TTS'], shift: 1 + (h >>> 1) % (center.late_shift ? 4 : 3), hours: 4,
        ride: p.flags.includes('car') ? 'paratransit' : 'self', flags: p.flags.slice(), risk: p.risk };  // flag "car" = no car
    });
    const byPid = Object.fromEntries(patients.map(p => [p.id, p]));

    // Open chairs: one station in eight per shift, Tue to Thu, at powered hemodialysis centers (25% left no staff calls at all).
    const receivers = facilities.filter(f => f.kind === 'dialysis' && !closedIds.includes(f.id) && f.stations > 0 && props[f.id].hemodialysis);
    const baseCap = new Map();
    for (const c of receivers) for (const date of ['2026-10-27', '2026-10-28', '2026-10-29'])
      for (const s of props[c.id].late_shift ? [1, 2, 3, 4] : [1, 2, 3])
        baseCap.set(`${c.id}|${date}|${s}`, Math.floor(c.stations * OPEN_SHARE));

    let sessions, near;
    const affected = step('affected', () => {
      const start = Date.parse(EVENT.start), end = Date.parse(EVENT.end), list = [];
      for (const p of patients) {
        if (!closedIds.includes(p.center_id)) continue;
        for (let d = 0; d < 5; d++) {  // the demo week, from the notice day on
          const date = iso(Date.parse('2026-10-26T12:00:00-07:00') + d * 1440 * MIN).slice(0, 10);
          const s = at(date, p.shift), e = s + p.hours * 60 * MIN;
          if (p.days.includes(WEEK[local(s).getUTCDay()].slice(0, 3)) && s < end && e > start) {
            list.push({ patient_id: p.id, clinic_id: p.center_id, start: iso(s), end: iso(e) });
            break;  // one affected session per patient: shifts last 4 h and the window is 42 h
          }
        }
      }
      sessions = Object.fromEntries(list.map(s => [s.patient_id, s]));
      const lead = Math.round((start - NOW) / 360e3) / 10;
      return { closed_clinic_ids: closedIds, sessions: list,
        home_in_outage: Object.fromEntries(patients.map(p => [p.id, inside(p.lng, p.lat, ring)])),
        mode: lead >= 24 ? 'early' : lead >= 6 ? 'transfer' : 'critical', lead_hours: lead, now: iso(NOW),
        window: { start: EVENT.start, end: EVENT.end } };
    });

    const ranked = step('rank', () => patients.filter(p => sessions[p.id]).map((p, i) => {
      const f = p.flags, start = Date.parse(sessions[p.id].start);
      const reasons = ['session_in_window'];
      if (start - NOW <= 36 * 60 * MIN) reasons.push('session_within_36h');
      if (f.includes('missed')) reasons.push('missed_recently');
      if (p.ride === 'paratransit') reasons.push('paratransit');
      if (affected.home_in_outage[p.id]) reasons.push('home_in_outage');
      if (f.includes('car')) reasons.push('no_car');
      if (f.includes('alone')) reasons.push('lives_alone');
      if (f.includes('chair')) reasons.push('wheelchair');
      if (f.includes('interp')) reasons.push('limited_english');
      const urgency = reasons.reduce((a, r) => a + (URGENCY[r] || 0), 0), difficulty = reasons.reduce((a, r) => a + (DIFFICULTY[r] || 0), 0);
      // The old prototype's risk score (adds potassium and fluid gain, which rules.json has no key for) breaks ties.
      return { row: { patient_id: p.id, urgency, difficulty, reasons }, key: [-urgency, -difficulty, -p.risk, start, i] };
    }).sort((a, b) => { for (let k = 0; k < 5; k++) if (a.key[k] !== b.key[k]) return a.key[k] - b.key[k]; return 0; })
      .map(({ row }, i) => ({ ...row, rank: i + 1 })));

    function blankRow(r) {
      const s = sessions[r.patient_id];
      return { patient_id: r.patient_id, rank: r.rank, urgency: r.urgency, difficulty: r.difficulty, reasons: r.reasons.slice(),
        reason_text: null, affected_session: s ? s.start : null, action: 'notify_only', clinic_id: null, slot: null, drive_minutes: null,
        drive_source: null, pickup_time: null, ride: byPid[r.patient_id].ride, book_today: false, flags: [], messages: {}, audio: {},
        status: 'draft', pinned: false };
    }

    // Same contract as backend match(): ranked rows in, {patients, overflow} out; locked rows keep their chairs.
    function match(rankRows, cap, locked) {
      const open = new Map(cap), rows = [], overflow = [];
      near = near || Object.fromEntries(patients.map(p => [p.id, receivers
        .map(c => ({ id: c.id, minutes: Math.round(km([p.lng, p.lat], [c.lng, c.lat]) * 1.3 / 45 * 60 + 5) }))
        .filter(c => c.minutes <= DRIVE_CAP).sort((a, b) => a.minutes - b.minutes || (a.id < b.id ? -1 : 1))]));
      for (const r of locked.values()) {
        if (r.status === 'declined' || !r.slot) continue;
        const k = `${r.clinic_id}|${r.slot.date}|${r.slot.shift}`;
        if (!(open.get(k) > 0)) throw new Error(`${r.patient_id} holds a chair at ${fac[r.clinic_id].name} that is no longer open.`);
        open.set(k, open.get(k) - 1);
      }
      const take = (row, p) => {
        const date = sessions[p.id].start.slice(0, 10);  // keep the usual day (old prototype)
        for (const shift of PREF[p.shift]) for (const c of near[p.id]) {
          const k = `${c.id}|${date}|${shift}`, start = at(date, shift), pickup = start - (c.minutes + BUFFER) * MIN;
          if (!(open.get(k) > 0) || pickup <= NOW) continue;
          open.set(k, open.get(k) - 1);
          // long_gap_after never applies: the new slot is on the usual day, so the next usual session is 2 days later
          Object.assign(row, { action: 'transfer', clinic_id: c.id, slot: { date, shift }, drive_minutes: c.minutes,
            drive_source: 'estimate', pickup_time: iso(pickup), book_today: p.ride === 'paratransit' });
          return true;
        }
        return false;
      };
      for (const r of rankRows) {
        const pid = r.patient_id, L = locked.get(pid);
        if (L && L.status !== 'declined') { rows.push(L); if (L.action === 'hospital') overflow.push(pid); continue; }
        const row = blankRow(r);
        if (L) {  // declined: no chair, a staff call, overflow; the action stays
          Object.assign(row, L, { clinic_id: null, slot: null, drive_minutes: null, drive_source: null, pickup_time: null,
            book_today: false, messages: {}, audio: {}, flags: ['staff_call'] });
          overflow.push(pid);
        } else if (sessions[pid] && !take(row, byPid[pid])) {
          Object.assign(row, { action: 'hospital', clinic_id: HOSPITAL.id, flags: ['staff_call'] });
          overflow.push(pid);
        }
        rows.push(row);
      }
      return { patients: rows, overflow };
    }

    function reasonText(row) {
      const day = weekday(Date.parse(row.affected_session));
      const head = row.reasons.includes('session_within_36h') ? `The ${day} session starts within 36 hours`
        : `The ${day} session falls in the shutoff window`;
      const say = parts => parts.length ? `${head}, and this patient ${list(parts)}.` : `${head}.`;
      const parts = [];
      for (const r of row.reasons) {
        if (!PHRASE[r] || (r === 'no_car' && row.reasons.includes('paratransit'))) continue;
        if (words(say(parts.concat(PHRASE[r]))) <= 20) parts.push(PHRASE[r]);
      }
      return say(parts);
    }

    function message(row) {  // backend text_fallback.message, with the name filled as in HTTP responses
      const p = byPid[row.patient_id], c = fac[row.clinic_id];
      const old = Date.parse(row.affected_session), next = at(row.slot.date, row.slot.shift), pickup = clock(Date.parse(row.pickup_time));
      const when = iso(next).slice(0, 10) === iso(old).slice(0, 10) ? clock(next)
        : `${weekday(next)}, ${MONTH[local(next).getUTCMonth()]} ${local(next).getUTCDate()}, ${clock(next)},`;
      const ride = row.ride === 'paratransit' ? `Paratransit picks you up at ${pickup}.` : `Please leave home by ${pickup}.`;
      return `${p.name}, this is ${fac[p.center_id].name.replace(/ Dialysis$/, '')}. A power shutoff moves your ${weekday(old)} treatment to ` +
        `${when} at ${c.name}, ${c.address.split(',')[0]}. ${ride} Questions? Call ${CALLBACK}.`;
    }

    function fillText(rows, only) {
      for (const r of rows) {
        if (only && !only.has(r.patient_id)) continue;
        if (r.affected_session) r.reason_text = reasonText(r);
        r.messages = r.slot && (r.action === 'transfer' || r.action === 'early_session') ? { en: message(r) } : {};
      }
    }

    function summary(rows) {  // backend text_fallback.fill
      const n = a => rows.filter(r => r.action === a).length, rides = rows.filter(r => r.book_today).length;
      return `${n('early_session')} patients dialyze early, ${n('transfer')} move to another clinic, ` +
        `and ${n('hospital')} need a staff call. Book ${rides} paratransit rides today.`;
    }

    const matched = step('match', () => match(ranked, baseCap, new Map()));
    step('text', () => fillText(matched.patients));
    const v1 = { event_id: EVENT.event_id, version: 1, created_at: iso(NOW), mode: affected.mode, lead_hours: affected.lead_hours,
      timing_ms: timing, patients: matched.patients, overflow: matched.overflow, audit: [], summary: summary(matched.patients),
      ai_sources: { text: 'fallback' } };
    timing.total = Math.max(Math.round(performance.now() - t0), timing.affected + timing.rank + timing.match + timing.text);

    let current = v1;  // the latest version; replan and approve build on it. Reset = LumenTour.build(data) again.
    const stamp = version => iso(NOW + (version - 1) * MIN);  // shortcut: one demo minute per version, not wall time

    function replan(instruction) {
      const t = performance.now();
      const m = /^\s*(.+?)\s+can only take (\d+|\w+) more(\s+patients?)?\W*$/i.exec(String(instruction || ''));
      const n = m && (/^\d+$/.test(m[2]) ? Number(m[2]) : NUMBERS[m[2].toLowerCase()]);
      if (n == null) throw new Error("The tour understands only '(center name) can only take N more'.");
      const name = m[1].trim().toLowerCase();
      const hits = facilities.filter(c => c.kind === 'dialysis' && c.name.toLowerCase().includes(name));
      const exact = hits.filter(c => c.name.toLowerCase() === name);
      if ((exact.length || hits.length) !== 1)
        throw new Error(`'${m[1].trim()}' matches ${hits.map(c => c.name).join(', ') || 'no center'}; use the full center name.`);
      const center = (exact.length ? exact : hits)[0];
      if (closedIds.includes(center.id)) throw new Error(`${center.name} is closed in this shutoff; name a receiving center.`);

      const old = current, work = structuredClone(old.patients);
      // N more = at most N visiting patients at that center across all slots: pinned and confirmed rows first, then rank order
      const keep = work.filter(r => r.clinic_id === center.id && r.slot && r.status !== 'declined')
        .sort((a, b) => (!(a.pinned || a.status === 'confirmed') - !(b.pinned || b.status === 'confirmed')) || a.rank - b.rank).slice(0, n);
      const cap = new Map(baseCap);
      for (const k of cap.keys()) if (k.startsWith(center.id + '|'))
        cap.set(k, keep.filter(r => `${center.id}|${r.slot.date}|${r.slot.shift}` === k).length);
      const locked = new Map(work.filter(r => r.pinned || ['confirmed', 'declined'].includes(r.status) || (r.slot && r.clinic_id !== center.id))
        .map(r => [r.patient_id, r]));
      const result = match(work.slice().sort((a, b) => a.rank - b.rank), cap, locked);
      const before = Object.fromEntries(old.patients.map(r => [r.patient_id, r]));
      const changed = new Set();
      for (const r of result.patients) {
        const o = before[r.patient_id];
        if (DECISION.every(k => same(r[k], o[k]))) Object.assign(r, structuredClone({ reason_text: o.reason_text, messages: o.messages, audio: o.audio, status: o.status }));
        else changed.add(r.patient_id);
      }
      const diff = [];
      for (const r of result.patients) for (const f of DIFF_FIELDS)
        if (!same(before[r.patient_id][f], r[f])) diff.push({ patient_id: r.patient_id, field: f, from: before[r.patient_id][f], to: r[f] });
      const tReplan = Math.round(performance.now() - t), tText = performance.now();
      fillText(result.patients, changed);
      const moved = new Set(diff.filter(d => d.field === 'clinic_id' && d.from === center.id).map(d => d.patient_id)).size;
      const toStaff = result.overflow.filter(id => !old.overflow.includes(id)).length;
      const count = (k, noun, one, many) => `${k} ${noun}${k === 1 ? '' : 's'} ${k === 1 ? one : many}`;
      const text = `${center.name} can take only ${n} more, so ${count(moved, 'patient', 'moves', 'move')} to other chairs or the staff call list. ` +
        `${count(toStaff, 'more patient', 'needs', 'need')} a staff call.`;
      const ts = stamp(old.version + 1);
      const timingMs = { replan: tReplan, text: Math.round(performance.now() - tText) };
      timingMs.total = Math.max(Math.round(performance.now() - t), timingMs.replan + timingMs.text);
      current = { ...old, version: old.version + 1, created_at: ts, timing_ms: timingMs, patients: result.patients, overflow: result.overflow,
        audit: old.audit.concat({ ts, actor: 'Rosa', change: `re-plan: ${String(instruction).trim().slice(0, 200)}` }), summary: text,
        ai_sources: { ...old.ai_sources, replan: 'fallback' } };
      return { plan: current, diff, summary: text };
    }

    function approve(patientIds, edits = []) {  // backend approve.apply; throws Error on a bad request
      const t = performance.now(), ids = patientIds === 'all' ? ['all'] : patientIds;
      if (!Array.isArray(ids)) throw new Error('patient_ids must be a list');
      if (!Array.isArray(edits)) throw new Error('edits must be a list');
      const next = structuredClone(current), ts = stamp(current.version + 1);
      const rows = new Map(next.patients.map(r => [r.patient_id, r]));
      const row = id => { if (!rows.has(id)) throw new Error(`unknown patient ${id}`); return rows.get(id); };
      const audit = change => next.audit.push({ ts, actor: 'Rosa', change });
      if (ids.includes('all')) {
        if (ids.length !== 1) throw new Error('"all" cannot be mixed with patient IDs');
        const drafts = next.patients.filter(r => r.status === 'draft');
        drafts.forEach(r => { r.status = 'approved'; });
        if (drafts.length) audit('approved all');  // a repeat "approve all" changes nothing, so it logs nothing
      } else {
        for (const id of ids) { const r = row(id); if (r.status === 'draft') { r.status = 'approved'; audit(`approved ${id}`); } }
      }
      for (const e of edits) {
        if (!e || typeof e !== 'object' || !('patient_id' in e)) throw new Error('each edit needs a patient_id');
        const r = row(e.patient_id);
        if ('pinned' in e && typeof e.pinned !== 'boolean') throw new Error(`${r.patient_id}: pinned must be true or false`);
        if ('status' in e && !EDIT_STATUSES.includes(e.status)) throw new Error(`${r.patient_id}: status must be one of ${EDIT_STATUSES.join(', ')}`);
        if ('pinned' in e && e.pinned !== r.pinned) { r.pinned = e.pinned; audit(`${r.pinned ? 'pinned' : 'unpinned'} ${r.patient_id}`); }
        if ('status' in e && e.status !== r.status) { r.status = e.status; audit(`${r.patient_id} status ${r.status}`); }
      }
      Object.assign(next, { version: current.version + 1, created_at: ts, timing_ms: { total: Math.round(performance.now() - t) } });
      return (current = next);
    }

    // The receiving center with the most transfers, for the rail's suggestion chip.
    const busiest = Object.entries(v1.patients.reduce((a, r) => (r.action === 'transfer' && (a[r.clinic_id] = (a[r.clinic_id] || 0) + 1), a), {}))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];

    return { facilities, patients, outage: data.outage, event: { ...EVENT }, affected, plan: v1, replan, approve,
      suggestion: busiest ? `${fac[busiest[0]].name} can only take four more` : '' };
  }

  window.LumenTour = { build };
})();
