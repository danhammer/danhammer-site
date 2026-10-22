// Elevation profile on the Moon's globe. A small round button (bottom right) arms it; two clicks on the
// surface drop A and B, the great circle between them is drawn over the Moon, and the heights along it
// are plotted in a panel above the button. Pressing the button again clears both.
//
// Heights are real, not guessed from the picture: NASA Moon Trek's LOLA DEM (LRO laser altimetry,
// 128 ppd, served as 8-bit greyscale tiles to zoom 5, ~0.7 km per pixel at the equator). Grey 0..255 is
// a linear stretch over the Moon's whole range, so a step is ~78 m; samples are read bilinearly, which
// smooths the steps into slopes. Purely visual: nothing here is embedded.
import * as THREE from 'three';

const DEM = 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_LOLA_DEM_Global_128ppd_v04/1.0.0/default/default028mm/{z}/{y}/{x}.png';
const DEM_MAX_Z = 5;         // finest zoom the DEM is tiled to
const TILE_PX = 256;
const H_LO = -9.13, H_HI = 10.78;   // km above the 1737.4 km sphere at grey 0 and grey 255 (LOLA's full range)
const MOON_KM = 1737.4;
const WORLD = 10;            // must match globe.js: the Moon's radius in world units
const SAMPLES = 480;         // heights read along the line
const CHART_H = 128;
const PAD = { l: 40, r: 12, t: 10, b: 22 };
const NS = 'http://www.w3.org/2000/svg';
const RIDE_MS = 6000;        // A to B on level ground; slower uphill, faster down
const CHEER_MS = 1800;       // past B the rider pumps their arms this long, then the bike is back by A
const CHEER_HZ = 3.2;        // arm pumps per second
const ROLL_MS = 380;         // from its spot left of the origin along the axis to A
const CLIMB_MS = 550;        // then up to where the ground starts at A (and, at B, back down to the axis)

// A bike and rider facing +x, the wheels' contact point midway between them at the origin (SVG y down).
// Each wheel has one spoke that turns as it rolls.
const WHEEL_R = 2.6, WHEEL_X = 4.6;
const ARM_REST = 'M0.2,-11L3.6,-7.9';   // shoulder to handlebar
const BIKE = `
  <circle class="wheel" cx="${-WHEEL_X}" cy="${-WHEEL_R}" r="${WHEEL_R}"/>
  <circle class="wheel" cx="${WHEEL_X}" cy="${-WHEEL_R}" r="${WHEEL_R}"/>
  <path class="spoke" data-cx="${-WHEEL_X}" d="M${-WHEEL_X - WHEEL_R},${-WHEEL_R}h${2 * WHEEL_R}"/>
  <path class="spoke" data-cx="${WHEEL_X}" d="M${WHEEL_X - WHEEL_R},${-WHEEL_R}h${2 * WHEEL_R}"/>
  <path class="frame" d="M${-WHEEL_X},${-WHEEL_R}L-0.6,${-WHEEL_R}L3.2,-6.4L-1.8,-6.6Z M-0.6,${-WHEEL_R}L-2.1,-7.7 M3.2,-6.4L${WHEEL_X},${-WHEEL_R} M3.2,-6.4L3.6,-7.8"/>
  <path class="rider" d="M-2.1,-7.9L0.2,-11 M-2.1,-7.9L-0.2,-4.8L-0.6,${-WHEEL_R}"/>
  <path class="rider arm" d="${ARM_REST}"/>
  <circle class="head" cx="0.7" cy="-12.5" r="1.4"/>`;

// both arms raised, fists pumping: k in [0, 1] from fists low to fists high (null: hands on the bars)
function pump(g, k) {
  const d = k == null ? ARM_REST
    : `M0.2,-11L-1.6,${(-13.2 - 2.6 * k).toFixed(2)}M0.2,-11L2.4,${(-13.4 - 2.6 * k).toFixed(2)}`;
  for (const a of g.querySelectorAll('.arm')) a.setAttribute('d', d);
}

// turn each wheel's spoke to match `roll` px travelled
function spin(g, roll) {
  const deg = ((roll / WHEEL_R) * 180 / Math.PI) % 360;
  for (const sp of g.querySelectorAll('.spoke')) sp.setAttribute('transform', `rotate(${deg.toFixed(1)} ${sp.dataset.cx} ${-WHEEL_R})`);
}

const svgEl = (tag, attrs = {}, parent = null) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
};

