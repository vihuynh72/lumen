/* Lumen map: window.LumenMap on MapLibre GL JS 4.7.1 (global maplibregl). Contract: CONTRACT.md "Map module". */
(() => {
  'use strict';

  const OSM = '© OpenStreetMap contributors';
  const EMPTY = { type: 'FeatureCollection', features: [] };
  // Standard MapLibre "animated dash" sequence: one step every DASH_MS moves the dashes along the line.
  const DASH = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
    [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
  const DASH_MS = 60;
  const DROP = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2C6.2 4.6 4.2 7.1 4.2 9.6a3.8 3.8 0 0 0 7.6 0C11.8 7.1 9.8 4.6 8 2.2z" fill="currentColor" fill-opacity=".18"/></svg>';
  const HOSP = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" aria-hidden="true"><path d="M5 3.8v8.4M11 3.8v8.4M5 8h6"/></svg>';
  const RANK = { home: 0, closed: 1, receiving: 2, hospital: 3, normal: 4 };

  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => mq.matches;
  const fc = (features) => ({ type: 'FeatureCollection', features });
  const point = (c, properties = {}) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: c } });
  const z = (...stops) => ['interpolate', ['linear'], ['zoom'], ...stops];

  let map = null, opts = {}, ready = false, amazon = false, raf = 0, dashStep = -1, moveRaf = 0;
  let T = {}, fontR = ['Noto Sans Regular'], fontB = ['Noto Sans Bold'];
  let markers = [];
  const area = { marker: null, text: null, box: null }; // DOM "Shutoff area" label, so facility labels can avoid it
  const S = { theme: 'light', region: null, facilities: [], status: {}, dead: false, outage: null, patients: null,
    flows: null, recv: {}, sel: null, is3D: false, pad: { top: 0, right: 0, bottom: 0, left: 0 } };
  const D = { trans: EMPTY, subs: EMPTY, feeders: EMPTY, fp: [], center: {} };

  // ---------- style, tokens, fonts ----------

  function styleUrl() {
    const dark = S.theme === 'dark';
    return amazon
      ? `https://maps.geo.us-east-2.amazonaws.com/v2/styles/Monochrome/descriptor?key=${encodeURIComponent(opts.mapKey)}&color-scheme=${dark ? 'Dark' : 'Light'}`
      : `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`;
  }

  function readTokens() {
    const cs = getComputedStyle(document.documentElement), dark = S.theme === 'dark';
    const g = (n, l, d) => cs.getPropertyValue(n).trim() || (dark ? d : l);
    T = {
      power: g('--map-power', '#2F8F5B', '#57C98C'), dead: g('--map-dead', '#B5544C', '#FF8A7D'),
      trans: g('--map-trans', '#4A5953', '#A9B8B1'), outage: g('--map-outage', '#C2362F', '#FF6B5B'),
      early: g('--map-early', '#23784A', '#57C98C'), transfer: g('--map-transfer', '#2457C5', '#7FA6FF'),
      hospital: g('--map-hospital', '#C2362F', '#FF6B5B'), affected: g('--map-affected', '#E39A1E', '#F2AE3D'),
      ink: g('--map-ink', '#13201C', '#E6EDEA'), halo: g('--map-halo', 'rgba(251,252,251,.92)', 'rgba(10,16,14,.85)'),
      mute: g('--mute', '#5B6863', '#93A39C'),
      warm: dark ? '#5E5A53' : '#CDC7BD',          // neutral warm gray for facility buildings
      bldg: dark ? '#2A302D' : '#DDDBD5',          // faint basemap buildings
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

  function addOverlays() {
    const style = map.getStyle();
    const before = (style.layers.find((l) => l.type === 'symbol') || {}).id;
    const add = (layer, beforeId) => map.addLayer(layer, beforeId);
    const halo = { 'text-halo-color': T.halo, 'text-halo-width': 1.6, 'text-halo-blur': 0.4 };
    const round = { 'line-cap': 'round', 'line-join': 'round' };
    const act = ['match', ['get', 'action'], 'early_session', T.early, 'transfer', T.transfer, 'hospital', T.hospital, 'notify_only', T.mute, T.affected];
    const flowColor = ['case', ['get', 'changed'], T.affected, act];
    const fade = { duration: 0, delay: 0 };

    ['lm-outage', 'lm-trans', 'lm-subs', 'lm-feeders', 'lm-fp', 'lm-flows', 'lm-flow-ends', 'lm-pat']
      .forEach((id) => map.addSource(id, { type: 'geojson', data: EMPTY }));
    map.addImage('lm-sub-live', subIcon(T.trans, false), { pixelRatio: 2 });
    map.addImage('lm-sub-dead', subIcon(T.dead, true), { pixelRatio: 2 });

    // Under the basemap labels: outage fill, grid, outline, buildings.
    add({ id: 'lm-outage-fill', type: 'fill', source: 'lm-outage', paint: { 'fill-color': T.outage, 'fill-opacity': 0, 'fill-opacity-transition': fade } }, before);
    const tw = z(8, ['*', 1, ['get', 'w']], 11, ['*', 1.6, ['get', 'w']], 14, ['*', 2, ['get', 'w']], 17, ['*', 3, ['get', 'w']]);
    add({ id: 'lm-trans-line', type: 'line', source: 'lm-trans', layout: round, paint: { 'line-color': T.trans, 'line-opacity': 0.85, 'line-width': tw } }, before);
    add({ id: 'lm-trans-dead', type: 'line', source: 'lm-trans', layout: { 'line-join': 'round' }, paint: { 'line-color': T.dead, 'line-opacity': 0.7, 'line-width': tw, 'line-dasharray': [2, 1.6] } }, before);
    add({ id: 'lm-feeder-casing', type: 'line', source: 'lm-feeders', layout: round, paint: { 'line-color': T.halo, 'line-width': z(10, 4, 15, 8) } }, before);
    add({ id: 'lm-feeder-live', type: 'line', source: 'lm-feeders', layout: round, paint: { 'line-color': T.power, 'line-opacity': 0.32, 'line-width': z(10, 1.8, 15, 3.4) } }, before);
    add({ id: 'lm-feeder-flow', type: 'line', source: 'lm-feeders', layout: { 'line-join': 'round' }, paint: { 'line-color': T.power, 'line-width': z(10, 1.8, 15, 3.4), 'line-dasharray': DASH[0], 'line-dasharray-transition': fade } }, before);
    add({ id: 'lm-feeder-dead', type: 'line', source: 'lm-feeders', layout: { 'line-join': 'round' }, paint: { 'line-color': T.dead, 'line-opacity': 0.6, 'line-width': z(10, 1.6, 15, 2.8), 'line-dasharray': [1.6, 1.6] } }, before);
    add({ id: 'lm-outage-line', type: 'line', source: 'lm-outage', layout: { 'line-join': 'round' }, paint: { 'line-color': T.outage, 'line-width': z(8, 1.5, 14, 2.25), 'line-dasharray': [3, 2], 'line-opacity': 0, 'line-opacity-transition': fade } }, before);

    // Faint basemap 3D buildings when the style's tiles carry heights.
    const has = (src, sl) => style.sources[src] && style.layers.some((l) => l.source === src && l['source-layer'] === sl);
    if (has('openmaptiles', 'building')) {
      add({ id: 'lm-bldg-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
        filter: ['!=', ['get', 'hide_3d'], true],
        paint: { 'fill-extrusion-color': T.bldg, 'fill-extrusion-opacity': 0.5,
          'fill-extrusion-height': z(14, 0, 14.6, ['coalesce', ['get', 'render_height'], 5]),
          'fill-extrusion-base': z(14, 0, 14.6, ['coalesce', ['get', 'render_min_height'], 0]) } }, before);
    } else if (has('aws', 'buildings')) {
      // shortcut: Amazon Location building tiles carry no height, so every building gets a fixed 6 m; upgrade if the tiles add one.
      add({ id: 'lm-bldg-3d', type: 'fill-extrusion', source: 'aws', 'source-layer': 'buildings', minzoom: 14,
        filter: ['all', ['==', ['get', 'kind'], 'building'], ['==', ['geometry-type'], 'Polygon']],
        paint: { 'fill-extrusion-color': T.bldg, 'fill-extrusion-opacity': 0.5, 'fill-extrusion-height': z(14, 0, 14.6, 6) } }, before);
    }

    // Facility buildings, colored by status.
    const FP = { normal: T.warm, closed: mix(T.outage, T.warm, 0.42), receiving: mix(T.early, T.warm, 0.42), hospital: mix(T.transfer, T.warm, 0.72) };
    const fpColor = (k) => ['match', ['get', 'st'], 'closed', mix(FP.closed, T.ink, k), 'receiving', mix(FP.receiving, T.ink, k), 'hospital', mix(FP.hospital, T.ink, k), mix(FP.normal, T.ink, k)];
    add({ id: 'lm-fp-line', type: 'line', source: 'lm-fp', paint: { 'line-color': fpColor(0.3), 'line-width': z(13, 0.6, 17, 1.4) } }, before);
    add({ id: 'lm-fp-3d', type: 'fill-extrusion', source: 'lm-fp', paint: { 'fill-extrusion-color': fpColor(0), 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 0.94 } }, before);

    // Above basemap labels: flows, patients, then our own labels.
    add({ id: 'lm-flow-casing', type: 'line', source: 'lm-flows', layout: { ...round, 'line-sort-key': ['case', ['get', 'changed'], 1, 0] }, paint: { 'line-color': T.halo, 'line-width': ['case', ['get', 'changed'], 6.5, 4.5] } });
    add({ id: 'lm-flow-line', type: 'line', source: 'lm-flows', layout: { ...round, 'line-sort-key': ['case', ['get', 'changed'], 1, 0] }, paint: { 'line-color': flowColor, 'line-width': ['case', ['get', 'changed'], 3.5, 2] } });
    add({ id: 'lm-flow-end', type: 'circle', source: 'lm-flow-ends', paint: { 'circle-radius': ['case', ['get', 'changed'], 4.5, 3.5], 'circle-color': flowColor, 'circle-stroke-color': T.halo, 'circle-stroke-width': 1.5 } });
    add({ id: 'lm-pat-ring', type: 'circle', source: 'lm-pat', filter: ['==', ['get', 'sel'], true], paint: { 'circle-radius': z(8, 9, 14, 13), 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': T.ink, 'circle-stroke-width': 2 } });
    add({ id: 'lm-pat', type: 'circle', source: 'lm-pat', layout: { 'circle-sort-key': ['case', ['get', 'sel'], 1, 0] }, paint: { 'circle-radius': z(8, 4, 14, 7), 'circle-color': act, 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 1.5 } });

    add({ id: 'lm-trans-label', type: 'symbol', source: 'lm-trans', minzoom: 12, filter: ['has', 'kv'],
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 420, 'text-field': ['get', 'kv'], 'text-font': fontR, 'text-size': 10.5, 'text-offset': [0, -0.8], 'text-letter-spacing': 0.02 },
      paint: { 'text-color': T.trans, ...halo } });
    add({ id: 'lm-subs', type: 'symbol', source: 'lm-subs', minzoom: 9.5,
      layout: { 'icon-image': 'lm-sub-live', 'icon-size': z(9.5, 0.7, 13, 1), 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'text-field': ['step', ['zoom'], '', 11, ['coalesce', ['get', 'name'], '']], 'text-font': fontR, 'text-size': 11,
        'text-anchor': 'left', 'text-offset': [0.9, 0], 'text-optional': true, 'text-max-width': 10 },
      paint: { 'text-color': T.trans, ...halo } });
    add({ id: 'lm-feeder-label', type: 'symbol', source: 'lm-feeders', minzoom: 13,
      layout: { 'symbol-placement': 'line-center', 'text-field': 'Feeder (illustrative)', 'text-font': fontR, 'text-size': 10.5, 'text-offset': [0, -0.9] },
      paint: { 'text-color': T.power, ...halo } });
    add({ id: 'lm-pat-label', type: 'symbol', source: 'lm-pat', filter: ['!=', ['get', 'txt'], ''],
      layout: { 'text-field': ['get', 'txt'], 'text-font': fontB, 'text-size': 11.5, 'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
        'text-radial-offset': 0.85, 'symbol-sort-key': ['case', ['get', 'sel'], 0, 1] },
      paint: { 'text-color': T.ink, ...halo } });
  }

  function setSrc(id, data) { const s = ready && map.getSource(id); if (s) s.setData(data); }

  function renderAll() {
    setSrc('lm-trans', D.trans); setSrc('lm-subs', D.subs); setSrc('lm-feeders', D.feeders);
    renderFp(); renderOutage(true); renderPatients(); renderFlows(); applyPower();
  }

  const statusOf = (f) => S.status[f.id] || 'normal';
  const facPt = (f) => f && (D.center[f.id] || [f.lng, f.lat]); // pin the building when its footprint is known

  function renderFp() {
    const byId = Object.fromEntries(S.facilities.map((f) => [f.id, f]));
    setSrc('lm-fp', fc(D.fp.map(({ id, levels, geometry }) => {
      const f = byId[id] || { id }, hosp = f.kind === 'hospital';
      return { type: 'Feature', properties: { st: hosp ? 'hospital' : statusOf(f), h: hosp ? 30 : levels ? levels * 4.2 : 12 }, geometry };
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
    setSrc('lm-pat', fc((S.patients || []).filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat)).map((p) => {
      const sel = p.id === S.sel, rk = p.rank != null && p.rank <= 3 ? `#${p.rank}` : '';
      return point([p.lng, p.lat], { id: p.id, action: p.action || '', sel, txt: sel ? [rk, p.label].filter(Boolean).join(' ') : rk });
    })));
  }

  function arc(a, b, side) {
    const A = maplibregl.MercatorCoordinate.fromLngLat(a), B = maplibregl.MercatorCoordinate.fromLngLat(b);
    const dx = B.x - A.x, dy = B.y - A.y, k = 0.34 * side; // control point offset 34% => curve apex ~17% of the distance
    const cx = (A.x + B.x) / 2 - dy * k, cy = (A.y + B.y) / 2 + dx * k;
    const at = (t) => {
      const u = 1 - t, ll = new maplibregl.MercatorCoordinate(u * u * A.x + 2 * u * t * cx + t * t * B.x, u * u * A.y + 2 * u * t * cy + t * t * B.y).toLngLat();
      return [ll.lng, ll.lat];
    };
    return { line: Array.from({ length: 33 }, (_, i) => at(i / 32)), tip: at(0.95) };
  }

  function renderFlows() {
    const lines = [], ends = [];
    (S.flows || []).forEach((f, i) => {
      if (!f || !f.from || !f.to) return;
      const { line, tip } = arc(f.from, facPt(destOf(f)) || f.to, i % 2 ? 1 : -1), props = { id: f.id, action: f.action || '', changed: !!f.changed };
      lines.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: line } });
      ends.push(point(tip, props));
    });
    setSrc('lm-flows', fc(lines)); setSrc('lm-flow-ends', fc(ends));
  }

  function applyPower() {
    if (!ready) return;
    const dead = (k) => ['all', S.dead, ['==', ['get', k], true]], live = (k) => ['!', dead(k)];
    map.setFilter('lm-trans-line', live('in_outage')); map.setFilter('lm-trans-dead', dead('in_outage'));
    map.setFilter('lm-feeder-live', live('deenergized')); map.setFilter('lm-feeder-flow', live('deenergized'));
    map.setFilter('lm-feeder-dead', dead('deenergized'));
    map.setLayoutProperty('lm-subs', 'icon-image', ['case', dead('in_outage'), 'lm-sub-dead', 'lm-sub-live']);
    map.setPaintProperty('lm-subs', 'icon-opacity', ['case', dead('in_outage'), 0.7, 1]);
    map.setPaintProperty('lm-subs', 'text-color', ['case', dead('in_outage'), T.dead, T.trans]);
    map.setPaintProperty('lm-feeder-label', 'text-color', ['case', dead('deenergized'), T.dead, T.power]);
    map.setPaintProperty('lm-trans-label', 'text-color', ['case', dead('in_outage'), T.dead, T.trans]);
  }

  // ---------- feeder current animation ----------

  function tick(t) {
    raf = requestAnimationFrame(tick);
    const s = Math.floor(t / DASH_MS) % DASH.length;
    if (s !== dashStep && ready && map.getLayer('lm-feeder-flow')) { dashStep = s; map.setPaintProperty('lm-feeder-flow', 'line-dasharray', DASH[s]); }
  }

  function syncAnim() {
    const want = ready && !reduced() && !document.hidden && D.feeders.features.some((f) => !(S.dead && f.properties.deenergized));
    if (want && !raf) raf = requestAnimationFrame(tick);
    else if (!want && raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  // ---------- facility markers (DOM) ----------

  function injectCss() {
    if (document.getElementById('lm-css')) return;
    const css = document.createElement('style');
    css.id = 'lm-css';
    css.textContent = `
.lm-fac{--pin:26px;--stem:10px;appearance:none;background:none;border:0;margin:0;padding:0 0 var(--stem);display:block;width:var(--pin);cursor:pointer;font-family:var(--f-ui,system-ui,sans-serif);text-align:left;color:var(--map-ink,#13201C);-webkit-tap-highlight-color:transparent}
.lm-fac.is-home{--pin:30px}
.lm-fac.is-tall{--stem:30px}
.lm-fac.is-small{--pin:20px;--stem:7px}
.lm-fac.is-small.is-home{--pin:24px}
.lm-fac.is-small .lm-pin svg{width:12px;height:12px}
.lm-pin{box-sizing:border-box;width:var(--pin);height:var(--pin);border-radius:50%;display:grid;place-items:center;background:var(--paper,#FBFCFB);border:1.5px solid var(--line-2,#B7C1BC);color:var(--ink-2,#3A4843);box-shadow:0 1px 2px rgba(19,32,28,.12),0 3px 10px rgba(19,32,28,.14);transition:background-color .2s ease-out,border-color .2s ease-out,color .2s ease-out,transform .15s ease-out}
.lm-fac.is-home .lm-pin{border:2px solid var(--map-ink,#13201C);color:var(--map-ink,#13201C)}
.lm-fac.is-hosp .lm-pin{border-radius:6px;background:#2457C5;border-color:#2457C5;color:#fff}
.lm-fac[data-st=closed] .lm-pin{background:var(--map-outage,#C2362F);border-color:var(--map-outage,#C2362F);color:#fff}
.lm-fac[data-st=receiving] .lm-pin{background:var(--map-early,#23784A);border-color:var(--map-early,#23784A);color:#fff}
.lm-fac.is-home[data-st=closed] .lm-pin,.lm-fac.is-home[data-st=receiving] .lm-pin{border-color:var(--map-ink,#13201C)}
:root[data-theme=dark] .lm-fac[data-st=closed] .lm-pin,:root[data-theme=dark] .lm-fac[data-st=receiving] .lm-pin{color:var(--ground,#0A100E)}
.lm-stem{position:absolute;left:calc(var(--pin) / 2 - .75px);top:var(--pin);width:1.5px;height:var(--stem);background:var(--map-ink,#13201C);opacity:.75}
.lm-stem::after{content:"";position:absolute;left:-2.25px;bottom:-3px;width:6px;height:6px;border-radius:50%;background:var(--map-ink,#13201C);box-shadow:0 0 0 1.5px var(--map-halo,#fff)}
.lm-txt{position:absolute;left:calc(var(--pin) + 7px);top:0;display:flex;flex-direction:column;justify-content:center;min-height:var(--pin);white-space:nowrap;line-height:1.15}
.lm-fac.lbl-left .lm-txt{left:auto;right:calc(100% + 7px);align-items:flex-end;text-align:right}
.lm-name,.lm-sub{text-shadow:0 0 1px var(--map-halo,#fff),0 0 2px var(--map-halo,#fff),0 0 3px var(--map-halo,#fff),0 0 5px var(--map-halo,#fff)}
.lm-name{font-size:13px;font-weight:600;letter-spacing:.005em}
.lm-sub{font-size:11.5px;font-weight:500;color:var(--ink-2,#3A4843);margin-top:1px}
.lm-fac[data-st=closed] .lm-sub{color:var(--red-ink,#A12A24)}
.lm-fac[data-st=receiving] .lm-sub{color:var(--green-ink,#1D6940)}
.lm-fac.no-sub .lm-sub{display:none}
.lm-area{pointer-events:none;white-space:nowrap;font-family:var(--f-ui,system-ui,sans-serif);font-size:13px;font-weight:700;letter-spacing:.02em;color:var(--map-outage,#C2362F);opacity:0;transition:opacity .4s ease-out;text-shadow:0 0 1px var(--map-halo,#fff),0 0 2px var(--map-halo,#fff),0 0 3px var(--map-halo,#fff),0 0 5px var(--map-halo,#fff)}
.lm-area.on{opacity:1}
.lm-fac.no-label .lm-txt{visibility:hidden}
.lm-fac:hover,.lm-fac:focus-visible{z-index:9!important}
.lm-fac:hover .lm-pin{transform:scale(1.07)}
.lm-fac:focus{outline:none}
.lm-fac:focus-visible .lm-pin{outline:2px solid var(--focus,#2457C5);outline-offset:2px}
.lm-fac:hover .lm-txt,.lm-fac:focus-visible .lm-txt{visibility:visible}
.maplibregl-ctrl.maplibregl-ctrl-group,.maplibregl-ctrl.maplibregl-ctrl-attrib,.maplibregl-ctrl-scale{background:var(--paper,#FBFCFB);color:var(--ink-2,#3A4843);font-family:var(--f-ui,system-ui,sans-serif)}
.maplibregl-ctrl.maplibregl-ctrl-group{border-radius:8px;box-shadow:0 1px 2px rgba(19,32,28,.06),0 10px 30px rgba(19,32,28,.13)}
.maplibregl-ctrl-group button+button{border-top-color:var(--line,#D4DBD7)}
.maplibregl-ctrl-attrib a{color:inherit}
.maplibregl-ctrl-scale{border-color:var(--ink-2,#3A4843)}
:root[data-theme=dark] .maplibregl-ctrl-icon,:root[data-theme=dark] .maplibregl-ctrl-attrib-button{filter:invert(1) hue-rotate(180deg)}
@media (prefers-reduced-motion:reduce){.lm-pin,.lm-area{transition:none}.lm-fac:hover .lm-pin{transform:none}}`;
    document.head.appendChild(css);
  }

  const shortName = (n) => n.replace(/\s+(Dialysis|Center|Centre)\b/gi, '').replace(/\s{2,}/g, ' ').trim();

  function subLabel(f, st, n) {
    if (f.kind === 'hospital') return st === 'hospital' ? 'Hospital · staff calls' : 'Hospital';
    const s = st === 'closed' ? 'loses power' : st === 'receiving' ? `receiving${n ? ' ' + n : ''}` : '';
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
      el.innerHTML = `<span class="lm-stem"></span><span class="lm-pin">${f.kind === 'hospital' ? HOSP : DROP}</span><span class="lm-txt"><span class="lm-name"></span><span class="lm-sub"></span></span>`;
      el.addEventListener('click', (e) => { e.stopPropagation(); if (opts.onSelect) opts.onSelect({ type: 'facility', id: f.id }); });
      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom-left' }).setLngLat(facPt(f)).addTo(map);
      markers.push({ f, el, marker, name: el.querySelector('.lm-name'), sub: el.querySelector('.lm-sub'), txt: el.querySelector('.lm-txt'), key: '' });
    });
    updateMarkers();
  }

  function updateMarkers() {
    if (!map) return;
    const zm = map.getZoom(), short = zm < 12, noSub = zm < 11, tall = zm >= 14.5, small = zm < 10.5;
    markers.forEach((m) => {
      const f = m.f, st = statusOf(f), name = short ? shortName(f.name) : f.name, sub = subLabel(f, st, S.recv[f.id] || 0);
      const key = `${st}|${name}|${sub}|${noSub}|${tall}|${small}`;
      if (key === m.key) return;
      m.key = key;
      m.el.dataset.st = st;
      m.el.classList.toggle('is-home', !!f.home);
      m.el.classList.toggle('is-hosp', f.kind === 'hospital');
      m.el.classList.toggle('no-sub', noSub);
      m.el.classList.toggle('is-tall', tall);
      m.el.classList.toggle('is-small', small);
      m.stem = tall ? 30 : small ? 7 : 10;
      m.pin = (f.home ? 30 : 26) - (small ? 6 : 0);
      m.marker.setOffset([-m.pin / 2, 0]); // keeps the stem foot on the point
      m.name.textContent = name;
      m.sub.textContent = sub;
      m.el.setAttribute('aria-label', `${f.name}. ${sub}`);
      m.el.style.zIndex = f.home ? 3 : st === 'normal' ? 1 : 2;
      m.rank = f.home ? 0 : RANK[st] != null ? RANK[st] : 4;
      m.lw = m.txt.offsetWidth; m.lh = m.txt.offsetHeight;
    });
    placeLabels();
  }

  // Put each facility label right of its pin, else left, else hide it; never over another pin or a higher-priority label (pins always stay).
  function placeLabels() {
    const items = markers.map((m) => {
      const p = map.project(m.marker.getLngLat());
      return { m, p, pin: [p.x - m.pin / 2 - 2, p.y - m.stem - m.pin - 2, p.x + m.pin / 2 + 2, p.y + 3] };
    });
    const placed = items.map((i) => i.pin), W = map.getContainer().clientWidth;
    const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
    if (area.box) { // area label: center, else the first nearby spot no pin covers
      const c = map.project(area.marker.getLngLat()), [w, h] = area.box, dx = w / 2 + 12, dy = h + 6;
      const at = ([x, y]) => [c.x + x - w / 2, c.y + y - h / 2, c.x + x + w / 2, c.y + y + h / 2];
      const off = [[0, 0], [dx, 0], [0, dy], [0, -dy], [-dx, 0], [dx, dy], [dx, -dy]].find((o) => !placed.some((b) => hit(at(o), b))) || [0, 0];
      const cur = area.marker.getOffset();
      if (cur.x !== off[0] || cur.y !== off[1]) area.marker.setOffset(off);
      placed.push(at(off));
    }
    items.sort((a, b) => a.m.rank - b.m.rank).forEach(({ m, p, pin }) => {
      const top = p.y - m.stem - m.pin, bottom = top + Math.max(m.lh, m.pin) + 1;
      const right = [p.x + m.pin / 2 + 5, top - 1, p.x + m.pin / 2 + 9 + m.lw, bottom];
      const left = [p.x - m.pin / 2 - 9 - m.lw, top - 1, p.x - m.pin / 2 - 5, bottom];
      const free = (box) => box[0] >= 0 && box[2] <= W && !placed.some((b) => b !== pin && hit(box, b));
      const box = free(right) ? right : free(left) ? left : null;
      if (box) placed.push(box);
      m.el.classList.toggle('no-label', !box);
      m.el.classList.toggle('lbl-left', box === left);
    });
  }

  function onMove() {
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => { moveRaf = 0; updateMarkers(); });
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

  // ---------- public API ----------

  async function init(container, o = {}) {
    if (!window.maplibregl) throw new Error('The map library did not load.');
    opts = o;
    S.theme = o.theme === 'dark' ? 'dark' : 'light';
    amazon = !!o.mapKey;
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
    map.on('error', (e) => { // Amazon style failed to load: fall back to OpenFreeMap
      if (amazon && !ready && !e.sourceId && !e.tile) { amazon = false; map.setStyle(styleUrl(), { diff: false }); }
    });
    map.on('click', 'lm-pat', (e) => { const f = e.features && e.features[0]; if (f && opts.onSelect) opts.onSelect({ type: 'patient', id: f.properties.id }); });
    map.on('mouseenter', 'lm-pat', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'lm-pat', () => { map.getCanvas().style.cursor = ''; });
    map.on('move', onMove);
    map.on('resize', onMove);
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
    D.fp = ((r.footprints || EMPTY).features || []).map((f) => ({ id: f.properties.facility_id, levels: f.properties.levels, geometry: grow(f.geometry) }));
    D.center = Object.fromEntries(D.fp.filter((f) => f.geometry && f.geometry.type === 'Polygon').map((f) => {
      const r0 = f.geometry.coordinates[0];
      return [f.id, [r0.reduce((a, c) => a + c[0], 0) / r0.length, r0.reduce((a, c) => a + c[1], 0) / r0.length]];
    }));
    computeRecv();
    buildMarkers();
    if (ready) { setSrc('lm-trans', D.trans); setSrc('lm-subs', D.subs); setSrc('lm-feeders', D.feeders); renderFp(); renderFlows(); }
    syncAnim();
  }

  // Match each flow's end to a facility (within ~200 m): counts "Receiving N" and lets the arc end at the pin.
  const destOf = (fl) => fl && fl.to && S.facilities.find((x) => Math.abs(x.lng - fl.to[0]) < 2e-3 && Math.abs(x.lat - fl.to[1]) < 2e-3);
  function computeRecv() {
    S.recv = {};
    (S.flows || []).forEach((fl) => { const f = destOf(fl); if (f) S.recv[f.id] = (S.recv[f.id] || 0) + 1; });
  }

  function focus(target, o = {}) {
    if (!map) return;
    const duration = o.duration != null ? o.duration : 1400;
    const pitch = S.is3D ? 50 : 0, bearing = S.is3D ? -15 : 0;
    const go = (center, zoom) => (reduced() || !duration
      ? map.jumpTo({ center, zoom, pitch, bearing })
      : map.flyTo({ center, zoom, pitch, bearing, duration, essential: true }));
    const fit = (pts) => {
      const b = new maplibregl.LngLatBounds();
      pts.forEach((p) => p && b.extend(p));
      if (b.isEmpty()) return;
      const cam = map.cameraForBounds(b, { padding: 56, bearing, maxZoom: 14.5 });
      if (cam) go(cam.center, cam.zoom);
    };
    const home = S.facilities.find((f) => f.home);
    const bbox = S.region && S.region.bbox;
    const region = () => bbox && fit([[bbox[0], bbox[1]], [bbox[2], bbox[3]]]);
    if (target === 'home') return home ? go(facPt(home), 13.2) : region();
    if (target === 'region') return region();
    if (target === 'outage') return S.outage ? fit([...coordsOf(S.outage), facPt(home)]) : region();
    if (target === 'flows') {
      const pts = (S.flows || []).flatMap((f) => (f ? [f.from, f.to] : []));
      return pts.length ? fit([...pts, ...S.facilities.map(facPt)]) : region();
    }
    if (target && target.facility) { const f = S.facilities.find((x) => x.id === target.facility); return f && go(facPt(f), 15.5); }
    if (target && target.patient) { const p = (S.patients || []).find((x) => x.id === target.patient); return p && go([p.lng, p.lat], 14); }
  }

  function set3D(on) {
    S.is3D = !!on;
    if (!map) return;
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
    setPatients(list) { S.patients = list || null; renderPatients(); },
    setFlows(list) { S.flows = list || null; computeRecv(); renderFlows(); updateMarkers(); },
    focus,
    set3D,
    is3D: () => S.is3D,
    selectPatient(id) { S.sel = id == null ? null : id; renderPatients(); },
    setPadding(p) { S.pad = { top: 0, right: 0, bottom: 0, left: 0, ...(p || {}) }; if (map) map.setPadding(S.pad); },
    resize() { if (map) map.resize(); },
    get map() { return map; }, // debugging only
  };
})();
