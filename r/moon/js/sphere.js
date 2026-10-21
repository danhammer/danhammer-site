// Sphere maths shared by the Moon's globe (globe.js) and its streamed tiles (tiles.js): the unit-sphere
// convention (y up, longitude 0 toward +z), web mercator's row <-> latitude mapping, and the one lighting
// rule every surface uses, so the skin, the facets and the streamed tiles hand over without a seam.
import * as THREE from 'three';

export const POLE_DEG = 85.0511;   // web mercator's edge: beyond this the map has no data

// mercator row in [0, 1] from the north edge <-> latitude in radians
export const mercLat = (gy) => Math.atan(Math.sinh(Math.PI * (1 - 2 * gy)));
export const mercRow = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2;

// unit-sphere point for longitude and latitude in radians
export const sphereXYZ = (lon, lat) =>
  new THREE.Vector3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));

// the same in GLSL, plus the lighting: a surface is lit by how squarely it faces the viewer
export const SPHERE_GLSL = /* glsl */`
  #define PI 3.141592653589793
  float mercLat(float gy) { float s = PI * (1.0 - 2.0 * gy); return atan(0.5 * (exp(s) - exp(-s))); }
  vec3 sphere(float lon, float lat) { return vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon)); }
  float shade(vec3 n, vec3 p) { return 0.6 + 0.4 * max(dot(n, normalize(cameraPosition - p)), 0.0); }
`;
