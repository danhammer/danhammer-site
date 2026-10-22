// The Moon as a globe made of its own pictures, and the morph from that globe into embedding space.
// Only for a bundle whose meta.json has a "globe" block (the Moon datasets). Each item is one
// web-mercator tile. At rest it lies on the sphere; as it lifts off it flattens into a facet centred on
// the ray from the Moon's centre through the middle of its patch, then flies to its embedding spot.
// One uniform, uT, carries every picture from its place on the globe (0) to its embedding spot (1).
import * as THREE from 'three';
import { tween, ease } from './anim.js';
import { TileLayer } from './tiles.js';
import { POLE_DEG, mercLat, mercRow, sphereXYZ, SPHERE_GLSL } from './sphere.js';

const WORLD = 10;           // must match cloud.js: the globe is the unit sphere in layout units
const GAP = 0.975;          // in flight, a picture covers this share of its patch: a hairline between neighbours
const TILE_END = 0.22;      // patch size (world units) as it arrives in the cloud, before it fades to its dot
const SPREAD = 0.9;         // stagger: share of the morph by which the last patch starts after the first
const LIFT = 0.28;          // patches rise off the surface (x radius) mid-flight
const MORPH_MS = 3200;
const PULL_MS = 900;        // zoomed in: the glide back out to the whole Moon before it breaks up
const SKIN_FADE = 0.5;      // share of the morph over which the skin fades as the facets lift off
const CURVE_END = 0.25;     // a facet has flattened by this share of its own flight
const TILES_FADE = 0.12;    // share of the morph over which the streamed close-up tiles fade as it starts
const FILL = 1.02;          // on load the Moon's radius spans this share of half the view's height
const BELOW = 0.2;          // on load, this share of the Moon's height sits below the page edge
const NEAREST = 1.012;      // on the globe, the camera stops this far from the centre (x radius): ~20 km up