// 1, 2 or 5 x 10^n: about `count` ticks over [lo, hi]
function ticks(lo, hi, count) {
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(6));
  return { step, values: out };
}

const fmtKm = (v, step) => `${v.toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0).replace('-', '−')}`;

// One decoded DEM tile per "z/x/y", as greyscale + validity, or null if it could not be read.
const tileCache = new Map();
function demTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!tileCache.has(key)) {
    tileCache.set(key, new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = cv.height = TILE_PX;
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        resolve(g.getImageData(0, 0, TILE_PX, TILE_PX).data);
      };
      img.onerror = () => { tileCache.delete(key); resolve(null); };
      img.src = DEM.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    }));
  }
  return tileCache.get(key);
}

const lonLat = (p) => [Math.atan2(p.x, p.z), Math.asin(THREE.MathUtils.clamp(p.y, -1, 1))];

export class Profile {
  // cloud: the Cloud; globe: its Globe; button: the round toggle; panel: the chart's box
  constructor(cloud, globe, { button, panel, hint }) {
    Object.assign(this, { cloud, globe, button, panel, hint });
    this.on = false;
    this.a = null; this.b = null;    // unit vectors on the sphere
    this.hover = null;               // unit vector under the pointer while placing B
    this.path = [];                  // unit vectors along the line
    this.heights = null;             // km, per path point (NaN where the DEM has no data)
    this.dist = null;                // km from A, per path point
    this.mark = null;                // index into path picked on the chart
    this.job = 0;
    this.ride = null;                // fractional index into path while the bike rides it
    this.roll = 0;                   // px the bike has rolled on the chart (turns its wheels)

    this.overlay = svgEl('svg', { class: 'profile-overlay', 'aria-hidden': 'true' }, document.body);
    this.lineHalo = svgEl('path', { class: 'pl-halo' }, this.overlay);
    this.line = svgEl('path', { class: 'pl-line' }, this.overlay);
    this.ends = ['A', 'B'].map((t) => {
      const g = svgEl('g', { class: 'pl-end' }, this.overlay);
      svgEl('circle', { r: 5 }, g);
      svgEl('text', { x: 9, y: -8 }, g).textContent = t;
      return g;
    });
    this.dot = svgEl('circle', { class: 'pl-mark', r: 4.5 }, this.overlay);
    this.bike = svgEl('g', { class: 'pl-bike' }, this.overlay);
    this.bike.innerHTML = `<g class="halo">${BIKE}</g><g class="body">${BIKE}</g>`;

    button.hidden = false;
    button.addEventListener('click', () => this.setOn(!this.on));
    cloud.surfaceCb = (x, y) => this.onClick(x, y);
    cloud.renderer.domElement.addEventListener('pointermove', (e) => {
      if (!this.on || !this.a || this.b || e.buttons) return;
      this.hover = this.surfaceAt(e.clientX, e.clientY);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.on) this.clear(); });
  }

  setOn(on) {
    this.on = on;
    this.button.setAttribute('aria-pressed', String(on));
    this.button.setAttribute('aria-label', on ? 'Close the elevation profile' : 'Elevation profile');
    if (on) document.body.dataset.measure = 'on'; else delete document.body.dataset.measure;
    this.clear();
  }

  clear() {
    this.a = this.b = this.hover = null;
    this.path = []; this.heights = null; this.mark = null; this.ride = null;
    this.job++;
    this.panel.hidden = true;
    this.panel.replaceChildren();
    this.say('Click two points on the Moon');
  }

  say(text) {
    this.hint.textContent = text || '';
    this.hint.hidden = !this.on || !text;
  }

  // the unit vector on the Moon under a screen point, or null (off the disc, or the globe not whole)
  surfaceAt(x, y) {
    if (!this.globe.whole) return null;
    const c = this.cloud;
    const ndc = new THREE.Vector2(x / window.innerWidth * 2 - 1, 1 - y / window.innerHeight * 2);
    c.raycaster.setFromCamera(ndc, c.camera);
    const hit = c.raycaster.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), WORLD), new THREE.Vector3());
    return hit ? hit.divideScalar(WORLD) : null;
  }

  // A click on the canvas: claimed (true) whenever the tool is on, so tiles don't open their neighbours.
  onClick(x, y) {
    if (!this.on) return false;
    const p = this.surfaceAt(x, y);
    if (!p) return true;
    if (!this.a || this.b) {          // first point, or a fresh line after a finished one
      this.clear();
      this.a = p;
      this.say('Click a second point');
    } else {
      this.b = p;
      this.hover = null;
      this.measure();
    }
    return true;
  }

  // points along the great circle from a to b
  arc(a, b, n) {
    const om = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)), s = Math.sin(om), out = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      if (s < 1e-6) { out.push(a.clone().lerp(b, t).normalize()); continue; }
      out.push(a.clone().multiplyScalar(Math.sin((1 - t) * om) / s).addScaledVector(b, Math.sin(t * om) / s));
    }
    return { pts: out, om };
  }

  async measure() {
    const job = ++this.job;
    this.ride = null;
    const { pts, om } = this.arc(this.a, this.b, SAMPLES);
    this.path = pts;
    this.dist = pts.map((_, i) => (i / (SAMPLES - 1)) * om * MOON_KM);
    this.say('');
    this.panel.hidden = false;
    this.panel.innerHTML = '<p class="profile-kicker">Elevation profile</p><p class="profile-wait">Reading LOLA heights…</p>';

    // the coarsest zoom that still puts two DEM pixels under every sample
    const z = THREE.MathUtils.clamp(Math.ceil(Math.log2((2 * SAMPLES * 2 * Math.PI) / (Math.max(om, 1e-4) * 2 * TILE_PX))), 0, DEM_MAX_Z);
    const W = TILE_PX * 2 ** (z + 1), H = TILE_PX * 2 ** z;
    const at = pts.map((p) => {
      const [lon, lat] = lonLat(p);
      return [(lon / Math.PI + 1) / 2 * W - 0.5, (Math.PI / 2 - lat) / Math.PI * H - 0.5];
    });
    const px = (x, y) => [((Math.floor(x) % W) + W) % W, THREE.MathUtils.clamp(Math.floor(y), 0, H - 1)];
    const need = new Set();
    for (const [fx, fy] of at) {
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const [x, y] = px(fx + dx, fy + dy);
        need.add(`${Math.floor(x / TILE_PX)}/${Math.floor(y / TILE_PX)}`);
      }
    }
    const tiles = new Map();
    await Promise.all([...need].map(async (k) => {
      const [x, y] = k.split('/').map(Number);
      tiles.set(k, await demTile(z, x, y));
    }));
    if (job !== this.job) return;

    const grey = (fx, fy) => {
      const [x, y] = px(fx, fy);
      const d = tiles.get(`${Math.floor(x / TILE_PX)}/${Math.floor(y / TILE_PX)}`);
      if (!d) return NaN;
      const o = ((y % TILE_PX) * TILE_PX + (x % TILE_PX)) * 4;
      return d[o + 3] < 128 ? NaN : d[o];
    };
    this.heights = at.map(([fx, fy]) => {
      const x0 = Math.floor(fx), y0 = Math.floor(fy), u = fx - x0, v = fy - y0;
      const g = (1 - u) * (1 - v) * grey(x0, y0) + u * (1 - v) * grey(x0 + 1, y0)
              + (1 - u) * v * grey(x0, y0 + 1) + u * v * grey(x0 + 1, y0 + 1);
      return H_LO + (g / 255) * (H_HI - H_LO);
    });
    if (this.heights.every(Number.isNaN)) {
      this.panel.innerHTML = '<p class="profile-kicker">Elevation profile</p><p class="profile-wait">The elevation tiles could not be reached.</p>';
      return;
    }
    this.chart();
  }

  chart() {
    const hs = this.heights, ds = this.dist, total = ds[ds.length - 1];
    const ok = hs.filter((h) => !Number.isNaN(h));
    const lo = Math.min(...ok), hi = Math.max(...ok);
    const panel = this.panel;
    panel.replaceChildren();
    const head = document.createElement('div');
    head.className = 'profile-head';
    head.innerHTML = '<p class="profile-kicker">Elevation profile</p><p class="profile-read"></p>';
    const stats = document.createElement('p');
    stats.className = 'profile-stats';
    const len = total < 10 ? total.toFixed(1) : Math.round(total).toLocaleString();
    stats.textContent = `${len} km · high ${fmtKm(hi, 0.1)} km · low ${fmtKm(lo, 0.1)} km · relief ${(hi - lo).toFixed(1)} km`;
    panel.append(head, stats);
    const read = head.querySelector('.profile-read');

    const w = panel.clientWidth - 2 * 14;
    const iw = w - PAD.l - PAD.r, ih = CHART_H - PAD.t - PAD.b;
    const span = Math.max(hi - lo, 0.2), pad = span * 0.08;
    const yt = ticks(lo - pad, hi + pad, 3), xt = ticks(0, total, 4);
    const y0 = Math.min(lo - pad, yt.values[0]), y1 = Math.max(hi + pad, yt.values[yt.values.length - 1]);
    const X = (d) => PAD.l + (d / total) * iw, Y = (h) => PAD.t + (1 - (h - y0) / (y1 - y0)) * ih;

    const svg = svgEl('svg', { class: 'profile-chart', width: w, height: CHART_H, viewBox: `0 0 ${w} ${CHART_H}`,
      role: 'img', 'aria-label': `Elevation along the line, ${len} km, from ${fmtKm(lo, 0.1)} to ${fmtKm(hi, 0.1)} km` });
    for (const v of yt.values) {
      if (v < y0 || v > y1) continue;
      svgEl('line', { class: 'pc-grid', x1: PAD.l, x2: PAD.l + iw, y1: Y(v), y2: Y(v) }, svg);
      svgEl('text', { class: 'pc-tick', x: PAD.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end' }, svg).textContent = fmtKm(v, yt.step);
    }
    // distance ticks between the ends, which are labelled A and B (none crowding B)
    for (const v of xt.values) {
      if (v === 0 || total - v < xt.step * 0.45) continue;
      svgEl('text', { class: 'pc-tick', x: X(v), y: CHART_H - 6, 'text-anchor': 'middle' }, svg).textContent = fmtKm(v, xt.step);
    }
    svgEl('text', { class: 'pc-end', x: PAD.l, y: CHART_H - 6, 'text-anchor': 'start' }, svg).textContent = 'A';
    svgEl('text', { class: 'pc-end', x: PAD.l + iw, y: CHART_H - 6, 'text-anchor': 'end' }, svg).textContent = 'B';
    svgEl('text', { class: 'pc-unit', x: PAD.l - 6, y: PAD.t - 1, 'text-anchor': 'end' }, svg).textContent = 'km';

    // the line and the ground under it, broken where the DEM has no data
    let line = '', area = '', run = [];
    const flush = () => {
      if (run.length > 1) {
        line += run.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
        area += `M${run[0][0].toFixed(1)},${(PAD.t + ih).toFixed(1)}` + run.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join('')
              + `L${run[run.length - 1][0].toFixed(1)},${(PAD.t + ih).toFixed(1)}Z`;
      }
      run = [];
    };
    hs.forEach((h, i) => { if (Number.isNaN(h)) flush(); else run.push([X(ds[i]), Y(h)]); });
    flush();
    svgEl('path', { class: 'pc-area', d: area }, svg);
    svgEl('line', { class: 'pc-base', x1: PAD.l, x2: PAD.l + iw, y1: PAD.t + ih, y2: PAD.t + ih }, svg);
    svgEl('path', { class: 'pc-line', d: line }, svg);
    const cross = svgEl('line', { class: 'pc-cross', y1: PAD.t, y2: PAD.t + ih }, svg);
    const knob = svgEl('circle', { class: 'pc-knob', r: 4 }, svg);
    const hit = svgEl('rect', { class: 'pc-hit', x: PAD.l, y: 0, width: iw, height: CHART_H }, svg);
    panel.append(svg);

    // vertical exaggeration: km per pixel across over km per pixel up
    const ve = (total / iw) / ((y1 - y0) / ih);
    const foot = document.createElement('p');
    foot.className = 'profile-foot';
    foot.textContent = `LRO LOLA elevation (NASA Moon Trek), above a ${MOON_KM} km sphere · vertical ×${ve >= 10 ? Math.round(ve) : ve.toFixed(1)}`;
    panel.append(foot);

    const show = (i) => {
      this.mark = i;
      const on = i != null && !Number.isNaN(hs[i]);
      cross.style.opacity = on ? 1 : 0;
      knob.style.opacity = on && this.ride == null ? 1 : 0;   // while riding, the bike is the marker
      if (!on) { read.textContent = ''; return; }
      cross.setAttribute('x1', X(ds[i])); cross.setAttribute('x2', X(ds[i]));
      knob.setAttribute('cx', X(ds[i])); knob.setAttribute('cy', Y(hs[i]));
      read.textContent = `${fmtKm(ds[i], total < 10 ? 0.1 : 1)} km · ${fmtKm(hs[i], 0.01)} km`;
    };
    hit.addEventListener('pointermove', (e) => {
      if (this.ride != null) return;
      const r = svg.getBoundingClientRect();
      const d = THREE.MathUtils.clamp((e.clientX - r.left - PAD.l) / iw, 0, 1) * total;
      show(Math.round((d / total) * (SAMPLES - 1)));
    });
    hit.addEventListener('pointerleave', () => { if (this.ride == null) show(null); });
    show(null);

    // The bike: parked on the axis by A. Clicked, it zooms up to where the ground starts, then rides the
    // profile to B, tilted to the slope, slower uphill and faster down, while its twin rides the line on
    // the Moon (step()).
    const N = hs.length;
    const hf = hs.slice();   // heights with the DEM's gaps filled from the nearest earlier (or first) value
    let last = ok[0];
    for (let i = 0; i < N; i++) { if (Number.isNaN(hf[i])) hf[i] = last; else last = hf[i]; }
    const at = (t) => {
      const i = Math.min(Math.floor(t), N - 2), f = t - i;
      return { x: X(ds[i] + (ds[i + 1] - ds[i]) * f), y: Y(hf[i] + (hf[i + 1] - hf[i]) * f) };
    };
    const bike = svgEl('g', { class: 'pc-bike', tabindex: 0, role: 'button', 'aria-label': 'Ride the profile from A to B' }, svg);
    svgEl('circle', { class: 'pc-bike-hit', cx: 0, cy: -6, r: 11 }, bike);
    const body = svgEl('g', {}, bike);
    body.innerHTML = BIKE;
    const place = (t) => {   // returns the slope on screen, degrees, positive downhill
      const p = at(t), a = at(Math.max(0, t - 3)), b = at(Math.min(N - 1, t + 3));
      const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      bike.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)}) rotate(${ang.toFixed(1)})`);
      spin(body, this.roll);
      return ang;
    };
    const base = PAD.t + ih;
    const parkX = (PAD.l - 14) / 2;   // midway between the panel's left edge (its 14 px padding) and the origin
    const cheerX = (PAD.l + iw + w + 14) / 2;   // midway between the axis's end and the panel's right edge
    const park = () => {
      bike.setAttribute('transform', `translate(${parkX},${base})`);
      spin(body, 0);
      pump(body, null);
      pump(this.bike, null);
    };
    this.roll = 0;
    park();
    const job = this.job, step = iw / (N - 1);   // chart px per sample
    const ride = () => {
      if (this.ride != null) return;
      this.ride = 0;
      this.roll = 0;
      bike.classList.add('is-riding');
      // along the axis to the origin, then up to the start of the ground, levelling off into its slope
      const top = at(0), a1 = at(3), lean = Math.atan2(a1.y - top.y, a1.x - top.x) * 180 / Math.PI;
      const t0 = performance.now();
      const climb = (now) => {
        if (job !== this.job) return;
        const r = Math.min(1, (now - t0) / ROLL_MS), er = r < 0.5 ? 2 * r * r : 1 - 2 * (1 - r) ** 2;
        const k = THREE.MathUtils.clamp((now - t0 - ROLL_MS) / CLIMB_MS, 0, 1), e = 1 - (1 - k) ** 3;   // out-cubic: a quick launch, eased landing
        const x = parkX + (PAD.l - parkX) * er, y = base + (top.y - base) * e;
        this.roll = (x - parkX) + (base - y);
        bike.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${(lean * e).toFixed(1)})`);
        spin(body, this.roll);
        if (k < 1) { requestAnimationFrame(climb); return; }
        prev = performance.now();
        requestAnimationFrame(frame);
      };
      let prev;
      const frame = (now) => {
        if (job !== this.job) return;
        const dt = Math.min(64, now - prev);
        prev = now;
        const ang = place(this.ride);
        const speed = (iw / RIDE_MS) * THREE.MathUtils.clamp(1 + ang / 45, 0.35, 2);   // px per ms along x
        const dx = speed * dt;
        this.roll += dx / Math.max(0.2, Math.cos(THREE.MathUtils.degToRad(ang)));
        this.ride = Math.min(N - 1, this.ride + dx / step);
        place(this.ride);
        show(Math.round(this.ride));
        if (this.ride < N - 1) { requestAnimationFrame(frame); return; }
        // at B: down to the axis, levelling off, and along it past the end, where the rider celebrates
        // (the twin, parked at B on the Moon, celebrates too); then the bike is back by A, ready to ride again
        const end = at(N - 1), e1 = at(N - 4), tilt = Math.atan2(end.y - e1.y, end.x - e1.x) * 180 / Math.PI;
        const roll0 = this.roll, d0 = performance.now();
        let c0;
        const descend = (t) => {
          if (job !== this.job) return;
          const k = Math.min(1, (t - d0) / CLIMB_MS), e = k * k * (3 - 2 * k);
          const r = THREE.MathUtils.clamp((t - d0 - CLIMB_MS) / ROLL_MS, 0, 1), er = r < 0.5 ? 2 * r * r : 1 - 2 * (1 - r) ** 2;
          const x = end.x + (cheerX - end.x) * er, y = end.y + (base - end.y) * e;
          this.roll = roll0 + Math.abs(y - end.y) + (x - end.x);
          bike.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${(tilt * (1 - e)).toFixed(1)})`);
          spin(body, this.roll);
          if (r < 1) { requestAnimationFrame(descend); return; }
          c0 = performance.now();
          requestAnimationFrame(cheer);
        };
        const cheer = (t) => {
          if (job !== this.job) return;
          const u = (t - c0) / CHEER_MS;
          if (u < 1) {
            const k = Math.abs(Math.sin(Math.PI * CHEER_HZ * (t - c0) / 1000));
            pump(body, k);
            pump(this.bike, k);
            requestAnimationFrame(cheer);
            return;
          }
          this.ride = null;
          this.roll = 0;
          bike.classList.remove('is-riding');
          park();
          show(null);
        };
        requestAnimationFrame(descend);
      };
      requestAnimationFrame(climb);
    };
    bike.addEventListener('click', ride);
    bike.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ride(); } });
  }

  // Each frame (from the cloud's loop): draw the line over the Moon where it faces the camera.
  step() {
    const whole = this.globe.whole;
    this.button.classList.toggle('is-away', !whole);
    this.panel.classList.toggle('is-away', !whole);
    const show = this.on && whole && this.a;
    this.overlay.style.display = show ? '' : 'none';
    if (!show) return;
    this.cloud.lastInteract = performance.now();   // no idle spin while measuring: the line would drift away
    const cam = this.cloud.camera.position, c = this.cloud;
    const front = (p) => p.dot(cam) > WORLD * 1.0005;   // on the near side of the horizon
    const scr = (p) => c.project(p.clone().multiplyScalar(WORLD));
    const b = this.b || this.hover;
    const pts = this.b ? this.path : b ? this.arc(this.a, b, 160).pts : [];
    let d = '', pen = false;
    for (const p of pts) {
      if (!front(p)) { pen = false; continue; }
      const s = scr(p);
      d += `${pen ? 'L' : 'M'}${s.x.toFixed(1)},${s.y.toFixed(1)}`;
      pen = true;
    }
    this.line.setAttribute('d', d);
    this.lineHalo.setAttribute('d', d);
    this.line.classList.toggle('is-preview', !this.b);
    [this.a, this.b].forEach((p, i) => {
      const g = this.ends[i], on = p && front(p);
      g.style.display = on ? '' : 'none';
      if (on) { const s = scr(p); g.setAttribute('transform', `translate(${s.x.toFixed(1)},${s.y.toFixed(1)})`); }
    });
    const m = this.mark != null && this.b && this.ride == null ? this.path[this.mark] : null;
    this.dot.style.display = m && front(m) ? '' : 'none';
    if (m && front(m)) { const s = scr(m); this.dot.setAttribute('cx', s.x); this.dot.setAttribute('cy', s.y); }
    // the bike's twin on the Moon, heading along the line (mirrored rather than upside down when it heads left)
    let riding = false;
    if (this.ride != null && this.b) {
      const P = this.path, N = P.length, i = Math.min(Math.floor(this.ride), N - 2);
      const p = P[i].clone().lerp(P[i + 1], this.ride - i).normalize();
      if (front(p)) {
        const s = scr(p), a = scr(P[Math.max(0, i - 2)]), b = scr(P[Math.min(N - 1, i + 3)]);
        const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
        const flip = Math.abs(ang) > 90 ? ' scale(1,-1)' : '';
        this.bike.setAttribute('transform', `translate(${s.x.toFixed(1)},${s.y.toFixed(1)}) rotate(${ang.toFixed(1)})${flip} scale(1.5)`);
        spin(this.bike, this.roll);
        riding = true;
      }
    }
    this.bike.style.display = riding ? '' : 'none';
  }
}
