// The Moon in embedding space: load the bundle, show the globe, and lay out a search (or a clicked
// tile's neighbours) as fly-in -> lines -> wall. Everything is static: the neighbours of every tile and
// the answers to the preset searches were computed ahead of time with EmbeddingGemma 2
// (scripts/export_moon_site.py in the embeddings-gemma-exploration repo).
import { Cloud } from './cloud.js';
import { Wall } from './wall.js';
import { Tip } from './tip.js';
import { Globe } from './globe.js';
import { Profile } from './profile.js';
import { tween, cancelExcept, ease } from './anim.js';

const FLY_MS = 900;
const LINE_MS = 300;
const LINE_STAGGER_MS = 60;
const DIM_TO = 0.22;

const $ = (id) => document.getElementById(id);
const picker = $('q');

const state = { phase: 'idle', run: 0 };
let cloud, wall, tip, globe, searches, neighbors;

function setPhase(p) {
  state.phase = p;
  document.body.dataset.phase = p;
}

async function loadBundle() {
  const files = ['items.json', 'points.bin', 'meta.json', 'neighbors.json', 'searches.json'];
  const res = await Promise.all(files.map((f) => fetch(`data/${f}`)));
  for (const r of res) if (!r.ok) throw new Error(`${r.url}: HTTP ${r.status}`);
  const [items, buf, meta, near, presets] = await Promise.all(res.map((r, i) => (i === 1 ? r.arrayBuffer() : r.json())));
  const n = items.length;
  if (buf.byteLength !== n * 15) throw new Error(`points.bin has ${buf.byteLength} bytes, expected ${n * 15}`);
  return { items, meta, near, presets, xyz: new Float32Array(buf, 0, n * 3), rgb: new Uint8Array(buf, n * 12, n * 3) };
}

// a stored answer ({position, neighbors: [[index, similarity]], weak}) as the result the display expects
function result(stored, extra) {
  return {
    ...extra,
    position: stored.position,
    weak: stored.weak,
    neighbors: stored.neighbors.map(([index, similarity], r) => ({ index, similarity, rank: r + 1 })),
  };
}

function lineOpacity(sim, lo, hi) {
  if (hi - lo < 1e-6) return 1;
  return 0.35 + 0.65 * (sim - lo) / (hi - lo);
}

async function runQuery(res, run) {
  cancelExcept(run);
  cloud.clearResult();
  wall.hide();
  setPulsed(null);
  // on the globe: break it up into embedding space first
  if (globe.active && !(await globe.morph(1, run))) return;
  syncGlobeToggle();
  await cloud.ensure3d();   // a query from the flat map first rounds it back into the cloud
  if (run !== state.run) return;
  cloud.mode = 'result';

  const { neighbors: near } = res;
  near.forEach((n) => cloud.preload(n.index));
  const q = cloud.showQuery(res.position);
  const pts = [q, ...near.map((n) => cloud.worldPos(n.index))];
  const d0 = cloud.uniforms.uDim.value;
  if (d0 < 1) tween(300, (e) => cloud.setDim(d0 + (1 - d0) * e), { run });

  setPhase('flying');
  if (!(await cloud.flyTo(pts, wall.panelWidth() / 2, FLY_MS, run))) return;

  setPhase('lines');
  cloud.lastResult = near;
  cloud.arrange(near);
  const sims = near.map((n) => n.similarity);
  const lo = Math.min(...sims), hi = Math.max(...sims);
  tween(LINE_STAGGER_MS * (near.length - 1) + LINE_MS, (e) => cloud.setDim(1 - (1 - DIM_TO) * e),
    { run, easing: ease.inOutCubic });
  const grows = near.map((n, i) => {
    const rec = cloud.addLine(n, lineOpacity(n.similarity, lo, hi), cloud.items[n.index].color);
    return cloud.growLine(rec, LINE_MS, i * LINE_STAGGER_MS, run);
  });
  const done = await Promise.all(grows);
  if (done.some((d) => !d) || run !== state.run) return;

  wall.render(res);
  wall.show();
  setPhase('wall');
}

function show(res) {
  const run = ++state.run;
  runQuery(res, run).catch((err) => console.error('display failed', err));
}

function setPulsed(index) {
  cloud.pulse(index);
  wall.mark(index);
}

function closeWall() {
  const run = ++state.run;
  cancelExcept(run);
  wall.hide();
  setPulsed(null);
  setPhase('idle');
  picker.value = '';
  cloud.reset(run);
}

function syncGlobeToggle() {
  const onGlobe = globe.t < 1;
  $('globe-toggle').setAttribute('aria-pressed', String(!onGlobe));   // pressed = in embedding space
  $('globe-toggle').disabled = globe.busy;
  document.body.dataset.globe = onGlobe ? 'on' : 'off';
}

async function toggleGlobe() {
  if (globe.busy) return;
  const run = ++state.run;
  cancelExcept(run);
  const to = globe.t < 1 ? 1 : 0;
  if (to === 0) {   // leave any hung result and the flat map before gathering the tiles back
    wall.hide();
    setPulsed(null);
    picker.value = '';
    cloud.clearResult();
    cloud.setDim(1);
    await cloud.ensure3d();
    setPhase('idle');
  }
  const p = globe.morph(to, run);
  syncGlobeToggle();
  await p;
  syncGlobeToggle();
}

async function main() {
  let bundle;
  try {
    bundle = await loadBundle();
  } catch (err) {
    $('loading').textContent = `Could not load the Moon: ${err.message}`;
    $('loading').classList.add('is-error');
    throw err;
  }
  const { items, meta, xyz, rgb } = bundle;
  searches = bundle.presets;
  neighbors = bundle.near;
  cloud = new Cloud($('stage'), { xyz, rgb, items });
  wall = new Wall({ items, onHover: (i) => setPulsed(i), onClose: closeWall });
  cloud.hoverCb = (i) => { if (state.phase === 'wall') setPulsed(i); };
  tip = new Tip(items, $('dot-tip'));
  globe = new Globe(cloud, meta.globe);
  globe.showWhole();
  cloud.lift = -40;                // the search is a header here: sit the Moon a little below centre
  cloud.applyShift();
  cloud.profile = new Profile(cloud, globe, { button: $('profile-toggle'), panel: $('profile'), hint: $('profile-hint') });
  $('globe-toggle').addEventListener('click', toggleGlobe);

  // a tile on the globe or its point in embedding space: its neighbourhood opens in the side panel
  // (from the globe it breaks up into embedding space first)
  cloud.clickCb = (i) => {
    tip.show(null);
    show(result(neighbors[i], { item: i }));
  };
  // a name tag under the pointer (none while the elevation profile is being drawn)
  cloud.tipCb = (i, x, y) => tip.show(cloud.profile.on ? null : i, x, y);

  for (const s of searches) picker.add(new Option(s.query, s.query));
  picker.addEventListener('change', () => {
    const s = searches.find((x) => x.query === picker.value);
    if (s) show(result(s, { query: s.query }));
  });

  syncGlobeToggle();
  setPhase('idle');
  await cloud.ready;
  // wait for the globe's picture, then two frames so it is drawn under the veil
  await globe.ready;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  $('loading').classList.add('is-done');
}

main();
