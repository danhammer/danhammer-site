// Streamed basemap for the Moon's globe: as you zoom in, sharper tiles are fetched from CORS-enabled
// tile servers and laid over the globe's skin as curved patches on the sphere. The skin (the atlas)
// stays underneath as the fallback, and is all that shows when zoomed out, offline, or while a tile
// is still on its way. Only drawn on the whole, still globe: the explosion
// into embedding space is carried by the facets alone. Purely visual: nothing here is embedded.
//
// Detail is counted in "levels": level L puts 256 * 2^L pixels around the equator, which is web
// mercator's zoom L and an equirectangular (2:1) grid's zoom L - 1. Each level comes from one source:
//   5-6   OpenPlanetaryMap's LOLA hillshade + albedo (the same imagery as the atlas), via geolibre
//   7-11  Kaguya Terrain Camera orthomosaic (JAXA/SELENE) via NASA Moon Trek, to ~20 m per pixel,
//         within 60 deg of the equator (feathered out from 55): nearer the poles that mosaic is blown
//         out, black or seamed, so there the finest view is OPM's level 6
import * as THREE from 'three';
import { POLE_DEG, mercLat, mercRow, SPHERE_GLSL } from './sphere.js';

const SOURCES = [
  { // web mercator, TMS rows (row 0 at the south edge)
    url: 'https://tiles.geolibre.app/opm/moon-hillshaded-albedo/{z}/{x}/{y}.png',
    grid: 'mercator', tms: true, levels: [5, 6],
  },
  { // equirectangular WMTS, rows from the north edge; 2 x 1 tiles at its zoom 0
    url: 'https://trek.nasa.gov/tiles/Moon/EQ/Kaguya_TCortho_Mosaic_Global_4096ppd/1.0.0/default/default028mm/{z}/{y}/{x}.png',
    grid: 'equirect', levels: [7, 11], fadeLat: [55, 60],
  },
];
const TILE_PX = 256;
const POLE = THREE.MathUtils.degToRad(POLE_DEG);
const SEG = 12;             // patch subdivisions per edge, so it follows the sphere
const MAX_LOADS = 8;        // concurrent requests
const MAX_VISIBLE = 360;    // drop a level rather than draw more than this many tiles
const CACHE = 480;          // tiles kept on the GPU (~170 MB with mipmaps); least recently seen go first
const FADE_MS = 500;        // tiles fade in slowly: sharpening reads as focus, not a switch
const SETTLE_MS = 300;      // after the globe comes back whole, stay still this long before streaming
const CHECK_MS = 120;

const VERT = /* glsl */`
  ${SPHERE_GLSL}
  uniform vec4 uBox;        // west, east, north, south: longitude in radians, and latitude (or mercator rows)
  uniform float uMerc, uR;  // uMerc 1: the north/south of uBox are mercator rows in [0, 1] from the north
  varying vec2 vUv;
  varying float vShade;
  varying float vLat;
  void main() {
    float lon = mix(uBox.x, uBox.y, uv.x);
    float t = mix(uBox.w, uBox.z, uv.y);                    // uv.y = 1 at the tile's north edge
    float lat = uMerc > 0.5 ? mercLat(t) : t;
    vec3 n = sphere(lon, lat);
    vec3 p = n * uR;
    vUv = uv;
    vLat = abs(lat);
    vShade = shade(n, p);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;

const FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform float uA;
  uniform vec2 uFade;       // |latitude| (radians) over which the source fades out toward the poles
  varying vec2 vUv;
  varying float vShade;
  varying float vLat;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    float a = t.a * uA * (1.0 - smoothstep(uFade.x, uFade.y, vLat));
    gl_FragColor = vec4(t.rgb * vShade, a);   // no-data pixels let the level beneath show through
  }`;

