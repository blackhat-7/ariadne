// voxel.js
// The "Voxel" look: models from voxels.js baked into meshes (exposed faces only, greedy-merged, ambient occlusion in
// the vertex colours), floating islands, the flow cart, and the render setup (moonlight with shadows, ACES, night sky).
// scene.js swaps these in when VOXEL is on; layout, picking, LOD, flows and labels are shared with the Glass look.
// Exports: BOX, uWorld, CUBE, RING, voxNode, voxIsland, setVoxAlpha, setVoxHot, voxMesh, voxCart, voxPreview, setupVoxel, followSun, refreshShadows
// Imports: state: state | theme: THEME | util: clamp | voxels: island
import * as THREE from 'three';
import { state } from './state.js';
import { THEME } from './theme.js';
import { clamp } from './util.js';
import { island } from './voxels.js';

const V = THEME.voxel;
export const BOX = new THREE.BoxGeometry(1, 1, 1);
export const uWorld = { value: 1 };   // 1 = world shown, 0 = dissolved (while a call board is open)
const uFade = { value: new THREE.Color(V.fog) };
const ONE = { value: 1 };
let spin, shadowMap = null;

/* ---------------- materials ----------------
   Baked meshes carry a colour per vertex (aColor) and one alpha and highlight per mesh (uAlpha, uHot); the moving
   voxels (clock faces, crates, the cart) are instanced unit cubes with a colour and alpha per instance. A colour above 1
   glows (lit windows, screens; selection lifts a little). A faded mesh is bleached toward the fog instead of turning
   see-through, so voxels stay opaque for shadows; only near alpha 0 (and with uWorld) it dissolves with an ordered
   dither. Modes: 0 still, 2 clock face (brightens on each second's tick), 3 crate riding the conveyor belt (x -6..6 in
   model voxels; aOff.xyz = crate centre minus this voxel, aOff.w = crate centre x; a crate shrinks away at the belt's
   end and comes back at the start). */
const MOVE = {
  0: '',
  2: 'vC *= 1.0 + 0.7 * exp(-fract(uSpin) * 7.0);',
  3: `float cx = -6.0 + mod(aOff.w + 6.0 + uSpin * 0.8, 12.0);
      transformed = (transformed - aOff.xyz) * smoothstep(-6.0, -4.5, cx) * smoothstep(6.0, 4.5, cx) + aOff.xyz; transformed.x += cx - aOff.w;`,
};

function patch(sh, mode, u = { uAlpha: ONE, uHot: ONE }) {
  Object.assign(sh.uniforms, { uSpin: spin, uWorld, uFade }, u);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>\nattribute vec3 aColor; uniform float uSpin; uniform float uAlpha; uniform float uHot; varying vec3 vC; varying float vA;
      #ifdef USE_INSTANCING
        attribute float aAlpha;
      #endif
      ${mode === 3 ? 'attribute vec4 aOff;' : ''}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vC = aColor; vA = aAlpha;
      #else
        vC = aColor * uHot; vA = uAlpha;
      #endif
      ${MOVE[mode]}`)
    .replace('#include <project_vertex>', '#include <project_vertex>\nif (vA < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <clipping_planes_pars_fragment>', '#include <clipping_planes_pars_fragment>\nuniform float uWorld; uniform vec3 uFade; varying vec3 vC; varying float vA;\nfloat bayer2(vec2 a) { a = floor(a); return fract(a.x / 2. + a.y * a.y * .75); }')
    .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (bayer2(0.5 * gl_FragCoord.xy) * 0.25 + bayer2(gl_FragCoord.xy) + 0.03125 >= smoothstep(0.0, 0.015, vA) * uWorld) discard;');
}

// Lit voxel material. u: this material's own uAlpha/uHot (baked meshes); instanced meshes share one per mode.
function voxMaterial(mode, u) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, envMapIntensity: 0 });
  m.onBeforeCompile = (sh) => {
    patch(sh, mode, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        float mx = max(vC.r, max(vC.g, vC.b)), glow = max(mx - 1.0, 0.0), fade = 1.0 - smoothstep(0.1, 0.4, vA);
        vec3 base = vC / max(mx, 1.0);
        diffuseColor.rgb = mix(base, mix(vec3(dot(base, vec3(0.2126, 0.7152, 0.0722))), uFade, 0.6), fade * 0.8);`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += base * glow * ' + V.glow.toFixed(2) + ' * (1.0 - fade);');
  };
  m.customProgramCacheKey = () => 'vox' + mode;
  return m;
}
const HOT = 1.35;   // selection and flow steps brighten a model, they do not make it glow
const mats = {};
const voxMat = (mode) => (mats[mode] ||= voxMaterial(mode));
let bakedDepth;   // shadow depth for baked meshes: dissolves with uWorld (a hidden mesh is not drawn at all)

