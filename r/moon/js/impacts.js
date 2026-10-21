// Landings and impacts on the Moon, 1966 to now. A small round button (bottom right, beside the elevation
// profile's) opens a timeline in the bottom left. Drag along it: as the present passes each landing date,
// its point on the timeline lights up and so does the site on the globe, with a ring for a soft landing
// or a burst for a crash (on the globe only when that side faces you; the globe itself never moves). The
// small point at the timeline's right end shows every site at once. Click a lit site on the globe, or a
// point on the timeline, for that landing's card: mission, outcome, when, where, country, operator.
// Pressing the button again clears it all.
//
// The sites are MoonSnag's Mission Watch list (moonsnag.com/landing-sites), fetched at build time into
// data/impacts.json by scripts/fetch_moon_impacts.py in the embeddings-gemma-exploration repo (the site
// sends no CORS headers, so the page cannot read it live). Purely visual: nothing here is embedded.
import * as THREE from 'three';
import { sphereXYZ } from './sphere.js';

const WORLD = 10;            // must match globe.js: the Moon's radius in world units
const RING_MS = 1300;        // a site's ring (or burst) expands and fades over this long as it is passed
const LABEL_MS = 2600;       // the site just passed is named on the globe this long
const NS = 'http://www.w3.org/2000/svg';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const svgEl = (tag, attrs = {}, parent = null) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
};
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// "1969-07-20" -> 1969.55
function yearOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  const t0 = Date.UTC(y, 0, 1), t1 = Date.UTC(y + 1, 0, 1);
  return y + (Date.UTC(y, m - 1, d) - t0) / (t1 - t0);
}
const fmtDate = (date) => { const [y, m, d] = date.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
// "1969-07-20 20:17 UTC" -> "20 Jul 1969, 20:17 UTC"
const fmtTime = (stamp) => { const [d, t] = stamp.split(' '); return t ? `${fmtDate(d)}, ${t} UTC` : fmtDate(d); };
const fmtCoord = (lat, lon) => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;

// eight rays around a crash, as one path (unit length; scaled per frame)
const RAYS = Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * Math.PI * 2 + 0.2;
  return `M${(Math.cos(a) * 0.45).toFixed(3)},${(Math.sin(a) * 0.45).toFixed(3)}L${Math.cos(a).toFixed(3)},${Math.sin(a).toFixed(3)}`;
}).join('');

export class Impacts {
  // cloud: the Cloud; globe: its Globe; button: the round toggle; panel: the timeline's box
  constructor(cloud, globe, { button, panel }) {
    Object.assign(this, { cloud, globe, button, panel });
    this.on = false;
    this.sites = null;           // [{mission, date, year, kind, p (unit vector), g (overlay group), mark, born}]
    this.t = 0;                  // the timeline's present, as a fractional year
    this.newest = null;          // the site just passed, named on the globe for a moment
    this.hover = null;           // the site under the pointer
    this.picked = null;          // the site whose card is open

    this.overlay = svgEl('svg', { class: 'impact-overlay', 'aria-hidden': 'true' }, document.body);
    this.sitesLayer = svgEl('g', {}, this.overlay);
    this.label = svgEl('text', { class: 'im-label' }, this.overlay);
    this.card = el('aside', 'im-card');
    this.card.hidden = true;
    this.card.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.card);