// One level's grid: its source, the source's own zoom, the tile counts, and tile (x, y) -> bounds.
function gridFor(level) {
  const src = SOURCES.find((s) => level >= s.levels[0] && level <= s.levels[1]);
  if (!src) return null;
  const merc = src.grid === 'mercator', z = merc ? level : level - 1;
  const cols = 2 ** (z + (merc ? 0 : 1)), rows = 2 ** z;
  return {
    src, merc, z, cols, rows, fade: (src.fadeLat || [90, 91]).map(THREE.MathUtils.degToRad),
    // [west, east, north, south] in radians (latitudes, even for mercator)
    bounds(x, y) {
      const w = (x / cols * 2 - 1) * Math.PI, e = ((x + 1) / cols * 2 - 1) * Math.PI;
      if (merc) return [w, e, mercLat(y / rows), mercLat((y + 1) / rows)];
      return [w, e, Math.PI / 2 - y / rows * Math.PI, Math.PI / 2 - (y + 1) / rows * Math.PI];
    },
    // the rows covering latitudes [lo, hi]
    rowRange(lo, hi) {
      if (merc) {
        const a = Math.floor(mercRow(Math.min(hi, POLE)) * rows), b = Math.floor(mercRow(Math.max(lo, -POLE)) * rows);
        return [Math.max(0, a), Math.min(rows - 1, b)];
      }
      return [Math.max(0, Math.floor((Math.PI / 2 - hi) / Math.PI * rows)), Math.min(rows - 1, Math.floor((Math.PI / 2 - lo) / Math.PI * rows))];
    },
    url(x, y) {
      const row = src.tms ? rows - 1 - y : y;
      return src.url.replace('{z}', z).replace('{x}', x).replace('{y}', row);
    },
  };
}

export class TileLayer {
  // cloud: the Cloud; radius: the globe's radius in world units; atlasPx: the atlas's pixels around the
  // equator (streaming starts once the screen wants clearly more than that)
  constructor(cloud, radius, atlasPx) {
    this.cloud = cloud;
    this.R = radius;
    this.atlasPx = atlasPx;
    this.minLevel = Math.min(...SOURCES.map((s) => s.levels[0]));
    this.maxLevel = Math.max(...SOURCES.map((s) => s.levels[1]));
    this.grids = {};
    for (let l = this.minLevel; l <= this.maxLevel; l++) this.grids[l] = gridFor(l);
    this.group = new THREE.Group();
    this.group.visible = false;
    cloud.scene.add(this.group);
    this.geo = new THREE.PlaneGeometry(1, 1, SEG, SEG).translate(0.5, 0.5, 0);   // uv == position.xy
    this.loader = new THREE.TextureLoader();
    this.loader.setCrossOrigin('anonymous');
    this.tiles = new Map();      // "level/x/y" -> {state: 'loading'|'ready'|'failed', mesh, seen, born}
    this.queue = [];             // keys wanted, coarse levels first, each nearest the view centre first
    this.loading = 0;
    this.frustum = new THREE.Frustum();
    this.m = new THREE.Matrix4();
    this.sphere = new THREE.Sphere();
    this.lastCheck = 0;
    this.level = 0;              // level being streamed; 0 = none (the atlas suffices)
    this.shown = [];             // records with a visible mesh
  }

  // for the page's debug handle
  get stats() {
    let ready = 0, failed = 0;
    for (const r of this.tiles.values()) { ready += r.state === 'ready'; failed += r.state === 'failed'; }
    return { level: this.level, visible: this.shown.length, ready, loading: this.loading, failed };
  }

