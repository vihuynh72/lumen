// Lumen landing page: one night seen twice. The seam splits the hero into the night without Lumen and the
// same night with it; drag it (pointer or keyboard) to compare. Wide screens split left and right, phones top and bottom.
(() => {
  'use strict';
  const RM = matchMedia('(prefers-reduced-motion: reduce)');
  const PHONE = matchMedia('(max-width: 859px)');
  const K = Math.cos(38.7 * Math.PI / 180);  // longitude squeeze at El Dorado's latitude

  // clinic positions from public CMS data (data/seed/clinics.json); C01 is the clinic that loses power
  const HOME = { lng: -120.972, lat: 38.658, name: 'Cameron Park · no power', short: 'Cameron Park' };
  const CLINICS = [
    { lng: -121.133, lat: 38.645, name: 'DaVita Folsom', short: 'Folsom', at: 'b', bend: .12 },
    { lng: -121.210, lat: 38.678, name: 'Orangevale', short: 'Orangevale', at: 't', bend: .2 },
    { lng: -121.269, lat: 38.592, name: 'Sunset', short: 'Sunset', at: 'l', bend: -.16 },
    { lng: -121.173, lat: 38.656 },  // SHC Folsom: no open chairs in the seed, so the plan sends nobody there
    { lng: -121.307, lat: 38.574 },  // DCI Rancho: open, not needed
  ];
  // the demo's 40 synthetic patients at home (data/seed/patients.json), [lng, lat]
  const HOMES = [[-120.932,38.670],[-120.811,38.724],[-121.073,38.672],[-121.025,38.893],[-120.903,38.805],[-121.073,38.698],[-121.071,38.679],[-120.597,38.754],[-121.007,38.892],[-120.896,38.808],[-120.880,38.801],[-120.920,38.811],[-120.574,38.750],[-121.089,38.681],[-120.922,38.673],[-120.891,38.802],[-120.799,38.742],[-120.796,38.729],[-121.066,38.691],[-121.071,38.681],[-120.826,38.697],[-120.905,38.802],[-121.070,38.691],[-121.083,38.689],[-120.784,38.734],[-120.917,38.798],[-121.067,38.690],[-120.901,38.801],[-120.803,38.696],[-120.939,38.675],[-120.998,38.665],[-121.097,38.693],[-120.927,38.653],[-121.075,38.682],[-120.896,38.802],[-120.916,38.667],[-121.095,38.676],[-120.897,38.788],[-120.827,38.682],[-121.080,38.689]];
  // the simulated shutoff area (data/seed/outage_area.geojson)
  const AREA = [[-121.03,38.69],[-121.02,38.64],[-120.95,38.615],[-120.82,38.64],[-120.74,38.69],[-120.75,38.77],[-120.86,38.785],[-120.98,38.73]];
  // the view frames the clinics and the area; the four farthest homes (Cool, Pollock Pines) fall outside it
  const SHOWN = HOMES.filter(([lng, lat]) => lng < -120.72 && lat < 38.82);

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
    const pts = [[HOME.lng, HOME.lat], ...CLINICS.map(c => [c.lng, c.lat]), ...SHOWN, ...AREA];
    const xs = pts.map(p => p[0] * K), ys = pts.map(p => -p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pl = narrow ? 52 : 64, pr = 12, pt = 30, pb = 26;
    const sc = Math.min((w - pl - pr) / (x1 - x0), (h - pt - pb) / (y1 - y0));
    const ox = pl + (w - pl - pr - (x1 - x0) * sc) / 2, oy = pt + (h - pt - pb - (y1 - y0) * sc) / 2;
    const P = (lng, lat) => [ox + (lng * K - x0) * sc, oy + (-lat - y0) * sc];
    const f = n => n.toFixed(1);
    const [hx, hy] = P(HOME.lng, HOME.lat);
    const day = face === 'd';
    let s = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false">`;
    s += `<path class="area" d="M${AREA.map(p => P(...p).map(f).join(' ')).join('L')}Z"/>`;
    const homes = SHOWN.map(p => P(...p));
    if (!day) s += `<g class="edges">${homes.map(([x, y]) => `<line x1="${f(x)}" y1="${f(y)}" x2="${f(hx)}" y2="${f(hy)}"/>`).join('')}</g>`;
    s += `<g class="homes">${homes.map(([x, y]) => `<circle cx="${f(x)}" cy="${f(y)}" r="3"/>`).join('')}</g>`;
    let labels = '';
    CLINICS.forEach((c, i) => {
      const [x, y] = P(c.lng, c.lat);
      if (!c.name) { s += `<circle class="cl ${day ? 'idle' : 'off'}" cx="${f(x)}" cy="${f(y)}" r="${day ? 4 : 5}"/>`; return; }
      if (!day) { s += `<circle class="cl off" cx="${f(x)}" cy="${f(y)}" r="6"/>`; return; }
      // a gentle arc from the dark clinic to each receiving clinic, bowed by c.bend
      const dx = x - hx, dy = y - hy, mx = (hx + x) / 2 - dy * c.bend, my = (hy + y) / 2 + dx * c.bend;
      const d = `M${f(hx)} ${f(hy)}Q${f(mx)} ${f(my)} ${f(x)} ${f(y)}`;
      s += `<path class="rt-base" pathLength="1" style="--i:${i}" d="${d}"/><path class="rt-flow" style="--i:${i}" d="${d}"/>`;
      labels += `<circle class="cl to" style="--i:${i}" cx="${f(x)}" cy="${f(y)}" r="7.5"/>`;
      const name = narrow ? c.short : c.name;
      if (!name) return;
      const [tx, ty, a] = { b: [x, y + 26, 'middle'], t: [x, y - 15, 'middle'], l: [x - 14, y + 5, 'end'] }[c.at];
      labels += `<text class="to" style="--i:${i}" x="${f(tx)}" y="${f(ty)}" text-anchor="${a}">${name}</text>`;
    });
    s += labels;
    s += `<circle class="ping" cx="${f(hx)}" cy="${f(hy)}" r="9"/><circle class="core" cx="${f(hx)}" cy="${f(hy)}" r="9"/>`;
    s += `<text class="off" x="${f(hx + 14)}" y="${f(hy + 26)}">${narrow ? HOME.short : HOME.name}</text>`;
    return s + '</svg>';
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