const VERT = /* glsl */`
  ${SPHERE_GLSL}
  attribute vec2 aTile;
  attribute vec3 aEmb;
  attribute float aSeed;
  uniform float uT, uN, uR;
  uniform vec3 uRight, uUp;
  varying vec2 vUv;
  varying float vK;
  varying float vShade;
  vec3 onGlobe(float gx, float gy) { return sphere((gx * 2.0 - 1.0) * PI, mercLat(gy)); }
  void main() {
    float u = uv.x, v = 1.0 - uv.y;                       // v = 0 at the picture's north edge
    float lonc = ((aTile.x + 0.5) / uN * 2.0 - 1.0) * PI, latc = mercLat((aTile.y + 0.5) / uN);
    vec3 nc = onGlobe((aTile.x + 0.5) / uN, (aTile.y + 0.5) / uN);   // the ray through the picture's centre
    vec3 east = vec3(cos(lonc), 0.0, -sin(lonc));
    vec3 north = vec3(-sin(latc) * sin(lonc), cos(latc), -sin(latc) * cos(lonc));
    // the patch's size on the sphere (mercator is conformal, so it is near square, like the picture)
    float w = uR * (2.0 * PI / uN) * cos(latc);
    float h = uR * (mercLat(aTile.y / uN) - mercLat((aTile.y + 1.0) / uN));
    float k = clamp(uT * (1.0 + ${SPREAD.toFixed(2)}) - aSeed * ${SPREAD.toFixed(2)}, 0.0, 1.0);
    float e = k < 0.5 ? 4.0 * k * k * k : 1.0 - pow(-2.0 * k + 2.0, 3.0) / 2.0;
    float gap = mix(1.0, ${GAP.toFixed(3)}, min(1.0, e * 4.0));   // closed on the globe, open once in flight
    vec3 pg = uR * nc + (east * (u - 0.5) * w + north * (0.5 - v) * h) * gap;
    // at rest each picture lies on the sphere exactly where the skin draws it, lit the same way, so the
    // hand-over from the skin is invisible; it flattens into a facet as it lifts off
    float curve = 1.0 - smoothstep(0.0, ${CURVE_END.toFixed(2)}, e);
    vec3 ns = onGlobe((aTile.x + u) / uN, (aTile.y + v) / uN);
    pg = mix(pg, uR * ns, curve);
    vec3 nShade = normalize(mix(nc, ns, curve));
    vec3 pe = aEmb + (uRight * (u - 0.5) + uUp * (0.5 - v)) * ${TILE_END.toFixed(2)};
    vec3 p = mix(pg, pe, e) + nc * (sin(PI * e) * uR * ${LIFT.toFixed(2)});
    vK = e;
    vUv = vec2((aTile.x + u) / uN, 1.0 - (aTile.y + v) / uN);
    vShade = shade(nShade, pg);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;

const FRAG = /* glsl */`
  uniform sampler2D uAtlas;
  varying vec2 vUv;
  varying float vK;
  varying float vShade;
  void main() {
    float a = 1.0 - smoothstep(0.82, 1.0, vK);
    if (a < 0.01) discard;
    vec3 c = texture2D(uAtlas, vUv).rgb * mix(vShade, 1.0, vK);
    gl_FragColor = vec4(c, a);
  }`;

// The whole, still globe is drawn as one seamless skin: the atlas wrapped on a true sphere, its
// web-mercator rows looked up per latitude. Past mercator's edge (+-85 deg) the edge row is stretched
// over the pole, so no opening shows. When the globe breaks up the facets lift off it while it fades
// (SKIN_FADE of the morph), so the gaps between them show the Moon, never the page behind.
const SKIN_VERT = /* glsl */`
  ${SPHERE_GLSL}
  uniform float uR, uPole;
  varying vec2 vUv;
  varying float vShade;
  void main() {
    float lon = (uv.x * 2.0 - 1.0) * PI, lat = (uv.y * 2.0 - 1.0) * 0.5 * PI;
    vec3 n = sphere(lon, lat);
    vec3 p = n * uR;
    float lm = clamp(lat, -uPole, uPole);
    vUv = vec2(uv.x, 0.5 + log(tan(0.25 * PI + 0.5 * lm)) / (2.0 * PI));   // mercator row, 1 at the north edge
    vShade = shade(n, p);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;

const SKIN_FRAG = /* glsl */`
  uniform sampler2D uAtlas;
  uniform float uA;
  varying vec2 vUv;
  varying float vShade;
  void main() { gl_FragColor = vec4(texture2D(uAtlas, vUv).rgb * vShade, uA); }`;

export class Globe {
  // cloud: the Cloud; info: meta.globe {z, cell, atlas}
  constructor(cloud, info) {
    this.cloud = cloud;
    this.n = 2 ** info.z;
    this.t = 0;                    // 0 = globe, 1 = embedding cloud
    this.busy = false;
    const items = cloud.items, count = items.length;
    this.indexAt = new Map();      // "x,y" -> item index
    const tile = new Float32Array(count * 2), emb = new Float32Array(count * 3);
    this.seed = new Float32Array(count);
    this.centres = [];
    items.forEach((it, i) => {
      const [x, y] = it.tile;
      this.indexAt.set(`${x},${y}`, i);
      tile[i * 2] = x; tile[i * 2 + 1] = y;
      emb.set(cloud.positions.subarray(i * 3, i * 3 + 3), i * 3);
      this.centres.push(sphereXYZ(((x + 0.5) / this.n * 2 - 1) * Math.PI, mercLat((y + 0.5) / this.n)));
    });

    // subdivided, so a picture can lie curved on the sphere at rest: 8 x 8 at z5, fewer for smaller tiles
    const seg = Math.max(2, 2 ** (8 - info.z));
    const base = new THREE.PlaneGeometry(1, 1, seg, seg);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    geo.setAttribute('aTile', new THREE.InstancedBufferAttribute(tile, 2));
    geo.setAttribute('aEmb', new THREE.InstancedBufferAttribute(emb, 3));
    this.seedAttr = new THREE.InstancedBufferAttribute(this.seed, 1);
    geo.setAttribute('aSeed', this.seedAttr);
    geo.instanceCount = count;

    let atlas;
    // resolves once the globe's picture is in (or failed to come): the page shows its loader until then
    this.ready = new Promise((resolve) => {
      atlas = new THREE.TextureLoader().load(info.atlas, () => { this.loaded = true; resolve(); }, undefined, (err) => {
        console.error('globe atlas failed to load', info.atlas, err);
        resolve();
      });
    });
    atlas.colorSpace = THREE.NoColorSpace;   // drawn as stored, like the dots' colours
    atlas.anisotropy = 8;
    this.uniforms = {
      uT: { value: 0 }, uN: { value: this.n }, uR: { value: WORLD },
      uRight: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 1, 0) },
      uAtlas: { value: atlas },
    };
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      side: THREE.FrontSide, transparent: true, depthWrite: true,   // see apply()
      // the facets at rest lie exactly on the skin's sphere: a depth bias keeps them in front of it, so the
      // two can trade places at the same size
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    }));
    this.mesh.frustumCulled = false;   // instances move far from the base plane's bounds
    this.mesh.renderOrder = 1;

    cloud.scene.add(this.mesh);
    cloud.globe = this;
    this.skin = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1, 256, 128).translate(0.5, 0.5, 0),   // uv == position.xy
      new THREE.ShaderMaterial({
        vertexShader: SKIN_VERT, fragmentShader: SKIN_FRAG,
        uniforms: { uR: { value: WORLD }, uPole: { value: THREE.MathUtils.degToRad(POLE_DEG) },
                    uAtlas: this.uniforms.uAtlas, uA: { value: 1 } },
        side: THREE.FrontSide, transparent: true, depthWrite: false,
      }));
    this.skin.frustumCulled = false;   // positioned in the shader
    // drawn after the facets and depth-tested against them: hidden where a facet still lies on the surface
    // (or has lifted toward the viewer), and laid translucently over whatever lies behind it, so facets on
    // the far side come into view only as it fades, never all at once. Under the streamed tiles (drawn after).
    this.skin.renderOrder = 2;
    this.skin.visible = false;
    cloud.scene.add(this.skin);
    this.tiles = new TileLayer(cloud, WORLD, info.cell * this.n);   // the atlas's pixels around the equator
    const k = cloud.controls;
    this.nav = { zoomToCursor: k.zoomToCursor, minDistance: k.minDistance, rotateSpeed: k.rotateSpeed,
                 enablePan: k.enablePan, autoRotateSpeed: k.autoRotateSpeed };
    this.apply(0);
  }

  get active() { return this.t < 1; }        // anything of the globe on screen
  get whole() { return this.t === 0 && !this.busy; }

  // Camera pose that shows the whole Moon left of centre-ish, the same viewing direction as now.
  pose() {
    const c = this.cloud;
    const dir = c.camera.position.clone().sub(c.controls.target).normalize();
    const tanV = Math.tan(THREE.MathUtils.degToRad(c.camera.fov) / 2);
    const dist = WORLD / Math.sin(Math.atan(tanV * FILL));
    return { target: new THREE.Vector3(), position: dir.multiplyScalar(dist) };
  }

  apply(t) {
    this.t = t;
    this.uniforms.uT.value = t;
    // at rest front faces only (the far side's backs stay unseen); in flight both, as the pictures
    // turn edge-on on their way to face the viewer (step() decides whether the facets are drawn)
    this.mesh.material.side = t === 0 ? THREE.FrontSide : THREE.DoubleSide;
    // the dots arrive as the patches land
    this.cloud.uniforms.uAlpha.value = THREE.MathUtils.smoothstep(t, 0.55, 1.0);
  }

  // Each frame: globe navigation while it is whole, the streamed tiles, and the arriving patches facing the camera.
  step() {
    this.navigate();
    this.settle();
    // whole and still: the seamless skin alone (streamed tiles over it); in flight, the facets over the fading skin
    const a = this.loaded ? 1 - THREE.MathUtils.smoothstep(this.t, 0, SKIN_FADE) : 0;
    this.skin.visible = a > 0;
    this.skin.material.uniforms.uA.value = a;
    this.mesh.visible = this.t < 1 && !(this.whole && this.loaded);
    // the streamed tiles fade out as the globe starts to break up (not on the way back: they return once it is whole)
    const leaving = this.busy && this.heading === 1;
    this.tiles.update(this.whole, this.whole ? 1 : leaving ? 1 - THREE.MathUtils.smoothstep(this.t, 0, TILES_FADE) : 0);
    if (!this.mesh.visible) return;
    const m = this.cloud.camera.matrixWorld.elements;
    this.uniforms.uRight.value.set(m[0], m[1], m[2]);
    this.uniforms.uUp.value.set(m[4], m[5], m[6]);
  }

  // On the whole globe the camera orbits the Moon's centre like a map's: scrolling zooms straight in
  // (stopping above the surface), and dragging turns the Moon slower the closer you are, so the
  // ground moves with the pointer. Anywhere else the cloud's own controls are restored.
  navigate() {
    const k = this.cloud.controls, n = this.nav, whole = this.whole;
    if (whole !== this.navWhole) {   // on the change: the globe's way of moving, or the cloud's back
      this.navWhole = whole;
      Object.assign(k, whole ? { zoomToCursor: false, enablePan: false, minDistance: WORLD * NEAREST } : n);
    }
    if (!whole) return;
    const alt = this.cloud.camera.position.distanceTo(k.target) - WORLD;
    const slow = THREE.MathUtils.clamp(alt / (WORLD * 2.5), 0.0005, 1);
    k.rotateSpeed = n.rotateSpeed * slow;
    k.autoRotateSpeed = n.autoRotateSpeed * slow;
  }

  // Sit the Moon low on the page, its lowest BELOW below the bottom edge. The drop shrinks as the Moon
  // grows on screen (zooming in brings the point you look at to the centre) and fades out as the globe
  // breaks up, so embedding space keeps its own framing.
  settle() {
    const c = this.cloud, h = window.innerHeight;
    const d = c.camera.position.distanceTo(c.controls.target);
    const tanV = Math.tan(THREE.MathUtils.degToRad(c.camera.fov) / 2);
    const r = d > WORLD ? (h / 2) * Math.tan(Math.asin(WORLD / d)) / tanV : h;   // on-screen radius, px
    // the centre goes to h - (1 - 2 BELOW) r from the top; unshifted it sits at h / 2 - lift
    // eased like the camera's flight (slow in, slow out), so the Moon never starts to slide before the rest moves
    const drop = Math.max(0, h / 2 - (1 - 2 * BELOW) * r + c.lift) * (1 - THREE.MathUtils.smootherstep(this.t, 0, 1));
    if (Math.abs(drop - c.drop) > 0.25) { c.drop = drop; c.applyShift(); }
  }

  // Patches nearest the viewer leave first, with a little jitter so it reads as breaking up, not peeling.
  restagger() {
    const view = this.cloud.camera.position.clone().normalize();
    let s = 1234567;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    this.centres.forEach((c, i) => { this.seed[i] = 0.7 * (1 - c.dot(view)) / 2 + 0.3 * rand(); });
    this.seedAttr.needsUpdate = true;
  }

  async morph(to, run = 0) {
    if (this.busy || this.t === to) return this.t === to;
    const c = this.cloud;
    this.busy = true;
    this.heading = to;
    // zoomed in: glide back out to the whole Moon along the line of sight first, then break it up from
    // there (up close, the pictures nearest the viewer would rush at the camera from the first frame)
    if (to === 1) {
      const whole = this.pose();
      const near = c.camera.position.distanceTo(c.controls.target) < whole.position.length() * 0.9;
      if (near && !(await c.flyToPose(whole, c.shift, PULL_MS, run))) {
        this.busy = false;
        return false;
      }
    }
    if (to === 1) this.restagger();
    const from = this.t;
    const p0 = c.camera.position.clone(), q0 = c.controls.target.clone(), s0 = c.shift;
    c.shift = 0;   // both poses are framed without the wall panel's offset
    const goal = to === 1 ? c.idlePose() : this.pose();
    c.shift = s0;
    c.flying = true;
    c.controls.enabled = false;
    c.controls.autoRotate = false;
    c.mode = 'globe';
    const done = await tween(MORPH_MS, (e, raw) => {
      this.apply(from + (to - from) * raw);
      c.camera.position.lerpVectors(p0, goal.position, e);
      c.controls.target.lerpVectors(q0, goal.target, e);
      c.shift = s0 * (1 - e);
      c.applyShift();
    }, { run, easing: ease.inOutCubic });
    this.apply(done ? to : this.t);
    c.settleControls();
    c.flying = false;
    c.controls.enabled = true;
    c.lastInteract = performance.now();
    c.mode = this.t >= 1 ? 'idle' : 'globe';
    this.busy = false;
    return done;
  }

  // Start on the globe, framed.
  showWhole() {
    const c = this.cloud, g = this.pose();
    c.camera.position.copy(g.position);
    c.controls.target.copy(g.target);
    c.mode = 'globe';
    this.apply(0);
  }

  // The tile under a screen point (whole globe only): ray against the sphere, then lat/lon -> tile.
  pick(x, y) {
    if (!this.whole) return null;
    const c = this.cloud;
    const ndc = new THREE.Vector2(x / window.innerWidth * 2 - 1, 1 - y / window.innerHeight * 2);
    c.raycaster.setFromCamera(ndc, c.camera);
    const hit = c.raycaster.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), WORLD), new THREE.Vector3());
    if (!hit) return null;
    const p = hit.divideScalar(WORLD);
    const lat = Math.asin(THREE.MathUtils.clamp(p.y, -1, 1));
    if (Math.abs(THREE.MathUtils.radToDeg(lat)) > POLE_DEG) return null;
    const lon = Math.atan2(p.x, p.z);
    const tx = Math.min(this.n - 1, Math.floor((lon / Math.PI + 1) / 2 * this.n));
    const ty = Math.min(this.n - 1, Math.floor(mercRow(lat) * this.n));
    return this.indexAt.get(`${tx},${ty}`) ?? null;
  }
}