  // The level the screen wants at the point under the camera: tiles about as large as their pixels.
  wantedLevel() {
    const cam = this.cloud.camera, alt = Math.max(1e-4, cam.position.length() - this.R);
    const px = window.innerHeight * this.cloud.renderer.getPixelRatio();
    const pxPerWorld = px / (2 * alt * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    const around = 2 * Math.PI * this.R * pxPerWorld;   // the equator's length on screen, in pixels
    if (around <= this.atlasPx * 1.6) return 0;   // the whole Moon (even on a dense screen): the atlas, nothing streamed
    const l = Math.ceil(Math.log2(around / TILE_PX) - 0.25);
    return Math.max(this.minLevel, Math.min(this.maxLevel, l));
  }

  // The part of the sphere in view, as a cap around the point under the camera (which looks at the
  // Moon's centre): {lat, lon, rho, view, horizon}.
  viewCap() {
    const cam = this.cloud.camera, cp = cam.position, d = cp.length();
    const horizon = Math.acos(Math.min(1, this.R / d));
    const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const alpha = Math.atan(tanV * Math.hypot(1, cam.aspect));    // half the view's diagonal
    const s = d * Math.sin(alpha) / this.R;
    const rho = s >= 1 ? horizon : Math.min(horizon, Math.asin(s) - alpha);
    const view = cp.clone().divideScalar(d);
    return { lat: Math.asin(view.y), lon: Math.atan2(view.x, view.z), rho, view, horizon };
  }

  // Tiles of a level facing the camera and inside the view, nearest the view centre first.
  visible(level, cap) {
    const g = this.grids[level], out = [];
    const lo = cap.lat - cap.rho, hi = cap.lat + cap.rho;
    const [r0, r1] = g.rowRange(lo, hi);
    let c0 = 0, c1 = g.cols - 1;
    if (hi < Math.PI / 2 && lo > -Math.PI / 2) {   // the cap misses both poles: only a band of longitude
      const dl = Math.asin(Math.min(1, Math.sin(cap.rho) / Math.cos(Math.max(Math.abs(lo), Math.abs(hi)))));
      if (dl < Math.PI) {
        c0 = Math.floor(((cap.lon - dl) / Math.PI + 1) / 2 * g.cols);
        c1 = Math.floor(((cap.lon + dl) / Math.PI + 1) / 2 * g.cols);
      }
    }
    if (c1 - c0 >= g.cols) { c0 = 0; c1 = g.cols - 1; }
    if ((r1 - r0 + 1) * (c1 - c0 + 1) > 40 * MAX_VISIBLE) return null;   // far too many: a coarser level
    const { view } = cap;
    for (let y = r0; y <= r1; y++) {
      for (let cx = c0; cx <= c1; cx++) {
        const x = ((cx % g.cols) + g.cols) % g.cols;   // longitude wraps
        const [w, e, n, s] = g.bounds(x, y);
        const lon = (w + e) / 2, lat = (n + s) / 2;
        if (Math.min(Math.abs(n), Math.abs(s)) >= g.fade[1]) continue;   // wholly faded out: not fetched
        const dx = Math.cos(lat) * Math.sin(lon), dy = Math.sin(lat), dz = Math.cos(lat) * Math.cos(lon);
        const half = 0.5 * Math.hypot((e - w) * Math.cos(Math.min(Math.abs(n), Math.abs(s))), n - s);
        const ang = Math.acos(Math.max(-1, Math.min(1, dx * view.x + dy * view.y + dz * view.z)));
        if (ang > cap.horizon + half) continue;
        this.sphere.center.set(dx * this.R, dy * this.R, dz * this.R);
        this.sphere.radius = this.R * half * 1.2;
        if (!this.frustum.intersectsSphere(this.sphere)) continue;
        out.push([ang, x, y]);
      }
    }
    return out.sort((a, b) => a[0] - b[0]);
  }

  load(key) {
    const [level, x, y] = key.split('/').map(Number);
    const g = this.grids[level];
    const rec = { state: 'loading', mesh: null, seen: performance.now(), born: 0 };
    this.tiles.set(key, rec);
    this.loading++;
    const done = () => { this.loading--; this.pump(); };
    this.loader.load(g.url(x, y), (tex) => {
      tex.colorSpace = THREE.NoColorSpace;   // drawn as stored, like the atlas
      tex.anisotropy = 8;
      const [w, e, n, s] = g.bounds(x, y);
      const box = g.merc ? [w, e, y / g.rows, (y + 1) / g.rows] : [w, e, n, s];
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG,
        uniforms: {
          uBox: { value: new THREE.Vector4(...box) }, uMerc: { value: g.merc ? 1 : 0 }, uR: { value: this.R },
          uMap: { value: tex }, uA: { value: 0 }, uFade: { value: new THREE.Vector2(...g.fade) },
        },
        transparent: true, depthTest: false, depthWrite: false, side: THREE.FrontSide,
      });
      rec.mesh = new THREE.Mesh(this.geo, mat);
      rec.mesh.frustumCulled = false;   // positioned in the shader
      rec.mesh.renderOrder = 3 + level; // finer levels over coarser, all over the skin
      rec.mesh.visible = false;
      rec.state = 'ready';
      rec.born = performance.now();
      this.group.add(rec.mesh);
      done();
    }, undefined, () => { rec.state = 'failed'; done(); });   // missing tile: the level beneath shows through
  }

  pump() {
    while (this.loading < MAX_LOADS && this.queue.length) {
      const key = this.queue.shift();
      if (!this.tiles.has(key)) this.load(key);
    }
  }

  evict() {
    if (this.tiles.size <= CACHE) return;
    const old = [...this.tiles].filter(([, r]) => r.state !== 'loading' && !(r.mesh && r.mesh.visible))
      .sort((a, b) => a[1].seen - b[1].seen);
    for (const [key, r] of old.slice(0, this.tiles.size - CACHE)) {
      if (r.mesh) {
        this.group.remove(r.mesh);
        r.mesh.material.uniforms.uMap.value.dispose();
        r.mesh.material.dispose();
      }
      this.tiles.delete(key);
    }
  }

  // Each frame. active: the whole globe is on screen and still (stream and update); alpha: the layer's
  // opacity, below 1 while it fades out as the globe starts to break up (no streaming then).
  update(active, alpha) {
    const now = performance.now();
    this.group.visible = alpha > 0;
    for (const r of this.shown) r.mesh.material.uniforms.uA.value = alpha * Math.min(1, (now - r.born) / FADE_MS);
    if (!active) {
      this.activeSince = null;
      this.queue.length = 0;
      // faded out: forget what was on screen, so nothing stale flashes up when the globe comes back
      // whole, and let every tile fade in afresh next time (once, on reaching zero)
      if (alpha === 0 && !this.cleared) {
        this.cleared = true;
        for (const r of this.shown) r.mesh.visible = false;
        this.shown = [];
        for (const r of this.tiles.values()) r.refade = true;
      }
      return;
    }
    this.cleared = false;
    this.activeSince ??= now;
    if (now - this.activeSince < SETTLE_MS || now - this.lastCheck < CHECK_MS) return;
    this.lastCheck = now;

    const cam = this.cloud.camera;
    cam.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const cap = this.viewCap();
    let level = this.wantedLevel(), want = null;
    while (level && ((want = this.visible(level, cap)) == null || want.length > MAX_VISIBLE)) {
      level = level > this.minLevel ? level - 1 : 0;
    }
    const show = new Set();
    if (level) {
      // the wanted level, plus coarser levels beneath it as stand-ins while it loads (any that would
      // take too many tiles are skipped)
      for (let l = this.minLevel; l <= level; l++) {
        const tiles = l === level ? want : this.visible(l, cap);
        if (tiles && tiles.length <= MAX_VISIBLE) for (const [, x, y] of tiles) show.add(`${l}/${x}/${y}`);
      }
    }
    this.level = level;
    this.shown = [];
    for (const [key, r] of this.tiles) {
      const on = show.has(key) && r.state === 'ready';
      if (on && !r.mesh.visible) {   // panned back into view: no fade again; after a round trip: fade in afresh
        r.born = r.refade ? now : Math.max(r.born, now - FADE_MS);
        r.refade = false;
      }
      if (r.mesh) r.mesh.visible = on;
      if (on) this.shown.push(r);
      if (show.has(key)) r.seen = now;
    }
    // fetch in the order show was filled: coarser stand-ins first, each level nearest the view centre first
    this.queue = [...show].filter((k) => !this.tiles.has(k));
    this.pump();
    this.evict();
  }
}
