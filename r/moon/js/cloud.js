// Embedding space: the Moon's tiles as points, query marker, neighbour lines, thumbnail billboards, camera fly-in.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { Line2 } from '../vendor/three/lines/Line2.js';
import { LineGeometry } from '../vendor/three/lines/LineGeometry.js';
import { LineMaterial } from '../vendor/three/lines/LineMaterial.js';
import { tween, ease, tick } from './anim.js';

const WORLD = 10;              // layout [-1, 1] -> world units
const BG = '#f1eee8';
const INK = '#2a2622';
const IDLE_ORBIT = 0.45;
const RESUME_MS = 2000;
const LIFT_PX = 44;            // default for cloud.lift: content sits this far above centre, clear of the chat box
const BILLBOARD = 0.06;        // screen-space sprite height (sizeAttenuation off)

// Map view: zoom in far enough and the cloud flattens onto the screen plane (like a globe turning
// into a flat map); dots then push apart so none overlap, and up close they become the works.
const MAP_IN = 5.5;            // camera distance at which the cloud flattens
const MAP_OUT = 7.5;           // ...and rounds back into 3D (hysteresis)
const MAP_MIN = 0.12;          // closest map zoom
const THUMB_D = 2.4;           // below this distance visible dots become thumbnails / cards
const MORPH_MS = 650;
const MAP_THUMB_PX = 74;       // thumbnail height on screen in the map view
const MAP_THUMB_CAP = 320;     // safety cap; at the thumbnail spacing a screen holds fewer than this
const CLICK_PX = 5;            // pointer travel below this counts as a click, not a drag
const PANE_K = 600;            // works hung on a pane: comfortably more than a screen at thumbnail zoom
const PANE_LOCAL = 24;         // neighbourhood scale: distance to this many-th nearest work...
const PANE_REACH = 3.2;        // ...times this is how far a pane reaches (covers a cluster even from its edge)
const REANCHOR_AT = 0.45;      // re-form once you have panned this share of the pane's half-size from where it formed

const POINT_VERT = /* glsl */`
  attribute vec3 color;
  attribute float aState;
  attribute float aAway;
  uniform float uSize, uPR, uNear, uFar, uRef;
  varying vec3 vColor;
  varying float vFade;
  varying float vHidden;
  varying float vAway;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float depth = -mv.z;
    vFade = smoothstep(uNear, uFar, depth);
    vColor = color;
    vHidden = aState;
    vAway = aAway;
    float s = uSize * pow(uRef / max(depth, 0.5), 0.72);
    gl_PointSize = (aState > 0.5 || aAway > 1.5) ? 0.0 : clamp(s, 1.5, 48.0) * uPR;
    gl_Position = projectionMatrix * mv;
  }`;

const POINT_FRAG = /* glsl */`
  uniform vec3 uBg;
  uniform float uDim;
  uniform float uAlpha;
  varying vec3 vColor;
  varying float vFade;
  varying float vHidden;
  varying float vAway;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p);
    float a = 1.0 - smoothstep(0.40, 0.5, r);
    if (a < 0.02) discard;
    // a faint darker rim keeps pale works legible on the light wall
    vec3 c = mix(vColor, vColor * 0.86, smoothstep(0.30, 0.48, r));
    // depth: far points recede into the wall
    c = mix(c, uBg, 0.55 * vFade);
    // dimming: non-neighbours fade toward the wall (uDim = visible share, 1 = full)
    c = mix(uBg, c, uDim);
    // off the gallery pane, behind it: recede
    c = mix(c, uBg, 0.7 * step(0.5, vAway));
    // the dots fade in as the globe's tiles land on them
    if (uAlpha < 0.01) discard;
    gl_FragColor = vec4(c, a * uAlpha);
  }`;

function rawRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function canvasTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// A tiny framed picture: dark frame, white mat, the thumbnail, a soft shadow.
function framedCanvas(img) {
  const long = 220, mat = 12, frame = 5, pad = 14;
  const ar = img.naturalWidth / img.naturalHeight;
  const iw = ar >= 1 ? long : Math.round(long * ar);
  const ih = ar >= 1 ? Math.round(long / ar) : long;
  const w = iw + 2 * (mat + frame) + 2 * pad, h = ih + 2 * (mat + frame) + 2 * pad;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.shadowColor = 'rgba(40,30,20,0.28)'; g.shadowBlur = 12; g.shadowOffsetY = 4;
  g.fillStyle = '#2b2723';
  g.fillRect(pad, pad, w - 2 * pad, h - 2 * pad);
  g.shadowColor = 'transparent';
  g.fillStyle = '#fbfaf6';
  g.fillRect(pad + frame, pad + frame, w - 2 * (pad + frame), h - 2 * (pad + frame));
  g.drawImage(img, pad + frame + mat, pad + frame + mat, iw, ih);
  g.strokeStyle = 'rgba(0,0,0,0.12)';
  g.strokeRect(pad + frame + mat + 0.5, pad + frame + mat + 0.5, iw - 1, ih - 1);
  return c;
}

function markerCanvas() {
  const s = 128, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const m = s / 2;
  const halo = g.createRadialGradient(m, m, 8, m, m, m);
  halo.addColorStop(0, 'rgba(42,38,34,0.20)');
  halo.addColorStop(1, 'rgba(42,38,34,0)');
  g.fillStyle = halo; g.beginPath(); g.arc(m, m, m, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fbfaf6'; g.beginPath(); g.arc(m, m, 21, 0, Math.PI * 2); g.fill();
  g.fillStyle = INK; g.beginPath(); g.arc(m, m, 15, 0, Math.PI * 2); g.fill();
  return c;
}

function ringCanvas() {
  const s = 128, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(42,38,34,0.55)'; g.lineWidth = 3;
  g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 4, 0, Math.PI * 2); g.stroke();
  return c;
}

function dotCanvas() {
  const s = 32, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 3, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(42,38,34,0.55)'; g.lineWidth = 2; g.stroke();
  return c;
}

export class Cloud {
  constructor(container, { xyz, rgb, items }) {
    this.items = items;
    this.n = items.length;
    this.container = container;
    this.shift = 0;                 // view offset in px (half the wall panel width)
    this.lastInteract = -Infinity;
    this.flying = false;
    this.mode = 'idle';
    this.lines = [];                // [{line, tip, index, opacity, sim}]
    this.billboards = new Map();    // index -> {sprite, base, k}
    this.pulsed = null;
    this.hoverCb = null;
    this.view = '3d';               // '3d' | 'flat' | 'morphing'
    this.morph = 0;                 // 0 = 3D layout, 1 = flat map
    this.mapSprites = new Map();    // index -> {sprite, k, h}
    this.clickCb = null;            // (index) => void, on a click (not a drag) on a dot or piece
    this.tipCb = null;              // (index|null, x, y) => void, item under the pointer
    this.surfaceCb = null;          // (x, y) => bool: a click claimed before picking (the elevation profile)
    this.profile = null;            // the elevation profile (profile.js), drawn over the globe each frame
    this.impacts = null;            // the landings timeline (impacts.js), drawn over the globe each frame
    this.globe = null;              // the Moon as a globe (globe.js)
    this.lift = LIFT_PX;            // px the content sits above centre; negative sits it lower
    this.drop = 0;                  // px further down, set each frame by the Moon's globe (globe.js)

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setClearColor(BG, 1);
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 400);
    this.camera.position.set(9, 6, 28);