    button.hidden = false;
    button.addEventListener('click', () => this.setOn(!this.on));
    cloud.renderer.domElement.addEventListener('pointerleave', () => { this.hover = null; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.picked) this.pick(null); });
  }

  async setOn(on) {
    this.on = on;
    this.button.setAttribute('aria-pressed', String(on));
    this.button.setAttribute('aria-label', on ? 'Close the landings timeline' : 'Landings and impacts timeline');
    if (!on) {
      this.panel.hidden = true;
      this.pick(null);
      this.newest = this.hover = null;
      if (this.sites) this.seek(this.start);   // nothing lit next time it opens
      return;
    }
    this.panel.hidden = false;
    if (!this.sites) {
      this.panel.replaceChildren(el('p', 'im-wait', 'Loading the landing sites…'));
      try {
        await this.load();
      } catch (err) {
        console.error('landing sites failed to load', err);
        this.panel.replaceChildren(el('p', 'im-wait', 'The landing sites could not be loaded.'));
        return;
      }
      if (!this.on) return;
      this.build();
    }
  }

  async load() {
    const res = await fetch('data/impacts.json');
    if (!res.ok) throw new Error(`data/impacts.json: HTTP ${res.status}`);
    const data = await res.json();
    this.sites = data.sites.map((s) => {
      const p = sphereXYZ(THREE.MathUtils.degToRad(s.lon), THREE.MathUtils.degToRad(s.lat));
      const g = svgEl('g', { class: `im-site im-site--${s.kind}` }, this.sitesLayer);
      const ring = svgEl('circle', { class: 'im-ring', r: 0 }, g);
      const rays = s.kind === 'crash' ? svgEl('path', { class: 'im-rays', d: RAYS }, g) : null;
      svgEl('circle', { class: 'im-dot', r: s.kind === 'crash' ? 3.4 : 3 }, g);
      g.style.display = 'none';
      return { ...s, year: yearOf(s.date), p, g, ring, rays, born: -Infinity };
    });
    this.start = Math.floor(this.sites[0].year);
    this.end = Math.max(...this.sites.map((s) => s.year)) + 0.5;
  }

  // the panel: the legend, the timeline, and the point that shows every site
  build() {
    const p = this.panel;
    p.replaceChildren();
    const legend = el('p', 'im-legend');
    legend.innerHTML = '<span class="im-key im-key--landed">Landed</span><span class="im-key im-key--crash">Crashed</span>';
    const row = el('div', 'im-row');

    const W = 340, H = 50, X0 = 7, X1 = W - 27, AX = 29;   // the present's year above the axis at y = AX, decades
    // below; past its end, at X1 + 18, the point that shows every site
    this.X = (y) => X0 + ((y - this.start) / (this.end - this.start)) * (X1 - X0);
    const svg = svgEl('svg', { class: 'im-axis', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'slider',
      tabindex: 0, 'aria-label': 'Timeline of Moon landings: drag to move through it',
      'aria-valuemin': this.start, 'aria-valuemax': Math.round(this.end) });
    svgEl('rect', { class: 'im-grab', x: 0, y: 0, width: W, height: H }, svg);   // the whole strip takes the drag
    svgEl('line', { class: 'im-base', x1: X0, x2: X1, y1: AX, y2: AX }, svg);
    for (let y = Math.ceil(this.start / 10) * 10; y <= this.end; y += 10) {
      svgEl('line', { class: 'im-tick', x1: this.X(y), x2: this.X(y), y1: AX + 3, y2: AX + 6 }, svg);
      svgEl('text', { class: 'im-year', x: this.X(y), y: H - 2, 'text-anchor': 'middle' }, svg).textContent = y;
    }
    this.fill = svgEl('line', { class: 'im-past', x1: X0, x2: X0, y1: AX, y2: AX }, svg);
    for (const s of this.sites) {
      s.mark = svgEl('circle', { class: `im-mark im-mark--${s.kind}`, cx: this.X(s.year).toFixed(1), cy: AX, r: 2.6 }, svg);
      svgEl('title', {}, s.mark).textContent = `${s.mission} · ${fmtDate(s.date)}`;
    }
    this.head = svgEl('line', { class: 'im-head-line', y1: AX - 8, y2: AX + 8 }, svg);
    this.yearText = svgEl('text', { class: 'im-now', y: AX - 12, 'text-anchor': 'middle' }, svg);
    // scrub: press anywhere on the strip and drag; a press on a site's point opens its card there
    const at = (e) => {
      const r = svg.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
    };
    const seekAt = (e) => {
      const [x] = at(e);
      this.seek(this.start + THREE.MathUtils.clamp((x - X0) / (X1 - X0), 0, 1) * (this.end - this.start));
    };
    svg.addEventListener('pointerdown', (e) => {
      // the nearest point within a few px of the press (they crowd in 1969-72)
      const [x, y] = at(e);
      let s = null, bd = 4.5;
      if (Math.abs(y - AX) < 7) for (const o of this.sites) { const d = Math.abs(this.X(o.year) - x); if (d < bd) { bd = d; s = o; } }
      if (s) { this.seek(Math.max(this.t, s.year)); this.pick(s); return; }
      if (e.target === this.allBtn) return;
      svg.setPointerCapture(e.pointerId);
      seekAt(e);
    });
    svg.addEventListener('pointermove', (e) => { if (e.buttons) seekAt(e); });
    svg.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: -1, ArrowRight: 1, PageDown: -10, PageUp: 10 }[e.key];
      if (d == null) return;
      e.preventDefault();
      this.seek(THREE.MathUtils.clamp(this.t + d, this.start, this.end));
    });
    this.axis = svg;

    // the small point past the end: every site at once
    this.allBtn = svgEl('circle', { class: 'im-all', cx: X1 + 18, cy: AX, r: 5.5, tabindex: 0, role: 'button',
      'aria-label': 'Show every landing site at once' }, svg);
    svgEl('title', {}, this.allBtn).textContent = 'Show every site';
    this.allBtn.addEventListener('click', () => this.showAll());
    this.allBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.showAll(); } });

    row.append(svg);
    p.append(legend, row);
    this.seek(this.start);
  }

  // Move the present to year t. Sites passed on the way forward ring on the globe and flash on the
  // timeline; going back, sites after t go dark. The last site at or before t stays highlighted.
  seek(t) {
    const now = performance.now(), t0 = this.t;
    this.t = t;
    for (const s of this.sites) {
      if (s.year > t) { s.born = -Infinity; continue; }
      if (s.year > t0 || s.born === -Infinity) {
        s.born = s.year > t0 ? now : 0;   // just passed: its ring now; already behind (e.g. after a jump back): lit, no ring
        if (s.year > t0) { this.newest = s; this.flash(s); }
      }
    }
    const past = this.sites.filter((s) => s.year <= t);
    this.current = past[past.length - 1] || null;
    if (this.newest && this.newest.year > t) this.newest = null;
    if (this.picked && this.picked.year > t) this.pick(null);   // scrubbed back before it
    this.drawAxis();
  }

  // the site's point on the timeline swells for a moment as the present passes it
  flash(s) {
    s.mark.classList.remove('is-hit');
    void s.mark.getBoundingClientRect();   // restart the animation
    s.mark.classList.add('is-hit');
  }

  // every site at once, each with its ring
  showAll() {
    this.t = this.end;
    const now = performance.now();
    this.sites.forEach((s, i) => { s.born = now + (i % 7) * 40; this.flash(s); });   // a ripple, not one flash
    this.newest = this.current = null;
    this.drawAxis();
  }

  // Open the card for site s (null closes it): what it was, how it ended, when, where and whose.
  pick(s) {
    for (const x of this.sites || []) x.g.classList.toggle('is-picked', x === s);
    this.picked = s;
    this.card.hidden = !s;
    if (!s) { this.card.replaceChildren(); return; }
    const c = this.card;
    c.replaceChildren();
    c.style.setProperty('--kind', s.kind === 'crash' ? 'var(--alert)' : 'var(--ink)');
    const close = el('button', 'im-card-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.pick(null));
    c.append(close, el('p', `im-card-kind im-card-kind--${s.kind}`, s.outcome), el('h3', 'im-card-title', s.mission));
    const dl = el('dl', 'im-card-facts');
    const row = (k, v) => { if (v) dl.append(el('dt', null, k), el('dd', null, v)); };
    row(s.kind === 'crash' ? 'Impact' : 'Landed', s.landing ? fmtTime(s.landing) : fmtDate(s.date));
    row('Site', s.site);
    row('Where', fmtCoord(s.lat, s.lon));
    row('Country', s.country);
    row('Operator', s.operator);
    row('Type', s.type && s.type[0].toUpperCase() + s.type.slice(1));
    row('Launched', s.launch && fmtDate(s.launch.split(' ')[0]));
    c.append(dl);
  }

  // A click on the globe while the timeline is open: a lit site opens its card (true: claimed); anywhere
  // else closes an open card (also claimed, so the tile under it does not open), or is left alone.
  click(x, y) {
    if (!this.on || !this.sites) return false;
    const s = this.hoverAt(x, y);
    if (s) { this.pick(s); return true; }
    if (this.picked) { this.pick(null); return true; }
    return false;
  }

  drawAxis() {
    if (!this.axis) return;
    const x = this.X(Math.min(this.t, this.end));
    this.head.setAttribute('x1', x); this.head.setAttribute('x2', x);
    this.fill.setAttribute('x2', x);
    for (const s of this.sites) {
      s.mark.classList.toggle('is-past', s.year <= this.t);
      s.mark.classList.toggle('is-current', s === this.current);
    }
    this.yearText.textContent = Math.floor(Math.min(this.t, this.end - 0.5));
    this.yearText.setAttribute('x', x);
    this.axis.setAttribute('aria-valuenow', Math.floor(this.t));
    this.axis.setAttribute('aria-valuetext', this.current ? `${this.current.mission}, ${fmtDate(this.current.date)}` : String(Math.floor(this.t)));
    this.allBtn.classList.toggle('is-on', this.t >= this.end);
  }

  // the lit site under a screen point, or null (the page asks, before naming the tile there)
  hoverAt(x, y) {
    if (!this.on) return (this.hover = null);
    let best = null, bd = 12;
    for (const s of this.sites || []) {
      if (s.g.style.display === 'none' || !s.screen) continue;
      const d = Math.hypot(s.screen.x - x, s.screen.y - y);
      if (d < bd) { bd = d; best = s; }
    }
    return (this.hover = best);
  }

  // Each frame (from the cloud's loop): draw the lit sites that face the camera, and their rings.
  step() {
    const whole = this.globe.whole;
    this.button.classList.toggle('is-away', !whole);
    this.panel.classList.toggle('is-away', !whole);
    const show = this.on && whole && this.sites;
    this.overlay.style.display = show ? '' : 'none';
    this.card.style.visibility = show ? '' : 'hidden';
    if (!show) return;
    const now = performance.now(), c = this.cloud, cam = c.camera.position;
    c.lastInteract = now;   // no idle spin while the timeline is open: the sites hold still to be clicked
    c.controls.autoRotate = false;
    const front = (p) => p.dot(cam) > WORLD * 1.0005;
    for (const s of this.sites) {
      const lit = s.year <= this.t && s.born !== -Infinity && now >= s.born;
      const on = lit && front(s.p);
      s.g.style.display = on ? '' : 'none';
      s.screen = null;
      if (!on) continue;
      const q = c.project(s.p.clone().multiplyScalar(WORLD));
      s.screen = q;
      s.g.setAttribute('transform', `translate(${q.x.toFixed(1)},${q.y.toFixed(1)})`);
      const k = Math.min(1, (now - s.born) / RING_MS);
      const big = s.kind === 'crash' ? 26 : 16;
      s.ring.setAttribute('r', (3 + (big - 3) * (1 - (1 - k) ** 3)).toFixed(1));
      s.ring.style.opacity = k < 1 ? (1 - k).toFixed(3) : 0;
      if (s.rays) {
        const rk = Math.min(1, k * 1.6);
        s.rays.setAttribute('transform', `scale(${(6 + 16 * (1 - (1 - rk) ** 2)).toFixed(1)})`);
        s.rays.style.opacity = rk < 1 ? (1 - rk).toFixed(3) : 0;
      }
    }

    // the open card: beside its site while that faces the camera, else above its point on the timeline
    if (this.picked) {
      const s = this.picked, r = this.card.getBoundingClientRect();
      let x, y;
      if (s.screen) { x = s.screen.x + 16; y = s.screen.y - r.height / 2; if (x + r.width > window.innerWidth - 12) x = s.screen.x - 16 - r.width; }
      else { const m = s.mark.getBoundingClientRect(); x = m.left + m.width / 2 - r.width / 2; y = this.panel.getBoundingClientRect().top - r.height - 10; }
      x = THREE.MathUtils.clamp(x, 12, window.innerWidth - r.width - 12);
      y = THREE.MathUtils.clamp(y, 12, window.innerHeight - r.height - 12);
      this.card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }

    // a name on the globe: the site under the pointer, else the one just passed, for a moment
    const named = this.hover || (this.newest && now - this.newest.born < LABEL_MS ? this.newest : null);
    if (named && named === this.picked) { this.label.style.display = 'none'; return; }   // its card names it
    if (named && named.screen) {
      this.label.textContent = `${named.mission} · ${named.date.slice(0, 4)}`;
      this.label.setAttribute('x', (named.screen.x + 10).toFixed(1));
      this.label.setAttribute('y', (named.screen.y - 9).toFixed(1));
      this.label.style.display = '';
      this.label.style.opacity = named === this.hover ? 1 : Math.min(1, (LABEL_MS - (now - named.born)) / 500).toFixed(3);
    } else {
      this.label.style.display = 'none';
    }
  }
}
