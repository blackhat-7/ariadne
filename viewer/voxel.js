// voxel.js
// The "Voxel" look: models from voxels.js drawn as instanced unit cubes, floating islands, the flow cart, and the
// render setup (sun with soft shadows, GTAO, ACES, night sky). scene.js swaps these in when VOXEL is on; layout,
// picking, LOD, flows and labels are shared with the Glass look.
// Exports: BOX, uWorld, CUBE, RING, voxMat, voxEntries, voxIsland, setIslandAlpha, voxMesh, voxCart, voxPreview, setupVoxel, followSun
// Imports: theme: THEME | util: clamp | voxels: island
import * as THREE from 'three';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { THEME } from './theme.js';
import { clamp } from './util.js';
import { island } from './voxels.js';

const V = THEME.voxel;
export const BOX = new THREE.BoxGeometry(1, 1, 1);
export const uWorld = { value: 1 };   // 1 = world shown, 0 = dissolved (while a call board is open)
const uFade = { value: new THREE.Color(V.fog) };
let spin;

/* ---------------- materials ----------------
   Per-instance colour (aColor) and visibility (aAlpha), as the Glass solids. A colour above 1 glows (lit windows,
   screens; selection lifts a little). A faded instance is bleached toward the fog instead of turning see-through, so
   voxels stay opaque for shadows and AO; only near alpha 0 (and with uWorld) it dissolves with an ordered dither. Modes: 0 still,
   2 clock face (brightens on each second's tick), 3 crate riding the conveyor belt (x -6..6 in model voxels; aOff.xyz =
   crate centre minus this voxel, aOff.w = crate centre x; a crate shrinks away at the belt's end and comes back at the start). */
const MOVE = {
  0: '',
  2: 'vC *= 1.0 + 0.7 * exp(-fract(uSpin) * 7.0);',
  3: `float cx = -6.0 + mod(aOff.w + 6.0 + uSpin * 0.8, 12.0);
      transformed = (transformed - aOff.xyz) * smoothstep(-6.0, -4.5, cx) * smoothstep(6.0, 4.5, cx) + aOff.xyz; transformed.x += cx - aOff.w;`,
};

function patch(sh, mode) {
  Object.assign(sh.uniforms, { uSpin: spin, uWorld, uFade });
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>\nattribute vec3 aColor; attribute float aAlpha; uniform float uSpin; varying vec3 vC; varying float vA;\n${mode === 3 ? 'attribute vec4 aOff;' : ''}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\nvC = aColor; vA = aAlpha; ${MOVE[mode]}`)
    .replace('#include <project_vertex>', '#include <project_vertex>\nif (aAlpha < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <clipping_planes_pars_fragment>', '#include <clipping_planes_pars_fragment>\nuniform float uWorld; uniform vec3 uFade; varying vec3 vC; varying float vA;\nfloat bayer2(vec2 a) { a = floor(a); return fract(a.x / 2. + a.y * a.y * .75); }')
    .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (bayer2(0.5 * gl_FragCoord.xy) * 0.25 + bayer2(gl_FragCoord.xy) + 0.03125 >= smoothstep(0.0, 0.015, vA) * uWorld) discard;');
}

const mats = {};
// Lit material (with its shadow-depth twin) for one animation mode.
export function voxMat(mode) {
  if (mats[mode]) return mats[mode];
  const m = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, envMapIntensity: 0 });
  m.userData.hot = 1.35;   // recolor(): selection brightens, it does not glow
  m.onBeforeCompile = (sh) => {
    patch(sh, mode);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        float mx = max(vC.r, max(vC.g, vC.b)), glow = max(mx - 1.0, 0.0), fade = 1.0 - smoothstep(0.1, 0.4, vA);
        vec3 base = vC / max(mx, 1.0);
        diffuseColor.rgb = mix(base, mix(vec3(dot(base, vec3(0.2126, 0.7152, 0.0722))), uFade, 0.6), fade * 0.8);`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += base * glow * ' + V.glow.toFixed(2) + ' * (1.0 - fade);');
  };
  m.customProgramCacheKey = () => 'vox' + mode;
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  d.onBeforeCompile = (sh) => patch(sh, mode);
  d.customProgramCacheKey = () => 'voxdepth' + mode;
  return (mats[mode] = { mat: m, depth: d });
}

// A voxel mesh casts and receives shadows; meshes that keep their shape also feed the AO pass.
function solid(mesh, mode) {
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.customDepthMaterial = voxMat(mode).depth;
  mesh.userData.ao = mode !== 3;
  return mesh;
}