/* ---------------- models -> voxels ----------------
   Models come from voxels.js: { voxels: [[x, y, z, r, g, b, emissive]], size: [w, h, d], anim?: { clock, crates } },
   integer cells, base on y = 0, sRGB colours, emissive 0..1, interiors already culled. Emissive voxels get a colour
   above 1, so they glow (and bloom). */
function cells(model) {
  const mode = new Map((model.anim?.clock || []).map((i) => [i, 2]));
  const crate = new Map();   // voxel index -> its crate's centre
  for (const list of model.anim?.crates || []) {
    const c = [0, 1, 2].map((k) => list.reduce((s, i) => s + model.voxels[i][k], 0) / list.length);
    for (const i of list) { mode.set(i, 3); crate.set(i, c); }
  }
  return model.voxels.map(([x, y, z, r, g, b, e], i) => {
    const m = mode.get(i) || 0, c = crate.get(i);
    return { mode: m, at: [x, y, z], color: new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace).multiplyScalar(1 + 2.4 * e), aOff: c && [c[0] - x, c[1] - y, c[2] - z, c[0]] };
  });
}

// The model fits a 2 x scale footprint and at most `height` x scale of height, base at pos.y - scale, or centred.
function fit(model, scale, centred, height) {
  const [w, h, d] = model.size, u = Math.min((2 * scale) / Math.max(w, d), (height * scale) / h);
  return { u, y0: centred ? -(h * u) / 2 : -scale };
}

// Instance entries for one model: { mode, scale, off (world, from the node centre), color, aOff }.
// `color` overrides the model's colours.
function voxEntries(model, scale, centred = false, color = null, height = 2.4) {
  const { u, y0 } = fit(model, scale, centred, height);
  return cells(model).map((c) => ({ mode: c.mode, scale: u, off: new THREE.Vector3(c.at[0] * u, y0 + (c.at[1] + 0.5) * u, c.at[2] * u), color: color || c.color, aOff: c.aOff }));
}

// One centred cube (functions, proxies, ports, in the node colour) and the "changed" ring on the ground.
export const CUBE = { voxels: [[0, 0, 0, 1, 1, 1, 0]], size: [1.3, 1.3, 1.3] };
export const RING = { voxels: [], size: [15, 15, 15] };
for (let x = -7; x <= 7; x++) for (let z = -7; z <= 7; z++) if (Math.abs(Math.hypot(x, z) - 6) < 0.55) RING.voxels.push([x, 0, z, 1, 1, 1, 0]);

/* ---------------- baking ----------------
   Exposed faces only. Each face corner gets the classic voxel AO from its 3 neighbours in front of the face (two
   sides and the corner between them); quads are split along the diagonal that avoids AO anisotropy. Faces of one
   colour with even AO merge into larger quads (greedy meshing). Glowing voxels are not darkened. */
const key = (x, y, z) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
const AO = [0.45, 0.64, 0.82, 1];
const CORNER = [[-1, -1], [1, -1], [1, 1], [-1, 1]];   // counter-clockwise seen from the face's front (for +normal)