    const c = this.controls = new OrbitControls(this.camera, r.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.06;
    c.rotateSpeed = 0.55;
    c.zoomSpeed = 0.7;
    c.enablePan = true;         // right-drag (or shift/ctrl + drag) pans
    c.screenSpacePanning = true;
    c.zoomToCursor = true;      // wheel zooms toward the pointer, so you can dive into any cluster
    c.minDistance = 0.05; // close enough to read individual dots; below the closest fly-in framing (0.5)
    c.maxDistance = 70;
    c.autoRotate = true;
    c.autoRotateSpeed = IDLE_ORBIT;
    c.addEventListener('start', () => { this.lastInteract = performance.now(); c.autoRotate = false; });
    c.addEventListener('end', () => { this.lastInteract = performance.now(); });

    // points
    const pos = new Float32Array(this.n * 3);
    for (let i = 0; i < this.n * 3; i++) pos[i] = xyz[i] * WORLD;
    this.positions = pos;          // canonical layout positions (search framing, lines)
    this.shown = pos.slice();      // what is drawn: equals positions in 3D, flattened in the map view
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.shown, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3, true));
    this.state = new Float32Array(this.n);
    geo.setAttribute('aState', new THREE.BufferAttribute(this.state, 1));
    this.away = new Float32Array(this.n);   // 0 on the pane / normal, 1 behind the pane, 2 hidden in front
    geo.setAttribute('aAway', new THREE.BufferAttribute(this.away, 1));
    geo.computeBoundingSphere();
    this.uniforms = {
      uSize: { value: 7.4 }, uPR: { value: r.getPixelRatio() },
      uNear: { value: 18 }, uFar: { value: 46 }, uRef: { value: 32 },
      uBg: { value: rawRgb(BG) }, uDim: { value: 1 }, uAlpha: { value: 1 },
    };
    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
      vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: true,
    }));
    this.scene.add(this.points);


    // query marker (+ a slow breathing ring)
    this.marker = new THREE.Sprite(new THREE.SpriteMaterial({
      map: canvasTexture(markerCanvas()), sizeAttenuation: false, depthTest: false, transparent: true }));
    this.marker.renderOrder = 30;
    this.marker.visible = false;
    this.ring = new THREE.Sprite(new THREE.SpriteMaterial({
      map: canvasTexture(ringCanvas()), sizeAttenuation: false, depthTest: false, transparent: true }));
    this.ring.renderOrder = 29;
    this.ring.visible = false;
    this.scene.add(this.marker, this.ring);

    this.dotTex = canvasTexture(dotCanvas());
    this.texCache = new Map();

    this.resize();
    const idle = this.idlePose();
    this.camera.position.copy(idle.position);
    this.controls.target.copy(idle.target);
    this.idleDist = idle.dist;
    this.uniforms.uRef.value = idle.dist;
    window.addEventListener('resize', () => this.resize());
    r.domElement.addEventListener('pointermove', (e) => this.onPointer(e));
    r.domElement.addEventListener('pointerleave', () => {
      if (this.hoverCb) this.hoverCb(null);
      if (this.tipCb) this.tipCb(null, 0, 0);
    });
    r.domElement.addEventListener('pointerdown', (e) => this.onDown(e));
    r.domElement.addEventListener('pointerup', (e) => this.onUp(e));
    r.domElement.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    // capture phase: runs before OrbitControls' own wheel handler, so it zooms toward the re-aimed target
    r.domElement.addEventListener('wheel', (e) => this.aimAtCursor(e), { capture: true, passive: true });
    r.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
    this.raycaster = new THREE.Raycaster();

    this.ready = this.warmup();
    r.setAnimationLoop((t) => this.frame(t));
  }

  // Compile every shader the fly-in will need (points, marker, ring, line, tip, billboard) before the
  // first query, so the first fly-in does not stall on shader compilation. Resolves when ready.
  async warmup() {
    const line = new Line2(new LineGeometry().setPositions([0, 0, 0, 1, 1, 1]),
      new LineMaterial({ linewidth: 1.6, vertexColors: true, transparent: true, depthTest: false }));
    const tip = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dotTex, color: 0xffffff, sizeAttenuation: false, depthTest: false, transparent: true }));
    const board = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dotTex, sizeAttenuation: false, depthTest: false, transparent: true }));
    this.marker.visible = this.ring.visible = true;
    this.scene.add(line, tip, board);
    await this.renderer.compileAsync(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);
    // wait for the GPU to actually finish (drivers may link lazily on first draw)
    this.renderer.getContext().finish();
    this.scene.remove(line, tip, board);
    // keep these materials alive: three releases a compiled program once no material uses it
    this.warm = [line, tip, board];
    this.marker.visible = this.ring.visible = false;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.applyShift();
  }

  // Shift the projection so the framed content sits left of the wall panel (x) and a little above
  // the chat box (y, or below the header when the search sits at the top), without moving the camera.
  applyShift() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.setViewOffset(w, h, this.shift, this.lift - this.drop, w, h);
    this.camera.updateProjectionMatrix();
  }

  worldPos(index) {
    const p = this.positions;
    return new THREE.Vector3(p[index * 3], p[index * 3 + 1], p[index * 3 + 2]);
  }

  // Camera pose (keeping the current viewing direction) whose projection fits every point inside
  // the visible region left of the wall panel, with headroom for the chat box.
  framing(points, shiftPx, { fillX = 0.74, fillY = 0.6, minDist = 0.5 } = {}) {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, dir).normalize();
    const up2 = new THREE.Vector3().crossVectors(dir, right).normalize();
    const center = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
    // re-centre on the projected extents
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of points) {
      const d = p.clone().sub(center);
      const dx = d.dot(right), dy = d.dot(up2);
      x0 = Math.min(x0, dx); x1 = Math.max(x1, dx); y0 = Math.min(y0, dy); y1 = Math.max(y1, dy);
    }
    center.addScaledVector(right, (x0 + x1) / 2).addScaledVector(up2, (y0 + y1) / 2);
    const w = window.innerWidth, h = window.innerHeight;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const tanH = tanV * Math.max(0.3, (w - 2 * shiftPx) / h);
    let dist = minDist;
    for (const p of points) {
      const d = p.clone().sub(center);
      const dz = d.dot(dir);
      dist = Math.max(dist, dz + Math.abs(d.dot(right)) / (tanH * fillX), dz + Math.abs(d.dot(up2)) / (tanV * fillY));
    }
    return { target: center, position: center.clone().addScaledVector(dir, dist), dist };
  }

  // Frame the body of the cloud; a handful of far outliers may drift off-screen while orbiting.
  idlePose() {
    const pts = [];
    for (let i = 0; i < this.n; i += 5) pts.push(this.worldPos(i));
    const c = new THREE.Vector3();
    pts.forEach((p) => c.add(p));
    c.divideScalar(pts.length);
    const d = pts.map((p) => p.distanceTo(c)).sort((a, b) => a - b);
    const cut = d[Math.floor(d.length * 0.97)];
    return this.framing(pts.filter((p) => p.distanceTo(c) <= cut), 0, { fillX: 1.0, fillY: 0.84, minDist: 6 });
  }

  async flyTo(points, shiftPx, duration, run) {
    return this.flyToPose(this.framing(points, shiftPx), shiftPx, duration, run);
  }

  // Fly the camera to a pose {position, target} (and the view offset to shiftPx), controls held meanwhile.
  async flyToPose({ position, target }, shiftPx, duration, run) {
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone(), s0 = this.shift;
    this.flying = true;
    this.controls.autoRotate = false;
    this.controls.enabled = false;
    const done = await tween(duration, (e) => {
      this.camera.position.lerpVectors(p0, position, e);
      this.controls.target.lerpVectors(t0, target, e);
      this.shift = s0 + (shiftPx - s0) * e;
      this.applyShift();
    }, { run, easing: ease.inOutCubic });
    this.settleControls();
    this.flying = false;
    this.controls.enabled = true;
    this.lastInteract = performance.now();
    return done;
  }

  // Drop any rotation still queued in OrbitControls' damping, so the camera stays where the tween left it.
  settleControls() {
    const c = this.controls;
    if (c._sphericalDelta) c._sphericalDelta.set(0, 0, 0);
    if (c._panOffset) c._panOffset.set(0, 0, 0);
    if ('_scale' in c) c._scale = 1;
  }

  showQuery(pos) {
    const v = new THREE.Vector3(pos[0] * WORLD, pos[1] * WORLD, pos[2] * WORLD);
    this.queryPos = v;
    this.marker.position.copy(v);
    this.ring.position.copy(v);
    this.marker.visible = this.ring.visible = true;
    this.marker.scale.setScalar(0.0001);
    return v;
  }

  // Preload a neighbour's billboard texture while the camera flies.
  preload(index) {
    const it = this.items[index];
    if (this.texCache.has(index) || !it.thumb) return;
    const entry = { tex: null, aspect: 1, ready: null };
    entry.ready = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const cv = framedCanvas(img);
        entry.tex = canvasTexture(cv);
        entry.aspect = cv.width / cv.height;
        resolve(true);
      };
      img.onerror = () => { console.error('thumbnail failed to load', it.thumb); resolve(false); };
      img.src = it.thumb;
    });
    this.texCache.set(index, entry);
  }

  setDim(v) { this.uniforms.uDim.value = v; }

  // Spread the neighbours' billboards apart in screen space so the hung pieces do not pile up,
  // then lift the new screen positions back into the world at their original depth.
  arrange(neighbors) {
    const W = window.innerWidth, H = window.innerHeight;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const px = (s) => (s * H) / (2 * tanV);
    const pad = 14;
    const nodes = neighbors.map((n) => {
      const entry = this.texCache.get(n.index);
      const aspect = entry && entry.tex ? entry.aspect : 1.2;
      const h = px(BILLBOARD);
      const p = this.worldPos(n.index).project(this.camera);
      return { index: n.index, z: p.z, dx: (p.x + 1) / 2 * W, dy: (1 - p.y) / 2 * H, w: h * aspect, h, fixed: false };
    });
    const q = this.queryPos.clone().project(this.camera);
    const qx = (q.x + 1) / 2 * W, qy = (1 - q.y) / 2 * H;
    // start each picture just beyond its dot, on the side away from the query, so the dot stays visible
    for (const nd of nodes) {
      let ux = nd.dx - qx, uy = nd.dy - qy;
      const len = Math.hypot(ux, uy) || 1;
      ux /= len; uy /= len;
      const off = Math.max(nd.w, nd.h) / 2 + 16;
      nd.x = nd.dx + ux * off; nd.y = nd.dy + uy * off;
    }
    // the real dots and the query are fixed obstacles the pictures must not cover
    const dots = nodes.map((nd) => ({ x: nd.dx, y: nd.dy, w: 14, h: 14, fixed: true }));
    nodes.push({ x: qx, y: qy, w: 34, h: 34, fixed: true }, ...dots);
    const right = W - 2 * this.shift - 24, bottom = H - 150;
    // Push overlapping pairs apart along the axis of least overlap, unless a piece is pinned against
    // the region's edge on that axis (a tall column of neighbours), in which case slide sideways.
    const clamp = (nd) => {
      const x = Math.min(Math.max(nd.x, 24 + nd.w / 2), right - nd.w / 2);
      const y = Math.min(Math.max(nd.y, 24 + nd.h / 2), bottom - nd.h / 2);
      nd.pinX = x !== nd.x; nd.pinY = y !== nd.y;
      nd.x = x; nd.y = y;
    };
    for (let iter = 0; iter < 600; iter++) {
      let moved = false;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          if (a.fixed && b.fixed) continue;
          let dx = b.x - a.x, dy = b.y - a.y;
          if (Math.abs(dx) < 0.5) dx = (i % 2 ? 1 : -1) * 0.5;
          if (Math.abs(dy) < 0.5) dy = (j % 2 ? 1 : -1) * 0.5;
          const ox = (a.w + b.w) / 2 + pad - Math.abs(dx), oy = (a.h + b.h) / 2 + pad - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          const share = a.fixed ? [0, 1] : b.fixed ? [1, 0] : [0.5, 0.5];
          const pinnedY = a.pinY || b.pinY, pinnedX = a.pinX || b.pinX;
          const alongX = pinnedY ? true : pinnedX ? false : ox < oy;
          if (alongX) {
            const st = Math.sign(dx) * Math.min(ox, 6);
            a.x -= st * share[0]; b.x += st * share[1];
          } else {
            const st = Math.sign(dy) * Math.min(oy, 6);
            a.y -= st * share[0]; b.y += st * share[1];
          }
        }
      }
      for (const nd of nodes) if (!nd.fixed) clamp(nd);
      if (!moved) break;
    }
    this.display = new Map();
    for (const nd of nodes) {
      if (nd.fixed) continue;
      const v = new THREE.Vector3(nd.x / W * 2 - 1, -(nd.y / H * 2 - 1), nd.z).unproject(this.camera);
      this.display.set(nd.index, v);
    }
  }

  displayPos(index) {
    return (this.display && this.display.get(index)) || this.worldPos(index);
  }

  addLine(n, opacity, color) {
    const from = this.queryPos, to = this.worldPos(n.index);   // the work's real place in the space
    const geo = new LineGeometry();
    geo.setPositions([from.x, from.y, from.z, from.x, from.y, from.z]);
    const ink = new THREE.Color(INK), end = new THREE.Color(color).lerp(ink, 0.3);
    geo.setColors([...ink.toArray(), ...end.toArray()]);
    const mat = new LineMaterial({ linewidth: 1.6, vertexColors: true, transparent: true, opacity, depthTest: false });
    const line = new Line2(geo, mat);
    line.renderOrder = 5;
    // the travelling tip carries the work's own colour out to it
    const tip = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.dotTex, color: new THREE.Color(color), sizeAttenuation: false, depthTest: false, transparent: true }));
    tip.scale.setScalar(0.012);
    tip.renderOrder = 6;
    tip.position.copy(from);
    this.scene.add(line, tip);
    const rec = { line, tip, index: n.index, opacity, from, to };
    this.lines.push(rec);
    return rec;
  }

  growLine(rec, duration, delay, run) {
    const p = new THREE.Vector3();
    return tween(duration, (e) => {
      p.lerpVectors(rec.from, rec.to, e);
      rec.line.geometry.setPositions([rec.from.x, rec.from.y, rec.from.z, p.x, p.y, p.z]);
      rec.tip.position.copy(p);
    }, { delay, run, easing: ease.outCubic }).then((done) => {
      rec.tip.scale.setScalar(0.016);   // stays on the real dot as its marker
      if (done) this.hang(rec.index, run);
      return done;
    });
  }

  // Replace a neighbour's dot with its framed thumbnail.
  hang(index, run) {
    const mat = new THREE.SpriteMaterial({ sizeAttenuation: false, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(this.displayPos(index));
    sprite.renderOrder = 10;
    // a faint leader from the real dot to its hung picture
    const leaderGeo = new THREE.BufferGeometry().setFromPoints([this.worldPos(index), sprite.position.clone()]);
    const leader = new THREE.Line(leaderGeo, new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.28, depthTest: false }));
    leader.renderOrder = 7;
    this.scene.add(leader);
    const rec = { sprite, leader, base: new THREE.Vector2(BILLBOARD, BILLBOARD), k: 0, target: 1,
      order: 1 - this.billboards.size / 100 };   // higher rank draws on top, deterministically
    this.preload(index);
    const entry = this.texCache.get(index);
    if (entry) {
      const apply = () => {
        if (!entry.tex) return;
        mat.map = entry.tex; mat.needsUpdate = true;
        rec.base.set(BILLBOARD * entry.aspect, BILLBOARD);
      };
      if (entry.tex) apply(); else entry.ready.then(apply);
    }
    sprite.scale.set(0.0001, 0.0001, 1);
    this.scene.add(sprite);
    this.billboards.set(index, rec);
    tween(380, (e) => { rec.k = e; }, { run, easing: ease.outBack });
  }

  pulse(index) {
    this.pulsed = index;
  }

  clearResult() {
    for (const { line, tip } of this.lines) {
      this.scene.remove(line, tip);
      line.geometry.dispose(); line.material.dispose(); tip.material.dispose();
    }
    this.lines = [];
    for (const [index, { sprite, leader }] of this.billboards) {
      this.scene.remove(sprite, leader);
      sprite.material.dispose();
      leader.geometry.dispose(); leader.material.dispose();
      this.state[index] = 0;
    }
    this.billboards.clear();
    this.points.geometry.attributes.aState.needsUpdate = true;
    this.marker.visible = this.ring.visible = false;
    this.pulsed = null;
    this.display = null;
    this.lastResult = null;
    this.camSig = null;
  }

  // Back to the plain cloud: undim, drop the panel offset, widen out.
  async reset(run) {
    this.clearResult();
    const d0 = this.uniforms.uDim.value, s0 = this.shift;
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone();
    this.shift = 0;
    const idle = this.idlePose();
    this.shift = s0;
    const p1 = idle.position, t1 = idle.target;
    this.mode = 'idle';
    this.flying = true;
    this.controls.enabled = false;
    await tween(900, (e) => {
      this.setDim(d0 + (1 - d0) * e);
      this.shift = s0 * (1 - e);
      this.applyShift();
      this.camera.position.lerpVectors(p0, p1, e);
      this.controls.target.lerpVectors(t0, t1, e);
    }, { run });
    this.settleControls();
    this.flying = false;
    this.controls.enabled = true;
  }

  project(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x + 1) / 2 * window.innerWidth, y: (1 - p.y) / 2 * window.innerHeight, z: p.z };
  }

  onPointer(e) {
    if (this.drag) { this.dragMove(e); return; }
    if (this.tipCb && !e.buttons && !this.flying) {
      const hit = this.pick(e.clientX, e.clientY);
      this.renderer.domElement.style.cursor = hit == null ? '' : 'pointer';
      // hold the idle orbit still while the pointer rests on a work, so it can be clicked
      if (hit != null) { this.controls.autoRotate = false; this.lastInteract = performance.now(); }
      this.tipCb(hit, e.clientX, e.clientY);
    }
    if (!this.hoverCb || this.billboards.size === 0) return;
    let best = null, bestD = Infinity;
    const halfPx = (BILLBOARD / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2))) * window.innerHeight / 2;
    for (const [index, { sprite }] of this.billboards) {
      const s = this.project(sprite.position);
      const d = Math.hypot(s.x - e.clientX, s.y - e.clientY);
      if (d < halfPx && d < bestD) { best = index; bestD = d; }
    }
    this.hoverCb(best);
  }


  // ---------- picking ----------

  // The item under a screen point: hung billboards and map thumbnails first, then the nearest dot.
  pick(x, y) {
    if (this.globe && this.globe.active) return this.globe.pick(x, y);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const H = window.innerHeight;
    const toPx = (s) => (s * H) / (2 * tanV);
    for (const group of [this.billboards, this.mapSprites]) {
      let best = null, bestD = Infinity;
      for (const [index, rec] of group) {
        const s = this.project(rec.sprite.position);
        const hw = toPx(rec.sprite.scale.x) / 2, hh = toPx(rec.sprite.scale.y) / 2;
        if (Math.abs(s.x - x) < hw * 0.8 && Math.abs(s.y - y) < hh * 0.8) {
          const d = Math.hypot(s.x - x, s.y - y);
          if (d < bestD) { best = index; bestD = d; }
        }
      }
      if (best != null) return best;
    }
    const cam = this.camera.position;
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.camera.matrixWorld);
    const v = new THREE.Vector3();
    const size = this.uniforms.uSize.value, ref = this.uniforms.uRef.value;
    let best = null, bestD = Infinity;
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] > 0.5 || this.away[i] > 0.5) continue;
      v.set(this.shown[i * 3], this.shown[i * 3 + 1], this.shown[i * 3 + 2]);
      const depth = v.clone().sub(cam).dot(fwd);
      if (depth <= 0.05) continue;
      v.project(this.camera);
      const sx = (v.x + 1) / 2 * window.innerWidth, sy = (1 - v.y) / 2 * H;
      const d = Math.hypot(sx - x, sy - y);
      const r = Math.max(5, Math.min(48, Math.max(1.5, size * Math.pow(ref / Math.max(depth, 0.5), 0.72))) / 2 + 2);
      // prefer the nearest-to-camera dot among overlapping hits
      const score = d + depth * 0.01;
      if (d < r && score < bestD) { best = i; bestD = score; }
    }
    return best;
  }

  onDown(e) {
    this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (this.view === 'flat' && (e.button === 0 || e.button === 2)) {
      this.drag = { last: this.planePoint(e.clientX, e.clientY) };
      this.renderer.domElement.setPointerCapture(e.pointerId);
      this.renderer.domElement.style.cursor = 'grabbing';
    }
  }

  onUp(e) {
    const d = this.down;
    this.down = null;
    if (this.drag) {
      this.drag = null;
      this.renderer.domElement.style.cursor = '';
      this.maybeReanchor();
      this.updateThumbs();
    }
    if (!d || e.button !== 0) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX || performance.now() - d.t > 700) return;
    if (this.surfaceCb && this.surfaceCb(e.clientX, e.clientY)) return;
    const hit = this.pick(e.clientX, e.clientY);
    if (hit != null && this.clickCb) this.clickCb(hit);
  }

  // ---------- map view ----------

  // Point on the map plane under a screen position (accounts for the projection view offset).
  planePoint(x, y) {
    const ndc = new THREE.Vector2(x / window.innerWidth * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.mapPlane, hit) || this.controls.target.clone();
  }

  dragMove(e) {
    const p = this.planePoint(e.clientX, e.clientY);
    const delta = this.drag.last.clone().sub(p);
    this.camera.position.add(delta);
    this.controls.target.add(delta);
    this.camera.updateMatrixWorld();
    this.drag.last = this.planePoint(e.clientX, e.clientY);
    this.lastInteract = performance.now();
    if (performance.now() - (this.lastThumbs || 0) > 90) { this.lastThumbs = performance.now(); this.updateThumbs(); }
    if (performance.now() - (this.lastAnchorCheck || 0) > 250) { this.lastAnchorCheck = performance.now(); this.maybeReanchor(); }
  }

  // Zooming in on the 3D cloud: move the orbit target (along the view axis, so nothing jumps) to the
  // depth of the dots under the pointer. Camera distance then measures how close you are to what you
  // are zooming at, so the map forms there instead of at an invisible centre behind or before it.
  aimAtCursor(e) {
    this.lastCursor = { x: e.clientX, y: e.clientY };
    if (this.view !== '3d' || this.mode !== 'idle' || this.flying || e.deltaY >= 0) return;
    this.camera.updateMatrixWorld();
    const cam = this.camera.position;
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.camera.matrixWorld);
    const v = new THREE.Vector3(), rel = new THREE.Vector3();
    const W = window.innerWidth, H = window.innerHeight;
    let nearest = null, nearestD = Infinity;
    const around = [];
    for (let i = 0; i < this.n; i++) {
      v.set(this.shown[i * 3], this.shown[i * 3 + 1], this.shown[i * 3 + 2]);
      const depth = rel.subVectors(v, cam).dot(fwd);
      if (depth <= 0.2) continue;
      v.project(this.camera);
      const d = Math.hypot((v.x + 1) / 2 * W - e.clientX, (1 - v.y) / 2 * H - e.clientY);
      if (d < 14 && depth < nearestD) { nearest = depth; nearestD = depth; }
      if (d < 70) around.push(depth);
    }
    let depth = nearest;
    if (depth == null && around.length) { around.sort((a, b) => a - b); depth = around[Math.floor(around.length * 0.3)]; }
    if (depth == null) return;   // empty space under the pointer: keep the current target
    this.controls.target.copy(cam).addScaledVector(fwd, depth);
  }

  onWheel(e) {
    if (this.view !== 'flat') return;   // OrbitControls zooms the 3D cloud
    e.preventDefault();
    const c = this.controls;
    const d = this.camera.position.distanceTo(c.target);
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const d1 = Math.min(MAP_OUT * 1.2, Math.max(MAP_MIN, d * Math.exp(e.deltaY * unit * 0.0016)));
    const s = d1 / d;
    const P = this.planePoint(e.clientX, e.clientY);   // the spot under the pointer stays put
    this.focus = P.clone();
    this.camera.position.sub(P).multiplyScalar(s).add(P);
    c.target.sub(P).multiplyScalar(s).add(P);
    this.camera.updateMatrixWorld();
    this.lastInteract = performance.now();
    if (d1 > MAP_OUT) this.exitFlat();
    else {
      // zooming toward the pointer slides the view across the pane; re-forming counts panning only
      if (this.pane && this.paneBasis) {
        const { F, right, up } = this.paneBasis, tc = c.target.clone().sub(F);
        this.pane.center = [tc.dot(right), tc.dot(up)];
      }
      if (performance.now() - (this.lastThumbs || 0) > 120) { this.lastThumbs = performance.now(); this.updateThumbs(); }
      clearTimeout(this.thumbTimer);
      this.thumbTimer = setTimeout(() => this.updateThumbs(), 120);
    }
  }

  // ---------- gallery pane ----------
  // Zoomed in on the idle cloud, the works around the spot hang on a pane: a plane fitted (PCA) to
  // their local neighbourhood in the 3D layout, so flattening loses as little structure as possible.
  // The camera turns once to face it; the rest of the cloud stays 3D behind (dimmed) or is hidden in
  // front. Panning near the pane's edge re-forms it around the new spot, keeping its orientation.

  // The works around a point (canonical 3D layout): up to k nearest, but only within a radius scaled
  // to the local neighbourhood (PANE_REACH x the distance to the PANE_LOCAL-th nearest work), so an
  // isolated cluster hangs alone instead of pulling in works from elsewhere in the space.
  nearest(P, k) {
    const d = new Float32Array(this.n), idx = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const dx = this.positions[i * 3] - P.x, dy = this.positions[i * 3 + 1] - P.y, dz = this.positions[i * 3 + 2] - P.z;
      d[i] = dx * dx + dy * dy + dz * dz; idx[i] = i;
    }
    const order = Array.from(idx).sort((a, b) => d[a] - d[b]);
    const r2 = d[order[Math.min(PANE_LOCAL, this.n - 1)]] * PANE_REACH * PANE_REACH;
    const out = [];
    for (const i of order) { if (out.length >= k || (out.length >= PANE_LOCAL && d[i] > r2)) break; out.push(i); }
    return out;
  }

  // Unit normal of the best-fit plane through the given works (smallest-variance direction).
  fitNormal(members) {
    const m = members.length, c = [0, 0, 0];
    for (const i of members) for (let a = 0; a < 3; a++) c[a] += this.positions[i * 3 + a] / m;
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const i of members) {
      const v = [0, 1, 2].map((a) => this.positions[i * 3 + a] - c[a]);
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += v[a] * v[b] / m;
    }
    const mul = (M, v) => [0, 1, 2].map((a) => M[a][0] * v[0] + M[a][1] * v[1] + M[a][2] * v[2]);
    const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
    // largest two eigenvectors by power iteration with deflation; the normal is their cross product
    let e1 = norm([1, 0.3, 0.2]);
    for (let it = 0; it < 60; it++) e1 = norm(mul(C, e1));
    let e2 = norm([0.2, 1, 0.3]);
    for (let it = 0; it < 60; it++) {
      e2 = mul(C, e2);
      const p = e2[0] * e1[0] + e2[1] * e1[1] + e2[2] * e1[2];
      e2 = norm(e2.map((x, a) => x - p * e1[a]));
    }
    const n = new THREE.Vector3(...e1).cross(new THREE.Vector3(...e2)).normalize();
    return n;
  }

  // Hang `members` on the pane at their chart coordinates (one chart for the whole plane, so panes
  // formed one after another agree), and dim or hide everything else.
  buildPane(members) {
    const prev = this.pane;
    if (prev && prev.ruv) {
      this.prevRelaxed = new Map(prev.members.map((i, k) => [i, [prev.ruv[k * 2], prev.ruv[k * 2 + 1]]]));
    }
    const uv = new Float32Array(members.length * 2);
    members.forEach((i, k) => { uv[k * 2] = this.chart[i * 2]; uv[k * 2 + 1] = this.chart[i * 2 + 1]; });
    const member = new Map(members.map((i, k) => [i, k]));
    const { F: F0, right: r0, up: u0 } = this.paneBasis;
    const tc = this.controls.target.clone().sub(F0);
    this.pane = { members, member, uv, ruv: null, center: [tc.dot(r0), tc.dot(u0)] };
    // the rest of the cloud: behind the pane dims, in front of it (between you and the wall) hides
    const { F, n } = this.paneBasis;
    for (let i = 0; i < this.n; i++) {
      if (member.has(i)) { this.away[i] = 0; continue; }
      const s = (this.positions[i * 3] - F.x) * n.x + (this.positions[i * 3 + 1] - F.y) * n.y + (this.positions[i * 3 + 2] - F.z) * n.z;
      this.away[i] = s > 0 ? 2 : 1;
    }
    this.points.geometry.attributes.aAway.needsUpdate = true;
  }

  // Chart coordinates for every work: its spot on the pane plane, scaled so the first pane's works
  // just fill the area their pictures need at thumbnail zoom (a pane is a local chart; scale is free).
  makeChart(members) {
    const { F, right, up } = this.paneBasis;
    const raw = new Float32Array(this.n * 2);
    for (let i = 0; i < this.n; i++) {
      const dx = this.positions[i * 3] - F.x, dy = this.positions[i * 3 + 1] - F.y, dz = this.positions[i * 3 + 2] - F.z;
      raw[i * 2] = dx * right.x + dy * right.y + dz * right.z;
      raw[i * 2 + 1] = dx * up.x + dy * up.y + dz * up.z;
    }
    // scale by coverage: the members should fill about the area their pictures need at thumbnail zoom
    // (radius taken at the 80th percentile, so a few far stragglers do not shrink everyone)
    const rad = members.map((i) => Math.hypot(raw[i * 2], raw[i * 2 + 1])).sort((x, y) => x - y);
    const r80 = Math.max(1e-6, rad[Math.floor(rad.length * 0.8)]);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const spacing = (MAP_THUMB_PX * 1.42) / (window.innerHeight / (2 * THUMB_D * 0.85 * tanV));
    this.paneSpacing = spacing;   // world units between pictures on every pane of this chart
    const area = 0.8 * members.length * spacing * spacing * 1.15;   // 80% of the works inside r80
    this.chartScale = Math.sqrt(area / Math.PI) / r80;
    for (let k = 0; k < raw.length; k++) raw[k] *= this.chartScale;
    this.chart = raw;
  }

  enterFlat() {
    const c = this.controls;
    this.settleControls();
    c.enabled = false;
    c.autoRotate = false;
    // the pane forms around the work under the pointer (or the aimed spot if there is none)
    const lc = this.lastCursor;
    const hit = lc ? this.pick(lc.x, lc.y) : null;
    this.setView('morphing');
    const F = hit != null ? this.worldPos(hit) : c.target.clone();
    const members = this.nearest(F, PANE_K);
    const n = this.fitNormal(members);
    const cam0 = this.camera.position.clone();
    if (n.dot(cam0.clone().sub(F)) < 0) n.negate();
    // keep "up" as close to world up as the pane allows, so leaving the pane needs no roll
    let up = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y);
    if (up.lengthSq() < 0.05) up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).addScaledVector(n, -n.dot(new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1)));
    up.normalize();
    const right = new THREE.Vector3().crossVectors(up, n).normalize();
    this.paneBasis = { F, right, up, n };
    this.mapPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, F);
    this.paneGoal = this.positions.slice();
    this.paneCur = this.positions.slice();
    this.pane = null;
    this.prevRelaxed = null;
    this.makeChart(members);
    this.buildPane(members);
    this.focus = F.clone();
    this.relax();
    this.paneCur.set(this.paneGoal);   // members morph straight to their spot on the pane
    // turn to face the pane: swing the camera around F onto the pane normal, keeping the distance,
    // and slide it in the pane so the work you aimed at ends up under the pointer again
    const d = cam0.distanceTo(c.target);
    const dir0 = cam0.clone().sub(F).normalize();
    const d0 = cam0.distanceTo(F);   // start exactly where the camera is (no jump on the first frame)
    this.camera.position.copy(F).addScaledVector(n, d);
    this.camera.lookAt(F);
    this.camera.updateMatrixWorld();
    const slide = lc ? F.clone().sub(this.planePoint(lc.x, lc.y)) : new THREE.Vector3();
    this.camera.position.copy(cam0);
    this.camera.lookAt(c.target);
    this.camera.updateMatrixWorld();
    const T0 = c.target.clone();
    const run = this.morphRun = (this.morphRun || 0) + 1;
    this.turning = true;
    tween(MORPH_MS, (e) => {
      if (run !== this.morphRun) return;
      this.morph = e;
      const dir = dir0.clone().lerp(n, e).normalize();
      const look = new THREE.Vector3().lerpVectors(T0, F.clone().add(slide), e);
      this.camera.position.copy(F).addScaledVector(dir, d0 + (d - d0) * e).addScaledVector(slide, e);
      this.camera.lookAt(look);
      c.target.copy(look);
      this.camera.updateMatrixWorld();
    }, { easing: ease.inOutCubic }).then(() => {
      this.turning = false;
      if (run === this.morphRun && this.view === 'morphing') this.setView('flat');
    });
  }

  // Leave the pane: works slide back into the cloud. Resolves when the morph has finished.
  exitFlat() {
    if (this.view === '3d') return Promise.resolve();
    if (this.leaving) return this.leaving;
    this.setView('morphing');
    this.clearMapSprites();
    const m0 = this.morph;
    const run = this.morphRun = (this.morphRun || 0) + 1;
    this.leaving = tween(MORPH_MS * Math.max(0.3, m0), (e) => { if (run === this.morphRun) this.morph = m0 * (1 - e); },
      { easing: ease.inOutCubic }).then(() => {
      this.morph = 0;
      this.away.fill(0);
      this.points.geometry.attributes.aAway.needsUpdate = true;
      this.shown.set(this.positions);
      this.points.geometry.attributes.position.needsUpdate = true;
      this.pane = null;
      this.setView('3d');
      this.leaving = null;
      this.settleControls();
      this.controls.enabled = true;
      this.lastInteract = performance.now();
    });
    return this.leaving;
  }

  setView(v) {
    if (v === this.view) return;
    this.view = v;
    if (this.viewCb) this.viewCb(v);
  }

  ensure3d() {
    return this.view === '3d' ? Promise.resolve() : this.exitFlat();
  }

  // Push the pane's works apart until none overlap at the current zoom, with a weak pull back to
  // their true spot. Depends only on the zoom and the pane, never on where you look, so panning
  // within a pane moves nothing.
  relax({ keepShared = false } = {}) {
    if ((this.view !== 'flat' && this.view !== 'morphing') || !this.pane || this.leaving) return;
    const t0 = performance.now();
    const pane = this.pane, m = pane.members.length;
    // laid out once, at thumbnail spacing: zooming only magnifies, it never rearranges
    const minW = this.paneSpacing;
    // start (and spring back) from each work's chart spot; on a re-form, works already hanging on
    // the previous pane start from, and stay anchored to, where they hung
    const x = new Float32Array(m), y = new Float32Array(m), hx = new Float32Array(m), hy = new Float32Array(m);
    let shared = 0;
    const fixed = new Uint8Array(m);   // on a re-form, works already hanging do not move at all
    for (let k = 0; k < m; k++) {
      const pr = keepShared && this.prevRelaxed && this.prevRelaxed.get(pane.members[k]);
      if (pr) { shared++; fixed[k] = 1; }
      hx[k] = x[k] = pr ? pr[0] : pane.uv[k * 2];
      hy[k] = y[k] = pr ? pr[1] : pane.uv[k * 2 + 1];
    }
    for (let iter = 0; iter < 320; iter++) {
      const grid = new Map();
      for (let k = 0; k < m; k++) {
        const key = Math.floor(x[k] / minW) * 73856093 ^ Math.floor(y[k] / minW) * 19349663;
        let b = grid.get(key); if (!b) grid.set(key, b = []); b.push(k);
      }
      let moved = 0;
      for (let k = 0; k < m; k++) {
        const gx = Math.floor(x[k] / minW), gy = Math.floor(y[k] / minW);
        for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
          const b = grid.get((gx + ox) * 73856093 ^ (gy + oy) * 19349663);
          if (!b) continue;
          for (const j of b) {
            if (j <= k) continue;
            let dx = x[j] - x[k], dy = y[j] - y[k];
            let dist = Math.hypot(dx, dy);
            if (dist >= minW) continue;
            if (dist < 1e-6) { const a = (k * 2.399) % (Math.PI * 2); dx = Math.cos(a); dy = Math.sin(a); dist = 1e-6; }
            if (fixed[k] && fixed[j]) continue;
            const push = (minW - dist) / dist * (fixed[k] || fixed[j] ? 1 : 0.5);
            if (!fixed[k]) { x[k] -= dx * push; y[k] -= dy * push; }
            if (!fixed[j]) { x[j] += dx * push; y[j] += dy * push; }
            if (dist < minW * 0.97) moved++;   // overlaps under 3% are invisible
          }
        }
      }
      if (!moved) break;
      // a gentle pull home keeps neighbourhoods together; it stops for the last stretch so the
      // final arrangement is overlap-free
      if (iter < 240) for (let k = 0; k < m; k++) {
        x[k] += (hx[k] - x[k]) * 0.006;
        y[k] += (hy[k] - y[k]) * 0.006;
      }
    }
    // keep the work under the zoom focus where it was: its previous spot on the pane (this pane or the
    // one before it), or its chart spot the first time
    const { F, right, up, n } = this.paneBasis;
    if (this.focus && !shared) {
      const f = this.focus.clone().sub(F);
      const fu = f.dot(right), fv = f.dot(up);
      const where = (k) => {
        if (pane.ruv) return [pane.ruv[k * 2], pane.ruv[k * 2 + 1]];
        const pr = this.prevRelaxed && this.prevRelaxed.get(pane.members[k]);
        return pr || [pane.uv[k * 2], pane.uv[k * 2 + 1]];
      };
      let kb = 0, db = Infinity;
      for (let k = 0; k < m; k++) {
        const [u, v] = where(k);
        const dd = (u - fu) ** 2 + (v - fv) ** 2;
        if (dd < db) { db = dd; kb = k; }
      }
      const [ru, rv] = where(kb);
      const sx = ru - x[kb], sy = rv - y[kb];
      for (let k = 0; k < m; k++) { x[k] += sx; y[k] += sy; }
    }
    pane.ruv = new Float32Array(m * 2);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < m; k++) {
      pane.ruv[k * 2] = x[k]; pane.ruv[k * 2 + 1] = y[k];
      u0 = Math.min(u0, x[k]); u1 = Math.max(u1, x[k]); v0 = Math.min(v0, y[k]); v1 = Math.max(v1, y[k]);
    }
    pane.extent = { u0, u1, v0, v1 };
    // goals: members on the pane (a hair in front, in a fixed per-work order so none z-fight),
    // everyone else back at their place in the cloud
    this.paneGoal.set(this.positions);
    pane.members.forEach((i, k) => {
      const lift = 0.004 + k * 2e-5;
      for (let a = 0, ax = ['x', 'y', 'z']; a < 3; a++) {
        this.paneGoal[i * 3 + a] = F[ax[a]] + x[k] * right[ax[a]] + y[k] * up[ax[a]] + lift * n[ax[a]];
      }
    });
    this.relaxMs = performance.now() - t0;
    this.updateThumbs();
  }

  // Panned toward the pane's edge: re-form it around the work at the centre of the view.
  maybeReanchor() {
    const pane = this.pane;
    if (!pane || !pane.extent || this.view !== 'flat') return;
    const { F, right, up } = this.paneBasis;
    const t = this.controls.target.clone().sub(F);
    const cu = t.dot(right), cv = t.dot(up);
    // measured from where this pane formed (centred on the view then), not from its extent, so a
    // lopsided pane (a tight cluster spreading to one side) cannot trigger a re-form on every pan
    const { u0, u1, v0, v1 } = pane.extent;
    const tanV0 = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const viewHalf = this.camera.position.distanceTo(this.controls.target) * tanV0;
    const viewHalfW = viewHalf * (window.innerWidth / window.innerHeight);
    // small panes: still at least ~3/4 of a screen width of panning before anything re-forms
    const reach = Math.max(REANCHOR_AT * Math.min(u1 - u0, v1 - v0) / 2, 0.75 * viewHalfW);
    if (Math.hypot(cu - pane.center[0], cv - pane.center[1]) < reach) return;
    // panned off the edge of the collection: nothing to hang here, keep the pane as it is
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const halfW = this.camera.position.distanceTo(this.controls.target) * tanV * (window.innerWidth / window.innerHeight);
    let near = false;
    for (let i = 0; i < this.n && !near; i++) near = Math.hypot(this.chart[i * 2] - cu, this.chart[i * 2 + 1] - cv) < halfW;
    if (!near) return;
    // the 3D spot under the view centre, through the chart, and the works nearest it
    const X = F.clone().addScaledVector(right, cu / this.chartScale).addScaledVector(up, cv / this.chartScale);
    const members = this.nearest(X, PANE_K);
    const same = members.filter((i) => pane.member.has(i)).length;
    if (same >= 0.9 * Math.max(members.length, pane.members.length)) {
      pane.center = [cu, cv];   // essentially the same works: keep this pane, just re-centre the trigger
      return;
    }
    this.buildPane(members);
    this.focus = this.controls.target.clone();
    this.relax({ keepShared: true });
    this.reanchors = (this.reanchors || 0) + 1;
  }

  // Up close, every work on the pane that is in view hangs as its picture. Cheap; runs while panning.
  updateThumbs() {
    if ((this.view !== 'flat' && this.view !== 'morphing') || !this.pane) return;
    const pane = this.pane;
    const d = this.camera.position.distanceTo(this.controls.target);
    this.minSpacingPx = this.paneSpacing * window.innerHeight / (2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    let show = [];
    if (d < THUMB_D && pane.ruv) {
      const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
      const halfH = d * tanV * 1.12, halfW = halfH * (window.innerWidth / window.innerHeight);
      const { F, right, up } = this.paneBasis;
      const t = this.controls.target.clone().sub(F);
      const cu = t.dot(right), cv = t.dot(up);
      const inView = [];
      for (let k = 0; k < pane.members.length; k++) {
        const du = pane.ruv[k * 2] - cu, dv = pane.ruv[k * 2 + 1] - cv;
        if (Math.abs(du) < halfW && Math.abs(dv) < halfH) inView.push([du * du + dv * dv, pane.members[k]]);
      }
      inView.sort((a, b) => a[0] - b[0]);
      show = inView.slice(0, MAP_THUMB_CAP).map((p) => p[1]);
    }
    this.updateMapSprites(show, d);
    // a fixed, unique draw order (centre on top) so overlapping pictures never trade places frame to frame
    show.forEach((index, r) => { const rec = this.mapSprites.get(index); if (rec) rec.sprite.renderOrder = 9 - r / 1000; });
  }

  updateMapSprites(show, d) {
    const keep = new Set(show);
    for (const [index, rec] of this.mapSprites) {
      if (keep.has(index)) continue;
      this.scene.remove(rec.sprite);
      rec.sprite.material.dispose();
      this.mapSprites.delete(index);
      this.state[index] = 0;
    }
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const unit = (2 * tanV) / window.innerHeight;   // sprite scale per screen pixel
    for (const index of show) {
      if (this.mapSprites.has(index)) continue;
      const mat = new THREE.SpriteMaterial({ sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0 });
      const sprite = new THREE.Sprite(mat);
      sprite.renderOrder = 8;
      const rec = { sprite, k: 0, w: MAP_THUMB_PX * 0.82 * unit * (180 / 220), h: MAP_THUMB_PX * 0.82 * unit };
      // register first: a texture that is already cached is applied synchronously below
      this.scene.add(sprite);
      this.mapSprites.set(index, rec);
      this.preload(index);
      const entry = this.texCache.get(index);
      const apply = () => {
        if (!entry.tex || this.mapSprites.get(index) !== rec) return;   // gone, or replaced by a newer sprite
        mat.map = entry.tex; mat.needsUpdate = true;
        const a = entry.aspect;
        rec.h = MAP_THUMB_PX * unit; rec.w = rec.h * a;
        this.state[index] = 1;
        this.points.geometry.attributes.aState.needsUpdate = true;
      };
      if (entry && entry.tex) apply(); else if (entry) entry.ready.then(apply);
    }
    this.points.geometry.attributes.aState.needsUpdate = true;
  }

  clearMapSprites() {
    this.updateMapSprites([], 0);
  }

  // Per frame: ease the works toward their pane spot (or back into the cloud) and place the pictures.
  stepMap() {
    if (this.view === '3d') return;
    const e = this.morph, s = this.shown, p = this.positions, cur = this.paneCur, goal = this.paneGoal;
    for (let i = 0; i < this.n * 3; i++) {
      cur[i] += (goal[i] - cur[i]) * 0.16;
      s[i] = p[i] + (cur[i] - p[i]) * e;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    for (const [index, rec] of this.mapSprites) {
      rec.sprite.position.set(s[index * 3], s[index * 3 + 1], s[index * 3 + 2]);
      rec.k += (1 - rec.k) * 0.14;
      rec.sprite.material.opacity = rec.sprite.material.map ? rec.k : 0;
      rec.sprite.scale.set(rec.w * (0.85 + 0.15 * rec.k), rec.h * (0.85 + 0.15 * rec.k), 1);
    }
  }

  frame(now) {
    tick(now);

    const c = this.controls;
    if (this.view === '3d') {
      // idle orbit only: once a query is hung, the composition holds still unless the presenter drags
      if (this.mode !== 'idle' && this.mode !== 'globe') c.autoRotate = false;
      else if (!this.flying && !c.autoRotate && now - this.lastInteract > RESUME_MS) c.autoRotate = true;
      if (!this.flying) c.update();
    }

    // depth fade window follows the camera distance
    const dist = this.camera.position.distanceTo(c.target);
    // zoomed in on the idle cloud: flatten it into a map
    if (this.view === '3d' && this.mode === 'idle' && !this.flying && dist < MAP_IN) this.enterFlat();
    this.stepMap();
    this.uniforms.uNear.value = Math.max(0.1, dist - 4);
    this.uniforms.uFar.value = dist + WORLD * 1.6;

    // marker breathing
    if (this.marker.visible) {
      const ms = this.marker.scale.x;
      this.marker.scale.setScalar(ms + (0.05 - ms) * 0.12);
      const ph = (now % 2400) / 2400;
      this.ring.scale.setScalar(0.03 + 0.05 * ph);
      this.ring.material.opacity = 0.7 * (1 - ph);
    }

    // callouts: when the camera has moved, re-spread them in screen space beside their real dots
    if (this.billboards.size && this.lastResult && !this.flying) {
      const sig = this.camera.matrixWorld.elements.map((x) => x.toFixed(4)).join(',') + this.shift;
      if (sig !== this.camSig && now - (this.lastArrange || 0) > 60) {
        this.camSig = sig;
        this.lastArrange = now;
        this.arrange(this.lastResult);
      }
    }
    for (const [index, rec] of this.billboards) {
      const goal = this.displayPos(index);
      rec.sprite.position.lerp(goal, 0.22);
      const a = rec.leader.geometry.attributes.position;
      const w = this.worldPos(index);
      a.setXYZ(0, w.x, w.y, w.z);
      a.setXYZ(1, rec.sprite.position.x, rec.sprite.position.y, rec.sprite.position.z);
      a.needsUpdate = true;
    }
    // billboards ease toward their size; the pulsed one breathes larger
    for (const [index, rec] of this.billboards) {
      const pulse = index === this.pulsed ? 1.32 + 0.05 * Math.sin(now / 160) : 1;
      rec.cur = (rec.cur ?? 1) + (pulse - (rec.cur ?? 1)) * 0.18;
      const s = rec.k * rec.cur;
      rec.sprite.scale.set(rec.base.x * s, rec.base.y * s, 1);
      rec.sprite.renderOrder = index === this.pulsed ? 12 : 10 + (rec.order || 0);
    }
    for (const rec of this.lines) {
      const target = this.pulsed == null ? rec.opacity : (rec.index === this.pulsed ? 1 : rec.opacity * 0.35);
      rec.line.material.opacity += (target - rec.line.material.opacity) * 0.2;
    }

    if (this.globe) this.globe.step();
    if (this.profile) this.profile.step();
    if (this.impacts) this.impacts.step();
    this.renderer.render(this.scene, this.camera);
  }
}

