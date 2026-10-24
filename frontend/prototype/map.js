/* Lumen map: window.LumenMap on MapLibre GL JS 4.7.1 (global maplibregl).
   Contracts: CONTRACT.md "Map module", CONTRACT-v2 E1/E2/E7-E9, CONTRACT-v3 R3 (capacity labels), R4 (route traces),
   R6 (one status per label, no ranks), R7 (road lines come only from the app's live Amazon Location results),
   R8 (a selection shows one path only), R9 (the visible search that builds the plan).
   CONTRACT-v5 section 6, with no new API: the map reads the run from the calls it already gets.
   - The grid (power lines, substations, feeders, kV labels) shows only while the clinic loses power: it fades in as
     flyHome3D lands, and fades out when setPatients brings the homes (also setFlows with a plan, setPower(false), setRegion).
     Grid lines follow setPower only; setScene still darkens the shutoff area.
   - The plan is on the map once setFlows, setCapacity or setPatients (a row with an action) carries it. Then: homes fade out
     except the selected patient and a route selection's patients; the county outline fades out; no chair bars; route
     badges only on a route with no road ("Road route not available"; traceRoutes' item label is no longer drawn); once the
     search is over, clinics that take nobody and an unused hospital hide.
   CONTRACT-v6 sections 2 and 3, still no new API: receiving clinics read "16 of 18 slots" (setCapacity used of open,
   counting up as routes land) or "Full". For several dark clinics: a search keeps only the edges earlier clinics use, a
   facility's search status sums them, crowded plan pins rise on longer stems, and a crowded label drops its early line,
   then hides (lesser labels first) instead of overlapping. */
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
  const FADE_MS = 500;           // v5 fades: the grid in and out, the homes and the county outline out
  const LIFTS = [0, 8, 16, 24, 32, 40]; // px a pin may rise on its stem to clear a pin placed before it
  // Grid layers and their full opacity; lm-subs' icon opacity depends on power, so applyFx writes it apart.
  const GRID = [['lm-trans-line', 'line-opacity', 0.85], ['lm-trans-dead-casing', 'line-opacity', 1], ['lm-trans-dead', 'line-opacity', 1],
    ['lm-feeder-casing', 'line-opacity', 1], ['lm-feeder-live', 'line-opacity', 0.32], ['lm-feeder-flow', 'line-opacity', 1], ['lm-feeder-dead', 'line-opacity', 1],
    ['lm-trans-label', 'text-opacity', 1], ['lm-subs', 'text-opacity', 1], ['lm-feeder-label', 'text-opacity', 1]];
  // [pitch, bearing] per kind of view while 3D is on; flat views use [0, 0].
  const VIEW3D = { home: [55, -20], over: [40, -15], near: [50, -15] };
  const DROP = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2C6.2 4.6 4.2 7.1 4.2 9.6a3.8 3.8 0 0 0 7.6 0C11.8 7.1 9.8 4.6 8 2.2z" fill="currentColor" fill-opacity=".18"/></svg>';
  const HOSP = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" aria-hidden="true"><path d="M5 3.8v8.4M11 3.8v8.4M5 8h6"/></svg>';

  const OK = '<svg class="lm-ok" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.4l2.3 2.3 4.7-5"/></svg>';
  const inOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const out = (t) => 1 - (1 - t) ** 3;

  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => mq.matches;
  const fc = (features) => ({ type: 'FeatureCollection', features });
  const point = (c, properties = {}) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: c } });
  const z = (...stops) => ['interpolate', ['linear'], ['zoom'], ...stops];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const is = (k) => ['==', ['get', k], true];
  const isLine = (l) => Array.isArray(l) && l.length > 1;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const calls = (n) => `${n} ${n === 1 ? 'needs' : 'need'} a phone call`;
  // Non-breaking space keeps a number with its unit ("21 min", "15.1 mi", "5:28 AM") wherever a line wraps.
  const keep = (s) => String(s || '').replace(/(\d) (?=(min|mi|AM|PM)\b)/g, '$1 ');

  let map = null, opts = {}, ready = false, amazon = false, raf = 0, dashStep = -1, moveRaf = 0, flying = null;
  let T = {}, fontR = ['Noto Sans Regular'], fontB = ['Noto Sans Bold'];
  let markers = [];
  let counts = []; // one per arrived route with a label: { k, line, cum, props, t, o, hide }; t = where along the route its badge sits (0..1), o = on the line (0), above (-1) or below (1)
  const area = { marker: null, text: null, box: null }; // DOM "Shutoff area" label, so facility labels can avoid it
  const call = { marker: null, el: null, w: 0, h: 0 };  // DOM callout at the selected patient's destination
  const run = { raf: 0, done: null };                   // the running traceRoutes animation
  const chip = { el: null, txt: null, w: 0, h: 0 };     // R8 "Showing … · Show all routes"
  // R9 search graph: nodes { k: source|facility, src, id, a, b (points), hosp, open, used, ok, d (distance), e (edge 0..1),
  // s (circle 0..1), st ''|'form'|'ok'|'no', done }; ring = frontier radius around c; gone = edges a road trace replaced.
  const G = { raf: 0, done: null, nodes: [], ring: 0, c: null, gone: new Set() };
  // v5 fades, each 0..1: grid = the grid (on only while the clinic loses power), pats = homes other than a selection, county.
  const FX = { v: { grid: 0, pats: 1, county: 1 }, to: { grid: 0, pats: 1, county: 1 }, raf: 0, t: 0 };
  const S = { theme: 'light', region: null, facilities: [], status: {}, dead: false, outage: null, patients: null,
    flows: null, recv: {}, early: {}, sel: null, pr: null, scene: null, cap: {}, iso: null, grid: false, gridT: 0,
    trace: [], // drawn routes from traceRoutes: { k, item, action, line, road, cum, n, label, p (0..1 drawn) }
    is3D: false, anim: true, pad: { top: 0, right: 0, bottom: 0, left: 0 } };
  const D = { trans: EMPTY, subs: EMPTY, feeders: EMPTY, county: EMPTY, fp: [], center: {} };

  // ---------- style, tokens, fonts ----------

  function styleUrl() {
    const dark = S.theme === 'dark';
    return amazon
      ? `https://maps.geo.us-east-2.amazonaws.com/v2/styles/Monochrome/descriptor?key=${encodeURIComponent(opts.mapKey)}&color-scheme=${dark ? 'Dark' : 'Light'}`
      : `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`;
  }

  // Map colors are the CSS tokens in app.css, read again on every theme change.
  function readTokens() {
    const cs = getComputedStyle(document.documentElement), v = (n, alt) => cs.getPropertyValue(n).trim() || (alt ? v(alt) : '');
    T = {
      power: v('--map-power'), dead: v('--map-dead'), trans: v('--map-trans'), outage: v('--map-outage'),
      early: v('--map-early'), transfer: v('--map-transfer'), staff: v('--map-staff'), affected: v('--map-affected'),
      ink: v('--map-ink'), halo: v('--map-halo'), mute: v('--mute'), paper: v('--paper'), line2: v('--line-2'), amberInk: v('--amber-ink'),
      mask: v('--map-mask', '--rail'), // dark in both themes
      powerInk: v('--green-ink'), deadInk: v('--red-ink'),
      warm: v('--map-fac', '--line-2'), // facility buildings
      bldg: v('--map-bldg', '--line'),  // faint basemap buildings
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

    ['lm-county', 'lm-outage', 'lm-trans', 'lm-subs', 'lm-feeders', 'lm-fp', 'lm-ring', 'lm-graph', 'lm-node', 'lm-flows', 'lm-head', 'lm-flow-mid', 'lm-pr', 'lm-pat']
      .forEach((id) => map.addSource(id, { type: 'geojson', data: EMPTY }));
    map.addImage('lm-sub-live', subIcon(T.trans, false), { pixelRatio: 2 });
    map.addImage('lm-sub-dead', subIcon(T.dead, true), { pixelRatio: 2 });
    map.addImage('lm-badge', badgeIcon(), { pixelRatio: 2, stretchX: [[12, 36]], stretchY: [[12, 36]], content: [10, 7, 38, 41] });

    // Under the basemap labels: county outline, power-off mask, outage fill, grid, outline, buildings.
    add({ id: 'lm-county-line', type: 'line', source: 'lm-county', layout: { 'line-join': 'round' }, paint: { 'line-color': T.ink, 'line-width': z(8, 1.25, 13, 2.25), 'line-dasharray': [4, 2.5] } }, before);
    add({ id: 'lm-outage-mask', type: 'fill', source: 'lm-outage', paint: { 'fill-color': T.mask, 'fill-opacity': 0, 'fill-opacity-transition': fade } }, before);
    add({ id: 'lm-outage-fill', type: 'fill', source: 'lm-outage', paint: { 'fill-color': T.outage, 'fill-opacity': 0, 'fill-opacity-transition': fade } }, before);
    const w = ['get', 'w'], tw = (k) => z(8, ['+', k, ['*', 1, w]], 11, ['+', k, ['*', 1.6, w]], 14, ['+', k, ['*', 2, w]], 17, ['+', k, ['*', 3, w]]);
    // Grid opacity and visibility come from applyFx (v5: the grid shows only while the clinic loses power).
    add({ id: 'lm-trans-line', type: 'line', source: 'lm-trans', layout: round, paint: { 'line-color': T.trans, 'line-width': tw(0) } }, before);
    // Dead lines are solid and opaque over a halo casing, so they never read as a second dashed shutoff edge.
    add({ id: 'lm-trans-dead-casing', type: 'line', source: 'lm-trans', layout: round, paint: { 'line-color': T.halo, 'line-width': tw(3.5) } }, before);
    add({ id: 'lm-trans-dead', type: 'line', source: 'lm-trans', layout: round, paint: { 'line-color': T.dead, 'line-width': tw(0.6) } }, before);
    add({ id: 'lm-feeder-casing', type: 'line', source: 'lm-feeders', layout: round, paint: { 'line-color': T.halo, 'line-width': z(10, 4.5, 15, 8.5) } }, before);
    add({ id: 'lm-feeder-live', type: 'line', source: 'lm-feeders', layout: round, paint: { 'line-color': T.power, 'line-width': z(10, 1.8, 15, 3.4) } }, before);
    add({ id: 'lm-feeder-flow', type: 'line', source: 'lm-feeders', layout: { 'line-join': 'round' }, paint: { 'line-color': T.power, 'line-width': z(10, 1.8, 15, 3.4), 'line-dasharray': DASH[0], 'line-dasharray-transition': fade } }, before);
    add({ id: 'lm-feeder-dead', type: 'line', source: 'lm-feeders', layout: round, paint: { 'line-color': T.dead, 'line-width': z(10, 2.2, 15, 4) } }, before);
    add({ id: 'lm-outage-line', type: 'line', source: 'lm-outage', layout: { 'line-join': 'round' }, paint: { 'line-color': T.outage, 'line-width': z(8, 1.25, 14, 2), 'line-opacity': 0, 'line-opacity-transition': fade } }, before);
    // R9: the soft frontier ring of the search.
    add({ id: 'lm-ring-fill', type: 'fill', source: 'lm-ring', paint: { 'fill-color': T.transfer, 'fill-opacity': 0.06 } }, before);
    add({ id: 'lm-ring-line', type: 'line', source: 'lm-ring', paint: { 'line-color': T.transfer, 'line-opacity': 0.4, 'line-width': 1.5, 'line-blur': 1 } }, before);

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

    // Above basemap labels: road routes from traceRoutes (one per closed clinic, destination and action; width grows with
    // the patient count; largest underneath, changed on top, 1 px halo casing), the selected patient's route, patients, labels.
    // R9 search graph under the routes: straight edges from the closed clinic and a circle forming at each visited node.
    const gcol = ['match', ['get', 'st'], 'ok', ['case', is('hosp'), T.staff, T.transfer], 'no', T.mute, T.ink];
    const gop = ['match', ['get', 'st'], 'no', 0.45, 0.9];
    add({ id: 'lm-graph-line', type: 'line', source: 'lm-graph', filter: ['!', is('hosp')], layout: round, paint: { 'line-color': gcol, 'line-opacity': gop, 'line-width': 2 } });
    add({ id: 'lm-graph-dash', type: 'line', source: 'lm-graph', filter: is('hosp'), layout: { 'line-join': 'round' }, paint: { 'line-color': gcol, 'line-opacity': gop, 'line-width': 2, 'line-dasharray': STAFF_DASH } });
    add({ id: 'lm-node', type: 'circle', source: 'lm-node', paint: { 'circle-radius': ['*', 14, ['get', 's']], 'circle-color': gcol, 'circle-opacity': 0.16,
      'circle-stroke-color': gcol, 'circle-stroke-opacity': gop, 'circle-stroke-width': 2, 'circle-pitch-alignment': 'map' } });
    const road = ['!', is('pending')];
    const sort = { 'line-sort-key': ['+', ['case', ['get', 'changed'], 1e4, 0], ['-', 0, ['get', 'n']]] };
    // R8: a wide invisible line, so a route is easy to click.
    add({ id: 'lm-flow-hit', type: 'line', source: 'lm-flows', layout: round, paint: { 'line-color': T.ink, 'line-opacity': 0, 'line-width': 16 } });
    add({ id: 'lm-flow-casing', type: 'line', source: 'lm-flows', filter: road, layout: { ...round, ...sort }, paint: { 'line-color': T.halo, 'line-width': ['+', ['get', 'w'], 2] } });
    add({ id: 'lm-flow-line', type: 'line', source: 'lm-flows', filter: ['all', road, ['!=', ['get', 'action'], 'hospital']], layout: { ...round, ...sort }, paint: { 'line-color': flowColor, 'line-width': ['get', 'w'] } });
    add({ id: 'lm-flow-staff', type: 'line', source: 'lm-flows', filter: ['all', road, ['==', ['get', 'action'], 'hospital']], layout: { 'line-join': 'round', ...sort }, paint: { 'line-color': flowColor, 'line-width': ['get', 'w'], 'line-dasharray': STAFF_DASH } });
    // Funnel: dashes moving from the closed clinic toward the destination (setScene funnel 0..1 steps the dash).
    add({ id: 'lm-flow-run', type: 'line', source: 'lm-flows', filter: road, layout: { 'line-join': 'round', visibility: 'none', ...sort }, paint: { 'line-color': flowColor, 'line-width': ['get', 'w'], 'line-dasharray': DASH[0] } });
    // No road route for the pair: a thin dashed straight line, never a fake road.
    add({ id: 'lm-flow-pending', type: 'line', source: 'lm-flows', filter: is('pending'), layout: { 'line-join': 'round' }, paint: { 'line-color': flowColor, 'line-width': 2, 'line-dasharray': STRAIGHT_DASH } });
    // The moving head of a route while it traces.
    add({ id: 'lm-head', type: 'circle', source: 'lm-head', paint: { 'circle-radius': 6, 'circle-color': act, 'circle-stroke-color': T.halo, 'circle-stroke-width': 2 } });
    add({ id: 'lm-pr-casing', type: 'line', source: 'lm-pr', layout: round, paint: { 'line-color': T.halo, 'line-width': 8 } });
    add({ id: 'lm-pr-line', type: 'line', source: 'lm-pr', filter: ['!', is('straight')], layout: round, paint: { 'line-color': act, 'line-width': 5 } });
    add({ id: 'lm-pr-straight', type: 'line', source: 'lm-pr', filter: is('straight'), layout: { 'line-join': 'round' }, paint: { 'line-color': act, 'line-width': 4, 'line-dasharray': STRAIGHT_DASH } });
    add({ id: 'lm-pat-ring', type: 'circle', source: 'lm-pat', filter: is('sel'), paint: { 'circle-radius': z(8, 7, 14, 10), 'circle-color': T.ink, 'circle-opacity': 0, 'circle-stroke-color': T.ink, 'circle-stroke-width': 2 } });
    // Home dots stay small (no lines from homes); the selected patient's dot is full strength; opacity comes from applyFx.
    add({ id: 'lm-pat', type: 'circle', source: 'lm-pat', layout: { 'circle-sort-key': ['case', ['get', 'sel'], 1, 0] }, paint: { 'circle-radius': z(8, 3, 14, 5.5), 'circle-color': act,
      'circle-stroke-color': T.halo, 'circle-stroke-width': 1.25 } });

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
      // One badge per arrived route, worded by the app. Badges collide with each other and hide instead of piling up:
      // changed routes place first, then the biggest counts.
      layout: { 'text-field': ['get', 'l'], 'text-font': fontB, 'text-size': 12, 'text-offset': ['match', ['get', 'o'], -1, ['literal', [0, -1.8]], 1, ['literal', [0, 1.8]], ['literal', [0, 0]]],
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
    renderFp(); renderOutage(true); renderPatients(); renderPr(); renderFlows(); drawGraph(); applyPower(); applyFlowPaint();
  }

  const rawStatus = (f) => S.status[f.id] || 'normal';
  // In a simulation (setScene) a closed clinic is drawn red only while its power is off.
  // A running search (R9) has not resolved this facility yet: plain until its node forms, then neutral until it resolves
  // (a facility another closed clinic already sends patients to stays receiving).
  const waiting = (f) => !!G.raf && G.nodes.some((n) => n.id === f.id && n.st !== 'ok' && n.st !== 'no') && !G.nodes.some((n) => n.id === f.id && n.st === 'ok');
  const statusOf = (f) => { const st = rawStatus(f); return (st === 'closed' && S.scene && S.scene.power !== 'off') || (st === 'receiving' && waiting(f)) ? 'normal' : st; };
  const isDead = () => (S.scene ? S.scene.power === 'off' : S.dead);
  // v5: the plan is on the map (the app's mapStage 4): routes, capacity, or homes that carry an action.
  const planned = () => !!((S.flows && S.flows.length) || Object.keys(S.cap).length || (S.patients || []).some((p) => p && p.action));
  const facPt = (f) => f && (D.center[f.id] || [f.lng, f.lat]); // pin the building when its footprint is known
  const facById = (id) => id != null && S.facilities.find((x) => x.id === id);
  // The facility at a coordinate: exact match first, else the first within ~200 m.
  const near = (x, c, d) => Math.abs(x.lng - c[0]) < d && Math.abs(x.lat - c[1]) < d;
  const facAt = (c) => Array.isArray(c) && (S.facilities.find((x) => x.lng === c[0] && x.lat === c[1]) || S.facilities.find((x) => near(x, c, 2e-3)));
  const snap = (c) => facPt(facAt(c)) || c;
  // A setFlows item's route key, the same key a traceRoutes item gets: closed clinic | destination | action.
  const flowKey = (f) => { const a = f.fromId != null ? f.fromId : (facAt(f.from) || {}).id, b = f.toId != null ? f.toId : (facAt(f.to) || {}).id; return `${a}|${b}|${f.action || ''}`; };

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

  // R8: what a selection keeps on the map: { routes: route keys, pats: patient ids, facs: facility ids }; null = everything.
  function isoSet() {
    const i = S.iso;
    if (!i) return null;
    const flows = (S.flows || []).filter(Boolean);
    if (i.type === 'patient') {
      const fl = flows.find((x) => x.id === i.id), p = (S.patients || []).find((x) => x.id === i.id);
      const to = (S.pr && S.pr.id === i.id && facAt(S.pr.to)) || (fl && (facById(fl.toId) || facAt(fl.to))) || (p && facAt(p.to));
      const from = (fl && (facById(fl.fromId) || facAt(fl.from))) || S.facilities.find((f) => f.home);
      return { routes: new Set(), pats: new Set([i.id]), facs: new Set([from, to].filter(Boolean).map((f) => f.id)) };
    }
    const on = (from, to) => to === i.toId && (i.fromId == null || from === i.fromId);
    return { routes: new Set(S.trace.filter((r) => on(r.item.fromId, r.item.toId)).map((r) => r.k)),
      pats: new Set(flows.filter((f) => { const [a, b] = flowKey(f).split('|'); return on(a, b) || on(f.fromId, f.toId); }).map((f) => f.id)),
      facs: new Set([i.fromId, i.toId]) };
  }

  // v5: with a plan, only a selection keeps its homes (keep); the others fade out (FX pats), then leave the source.
  function renderPatients() {
    const pr = S.pr && S.pr.id, I = isoSet(), plan = planned();
    setSrc('lm-pat', fc((S.patients || []).filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat) && (!I || I.pats.has(p.id))).flatMap((p) => {
      const sel = p.id === S.sel || p.id === pr, keep = !plan || sel || !!I; // R6: no rank tags; only the selected patient is named
      return keep || FX.v.pats > 0 ? [point([p.lng, p.lat], { id: p.id, action: p.action || '', sel, keep, txt: sel ? p.label || '' : '' })] : [];
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

  // The part of a route drawn so far (r.p of its length).
  function cut(r) {
    if (r.p >= 1) return r.line;
    const L = r.cum[r.cum.length - 1] * r.p, i = r.cum.findIndex((d) => d >= L);
    return [...r.line.slice(0, i < 0 ? r.line.length : Math.max(1, i)), along(r, r.p)];
  }

  // Route properties; setFlows marks a traced route "changed" (re-plan) through the same key.
  const changedKeys = () => new Set((S.flows || []).filter((f) => f && f.changed).map(flowKey));
  const routeProps = (r, ch) => ({ action: r.action, changed: ch.has(r.k), n: r.n, w: 3 + 1.4 * Math.sqrt(r.n), pending: !r.road, l: r.label, from: r.item.fromId, to: r.item.toId });

  // Every frame of a trace: the drawn part of each route and the moving heads.
  function drawLines() {
    const I = isoSet(), shown = S.trace.filter((r) => r.line && r.p > 0 && (!I || I.routes.has(r.k))), ch = changedKeys();
    setSrc('lm-flows', fc(shown.map((r) => ({ type: 'Feature', properties: routeProps(r, ch), geometry: { type: 'LineString', coordinates: cut(r) } }))));
    setSrc('lm-head', fc(shown.filter((r) => r.p < 1).map((r) => point(along(r, r.p), { action: r.action }))));
  }

  // Lines plus one badge per arrived route with a label. Badges keep their spot and hidden state, and are re-placed
  // against pins and labels in the same call, so a badge never sits under a pin, even for one frame.
  function renderFlows() {
    drawLines();
    const prev = new Map(counts.map((c) => [c.k, c])), ch = changedKeys(), I = isoSet();
    counts = S.trace.filter((r) => r.line && r.p >= 1 && r.label && (!I || I.routes.has(r.k))).map((r) => {
      const was = prev.get(r.k);
      return { k: r.k, line: r.line, cum: r.cum, props: routeProps(r, ch), t: was ? was.t : 0.5, o: was ? was.o : 0, hide: was ? was.hide : true };
    });
    if (map) placeLabels(true); else writeCounts();
  }

  function writeCounts() { setSrc('lm-flow-mid', fc(counts.filter((c) => !c.hide).map((c) => point(along(c, c.t), { ...c.props, o: c.o })))); }

  function stopTrace() {
    if (run.raf) cancelAnimationFrame(run.raf);
    const done = run.done;
    run.raf = 0; run.done = null;
    if (done) done(); // a replaced or cleared trace still resolves, so a caller awaiting it never hangs
  }

  // R4: draw each route along its road from the closed clinic, one after another (stagger ms apart, duration ms each,
  // easing out) with a moving head. A route already drawn stays drawn. onArrive(item) runs as each route arrives.
  function traceRoutes(list, o = {}) {
    stopTrace();
    const old = new Set(S.trace.filter((r) => r.p >= 1).map((r) => r.k));
    S.trace = (list || []).filter(Boolean).map((it) => {
      const k = `${it.fromId}|${it.toId}|${it.action || ''}`, road = isLine(it.line);
      const a = facPt(facById(it.fromId)), b = facPt(facById(it.toId)), line = road ? it.line : a && b ? [a, b] : null;
      const n = Number.isFinite(it.count) ? it.count : (S.flows || []).filter((f) => f && flowKey(f) === k).length || 1;
      // v5: no "+N" badge (the clinic label has the count); only a straight stand-in line says so on the line
      return { k, item: it, action: it.action || '', line, road, cum: line && measure(line), n,
        label: road ? '' : 'Road route not available', p: !line || old.has(k) ? 1 : 0 };
    });
    // R9: the search's straight edge to a node gives way to its road trace; on arrival the label shows its slots again.
    const gk = (r) => `${r.item.fromId}|${r.item.toId}`;
    const arrive = (r) => {
      r.p = 1;
      G.nodes.forEach((n) => { if (n.k === gk(r)) n.done = true; });
      try { if (o.onArrive) o.onArrive(r.item); } catch (e) { console.warn('LumenMap onArrive', e); }
    };
    const todo = S.trace.filter((r) => r.p < 1);
    S.trace.filter((r) => r.p >= 1).forEach(arrive);
    if (reduced()) todo.forEach(arrive);
    G.ring = 0;
    renderFlows();
    if (reduced() || !todo.length) { clearGraph(); return Promise.resolve(); }
    const stagger = Number.isFinite(o.stagger) ? o.stagger : 600, dur = Math.max(1, Number.isFinite(o.duration) ? o.duration : 1600), t0 = performance.now();
    todo.forEach((r, i) => { r.t0 = t0 + i * stagger; });
    return new Promise((resolve) => {
      run.done = resolve;
      const step = (now) => {
        let left = 0, landed = false;
        todo.forEach((r) => {
          if (r.p >= 1) return;
          if (now >= r.t0) G.gone.add(gk(r));
          const u = clamp((now - r.t0) / dur, 0, 1);
          if (u >= 1) { arrive(r); landed = true; } else { r.p = out(u); left++; }
        });
        if (G.nodes.length) drawGraph();
        if (landed) { renderFlows(); if (G.nodes.length) updateMarkers(); } else drawLines();
        if (left) run.raf = requestAnimationFrame(step);
        else { run.raf = 0; run.done = null; clearGraph(); resolve(); }
      };
      run.raf = requestAnimationFrame(step);
    });
  }

  // ---------- R9 search graph ----------

  // A facility's search status across closed clinics: the node forming now (its open slots less what earlier clinics
  // took), else "+N patients" summed over the clinics that send patients there, else the latest "Full" / "Not needed";
  // none once a road route has reached it (the hospital: once all have, so its phone calls never count back down).
  function graphNode(id) {
    const ns = G.nodes.filter((n) => n.id === id && n.st), last = ns[ns.length - 1], ok = ns.filter((n) => n.st === 'ok');
    if (!last || (last.hosp ? ok.length && ok.every((n) => n.done) : ns.some((n) => n.done))) return null;
    const used = ok.reduce((t, n) => t + n.used, 0);
    if (last.st === 'form') return ok.length && last.open != null ? { ...last, open: Math.max(0, last.open - used) } : last;
    return ok.length ? { ...ok[0], used } : last;
  }
  // The node's one status: forming "18 open slots", then "+16 patients" / "4 need a phone call", or a gray "Full" / "Not needed".
  function nodeText(n) {
    if (n.st === 'form') return n.hosp ? 'Hospital' : n.open > 0 ? plural(n.open, 'open slot') : 'No open slots';
    if (n.st === 'ok') return n.hosp ? calls(n.used) : `+${plural(n.used, 'patient')}`;
    return n.open === 0 || (n.open != null && n.used >= n.open) ? 'Full' : 'Not needed';
  }

  function drawGraph() {
    const live = G.nodes.filter((n) => !G.gone.has(n.k));
    setSrc('lm-graph', fc(live.filter((n) => n.e > 0).map((n) => ({ type: 'Feature', properties: { st: n.st || 'form', hosp: n.hosp },
      geometry: { type: 'LineString', coordinates: [n.a, [n.a[0] + (n.b[0] - n.a[0]) * n.e, n.a[1] + (n.b[1] - n.a[1]) * n.e]] } }))));
    setSrc('lm-node', fc(live.filter((n) => n.s > 0).map((n) => point(n.b, { st: n.st || 'form', hosp: n.hosp, s: n.s }))));
    const c = G.c, k = c && Math.cos((c[1] * Math.PI) / 180);
    setSrc('lm-ring', G.ring > 0 ? fc([{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [Array.from({ length: 65 }, (_, i) => {
      const a = (i / 64) * 2 * Math.PI;
      return [c[0] + (G.ring * Math.cos(a)) / k, c[1] + G.ring * Math.sin(a)];
    })] } }]) : EMPTY);
  }

  function clearGraph() {
    if (G.raf) cancelAnimationFrame(G.raf);
    const done = G.done, had = G.nodes.length;
    Object.assign(G, { raf: 0, done: null, nodes: [], ring: 0 });
    G.gone.clear();
    drawGraph();
    if (had) { renderFp(); updateMarkers(); }
    if (done) done(); // a cleared search still resolves, so a caller awaiting it never hangs
  }

  // R9: zoom out slowly to the closed clinic and its candidates (skipped when they are already in view), then visit each
  // node in the given order: an edge draws from the clinic, the node forms, then resolves. A second call for another
  // closed clinic keeps only the edges the first one uses (v6: three dark clinics would leave ~70 gray edges). Resolves
  // after the last node; reduced motion: the final state at once.
  function searchGraph(o) {
    if (!o || o.sourceId == null) { clearGraph(); return Promise.resolve(); }
    const settle = (n) => { n.e = n.s = 1; n.st = n.ok ? 'ok' : 'no'; };
    if (G.raf) cancelAnimationFrame(G.raf);
    G.raf = 0;
    G.nodes.forEach(settle);
    if (G.done) { const d = G.done; G.done = null; d(); }
    const a = facPt(facById(o.sourceId));
    if (!a) return Promise.resolve();
    const per = Math.max(1, Number.isFinite(o.perNode) ? o.perNode : 700), k = Math.cos((a[1] * Math.PI) / 180);
    const mine = (o.visits || []).filter((v) => v && facPt(facById(v.id))).map((v) => {
      const f = facById(v.id), b = facPt(f), used = Number.isFinite(v.used) ? v.used : 0;
      return { k: `${o.sourceId}|${f.id}`, src: o.sourceId, id: f.id, a, b, hosp: f.kind === 'hospital', open: Number.isFinite(v.open) ? v.open : null, used,
        ok: v.accepted != null ? !!v.accepted : used > 0, d: Math.hypot((b[0] - a[0]) * k, b[1] - a[1]), e: 0, s: 0, st: '' };
    });
    G.nodes = G.nodes.filter((n) => n.src !== o.sourceId && n.st === 'ok').concat(mine);
    mine.forEach((n) => G.gone.delete(n.k));
    G.c = a; G.ring = 0;
    const pts = [a, ...mine.map((n) => n.b)], el = map && map.getContainer(), P = S.pad;
    // In view and not much smaller than a fit (a phone that shows the whole county still zooms in to the search).
    const fitZ = el && (map.cameraForBounds(pts.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds()), { padding: Math.min(FIT_PAD, el.clientWidth / 5) }) || {}).zoom;
    const seen = el && !(fitZ > map.getZoom() + 0.75) && pts.every((c) => { const q = map.project(c); return q.x >= P.left + 24 && q.x <= el.clientWidth - P.right - 24 && q.y >= P.top + 24 && q.y <= el.clientHeight - P.bottom - 24; });
    const ringAt = () => Math.max(0, ...mine.map((n) => n.d * n.e)) * 1.06; // the frontier reaches each node as its edge does
    if (reduced()) {
      focus({ facilities: [o.sourceId, ...mine.map((n) => n.id)] });
      mine.forEach(settle); G.ring = ringAt(); drawGraph(); updateMarkers();
      return Promise.resolve();
    }
    const wait = seen ? 0 : 2250; // the slow zoom out before the search; the user asked for it 25% faster than 3 s
    if (!seen) focus({ facilities: [o.sourceId, ...mine.map((n) => n.id)] }, { duration: wait, easing: inOut });
    return new Promise((resolve) => {
      G.done = resolve;
      const t0 = performance.now() + wait;
      const step = (now) => {
        const t = now - t0;
        let changed = false;
        if (t >= 0) {
          mine.forEach((n, i) => {
            const u = (t - i * per) / per;
            if (u <= 0) return;
            n.e = out(clamp(u / 0.45, 0, 1)); n.s = out(clamp((u - 0.3) / 0.3, 0, 1));
            const st = u >= 0.7 ? (n.ok ? 'ok' : 'no') : u >= 0.3 ? 'form' : '';
            if (st !== n.st) { n.st = st; changed = true; }
          });
          G.ring = ringAt(); drawGraph();
          if (changed) { renderFp(); updateMarkers(); }
        }
        if (t < mine.length * per) G.raf = requestAnimationFrame(step);
        else { G.raf = 0; G.done = null; resolve(); }
      };
      G.raf = requestAnimationFrame(step);
      renderFp(); updateMarkers();
    });
  }

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
      [!road && (p.note || 'Road route not available'), 'lm-call-n'],
      [p.minutes > TOO_FAR && `Too far: over ${TOO_FAR} min by road`, 'lm-call-f']].filter(([t]) => t);
    if (!rows.length) { call.marker.remove(); call.w = 0; return; }
    call.el.replaceChildren(...rows.map(([t, c]) => { const s = document.createElement('span'); s.className = c; s.textContent = keep(t); return s; }));
    call.marker.setLngLat(p.to).addTo(map);
    call.w = call.el.offsetWidth; call.h = call.el.offsetHeight;
  }

  // The funnel. In a simulation (setScene) the routes stay faint until patients flow: while 0 < funnel < 1 dashes move from
  // the closed clinic outward, at 1 they are solid. (A selection hides the other routes instead of dimming them, R8.)
  function applyFlowPaint() {
    if (!ready) return;
    const sc = S.scene, f = sc ? sc.funnel : 1, run = !!sc && !reduced() && f > 0 && f < 1;
    const base = f >= 1 || (f > 0 && reduced()) ? 1 : 0.35;
    ['lm-flow-casing', 'lm-flow-line', 'lm-flow-staff', 'lm-flow-pending'].forEach((id) => map.setPaintProperty(id, 'line-opacity', base));
    map.setLayoutProperty('lm-flow-run', 'visibility', run ? 'visible' : 'none');
    if (run) map.setPaintProperty('lm-flow-run', 'line-dasharray', DASH[Math.floor(f * FUNNEL_STEPS) % DASH.length]);
  }

  // Grid lines follow setPower only (v5): in the run the timeline darkens the area first, then the lines die with the clinic.
  const gridDead = (k) => ['all', S.dead, ['==', ['get', k], true]];

  function applyPower() {
    if (!ready) return;
    const off = isDead(), dead = gridDead, live = (k) => ['!', dead(k)];
    // Power off: the shutoff area goes dark under the grid, buildings and labels.
    map.setPaintProperty('lm-outage-mask', 'fill-opacity-transition', { duration: reduced() ? 0 : 600, delay: 0 });
    map.setPaintProperty('lm-outage-mask', 'fill-opacity', off ? (S.theme === 'dark' ? 0.5 : 0.22) : 0);
    map.setFilter('lm-trans-line', live('in_outage')); map.setFilter('lm-trans-dead', dead('in_outage')); map.setFilter('lm-trans-dead-casing', dead('in_outage'));
    map.setFilter('lm-feeder-live', live('deenergized')); map.setFilter('lm-feeder-flow', live('deenergized'));
    map.setFilter('lm-feeder-dead', dead('deenergized'));
    map.setLayoutProperty('lm-subs', 'icon-image', ['case', dead('in_outage'), 'lm-sub-dead', 'lm-sub-live']);
    map.setPaintProperty('lm-subs', 'text-color', ['case', dead('in_outage'), T.deadInk, T.trans]);
    map.setLayoutProperty('lm-feeder-label', 'text-field', ['case', dead('deenergized'), 'No power: feeder (illustrative)', 'Feeder (illustrative)']);
    map.setPaintProperty('lm-feeder-label', 'text-color', ['case', dead('deenergized'), T.deadInk, T.powerInk]);
    // Real OSM lines drawn dead are a simulation: say so on the line.
    map.setLayoutProperty('lm-trans-label', 'text-field', ['case', dead('in_outage'), ['concat', ['get', 'kv'], ' · no power (simulated)'], ['get', 'kv']]);
    map.setPaintProperty('lm-trans-label', 'text-color', ['case', dead('in_outage'), T.deadInk, T.trans]);
    applyFx();
  }

  // ---------- v5 fades: the grid, the homes, the county outline ----------

  function applyFx() {
    if (!ready) return;
    const g = FX.v.grid, dot = ['case', is('sel'), 1, is('keep'), 0.85, 0.85 * FX.v.pats];
    GRID.forEach(([id, p, v]) => { map.setLayoutProperty(id, 'visibility', g > 0 ? 'visible' : 'none'); map.setPaintProperty(id, p, v * g); });
    map.setPaintProperty('lm-subs', 'icon-opacity', ['*', g, ['case', gridDead('in_outage'), 0.7, 1]]);
    map.setPaintProperty('lm-county-line', 'line-opacity', (S.theme === 'dark' ? 0.32 : 0.45) * FX.v.county);
    map.setPaintProperty('lm-pat', 'circle-opacity', dot); map.setPaintProperty('lm-pat', 'circle-stroke-opacity', dot);
    syncAnim();
  }

  // Targets from the state: the grid only in the "loses power" scene; homes and county outline gone once the plan shows.
  function syncFx() {
    const plan = planned();
    FX.to = { grid: S.grid ? 1 : 0, pats: plan ? 0 : 1, county: plan ? 0 : 1 };
    if (!plan && FX.v.pats < 1) { FX.v.pats = 1; applyFx(); renderPatients(); } // the homes come back at once when the plan clears
    if (reduced() || !ready) {
      if (FX.raf) cancelAnimationFrame(FX.raf);
      FX.raf = 0; Object.assign(FX.v, FX.to); applyFx(); renderPatients();
    } else if (!FX.raf && Object.keys(FX.to).some((k) => FX.v[k] !== FX.to[k])) { FX.t = performance.now(); FX.raf = requestAnimationFrame(stepFx); }
  }

  function stepFx(now) {
    const d = (now - FX.t) / FADE_MS, was = FX.v.pats;
    FX.t = now;
    Object.keys(FX.to).forEach((k) => { const a = FX.v[k], b = FX.to[k]; FX.v[k] = a < b ? Math.min(b, a + d) : Math.max(b, a - d); });
    applyFx();
    if (was > 0 && !FX.v.pats) renderPatients(); // faded out: off the source, so a hidden home cannot be clicked
    FX.raf = Object.keys(FX.to).some((k) => FX.v[k] !== FX.to[k]) ? requestAnimationFrame(stepFx) : 0;
  }

  // The "loses power" scene: on after wait ms (flyHome3D, so the grid arrives with the camera), off at once.
  function gridScene(on, wait = 0) {
    clearTimeout(S.gridT);
    if (on && wait) { S.gridT = setTimeout(() => gridScene(true), wait); return; }
    if (S.grid !== on) { S.grid = on; syncFx(); }
  }

  // ---------- feeder current animation ----------

  function tick(t) {
    raf = requestAnimationFrame(tick);
    const s = Math.floor(t / DASH_MS) % DASH.length;
    if (s !== dashStep && ready && map.getLayer('lm-feeder-flow')) { dashStep = s; map.setPaintProperty('lm-feeder-flow', 'line-dasharray', DASH[s]); }
  }

  // Runs only while wanted: grid shown, not paused, motion allowed, tab visible, zoomed in enough to see feeders, a live feeder exists.
  function syncAnim() {
    const want = ready && FX.v.grid > 0 && S.anim && !reduced() && !document.hidden && map.getZoom() >= ANIM_MIN_ZOOM
      && D.feeders.features.some((f) => !(S.dead && f.properties.deenergized));
    if (want && !raf) raf = requestAnimationFrame(tick);
    else if (!want && raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  // ---------- facility markers (DOM) ----------

  function injectCss() {
    if (document.getElementById('lm-css')) return;
    const css = document.createElement('style');
    css.id = 'lm-css';
    css.textContent = `
.lm-fac{--pin:26px;--stem:10px;appearance:none;background:none;border:0;margin:0;padding:0 0 calc(var(--stem) + var(--lift,0px));display:block;width:var(--pin);cursor:pointer;font-family:var(--f-ui);text-align:left;color:var(--map-ink);-webkit-tap-highlight-color:transparent}
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
.lm-stem{position:absolute;left:calc(var(--pin) / 2 - .75px);top:var(--pin);width:1.5px;height:calc(var(--stem) + var(--lift,0px));background:var(--map-ink);opacity:.75;transition:height .3s cubic-bezier(.16,1,.3,1)}
.lm-stem::after{content:"";position:absolute;left:-2.25px;bottom:-3px;width:6px;height:6px;border-radius:50%;background:var(--map-ink);box-shadow:0 0 0 1.5px var(--map-halo)}
.lm-txt{position:absolute;left:calc(var(--pin) + 4px);top:calc(var(--pin) / 2);transform:translateY(calc(-50% + var(--dy,0px)));display:flex;flex-direction:column;padding:1px 4px 2px;border-radius:4px;background:var(--map-halo);white-space:nowrap;line-height:1.15}
.lm-fac.lbl-left .lm-txt{left:auto;right:calc(100% + 4px);align-items:flex-end;text-align:right}
.lm-fac.lbl-up .lm-txt,.lm-fac.lbl-down .lm-txt{left:50%;align-items:center;text-align:center}
.lm-fac.lbl-up .lm-txt{top:auto;bottom:calc(100% + 2px);transform:translateX(-50%)}
.lm-fac.lbl-down .lm-txt{top:calc(100% + 5px);transform:translateX(-50%)}
.lm-name{font-size:13px;font-weight:600;letter-spacing:.005em}
.lm-sub{font-size:11.5px;font-weight:500;color:var(--ink-2);margin-top:1px;font-variant-numeric:tabular-nums}
.lm-fac[data-st=closed] .lm-sub{color:var(--red-ink)}
.lm-fac[data-st=receiving] .lm-sub{color:var(--green-ink)}
.lm-fac.no-sub .lm-sub{display:none}
.lm-cnt{font-weight:500;color:var(--green-ink);font-variant-numeric:tabular-nums}
.lm-fac.is-narrow .lm-cnt{display:block;margin-top:1px;font-size:11.5px}
.lm-fac.is-narrow .lm-sep{display:none}
.lm-fac.is-full .lm-sub{align-self:flex-start;margin-top:2px;padding:0 6px;border:1px solid var(--map-ink);border-radius:999px;color:var(--map-ink);font-weight:600}
.lm-fac.lbl-left.is-full .lm-sub{align-self:flex-end}
.lm-fac.lbl-up.is-full .lm-sub,.lm-fac.lbl-down.is-full .lm-sub,.lm-fac.lbl-up .lm-early,.lm-fac.lbl-down .lm-early{align-self:center}
.lm-early{display:none;align-self:flex-start;margin:2px 0 1px;padding:0 5px;border-radius:4px;background:var(--green-bg);color:var(--green-ink);font-size:11.5px;font-weight:600}
.lm-fac.lbl-left .lm-early{align-self:flex-end}
.lm-fac.has-early .lm-early{display:block}
.lm-fac.no-early:not(:hover):not(:focus-visible) .lm-early{display:none}
.lm-fac{transition:opacity .4s cubic-bezier(.16,1,.3,1),visibility 0s,padding-bottom .3s cubic-bezier(.16,1,.3,1)}
/* !important: MapLibre writes each marker's opacity inline */
.lm-fac.lm-dim{opacity:.35!important}
.lm-fac.lm-off{opacity:0!important;visibility:hidden;pointer-events:none;transition:opacity .4s ease-out,visibility 0s .4s}
.lm-call{pointer-events:none;box-sizing:border-box;max-width:260px;display:flex;flex-direction:column;gap:2px;padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font-family:var(--f-ui);font-size:12.5px;line-height:1.3;box-shadow:var(--shadow)}
.lm-call-t{font-weight:600}
.lm-call-n{color:var(--mute)}
.lm-call-f{color:var(--red-ink);font-weight:600}
.lm-area{display:inline-block;pointer-events:none;white-space:nowrap;font-family:var(--f-ui);font-size:13px;font-weight:700;letter-spacing:.02em;color:var(--map-outage);background:var(--map-halo);padding:0 4px;border-radius:4px;opacity:0;transition:opacity .4s ease-out}
.lm-area.on{opacity:1}
.lm-fac.no-label .lm-txt{visibility:hidden}
.lm-fac.sg-ok .lm-sub{color:var(--green-ink);font-weight:600}
.lm-fac.sg-no .lm-sub{color:var(--mute)}
.lm-ok{vertical-align:-1px;margin-right:3px}
.lm-iso{position:absolute;z-index:3;top:calc(12px + var(--lm-top,0px));left:calc(50% + var(--lm-dx,0px));transform:translateX(-50%);display:flex;align-items:center;gap:10px;max-width:calc(100% - 32px);box-sizing:border-box;padding:5px 5px 5px 14px;border:1px solid var(--line);border-radius:999px;background:var(--paper);color:var(--ink);font:500 13px/18px var(--f-ui);box-shadow:var(--shadow);white-space:nowrap}
.lm-iso[hidden]{display:none}
.lm-iso span{overflow:hidden;text-overflow:ellipsis}
.lm-iso button{appearance:none;flex:none;margin:0;padding:4px 12px;border:1px solid var(--line-2);border-radius:999px;background:var(--paper-2);color:var(--ink);font:600 13px/18px var(--f-ui);cursor:pointer}
.lm-iso button:hover{background:var(--paper-3)}
.lm-iso button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
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
@media (pointer:coarse){.lm-fac::before{content:"";position:absolute;left:calc(var(--pin) / 2 - 22px);top:calc(var(--pin) / 2 - 22px);width:44px;height:44px}.lm-iso button{min-height:44px}}
@media (prefers-reduced-motion:reduce){.lm-fac,.lm-fac.lm-off,.lm-pin,.lm-stem,.lm-area{transition:none}.lm-fac:hover .lm-pin{transform:none}}`;
    document.head.appendChild(css);
  }

  // Same rule as the panel's short name (app.js), so the visible pin text is part of its accessible name.
  const shortName = (n) => String(n || '').replace(/\s+Dialysis(\s+(Center|Clinic))?$/i, '');

  // One status per label (R6). setCapacity wins: its text, else a receiving clinic says "16 of 18 slots" (used of open,
  // counting up while routes land) or "Full" (v6); with no slot count it says "· 16 patients" beside its name (n). st is
  // the real status (not the simulated look), so a closed clinic always says what happens to its power. plan: the status
  // comes from the plan, so the label places before plain clinics; w (patients) orders plan labels, biggest first. While
  // the search (R9) visits a facility, its node status wins.
  function status(f, st, n) {
    const g = graphNode(f.id);
    if (g) return { s: nodeText(g), plan: true, sg: g.st, w: g.used };
    if (waiting(f)) return { s: f.kind === 'hospital' ? 'Hospital' : 'Dialysis' };
    const c = S.cap[f.id], used = c && Number.isFinite(c.used) ? c.used : n, w = (c && c.n) || used;
    if (c && c.text) return { s: c.text, plan: true, w };
    if (f.kind === 'hospital') return used ? { s: calls(used), plan: true, w } : { s: 'Hospital' };
    if (st === 'receiving' || used > 0) {
      const open = c && Number.isFinite(c.open) ? c.open : null, full = !!c && (c.full != null ? !!c.full : open != null && used >= open);
      const slots = open != null ? `${used} of ${plural(open, 'slot')}` : ''; // a: what "Full" means, for screen readers
      return { s: full ? 'Full' : slots, n: full || slots ? '' : plural(used, 'patient'), a: full ? slots : '', full, plan: true, w };
    }
    if (st === 'closed') return { s: S.scene && S.scene.power === 'restored' ? 'Power back' : isDead() ? 'No power' : 'Loses power' };
    return { s: f.home ? 'Home clinic' : 'Dialysis' };
  }

  // v5: once the plan shows and the search is over, a facility with no part in the plan hides (the hospital too, unused).
  const idle = (f, raw) => planned() && !G.nodes.length && !f.home && raw !== 'closed' && raw !== 'receiving' && !S.recv[f.id] && !S.early[f.id]
    && !(S.cap[f.id] && (S.cap[f.id].used > 0 || S.cap[f.id].text || S.cap[f.id].early));

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
    const zm = map.getZoom(), short = zm < 12, noSub = zm < 11, tall = zm >= 14.5, small = zm < 10.5, I = isoSet();
    const narrow = map.getContainer().clientWidth < 560; // phone: short names, "16 patients" under the name, so labels fit
    markers.forEach((m) => {
      const f = m.f, raw = rawStatus(f), st = statusOf(f), name = short || narrow ? shortName(f.name) : f.name, x = status(f, raw, S.recv[f.id] || 0), sub = x.s;
      const c = S.cap[f.id], early = S.early[f.id] ? (c && c.early) || `${S.early[f.id]} come in early` : '', dim = !!I && !I.facs.has(f.id);
      // A pin that hides (v5) keeps its last words while it fades out; it is drawn afresh when it comes back.
      if (idle(f, raw)) { if (!m.off) { m.off = true; m.key = ''; m.el.classList.add('lm-off'); } return; }
      m.off = false;
      // Status text stays at every zoom, so closed, receiving and capacity never rely on pin color alone.
      const ns = !sub || (noSub && !f.home && !x.plan && (raw === 'normal' || sub === 'Hospital'));
      const key = `${st}|${name}|${x.n}|${sub}|${x.sg}|${early}|${dim}|${ns}|${tall}|${small}|${narrow}`;
      if (key === m.key) return;
      m.key = key;
      m.el.classList.remove('lm-off');
      m.el.dataset.st = st;
      m.el.classList.toggle('is-home', !!f.home);
      m.el.classList.toggle('is-hosp', f.kind === 'hospital');
      m.el.classList.toggle('no-sub', ns);
      m.el.classList.toggle('is-tall', tall);
      m.el.classList.toggle('is-small', small);
      m.el.classList.toggle('is-narrow', narrow);
      m.el.classList.toggle('has-early', !!early);
      m.el.classList.toggle('is-full', !!x.full);
      m.el.classList.toggle('sg-ok', x.sg === 'ok');
      m.el.classList.toggle('sg-no', x.sg === 'no');
      m.el.classList.toggle('lm-dim', dim);
      m.stem = tall ? 30 : small ? 7 : 10;
      m.pin = small ? (f.home ? 26 : 24) : (f.home ? 30 : 26);
      m.marker.setOffset([-m.pin / 2, 0]); // keeps the stem foot on the point
      m.name.textContent = name;
      if (x.n) { const s = document.createElement('span'); s.className = 'lm-cnt'; s.innerHTML = '<span class="lm-sep"> · </span>'; s.append(x.n); m.name.append(s); }
      m.sub.innerHTML = x.sg === 'ok' ? OK : '';
      m.sub.append(keep(sub));
      m.early.textContent = early;
      m.el.setAttribute('aria-label', [f.name + (x.n ? `, ${x.n}` : ''), x.a, sub, early].filter(Boolean).join('. '));
      // Dark clinics stay on top of a cluster; a raised pin is 1 lower. At most 2: the console's legend, map buttons, timeline,
      // notice card and banner (z-index 2 to 5, after the map) stay over the pins; hover and focus (9) still rise above them.
      m.z = f.home || raw === 'closed' ? 2 : st === 'normal' ? 0 : 1;
      m.rank = f.home ? 0 : raw === 'closed' ? 1 : x.plan || st === 'receiving' ? 2 : 3; // 3: plain clinic or hospital
      m.w = x.w || 0;
      // Full label size, and (with an early line) the compact size a crowded label falls back to before it hides.
      const ne = m.el.classList.contains('no-early');
      m.el.classList.remove('no-early');
      m.lw = m.txt.offsetWidth; m.lh = m.txt.offsetHeight;
      m.el.classList.add('no-early');
      [m.lw2, m.lh2] = early ? [m.txt.offsetWidth, m.txt.offsetHeight] : [0, 0];
      m.el.classList.toggle('no-early', ne && !!early);
    });
    placeLabels();
  }

  // Pins first: a pin whose head would sit on one placed before it rises on a longer stem (a leader line; its foot stays on
  // the clinic), so clustered clinics stay apart; zoomed out to the county, only pins with a plan status rise (no forest of
  // stems). Then each facility label goes beside its pin, on its current side, else the other side, above or below the
  // pin, else slid up or down along it, else without its early line, else it hides; never over another pin or an earlier
  // label (pins always stay). Order: home (never hidden), closed clinics, the area label, labels with a plan status (most
  // patients first), route badges, then plain clinics.
  function placeLabels(force) {
    const box0 = map.getContainer(), W = box0.clientWidth, H = box0.clientHeight;
    const faded = (m) => m.el.classList.contains('lm-dim');
    const order = (m) => m.rank * 1e4 - (m.rank === 2 ? m.w || 0 : 0);
    const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
    const ov = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const items = markers.map((m) => {
      const p = map.project(m.marker.getLngLat()), tab = !m.off && p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H ? 0 : -1;
      if (m.el.tabIndex !== tab) m.el.tabIndex = tab; // no focus stops on hidden pins or pins outside the map
      return { m, p };
    }).filter((i) => !i.m.off).sort((a, b) => order(a.m) - order(b.m)); // a hidden pin (v5) takes no room
    const heads = [], few = map.getZoom() >= 11, head = (i, l) => [i.p.x - i.m.pin / 2 - 1, i.p.y - i.m.stem - l - i.m.pin - 1, i.p.x + i.m.pin / 2 + 1, i.p.y - i.m.stem - l + 1];
    items.forEach((i) => {
      const cost = (l) => heads.reduce((t, b) => t + ov(head(i, l), b), 0); // no free height: the least covered one
      const rise = few || i.m.rank <= 2, lift = !rise || i.p.x < -40 || i.p.x > W + 40 ? 0 : LIFTS.find((l) => !cost(l)) ?? LIFTS.reduce((a, l) => (cost(l) < cost(a) ? l : a));
      if (rise) heads.push(head(i, lift));
      if (lift !== (i.m.lift || 0)) { i.m.lift = lift; i.m.el.style.setProperty('--lift', `${lift}px`); }
      const z = String(Math.max(0, i.m.z - !!lift)); // a raised pin's stem passes behind the pin it clears
      if (i.m.el.style.zIndex !== z) i.m.el.style.zIndex = z;
      const st = i.m.stem + lift;
      i.pin = [i.p.x - i.m.pin / 2 - 2, i.p.y - st - i.m.pin - 2, i.p.x + i.m.pin / 2 + 2, i.p.y + 3];
    });
    // While a selection is shown (R8), faded pins do not push labels away and show no label; the chip and the map's own
    // controls (zoom, scale, attribution) are kept clear.
    const placed = items.filter((i) => !faded(i.m)).map((i) => i.pin), r0 = box0.getBoundingClientRect();
    box0.querySelectorAll('.maplibregl-ctrl').forEach((el) => { const r = el.getBoundingClientRect(); if (r.width) placed.push([r.left - r0.left, r.top - r0.top, r.right - r0.left, r.bottom - r0.top]); });
    if (S.iso && chip.w) { const x = W / 2 + chip.dx, y = 12 + S.pad.top; placed.push([x - chip.w / 2 - 4, y - 4, x + chip.w / 2 + 4, y + chip.h + 4]); }
    if (S.pr && call.w) { // route callout under the destination pin (above it near the bottom edge), kept inside the map
      const q = map.project(S.pr.to), w = call.w, h = call.h, below = q.y + 12, above = q.y - 46 - h;
      const y = below + h <= H - 8 || above < 8 ? below : above, x = clamp(q.x - w / 2, 8, Math.max(8, W - w - 8));
      call.marker.setOffset([x - q.x, y - q.y]);
      placed.push([x, y, x + w, y + h]);
    }
    const placeArea = () => { // area label: where it is now, else center, else the first nearby spot no pin or label covers
      if (!area.box) return;
      const c = map.project(area.marker.getLngLat()), [w, h] = area.box, dx = w / 2 + 12, dy = h + 6, cur = area.marker.getOffset();
      const at = ([x, y]) => [c.x + x - w / 2, c.y + y - h / 2, c.x + x + w / 2, c.y + y + h / 2];
      const fits = (o) => { const b = at(o); return b[0] >= 0 && b[1] >= 0 && b[2] <= W && b[3] <= H && !placed.some((p) => hit(b, p)); };
      // Nothing free: centered, but pulled inside the map edges while the area's center is on screen.
      const off = [[cur.x, cur.y], [0, 0], [dx, 0], [0, dy], [0, -dy], [-dx, 0], [dx, dy], [dx, -dy]].find(fits)
        || (c.x >= 0 && c.x <= W && c.y >= 0 && c.y <= H ? [clamp(0, w / 2 - c.x, W - w / 2 - c.x), clamp(0, h / 2 - c.y, H - h / 2 - c.y)] : [0, 0]);
      if (cur.x !== off[0] || cur.y !== off[1]) area.marker.setOffset(off);
      // Over a pin, a label or past the map edge: hide it; the red area and the dark clinics' "No power" still say what it is.
      const b = at(off), show = fits(off);
      area.text.style.visibility = show ? '' : 'hidden';
      if (show) placed.push(b);
    };
    // Route badges slide along their route, else sit just above or below it, off pins, labels and each other. The symbol
    // layer cannot see DOM pins, so a badge with no free spot is hidden (the clinic label and the panel carry its numbers).
    const placeBadges = () => {
      let moved = !!force;
      [...counts].sort((a, b) => b.props.changed - a.props.changed || b.props.n - a.props.n).forEach((c) => {
        const w = c.props.l.length * 7 + 10, box = (t, o) => { const q = map.project(along(c, t)), y = q.y + o * 22; return [q.x - w / 2, y - 11, q.x + w / 2, y + 11]; }; // o * 22 px = text-offset 1.8 em
        const ok = (b) => b[0] >= 0 && b[1] >= 0 && b[2] <= W && b[3] <= H && !placed.some((p) => hit(b, p)); // inside the map, off pins and labels
        const s = [[c.t, c.o], ...[0, -1, 1].flatMap((o) => [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78].map((t) => [t, o]))].find((x) => ok(box(...x))), hide = !s;
        if (!hide) placed.push(box(...s));
        if (hide !== !!c.hide || (!hide && (s[0] !== c.t || s[1] !== c.o))) { c.hide = hide; if (!hide) [c.t, c.o] = s; moved = true; }
      });
      if (moved) writeCounts();
    };
    let areaDone = false, badgesDone = false;
    items.sort((a, b) => faded(a.m) - faded(b.m)).forEach(({ m, p, pin }) => { // stable: the order above, faded labels last
      if ((m.rank > 1 || faded(m)) && !areaDone) { areaDone = true; placeArea(); }
      if ((m.rank > 2 || faded(m)) && !badgesDone) { badgesDone = true; placeBadges(); }
      const st = m.stem + (m.lift || 0), cy = p.y - st - m.pin / 2; // a beside label is centered on the pin
      const inside = (box) => box[0] >= 0 && box[2] <= W && box[1] >= 0 && box[3] <= H; // a label above or below its pin can leave the map
      const free = (box) => inside(box) && !placed.some((b) => b !== pin && hit(box, b));
      const side = m.side || 'r', hz = side === 'l' ? ['l', 'r'] : ['r', 'l'];
      // Spots for the full label (k 0) or the compact one without its early line (k 1).
      const geo = (k) => {
        const lw = k ? m.lw2 : m.lw, lh = k ? m.lh2 : m.lh, h = Math.max(lh, m.pin), top = cy - h / 2, bottom = cy + h / 2 + 1, a = (h + m.pin) / 2 - 6; // slid by a, the label still overlaps the pin by 6 px
        const at = (s, dy) => (s === 'l' ? [p.x - m.pin / 2 - 6 - lw, top - 1 + dy, p.x - m.pin / 2 - 2, bottom + dy]
          : s === 'u' ? [p.x - lw / 2 - 2, p.y - st - m.pin - 4 - lh, p.x + lw / 2 + 2, p.y - st - m.pin]
            : s === 'd' ? [p.x - lw / 2 - 2, p.y + 3, p.x + lw / 2 + 2, p.y + 7 + lh]
              : [p.x + m.pin / 2 + 2, top - 1 + dy, p.x + m.pin / 2 + 6 + lw, bottom + dy]);
        return { at, spots: [[side, m.dy || 0], ...hz.map((x) => [x, 0]), ['u', 0], ['d', 0], ...[-a / 2, a / 2, -a, a].flatMap((dy) => hz.map((x) => [x, dy]))] };
      };
      let spot = null, box = null, k = 0;
      for (; !faded(m) && !spot && k < (m.lh2 ? 2 : 1); k++) { const g = geo(k); spot = g.spots.find((x) => free(g.at(...x))); if (spot) box = g.at(...spot); }
      k = spot ? k - 1 : m.lh2 ? 1 : 0;
      if (!spot && !faded(m) && m.f.home) { // the home label never hides: compact, on the spot covering the least of other pins
        const g = geo(k), cover = (b) => placed.reduce((t, q) => t + (q === pin ? 0 : ov(b, q)), 0);
        spot = g.spots.filter((x) => inside(g.at(...x))).reduce((a, x) => (a && cover(g.at(...a)) <= cover(g.at(...x)) ? a : x), null) || [g.at('r', 0)[2] > W ? 'l' : 'r', 0];
        box = g.at(...spot);
      }
      if (spot) placed.push(box);
      m.el.classList.toggle('no-label', !spot);
      m.el.classList.toggle('no-early', !!spot && k === 1);
      if (spot && spot[0] !== m.side) { m.side = spot[0]; ['l', 'u', 'd'].forEach((x) => m.el.classList.toggle(`lbl-${{ l: 'left', u: 'up', d: 'down' }[x]}`, m.side === x)); }
      const dy = spot ? spot[1] : 0;
      if (dy !== (m.dy || 0)) { m.dy = dy; m.el.style.setProperty('--dy', `${dy}px`); }
    });
    if (!areaDone) placeArea();
    if (!badgesDone) placeBadges();
  }

  function onMove() {
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => { moveRaf = 0; updateMarkers(); syncAnim(); });
  }

  // ---------- R8 one path only ----------

  function isoText() {
    const i = S.iso;
    if (!i) return '';
    if (i.type === 'patient') {
      const p = (S.patients || []).find((x) => x.id === i.id), name = (p && p.label) || (S.pr && S.pr.id === i.id && S.pr.name) || 'this patient';
      return `Showing ${name}’s route`;
    }
    const f = facById(i.toId), rs = S.trace.filter((r) => isoSet().routes.has(r.k)), n = rs.reduce((t, r) => t + r.n, 0) || isoSet().pats.size;
    return `Showing ${f ? shortName(f.name) : 'this route'}${n ? ` · ${f && f.kind === 'hospital' ? calls(n) : plural(n, 'patient')}` : ''}`;
  }

  function renderChip() {
    if (!map) return;
    if (!chip.el) {
      chip.el = document.createElement('div');
      chip.el.className = 'lm-iso';
      chip.el.innerHTML = '<span></span><button type="button">Show all routes</button>';
      chip.txt = chip.el.firstChild;
      chip.el.lastChild.addEventListener('click', showAll);
      map.getContainer().appendChild(chip.el);
    }
    const t = isoText(), W = map.getContainer().clientWidth;
    chip.el.hidden = !t;
    chip.txt.textContent = t;
    chip.el.style.setProperty('--lm-top', `${S.pad.top}px`);
    chip.w = t ? chip.el.offsetWidth : 0; chip.h = chip.el.offsetHeight;
    // Centered in the padded view, but never past the map's 16 px edge (a phone's map controls pad the right side).
    const room = Math.max(0, (W - chip.w) / 2 - 16);
    chip.dx = clamp((S.pad.left - S.pad.right) / 2, -room, room);
    chip.el.style.setProperty('--lm-dx', `${chip.dx}px`);
  }

  // The chip and Esc: back to every route; onSelect(null) tells the app the selection ended.
  function showAll() {
    if (!S.iso) return;
    const had = chip.el && chip.el.contains(document.activeElement);
    isolate(null);
    if (had && map) map.getCanvas().focus();
    if (S.trace.length) focus('flows', { all: true });
    if (opts.onSelect) opts.onSelect(null);
  }

  // {type:'patient', id} | {type:'route', fromId, toId} | null. Hides every other route, badge and patient dot (no dimming).
  function isolate(sel) {
    const t = sel && sel.type;
    S.iso = t === 'patient' && sel.id != null ? { type: t, id: sel.id } : t === 'route' && sel.toId != null ? { type: t, fromId: sel.fromId != null ? sel.fromId : null, toId: sel.toId } : null;
    if (S.pr && !(S.iso && S.iso.type === 'patient' && S.iso.id === S.pr.id)) S.pr = null; // a patient route belongs to its selection
    renderIso();
    if (S.iso) focus(S.iso.type === 'patient' ? { patient: S.iso.id } : { fromId: S.iso.fromId, toId: S.iso.toId });
  }

  function renderIso() { renderPatients(); renderPr(); renderChip(); renderFlows(); updateMarkers(); }

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
    // A patient dot wins over a route line or badge under it; a route reports {type:'route', fromId, toId} (R8).
    const hits = (pt) => (ready ? map.queryRenderedFeatures(pt, { layers: ['lm-pat', 'lm-flow-count', 'lm-flow-hit'].filter((id) => map.getLayer(id)) }) : []);
    map.on('click', (e) => {
      const h = hits(e.point), f = h.find((x) => x.layer.id === 'lm-pat') || h[0];
      if (!f || !opts.onSelect) return;
      opts.onSelect(f.layer.id === 'lm-pat' ? { type: 'patient', id: f.properties.id } : { type: 'route', fromId: f.properties.from, toId: f.properties.to });
    });
    map.on('mousemove', (e) => { map.getCanvas().style.cursor = hits(e.point).length ? 'pointer' : ''; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.iso && !e.defaultPrevented && !document.querySelector('dialog[open]')) showAll(); });
    map.on('move', onMove);
    map.on('resize', () => { if (S.iso) renderChip(); onMove(); }); // the chip's room changes with the map's width
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
    S.pr = null; S.iso = null; renderPr(); renderChip(); // a patient route never outlives its county, nor do routes, capacity and the search
    stopTrace(); S.trace = []; S.cap = {}; clearGraph();
    D.fp = ((r.footprints || EMPTY).features || []).map((f) => ({ id: f.properties.facility_id, levels: f.properties.levels,
      gen: f.properties.source === 'generated', geometry: grow(f.geometry) }));
    D.center = Object.fromEntries(D.fp.filter((f) => f.geometry && f.geometry.type === 'Polygon').map((f) => {
      const r0 = f.geometry.coordinates[0];
      return [f.id, [r0.reduce((a, c) => a + c[0], 0) / r0.length, r0.reduce((a, c) => a + c[1], 0) / r0.length]];
    }));
    computeRecv();
    buildMarkers();
    if (ready) { setSrc('lm-trans', D.trans); setSrc('lm-subs', D.subs); setSrc('lm-feeders', D.feeders); setSrc('lm-county', D.county); renderFp(); renderFlows(); }
    gridScene(false); syncFx();
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
      if (o.easing) map.easeTo({ ...cam, duration, easing: o.easing, essential: true }); else map.flyTo({ ...cam, duration, essential: true });
      flying = [target, o]; // after flyTo: the flight it interrupts ends (moveend) inside that call
    };
    const fit = (pts, kind, maxZoom = 14.5, pad) => { const [pitch, bearing] = view(kind); go(camFor(pts, pitch, bearing, maxZoom, pad)); };
    const at = (center, zoom, kind) => { const [pitch, bearing] = view(kind); go({ center, zoom, pitch, bearing }); };
    const home = S.facilities.find((f) => f.home);
    const bbox = S.region && S.region.bbox;
    const region = () => bbox && fit([[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]], 'over');
    // The whole affected area: shutoff polygon, home clinic and every affected patient's home (v5: homes only while shown).
    const whole = () => [...coordsOf(S.outage), facPt(home), ...(planned() ? [] : S.patients || []).filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat)).map((p) => [p.lng, p.lat])];
    if (target === 'home') { // the home building in the middle, with its feeder and the substation that feeds it in view
      if (!home) return region();
      const h = facPt(home), fd = coordsOf(D.feeders.features.find((f) => f.properties.facility_id === home.id));
      // Zoom that fits the feeder mirrored around home, then home exactly in the middle (the tilt squeezes the far side).
      const [pitch, bearing] = view('home'), cam = camFor([h, ...fd, ...fd.map(([x, y]) => [2 * h[0] - x, 2 * h[1] - y])], pitch, bearing, 15.2);
      return go(cam && { ...cam, center: h });
    }
    if (target === 'region') return region();
    if (target === 'outage') return S.outage ? fit(whole(), 'over') : region();
    if (target === 'flows') { // after a re-plan: the changed routes and home (D7); else, or with { all: true }, the whole plan and area
      const fl = (S.flows || []).filter((f) => f && f.from && f.to), ch = o.all ? [] : fl.filter((f) => f.changed), chk = new Set(ch.map(flowKey));
      const pts = (ch.length ? ch : fl).flatMap((f) => [snap(f.from), snap(f.to)]);
      const roads = S.trace.filter((r) => r.line && (!ch.length || chk.has(r.k))).flatMap((r) => r.line); // roads can bulge past their ends
      return pts.length || roads.length ? fit([...pts, ...roads, ...(ch.length ? [facPt(home)] : whole())], 'over') : region();
    }
    if (Array.isArray(target.facilities)) return fit(target.facilities.map((id) => facPt(facById(id))), 'over', 14); // R9 search
    if (target.toId != null) { // R8 one route: its road, both clinics and its patients' homes; room for the chip
      const I = isoSet(), on = (r) => r.item.toId === target.toId && (target.fromId == null || r.item.fromId === target.fromId);
      const homes = (S.patients || []).filter((p) => I && I.pats.has(p.id) && Number.isFinite(p.lng)).map((p) => [p.lng, p.lat]);
      return fit([facPt(facById(target.fromId)), facPt(facById(target.toId)), ...S.trace.filter((r) => on(r) && r.line).flatMap((r) => r.line), ...homes], 'over', 14, 80);
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
    // The closed clinic says "No power" once dead; power back on also ends the grid scene (v5).
    setPower(dead) { S.dead = !!dead; if (!S.dead) gridScene(false); applyPower(); updateMarkers(); },
    setFacilityStatus(statusById) { S.status = { ...(statusById || {}) }; renderFp(); updateMarkers(); },
    // v5: the homes arriving end the grid scene.
    setPatients(list) { S.patients = list || null; if (S.patients && S.patients.length) gridScene(false); computeRecv(); renderPatients(); updateMarkers(); syncFx(); },
    // Who moves: items {id, fromId, toId, from:[lng,lat], to:[lng,lat], action, changed}; ids are optional (found from the
    // coordinates). It marks changed routes and fits 'flows'; it draws no lines. null or [] also clears the traced routes.
    setFlows(list) {
      S.flows = list || null;
      if (!S.flows || !S.flows.length) { stopTrace(); S.trace = []; clearGraph(); } else gridScene(false);
      computeRecv(); renderFlows(); updateMarkers(); syncFx();
    },
    // R4: [{fromId, toId, action, line:[[lng,lat]..]|null, count, label}], { stagger, duration, onArrive(item) } -> Promise.
    // The only source of route lines (R7); null line = dashed straight line. [] clears.
    traceRoutes,
    // R9: { sourceId, visits: [{ id, open, used, accepted }], perNode: 700 } -> Promise; null clears. traceRoutes takes over its edges.
    searchGraph,
    // R8: {type:'patient', id} | {type:'route', fromId, toId} | null. Shows one path only, with a "Show all routes" chip.
    isolate,
    // R3: { [facilityId]: { open, used, full, text, early } }; {} clears. text replaces the status; early replaces "8 come in early".
    setCapacity(c) { S.cap = c && typeof c === 'object' ? { ...c } : {}; updateMarkers(); syncFx(); },
    // R4 scene 3: tilt into the home clinic; resolves after the flight plus hold ms (at once under reduced motion).
    // v5: the grid fades in over the second half of the flight and stays until the homes arrive.
    flyHome3D({ hold = 0, duration = 1800 } = {}) {
      if (!S.is3D) { S.is3D = true; if (opts.on3D) opts.on3D(true); }
      const d = reduced() ? 0 : duration;
      focus('home', { duration: d });
      gridScene(true, d * 0.55);
      return new Promise((r) => setTimeout(r, reduced() ? 0 : d + hold));
    },
    // E2/R8: {id, home, to, line|null, minutes, miles, label, action?, note?}; shows only that route (isolate patient), fits it.
    // null ends a patient isolation.
    showPatientRoute(p) {
      if (!p || !Array.isArray(p.home) || !Array.isArray(p.to)) { S.pr = null; if (S.iso && S.iso.type === 'patient') S.iso = null; }
      else {
        const fl = (S.flows || []).find((x) => x && x.id === p.id), me = (S.patients || []).find((x) => x.id === p.id);
        S.pr = { ...p, action: p.action || (me && me.action) || (fl && fl.action) || 'transfer' };
        S.iso = { type: 'patient', id: p.id };
      }
      renderIso();
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
    // Ring + label on the dot. A route or isolation shown for another patient goes away (it belongs to that patient).
    selectPatient(id) {
      S.sel = id == null ? null : id;
      if (S.pr && S.pr.id !== S.sel) S.pr = null;
      if (S.iso && S.iso.type === 'patient' && S.iso.id !== S.sel) S.iso = null;
      renderIso();
    },
    setAnimation(on) { S.anim = on !== false; syncAnim(); },
    setPadding(p) {
      S.pad = { top: 0, right: 0, bottom: 0, left: 0, ...(p || {}) };
      if (!map) return;
      const f = flying; // map.setPadding is a jumpTo: it stops a running flyTo, so re-aim that flight
      map.setPadding(S.pad);
      renderChip();
      if (f) focus(f[0], { ...f[1], duration: 700 });
    },
    resize() { if (map) map.resize(); },
    get map() { return map; }, // debugging only
  };
})();
