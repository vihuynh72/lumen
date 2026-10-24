// Lumen landing page: one night seen twice. The seam splits the hero into the night without Lumen and the
// same night with it; drag it (pointer or keyboard) to compare. Wide screens split left and right, phones top and bottom.
(() => {
  'use strict';
  const RM = matchMedia('(prefers-reduced-motion: reduce)');
  const PHONE = matchMedia('(max-width: 859px)');
  const K = Math.cos(37.3 * Math.PI / 180);  // longitude squeeze at San Jose's latitude

  // The Santa Clara demo (backend data/seed/santaclara/): clinic positions from public CMS data (clinics.json); routes
  // and counts from the plan's own steps run on that seed. The shutoff closes the three DARK clinics.
  const DARK = [
    { lng: -121.792, lat: 37.315, name: 'Evergreen', at: 'r' },     // C11 SHC Evergreen, the home clinic
    { lng: -121.810, lat: 37.307, name: 'Silver Creek', at: 'b' },  // C12 SHC Silver Creek
    { lng: -121.778, lat: 37.228, name: 'Santa Teresa', at: 'r' },  // C17 SHC Santa Teresa
  ];
  // where the plan sends them: n patients in all, drawn as one route from the dark clinic that sends the most
  // (the console draws every trip); at = label side
  const TO = [
    { lng: -121.814, lat: 37.351, name: 'White Road', at: 'r', from: 0, n: 12 },      // C13
    { lng: -121.847, lat: 37.308, name: 'Tully', at: 'l', from: 1, n: 18 },           // C15 DaVita Tully
    { lng: -121.848, lat: 37.360, name: 'East San Jose', at: 'l', from: 0, n: 14 },   // C16
    { lng: -121.827, lat: 37.251, name: 'South San Jose', at: 'r', from: 2, n: 15 },  // C18
    { lng: -121.892, lat: 37.245, name: 'Blossom Valley', at: 'l', from: 2, n: 11, bend: -.16 },  // C19
    { lng: -121.934, lat: 37.316, name: 'Valley Renal', at: 'l', from: 2, n: 3 },     // C22 Santa Clara Valley Renal Care Center
    { lng: -121.902, lat: 37.379, name: 'Silicon Valley', at: 'l', from: 0, n: 2 },   // C25 DaVita Silicon Valley
    // H11 Regional Medical Center gets the sheets of the 4 patients who need a phone call. It sits 400 m from
    // SHC East San Jose, so it is drawn a few pixels up and right (nudge) to keep both marks readable.
    { lng: -121.848, lat: 37.363, name: 'Hospital', at: 'r', from: 1, n: 4, h: true, nudge: [14, -14] },
  ];
  // in-center clinics in view that the plan does not need
  const IDLE = [[-121.825,37.347],[-121.914,37.297],[-121.932,37.328],[-121.932,37.311]];
  // the demo's 96 synthetic patients at home (patients.json): [lng, lat, DARK index of their clinic]
  const HOMES = [[-121.766,37.361,0],[-121.78,37.367,0],[-121.76,37.351,0],[-121.851,37.383,0],[-121.793,37.294,0],[-121.847,37.377,0],[-121.829,37.328,0],[-121.837,37.365,0],[-121.832,37.323,0],[-121.849,37.381,0],[-121.844,37.347,0],[-121.835,37.332,0],[-121.82,37.346,0],[-121.83,37.347,0],[-121.843,37.385,0],[-121.819,37.341,0],[-121.873,37.396,0],[-121.769,37.35,0],[-121.778,37.354,0],[-121.84,37.325,0],[-121.829,37.34,0],[-121.776,37.361,0],[-121.785,37.362,0],[-121.841,37.327,0],[-121.786,37.298,0],[-121.829,37.342,0],[-121.873,37.404,0],[-121.85,37.377,0],[-121.837,37.335,0],[-121.857,37.381,0],[-121.771,37.366,0],[-121.77,37.362,0],[-121.821,37.288,1],[-121.766,37.279,1],[-121.766,37.311,1],[-121.831,37.274,1],[-121.834,37.27,1],[-121.849,37.31,1],[-121.868,37.305,1],[-121.836,37.338,1],[-121.78,37.306,1],[-121.763,37.294,1],[-121.823,37.272,1],[-121.827,37.326,1],[-121.845,37.331,1],[-121.777,37.282,1],[-121.764,37.294,1],[-121.828,37.269,1],[-121.834,37.329,1],[-121.843,37.323,1],[-121.817,37.276,1],[-121.824,37.328,1],[-121.823,37.329,1],[-121.829,37.274,1],[-121.775,37.298,1],[-121.831,37.291,1],[-121.837,37.274,1],[-121.82,37.271,1],[-121.845,37.29,1],[-121.769,37.316,1],[-121.827,37.288,1],[-121.813,37.279,1],[-121.791,37.309,1],[-121.834,37.27,1],[-121.834,37.244,2],[-121.781,37.221,2],[-121.846,37.261,2],[-121.784,37.219,2],[-121.769,37.234,2],[-121.784,37.232,2],[-121.866,37.218,2],[-121.813,37.267,2],[-121.781,37.218,2],[-121.816,37.265,2],[-121.771,37.234,2],[-121.828,37.262,2],[-121.754,37.241,2],[-121.827,37.256,2],[-121.82,37.269,2],[-121.826,37.264,2],[-121.815,37.27,2],[-121.758,37.226,2],[-121.83,37.251,2],[-121.864,37.211,2],[-121.866,37.218,2],[-121.828,37.266,2],[-121.876,37.23,2],[-121.826,37.257,2],[-121.782,37.22,2],[-121.854,37.229,2],[-121.846,37.208,2],[-121.831,37.277,2],[-121.861,37.228,2],[-121.851,37.223,2],[-121.835,37.257,2],[-121.855,37.25,2]];
  // the simulated shutoff area (outage_area.geojson): the east foothills and south San Jose hills
  const AREA = [[-121.801,37.395],[-121.76,37.405],[-121.715,37.37],[-121.705,37.31],[-121.72,37.255],[-121.745,37.205],[-121.775,37.2],[-121.792,37.218],[-121.788,37.25],[-121.8,37.278],[-121.817,37.298],[-121.817,37.315],[-121.803,37.342],[-121.805,37.37]];

  const $ = s => document.querySelector(s);
  const hero = $('.hero'), knob = $('.knob'), grab = $('.grab'), nav = $('.nav'), map = $('.map');
  if (!hero) return;
  hero.classList.add('js');

  // the lit copy of each block: hidden from assistive tech, each call row shows what Lumen planned
  for (const el of document.querySelectorAll('.split[data-copy]')) {
    const d = el.firstElementChild.cloneNode(true);
    d.classList.replace('n', 'd');
    d.removeAttribute('aria-label');
    d.setAttribute('aria-hidden', 'true');
    d.inert = true;
    for (const li of d.querySelectorAll('li[data-day]')) {
      const st = li.querySelector('.st');
      st.textContent = li.dataset.day;
      st.className = 'st ' + li.dataset.k;
      li.querySelector('.vh')?.remove();
    }
    el.append(d);
  }
  const splits = [...document.querySelectorAll('.split')];

  // one SVG per side, drawn at the box's pixel size so labels keep their real size
  function svg(face, w, h) {
    const narrow = w < 520;
    // the view frames the clinics; the far homes and the ends of the area run past its edges
    const pts = [...DARK, ...TO].map(c => [c.lng, c.lat]);
    const xs = pts.map(p => p[0] * K), ys = pts.map(p => -p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pl = 104, pr = 96, pt = 22, pb = 26;  // room for the longest labels on both sides
    const sc = Math.min((w - pl - pr) / (x1 - x0), (h - pt - pb) / (y1 - y0));
    const ox = pl + (w - pl - pr - (x1 - x0) * sc) / 2, oy = pt + (h - pt - pb - (y1 - y0) * sc) / 2;
    const P = (lng, lat) => [ox + (lng * K - x0) * sc, oy + (-lat - y0) * sc];
    const f = n => n.toFixed(1);
    const day = face === 'd', r = narrow ? 6 : 8;
    const label = (x, y, at, gap) => ({ b: [x, y + gap + 13, 'middle'], t: [x, y - gap - 5, 'middle'], l: [x - gap - 5, y + 5, 'end'], r: [x + gap + 5, y + 5, 'start'] })[at];
    const dk = DARK.map(c => P(c.lng, c.lat));
    const to = TO.map(c => { const [x, y] = P(c.lng, c.lat), [nx, ny] = c.nudge || [0, 0]; return [x + nx, y + ny]; });
    let s = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false">`;
    s += `<path class="area" d="M${AREA.map(p => P(...p).map(f).join(' ')).join('L')}Z"/>`;
    const homes = HOMES.map(([lng, lat, k]) => [...P(lng, lat), k]);
    if (!day) s += `<g class="edges">${homes.map(([x, y, k]) => `<line x1="${f(x)}" y1="${f(y)}" x2="${f(dk[k][0])}" y2="${f(dk[k][1])}"/>`).join('')}</g>`;
    s += `<g class="homes">${homes.map(([x, y]) => `<circle cx="${f(x)}" cy="${f(y)}" r="${narrow ? 2.25 : 3}"/>`).join('')}</g>`;
    for (const [lng, lat] of IDLE) { const [x, y] = P(lng, lat); s += `<circle class="cl ${day ? 'idle' : 'off'}" cx="${f(x)}" cy="${f(y)}" r="${day ? 3.5 : 4.5}"/>`; }
    if (day) TO.forEach((c, i) => {
      // a gentle arc from the dark clinic to the place it sends patients; width follows the count
      const [hx, hy] = dk[c.from], [x, y] = to[i], dx = x - hx, dy = y - hy, b = c.bend ?? .14;
      const d = `M${f(hx)} ${f(hy)}Q${f((hx + x) / 2 - dy * b)} ${f((hy + y) / 2 + dx * b)} ${f(x)} ${f(y)}`;
      const st = `style="--i:${i};--w:${(1.5 + c.n * .15).toFixed(2)}px"`;
      // the hospital rows wait on a phone call from staff, so their line is dotted; the hospital gets their sheets
      s += c.h ? `<path class="rt-call" ${st} d="${d}"/>` : `<path class="rt-base" pathLength="1" ${st} d="${d}"/><path class="rt-flow" ${st} d="${d}"/>`;
    });
    let labels = '';
    TO.forEach((c, i) => {
      const [x, y] = to[i], q = narrow ? 5.5 : 7;
      if (!day) { s += `<circle class="cl off" cx="${f(x)}" cy="${f(y)}" r="${narrow ? 4.5 : 6}"/>`; return; }
      labels += c.h ? `<rect class="cl to h" style="--i:${i}" x="${f(x - q)}" y="${f(y - q)}" width="${2 * q}" height="${2 * q}" rx="3"/>`
        : `<circle class="cl to" style="--i:${i}" cx="${f(x)}" cy="${f(y)}" r="${q}"/>`;
      const [tx, ty, an] = label(x, y, c.at, q);
      labels += `<text class="to" style="--i:${i}" x="${f(tx)}" y="${f(ty)}" text-anchor="${an}">${c.name}</text>`;
    });
    DARK.forEach((c, i) => {
      const [x, y] = dk[i], [tx, ty, an] = label(x, y, c.at, r);
      s += `<circle class="ping" cx="${f(x)}" cy="${f(y)}" r="${r}"/><circle class="core" cx="${f(x)}" cy="${f(y)}" r="${r}"/>`;
      labels += `<text class="off" x="${f(tx)}" y="${f(ty)}" text-anchor="${an}">${c.name}</text>`;
    });
    return s + labels + '</svg>';
  }
  let drawn = '';
  function drawMap() {
    const w = Math.round(map.clientWidth), h = Math.round(map.clientHeight);
    if (!w || !h || drawn === w + 'x' + h) return;
    drawn = w + 'x' + h;
    map.querySelector('.n').innerHTML = svg('n', w, h);
    map.querySelector('.d').innerHTML = svg('d', w, h);
  }

  // seam state: --s is the seam's distance in px from the hero's left (wide) or top (phone) edge
  let axis = '', size = 1, s = 0, lo = 0, hi = 1, def = 0, ratio = null, sides = [];
  let tweening = false, raf = 0, timer = 0, dragging = null;
  function setSeam(v, free) {
    s = free ? v : Math.min(hi, Math.max(lo, v));
    hero.style.setProperty('--s', s.toFixed(1) + 'px');
    for (const [el, c] of sides) el.classList.toggle('lit', c > s);
    const p = Math.round(100 * Math.min(1, Math.max(0, s / size)));
    knob.setAttribute('aria-valuenow', p);
    knob.setAttribute('aria-valuetext', `${p}% without Lumen, ${100 - p}% with Lumen`);
  }

  function layout() {
    const was = axis;
    axis = PHONE.matches ? 'y' : 'x';
    knob.setAttribute('aria-orientation', axis === 'x' ? 'horizontal' : 'vertical');
    if (axis === 'x') document.documentElement.style.setProperty('--how-h', $('.how').offsetHeight + 'px');
    const hr = hero.getBoundingClientRect();
    const at = r => axis === 'x' ? r.left - hr.left : r.top - hr.top;
    const mid = r => axis === 'x' ? r.left + r.width / 2 - hr.left : r.top + r.height / 2 - hr.top;
    size = axis === 'x' ? hr.width : hr.height;
    for (const el of splits) el.style.setProperty('--o', at(el.firstElementChild.getBoundingClientRect()).toFixed(1) + 'px');
    sides = [...hero.querySelectorAll('[data-side]')].map(el => [el, mid(el.getBoundingClientRect())]);
    if (axis === 'x') {
      // the seam stays between the two nav groups, so no link is ever cut in half
      const lg = $('.nav .nl[href="#clinics"]').getBoundingClientRect(), rg = $('.nav button.nl').getBoundingClientRect();
      lo = Math.max(size * .08, lg.right - hr.left + 20); hi = Math.min(size * .92, rg.left - hr.left - 20); def = size / 2;
      const r = $('.scene').getBoundingClientRect();
      hero.style.setProperty('--ky', (r.top + r.height / 2 - hr.top).toFixed(0) + 'px');
    } else {
      // the knob (48 px) stays clear of the nav and the hero's bottom edge
      lo = nav.getBoundingClientRect().bottom - hr.top + 30; hi = size - 30;
      def = ($('.calls .n').getBoundingClientRect().bottom + $('.ld .n').getBoundingClientRect().top) / 2 - hr.top;
    }
    knob.setAttribute('aria-valuemin', Math.round(100 * lo / size));
    knob.setAttribute('aria-valuemax', Math.round(100 * hi / size));
    drawMap();
    if (!tweening) setSeam(ratio === null || was !== axis ? def : ratio * size);
  }

  function stopIntro() {
    if (!tweening) return;
    tweening = false; clearTimeout(timer); cancelAnimationFrame(raf);
  }
  // the entrance: the whole hero starts as night, then the lit side sweeps in to the middle
  function intro() {
    if (RM.matches) return;
    hero.classList.add('intro');
    tweening = true;
    const start = axis === 'x' ? size : Math.min(size, innerHeight - hero.getBoundingClientRect().top);
    setSeam(start, true);
    timer = setTimeout(() => {
      const t0 = performance.now(), ms = 1100;
      const step = now => {
        if (!tweening) return;
        const t = Math.min(1, (now - t0) / ms);
        setSeam(t < 1 ? start + (def - start) * (1 - 2 ** (-10 * t)) : def, true);
        if (t < 1) raf = requestAnimationFrame(step); else tweening = false;
      };
      raf = requestAnimationFrame(step);
    }, 1000);
    setTimeout(() => hero.classList.remove('intro'), 3600);
  }

  // drag: the knob anywhere, the line only on wide screens (on phones the line spans the page and must still scroll)
  function down(e) {
    if (e.button > 0) return;
    stopIntro();
    dragging = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    hero.classList.add('dragging');  // before mousedown, so no text selection starts
    move(e);
  }
  function move(e) {
    if (dragging !== e.pointerId) return;
    const r = hero.getBoundingClientRect();
    setSeam(axis === 'x' ? e.clientX - r.left : e.clientY - r.top);
    ratio = s / size;
  }
  function up(e) {
    if (dragging !== e.pointerId) return;
    dragging = null;
    hero.classList.remove('dragging');
  }
  for (const el of [knob, grab]) {
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  knob.addEventListener('keydown', e => {
    const step = size * (e.shiftKey ? .1 : .03);
    const v = { ArrowLeft: s - step, ArrowUp: s - step, ArrowRight: s + step, ArrowDown: s + step,
      PageUp: s - size * .15, PageDown: s + size * .15, Home: lo, End: hi }[e.key];
    if (v === undefined) return;
    e.preventDefault();
    stopIntro();
    setSeam(v);
    ratio = s / size;
  });

  let lr = 0;
  const relayout = () => { cancelAnimationFrame(lr); lr = requestAnimationFrame(layout); };
  new ResizeObserver(relayout).observe(hero);
  PHONE.addEventListener('change', relayout);
  document.fonts?.ready.then(relayout);
  // the flowing routes are the only loop; they rest while the hero is off screen
  new IntersectionObserver(([en]) => hero.classList.toggle('still', !en.isIntersecting)).observe(hero);
  layout();
  intro();

  // Request a demo and Sign in: one Coming soon dialog that collects nothing
  const dlg = $('#soon');
  let opener = null;
  for (const b of document.querySelectorAll('[data-soon]')) b.addEventListener('click', () => { opener = b; dlg.showModal(); });
  dlg.addEventListener('close', () => opener?.focus());
  dlg.addEventListener('click', e => {
    const r = dlg.getBoundingClientRect();
    if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dlg.close();
  });
})();
