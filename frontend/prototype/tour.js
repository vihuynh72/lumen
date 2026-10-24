/* Lumen Santa Clara tour (window.LumenTour): the plan pipeline computed in the page, in the live API shapes
   (contracts/schemas). Ports backend/lumen affected, rank_fallback, match, text_fallback, replan_tools, approve, check and notify. */
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
  // Template translations for patient messages (tour only). d is a local Date read with getUTC*.
  // v: {name, home, clinic, street, callback, oldDay, day, m, dd, t (new time), same (same date), ride}
  const hm = d => `${(d.getUTCHours() + 11) % 12 + 1}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const BUWAN = ['Enero', 'Pebrero', 'Marso', 'Abril', 'Mayo', 'Hunyo', 'Hulyo', 'Agosto', 'Setyembre', 'Oktubre', 'Nobyembre', 'Disyembre'];
  const alas = t => (t.startsWith('1:') ? 'a la ' : 'a las ') + t;
  const L10N = {
    es: {
      days: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
      time: d => `${hm(d)} ${d.getUTCHours() < 12 ? 'a. m.' : 'p. m.'}`,
      para: t => `El paratránsito pasará por usted ${alas(t)}.`,
      leave: t => `Salga de su casa a más tardar ${alas(t)}.`,
      text: v => `${v.name}, le habla ${v.home}. Un corte de electricidad programado cambia su tratamiento del ${v.oldDay} ` +
        (v.same ? alas(v.t) : `al ${v.day} ${v.dd} de ${MES[v.m - 1]}, ${alas(v.t)}`) +
        `, en ${v.clinic}, ${v.street}. ${v.ride} ¿Preguntas? Llame al ${v.callback}.`,
    },
    zh: {
      days: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
      time: d => `${d.getUTCHours() < 12 ? '上午' : '下午'}${hm(d)}`,
      para: t => `辅助交通车将于${t}来接您。`,
      leave: t => `请于${t}前出门。`,
      text: v => `${v.name}，您好，这里是${v.home}。由于计划停电，您${v.oldDay}的透析治疗改到` +
        (v.same ? `当天${v.t}` : `${v.m}月${v.dd}日（${v.day}）${v.t}`) +
        `，地点：${v.clinic}（${v.street}）。${v.ride}如有疑问，请致电 ${v.callback}。`,
    },
    yue: {
      days: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
      time: d => `${d.getUTCHours() < 12 ? '上午' : '下午'}${hm(d)}`,
      para: t => `復康巴士會喺${t}嚟接你。`,
      leave: t => `請喺${t}之前出門。`,
      text: v => `${v.name}，你好，呢度係${v.home}。因為計劃停電，你${v.oldDay}嘅洗腎療程改咗去` +
        (v.same ? `當日${v.t}` : `${v.m}月${v.dd}日（${v.day}）${v.t}`) +
        `，地點：${v.clinic}（${v.street}）。${v.ride}如有疑問，請致電 ${v.callback}。`,
    },
    ko: {
      days: ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'],
      time: d => `${d.getUTCHours() < 12 ? '오전' : '오후'} ${hm(d)}`,
      para: t => `장애인 교통 서비스 차량이 ${t}에 모시러 갑니다.`,
      leave: t => `${t}까지 집에서 출발해 주세요.`,
      text: v => `${v.name}님, ${v.home}입니다. 계획 정전으로 ${v.oldDay} 투석 치료 일정이 바뀌었습니다. 새 일정: ` +
        (v.same ? `같은 날 ${v.t}` : `${v.m}월 ${v.dd}일 ${v.day} ${v.t}`) +
        `, ${v.clinic}(${v.street}). ${v.ride} 문의: ${v.callback}.`,
    },
    vi: {
      days: ['Chủ Nhật', 'thứ Hai', 'thứ Ba', 'thứ Tư', 'thứ Năm', 'thứ Sáu', 'thứ Bảy'],
      time: d => `${hm(d)} ${d.getUTCHours() < 12 ? 'sáng' : d.getUTCHours() < 18 ? 'chiều' : 'tối'}`,
      para: t => `Xe đưa đón (paratransit) sẽ đến đón quý vị lúc ${t}.`,
      leave: t => `Vui lòng rời nhà trước ${t}.`,
      text: v => `Xin chào ${v.name}, đây là ${v.home}. Do cắt điện theo kế hoạch, buổi lọc máu ${v.oldDay} của quý vị được dời sang ` +
        (v.same ? `${v.t} cùng ngày` : `${v.t} ${v.day}, ngày ${v.dd} tháng ${v.m}`) +
        `, tại ${v.clinic}, ${v.street}. ${v.ride} Nếu có thắc mắc, vui lòng gọi ${v.callback}.`,
    },
    tl: {
      days: ['Linggo', 'Lunes', 'Martes', 'Miyerkules', 'Huwebes', 'Biyernes', 'Sabado'],
      time: d => `${hm(d)} ng ${d.getUTCHours() < 12 ? 'umaga' : d.getUTCHours() < 18 ? 'hapon' : 'gabi'}`,
      para: t => `Susunduin kayo ng paratransit nang ${t}.`,
      leave: t => `Umalis po kayo ng bahay nang ${t}.`,
      text: v => `Magandang araw, ${v.name}. Ito ang ${v.home}. Dahil sa nakaplanong pagpatay ng kuryente, ` +
        (v.same ? `inilipat ang oras ng inyong dialysis sa ${v.oldDay} sa ${v.t}` :
          `inilipat ang inyong dialysis mula ${v.oldDay} patungong ${v.day}, ${BUWAN[v.m - 1]} ${v.dd}, ${v.t}`) +
        `, sa ${v.clinic}, ${v.street}. ${v.ride} May tanong? Tumawag sa ${v.callback}.`,
    },
  };

  const EDIT_STATUSES = ['approved', 'confirmed', 'declined', 'no_answer'];

  const street = c => c.address.split(',')[0].replace(/\.$/, '');  // some CMS addresses end in a period
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
        `${when} at ${c.name}, ${street(c)}. ${ride} Questions? Call ${CALLBACK}.`;
    }

    // Template translations, written ahead of time (not machine-translated per message). Same facts as message().
    function localized(row, lang) {
      const L = L10N[lang], p = byPid[row.patient_id], c = fac[row.clinic_id];
      const old = local(Date.parse(row.affected_session)), next = at(row.slot.date, row.slot.shift), n = local(next);
      const pickup = L.time(local(Date.parse(row.pickup_time)));
      return L.text({
        name: p.name, home: fac[p.center_id].name, clinic: c.name, street: street(c), callback: CALLBACK,
        oldDay: L.days[old.getUTCDay()], day: L.days[n.getUTCDay()], m: n.getUTCMonth() + 1, dd: n.getUTCDate(), t: L.time(n),
        same: iso(next).slice(0, 10) === iso(Date.parse(row.affected_session)).slice(0, 10),
        ride: row.ride === 'paratransit' ? L.para(pickup) : L.leave(pickup),
      }).replace(/\.(\s*\.)+/g, '.');  // names like "Minh G." and "p. m." end a sentence once
    }

    function fillText(rows, only) {
      for (const r of rows) {
        if (only && !only.has(r.patient_id)) continue;
        if (r.affected_session) r.reason_text = reasonText(r);
        const lang = byPid[r.patient_id].language, move = r.slot && (r.action === 'transfer' || r.action === 'early_session');
        r.messages = move ? { en: message(r), ...(L10N[lang] ? { [lang]: localized(r, lang) } : {}) } : {};
      }
    }

    function summary(rows) {  // backend text_fallback.fill in plain words, with zero counts left out
      const n = a => rows.filter(r => r.action === a).length, rides = rows.filter(r => r.book_today).length;
      const parts = [['early_session', 'comes in early', 'come in early'], ['transfer', 'moves to another clinic', 'move to another clinic'], ['hospital', 'needs a staff call', 'need a staff call']]
        .map(([a, one, many]) => [n(a), one, many]).filter(([k]) => k)
        .map(([k, one, many]) => `${k} ${k === 1 ? one : many}`);
      const list = parts.length > 2 ? `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}` : parts.join(' and ') || 'No patient needs a change';
      return `${list}.${rides ? ` Book ${rides} paratransit ride${rides === 1 ? '' : 's'} today.` : ''}`;
    }

    const matched = step('match', () => match(ranked, baseCap, new Map()));
    step('text', () => fillText(matched.patients));
    const v1 = { event_id: EVENT.event_id, version: 1, created_at: iso(NOW), mode: affected.mode, lead_hours: affected.lead_hours,
      timing_ms: timing, patients: matched.patients, overflow: matched.overflow, audit: [], summary: summary(matched.patients),
      ai_sources: { text: 'fallback' } };
    timing.total = Math.max(Math.round(performance.now() - t0), timing.affected + timing.rank + timing.match + timing.text);

    let current = v1, capNow = baseCap;  // the latest version and the chairs its match used; replan and approve build on it. Reset = LumenTour.build(data) again.
    const stamp = version => iso(NOW + (version - 1) * MIN);  // shortcut: one demo minute per version, not wall time

    // Two changes, as the live re-plan reads them: "(center) can only take N more" and "(patient) declined".
    function replan(instruction) {
      const t = performance.now(), said = String(instruction || '');
      const m = /^\s*(.+?)\s+can only take (\d+|\w+) more(\s+patients?)?\W*$/i.exec(said);
      const n = m && (/^\d+$/.test(m[2]) ? Number(m[2]) : NUMBERS[m[2].toLowerCase()]);
      const gone = n == null && /^\s*(.+?)\s+declined\W*$/i.exec(said);
      if (n == null && !gone) throw new Error("Lumen could not read that change. Try '(center name) can only take 4 more' or '(patient name) declined'.");
      const old = current, work = structuredClone(old.patients), cap = new Map(capNow);  // earlier cuts still hold
      let center, who, locked;
      if (gone) {
        const key = s => s.trim().toLowerCase().replace(/\.$/, ''), want = key(gone[1]);
        const full = work.filter(r => key(byPid[r.patient_id].name) === want);
        const hits = full.length ? full : work.filter(r => key(byPid[r.patient_id].name.split(' ')[0]) === want);  // a first name only when one patient has it
        // tour names repeat ("Elena W."), so a shared full name needs the patient's own Decline button
        if (hits.length !== 1) throw new Error(hits.length ? `${hits.length} patients are named '${gone[1].trim()}'. ` +
          (full.length ? 'Open the patient and press Decline.' : 'Use the full name.') : `No patient in the plan is named '${gone[1].trim()}'.`);
        who = hits[0];
        who.status = 'declined';
        locked = new Map(work.filter(r => r.pinned || ['confirmed', 'declined'].includes(r.status) || r.slot).map(r => [r.patient_id, r]));
      } else {
        const name = m[1].trim().toLowerCase();
        const hits = facilities.filter(c => c.kind === 'dialysis' && c.name.toLowerCase().includes(name));
        const exact = hits.filter(c => c.name.toLowerCase() === name);
        if ((exact.length || hits.length) !== 1)
          throw new Error(`'${m[1].trim()}' matches ${hits.map(c => c.name).join(', ') || 'no center'}; use the full center name.`);
        center = (exact.length ? exact : hits)[0];
        if (closedIds.includes(center.id)) throw new Error(`${center.name} is closed in this shutoff; name a receiving center.`);
        // N more = at most N visiting patients at that center across all slots: pinned and confirmed rows first, then rank order
        const keep = work.filter(r => r.clinic_id === center.id && r.slot && r.status !== 'declined')
          .sort((a, b) => (!(a.pinned || a.status === 'confirmed') - !(b.pinned || b.status === 'confirmed')) || a.rank - b.rank).slice(0, n);
        for (const k of cap.keys()) if (k.startsWith(center.id + '|'))
          cap.set(k, keep.filter(r => `${center.id}|${r.slot.date}|${r.slot.shift}` === k).length);
        locked = new Map(work.filter(r => r.pinned || ['confirmed', 'declined'].includes(r.status) || (r.slot && r.clinic_id !== center.id))
          .map(r => [r.patient_id, r]));
      }
      const result = match(work.slice().sort((a, b) => a.rank - b.rank), cap, locked);
      const before = Object.fromEntries(old.patients.map(r => [r.patient_id, r]));
      const changed = new Set();
      for (const r of result.patients) {
        const o = before[r.patient_id];
        if (DECISION.every(k => same(r[k], o[k]))) Object.assign(r, structuredClone({ reason_text: o.reason_text, messages: o.messages, audio: o.audio, status: o.status }));
        else changed.add(r.patient_id);
        if (o.note) r.note = changed.has(r.patient_id) ? { ...o.note, status: 'stale' } : structuredClone(o.note);  // a moved row's note is out of date
      }
      const diff = [];
      for (const r of result.patients) for (const f of DIFF_FIELDS)
        if (!same(before[r.patient_id][f], r[f])) diff.push({ patient_id: r.patient_id, field: f, from: before[r.patient_id][f], to: r[f] });
      const tReplan = Math.round(performance.now() - t), tText = performance.now();
      fillText(result.patients, changed);
      const count = (k, noun, one, many) => `${k} ${noun}${k === 1 ? '' : 's'} ${k === 1 ? one : many}`;
      let text, understood;  // understood: one sentence per applied change, as the live re-plan returns it
      if (who) {
        const back = old.overflow.filter(id => !result.overflow.includes(id)).length;
        understood = [`${byPid[who.patient_id].name} will not come. Staff call them.`];
        text = back ? `${count(back, 'patient', 'moves', 'move')} from the staff call list to the open chair.` : 'No other patient needs to move.';
      } else {
        const moved = new Set(diff.filter(d => d.field === 'clinic_id' && d.from === center.id).map(d => d.patient_id)).size;
        const toStaff = result.overflow.filter(id => !old.overflow.includes(id)).length;
        understood = [`${center.name} takes at most ${n} more patient${n === 1 ? '' : 's'}.`];
        text = moved ? `${center.name} can take only ${n} more, so ${count(moved, 'patient', 'moves', 'move')} to other chairs or the staff call list.` +
          (toStaff ? ` ${count(toStaff, 'more patient', 'needs', 'need')} a staff call.` : '') : `${center.name} can take only ${n} more; no patient needs to move.`;
      }
      const ts = stamp(old.version + 1);
      const timingMs = { replan: tReplan, text: Math.round(performance.now() - tText) };
      timingMs.total = Math.max(Math.round(performance.now() - t), timingMs.replan + timingMs.text);
      capNow = cap;
      current = { ...old, version: old.version + 1, created_at: ts, timing_ms: timingMs, patients: result.patients, overflow: result.overflow,
        audit: old.audit.concat({ ts, actor: 'Rosa', change: `re-plan: ${String(instruction).trim().slice(0, 200)}` }), summary: text,
        ai_sources: { ...old.ai_sources, replan: 'fallback' } };
      return { plan: current, diff, summary: text, understood };
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

    // POST /check in the live shape: code rules on the tour's synthetic fields, sentences with patient IDs (the screen shows names).
    // The tour has no heart failure field and keeps the usual day, so heart_failure_long_gap never applies here.
    function check() {
      const hard = [], soft = [], booked = new Map();
      const add = (to, severity, code, patient_id, facility_id, text, more) =>
        to.push({ patient_id, facility_id, severity, code, text, source: 'template', ...more });
      for (const r of current.patients) {
        if (r.action === 'notify_only' || r.status === 'declined' || !r.clinic_id) continue;
        const pid = r.patient_id, c = fac[r.clinic_id], pickup = r.pickup_time && r.pickup_time.slice(11, 16);
        if (r.slot) { const k = `${c.id}|${r.slot.date}|${r.slot.shift}`; booked.set(k, (booked.get(k) || 0) + 1); }
        if (r.action === 'transfer' && r.drive_minutes > DRIVE_CAP)
          add(hard, 'warning', 'long_drive', pid, c.id, `${pid} has a ${r.drive_minutes}-minute drive to ${c.name}, longer than the ${DRIVE_CAP}-minute limit.`);
        if (byPid[pid].flags.includes('alone') && pickup && !(pickup >= '06:00' && pickup < '19:00'))
          add(soft, 'warning', 'lives_alone_night_pickup', pid, c.id, `${pid} lives alone and has a pickup in the dark at ${pickup}.`, { soft: true });
      }
      for (const [k, count] of booked) {
        const [id, date, shift] = k.split('|'), chairs = capNow.get(k) || 0;
        if (count > chairs) add(hard, 'block', 'over_capacity', null, id,
          `${fac[id].name} has ${chairs} open chairs on ${date} shift ${shift}, but the plan sends ${count} patients.`, { slot: { date, shift: +shift } });
      }
      const issues = hard.sort((a, b) => (a.severity !== 'block') - (b.severity !== 'block')).concat(soft);
      return { issues, counts: { block: issues.filter(i => i.severity === 'block').length, warning: issues.filter(i => i.severity === 'warning').length },
        explained_by: 'template' };
    }

    // backend check.blocks_row: the block names the patient, or it is the over-capacity block of the row's slot
    const blocksRow = (i, r) => i.severity === 'block' &&
      (i.patient_id === r.patient_id || (i.patient_id === null && i.facility_id === r.clinic_id && same(i.slot, r.slot)));

    // POST /notify (simulated: nothing leaves Lumen). One outcome per row; the first matching reason wins. Throws Error on a bad request.
    function notify(patientIds, { callInstead, dryRun = false, now } = {}) {
      const t = performance.now(), calls = callInstead == null ? [] : callInstead;
      if (!Array.isArray(patientIds) || !patientIds.length || !patientIds.every(p => typeof p === 'string'))
        throw new Error('patient_ids must be a non-empty list of patient IDs');
      if (!Array.isArray(calls)) throw new Error('call_instead must be a list');
      const next = structuredClone(current), rows = new Map(next.patients.map(r => [r.patient_id, r]));
      for (const id of calls) if (!rows.has(id)) throw new Error(`unknown patient ${id}`);
      const ids = patientIds.length === 1 && patientIds[0] === 'all' ? [...rows.keys()] : [...new Set(patientIds)];
      const blocks = check().issues.filter(i => i.severity === 'block');
      // The tour clock (a new version's timestamp) unless the caller sets one. Quiet hours: before 08:00 or from 20:00, local time.
      const ms = now == null ? Date.parse(stamp(current.version + 1)) : new Date(now).getTime(), hour = local(ms).getUTCHours();
      const quiet = hour < 8 || hour >= 20;
      let wake = Date.parse(iso(ms).slice(0, 10) + 'T08:00:00-07:00');
      if (wake <= ms) wake += 1440 * MIN;
      const sent = [], queued = [], skipped = [];
      for (const id of ids) {
        const r = rows.get(id);
        if (!r) throw new Error(`unknown patient ${id}`);
        const lang = byPid[id].language;
        const reason = r.status === 'declined' ? 'declined'
          : r.action === 'hospital' || r.flags.includes('staff_call') ? 'staff_call'
          : !['early_session', 'transfer'].includes(r.action) || !Object.keys(r.messages).length ? 'no_message'
          : r.status === 'draft' ? 'not_approved'
          : blocks.some(b => blocksRow(b, r)) ? 'blocked'
          : calls.includes(id) ? 'call_instead'
          : r.note && ['sent', 'queued'].includes(r.note.status) ? 'already_sent' : null;
        if (reason) { skipped.push({ patient_id: id, reason }); continue; }
        // one note per patient, in the patient's language (English when the row has no message in it)
        r.note = { status: quiet ? 'queued' : 'sent', sent_at: quiet ? null : iso(ms), send_at: quiet ? iso(wake) : null,
          lang: r.messages[lang] ? lang : 'en', channel: 'simulated voice note', version: current.version };
        (quiet ? queued : sent).push(id);
      }
      const k = sent.length + queued.length;
      if (k && !dryRun) {
        next.audit.push({ ts: iso(ms), actor: 'Rosa', change: `voice notes ${queued.length ? 'queued for 08:00 for' : 'sent to'} ${k} patient${k === 1 ? '' : 's'} (simulated)` });
        Object.assign(next, { version: current.version + 1, created_at: iso(ms), timing_ms: { total: Math.round(performance.now() - t) } });
        current = next;
      }
      return { plan: current, sent, queued, skipped, dry_run: !!dryRun };
    }

    // The receiving center with the most transfers, for the rail's suggestion chip.
    const busiest = Object.entries(v1.patients.reduce((a, r) => (r.action === 'transfer' && (a[r.clinic_id] = (a[r.clinic_id] || 0) + 1), a), {}))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];

    return { facilities, patients, outage: data.outage, event: { ...EVENT }, affected, plan: v1, replan, approve, check, notify,
      suggestion: busiest ? `${fac[busiest[0]].name} can only take four more` : '',
      // Chairs per powered hemodialysis center, from the latest plan: open = chairs the match could use, used = rows holding one.
      get capacity() {
        const out = {};
        for (const [k, n] of capNow) { const id = k.split('|')[0]; (out[id] ||= { open: 0, used: 0 }).open += n; }
        for (const r of current.patients) if (r.slot && r.status !== 'declined' && out[r.clinic_id]) out[r.clinic_id].used++;
        return out;
      } };
  }

  window.LumenTour = { build };
})();