// list: the cells to bake; solid: keys of every cell that hides a face or occludes (list plus fixed neighbours).
function bake(list, solid) {
  const occ = (p) => solid.has(key(p[0], p[1], p[2])), q = [0, 0, 0];
  const planes = new Map();   // one per face direction and layer: Map(u,v -> face)
  for (const c of list) {
    const p = c.at, glow = Math.max(c.color.r, c.color.g, c.color.b) > 1;
    for (let d = 0; d < 3; d++) for (const s of [1, -1]) {
      q[0] = p[0]; q[1] = p[1]; q[2] = p[2]; q[d] += s;
      if (occ(q)) continue;
      const a = (d + 1) % 3, b = (d + 2) % 3, ao = [3, 3, 3, 3];
      if (!glow) CORNER.forEach(([i, j], k) => {
        q[a] = p[a] + i; const s1 = occ(q);
        q[b] = p[b] + j; const cr = occ(q);
        q[a] = p[a]; const s2 = occ(q); q[b] = p[b];
        ao[k] = s1 && s2 ? 0 : 3 - s1 - s2 - cr;
      });
      const pk = d * 2 + (s > 0) + ',' + p[d];
      if (!planes.has(pk)) planes.set(pk, { d, s, layer: p[d], faces: new Map() });
      const even = ao[0] === ao[1] && ao[1] === ao[2] && ao[2] === ao[3];
      planes.get(pk).faces.set(key(p[a], 0, p[b]), { u: p[a], v: p[b], ao, color: c.color, merge: even ? `${c.color.r},${c.color.g},${c.color.b},${ao[0]}` : null, done: false });
    }
  }
  const pos = [], nor = [], col = [], idx = [], P = [0, 0, 0], N = [0, 0, 0];
  for (const { d, s, layer, faces } of planes.values()) {
    const a = (d + 1) % 3, b = (d + 2) % 3;
    N[0] = N[1] = N[2] = 0; N[d] = s;
    const sorted = [...faces.values()].sort((f, g) => f.v - g.v || f.u - g.u);
    for (const f of sorted) {
      if (f.done) continue;
      let w = 1, h = 1;
      const same = (u, v) => { const g = faces.get(key(u, 0, v)); return g && !g.done && g.merge === f.merge; };
      if (f.merge) {
        while (same(f.u + w, f.v)) w++;
        for (; ; h++) { let row = true; for (let i = 0; i < w && row; i++) row = same(f.u + i, f.v + h); if (!row) break; }
      }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) faces.get(key(f.u + i, 0, f.v + j)).done = true;
      const u0 = f.u - 0.5, u1 = f.u + w - 0.5, v0 = f.v - 0.5, v1 = f.v + h - 0.5, base = pos.length / 3;
      const order = s > 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
      for (const k of order) {
        P[d] = layer + s * 0.5; P[a] = CORNER[k][0] < 0 ? u0 : u1; P[b] = CORNER[k][1] < 0 ? v0 : v1;
        const l = AO[f.ao[k]];
        pos.push(P[0], P[1], P[2]); nor.push(N[0], N[1], N[2]); col.push(f.color.r * l, f.color.g * l, f.color.b * l);
      }
      const o = order.map((k) => f.ao[k]);
      if (o[0] + o[2] > o[1] + o[3]) idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
      else idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// A baked mesh: casts and receives shadows; its own material holds its alpha and highlight.
function bakedMesh(list, solid) {
  const u = { uAlpha: { value: 1 }, uHot: { value: 1 } };
  const mesh = new THREE.Mesh(bake(list, solid), voxMaterial(0, u));
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.customDepthMaterial = bakedDepth;
  mesh.userData.u = u;
  return mesh;
}

// A node's model: its still voxels baked into one mesh at pos (scale, centred and height as in fit()); its moving
// voxels (clock faces, crates) come back as instance entries (see voxEntries). top: the model's top above pos.y.
export function voxNode(model, scale, centred, color, height, pos) {
  const { u, y0 } = fit(model, scale, centred, height), all = cells(model);
  if (color) for (const c of all) c.color = color;
  const still = all.filter((c) => !c.mode);
  const mesh = bakedMesh(still, new Set(all.filter((c) => c.mode !== 3).map((c) => key(...c.at))));   // crates move away: they hide nothing
  mesh.position.set(pos.x, pos.y + y0 + 0.5 * u, pos.z); mesh.scale.setScalar(u);
  mesh.updateMatrix(); mesh.matrixAutoUpdate = false;
  const moving = all.filter((c) => c.mode).map((c) => ({ mode: c.mode, scale: u, off: new THREE.Vector3(c.at[0] * u, y0 + (c.at[1] + 0.5) * u, c.at[2] * u), color: c.color, aOff: c.aOff }));
  return { mesh, moving, top: y0 + (model.size[1] + 0.5) * u };
}

/* ---------------- islands ---------------- */
// A cluster or dock island of world radius R: at most 27 voxels across the radius (about 6000 voxels), so big domains
// get bigger voxels. The grass ends at topY (model.top is the first free layer above it).
export function voxIsland(seed, R, tint, cx, cz, topY) {
  const tile = Math.max(1, R / 27), model = island(seed, Math.round(R / tile), tint), list = cells(model);
  const mesh = bakedMesh(list, new Set(list.map((c) => key(...c.at))));
  mesh.position.set(cx, topY + (0.5 - model.top) * tile, cz); mesh.scale.setScalar(tile);
  mesh.updateMatrix(); mesh.matrixAutoUpdate = false;
  return mesh;
}

// Fade (bleach) a baked mesh; it is not drawn at all near 0. Returns whether anything changed.
export function setVoxAlpha(mesh, a) {
  const u = mesh.userData.u.uAlpha;
  if (u.value === a) return false;
  u.value = a;
  const vis = a >= 0.004;
  if (vis !== mesh.visible) { mesh.visible = vis; refreshShadows(); }
  return true;
}
export function setVoxHot(mesh, on) { mesh.userData.u.uHot.value = on ? HOT : 1; }

// Instanced unit cubes for the moving voxels of one mode (scene.js fills matrices, colours, alpha and aOff). They
// receive shadows but cast none, so they never invalidate the shadow map.
export function voxMesh(geo, mode, count) {
  const mesh = new THREE.InstancedMesh(geo, voxMat(mode), count);
  mesh.receiveShadow = true; mesh.material.userData.hot = HOT;
  return mesh;
}

/* ---------------- flow cart ---------------- */
// The flow pulse: the cart model, about 1 unit across at scale 1, centred; its emissive voxels bloom.
export function voxCart(model) {
  const list = voxEntries(model, 0.5, true), geo = BOX.clone(), mesh = voxMesh(geo, 0, list.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), col = new Float32Array(list.length * 3);
  list.forEach((e, i) => { mesh.setMatrixAt(i, m4.compose(e.off, q, s.setScalar(e.scale))); e.color.toArray(col, i * 3); });
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(col, 3));
  geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(list.length).fill(1), 1));
  mesh.frustumCulled = false;
  return mesh;
}

