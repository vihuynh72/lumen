/* Lumen map: window.LumenMap on MapLibre GL JS 4.7.1 (global maplibregl).
   Contracts: CONTRACT.md "Map module", CONTRACT-v2 E1 (funnel on roads), E2 (patient route), E7-E9 and the map API additions. */
(() => {
  'use strict';

  const OSM = '© OpenStreetMap contributors';
  const EMPTY = { type: 'FeatureCollection', features: [] };
  // Standard MapLibre "animated dash" sequence: one step every DASH_MS moves the dashes along the line.
  const DASH = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
    [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
  const DASH_MS = 60;
  const ANIM_MIN_ZOOM = 11;   // below this the feeders are a few px: no animation, no repaints
  const STAFF_DASH = [1.6, 1.1]; // staff-call routes, in line widths
  const STRAIGHT_DASH = [2, 2];  // straight stand-in lines (no road route), in line widths
  const FUNNEL_STEPS = 6 * DASH.length; // funnel 0..1 runs the dash cycle 6 times along every route
  const TOO_FAR = 40;            // road minutes
  const FIT_PAD = 48;
  // [pitch, bearing] per kind of view while 3D is on; flat views use [0, 0].
  const VIEW3D = { home: [55, -20], over: [40, -15], near: [50, -15] };
  const DROP = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2C6.2 4.6 4.2 7.1 4.2 9.6a3.8 3.8 0 0 0 7.6 0C11.8 7.1 9.8 4.6 8 2.2z" fill="currentColor" fill-opacity=".18"/></svg>';
  const HOSP = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" aria-hidden="true"><path d="M5 3.8v8.4M11 3.8v8.4M5 8h6"/></svg>';
  const RANK = { home: 0, closed: 1, receiving: 2, hospital: 3, normal: 4 };

  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => mq.matches;
  const fc = (features) => ({ type: 'FeatureCollection', features });
  const point = (c, properties = {}) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: c } });
  const z = (...stops) => ['interpolate', ['linear'], ['zoom'], ...stops];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const is = (k) => ['==', ['get', k], true];
  const isLine = (l) => Array.isArray(l) && l.length > 1;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const miles = (m) => { const v = m / 1609.344; return v < 10 ? v.toFixed(1) : String(Math.round(v)); };

  let map = null, opts = {}, ready = false, amazon = false, raf = 0, dashStep = -1, moveRaf = 0, flying = null;
  let T = {}, fontR = ['Noto Sans Regular'], fontB = ['Noto Sans Bold'];
  let markers = [];
  let counts = []; // one per drawn route: { k, line, cum, props, t }; t = where along the route its badge sits (0..1)
  const area = { marker: null, text: null, box: null }; // DOM "Shutoff area" label, so facility labels can avoid it
  const call = { marker: null, el: null, w: 0, h: 0 };  // DOM callout at the selected patient's destination
  const S = { theme: 'light', region: null, facilities: [], status: {}, dead: false, outage: null, patients: null,
    flows: null, recv: {}, early: {}, sel: null, routes: null, pr: null, scene: null,
    is3D: false, anim: true, pad: { top: 0, right: 0, bottom: 0, left: 0 } };
  const D = { trans: EMPTY, subs: EMPTY, feeders: EMPTY, county: EMPTY, fp: [], center: {} };

  // ---------- style, tokens, fonts ----------

  function styleUrl() {
    const dark = S.theme === 'dark';
    return amazon
      ? `https://maps.geo.us-east-2.amazonaws.com/v2/styles/Monochrome/descriptor?key=${encodeURIComponent(opts.mapKey)}&color-scheme=${dark ? 'Dark' : 'Light'}`
      : `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`;
  }

  // Map colors come from the CSS tokens in app.css; the pairs below only mirror them in case a token is missing.
  function readTokens() {
    const cs = getComputedStyle(document.documentElement), dark = S.theme === 'dark';
    const v = (n) => cs.getPropertyValue(n).trim();
    const g = (n, l, d) => v(n) || (dark ? d : l);
    T = {
      power: g('--map-power', '#2F8F5B', '#57C98C'), dead: g('--map-dead', '#B5544C', '#FF8A7D'),
      trans: g('--map-trans', '#4A5953', '#A9B8B1'), outage: g('--map-outage', '#C2362F', '#FF6B5B'),
      early: g('--map-early', '#23784A', '#57C98C'), transfer: g('--map-transfer', '#2457C5', '#7FA6FF'),
      staff: g('--map-staff', '#3A4843', '#C2CEC9'), affected: g('--map-affected', '#E39A1E', '#F2AE3D'),
      ink: g('--map-ink', '#13201C', '#E6EDEA'), halo: g('--map-halo', 'rgba(251,252,251,.92)', 'rgba(10,16,14,.85)'),
      mute: g('--mute', '#5B6863', '#93A39C'), paper: g('--paper', '#FBFCFB', '#111917'), line2: g('--line-2', '#B7C1BC', '#35453F'),
      amberInk: g('--amber-ink', '#8A5300', '#F5BE63'),
      mask: v('--map-mask') || g('--rail', '#15211D', '#0D1412'), // dark in both themes
      powerInk: g('--green-ink', '#1D6940', '#7ED8A8'), deadInk: g('--red-ink', '#A12A24', '#FF8A7D'),
      warm: v('--map-fac') || g('--line-2', '#B7C1BC', '#35453F'),   // facility buildings
      bldg: v('--map-bldg') || g('--line', '#D4DBD7', '#24312C'),    // faint basemap buildings
    };
  }

  // Reuse fonts the active style already uses, so the style's glyph server can serve them.
  function pickFonts() {
    const names = new Set();
    const walk = (v) => Array.isArray(v) ? v.forEach(walk) : (typeof v === 'string' && /Regular|Bold/.test(v) && names.add(v));
    map.getStyle().layers.forEach((l) => l.layout && walk(l.layout['text-font']));
    const pick = (re) => [...names].filter((n) => re.test(n)).sort((a, b) => /Condensed/.test(a) - /Condensed/.test(b))[0];
    const r = pick(/Regular/) || 'Noto Sans Regular';
    fontR = [r];
    fontB = [pick(/Bold/) || (amazon ? r : 'Noto Sans Bold')]; // OpenFreeMap serves Noto Sans Bold even when the dark style does not use it
  }

  function mix(a, b, t) {
    const p = (h) => { h = String(h).trim().replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&'); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
    const A = p(a), B = p(b);
    if ([...A, ...B].some(Number.isNaN)) return a;
    return `rgb(${A.map((v, i) => Math.round(v * (1 - t) + B[i] * t)).join(',')})`;
  }

  // ---------- overlays ----------

  function subIcon(stroke, dashed) {
    const r = 2, s = 14 * r, c = document.createElement('canvas');
    c.width = c.height = s;
    const x = c.getContext('2d');
    x.fillStyle = T.halo; x.beginPath(); x.arc(s / 2, s / 2, s / 2 - r, 0, Math.PI * 2); x.fill();
    x.strokeStyle = x.fillStyle = stroke; x.lineWidth = 1.6 * r;
    if (dashed) x.setLineDash([2 * r, 1.4 * r]);
    x.globalAlpha = 0.28; x.fillRect(4 * r, 4 * r, 6 * r, 6 * r);
    x.globalAlpha = 1; x.strokeRect(4 * r, 4 * r, 6 * r, 6 * r);
    return x.getImageData(0, 0, s, s);
  }

  // Paper pill behind route badges; stretchable, so icon-text-fit sizes it to any text.
  function badgeIcon() {
    const r = 2, s = 24 * r, c = document.createElement('canvas');
    c.width = c.height = s;
    const x = c.getContext('2d');
    x.fillStyle = T.paper; x.strokeStyle = T.line2; x.lineWidth = r;
    x.beginPath(); x.roundRect(r / 2, r / 2, s - r, s - r, 6 * r); x.fill(); x.stroke();
    return x.getImageData(0, 0, s, s);
  }

  function addOverlays() {
    const style = map.getStyle();
    const before = (style.layers.find((l) => l.type === 'symbol') || {}).id;
    const add = (layer, beforeId) => map.addLayer(layer, beforeId);
    const halo = { 'text-halo-color': T.halo, 'text-halo-width': 1.6, 'text-halo-blur': 0.4 };
    const round = { 'line-cap': 'round', 'line-join': 'round' };
    // Red means power off only: staff calls are --map-staff and drawn dashed.
    const act = ['match', ['get', 'action'], 'early_session', T.early, 'transfer', T.transfer, 'hospital', T.staff, 'notify_only', T.mute, T.affected];
    const flowColor = ['case', ['get', 'changed'], T.affected, act];
    const fade = { duration: 0, delay: 0 };

    ['lm-county', 'lm-outage', 'lm-trans', 'lm-subs', 'lm-feeders', 'lm-fp', 'lm-flows', 'lm-flow-mid', 'lm-pr', 'lm-pat']
      .forEach((id) => map.addSource(id, { type: 'geojson', data: EMPTY }));
    map.addImage('lm-sub-live', subIcon(T.trans, false), { pixelRatio: 2 });
    map.addImage('lm-sub-dead', subIcon(T.dead, true), { pixelRatio: 2 });
    map.addImage('lm-badge', badgeIcon(), { pixelRatio: 2, stretchX: [[12, 36]], stretchY: [[12, 36]], content: [10, 7, 38, 41] });

    // Under the basemap labels: county outline, power-off mask, outage fill, grid, outline, buildings.
    add({ id: 'lm-county-line', type: 'line', source: 'lm-county', layout: { 'line-join': 'round' }, paint: { 'line-color': T.ink, 'line-opacity': S.theme === 'dark' ? 0.32 : 0.45, 'line-width': z(8, 1.25, 13, 2.25), 'line-dasharray': [4, 2.5] } }, before);
    add({ id: 'lm-outage-mask', type: 'fill', source: 'lm-outage', paint: { 'fill-color': T.mask, 'fill-opacity': 0, 'fill-opacity-transition': fade } }, before);
    add({ id: 'lm-outage-fill', type: 'fill', source: 'lm-outage', paint: { 'fill-color': T.outage, 'fill-opacity': 0, 'fill-opacity-transition': fade } }, before);
    const w = ['get', 'w'], tw = (k) => z(8, ['+', k, ['*', 1, w]], 11, ['+', k, ['*', 1.6, w]], 14, ['+', k, ['*', 2, w]], 17, ['+', k, ['*', 3, w]]);
    add({ id: 'lm-trans-line', type: 'line', source: 'lm-trans', layout: round, paint: { 'line-color': T.trans, 'line-opacity': 0.85, 'line-width': tw(0) } }, before);
    // Dead lines are solid and opaque over a halo casing, so they never read as a second dashed shutoff edge.
    add({ id: 'lm-trans-dead-casing', type: 'line', source: 'lm-trans', layout: round, paint: { 'line-color': T.halo, 'line-width': tw(3.5) } }, before);
    add({ id: 'lm-trans-dead', type: 'line', source: 'lm-trans', layout: round, paint: { 'line-color': T.dead, 'line-width': tw(0.6) } }, before);
    add({ id: 'lm-feeder-casing', type: 'line', source: 'lm-feeders', layout: round, paint: { 'line-color': T.halo, 'line-width': z(10, 4.5, 15, 8.5) } }, before);
    add({ id: 'lm-feeder-live', type: 'line', source: 'lm-feeders', layout: round, paint: { 'line-color': T.power, 'line-opacity': 0.32, 'line-width': z(10, 1.8, 15, 3.4) } }, before);
    add({ id: 'lm-feeder-flow', type: 'line', source: 'lm-feeders', layout: { 'line-join': 'round' }, paint: { 'line-color': T.power, 'line-width': z(10, 1.8, 15, 3.4), 'line-dasharray': DASH[0], 'line-dasharray-transition': fade } }, before);
    add({ id: 'lm-feeder-dead', type: 'line', source: 'lm-feeders', layout: round, paint: { 'line-color': T.dead, 'line-width': z(10, 2.2, 15, 4) } }, before);
    add({ id: 'lm-outage-line', type: 'line', source: 'lm-outage', layout: { 'line-join': 'round' }, paint: { 'line-color': T.outage, 'line-width': z(8, 1.25, 14, 2), 'line-opacity': 0, 'line-opacity-transition': fade } }, before);

    // Faint basemap 3D buildings when the style's tiles carry heights; they rise from zoom 13 so the home view shows volume.
    const has = (src, sl) => style.sources[src] && style.layers.some((l) => l.source === src && l['source-layer'] === sl);
    if (has('openmaptiles', 'building')) {
      add({ id: 'lm-bldg-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
        filter: ['!=', ['get', 'hide_3d'], true],
        paint: { 'fill-extrusion-color': T.bldg, 'fill-extrusion-opacity': 0.5,
          'fill-extrusion-height': z(13, 0, 13.6, ['coalesce', ['get', 'render_height'], 5]),
          'fill-extrusion-base': z(13, 0, 13.6, ['coalesce', ['get', 'render_min_height'], 0]) } }, before);
    } else if (has('aws', 'buildings')) {
      // shortcut: Amazon Location building tiles carry no height, so every building gets a fixed 6 m; upgrade if the tiles add one.
      add({ id: 'lm-bldg-3d', type: 'fill-extrusion', source: 'aws', 'source-layer': 'buildings', minzoom: 13,
        filter: ['all', ['==', ['get', 'kind'], 'building'], ['==', ['geometry-type'], 'Polygon']],
        paint: { 'fill-extrusion-color': T.bldg, 'fill-extrusion-opacity': 0.5, 'fill-extrusion-height': z(13, 0, 13.6, 6) } }, before);
    }

    // Facility buildings, colored by status (closed = power-off red). Generated outlines are approximate: flat and dashed.
    const FP = { normal: T.warm, closed: T.outage, receiving: mix(T.early, T.warm, 0.42), hospital: mix(T.transfer, T.warm, 0.72) };
    const fpColor = (k) => ['match', ['get', 'st'], 'closed', mix(FP.closed, T.ink, k), 'receiving', mix(FP.receiving, T.ink, k), 'hospital', mix(FP.hospital, T.ink, k), mix(FP.normal, T.ink, k)];
    const gen = ['==', ['get', 'gen'], true], real = ['!=', ['get', 'gen'], true];
    add({ id: 'lm-fp-gen-fill', type: 'fill', source: 'lm-fp', filter: gen, paint: { 'fill-color': fpColor(0), 'fill-opacity': 0.45 } }, before);
    add({ id: 'lm-fp-gen-line', type: 'line', source: 'lm-fp', filter: gen, paint: { 'line-color': fpColor(0.3), 'line-width': z(13, 0.9, 17, 1.8), 'line-dasharray': [2, 1.5] } }, before);
    add({ id: 'lm-fp-line', type: 'line', source: 'lm-fp', filter: real, paint: { 'line-color': fpColor(0.3), 'line-width': z(13, 0.6, 17, 1.4) } }, before);
    add({ id: 'lm-fp-3d', type: 'fill-extrusion', source: 'lm-fp', filter: real, paint: { 'fill-extrusion-color': fpColor(0), 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 0.94 } }, before);

    // Above basemap labels: road routes (one per closed clinic, destination and action; width grows with the patient
    // count; largest underneath, changed on top, 1 px halo casing), the selected patient's route, patients, our labels.
    const road = ['!', is('pending')];
    const sort = { 'line-sort-key': ['+', ['case', ['get', 'changed'], 1e4, 0], ['-', 0, ['get', 'n']]] };
    add({ id: 'lm-flow-casing', type: 'line', source: 'lm-flows', filter: road, layout: { ...round, ...sort }, paint: { 'line-color': T.halo, 'line-width': ['+', ['get', 'w'], 2] } });
    add({ id: 'lm-flow-line', type: 'line', source: 'lm-flows', filter: ['all', road, ['!=', ['get', 'action'], 'hospital']], layout: { ...round, ...sort }, paint: { 'line-color': flowColor, 'line-width': ['get', 'w'] } });
    add({ id: 'lm-flow-staff', type: 'line', source: 'lm-flows', filter: ['all', road, ['==', ['get', 'action'], 'hospital']], layout: { 'line-join': 'round', ...sort }, paint: { 'line-color': flowColor, 'line-width': ['get', 'w'], 'line-dasharray': STAFF_DASH } });
    // Funnel: dashes moving from the closed clinic toward the destination (setScene funnel 0..1 steps the dash).
    add({ id: 'lm-flow-run', type: 'line', source: 'lm-flows', filter: road, layout: { 'line-join': 'round', visibility: 'none', ...sort }, paint: { 'line-color': flowColor, 'line-width': ['get', 'w'], 'line-dasharray': DASH[0] } });
    // No road route for the pair yet: a thin dashed straight line, never a fake road.
    add({ id: 'lm-flow-pending', type: 'line', source: 'lm-flows', filter: is('pending'), layout: { 'line-join': 'round' }, paint: { 'line-color': flowColor, 'line-width': 2, 'line-dasharray': STRAIGHT_DASH } });
    add({ id: 'lm-pr-casing', type: 'line', source: 'lm-pr', layout: round, paint: { 'line-color': T.halo, 'line-width': 8 } });
    add({ id: 'lm-pr-line', type: 'line', source: 'lm-pr', filter: ['!', is('straight')], layout: round, paint: { 'line-color': act, 'line-width': 5 } });
    add({ id: 'lm-pr-straight', type: 'line', source: 'lm-pr', filter: is('straight'), layout: { 'line-join': 'round' }, paint: { 'line-color': act, 'line-width': 4, 'line-dasharray': STRAIGHT_DASH } });
    add({ id: 'lm-pat-ring', type: 'circle', source: 'lm-pat', filter: is('sel'), paint: { 'circle-radius': z(8, 7, 14, 10), 'circle-color': T.ink, 'circle-opacity': 0, 'circle-stroke-color': T.ink, 'circle-stroke-width': 2 } });
    // Home dots stay small and faint (no lines from homes); the selected patient's dot is full strength.
    add({ id: 'lm-pat', type: 'circle', source: 'lm-pat', layout: { 'circle-sort-key': ['case', ['get', 'sel'], 1, 0] }, paint: { 'circle-radius': z(8, 3, 14, 5.5), 'circle-color': act, 'circle-stroke-color': T.halo, 'circle-stroke-width': 1.25 } });

    add({ id: 'lm-trans-label', type: 'symbol', source: 'lm-trans', minzoom: 12, filter: ['has', 'kv'],
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 420, 'text-field': ['get', 'kv'], 'text-font': fontR, 'text-size': 10.5, 'text-offset': [0, -0.8], 'text-letter-spacing': 0.02 },
      paint: { 'text-color': T.trans, ...halo } });
    add({ id: 'lm-subs', type: 'symbol', source: 'lm-subs', minzoom: 9.5,
      layout: { 'icon-image': 'lm-sub-live', 'icon-size': z(9.5, 0.7, 13, 1), 'icon-allow-overlap': true, 'icon-ignore-placement': false,
        'text-field': ['step', ['zoom'], '', 11, ['coalesce', ['get', 'name'], '']], 'text-font': fontR, 'text-size': 11,
        'text-anchor': 'left', 'text-offset': [0.9, 0], 'text-optional': true, 'text-max-width': 10 },
      paint: { 'text-color': T.trans, ...halo } });
    add({ id: 'lm-feeder-label', type: 'symbol', source: 'lm-feeders', minzoom: 13,
      layout: { 'symbol-placement': 'line-center', 'text-field': 'Feeder (illustrative)', 'text-font': fontR, 'text-size': 10.5, 'text-offset': [0, -0.9] },
      paint: { 'text-color': T.powerInk, ...halo } });
    add({ id: 'lm-flow-count', type: 'symbol', source: 'lm-flow-mid',
      // One badge per route ("16 patients · 22 min · 14 mi", short below zoom 11). Badges collide with each other and the
      // rank tags and hide instead of piling up: changed routes place first, then the biggest counts.
      layout: { 'text-field': ['step', ['zoom'], ['get', 's'], 11, ['get', 'l']], 'text-font': fontB, 'text-size': 12,
        'text-max-width': 40, 'icon-image': 'lm-badge', 'icon-text-fit': 'both', 'icon-text-fit-padding': [1, 2, 1, 2],
        'text-allow-overlap': false, 'icon-allow-overlap': false, 'text-padding': 4,
        'symbol-sort-key': ['-', ['case', ['get', 'changed'], 0, 1e4], ['get', 'n']] },
      paint: { 'text-color': ['case', ['get', 'changed'], T.amberInk, is('pending'), T.mute, T.ink] } });
    add({ id: 'lm-pat-label', type: 'symbol', source: 'lm-pat', filter: ['!=', ['get', 'txt'], ''],
      layout: { 'text-field': ['get', 'txt'], 'text-font': fontB, 'text-size': 11.5, 'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
        'text-radial-offset': 0.85, 'text-padding': 4, 'symbol-sort-key': ['case', ['get', 'sel'], 0, 1] },
      paint: { 'text-color': T.ink, ...halo } });
  }

  function setSrc(id, data) { const s = ready && map.getSource(id); if (s) s.setData(data); }

  function renderAll() {
    setSrc('lm-trans', D.trans); setSrc('lm-subs', D.subs); setSrc('lm-feeders', D.feeders); setSrc('lm-county', D.county);
    renderFp(); renderOutage(true); renderPatients(); renderFlows(); renderPr(); applyPower(); applyFlowPaint();
  }

  const rawStatus = (f) => S.status[f.id] || 'normal';
  // In a simulation (setScene) a closed clinic is drawn red only while its power is off.
  const statusOf = (f) => { const st = rawStatus(f); return st === 'closed' && S.scene && S.scene.power !== 'off' ? 'normal' : st; };
  const isDead = () => (S.scene ? S.scene.power === 'off' : S.dead);
  const facPt = (f) => f && (D.center[f.id] || [f.lng, f.lat]); // pin the building when its footprint is known
  const facById = (id) => id != null && S.facilities.find((x) => x.id === id);
  // The facility at a coordinate: exact match first, else the first within ~200 m.
  const near = (x, c, d) => Math.abs(x.lng - c[0]) < d && Math.abs(x.lat - c[1]) < d;
  const facAt = (c) => Array.isArray(c) && (S.facilities.find((x) => x.lng === c[0] && x.lat === c[1]) || S.facilities.find((x) => near(x, c, 2e-3)));
  const snap = (c) => facPt(facAt(c)) || c;
  const pairOf = (a, b) => (S.routes && S.routes.pairs && a != null && b != null && S.routes.pairs[`${a}|${b}`]) || null;

  function renderFp() {
    const byId = Object.fromEntries(S.facilities.map((f) => [f.id, f]));
    setSrc('lm-fp', fc(D.fp.map(({ id, levels, gen, geometry }) => {
      const f = byId[id] || { id }, hosp = f.kind === 'hospital';
      return { type: 'Feature', properties: { st: hosp ? 'hospital' : statusOf(f), gen, h: hosp ? 30 : levels ? levels * 4.2 : 12 }, geometry };
    })));
  }

  function renderOutage(instant) {
    if (!ready) return;
    const g = S.outage;
    setSrc('lm-outage', g || EMPTY);
    const duration = instant || reduced() || !g ? 0 : 400;
    [['lm-outage-fill', 'fill-opacity', 0.1], ['lm-outage-line', 'line-opacity', 0.9]].forEach(([id, p, v]) => {
      map.setPaintProperty(id, p + '-transition', { duration, delay: 0 });
      map.setPaintProperty(id, p, g ? v : 0);
    });
  }

  function renderPatients() {
    const pr = S.pr && S.pr.id;
    setSrc('lm-pat', fc((S.patients || []).filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat)).map((p) => {
      const sel = p.id === S.sel || p.id === pr, rk = p.rank != null && p.rank <= 3 ? `#${p.rank}` : '';
      return point([p.lng, p.lat], { id: p.id, action: p.action || '', sel, txt: sel ? [rk, p.label].filter(Boolean).join(' ') : rk });
    })));
  }

  // Cumulative route length (degrees, longitude scaled by cos(lat)), so a badge can sit at a fraction of the route.
  function measure(line) {
    const k = Math.cos((line[0][1] * Math.PI) / 180), cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot((line[i][0] - line[i - 1][0]) * k, line[i][1] - line[i - 1][1]));
    return cum;
  }
  function along(c, t) {
    const L = c.cum[c.cum.length - 1] * t;
    let i = c.cum.findIndex((d) => d >= L);
    i = i < 0 ? c.cum.length - 1 : Math.max(1, i);
    const d0 = c.cum[i - 1], d1 = c.cum[i], u = d1 > d0 ? (L - d0) / (d1 - d0) : 0, A = c.line[i - 1], B = c.line[i];
    return [A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u];
  }

  function badgeText(n, r) {
    if (!r) return { l: `${plural(n, 'patient')} · Road route pending`, s: `${n} · route pending` };
    const min = Number.isFinite(r.seconds) ? `${Math.round(r.seconds / 60)} min` : '', mi = Number.isFinite(r.meters) ? `${miles(r.meters)} mi` : '';
    return { l: [plural(n, 'patient'), min, mi].filter(Boolean).join(' · '), s: [n, min || mi].filter(Boolean).join(' · ') };
  }

  // E1 funnel: patients gather at their closed clinic; one road route per (closed clinic, destination, action), from
  // data/routes-<region>.json. A pair without a route is a thin dashed straight line labeled "Road route pending".
  // Early sessions draw no route (the clinic label carries "N come in early").
  function renderFlows() {
    const groups = new Map(), lines = [], prevT = new Map(counts.map((c) => [c.k, c.t]));
    counts = [];
    (S.flows || []).forEach((f) => {
      if (!f || !f.from || !f.to || f.action === 'early_session') return;
      const fromId = f.fromId != null ? f.fromId : (facAt(f.from) || {}).id, toId = f.toId != null ? f.toId : (facAt(f.to) || {}).id;
      if (fromId != null && fromId === toId) return;
      const k = `${fromId != null ? fromId : f.from}|${toId != null ? toId : f.to}|${f.action}`;
      const g = groups.get(k) || groups.set(k, { fromId, toId, a: facPt(facById(fromId)) || snap(f.from), b: facPt(facById(toId)) || snap(f.to),
        action: f.action || '', n: 0, changed: false }).get(k);
      g.n++; g.changed = g.changed || !!f.changed;
    });
    groups.forEach((g, k) => {
      const r = pairOf(g.fromId, g.toId), road = r && isLine(r.line), line = road ? r.line : [g.a, g.b];
      const props = { action: g.action, changed: g.changed, n: g.n, w: 3 + 1.4 * Math.sqrt(g.n), pending: !road, ...badgeText(g.n, road && r) };
      lines.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: line } });
      counts.push({ k, line, cum: measure(line), props, t: prevT.get(k) || 0.5 });
    });
    setSrc('lm-flows', fc(lines)); writeCounts();
  }

  function writeCounts() { setSrc('lm-flow-mid', fc(counts.filter((c) => !c.hide).map((c) => point(along(c, c.t), c.props)))); }

  // E2: the selected patient's own route on top (road line, else a dashed straight line) and a callout at the destination.
  function renderPr() {
    const p = S.pr, road = p && isLine(p.line);
    setSrc('lm-pr', p ? fc([{ type: 'Feature', properties: { action: p.action, straight: !road }, geometry: { type: 'LineString', coordinates: road ? p.line : [p.home, p.to] } }]) : EMPTY);
    if (!map) return;
    if (!call.marker) {
      call.el = document.createElement('div');
      call.el.className = 'lm-call';
      call.el.style.zIndex = 8; // above facility pins, below a hovered pin
      call.marker = new maplibregl.Marker({ element: call.el, anchor: 'top-left' });
    }
    const facts = p && [Number.isFinite(p.minutes) && `${Math.round(p.minutes)} min`, Number.isFinite(p.miles) && `${p.miles} mi`].filter(Boolean).join(' · ');
    const rows = !p ? [] : [[p.label || (facts && `${facts} by road`), 'lm-call-t'],
      [!road && (p.note || 'Road route unavailable; straight line shown'), 'lm-call-n'],
      [p.minutes > TOO_FAR && `Too far: over ${TOO_FAR} min by road`, 'lm-call-f']].filter(([t]) => t);
    if (!rows.length) { call.marker.remove(); call.w = 0; return; }
    // Non-breaking space keeps a number with its unit ("21 min", "3 mi") when the callout wraps; the label may come from app.js.
    call.el.replaceChildren(...rows.map(([t, c]) => { const s = document.createElement('span'); s.className = c; s.textContent = t.replace(/(\d) (?=(min|mi)\b)/g, '$1\u00a0'); return s; }));
    call.marker.setLngLat(p.to).addTo(map);
    call.w = call.el.offsetWidth; call.h = call.el.offsetHeight;
  }

  // Opacity and the funnel. A shown patient route dims everything else to 0.35. In a simulation (setScene) the routes
  // stay faint until patients flow: while 0 < funnel < 1 dashes move from the closed clinic outward, at 1 they are solid.
  function applyFlowPaint() {
    if (!ready) return;
    const dim = S.pr ? 0.35 : 1, sc = S.scene, f = sc ? sc.funnel : 1, run = !!sc && !reduced() && f > 0 && f < 1;
    const base = dim * (f >= 1 || (f > 0 && reduced()) ? 1 : 0.35);
    ['lm-flow-casing', 'lm-flow-line', 'lm-flow-staff', 'lm-flow-pending'].forEach((id) => map.setPaintProperty(id, 'line-opacity', base));
    map.setLayoutProperty('lm-flow-run', 'visibility', run ? 'visible' : 'none');
    if (run) map.setPaintProperty('lm-flow-run', 'line-dasharray', DASH[Math.floor(f * FUNNEL_STEPS) % DASH.length]);
    map.setPaintProperty('lm-flow-run', 'line-opacity', dim);
    map.setPaintProperty('lm-flow-count', 'text-opacity', dim);
    map.setPaintProperty('lm-flow-count', 'icon-opacity', dim);
    const dot = ['case', is('sel'), 1, ['==', ['get', 'action'], ''], 0.85 * dim, 0.55 * dim];
    map.setPaintProperty('lm-pat', 'circle-opacity', dot);
    map.setPaintProperty('lm-pat', 'circle-stroke-opacity', dot);
    map.setPaintProperty('lm-pat-label', 'text-opacity', ['case', is('sel'), 1, dim]);
  }

  function applyPower() {
    if (!ready) return;
    const off = isDead(), dead = (k) => ['all', off, ['==', ['get', k], true]], live = (k) => ['!', dead(k)];
    // Power off: the shutoff area goes dark under the grid, buildings and labels.
    map.setPaintProperty('lm-outage-mask', 'fill-opacity-transition', { duration: reduced() ? 0 : 600, delay: 0 });
    map.setPaintProperty('lm-outage-mask', 'fill-opacity', off ? (S.theme === 'dark' ? 0.5 : 0.22) : 0);
    map.setFilter('lm-trans-line', live('in_outage')); map.setFilter('lm-trans-dead', dead('in_outage')); map.setFilter('lm-trans-dead-casing', dead('in_outage'));
    map.setFilter('lm-feeder-live', live('deenergized')); map.setFilter('lm-feeder-flow', live('deenergized'));
    map.setFilter('lm-feeder-dead', dead('deenergized'));
    map.setLayoutProperty('lm-subs', 'icon-image', ['case', dead('in_outage'), 'lm-sub-dead', 'lm-sub-live']);
    map.setPaintProperty('lm-subs', 'icon-opacity', ['case', dead('in_outage'), 0.7, 1]);
    map.setPaintProperty('lm-subs', 'text-color', ['case', dead('in_outage'), T.deadInk, T.trans]);
    map.setLayoutProperty('lm-feeder-label', 'text-field', ['case', dead('deenergized'), 'No power: feeder (illustrative)', 'Feeder (illustrative)']);
    map.setPaintProperty('lm-feeder-label', 'text-color', ['case', dead('deenergized'), T.deadInk, T.powerInk]);
    // Real OSM lines drawn dead are a simulation: say so on the line.
    map.setLayoutProperty('lm-trans-label', 'text-field', ['case', dead('in_outage'), ['concat', ['get', 'kv'], ' · no power (simulated)'], ['get', 'kv']]);
    map.setPaintProperty('lm-trans-label', 'text-color', ['case', dead('in_outage'), T.deadInk, T.trans]);
  }

  // ---------- feeder current animation ----------

  function tick(t) {
    raf = requestAnimationFrame(tick);
    const s = Math.floor(t / DASH_MS) % DASH.length;
    if (s !== dashStep && ready && map.getLayer('lm-feeder-flow')) { dashStep = s; map.setPaintProperty('lm-feeder-flow', 'line-dasharray', DASH[s]); }
  }

  // Runs only while wanted: not paused, motion allowed, tab visible, zoomed in enough to see feeders, a live feeder exists.
  function syncAnim() {
    const want = ready && S.anim && !reduced() && !document.hidden && map.getZoom() >= ANIM_MIN_ZOOM
      && D.feeders.features.some((f) => !(isDead() && f.properties.deenergized));
    if (want && !raf) raf = requestAnimationFrame(tick);
    else if (!want && raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  // ---------- facility markers (DOM) ----------

  function injectCss() {
    if (document.getElementById('lm-css')) return;
    const css = document.createElement('style');
    css.id = 'lm-css';
    css.textContent = `
.lm-fac{--pin:26px;--stem:10px;appearance:none;background:none;border:0;margin:0;padding:0 0 var(--stem);display:block;width:var(--pin);cursor:pointer;font-family:var(--f-ui);text-align:left;color:var(--map-ink);-webkit-tap-highlight-color:transparent}
.lm-fac.is-home{--pin:30px}
.lm-fac.is-tall{--stem:30px}
.lm-fac.is-small{--pin:24px;--stem:7px}
.lm-fac.is-small.is-home{--pin:26px}
.lm-fac.is-small .lm-pin svg{width:13px;height:13px}
.lm-pin{box-sizing:border-box;width:var(--pin);height:var(--pin);border-radius:50%;display:grid;place-items:center;background:var(--paper);border:1.5px solid var(--line-2);color:var(--ink-2);box-shadow:var(--shadow);transition:background-color .2s ease-out,border-color .2s ease-out,color .2s ease-out,transform .15s ease-out}
.lm-fac.is-home .lm-pin{border:2px solid var(--map-ink);color:var(--map-ink)}
.lm-fac.is-hosp .lm-pin{border-radius:6px;background:var(--map-transfer);border-color:var(--map-transfer);color:var(--map-halo)}
.lm-fac[data-st=closed] .lm-pin{background:var(--map-outage);border-color:var(--map-outage);color:var(--map-halo)}
.lm-fac[data-st=receiving] .lm-pin{background:var(--map-early);border-color:var(--map-early);color:var(--map-halo)}
.lm-fac.is-home[data-st=closed] .lm-pin,.lm-fac.is-home[data-st=receiving] .lm-pin{border-color:var(--map-ink)}
.lm-stem{position:absolute;left:calc(var(--pin) / 2 - .75px);top:var(--pin);width:1.5px;height:var(--stem);background:var(--map-ink);opacity:.75}
.lm-stem::after{content:"";position:absolute;left:-2.25px;bottom:-3px;width:6px;height:6px;border-radius:50%;background:var(--map-ink);box-shadow:0 0 0 1.5px var(--map-halo)}
.lm-txt{position:absolute;left:calc(var(--pin) + 4px);top:calc(var(--pin) / 2);transform:translateY(-50%);display:flex;flex-direction:column;padding:1px 4px 2px;border-radius:4px;background:var(--map-halo);white-space:nowrap;line-height:1.15}
.lm-fac.lbl-left .lm-txt{left:auto;right:calc(100% + 4px);align-items:flex-end;text-align:right}
.lm-name{font-size:13px;font-weight:600;letter-spacing:.005em}
.lm-sub{font-size:11.5px;font-weight:500;color:var(--ink-2);margin-top:1px}
.lm-fac[data-st=closed] .lm-sub{color:var(--red-ink)}
.lm-fac[data-st=receiving] .lm-sub{color:var(--green-ink)}
.lm-fac.no-sub .lm-sub{display:none}
.lm-early{display:none;align-self:flex-start;margin:2px 0 1px;padding:0 5px;border-radius:4px;background:var(--green-bg);color:var(--green-ink);font-size:11.5px;font-weight:600}
.lm-fac.lbl-left .lm-early{align-self:flex-end}
.lm-fac.has-early .lm-early{display:block}
.lm-fac{transition:opacity .2s ease-out}
.lm-fac.lm-dim{opacity:.35}
.lm-call{pointer-events:none;box-sizing:border-box;max-width:260px;display:flex;flex-direction:column;gap:2px;padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font-family:var(--f-ui);font-size:12.5px;line-height:1.3;box-shadow:var(--shadow)}
.lm-call-t{font-weight:600}
.lm-call-n{color:var(--mute)}
.lm-call-f{color:var(--red-ink);font-weight:600}
.lm-area{display:inline-block;pointer-events:none;white-space:nowrap;font-family:var(--f-ui);font-size:13px;font-weight:700;letter-spacing:.02em;color:var(--map-outage);background:var(--map-halo);padding:0 4px;border-radius:4px;opacity:0;transition:opacity .4s ease-out}
.lm-area.on{opacity:1}
.lm-fac.no-label .lm-txt{visibility:hidden}
.lm-fac:hover,.lm-fac:focus-visible{z-index:9!important}
.lm-fac:hover .lm-pin{transform:scale(1.07)}
.lm-fac:focus{outline:none}
.lm-fac:focus-visible .lm-pin{outline:2px solid var(--focus);outline-offset:2px}
.lm-fac:hover .lm-txt,.lm-fac:focus-visible .lm-txt{visibility:visible}
.maplibregl-ctrl.maplibregl-ctrl-group,.maplibregl-ctrl.maplibregl-ctrl-attrib,.maplibregl-ctrl-scale{background:var(--paper);color:var(--ink-2);font-family:var(--f-ui)}
.maplibregl-ctrl.maplibregl-ctrl-group{border-radius:8px;box-shadow:var(--shadow)}
.maplibregl-ctrl-group button+button{border-top-color:var(--line)}
.maplibregl-ctrl-attrib a{color:inherit}
.maplibregl-ctrl-scale{border-color:var(--ink-2)}
:root[data-theme=dark] .maplibregl-ctrl-icon,:root[data-theme=dark] .maplibregl-ctrl-attrib-button{filter:invert(1) hue-rotate(180deg)}
@media (prefers-reduced-motion:reduce){.lm-fac,.lm-pin,.lm-area{transition:none}.lm-fac:hover .lm-pin{transform:none}}`;
    document.head.appendChild(css);
  }

  // Same rule as the panel's short name (app.js), so the visible pin text is part of its accessible name.
  const shortName = (n) => String(n || '').replace(/\s+Dialysis(\s+(Center|Clinic))?$/i, '');

  // st is the real status (not the simulated look), so a closed clinic always says what happens to its power.
  function subLabel(f, st, n) {
    if (f.kind === 'hospital') return n ? `Hospital · ${n} staff call${n > 1 ? 's' : ''}` : 'Hospital';
    const s = st === 'closed' ? ({ off: 'no power', restored: 'power back' }[S.scene && S.scene.power] || 'loses power')
      : st === 'receiving' ? `receiving${n ? ' ' + n : ''}` : '';
    if (f.home) return s ? `Home · ${s}` : 'Home clinic';
    if (s) return s[0].toUpperCase() + s.slice(1);
    return f.stations ? `${f.stations} stations` : 'Dialysis';
  }

  function buildMarkers() {
    markers.forEach((m) => m.marker.remove());
    markers = [];
    if (!map) return;
    S.facilities.forEach((f) => {
      if (!Number.isFinite(f.lng) || !Number.isFinite(f.lat)) return;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'lm-fac';
      el.innerHTML = `<span class="lm-stem"></span><span class="lm-pin">${f.kind === 'hospital' ? HOSP : DROP}</span><span class="lm-txt"><span class="lm-name"></span><span class="lm-sub"></span><span class="lm-early"></span></span>`;
      el.addEventListener('click', (e) => { e.stopPropagation(); if (opts.onSelect) opts.onSelect({ type: 'facility', id: f.id }); });
      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom-left' }).setLngLat(facPt(f)).addTo(map);
      markers.push({ f, el, marker, name: el.querySelector('.lm-name'), sub: el.querySelector('.lm-sub'), early: el.querySelector('.lm-early'), txt: el.querySelector('.lm-txt'), key: '' });
    });
    updateMarkers();
  }

  function updateMarkers() {
    if (!map) return;
    const zm = map.getZoom(), short = zm < 12, noSub = zm < 11, tall = zm >= 14.5, small = zm < 10.5;
    markers.forEach((m) => {
      const f = m.f, raw = rawStatus(f), st = statusOf(f), n = S.recv[f.id] || 0, name = short ? shortName(f.name) : f.name, sub = subLabel(f, raw, n);
      const early = S.early[f.id] ? `${S.early[f.id]} come in early` : '', dim = !!S.pr && !S.pr.keep.has(f.id);
      // Status text stays at every zoom, so closed and receiving never rely on pin color alone.
      const ns = noSub && !f.home && (raw === 'normal' || (f.kind === 'hospital' && !n));
      const key = `${st}|${name}|${sub}|${early}|${dim}|${ns}|${tall}|${small}`;
      if (key === m.key) return;
      m.key = key;
      m.el.dataset.st = st;
      m.el.classList.toggle('is-home', !!f.home);
      m.el.classList.toggle('is-hosp', f.kind === 'hospital');
      m.el.classList.toggle('no-sub', ns);
      m.el.classList.toggle('is-tall', tall);
      m.el.classList.toggle('is-small', small);
      m.el.classList.toggle('has-early', !!early);
      m.el.classList.toggle('lm-dim', dim);
      m.stem = tall ? 30 : small ? 7 : 10;
      m.pin = small ? (f.home ? 26 : 24) : (f.home ? 30 : 26);
      m.marker.setOffset([-m.pin / 2, 0]); // keeps the stem foot on the point
      m.name.textContent = name;
      m.sub.textContent = sub;
      m.early.textContent = early;
      m.el.setAttribute('aria-label', `${f.name}. ${sub}${early ? `. ${early}` : ''}`);
      m.el.style.zIndex = f.home ? 3 : st === 'normal' ? 1 : 2;
      m.rank = f.home ? 0 : RANK[st] != null ? RANK[st] : 4;
      m.lw = m.txt.offsetWidth; m.lh = m.txt.offsetHeight;
    });
    placeLabels();
  }

  // Put each facility label on its current side, else the other side, else hide it; never over another pin or a
  // higher-priority label (pins always stay). Home goes first and is never hidden; the area label comes right after home.
  function placeLabels() {
    const box0 = map.getContainer(), W = box0.clientWidth, H = box0.clientHeight;
    const items = markers.map((m) => {
      const p = map.project(m.marker.getLngLat()), tab = p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H ? 0 : -1;
      if (m.el.tabIndex !== tab) m.el.tabIndex = tab; // no focus stops on pins outside the map
      return { m, p, pin: [p.x - m.pin / 2 - 2, p.y - m.stem - m.pin - 2, p.x + m.pin / 2 + 2, p.y + 3] };
    });
    // While one patient's route is shown, faded pins do not push labels away, and faded labels place last.
    const faded = (m) => m.el.classList.contains('lm-dim');
    const placed = items.filter((i) => !faded(i.m)).map((i) => i.pin);
    const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
    if (S.pr && call.w) { // route callout under the destination pin (above it near the bottom edge), kept inside the map
      const q = map.project(S.pr.to), w = call.w, h = call.h, below = q.y + 12, above = q.y - 46 - h;
      const y = below + h <= H - 8 || above < 8 ? below : above, x = clamp(q.x - w / 2, 8, Math.max(8, W - w - 8));
      call.marker.setOffset([x - q.x, y - q.y]);
      placed.push([x, y, x + w, y + h]);
    }
    const npin = placed.length;
    const placeArea = () => { // area label: where it is now, else center, else the first nearby spot no pin or label covers
      if (!area.box) return;
      const labels = placed.slice(npin); // pins (and the route callout) come first; after them only the home label is placed yet
      const c = map.project(area.marker.getLngLat()), [w, h] = area.box, dx = w / 2 + 12, dy = h + 6, cur = area.marker.getOffset();
      const at = ([x, y]) => [c.x + x - w / 2, c.y + y - h / 2, c.x + x + w / 2, c.y + y + h / 2];
      const fits = (o) => { const b = at(o); return b[0] >= 0 && b[1] >= 0 && b[2] <= W && b[3] <= H && !placed.some((p) => hit(b, p)); };
      // Nothing free: centered, but pulled inside the map edges while the area's center is on screen.
      const off = [[cur.x, cur.y], [0, 0], [dx, 0], [0, dy], [0, -dy], [-dx, 0], [dx, dy], [dx, -dy]].find(fits)
        || (c.x >= 0 && c.x <= W && c.y >= 0 && c.y <= H ? [clamp(0, w / 2 - c.x, W - w / 2 - c.x), clamp(0, h / 2 - c.y, H - h / 2 - c.y)] : [0, 0]);
      if (cur.x !== off[0] || cur.y !== off[1]) area.marker.setOffset(off);
      // Over a label or past the map edge: hide it; the red area and its legend row still say what it is.
      const b = at(off), show = b[0] >= 0 && b[1] >= 0 && b[2] <= W && b[3] <= H && !labels.some((p) => hit(b, p));
      area.text.style.visibility = show ? '' : 'hidden';
      if (show) placed.push(b);
    };
    let areaDone = false;
    items.sort((a, b) => a.m.rank + 10 * faded(a.m) - b.m.rank - 10 * faded(b.m)).forEach(({ m, p, pin }) => {
      if (!m.f.home && !areaDone) { areaDone = true; placeArea(); }
      const cy = p.y - m.stem - m.pin / 2, top = cy - Math.max(m.lh, m.pin) / 2, bottom = cy + Math.max(m.lh, m.pin) / 2 + 1; // label is centered on the pin
      const right = [p.x + m.pin / 2 + 2, top - 1, p.x + m.pin / 2 + 6 + m.lw, bottom];
      const left = [p.x - m.pin / 2 - 6 - m.lw, top - 1, p.x - m.pin / 2 - 2, bottom];
      const free = (box) => box[0] >= 0 && box[2] <= W && !placed.some((b) => b !== pin && hit(box, b));
      const [a, b] = m.el.classList.contains('lbl-left') ? [left, right] : [right, left];
      const box = free(a) ? a : free(b) ? b : m.f.home ? (right[2] <= W ? right : left) : null;
      if (box) placed.push(box);
      m.el.classList.toggle('no-label', !box);
      m.el.classList.toggle('lbl-left', box === left);
    });
    if (!areaDone) placeArea();
    // Route badges slide along their route off pins, labels and each other. The symbol layer cannot see DOM pins, so a
    // badge with no free spot is hidden (the route line and the Routes table still carry its numbers).
    let moved = false;
    const short = map.getZoom() < 11;
    [...counts].sort((a, b) => b.props.changed - a.props.changed || b.props.n - a.props.n).forEach((c) => {
      const w = (short ? c.props.s : c.props.l).length * 7 + 20, box = (t) => { const q = map.project(along(c, t)); return [q.x - w / 2, q.y - 12, q.x + w / 2, q.y + 12]; };
      const t = [c.t, 0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78].find((x) => !placed.some((b) => hit(box(x), b))), hide = t == null;
      if (!hide) placed.push(box(t));
      if (hide !== !!c.hide || (!hide && t !== c.t)) { c.hide = hide; if (!hide) c.t = t; moved = true; }
    });
    if (moved) writeCounts();
  }

  function onMove() {
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => { moveRaf = 0; updateMarkers(); syncAnim(); });
  }

  function showAreaLabel() {
    if (!map) return;
    const lp = S.outage && labelPoint(S.outage);
    if (!area.marker) {
      const el = document.createElement('div');
      el.innerHTML = '<span class="lm-area">Shutoff area (illustrative)</span>';
      el.style.zIndex = 0;
      area.text = el.firstChild;
      area.marker = new maplibregl.Marker({ element: el, anchor: 'center' });
    }
    if (!lp) { area.marker.remove(); area.text.classList.remove('on'); area.box = null; updateMarkers(); return; }
    area.marker.setLngLat(lp).addTo(map);
    area.box = [area.text.offsetWidth + 8, area.text.offsetHeight + 4];
    requestAnimationFrame(() => area.text.classList.add('on'));
    updateMarkers();
  }

  // ---------- geometry helpers ----------

  function labelPoint(g) {
    const rings = [];
    const walk = (o) => {
      if (!o) return;
      if (o.type === 'FeatureCollection') o.features.forEach(walk);
      else if (o.type === 'Feature') walk(o.geometry);
      else if (o.type === 'Polygon') rings.push(o.coordinates[0]);
      else if (o.type === 'MultiPolygon') o.coordinates.forEach((p) => rings.push(p[0]));
    };
    walk(g);
    let best = null, size = 0;
    rings.forEach((r) => {
      let a = 0, x = 0, y = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const c = r[j][0] * r[i][1] - r[i][0] * r[j][1];
        a += c; x += (r[j][0] + r[i][0]) * c; y += (r[j][1] + r[i][1]) * c;
      }
      if (Math.abs(a) > size) { size = Math.abs(a); best = [x / (3 * a), y / (3 * a)]; }
    });
    return best;
  }

  function coordsOf(o, out = []) {
    const flat = (c) => (typeof c[0] === 'number' ? out.push(c) : c.forEach(flat));
    if (!o) return out;
    if (o.type === 'FeatureCollection') o.features.forEach((f) => coordsOf(f, out));
    else if (o.type === 'Feature') coordsOf(o.geometry, out);
    else if (o.coordinates) flat(o.coordinates);
    return out;
  }

  // Grow a footprint 3% around its center so its walls never sit exactly on the basemap building's walls (z-fighting).
  function grow(g) {
    if (!g || g.type !== 'Polygon') return g;
    const r = g.coordinates[0], cx = r.reduce((s, c) => s + c[0], 0) / r.length, cy = r.reduce((s, c) => s + c[1], 0) / r.length;
    return { type: 'Polygon', coordinates: g.coordinates.map((ring) => ring.map(([x, y]) => [cx + (x - cx) * 1.03, cy + (y - cy) * 1.03])) };
  }

  // Convex hull of LngLats (monotone chain on Mercator y, where the camera's projection keeps straight lines straight).
  function hull(pts) {
    if (pts.length < 4) return pts;
    const P = pts.map((p) => [p.lng, Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI) / 360)), p]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (list) => list.reduce((h, q) => { while (h.length > 1 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop(); h.push(q); return h; }, []);
    const lo = half(P), up = half(P.slice().reverse());
    return [...lo.slice(0, -1), ...up.slice(0, -1)].map((q) => q[2]);
  }

  // Camera that fits pts inside the padded view at this pitch. cameraForBounds ignores pitch, so search zoom and
  // center on a copy of the map transform (MapLibre 4.x internals; falls back to the flat answer if they are missing).
  function camFor(pts, pitch, bearing, maxZoom, pad = FIT_PAD) {
    pts = pts.filter(Boolean).map((p) => maplibregl.LngLat.convert(p));
    if (!pts.length) return null;
    const el = map.getContainer();
    pad = Math.min(pad, el.clientWidth / 5, el.clientHeight / 5); // small maps (phones) keep room for the content
    const bounds = new maplibregl.LngLatBounds();
    pts.forEach((p) => bounds.extend(p));
    const ll = hull(pts); // fitting the hull fits every point, and stays fast with hundreds of homes and route points
    const flat = map.cameraForBounds(bounds, { padding: pad, bearing, maxZoom });
    if (!flat) return null;
    const cam = { center: flat.center, zoom: flat.zoom, pitch, bearing };
    const tr = pitch && map.transform && map.transform.clone ? map.transform.clone() : null;
    if (!tr || !tr.locationPoint || !tr.pointLocation) return cam;
    const P = tr.padding, box = [P.left + pad, P.top + pad, tr.width - P.right - pad, tr.height - P.bottom - pad];
    if (box[2] <= box[0] || box[3] <= box[1]) return cam;
    tr.bearing = bearing; tr.pitch = pitch; tr.center = flat.center;
    const place = (zm) => { // center the points in the box at this zoom; true when they fit
      tr.zoom = zm;
      let r = null;
      for (let i = 0; i < 4; i++) {
        const q = ll.map((p) => tr.locationPoint(p)), xs = q.map((p) => p.x), ys = q.map((p) => p.y);
        r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        const c = tr.locationPoint(tr.center);
        c.x += (r[0] + r[2] - box[0] - box[2]) / 2; c.y += (r[1] + r[3] - box[1] - box[3]) / 2;
        tr.center = tr.pointLocation(c);
      }
      return r[2] - r[0] <= box[2] - box[0] && r[3] - r[1] <= box[3] - box[1];
    };
    let lo = flat.zoom - 2, hi = Math.min(maxZoom, flat.zoom + 2);
    if (place(hi)) lo = hi;
    else for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (place(mid)) lo = mid; else hi = mid; }
    place(lo);
    return { center: tr.center, zoom: lo, pitch, bearing };
  }

  // ---------- public API ----------

  async function init(container, o = {}) {
    if (!window.maplibregl) throw new Error('The map library did not load.');
    opts = { ...o };
    S.theme = o.theme === 'dark' ? 'dark' : 'light';
    amazon = !!opts.mapKey;
    injectCss();
    map = new maplibregl.Map({ container, style: styleUrl(), center: (S.region && S.region.home_center) || [-120.97, 38.66], zoom: 9.5,
      attributionControl: false, antialias: true, maxPitch: 70, fadeDuration: 150 });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'imperial' }), 'bottom-left');
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: OSM }), 'bottom-right');
    map.setPadding(S.pad);
    map.on('style.load', () => {
      ready = true; dashStep = -1;
      readTokens(); pickFonts(); addOverlays(); renderAll(); syncAnim();
    });
    map.on('error', (e) => { // Amazon style failed to load: fall back to OpenFreeMap for the rest of the session
      if (amazon && !ready && !e.sourceId && !e.tile) { amazon = false; opts.mapKey = ''; map.setStyle(styleUrl(), { diff: false }); }
      else console.warn('LumenMap', (e && e.error) || e);
    });
    map.on('click', 'lm-pat', (e) => { const f = e.features && e.features[0]; if (f && opts.onSelect) opts.onSelect({ type: 'patient', id: f.properties.id }); });
    map.on('mouseenter', 'lm-pat', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'lm-pat', () => { map.getCanvas().style.cursor = ''; });
    map.on('move', onMove);
    map.on('resize', onMove);
    map.on('moveend', () => { flying = null; });
    // A person tilting with the mouse or resetting with the compass changes 3D; tell the app so its button stays true.
    map.on('pitchend', (e) => {
      if (!e.originalEvent) return;
      const on = map.getPitch() > 10;
      if (on !== S.is3D) { S.is3D = on; if (opts.on3D) opts.on3D(on); }
    });
    document.addEventListener('visibilitychange', syncAnim);
    mq.addEventListener('change', syncAnim);
    buildMarkers();
    showAreaLabel();
    await new Promise((r) => { map.once('load', r); setTimeout(r, 10000); });
  }

  function setTheme(theme) {
    theme = theme === 'dark' ? 'dark' : 'light';
    if (theme === S.theme) return;
    S.theme = theme;
    if (!map) return;
    ready = false; syncAnim();
    amazon = !!opts.mapKey;
    map.setStyle(styleUrl(), { diff: false });
  }

  function setRegion(region, facilities) {
    S.region = region || null;
    S.facilities = (facilities || []).slice();
    const r = region || {};
    D.trans = fc(((r.transmission || EMPTY).features || []).map((f) => {
      const kvs = [...new Set(String(f.properties.voltage || '').split(';').map(Number).filter((v) => v >= 1000).map((v) => Math.round(v / 1000)))].sort((a, b) => b - a);
      const p = { ...f.properties, w: kvs[0] >= 200 ? 1.4 : kvs[0] >= 100 ? 1 : kvs[0] >= 50 ? 0.8 : 0.6 };
      if (kvs.length) p.kv = `${kvs.join('/')} kV`;
      return { ...f, properties: p };
    }));
    D.subs = r.substations || EMPTY;
    D.feeders = r.feeders || EMPTY;
    D.county = r.county || EMPTY; // E9: faint outline when the region has one
    S.pr = null; renderPr(); // a patient route never outlives its county
    D.fp = ((r.footprints || EMPTY).features || []).map((f) => ({ id: f.properties.facility_id, levels: f.properties.levels,
      gen: f.properties.source === 'generated', geometry: grow(f.geometry) }));
    D.center = Object.fromEntries(D.fp.filter((f) => f.geometry && f.geometry.type === 'Polygon').map((f) => {
      const r0 = f.geometry.coordinates[0];
      return [f.id, [r0.reduce((a, c) => a + c[0], 0) / r0.length, r0.reduce((a, c) => a + c[1], 0) / r0.length]];
    }));
    computeRecv();
    buildMarkers();
    if (ready) { setSrc('lm-trans', D.trans); setSrc('lm-subs', D.subs); setSrc('lm-feeders', D.feeders); setSrc('lm-county', D.county); renderFp(); renderFlows(); }
    syncAnim();
  }

  // Per facility: patients moving in (routes) and patients coming in early (no route; shown on the clinic label).
  function computeRecv() {
    S.recv = {}; S.early = {};
    (S.flows || []).forEach((fl) => {
      const f = fl && fl.action !== 'early_session' && (facById(fl.toId) || facAt(fl.to));
      if (f) S.recv[f.id] = (S.recv[f.id] || 0) + 1;
    });
    const home = S.facilities.find((x) => x.home);
    (S.patients || []).forEach((p) => {
      const f = p && p.action === 'early_session' && (facAt(p.to) || home);
      if (f) S.early[f.id] = (S.early[f.id] || 0) + 1;
    });
  }

  function focus(target, o = {}) {
    if (!map || !target) return;
    const duration = reduced() ? 0 : o.duration != null ? o.duration : 1400;
    const view = (kind) => (S.is3D ? VIEW3D[kind] : [0, 0]);
    const go = (cam) => {
      if (!cam) return;
      if (!duration) { map.jumpTo(cam); flying = null; return; }
      map.flyTo({ ...cam, duration, essential: true });
      flying = [target, o]; // after flyTo: the flight it interrupts ends (moveend) inside that call
    };
    const fit = (pts, kind, maxZoom = 14.5, pad) => { const [pitch, bearing] = view(kind); go(camFor(pts, pitch, bearing, maxZoom, pad)); };
    const at = (center, zoom, kind) => { const [pitch, bearing] = view(kind); go({ center, zoom, pitch, bearing }); };
    const home = S.facilities.find((f) => f.home);
    const bbox = S.region && S.region.bbox;
    const region = () => bbox && fit([[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]], 'over');
    // The whole affected area: shutoff polygon, home clinic and every affected patient's home.
    const whole = () => [...coordsOf(S.outage), facPt(home), ...(S.patients || []).filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat)).map((p) => [p.lng, p.lat])];
    if (target === 'home') { // the home building, its feeder and the substation that feeds it
      if (!home) return region();
      return fit([facPt(home), ...coordsOf(D.feeders.features.find((f) => f.properties.facility_id === home.id))], 'home', 15.2);
    }
    if (target === 'region') return region();
    if (target === 'outage') return S.outage ? fit(whole(), 'over') : region();
    if (target === 'flows') { // after a re-plan: the changed routes and home (D7); else, or with { all: true }, the whole plan and area
      const fl = (S.flows || []).filter((f) => f && f.from && f.to), ch = o.all ? [] : fl.filter((f) => f.changed);
      const pts = (ch.length ? ch : fl).flatMap((f) => [snap(f.from), snap(f.to)]);
      const roads = counts.filter((c) => !ch.length || c.props.changed).flatMap((c) => c.line); // roads can bulge past their ends
      return pts.length ? fit([...pts, ...roads, ...(ch.length ? [facPt(home)] : whole())], 'over') : region();
    }
    if (target.facility != null) { const f = S.facilities.find((x) => x.id === target.facility); return f && at(facPt(f), 15.5, 'near'); }
    if (target.patient != null) { // their route (home and destination together), else just their home
      const pr = S.pr && S.pr.id === target.patient && S.pr, p = (S.patients || []).find((x) => x.id === target.patient);
      if (pr) return fit([pr.home, pr.to, ...(isLine(pr.line) ? pr.line : [])], 'over', 14, 110); // room for the name and the callout
      if (p && Array.isArray(p.to)) return fit([[p.lng, p.lat], snap(p.to)], 'over', 14);
      return p && at([p.lng, p.lat], 14, 'near');
    }
  }

  function set3D(on) {
    S.is3D = !!on;
    if (!map) return;
    if (flying) return focus(flying[0], { ...flying[1], duration: 700 }); // re-aim the running flight instead of freezing it halfway
    const cam = { pitch: S.is3D ? 50 : 0, bearing: S.is3D ? -15 : 0 };
    if (reduced()) map.jumpTo(cam); else map.easeTo({ ...cam, duration: 700 });
  }

  window.LumenMap = {
    init,
    setTheme,
    setRegion,
    showOutage(g) { S.outage = g || null; renderOutage(false); showAreaLabel(); },
    setPower(dead) { S.dead = !!dead; applyPower(); syncAnim(); },
    setFacilityStatus(statusById) { S.status = { ...(statusById || {}) }; renderFp(); updateMarkers(); },
    setPatients(list) { S.patients = list || null; computeRecv(); renderPatients(); updateMarkers(); },
    // Items {id, fromId, toId, from:[lng,lat], to:[lng,lat], action, changed}; ids are optional (found from the coordinates).
    setFlows(list) { S.flows = list || null; computeRecv(); renderFlows(); updateMarkers(); },
    // Parsed data/routes-<region>.json, or null (file missing: every route is a straight "Road route pending" line).
    setRoutes(data) { S.routes = data && typeof data === 'object' ? data : null; renderFlows(); updateMarkers(); },
    routeInfo(fromId, toId) {
      const r = pairOf(fromId, toId);
      return r && (Number.isFinite(r.seconds) || Number.isFinite(r.meters))
        ? { minutes: Number.isFinite(r.seconds) ? Math.round(r.seconds / 60) : null, miles: Number.isFinite(r.meters) ? Number(miles(r.meters)) : null } : null;
    },
    // E2: {id, home, to, line|null, minutes, miles, label, action?, note?}; draws that route on top, dims the rest, fits it.
    showPatientRoute(p) {
      if (!p || !Array.isArray(p.home) || !Array.isArray(p.to)) S.pr = null;
      else {
        const fl = (S.flows || []).find((x) => x && x.id === p.id), me = (S.patients || []).find((x) => x.id === p.id);
        const from = fl && (facById(fl.fromId) || facAt(fl.from)), to = facAt(p.to);
        S.pr = { ...p, action: p.action || (me && me.action) || (fl && fl.action) || 'transfer', keep: new Set([from, to].filter(Boolean).map((f) => f.id)) };
      }
      renderPatients(); renderPr(); applyFlowPaint(); updateMarkers();
      if (S.pr) focus({ patient: S.pr.id });
    },
    // E8: {power:'on'|'off'|'restored', funnel:0..1}; null hands power back to setPower. Called every animation frame,
    // so only a power change redraws the grid and clinics.
    setScene(sc) {
      const prev = S.scene && S.scene.power, f = sc && Number(sc.funnel);
      S.scene = sc ? { power: ['on', 'off', 'restored'].includes(sc.power) ? sc.power : 'on', funnel: Number.isFinite(f) ? clamp(f, 0, 1) : 1 } : null;
      if ((S.scene && S.scene.power) !== prev) { applyPower(); renderFp(); updateMarkers(); syncAnim(); }
      applyFlowPaint();
    },
    focus,
    set3D,
    is3D: () => S.is3D,
    // Ring + label on the dot. A route shown for another patient goes away (it belongs to the selected patient).
    selectPatient(id) {
      S.sel = id == null ? null : id;
      if (S.pr && S.pr.id !== S.sel) S.pr = null;
      renderPatients(); renderPr(); applyFlowPaint(); updateMarkers();
    },
    setAnimation(on) { S.anim = on !== false; syncAnim(); },
    setPadding(p) {
      S.pad = { top: 0, right: 0, bottom: 0, left: 0, ...(p || {}) };
      if (!map) return;
      const f = flying; // map.setPadding is a jumpTo: it stops a running flyTo, so re-aim that flight
      map.setPadding(S.pad);
      if (f) focus(f[0], { ...f[1], duration: 700 });
    },
    resize() { if (map) map.resize(); },
    get map() { return map; }, // debugging only
  };
})();
