/* Lumen outage timeline bar (CONTRACT-v2 E8): window.LumenTimeline. Plain script, no dependencies.
   stops[0] = notice, stops[1] = power off, stops[2] = power back. The track runs from the first to the last stop.
   setMode('run'): the bar is the guided run's clock, read-only, with a scene caption from set(iso, {caption}).
   setMode('replay') (the default): play button and draggable handle. The mode outlasts destroy/mount, so the run can set it first. */
(function () {
  'use strict';
  var HOUR = 36e5, SNAP_MS = 15 * 6e4, SNAP_PX = 8;
  var F = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  var WORD = { on: 'power on', off: 'power off', restored: 'power back on' };
  var S = null, MODE = 'replay';

  function parts(t) { var r = {}; F.formatToParts(t).forEach(function (p) { r[p.type] = p.value; }); return r; }
  function longText(t) { var p = parts(t); return p.weekday + ' ' + p.month + ' ' + p.day + ', ' + p.hour + ':' + p.minute + ' ' + p.dayPeriod; }
  function reduced() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function clampT(t) { return Math.min(S.t1, Math.max(S.t0, t)); }
  function frac(t) { return (t - S.t0) / (S.t1 - S.t0); }

  function stateAt(t) {
    var power = t < S.off ? 'on' : t < S.back ? 'off' : 'restored';
    // funnel ramps 0 -> 1 over the first 10% of the power-off window, then stays 1
    var funnel = power === 'on' ? 0 : Math.min(1, (t - S.off) / (0.1 * (S.back - S.off)));
    return { time: new Date(t).toISOString(), power: power, funnel: funnel };
  }

  function apply(t) {
    t = clampT(t);
    S.t = t;
    var st = stateAt(t), p = parts(t), txt = longText(t);
    S.root.style.setProperty('--p', frac(t));
    S.h.setAttribute('aria-valuenow', Math.round((t - S.t0) / HOUR * 100) / 100);
    S.h.setAttribute('aria-valuetext', txt + ' · ' + WORD[st.power]);
    S.time.innerHTML = p.weekday + '<span class="lt-dt"> ' + p.month + ' ' + p.day + ',</span> ' + p.hour + ':' + p.minute + ' ' + p.dayPeriod;
    if (st.power !== S.power) {
      S.power = st.power;
      S.root.dataset.power = st.power;
      S.pw.innerHTML = st.power === 'restored' ? 'Power back<span class="lt-on"> on</span>' : 'P' + WORD[st.power].slice(1);
      S.live.textContent = 'P' + WORD[st.power].slice(1) + ', ' + txt + '.';
    }
    if (S.onChange) S.onChange(st);
  }

  function setPlaying(on) {
    S.root.classList.toggle('playing', on);
    S.btn.setAttribute('aria-label', on ? 'Pause' : reduced() ? 'Go to the next stop' : 'Play the ' + S.label.toLowerCase());
  }

  function finish(ok) {
    if (!S || !S.done) return;
    cancelAnimationFrame(S.raf);
    var done = S.done;
    S.done = null;
    setPlaying(false);
    done(ok);
  }

  function play(o) {
    if (!S) return Promise.resolve(false);
    o = o || {};
    var to = o.to != null ? Date.parse(o.to) : S.t1;
    if (isNaN(to)) return Promise.resolve(false);
    to = clampT(to);
    finish(false);
    var from = S.t, ms = o.ms != null ? o.ms : Math.abs(to - from) / (S.t1 - S.t0) * 10000;
    if (reduced() || !(ms > 0)) { apply(to); return Promise.resolve(true); }
    setPlaying(true);
    return new Promise(function (resolve) {
      var start = null;
      S.done = resolve;
      function step(now) {
        if (start === null) start = now;
        var k = Math.min(1, (now - start) / ms);
        apply(from + (to - from) * (0.5 - Math.cos(Math.PI * k) / 2));  // ease in-out sine
        if (k < 1) S.raf = requestAnimationFrame(step); else finish(true);
      }
      S.raf = requestAnimationFrame(step);
    });
  }

  // The play button tells the story: run up to the shutoff, hold on the dark map, slow down while
  // patients move out, then run on to power back.
  function playStory() {
    if (S.t >= S.t1) apply(S.t0);
    var t = S.t, prev = S.t0, chain = Promise.resolve(true);
    [[S.off, 3000], [S.off, 700], [S.off + 0.1 * (S.back - S.off), 4000], [S.t1, 3500]].forEach(function (seg) {
      var end = seg[0], from = Math.max(t, prev);
      if (end >= t) {
        var ms = end === prev ? seg[1] : seg[1] * (end - from) / (end - prev);
        chain = chain.then(function (ok) { return ok && play({ to: new Date(end).toISOString(), ms: ms }); });
      }
      prev = end;
    });
  }

  function onButton() {
    if (S.done) return finish(false);
    if (!reduced()) return playStory();
    var next = S.stops.filter(function (s) { return s > S.t; })[0];
    apply(next != null ? next : S.t0);
    setPlaying(false);
  }

  function seek(e) {
    var r = S.rect, x = e.clientX - r.left, t = S.t0 + Math.max(0, Math.min(1, x / r.width)) * (S.t1 - S.t0);
    t = S.t0 + Math.round((t - S.t0) / SNAP_MS) * SNAP_MS;
    S.stops.forEach(function (s) { if (Math.abs(frac(s) * r.width - x) <= SNAP_PX) t = s; });
    if (t !== S.t) apply(t);
  }

  function onKey(e) {
    if (MODE === 'run') return;
    var d = { ArrowRight: HOUR, ArrowUp: HOUR, ArrowLeft: -HOUR, ArrowDown: -HOUR, PageUp: 6 * HOUR, PageDown: -6 * HOUR }[e.key];
    var t = d != null ? S.t + d : e.key === 'Home' ? S.t0 : e.key === 'End' ? S.t1 : null;
    if (t === null) return;
    e.preventDefault();
    finish(false);
    apply(t);
  }

  function mount(el, o) {
    var stops = (o.stops || []).map(function (s) { return Date.parse(s.t); });
    if (stops.length < 3 || stops.some(isNaN) || !(stops[0] < stops[1] && stops[1] < stops[2]))
      throw new Error('LumenTimeline needs three stops in time order: notice, power off, power back');
    if (S) destroy();
    var label = o.label || 'Simulated outage';
    var root = document.createElement('div');
    root.className = 'lt';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', label);
    root.innerHTML =
      '<button class="btn sec ico sm lt-btn" type="button">' +
        '<svg class="i fill lt-ip" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5l8 4.5-8 4.5z"/></svg>' +
        '<svg class="i lt-ipa" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5v9M10.5 3.5v9"/></svg></button>' +
      '<div class="lt-hd"><span class="lt-lb"></span><span class="lt-cap"></span><span class="lt-rd"><span class="lt-t m"></span><span class="lt-pw"></span></span></div>' +
      '<div class="lt-tr"><div class="lt-in">' +
        '<div class="lt-ln"><i class="lt-base"></i><i class="lt-off"></i><i class="lt-fill"></i></div>' +
        '<div class="lt-h" role="slider" tabindex="0"></div>' +
        '<div class="lt-stops"></div></div></div>' +
      '<span class="vh" aria-live="polite"></span>';
    root.querySelector('.lt-lb').textContent = label;
    var t0 = stops[0], t1 = stops[stops.length - 1];
    S = { root: root, label: label, stops: stops, t0: t0, t1: t1, off: stops[1], back: stops[2], t: t0, power: null,
      onChange: null, done: null, raf: 0, rect: null, btn: root.querySelector('.lt-btn'), h: root.querySelector('.lt-h'),
      time: root.querySelector('.lt-t'), cap: root.querySelector('.lt-cap'), pw: root.querySelector('.lt-pw'), live: root.querySelector('.vh') };
    var ln = root.querySelector('.lt-ln'), stopsEl = root.querySelector('.lt-stops'), tr = root.querySelector('.lt-tr');
    root.style.setProperty('--off0', frac(S.off));
    root.style.setProperty('--off1', frac(S.back));
    stops.forEach(function (s, i) {
      var p = parts(s), tick = document.createElement('i'), lab = document.createElement('span');
      tick.className = 'lt-tk';
      tick.style.left = frac(s) * 100 + '%';
      ln.appendChild(tick);
      lab.className = 'lt-sl' + (i === 0 ? ' first' : i === stops.length - 1 ? ' last' : '');
      lab.style.left = frac(s) * 100 + '%';
      lab.title = longText(s) + ' · ' + (o.stops[i].label || '');
      lab.innerHTML = '<span class="lt-st m">' + p.weekday + ' ' + p.hour + (p.minute === '00' ? '<span class="lt-mm">:00</span>' : ':' + p.minute) + ' ' + p.dayPeriod + ' </span><b></b>';
      lab.querySelector('b').textContent = o.stops[i].label || '';
      stopsEl.appendChild(lab);
    });
    S.h.setAttribute('aria-label', label + ' time');
    S.h.setAttribute('aria-valuemin', '0');
    S.h.setAttribute('aria-valuemax', String(Math.round((t1 - t0) / HOUR * 100) / 100));

    S.btn.addEventListener('click', onButton);
    S.h.addEventListener('keydown', onKey);
    tr.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || MODE === 'run') return;
      e.preventDefault();  // no text selection, no native focus jump
      finish(false);
      tr.setPointerCapture(e.pointerId);
      S.rect = ln.getBoundingClientRect();
      root.classList.add('drag');
      S.h.focus({ preventScroll: true });
      if (e.target !== S.h) seek(e);  // grabbing the handle itself must not nudge it
    });
    tr.addEventListener('pointermove', function (e) { if (root.classList.contains('drag')) seek(e); });
    tr.addEventListener('lostpointercapture', function () { root.classList.remove('drag'); });

    el.appendChild(root);
    apply(t0);  // paint the first state before the caller's onChange is attached: mounting is not a change
    S.onChange = o.onChange || null;
    setPlaying(false);
    setMode(MODE);
  }

  function setMode(m) {
    MODE = m === 'run' ? 'run' : 'replay';
    if (!S) return;
    if (MODE === 'run') finish(false);  // the run owns the clock: stop a replay the user started
    S.root.classList.toggle('run', MODE === 'run');
    S.h.setAttribute('aria-readonly', String(MODE === 'run'));
  }

  // set(iso) moves the clock; set(null, {caption}) only changes the caption.
  function set(iso, o) {
    if (!S) return;
    var t = Date.parse(iso), c = o && o.caption;
    if (!isNaN(t)) { finish(false); apply(t); }
    if (c != null && c !== S.cap.textContent) {
      S.cap.textContent = c;
      if (c) S.live.textContent = c + '.';
    }
  }

  function destroy() {
    if (!S) return;
    finish(false);
    S.root.remove();
    S = null;
  }

  window.LumenTimeline = {
    mount: mount,
    set: set,
    setMode: setMode,
    play: play,
    pause: function () { finish(false); },
    destroy: destroy
  };
})();