// A model as one small instanced mesh with plain instance colours (legend icons).
export function voxPreview(model) {
  const list = voxEntries(model, 1.1), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const mesh = new THREE.InstancedMesh(BOX, new THREE.MeshStandardMaterial({ roughness: 0.8 }), list.length);
  list.forEach((e, i) => { mesh.setMatrixAt(i, m4.compose(e.off, q, s.setScalar(e.scale))); mesh.setColorAt(i, e.color.clone().multiplyScalar(1 / Math.max(1, e.color.r, e.color.g, e.color.b))); });
  return mesh;
}

/* ---------------- render setup ---------------- */
let sun;
const sunDir = new THREE.Vector3(0.55, 1, 0.38).normalize(), sunRight = new THREE.Vector3(), sunUp = new THREE.Vector3(), snap = new THREE.Vector3();
const SHADOW = 2048;

// The shadow map is drawn only when asked: when the sun's frustum moves or what casts shadows changes.
export function refreshShadows() { if (shadowMap) shadowMap.needsUpdate = state.redraw = true; }

// Moonlight (with shadows unless `low`), sky fill, sky gradient, fog colour, ACES, bloom settings.
export function setupVoxel({ renderer, scene, bloom, spinTime, skyTexture, low }) {
  spin = spinTime;
  document.body.classList.add('voxel');   // label halos (hud.css)
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = V.exposure;
  scene.background = skyTexture([V.skyTop, V.skyMid, V.skyLow]);
  scene.fog.color.set(V.fog);
  sun = new THREE.DirectionalLight(V.sun, V.sunI);
  if (!low) {
    shadowMap = renderer.shadowMap;
    Object.assign(shadowMap, { enabled: true, type: THREE.PCFShadowMap, autoUpdate: false, needsUpdate: true });
    sun.castShadow = true; sun.shadow.mapSize.set(SHADOW, SHADOW); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 1.6;
  }
  bakedDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  bakedDepth.onBeforeCompile = (sh) => patch(sh, 0);
  bakedDepth.customProgramCacheKey = () => 'voxdepth';
  scene.add(sun, sun.target, new THREE.HemisphereLight(V.sky, V.ground, V.hemiI));
  sunRight.crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize(); sunUp.crossVectors(sunDir, sunRight);
  Object.assign(bloom, { strength: V.bloom.strength, radius: V.bloom.radius, threshold: V.bloom.threshold });
}

// Keep the shadow camera on what is in view: sized to the camera distance (in steps), moved in steps of 1/16 of its
// size (snapped to shadow texels), so a small pan does not redraw the shadow map.
export function followSun(target, dist) {
  if (!shadowMap) return;
  const half = 24 * 1.25 ** Math.ceil(Math.log(clamp(dist * 0.85, 24, 600) / 24) / Math.log(1.25)), cam = sun.shadow.camera;
  if (cam.right !== half) {
    Object.assign(cam, { left: -half, right: half, top: half, bottom: -half, near: 1, far: half * 6 + 200 });
    cam.updateProjectionMatrix(); refreshShadows();
  }
  const step = Math.round(SHADOW / 32) * (2 * half) / SHADOW;
  snap.copy(sunRight).multiplyScalar(Math.round(target.dot(sunRight) / step) * step)
    .addScaledVector(sunUp, Math.round(target.dot(sunUp) / step) * step).addScaledVector(sunDir, Math.round(target.dot(sunDir) / step) * step);
  if (snap.equals(sun.target.position)) return;
  sun.target.position.copy(snap);
  sun.position.copy(snap).addScaledVector(sunDir, half * 3 + 100);
  refreshShadows();
}