/* ---------------- models -> instances ----------------
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

// Instance entries for one model: { mode, scale, off (world, from the node centre), color, aOff }. The model fits a
// 2 x scale footprint and at most 2.4 x scale of height (under the node's label), base at pos.y - scale, or centred.
// `color` overrides the model's colours.
export function voxEntries(model, scale, centred = false, color = null) {
  const [w, h, d] = model.size, u = Math.min((2 * scale) / Math.max(w, d), (2.4 * scale) / h), y0 = centred ? -(h * u) / 2 : -scale;
  return cells(model).map((c) => ({ mode: c.mode, scale: u, off: new THREE.Vector3(c.at[0] * u, y0 + (c.at[1] + 0.5) * u, c.at[2] * u), color: color || c.color, aOff: c.aOff }));
}

// One centred cube (functions, proxies, ports, in the node colour) and the "changed" ring on the ground.
export const CUBE = { voxels: [[0, 0, 0, 1, 1, 1, 0]], size: [1.3, 1.3, 1.3] };
export const RING = { voxels: [], size: [15, 15, 15] };
for (let x = -7; x <= 7; x++) for (let z = -7; z <= 7; z++) if (Math.abs(Math.hypot(x, z) - 6) < 0.55) RING.voxels.push([x, 0, z, 1, 1, 1, 0]);

/* ---------------- islands ---------------- */
// A cluster or dock island of world radius R: at most 27 voxels across the radius (about 6000 voxels), so big domains
// get bigger voxels. The grass ends at topY (model.top is the first free layer above it).
export function voxIsland(seed, R, tint, cx, cz, topY) {
  const tile = Math.max(1, R / 27), model = island(seed, Math.round(R / tile), tint), list = cells(model);
  const geo = BOX.clone(), mesh = new THREE.InstancedMesh(geo, voxMat(0).mat, list.length), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3().setScalar(tile);
  const col = new Float32Array(list.length * 3), al = new THREE.InstancedBufferAttribute(new Float32Array(list.length).fill(1), 1);
  list.forEach((c, i) => { mesh.setMatrixAt(i, m4.compose(p.set(cx + c.at[0] * tile, topY + (c.at[1] - model.top + 0.5) * tile, cz + c.at[2] * tile), q, s)); c.color.toArray(col, i * 3); });
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(col, 3)); geo.setAttribute('aAlpha', al);
  mesh.userData.alpha = al; mesh.userData.a = 1;
  mesh.computeBoundingSphere();
  return solid(mesh, 0);
}

export function setIslandAlpha(mesh, a) {
  if (mesh.userData.a === a) return;
  mesh.userData.a = a; mesh.userData.alpha.array.fill(a); mesh.userData.alpha.needsUpdate = true;
}

// Instanced mesh for node voxels of one mode (scene.js fills matrices, colours, alpha and aOff).
export function voxMesh(geo, mode, count) { return solid(new THREE.InstancedMesh(geo, voxMat(mode).mat, count), mode); }

/* ---------------- flow cart ---------------- */
// The flow pulse: the cart model, about 1 unit across at scale 1, centred; its emissive voxels bloom.
export function voxCart(model) {
  const list = voxEntries(model, 0.5, true), geo = BOX.clone(), mesh = solid(new THREE.InstancedMesh(geo, voxMat(0).mat, list.length), 0);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), col = new Float32Array(list.length * 3);
  list.forEach((e, i) => { mesh.setMatrixAt(i, m4.compose(e.off, q, s.setScalar(e.scale))); e.color.toArray(col, i * 3); });
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(col, 3));
  geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(list.length).fill(1), 1));
  mesh.userData.ao = false; mesh.frustumCulled = false;
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

// Shadows, sun + sky fill, sky gradient, fog colour, ACES, and GTAO inserted before bloom.
export function setupVoxel({ renderer, scene, camera, composer, bloom, spinTime, skyTexture }) {
  spin = spinTime;
  document.body.classList.add('voxel');   // label halos (hud.css)
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = V.exposure;
  scene.background = skyTexture([V.skyTop, V.skyMid, V.skyLow]);
  scene.fog.color.set(V.fog);
  sun = new THREE.DirectionalLight(V.sun, V.sunI);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target, new THREE.HemisphereLight(V.sky, V.ground, V.hemiI));
  sunRight.crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize(); sunUp.crossVectors(sunDir, sunRight);
  // AO at CSS-pixel resolution with few samples; only still voxel meshes go into its normal/depth buffer
  const pr = renderer.getPixelRatio();
  const ao = new GTAOPass(scene, camera, innerWidth, innerHeight, undefined, { radius: 1.4, distanceExponent: 1.6, thickness: 1.4, scale: 1.15, samples: 8 }, { samples: 8, radius: 5 });
  ao.setSize = (w, h) => GTAOPass.prototype.setSize.call(ao, w / pr, h / pr);
  ao.overrideVisibility = function () {
    this.scene.traverse((o) => { this._visibilityCache.set(o, o.visible); if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && !o.userData.ao) o.visible = false; });
  };
  ao.normalMaterial.onBeforeCompile = (sh) => patch(sh, 0);
  ao.normalMaterial.customProgramCacheKey = () => 'voxnormal';
  composer.insertPass(ao, 1);
  Object.assign(bloom, { strength: V.bloom.strength, radius: V.bloom.radius, threshold: V.bloom.threshold });
}

// Keep the shadow camera on what is in view: sized to the camera distance (in steps), snapped to shadow texels.
export function followSun(target, dist) {
  const half = 24 * 1.25 ** Math.ceil(Math.log(clamp(dist * 0.85, 24, 600) / 24) / Math.log(1.25)), cam = sun.shadow.camera;
  if (cam.right !== half) {
    Object.assign(cam, { left: -half, right: half, top: half, bottom: -half, near: 1, far: half * 6 + 200 });
    cam.updateProjectionMatrix();
  }
  const texel = (2 * half) / 2048;
  snap.copy(sunRight).multiplyScalar(Math.round(target.dot(sunRight) / texel) * texel)
    .addScaledVector(sunUp, Math.round(target.dot(sunUp) / texel) * texel).addScaledVector(sunDir, target.dot(sunDir));
  sun.target.position.copy(snap);
  sun.position.copy(snap).addScaledVector(sunDir, half * 3 + 100);
}
