// scene.js
// Exports: LOW, setResolution, solidMats, shadowMat, lineRes, spinTime, bgColor, fatLoop, slab, stage, renderer, scene, camera, controls, rt, composer, bloom, uTime, nodeMats, ATLAS, CELL, atlasCv, atlasCtx, atlasCells, LUCIDE, atlasTex, atlasCell, iconMat, lineMat, tubeMat, shellMat, LineSet, curve, parts, clusters, exts, docks, nodes, nodeByKey, meshes, linkSet, trackSet, streams, at, merge, G, SHAPES, AMBER, addNode, shapeOfPart, partScale, build, buildDetail, kindOn, recolor, setEmphasis, dimOf, camPos, updateLOD, fly, fv, flyTo, updateViewOffset, updateFly, flyOverview, flyToEnt, resolveEnt, entFromNode, findEnt, select, labelOf, dive, ray, ndc, pick, entFromEvent, player, MOVE, STEP, pulseTex, pulse, trailGeo, trail, flowById, actorPos, actorKey, playFlow, gotoStep, stopFlow, pv, updatePlayer, isMac, isTrackpad, navPlane, navP, navN, navR, navU, zoomAt, panBy, gestureOpts, initThreeSetup, initShaders, initWorldModel, initState, initLod, initCameraFlight, initPicking, initFlowPlayback, initNavigation
// Imports: state: state | board: boardNear, flyToBoard, openLens, setFacing, updateStructs | drawer: codeHtml, drawer, openFile | hud: Label, closeDetail, detail, hoverEl, openCode, showDetail | theme: EXT, KINDS, PORTS, QUALITY, THEME, VOXEL, extOf, kindOf | util: $, V3, clamp, ease, esc, hashStr, rng, smooth | voice: cancelSpeech, pauseSpeech, renderVoiceButton, resumeSpeech, speak, stepSpeech, voice | voxel: BOX, CUBE, RING, followSun, refreshShadows, setVoxAlpha, setVoxHot, setupVoxel, uWorld, voxCart, voxIsland, voxMesh, voxNode | voxels: cart, externalModel, partModel
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { state } from './state.js';
import { boardNear, flyToBoard, openLens, setFacing, updateStructs } from './board.js';
import { codeHtml, drawer, openFile } from './drawer.js';
import { Label, closeDetail, detail, hoverEl, openCode, showDetail } from './hud.js';
import { EXT, KINDS, PORTS, QUALITY, THEME, VOXEL, extOf, kindOf, mute } from './theme.js';
import { $, V3, clamp, ease, esc, hashStr, reducedMotion, rng, smooth, spring } from './util.js';
import { cancelSpeech, pauseSpeech, renderVoiceButton, resumeSpeech, speak, speakFlow, stepSpeech, voice } from './voice.js';
import { BOX, CUBE, RING, followSun, refreshShadows, setVoxAlpha, setVoxHot, setupVoxel, uWorld, voxCart, voxIsland, voxMesh, voxNode } from './voxel.js';
import { cart, externalModel, partModel } from './voxels.js';

export let LOW, stage, renderer, scene, camera, controls, rt, composer, bloom, uTime, nodeMats, ATLAS, CELL, atlasCv, atlasCtx, atlasCells, LUCIDE, atlasTex, iconMat, lineMat, tubeMat, shellMat, parts, clusters, exts, docks, nodes, nodeByKey, meshes, linkSet, trackSet, streams, at, merge, G, SHAPES, AMBER, shapeOfPart, partScale, kindOn, dimOf, camPos, fly, fv, flyOverview, ray, ndc, player, MOVE, STEP, pulseTex, pulse, trailGeo, trail, pv, isMac, navPlane, navP, navN, navR, navU, gestureOpts, solidMats, shadowMat, lineRes, spinTime, bgColor;
let glassMat, floorShadowMat, floorShadowGeo;

export function atlasCell(name) {
  if (atlasCells.has(name)) return atlasCells.get(name);
  const i = atlasCells.size, x = (i % (ATLAS / CELL)) * CELL, y = Math.floor(i / (ATLAS / CELL)) * CELL, g = atlasCtx;
  g.save(); g.translate(x, y);
  g.fillStyle = 'rgba(2,10,18,.78)'; g.beginPath(); g.arc(CELL / 2, CELL / 2, CELL * 0.46, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 3; g.stroke();
  g.strokeStyle = g.fillStyle = '#fff';
  if (LUCIDE[name]) {
    g.translate(CELL * 0.2, CELL * 0.2); g.scale((CELL * 0.6) / 24, (CELL * 0.6) / 24);
    g.lineWidth = 2.2; g.lineCap = g.lineJoin = 'round';
    for (const d of LUCIDE[name]) g.stroke(new Path2D(d));
  } else {
    g.font = `600 ${name.length > 1 ? 52 : 66}px ui-monospace,Menlo,Consolas,monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name, CELL / 2, CELL / 2 + 3);
  }
  g.restore();
  atlasCells.set(name, i); atlasTex.needsUpdate = state.redraw = true; return i;
}

/* ---------------- line set (one fat-line geometry, many polylines; per-segment alpha and pulse) ---------------- */
export class LineSet {
  constructor(speed, spacing, base) { this.pos = []; this.d = []; this.col = []; this.items = []; this.hot = 0; this.mat = lineMat(speed, spacing, base); }
  add(points, color, owner) {
    const start = this.pos.length / 6; let acc = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1], l = a.distanceTo(b);
      this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z); this.d.push(acc, acc + l); acc += l;
      this.col.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
    const it = { start, count: this.pos.length / 6 - start, alpha: -1, pulse: -1, color, owner };
    this.items.push(it); return it;
  }
  build() {
    const g = new LineSegmentsGeometry(), n = this.pos.length / 6;
    g.setPositions(this.pos); g.setColors(this.col);
    g.setAttribute('instanceD', new THREE.InstancedBufferAttribute(new Float32Array(this.d), 2));
    this.alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(n), 1); this.alphaAttr.setUsage(THREE.DynamicDrawUsage); g.setAttribute('instanceAlpha', this.alphaAttr);
    this.pulseAttr = new THREE.InstancedBufferAttribute(new Float32Array(n), 1); this.pulseAttr.setUsage(THREE.DynamicDrawUsage); g.setAttribute('instancePulse', this.pulseAttr);
    this.obj = new LineSegments2(g, this.mat); this.obj.frustumCulled = false; scene.add(this.obj);
    this.pos = this.d = this.col = null;
  }
  setAlpha(it, a, pulse = 0) {
    a = Math.round(a * 200) / 200;
    this.hot -= it.pulse > 0 && it.alpha > 0;
    this.hot += pulse > 0 && a > 0;
    if (a !== it.alpha) { it.alpha = a; this.alphaAttr.array.fill(a, it.start, it.start + it.count); this.dirty = true; }
    if (pulse !== it.pulse) { it.pulse = pulse; this.pulseAttr.array.fill(pulse, it.start, it.start + it.count); this.pdirty = true; }
  }
  // Upload what changed; visible pulses run every frame.
  flush() {
    if (this.dirty) { this.alphaAttr.needsUpdate = true; this.dirty = false; state.redraw = true; }
    if (this.pdirty) { this.pulseAttr.needsUpdate = true; this.pdirty = false; state.redraw = true; }
    if (this.hot) state.redraw = true;
  }
}

export function curve(a, b, lift, bend) {
  const mid = new V3().addVectors(a, b).multiplyScalar(0.5), len = a.distanceTo(b);
  const side = new V3().subVectors(b, a).cross(new V3(0, 1, 0)).normalize();
  mid.y += len * lift; mid.addScaledVector(side, len * bend);
  return new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
}

/* ---------------- rounded geometry ---------------- */
// Round every corner of a 2D polyline with radius r (closed loop, or open with its two ends kept).
function fillet(pts, r, closed, seg = 8) {
  const out = [], n = pts.length;
  for (let i = 0; i < n; i++) {
    const P = pts[i];
    if (!closed && (i === 0 || i === n - 1)) { out.push(P); continue; }
    const d1 = pts[(i + n - 1) % n].clone().sub(P).normalize(), d2 = pts[(i + 1) % n].clone().sub(P).normalize();
    const half = Math.acos(clamp(d1.dot(d2), -1, 1)) / 2;
    const C = P.clone().addScaledVector(d1.clone().add(d2).normalize(), r / Math.sin(half));
    const T1 = P.clone().addScaledVector(d1, r / Math.tan(half)), T2 = P.clone().addScaledVector(d2, r / Math.tan(half));
    const a1 = Math.atan2(T1.y - C.y, T1.x - C.x);
    let da = Math.atan2(T2.y - C.y, T2.x - C.x) - a1;
    if (da > Math.PI) da -= Math.PI * 2; else if (da < -Math.PI) da += Math.PI * 2;
    for (let k = 0; k <= seg; k++) out.push(new THREE.Vector2(C.x + r * Math.cos(a1 + (da * k) / seg), C.y + r * Math.sin(a1 + (da * k) / seg)));
  }
  return out;
}
const v2 = (pts) => pts.map(([x, y]) => new THREE.Vector2(x, y));
// Smooth solid of revolution from an (radius, height) profile with rounded corners.
const lathe = (pts, r, closed = false) => { const p = fillet(v2(pts), r, closed); if (closed) p.push(p[0].clone()); return new THREE.LatheGeometry(p, 64); };
const regular = (n, R, a0 = 0) => Array.from({ length: n }, (_, i) => [R * Math.sin(a0 + (i / n) * Math.PI * 2), R * Math.cos(a0 + (i / n) * Math.PI * 2)]);
const rect = (w, d) => [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];

// Bevelled slab: a convex outline (x, z) with rounded corners, height h, edges rounded with radius r. Analytic smooth normals.
export function slab(corners, cornerR, h, r, rs = 5) {
  const ol = fillet(v2(corners), cornerR, true), n = ol.length, cx = ol.reduce((s, p) => s + p.x, 0) / n, cz = ol.reduce((s, p) => s + p.y, 0) / n;
  const N = ol.map((p, i) => { const a = ol[(i + n - 1) % n], b = ol[(i + 1) % n], v = new THREE.Vector2(b.y - a.y, a.x - b.x).normalize(); return v.dot(new THREE.Vector2(p.x - cx, p.y - cz)) < 0 ? v.negate() : v; });
  const pos = [], nor = [], tris = [], vert = (x, y, z, a, b, c) => { pos.push(x, y, z); nor.push(a, b, c); return pos.length / 3 - 1; };
  const rings = [];
  for (let k = 0; k <= rs * 2 + 1; k++) {
    const top = k > rs, phi = ((top ? k - rs - 1 : k) / rs - (top ? 0 : 1)) * Math.PI / 2, off = r * Math.cos(phi) - r, y = (top ? h / 2 - r : -h / 2 + r) + r * Math.sin(phi);
    rings.push(ol.map((p, i) => vert(p.x + N[i].x * off, y, p.y + N[i].y * off, N[i].x * Math.cos(phi), Math.sin(phi), N[i].y * Math.cos(phi))));
  }
  for (let k = 0; k < rings.length - 1; k++) for (let i = 0; i < n; i++) { const a = rings[k][i], b = rings[k][(i + 1) % n], c = rings[k + 1][i], d = rings[k + 1][(i + 1) % n]; tris.push([a, b, c], [b, d, c]); }
  for (const [ring, s] of [[rings[0], -1], [rings[rings.length - 1], 1]]) {
    const c = vert(cx, s * h / 2, cz, 0, s, 0), cap = ring.map((j) => vert(pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2], 0, s, 0));
    for (let i = 0; i < n; i++) tris.push([c, cap[i], cap[(i + 1) % n]]);
  }
  // wind every triangle to face along its vertex normal
  const P = (j) => new V3(pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]), idx = [];
  for (const [a, b, c] of tris) {
    const fn = P(b).sub(P(a)).cross(P(c).sub(P(a)));
    if (fn.dot(new V3(nor[a * 3], nor[a * 3 + 1], nor[a * 3 + 2])) < 0) idx.push(a, c, b); else idx.push(a, b, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2)); g.setIndex(idx);
  return g;
}

// Static constant-pixel-width line loops (orbit, plate outlines, ring guides).
export function fatLoop(loops, color, opacity, width = 1) {
  const pos = [];
  for (const pts of loops) for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; pos.push(a.x, a.y, a.z, b.x, b.y, b.z); }
  const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthWrite: false });
  m.uniforms.resolution.value = lineRes;
  const o = new LineSegments2(new LineSegmentsGeometry().setPositions(pos), m); o.frustumCulled = false;
  return o;
}
const circle = (R, y, n = 192) => Array.from({ length: n }, (_, i) => new V3(Math.cos((i / n) * Math.PI * 2) * R, y, Math.sin((i / n) * Math.PI * 2) * R));

export function addNode(key, type, shape, pos, scale, color, extra) {
  const n = { key, type, shape, pos, scale, base: new THREE.Color(color), alpha: 0, icons: [], ...extra };
  nodes.push(n); nodeByKey.set(key, n); return n;
}

export function build() {
  const rand = rng(hashStr(state.M.title || 'ariadne'));
  // clusters (create any referenced but missing)
  for (const c of state.M.clusters || []) clusters.set(c.id, { ...c, color: mute(c.color || THEME.accent), parts: [] });
  for (const p of state.M.parts || []) {
    if (!clusters.has(p.cluster)) clusters.set(p.cluster, { id: p.cluster || 'other', name: p.cluster || 'Other', summary: '', color: THEME.neutral, parts: [] });
    const P = { ...p, links: [], neighbors: new Set() };
    parts.set(p.id, P); clusters.get(p.cluster).parts.push(P);
  }
  for (const e of state.M.externals || []) exts.set(e.id, { ...e, links: [], users: new Set() });
  const cl = [...clusters.values()].filter((c) => c.parts.length);
  const RING = { service: 0, job: 1, library: 2, tool: 2 };
  for (const c of cl) {
    c.parts.sort((a, b) => RING[kindOf(a)] - RING[kindOf(b)] || (b.size || 0) - (a.size || 0) || a.id.localeCompare(b.id));
    c.rings = []; let r = 0;
    for (let k = 0; k < 3; k++) {
      const list = c.parts.filter((p) => RING[kindOf(p)] === k);
      if (!list.length) continue;
      const radius = !c.rings.length && list.length === 1 ? 0 : Math.max(c.rings.length ? r + 13 : 9, (list.length * 16) / (Math.PI * 2));
      c.rings.push({ radius, list }); r = radius;
    }
    c.r = Math.max(14, r + 10);
    c.colorObj = new THREE.Color(c.color || THEME.accent);
  }
  const circ = cl.reduce((s, c) => s + 2 * c.r + 120, 0);
  state.Rsys = cl.length < 2 ? 0 : Math.max(45, circ / (2 * Math.PI));
  cl.forEach((c, i) => {
    const a = (i / cl.length) * Math.PI * 2 + (rand() - 0.5) * 0.12;
    const rr = state.Rsys * (0.94 + rand() * 0.12);
    c.angle = a; c.pos = new V3(Math.cos(a) * rr, Math.sin(a + 0.6) * state.Rsys * 0.14, Math.sin(a) * rr);
    c.rings.forEach((ring, k) => ring.list.forEach((p, j) => {
      const th = (j / ring.list.length) * Math.PI * 2 + a + k * 0.6;
      p.pos = new V3(c.pos.x + Math.cos(th) * ring.radius, c.pos.y, c.pos.z + Math.sin(th) * ring.radius);
      p.r = partScale(p);
      if (VOXEL) { p.r *= 1.5; p.pos.y = c.pos.y - 1.2 + p.r; }   // a little bigger beside terrain voxels; standing on the island (base at pos.y - r)
      p.clusterObj = c;
    }));
  });
  for (const c of clusters.values()) if (!c.pos) { c.pos = new V3(); c.r = 10; c.colorObj = new THREE.Color(c.color || THEME.neutral); }
  // links
  const links = [];
  for (const l of state.M.links || []) {
    const a = parts.get(l.from), b = parts.get(l.to) || exts.get(l.to);
    if (!a || !b || a === b) continue;
    const L = { ...l, a, b, toExt: !parts.has(l.to), weight: l.weight || 1 };
    links.push(L); a.links.push(L); b.links.push(L); a.neighbors.add(l.to);
    if (L.toExt) b.users.add(a.id); else b.neighbors.add(a.id);
  }
  for (const p of parts.values()) for (const u of p.uses || []) if (exts.has(u.target)) exts.get(u.target).users.add(p.id);
  // externals on the outer ring, near the parts that use them
  for (const e of exts.values()) {
    const k = extOf(e);
    if (!docks.has(k)) docks.set(k, { id: 'dock:' + k, kind: k, name: EXT[k].plural, members: [], links: [] });
    const d = docks.get(k); d.members.push(e); e.dock = d;
  }
  const dk = [...docks.values()];
  for (const d of dk) {
    d.members.sort((a, b) => b.users.size - a.users.size || a.id.localeCompare(b.id));
    d.r = 4.6 * Math.sqrt(d.members.length) + 5;
    let x = 0, z = 0;
    for (const e of d.members) for (const id of e.users) { const p = parts.get(id); x += p.pos.x; z += p.pos.z; }
    d.ideal = x || z ? Math.atan2(z, x) : hashStr(d.id) / 4294967296 * Math.PI * 2;
    d.angle = d.ideal;
  }
  state.Rext = Math.max(40, ...cl.map((c) => c.pos.length() + c.r)) + Math.max(0, ...dk.map((d) => d.r)) + 30;
  dk.sort((a, b) => a.angle - b.angle || a.id.localeCompare(b.id));
  for (let it = 0; it < 300; it++) {
    for (let i = 0; i < dk.length && dk.length > 1; i++) {
      const a = dk[i], b = dk[(i + 1) % dk.length], gap = (a.r + b.r + 26) / state.Rext;
      let d = b.angle - a.angle; if (i === dk.length - 1) d += Math.PI * 2;
      if (d < gap) { const push = (gap - d) / 2; a.angle -= push; b.angle += push; }
    }
    for (const d of dk) d.angle += (d.ideal - d.angle) * 0.01;
  }
  for (const d of dk) {
    d.pos = new V3(Math.cos(d.angle) * state.Rext, 0, Math.sin(d.angle) * state.Rext);
    d.members.forEach((e, i) => {
      const rr = d.members.length === 1 ? 0 : 4.6 * Math.sqrt(i + 0.5), th = i * 2.39996 + d.angle;
      e.pos = new V3(d.pos.x + Math.cos(th) * rr, 0, d.pos.z + Math.sin(th) * rr);
      e.r = 0.75 + 0.2 * Math.sqrt(e.users.size);
      if (VOXEL) { e.r *= 1.7; e.pos.y = -1 + e.r; }   // bigger beside terrain voxels; standing on the dock island, whose top is y = -1
    });
  }
  state.overviewDist = state.Rext * 1.75;

  // ---- scene: environment; clusters: glass plates (Voxel: floating islands) ----
  const floorY = Math.min(...[...clusters.values()].map((c) => c.pos.y)) - 22;
  if (!VOXEL) glassStage(floorY);
  for (const c of cl) {
    if (VOXEL) {
      c.plateY = c.pos.y - 1.2;
      c.shell = voxIsland(hashStr(c.id), c.r * 1.08, c.color, c.pos.x, c.pos.z, c.plateY); scene.add(c.shell);
    } else glassPlate(c, floorY);
    const top = new V3(c.pos.x, c.plateY, c.pos.z + c.r * 1.05);
    c.label = new Label(`<b>${esc(c.name)}</b><i>${c.parts.length} parts</i>`, 'lb-cluster', top, 100, { style: `--c:${c.color}`, ent: { type: 'cluster', id: c.id }, mode: 'below', dy: 6 });
    const out = new V3(c.pos.x, 0, c.pos.z).normalize(); if (!out.lengthSq()) out.set(0, 0, 1);
    c.tag = new Label(esc(c.name), 'lb-ctag', new V3(c.pos.x + out.x * c.r, c.pos.y - 3, c.pos.z + out.z * c.r), 45, { style: `--c:${c.color}`, mode: 'center', ent: { type: 'cluster', id: c.id } });
  }

  // ---- parts ----
  for (const p of parts.values()) {
    const k = kindOf(p);
    p.node = addNode(p.id, 'part', shapeOfPart(p), p.pos, p.r, p.clusterObj.color, { part: p });
    if (k === 'tool' && !VOXEL) p.node.icons.push({ cell: 'cli', scale: p.r * 0.9, off: 0, color: THEME.amber });
    const chg = state.M.changes?.[p.id];
    p.label = new Label(`<b><span class="kd"></span>${esc(p.name || p.id)}${chg ? `<span class="chg">Δ${chg}</span>` : ''}</b>`, 'lb-part',
      new V3(p.pos.x, p.pos.y + p.r * 1.4, p.pos.z), 55 + Math.min(10, Math.sqrt(p.size || 0) / 12), { style: `--k:${p.clusterObj.color}`, ent: { type: 'part', id: p.id } });
    p.sumLabel = new Label(esc(p.summary), 'lb-psum', new V3(p.pos.x, p.pos.y - p.r, p.pos.z), 58, { mode: 'below', dy: 6, ent: { type: 'part', id: p.id } });
  }
  for (const d of docks.values()) {
    const k = d.kind;
    d.node = addNode(d.id, 'dock', 'dock', d.pos, d.r, EXT[k].color, { dock: d });
    if (VOXEL) { d.island = voxIsland(hashStr(d.id), d.r, THEME.voxel.dock, d.pos.x, d.pos.z, -1); scene.add(d.island); }
    d.label = new Label(`${EXT[k].icon}<b>${esc(d.name)}</b><em>${d.members.length}</em>`, 'lb-dock', new V3(d.pos.x, d.pos.y + 2, d.pos.z - d.r * 0.2), 90, { style: `--k:${EXT[k].color}`, ent: { type: 'dock', id: d.id }, dy: 10 });
  }
  for (const e of exts.values()) {
    const k = extOf(e);
    e.node = addNode(e.id, 'external', 'ext_' + k, e.pos, e.r, EXT[k].color, { ext: e });
    if (k === 'saas' && !VOXEL) e.node.icons.push({ cell: (e.id.match(/[A-Za-z0-9]/)?.[0] || '?').toUpperCase(), scale: e.r * 1.5, off: e.r * 0.2, color: EXT.saas.color });
    e.label = new Label(esc(e.id), 'lb-ext', new V3(e.pos.x, e.pos.y + e.r, e.pos.z), 40, { style: `--k:${EXT[k].color}`, ent: { type: 'external', id: e.id }, dy: 3 });
  }

  // ---- part details: ports, flow arcs, proxies, uses labels ----
  for (const p of parts.values()) buildDetail(p);

  // ---- links (part level) ----
  const white = new THREE.Color(THEME.link);
  for (const L of links) {
    const a = L.a.pos, b = L.b.pos;
    const crv = curve(a, b, L.toExt ? 0.08 : 0.18, 0.06);
    const col = L.toExt ? new THREE.Color(EXT[extOf(L.b)].color).lerp(white, 0.25) : white;
    L.item = linkSet.add(crv.getPoints(L.toExt ? 24 : 14), col, L);
    const t = L.toExt ? Math.min(0.5, (L.a.r + 7) / a.distanceTo(b)) : 0.5;
    L.label = new Label(esc(L.how || ''), L.toExt ? 'lb-use' : 'lb-link', crv.getPoint(t), L.toExt ? 30 : 16, { mode: 'center' });
  }
  state.M._links = links;
  linkSet.build(); trackSet.build();

  // ---- cluster streams ----
  const agg = new Map();
  for (const L of links) {
    const ca = L.a.clusterObj, cb = L.toExt ? L.b.dock : L.b.clusterObj;
    if (L.toExt) cb.links.push(L);
    if (ca === cb) continue;
    const key = ca.id + '→' + (L.toExt ? 'x:' : '') + (cb.id);
    if (!agg.has(key)) agg.set(key, { from: ca, to: cb, toExt: L.toExt, w: 0, hows: [] });
    const s = agg.get(key); s.w += L.weight; s.hows.push(L);
  }
  for (const s of agg.values()) {
    const dir = new V3().subVectors(s.to.pos, s.from.pos).normalize();
    const a = s.from.pos.clone().addScaledVector(dir, s.from.r * 0.92);
    const b = s.to.pos.clone().addScaledVector(dir, -s.to.r * (s.toExt ? 1.05 : 0.92));
    const crv = curve(a, b, s.toExt ? 0.04 : 0.14, 0.07);
    const rad = s.toExt ? 0.18 + 0.1 * Math.sqrt(s.w) : 0.3 + 0.25 * Math.sqrt(s.w);
    const mat = tubeMat(s.from.color, s.toExt ? EXT[s.to.kind].color : s.to.color, crv.getLength());
    s.mesh = new THREE.Mesh(new THREE.TubeGeometry(crv, 48, rad, 10, false), mat); scene.add(s.mesh);
    streams.push(s);
  }

  // ---- instanced meshes ----
  const groups = {};
  const put = (geo, mode, e) => (groups[geo + '|' + mode] ||= []).push(e);
  if (VOXEL) {
    // each node's model is one baked mesh; only its moving voxels (clock faces, crates) are instanced, grouped by mode
    const model = (n) => n.type === 'part' ? partModel(kindOf(n.part), hashStr(n.key), n.part.clusterObj.color, { size: n.part.size })
      : n.type === 'external' ? externalModel(extOf(n.ext), hashStr(n.key), EXT[extOf(n.ext)].color, { name: n.ext.name || n.ext.id }) : CUBE;
    const baked = (k, mesh, e) => { Object.assign(mesh.userData, { baked: true, list: [e] }); meshes[k] = mesh; scene.add(mesh); };
    for (const n of nodes) {
      if (n.type === 'dock') continue;   // docks are islands
      const m = model(n), cube = m === CUBE, v = voxNode(m, n.scale, cube, cube ? n.base : null, n.type === 'part' ? 3.6 : 2.4, n.pos);
      baked('n:' + n.key, v.mesh, { node: n });
      for (const e of v.moving) put('vox', e.mode, { node: n, ...e });
      // tall buildings (big services) rise above the usual label height: lift the label onto the roof
      if (n.type === 'part') n.part.label.pos.y = Math.max(n.part.label.pos.y, n.pos.y + v.top);
    }
    for (const p of parts.values()) if (state.M.changes?.[p.id]) baked('c:' + p.id, voxNode(RING, p.r, false, AMBER, 2.4, p.pos).mesh, { node: p.node, gate: 'chg' });
  } else {
    for (const n of nodes) for (const [geo, mode, gate] of SHAPES[n.shape]) put(geo, mode, { node: n, scale: n.scale, gate });
    for (const p of parts.values()) if (state.M.changes?.[p.id]) put('chg', 0, { node: p.node, scale: p.r * 1.8, gate: 'chg', color: AMBER, y: -p.r * 1.1 });
    for (const p of parts.values()) put('shadow', 4, { node: p.node, scale: p.r * 3.6, y: p.clusterObj.plateY + 0.27 - p.pos.y });   // contact shadow on the plate
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new V3(), pv = new V3();
  for (const [key, list] of Object.entries(groups)) {
    const [g, mode] = key.split('|');
    const geo = (g === 'vox' ? BOX : G[g]).clone();
    const mesh = g === 'vox' ? voxMesh(geo, +mode, list.length) : new THREE.InstancedMesh(geo, mode === '4' ? shadowMat : solidMats[+mode], list.length);
    const col = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
    const al = new THREE.InstancedBufferAttribute(new Float32Array(list.length).fill(-1), 1); al.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aColor', col); geo.setAttribute('aAlpha', al);
    if (g === 'vox' && mode === '3') geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(new Float32Array(list.flatMap((e) => e.aOff)), 4));   // crates
    list.forEach((e, i) => { pv.copy(e.node.pos); pv.y += e.y || 0; if (e.off) pv.add(e.off); m4.compose(pv, q, sc.setScalar(e.scale)); mesh.setMatrixAt(i, m4); });
    mesh.frustumCulled = false; mesh.userData.list = list; mesh.userData.alpha = al; mesh.userData.color = col; if (mode === '4') mesh.renderOrder = -1;
    meshes[key] = mesh; scene.add(mesh);
  }
  const icons = nodes.flatMap((n) => n.icons.map((ic) => ({ node: n, ...ic, cell: atlasCell(ic.cell), color: new THREE.Color(ic.color) })));
  if (icons.length) {
    const geo = new THREE.PlaneGeometry(1, 1), mesh = new THREE.InstancedMesh(geo, iconMat, icons.length);
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(icons.map((i) => i.cell)), 1));
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(icons.flatMap((i) => [i.color.r, i.color.g, i.color.b])), 3));
    const al = new THREE.InstancedBufferAttribute(new Float32Array(icons.length), 1); al.setUsage(THREE.DynamicDrawUsage); geo.setAttribute('aAlpha', al);
    icons.forEach((ic, i) => { pv.copy(ic.node.pos); pv.y += ic.off; m4.compose(pv, q, sc.setScalar(ic.scale)); mesh.setMatrixAt(i, m4); });
    mesh.frustumCulled = false; mesh.renderOrder = 5; mesh.userData = { list: icons, alpha: al }; state.iconMesh = mesh; scene.add(mesh);
  }
  recolor();
}

// Glass look: a faint grid and stage under everything, so the platforms' soft shadows have something to land on, and the dock orbit.
function glassStage(floorY) {
  const grid = new THREE.GridHelper(state.Rext * 6, 60, THEME.grid.major, THEME.grid.minor);
  grid.material.transparent = true; grid.material.opacity = 0.35; grid.material.depthWrite = false; grid.position.y = floorY; grid.renderOrder = -5; scene.add(grid);
  const stageR = state.Rext * 2.2;
  const floor = new THREE.Mesh(new THREE.CircleGeometry(stageR, 96).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec2 vP; void main(){ float d = length(vP) / ${stageR.toFixed(1)}; gl_FragColor = vec4(vec3(0.62, 0.68, 0.8), 0.009 * (1.0 - smoothstep(0.0, 1.0, d))); }`,
  }));
  floor.position.y = floorY - 0.05; floor.renderOrder = -4; scene.add(floor);
  const orbit = fatLoop([circle(state.Rext, -0.01, 256)], THEME.orbit.color, THEME.orbit.opacity, 1); scene.add(orbit);
}

// Glass look: a cluster's glass plate, hairline outline, ring guides and floor shadow.
function glassPlate(c, floorY) {
  c.plateY = c.pos.y - 3.2;
  const R = c.r * 1.08, H = 0.5, BR = 0.2, hex = regular(6, R, Math.PI / 6), cr = R * 0.07;
  c.shell = new THREE.Group(); c.shell.position.set(c.pos.x, c.plateY, c.pos.z);
  c.fillMat = glassMat(c.colorObj);
  const plate = new THREE.Mesh(slab(hex, cr, H, BR, 4), c.fillMat); plate.renderOrder = -2;
  const edge = fillet(v2(hex), cr, true, 6).map((p) => { const l = p.length(); return new V3(p.x * (l - BR) / l, H / 2 + 0.01, p.y * (l - BR) / l); });
  const outline = fatLoop([edge], c.colorObj, 0.6, 1); c.edgeMat = outline.material;
  c.shell.add(plate, outline); scene.add(c.shell);
  c.ring = fatLoop(c.rings.filter((g) => g.radius).map((g) => circle(g.radius, 0, 160)), c.colorObj, 0, 1);
  c.ring.position.set(c.pos.x, c.plateY + H / 2 + 0.02, c.pos.z); c.ringMat = c.ring.material; scene.add(c.ring);
  const sh = new THREE.Mesh(floorShadowGeo, floorShadowMat); sh.scale.setScalar(R * 2.8); sh.position.set(c.pos.x, floorY, c.pos.z); sh.renderOrder = -3; scene.add(sh);
}

export function buildDetail(p) {
  const flows = p.flows || [];
  const F = Math.max(1, flows.length);
  const actorsPer = flows.map((f) => { const s = []; for (const st of f.steps || []) for (const a of [st.from, st.to]) if (a && a !== p.id && !s.includes(a)) s.push(a); return s; });
  const maxA = Math.max(1, ...actorsPer.map((a) => a.length));
  const rr = Math.max(p.r + 5.5, (F * maxA * 2.6) / (Math.PI * 2 * 0.85));
  p.ring = rr; p.focusDist = Math.max(26, rr * 3.3);
  p.detailNodes = []; p.detailLabels = []; p.flowInfo = [];
  const base = -Math.PI / 2 - Math.PI / F * 0.85;
  flows.forEach((f, k) => {
    const actors = actorsPer[k], n = actors.length, map = new Map([[p.id, p.pos]]);
    const span = (Math.PI * 2 / F) * 0.8;
    actors.forEach((a, j) => {
      const th = base + k * (Math.PI * 2 / F) + (n === 1 ? span / 2 : (j / (n - 1)) * span);
      const pos = new V3(p.pos.x + Math.cos(th) * rr, p.pos.y + 1.5 + k * 1.6 + j * 0.3, p.pos.z + Math.sin(th) * rr);
      const target = parts.get(a) || exts.get(a);
      const st = (f.steps || []).find((s) => s.to === a && s.ref) || (f.steps || []).find((s) => s.from === a && s.ref);
      const key = `${p.id}#${k}:${a}`;
      let node;
      if (target) {
        const color = parts.has(a) ? KINDS[kindOf(target)].color : EXT[extOf(target)].color;
        node = addNode(key, 'proxy', 'proxy', pos, 0.55, color, { owner: p, flow: k, name: a, ref: st?.ref, target });
        node.label = new Label(`↗ ${esc(a)}`, 'lb-proxy', new V3(pos.x, pos.y + 0.6, pos.z), 30, { style: `--k:${color}`, ent: { type: 'proxy', key } });
        node.tether = trackSet.add([pos, target.pos], new THREE.Color(color), p);
      } else {
        node = addNode(key, 'fn', 'fn', pos, 0.42, THEME.fnNode, { owner: p, flow: k, name: a, ref: st?.ref, fn: st?.fn });
        if (st?.ref && state.M.code?.[st.ref]?.verified === false) node.icons.push({ cell: 'warn', scale: 0.75, off: 0.9, color: THEME.amber });
        node.label = new Label(esc(a), 'lb-fn', new V3(pos.x, pos.y + 0.5, pos.z), 32, { ent: { type: 'fn', key } });
      }
      if (node.ref) node.code = new Label(codeHtml(node.ref, 4), 'lb-code', pos, 22, { mode: 'right', dy: 18, ent: { type: 'code', ref: node.ref } });
      map.set(a, pos); p.detailNodes.push(node); p.detailLabels.push(node.label);
    });
    const segs = [];
    for (const st of f.steps || []) {
      const a = map.get(st.from), b = map.get(st.to);
      if (a && b && a !== b) segs.push(trackSet.add([a, b], new THREE.Color(THEME.track), p));
    }
    const first = map.get(actors[0]) || p.pos;
    const tl = new Label(`▶ ${esc(f.title)}`, 'lb-flow', new V3(first.x, first.y + 1.8, first.z), 40, { ent: { type: 'flow', id: `${p.id}#${k}` } });
    p.detailLabels.push(tl);
    p.flowInfo.push({ map, segs, title: tl });
  });
  (p.exposes || []).forEach((e, i, arr) => {
    const th = base + Math.PI / F + (i / arr.length) * Math.PI * 2 + 0.4;
    const pos = new V3(p.pos.x + Math.cos(th) * (p.r + 2.4), p.pos.y - 0.8, p.pos.z + Math.sin(th) * (p.r + 2.4));
    const t = PORTS[e.type] || PORTS.function, key = `${p.id}@${i}`;
    const node = addNode(key, 'port', 'port', pos, 0.2, t.color, { owner: p, ref: e.ref, expose: e });
    node.icons.push({ cell: LUCIDE[e.type] ? e.type : 'ƒ', scale: 1.15, off: 0, color: t.color });
    node.label = new Label(`<span class="pt" style="--c:${t.color}">${t.label}</span>${esc(e.what)}`, 'lb-port', new V3(pos.x, pos.y - 0.6, pos.z), 36, { mode: 'below', dy: 4, ent: { type: 'port', key } });
    if (e.ref) node.code = new Label(codeHtml(e.ref, 4), 'lb-code', pos, 22, { mode: 'right', dy: 18, ent: { type: 'code', ref: e.ref } });
    p.detailNodes.push(node); p.detailLabels.push(node.label);
  });
}

// Active (flow step) and selected nodes are lit. Solid materials read a colour above 1 as "glow" (the only thing that blooms).
export function recolor() {
  const c = new THREE.Color(), sel = state.selected?.node, lit = (e) => state.activeKeys.has(e.node.key) || (e.node === sel && e.gate !== 'chg');
  for (const mesh of Object.values(meshes)) {
    if (mesh.userData.baked) { setVoxHot(mesh, lit(mesh.userData.list[0])); continue; }
    const arr = mesh.userData.color.array, hot = mesh.material.userData.hot || (mesh.material.isMeshPhysicalMaterial ? 4 : 1.7);
    mesh.userData.list.forEach((e, i) => {
      c.copy(e.color || e.node.base);
      if (lit(e)) c.multiplyScalar(hot);
      arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
    });
    mesh.userData.color.needsUpdate = true;
  }
  state.redraw = true;
}

// A mesh entry's alpha: its node's, gated ("changed" ring, packets on hot externals).
const alphaOf = (e) => e.node.alpha * (!e.gate ? 1 : e.gate === 'chg' ? (state.showChanges ? 1.2 : 0) : e.node.hot ? 1 : 0);

// Set o[k] = v; a change means the view must be drawn again.
function set(o, k, v) {
  if (o[k] === v) return false;
  o[k] = v; state.redraw = true; return true;
}

export function setEmphasis(ids, linkFilter) {
  if (!ids) { state.emph = state.emphLinks = null; return; }
  state.emph = new Set(ids);
  state.emphLinks = new Set(state.M._links.filter(linkFilter || ((L) => state.emph.has(L.a.id) && state.emph.has(L.b.id))));
}

export function updateLOD(dt) {
  const tgt = controls.target;
  lineRes.set(innerWidth, innerHeight);
  if (!reducedMotion()) spinTime.value += dt;
  const camD = camPos.distanceTo(tgt);   // depth fade scales with the view: subtle at every zoom level
  scene.fog.near = camD * 1.1; scene.fog.far = camD * 5;
  for (const c of clusters.values()) {
    if (!c.shell) continue;
    const d = camPos.distanceTo(c.pos);
    c.open = 1 - smooth(c.r * 3.5, c.r * 5.2, d);
    const dim = state.emph ? (state.emph.has(c.id) || c.parts.some((p) => state.emph.has(p.id)) ? 1 : 0.3) : 1;
    const sd = 1 - 0.92 * (state.focusPart?.struct?.depth || 0);   // everything steps back while a call board is open
    c.plateAlpha = dim;
    if (VOXEL) setVoxAlpha(c.shell, dim) && (state.redraw = true);   // the call board's step back is uWorld, below
    else {
      set(c.fillMat, 'opacity', (0.035 + 0.04 * (1 - c.open)) * dim * sd); set(c.edgeMat, 'opacity', (0.55 - 0.25 * c.open) * dim * sd);
      set(c.ringMat, 'opacity', (0.06 + 0.22 * c.open) * dim * sd);
    }
    c.label.want = (1 - smooth(0.25, 0.7, c.open)) * dim * (1 - smooth(state.Rext * 4, state.Rext * 6, d)) * sd;
    c.tag.want = smooth(0.45, 0.85, c.open) * dim * sd;
  }
  // which part is "in focus" (unfolds)
  const selP = state.selected?.type === 'part' ? parts.get(state.selected.id) : null;
  const nearSel = selP && (selP.pos.distanceTo(tgt) < selP.r + 7 || (selP.struct && boardNear(selP.struct, tgt)));
  let fp = player.part || state.codeLink?.part || (state.selected && state.selected.owner) || (nearSel ? selP : null) || null;
  if (!fp && !player.on) {
    // A part is "in focus" when the orbit target is on it or on its call board (even while the board is hidden).
    // Hysteresis: keep the current one while it still qualifies, so neighbours don't flicker.
    const onPart = (p) => kindOn[kindOf(p)] && (p.pos.distanceTo(tgt) < p.r + 7 || (p.struct && boardNear(p.struct, tgt)));
    if (state.focusPart && onPart(state.focusPart)) fp = state.focusPart;
    else {
      let best = 1e9;
      for (const p of parts.values()) {
        if (!onPart(p)) continue;
        const d = p.struct && boardNear(p.struct, tgt) ? Math.min(p.pos.distanceTo(tgt), 6) : p.pos.distanceTo(tgt);
        if (d < best) { best = d; fp = p; }
      }
    }
  }
  state.focusPart = fp;
  for (const p of parts.values()) {
    const d = camPos.distanceTo(p.pos);
    const want = p === fp ? 1 - smooth(p.focusDist * 1.15, p.focusDist * 1.9, d) : 0;
    p.unfold = (p.unfold || 0) + (want - (p.unfold || 0)) * Math.min(1, dt * 5);
    if (Math.abs(want - p.unfold) < 0.002) p.unfold = want;   // settle, so an idle view stops changing
    p.dist = d;
  }
  const fpU = fp ? fp.unfold : 0, fpD = fp?.struct?.depth || 0;   // fpD: how far into the code-structure level we are
  const hp = state.hoverEnt?.type === 'part' ? parts.get(state.hoverEnt.id) : null;
  const selPart = state.selected?.type === 'part' ? parts.get(state.selected.id) : state.selected?.owner || null;
  for (const p of parts.values()) {
    const c = p.clusterObj, vis = kindOn[kindOf(p)] ? 1 : 0, dim = dimOf(p.id);
    const crowd = fp && fp !== p ? (1 - 0.65 * fpU) * (1 - 0.85 * fpD) : 1;
    p.node.alpha = (0.6 + 0.4 * c.open) * vis * dim * crowd * (1 - 0.55 * p.unfold) * (p === fp ? 1 - 0.92 * fpD : 1);
    p.label.want = smooth(0.35, 0.75, c.open) * (1 - smooth(Math.max(110, c.r * 3.4), Math.max(190, c.r * 4.6), p.dist)) * vis * (state.emph ? (state.emph.has(p.id) ? 1 : 0.25) : 1) * (fp && fp !== p ? (1 - 0.75 * fpU) * (1 - fpD) : 1);
    p.label.boost = p === fp ? 40 * fpU : (state.selected && state.selected.id === p.id ? 30 : 0);
    if (player.on && !player.part && state.emph.has(p.id)) { p.node.alpha = vis; p.label.want = vis; p.label.boost = state.activeKeys.has(p.id) ? 80 : 20; }
    if (p === hp) { p.label.want = Math.max(p.label.want, vis); p.label.boost = 90; }
    p.sumLabel.want = (p === hp || p === selPart || (p === fp && fpU > 0.3)) ? p.label.want * (1 - fpD) : 0;
    p.sumLabel.boost = p.label.boost;
    const tracksPulse = player.part === p || p === selPart || (state.codeLink?.hot && state.codeLink.part === p) ? 1 : 0;
    const u = p.unfold * vis * (1 - 0.97 * (p.struct?.depth || 0));
    for (const n of p.detailNodes) {
      n.alpha = u * dimOf(p.id) * (state.activeKeys.size && !state.activeKeys.has(n.key) && player.part === p ? 0.55 : 1);
      if (u > 0.01) {
        const dn = camPos.distanceTo(n.pos);
        n.label.want = u * (1 - smooth(Math.max(32, p.focusDist * 1.1), Math.max(50, p.focusDist * 1.6), dn));
        n.label.boost = state.activeKeys.has(n.key) ? 60 : 0;
        if (n.tether) trackSet.setAlpha(n.tether, u * 0.22);
        if (n.code) {
          // Fully visible when you point at the step (or select it); otherwise it fades in as you get close.
          const pointed = state.hoverEnt?.node === n || state.selected?.node === n;
          n.code.want = pointed ? u : u * (1 - smooth(10, 14, dn));
          n.code.boost = (pointed ? 80 : Math.max(0, 14 - dn) * 9) + (state.activeKeys.has(n.key) ? 40 : 0);
        }
      } else { n.label.want = 0; if (n.tether) trackSet.setAlpha(n.tether, 0); if (n.code) n.code.want = 0; }
    }
    for (const fi of p.flowInfo) {
      fi.title.want = u * (1 - smooth(Math.max(40, p.focusDist * 1.2), Math.max(60, p.focusDist * 1.7), camPos.distanceTo(fi.title.pos)));
      for (const s of fi.segs) trackSet.setAlpha(s, u * 0.7, tracksPulse);
    }
  }
  for (const d of docks.values()) {
    const dd = camPos.distanceTo(d.pos);
    d.near = 1 - smooth(d.r * 2.6 + 25, d.r * 4 + 60, dd);
    const dim = state.emph ? (d.members.some((e) => state.emph.has(e.id)) ? 1 : 0.3) : 1;
    d.node.alpha = 0.5 * dim;
    if (d.island && setVoxAlpha(d.island, dim)) state.redraw = true;
    d.label.want = (1 - d.near) * dim * (1 - 0.6 * fpU) * (1 - fpD);
  }
  for (const e of exts.values()) {
    const dim = dimOf(e.id), near = e.dock.near;
    const related = (hp && hp.neighbors.has(e.id)) || (state.emph && state.emph.has(e.id) && (state.selected || player.on)) ? 1 : 0;
    const fpRel = fp && fp.neighbors.has(e.id) ? fpU : 0;
    e.node.alpha = Math.max(0.2 + 0.7 * near, related, fpRel * (1 - fpD)) * dim;
    e.label.want = Math.max(near, related, fpRel * (1 - fpD)) * dim;
    e.label.boost = state.activeKeys.has(e.id) ? 80 : related ? 30 : 0;
    e.node.hot = !!(state.emph && state.emph.has(e.id) && (state.selected || player.on));
  }
  for (const L of state.M._links) {
    const a = L.a, b = L.b, vis = kindOn[kindOf(a)] && (L.toExt || kindOn[kindOf(b)]) ? 1 : 0;
    const oa = a.clusterObj.open, ob = L.toExt ? 0 : b.clusterObj.open;
    let al = L.toExt ? 0.06 * oa : 0.28 * Math.max(oa, ob);
    const touchFp = fp && (a === fp || b === fp);
    const hot = (hp && (a === hp || b === hp)) || (state.emphLinks && state.emphLinks.has(L));
    if (touchFp) al = Math.max(al, 0.2 + 0.45 * fpU); else if (fp) al *= 1 - 0.7 * fpU;
    if (state.emphLinks && !state.emphLinks.has(L)) al *= 0.08;
    if (hot) al = Math.max(0.7, al);
    al *= vis * (1 - (hot ? 0.8 : 0.9) * fpD);
    linkSet.setAlpha(L.item, al, hot ? 1 : 0);
    L.label.want = L.toExt
      ? (touchFp ? fpU : 0) * vis * (1 - fpD)
      : (hot ? 1 : 0) * (1 - smooth(90, 160, camPos.distanceTo(L.label.pos))) * vis;
  }
  for (const s of streams) {
    const oa = s.from.open, ob = s.toExt ? 0 : s.to.open;
    let al = (s.toExt ? 0.3 : 0.55) * (1 - Math.max(oa, ob));
    const hot = state.emphLinks ? s.hows.some((L) => state.emphLinks.has(L)) : false;
    if (state.emph) al *= hot ? 1.6 : 0.12;
    const u = s.mesh.material.uniforms;
    set(u.uAlpha, 'value', al * (1 - fpD)); set(u.uPulse, 'value', hot ? 1 : 0);
    if (hot && u.uAlpha.value > 0.004) state.redraw = true;   // the pulse runs
  }
  // per-instance alpha: upload only what changed
  for (const mesh of Object.values(meshes)) {
    if (mesh.material.uniforms?.uRows) continue;   // board text sets its own alpha
    if (mesh.userData.baked) { if (setVoxAlpha(mesh, alphaOf(mesh.userData.list[0]))) state.redraw = true; continue; }
    const arr = mesh.userData.alpha.array, list = mesh.userData.list;
    let changed = false;
    for (let i = 0; i < list.length; i++) { const a = Math.fround(alphaOf(list[i])); if (arr[i] !== a) { arr[i] = a; changed = true; } }
    if (changed) { mesh.userData.alpha.needsUpdate = true; state.redraw = true; }
  }
  if (state.iconMesh) {
    const arr = state.iconMesh.userData.alpha.array, list = state.iconMesh.userData.list;
    let changed = false;
    for (let i = 0; i < list.length; i++) { const a = Math.fround(Math.min(1, list[i].node.alpha * 1.4)); if (arr[i] !== a) { arr[i] = a; changed = true; } }
    if (changed) { state.iconMesh.userData.alpha.needsUpdate = true; state.redraw = true; }
  }
  updateStructs(dt, fp);
  linkSet.flush(); trackSet.flush();
  if (VOXEL) {
    // solid voxels would hide a call board inside the island: the world dissolves as the board comes up,
    // and the sky dims so the board reads on the dark backdrop it was designed for
    if (set(uWorld, 'value', 1 - fpD)) refreshShadows();
    set(scene, 'backgroundIntensity', 1 - 0.9 * fpD);
    followSun(tgt, camD);
  }
}

export function flyTo(target, dist, opts = {}) {
  fly.t0.copy(controls.target); fly.t1.copy(target);
  fly.d0.subVectors(camPos, controls.target); fly.r0 = fly.d0.length(); fly.d0.normalize();
  const d = opts.dir ? opts.dir.clone().normalize() : fly.d0.clone();
  let el = Math.asin(clamp(d.y, -1, 1)); const az = Math.atan2(d.x, d.z);
  el = clamp(el, opts.minEl ?? 0.42, opts.maxEl ?? 1.15);
  fly.d1.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  fly.r1 = dist; fly.t = 0;
  const travel = fly.t0.distanceTo(fly.t1) + Math.abs(Math.log(fly.r1 / fly.r0)) * 30;
  fly.dur = opts.dur ?? clamp(0.7 + travel / 260, 0.8, 1.8);
  hoverEl.style.display = 'none';
  if (reducedMotion()) { fly.on = false; controls.target.copy(fly.t1); camPos.copy(fly.t1).addScaledVector(fly.d1, fly.r1); return; }
  // Spring state: target xyz, view direction xyz, log distance (value, velocity pairs). A flight already under way keeps its velocity.
  const s = fly.s;
  if (!fly.on) [fly.t0.x, fly.t0.y, fly.t0.z, fly.d0.x, fly.d0.y, fly.d0.z, Math.log(fly.r0)].forEach((x, i) => { s[i * 2] = x; s[i * 2 + 1] = 0; });
  fly.on = true;
}

export function updateViewOffset(dt) {
  const dw = drawer.classList.contains('open') ? drawer.offsetWidth : detail.classList.contains('open') ? detail.offsetWidth + 16 : 0;
  const want = innerWidth > 900 ? dw / 2 : 0;
  if (Math.abs(want - state.viewOff) < 0.5 && state.viewOff === camera.view?.offsetX) return;
  state.redraw = true;
  state.viewOff += (want - state.viewOff) * Math.min(1, dt * 6);
  if (Math.abs(want - state.viewOff) < 0.5) state.viewOff = want;
  camera.setViewOffset(innerWidth, innerHeight, state.viewOff, 0, innerWidth, innerHeight);
}

// Critically damped camera flight: no linear moves, no overshoot; mostly settled after fly.dur.
export function updateFly(dt) {
  if (!fly.on) return;
  const s = fly.s, w = 7 / fly.dur, lr = Math.log(fly.r1);
  fly.t += dt / fly.dur;
  spring(s, 0, fly.t1.x, w, dt); spring(s, 2, fly.t1.y, w, dt); spring(s, 4, fly.t1.z, w, dt);
  spring(s, 6, fly.d1.x, w, dt); spring(s, 8, fly.d1.y, w, dt); spring(s, 10, fly.d1.z, w, dt);
  spring(s, 12, lr, w, dt);
  const done = fly.t > 2.5 || (Math.hypot(s[0] - fly.t1.x, s[2] - fly.t1.y, s[4] - fly.t1.z) < fly.r1 * 2e-3 && Math.hypot(s[6] - fly.d1.x, s[8] - fly.d1.y, s[10] - fly.d1.z) < 2e-3 && Math.abs(s[12] - lr) < 2e-3);
  if (done) { controls.target.copy(fly.t1); fv.copy(fly.d1); fly.on = false; }
  else { controls.target.set(s[0], s[2], s[4]); fv.set(s[6], s[8], s[10]).normalize(); }
  camPos.copy(controls.target).addScaledVector(fv, done ? fly.r1 : Math.exp(s[12]));
}

export function flyToEnt(ent) {
  if (!ent) return;
  if (ent.type === 'cluster') { const c = clusters.get(ent.id); flyTo(c.pos, c.r * 2.5); }
  else if (ent.type === 'part') { const p = parts.get(ent.id); flyTo(new V3(p.pos.x, p.pos.y + 1.5, p.pos.z), p.focusDist); }
  else if (ent.type === 'external') { const e = exts.get(ent.id); flyTo(e.pos, Math.max(30, e.dock.r * 2.2)); }
  else if (ent.type === 'dock') { const d = docks.get(ent.id.slice(5)); flyTo(d.pos, d.r * 3 + 20); }
  else if (ent.type === 'snode' && ent.node?.owner?.struct) { const S = ent.node.owner.struct; const d = new V3().subVectors(camPos, S.group.position); if (S.depth < 0.05) setFacing(S, Math.atan2(d.x, d.z)); flyToBoard(S, ent.node.item); }
  else if (ent.node) flyTo(ent.node.pos, 9);
}

/* ---------------- entities & selection ---------------- */
export function resolveEnt(ent) {
  if (!ent) return null;
  if (ent.key) { const n = nodeByKey.get(ent.key); return n ? { ...ent, node: n, owner: n.owner, id: n.key } : null; }
  if (ent.type === 'part' && parts.has(ent.id)) return { ...ent, node: parts.get(ent.id).node };
  if (ent.type === 'external' && exts.has(ent.id)) return { ...ent, node: exts.get(ent.id).node };
  if (ent.type === 'cluster' && clusters.has(ent.id)) return ent;
  if (ent.type === 'dock' && docks.has(ent.id.slice(5))) return ent;
  return ent.type === 'flow' || ent.type === 'code' ? ent : null;
}

export function entFromNode(n) {
  if (n.type === 'part') return { type: 'part', id: n.key, node: n };
  if (n.type === 'external') return { type: 'external', id: n.key, node: n };
  if (n.type === 'dock') return { type: 'dock', id: n.key, node: n };
  return { type: n.type, key: n.key, id: n.key, node: n, owner: n.owner };
}

export function findEnt(id) {
  if (parts.has(id)) return resolveEnt({ type: 'part', id });
  if (clusters.has(id)) return resolveEnt({ type: 'cluster', id });
  if (exts.has(id)) return resolveEnt({ type: 'external', id });
  if (String(id).startsWith('dock:')) return resolveEnt({ type: 'dock', id });
  if (nodeByKey.has(id)) return entFromNode(nodeByKey.get(id));
  const fn = nodes.find((n) => n.type === 'fn' && (n.name === id || n.fn === id));
  return fn ? entFromNode(fn) : null;
}

export function select(ent) {
  if (state.selected) labelOf(state.selected)?.el.classList.remove('sel');
  state.selected = ent;
  if (!ent) { if (!player.on) setEmphasis(null); closeDetail(); recolor(); return; }
  labelOf(ent)?.el.classList.add('sel');
  recolor();
  if (!player.on) {
    if (ent.type === 'part') { const p = parts.get(ent.id); setEmphasis([p.id, ...p.neighbors, ...p.links.map((L) => L.a.id)], (L) => L.a === p || L.b === p); }
    else if (ent.type === 'external') { const e = exts.get(ent.id); setEmphasis([e.id, ...e.users], (L) => L.b === e); }
    else if (ent.type === 'dock') { const d = docks.get(ent.id.slice(5)); setEmphasis([...d.members.map((e) => e.id), ...d.members.flatMap((e) => [...e.users])], (L) => L.b.dock === d); }
    else if (ent.type === 'cluster') { const c = clusters.get(ent.id); const ids = new Set([c.id, ...c.parts.map((p) => p.id)]); setEmphasis([...ids], (L) => ids.has(L.a.id) && ids.has(L.b.id)); }
    else if (ent.owner) { const p = ent.owner; setEmphasis([p.id, ...p.neighbors], (L) => L.a === p || L.b === p); }
  }
  showDetail(ent);
}

export function labelOf(ent) {
  if (ent.type === 'part') return parts.get(ent.id)?.label;
  if (ent.type === 'external') return exts.get(ent.id)?.label;
  if (ent.type === 'cluster') return clusters.get(ent.id)?.label;
  if (ent.type === 'dock') return docks.get(ent.id.slice(5))?.label;
  return ent.node?.label;
}

export function dive(ent) {
  ent = resolveEnt(ent);
  if (!ent) return;
  if (ent.type === 'flow') return playFlow(ent.id);
  if (ent.type === 'code') return openCode(ent.ref);
  select(ent); flyToEnt(ent);
}

export function pick(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(Object.values(meshes).filter((m) => m.material !== solidMats[3] && m.material !== shadowMat), false);
  for (const h of hits) { const n = h.object.userData.list[h.instanceId ?? 0]?.node; if (n && n.alpha > 0.25) return entFromNode(n); }
  let best = null, bd = 1e9;
  for (const c of clusters.values()) {
    if (!c.shell || c.plateAlpha < 0.2 || c.open > 0.6) continue;
    const t = (c.plateY - ray.ray.origin.y) / ray.ray.direction.y;
    if (t > 0) { ray.ray.at(t, navP); if (Math.hypot(navP.x - c.pos.x, navP.z - c.pos.z) < c.r * 1.05 && t < bd) { bd = t; best = c; } }
  }
  return best ? { type: 'cluster', id: best.id } : null;
}

export function entFromEvent(e) {
  const lb = e.target.closest?.('.lb');
  if (lb && lb._ent) return resolveEnt(lb._ent);
  return pick(e.clientX, e.clientY);
}

export function flowById(id) {
  const [owner, idx] = String(id).split('#'); const k = +idx;
  if (owner === 'system') { const f = (state.M.systemFlows || [])[k]; return f && { f, part: null, k }; }
  const p = parts.get(owner), f = p?.flows?.[k];
  return f && { f, part: p, k };
}

export function actorPos(name, prev) {
  if (player.part) return player.part.flowInfo[player.k].map.get(name) || player.part.pos;
  return parts.get(name)?.pos || exts.get(name)?.pos || prev || new V3();
}

export function actorKey(name) {
  if (player.part) return name === player.part.id ? player.part.id : `${player.part.id}#${player.k}:${name}`;
  return name;
}

export function playFlow(id, startAt = 0) {
  const r = flowById(id); if (!r) return false;
  Object.assign(player, { on: true, playing: true, id, steps: r.f.steps || [], part: r.part, k: r.k, title: r.f.title });
  if (!player.steps.length) return false;
  const ids = r.part ? [r.part.id, ...player.steps.flatMap((s) => [s.from, s.to]).filter((a) => parts.has(a) || exts.has(a))] : player.steps.flatMap((s) => [s.from, s.to]);
  const set = new Set(ids);
  setEmphasis([...set], r.part ? (L) => (L.a === r.part && set.has(L.b.id)) : (L) => player.steps.some((s) => s.from === L.a.id && s.to === L.b.id));
  $('#flowbar').classList.add('open'); $('#hint').style.display = 'none';
  $('#fbtitle').textContent = (r.part ? r.part.name + ' · ' : 'System · ') + r.f.title;
  $('#fbprog').innerHTML = player.steps.map((_, i) => `<i data-i="${i}" title="Step ${i + 1}"></i>`).join('');
  if (r.part) { state.selected = { type: 'part', id: r.part.id, node: r.part.node }; showDetail(state.selected); }
  pulse.visible = trail.visible = true;
  pulse.scale.setScalar(r.part ? 1.6 : 4);
  gotoStep(startAt);
  return true;
}

export function gotoStep(i, fromVoice = false) {
  const s = player.steps[i]; if (!s) return;
  player.i = i; player.t = 0;
  player.a.copy(actorPos(s.from, player.b)); player.b.copy(actorPos(s.to, player.a));
  state.activeKeys = new Set([actorKey(s.from), actorKey(s.to)]); recolor();
  if (drawer.classList.contains('open') && s.ref) { const m = /^(.*):(\d+)$/.exec(s.ref); if (m) openFile(m[1], +m[2]); }
  const mid = new V3().addVectors(player.a, player.b).multiplyScalar(0.5);
  if (player.part) { const p = player.part; mid.lerp(p.pos, 0.55); flyTo(mid, p.focusDist * 0.95, { dur: i === 0 ? 1.3 : 0.9 }); }
  else flyTo(mid, clamp(player.a.distanceTo(player.b) * 1.4, 80, 320), { dur: 1.1 });
  const unv = s.ref && state.M.code?.[s.ref]?.verified === false;
  $('#fbcap').innerHTML = `<span class="n">${i + 1}/${player.steps.length}</span><span>${esc(s.text)}${s.ref ? ` — <span class="rf" data-ref="${esc(s.ref)}">${esc(s.ref.split('/').pop())}</span>${unv ? ' <span class="unv" title="unverified">⚠</span>' : ''}` : ''}</span>`;
  $('#fbprog').querySelectorAll('i').forEach((el, j) => { el.className = j < i ? 'done' : j === i ? 'cur' : ''; });
  playButton(player.playing ? 'playing' : 'paused');
  narrate(fromVoice);
  document.querySelectorAll('.flow li.cur').forEach((el) => el.classList.remove('cur'));
  document.querySelector(`.flow[data-flow="${CSS.escape(player.id)}"] li[data-step="${i}"]`)?.classList.add('cur');
}

// Narration. player.voiceEnd: null = timed step, Infinity = speaking, else player.t when speech ended.
// The rest of the flow is read as one utterance that moves the steps itself (no pop between steps);
// a manual jump restarts it from that step. Voices without progress events fall back to one per step.
function narrate(fromVoice = false) {
  if (fromVoice) return;   // the running flow utterance just reached this step
  if (voice.on && speakFlow(player.steps.map(stepSpeech), player.i, player.speed,
    (i) => { if (player.on) gotoStep(i, true); },
    (why) => { if (!player.on) return; if (why === 'fallback') narrate(); else player.voiceEnd = player.t; })) {
    player.voiceEnd = Infinity;
    return;
  }
  const ok = voice.on && speak(stepSpeech(player.steps[player.i]), player.speed, () => { player.voiceEnd = player.t; });
  player.voiceEnd = ok ? Infinity : null;
}

const BEAT = 0.6;   // pause after the narration ends, in step time

// When the current step is over: a fixed time, or once the pulse has arrived and the narration has ended plus a short beat.
function stepEnd() { return player.voiceEnd == null ? STEP : Math.max(MOVE + 0.25, player.voiceEnd + BEAT); }

// Flow bar play button: state class (is-playing / is-paused / is-done) for the HUD's icon, glyph as fallback.
function playButton(st) {
  const b = $('#fbplay');
  b.textContent = { playing: '⏸', paused: '▶', done: '↻' }[st];
  b.classList.remove('is-playing', 'is-paused', 'is-done'); b.classList.add('is-' + st);
}

export function stopFlow() {
  if (!player.on) return;
  player.on = player.playing = false; player.part = null;
  cancelSpeech();
  pulse.visible = trail.visible = false; state.activeKeys = new Set(); recolor();
  $('#flowbar').classList.remove('open'); $('#hint').style.display = '';
  document.querySelectorAll('.flow li.cur').forEach((el) => el.classList.remove('cur'));
  const s = state.selected; state.selected = null; select(s && resolveEnt(s));
}

export function updatePlayer(dt) {
  if (!player.on) return;
  state.redraw = true;   // the cart and trail move
  if (player.playing) player.t += dt * player.speed;
  const u = ease(clamp((player.t - 0.25) / MOVE, 0, 1));
  pv.lerpVectors(player.a, player.b, u);
  pv.y += Math.sin(u * Math.PI) * player.a.distanceTo(player.b) * 0.12;
  pulse.position.copy(pv);
  if (VOXEL) pulse.lookAt(player.b.x, pv.y, player.b.z);   // the cart faces where it is going
  const buf = trailGeo.attributes.instanceStart.data, arr = buf.array;
  arr[0] = arr[9] = player.a.x; arr[1] = arr[10] = player.a.y; arr[2] = arr[11] = player.a.z; arr[3] = arr[6] = pv.x; arr[4] = arr[7] = pv.y; arr[5] = arr[8] = pv.z;   // the loop's two segments overlap
  buf.needsUpdate = true;
  if (player.playing && player.t > stepEnd()) {
    if (player.i < player.steps.length - 1) gotoStep(player.i + 1);
    else { player.playing = false; playButton('done'); }
  }
}

export function isTrackpad(e) {
  if (state.wheelDevice) return state.wheelDevice === 'trackpad';
  if (e.deltaMode === 1) { state.wheelDevice = 'mouse'; return false; }
  const ay = Math.abs(e.deltaY);
  if (e.deltaX !== 0 || (ay < 50 && !(state.lastNotch && ay % state.lastNotch === 0))) { state.wheelDevice = 'trackpad'; return true; }
  state.lastNotch = ay; state.wheelDevice = 'mouse'; return false;
}

// Zoom about what is under the pointer: a visible node, else the stage floor (where plates and
// docks sit), else the plane through the orbit pivot. Zooming about the pivot plane alone stalls
// at the minimum distance while the thing you aim at, often behind that plane, is still far away.
export function zoomAt(x, y, f) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(Object.values(meshes).filter((m) => m.material !== shadowMat), false)
    .find((h) => h.object.userData.list?.[h.instanceId ?? 0]?.node?.alpha > 0.25);
  const floor = -ray.ray.origin.y / ray.ray.direction.y;   // the stage floor is y = 0
  if (hit) navP.copy(hit.point);
  else if (floor > 0 && floor < camPos.distanceTo(controls.target) * 4) ray.ray.at(floor, navP);
  else {
    camera.getWorldDirection(navN);
    navPlane.setFromNormalAndCoplanarPoint(navN, controls.target);
    if (!ray.ray.intersectPlane(navPlane, navP)) navP.copy(controls.target);
  }
  const d = camPos.distanceTo(navP);
  f = clamp(f, controls.minDistance / d, controls.maxDistance / camPos.distanceTo(controls.target));
  controls.target.sub(navP).multiplyScalar(f).add(navP);   // scale the view about that point
  camPos.sub(navP).multiplyScalar(f).add(navP);
}

export function panBy(dx, dy) {
  const k = (2 * camPos.distanceTo(controls.target) * Math.tan((camera.fov * Math.PI) / 360)) / innerHeight;
  navR.setFromMatrixColumn(camera.matrix, 0).multiplyScalar(dx * k);
  navU.setFromMatrixColumn(camera.matrix, 1).multiplyScalar(-dy * k);
  navR.add(navU); controls.target.add(navR); camPos.add(navR);
}

export function initThreeSetup() {
  /* ---------------- three setup ---------------- */
  stage = $('#stage');
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });   // MSAA for the overlay pass; the composer has its own
  // Low quality: no shadows, pixel ratio at most 1. Auto picks Low for integrated Intel, base M1 and mobile/software GPUs.
  const gl = renderer.getContext(), dbg = gl.getExtension('WEBGL_debug_renderer_info'), gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
  LOW = QUALITY === 'low' || (QUALITY === 'auto' && /Intel(?!.*\bArc\b)|Apple M1(?! (Pro|Max|Ultra))|Mali|Adreno|PowerVR|SwiftShader|llvmpipe/i.test(gpu));
  renderer.setPixelRatio(Math.min(devicePixelRatio, LOW ? 1 : 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 1);
  stage.prepend(renderer.domElement);
  scene = new THREE.Scene();
  // vertical gradient background, top colour first
  const sky = (stops) => {
    const bg = document.createElement('canvas'); bg.width = 2; bg.height = 256;
    const bgc = bg.getContext('2d'), gr = bgc.createLinearGradient(0, 0, 0, 256);
    stops.forEach((c, i) => gr.addColorStop(i / (stops.length - 1), c)); bgc.fillStyle = gr; bgc.fillRect(0, 0, 2, 256);
    const t = new THREE.CanvasTexture(bg); t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  scene.background = sky([THEME.bgTop, THEME.bgBottom]);
  bgColor = new THREE.Color(THEME.bg);
  scene.fog = new THREE.Fog(bgColor, 300, 1500);   // near/far follow the camera distance (updateLOD)
  // soft studio light: a small room environment for reflections, one key light
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture; pmrem.dispose();
  if (!VOXEL) { const key = new THREE.DirectionalLight(0xffffff, 0.7); key.position.set(0.4, 1, 0.55); scene.add(key); }
  camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 8000);
  controls = new OrbitControls(camera, stage);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.zoomToCursor = true;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 3;
  controls.rotateSpeed = 0.6;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), THEME.bloom.strength, THEME.bloom.radius, THEME.bloom.threshold);
  const bloomSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => bloomSize(Math.round(w / 2), Math.round(h / 2));   // half resolution: it is a blur anyway
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  uTime = { value: 0 };
  spinTime = { value: 0 };   // decorative spin; frozen under prefers-reduced-motion
  lineRes = new THREE.Vector2(innerWidth, innerHeight);
  if (VOXEL) setupVoxel({ renderer, scene, bloom, spinTime, skyTexture: sky, low: LOW });
}

// Render size: the window at pixel ratio pr (main.js adapts pr to the frame time).
export function setResolution(pr = renderer.getPixelRatio()) {
  renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight);
  composer.setPixelRatio(pr); composer.setSize(innerWidth, innerHeight);
  state.redraw = true;
}

export function initShaders() {
  /* ---------------- shaders ---------------- */
  nodeMats = [0, 1, 2, 3].map((mode) => new THREE.ShaderMaterial({
    uniforms: { uTime }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec3 aColor; attribute float aAlpha; uniform float uTime;
      varying vec3 vN; varying vec3 vV; varying vec3 vC; varying float vA;
      void main(){
        vec3 p = position, n = normal;
        #if ${mode} == 1 || ${mode} == 2
          #if ${mode} == 1
            float a = uTime*0.3 + float(gl_InstanceID)*1.3;
          #else
            float a = -floor(uTime + float(gl_InstanceID)*0.37) * 0.5236;
          #endif
          float c = cos(a), s = sin(a); mat3 R = mat3(c,0.,-s, 0.,1.,0., s,0.,c); p = R*p; n = R*n;
        #elif ${mode} == 3
          p.x += (fract(uTime*0.5 + float(gl_InstanceID)*0.5) - 0.5) * 2.0;
        #endif
        mat4 m = modelMatrix*instanceMatrix;
        vec4 wp = m*vec4(p,1.);
        vN = normalize(mat3(m)*n); vV = normalize(cameraPosition - wp.xyz);
        vC = aColor; vA = aAlpha;
        gl_Position = projectionMatrix*viewMatrix*wp;
      }`,
    fragmentShader: `
      varying vec3 vN; varying vec3 vV; varying vec3 vC; varying float vA;
      void main(){
        if (vA < 0.004) discard;
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        gl_FragColor = vec4(vC*(0.32 + 1.5*pow(f, 2.0)), vA);
      }`,
  }));
  /* Icon billboards: one atlas texture, one instanced quad mesh. */
  ATLAS = 1024;
  CELL = 128;
  atlasCv = document.createElement('canvas');
  atlasCv.width = atlasCv.height = ATLAS;
  atlasCtx = atlasCv.getContext('2d');
  atlasCells = new Map();
  LUCIDE = {
    http: ['M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20', 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20', 'M2 12h20'],
    pubsub: ['M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4', 'M16.24 7.76a6 6 0 0 1 0 8.49', 'M7.76 16.24a6 6 0 0 1 0-8.49', 'M19.07 4.93a10 10 0 0 1 0 14.14', 'M4.93 19.07a10 10 0 0 1 0-14.14'],
    cron: ['M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20', 'M12 6v6l4 2'],
    cli: ['M4 17l6-6-6-6', 'M12 19h8'],
    rpc: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
    warn: ['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01'],
  };
  atlasTex = new THREE.CanvasTexture(atlasCv);
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.anisotropy = 4;
  iconMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: atlasTex }, uN: { value: ATLAS / CELL } }, transparent: true, depthWrite: false, depthTest: false,
    vertexShader: `
      attribute float aCell; attribute vec3 aColor; attribute float aAlpha; uniform float uN;
      varying vec2 vUv; varying vec3 vC; varying float vA;
      void main(){
        vec3 center = (modelMatrix*instanceMatrix*vec4(0.,0.,0.,1.)).xyz; float sc = length(instanceMatrix[0].xyz);
        vec4 mv = viewMatrix*vec4(center,1.); mv.xy += position.xy*sc;
        float col = mod(aCell, uN), row = floor(aCell/uN);
        vUv = vec2((col + uv.x)/uN, 1.0 - (row + 1.0 - uv.y)/uN);
        vC = aColor; vA = aAlpha; gl_Position = projectionMatrix*mv;
      }`,
    fragmentShader: `
      uniform sampler2D uMap; varying vec2 vUv; varying vec3 vC; varying float vA;
      void main(){ if (vA < 0.01) discard; vec4 t = texture2D(uMap, vUv); gl_FragColor = vec4(t.rgb*vC, t.a*vA); }`,
  });
  /* Fat lines: constant pixel width (hairline), 1.7x wider while active; light pulses run along active lines.
     LineMaterial's vertex shader plus per-segment alpha/pulse/distance; segments with alpha 0 are culled in the vertex shader. */
  lineMat = (speed, spacing, base) => {
    const m = new LineMaterial({ vertexColors: true, transparent: true, depthWrite: false, linewidth: 1.25 });
    m.fog = true;
    Object.assign(m.uniforms, { resolution: { value: lineRes }, uTime, uSpeed: { value: speed }, uSpacing: { value: spacing }, uBase: { value: base } });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('attribute vec3 instanceColorEnd;', 'attribute vec3 instanceColorEnd;\nattribute vec2 instanceD; attribute float instanceAlpha; attribute float instancePulse;\nvarying float vD; varying float vA; varying float vP;')
        .replace('void main() {', 'void main() {\nvD = position.y < 0.5 ? instanceD.x : instanceD.y; vA = instanceAlpha; vP = instancePulse;')
        .replace('offset *= linewidth;', 'offset *= linewidth * (1.0 + 0.7 * instancePulse);')
        .replace('gl_Position = clip;', 'gl_Position = instanceAlpha < 0.004 ? vec4(2.0, 2.0, 2.0, 1.0) : clip;');
      sh.fragmentShader = `
        uniform float opacity; uniform float uTime; uniform float uSpeed; uniform float uSpacing; uniform float uBase;
        varying vec2 vUv; varying float vD; varying float vA; varying float vP;
        #include <common>
        #include <color_pars_fragment>
        #include <fog_pars_fragment>
        void main() {
          if (abs(vUv.y) > 1.0) { float a = vUv.x, b = vUv.y > 0.0 ? vUv.y - 1.0 : vUv.y + 1.0; if (a * a + b * b > 1.0) discard; }
          float pulse = pow(1.0 - fract((uTime * uSpeed - vD) / uSpacing), 9.0) * vP;
          gl_FragColor = vec4(vColor * (uBase + 2.4 * pulse), vA * opacity);
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`;
    };
    return m;
  };
  /* Solid nodes: clearcoated physical material, per-instance colour/alpha. Faded nodes are truly see-through: fading
     toward one flat background colour painted them as black shapes over the gradient, lines and plates. A colour above 1
     marks an active node, which gets an emissive glow (the only solid thing that blooms).
     Modes: 0 still, 1 slow spin, 2 clock tick, 3 packet sliding along x. */
  const solid = (mode) => {
    const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.45, transparent: true });
    const ang = mode === 1 ? 'float sa = uSpin * 0.3 + float(gl_InstanceID) * 1.3;' : mode === 2 ? 'float sa = -floor(uSpin + float(gl_InstanceID) * 0.37) * 0.5236;' : '';
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uSpin: spinTime });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aColor; attribute float aAlpha; uniform float uSpin; varying vec3 vC; varying float vA;\nmat3 spinY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0., -s, 0., 1., 0., s, 0., c); }')
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\nvC = aColor; vA = aAlpha; ${ang} ${ang ? 'objectNormal = spinY(sa) * objectNormal;' : ''}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${ang ? 'transformed = spinY(sa) * transformed;' : ''} ${mode === 3 ? 'transformed.x += (fract(uSpin * 0.5 + float(gl_InstanceID) * 0.5) - 0.5) * 2.0;' : ''}`)
        .replace('#include <project_vertex>', '#include <project_vertex>\nif (aAlpha < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vC; varying float vA;')
        .replace('#include <color_fragment>', '#include <color_fragment>\nfloat mx = max(vC.r, max(vC.g, vC.b)), hot = smoothstep(1.05, 1.3, mx); diffuseColor.rgb *= vC / max(mx, 1.0);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * hot * 0.9;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= sqrt(clamp(vA, 0.0, 1.0));');
    };
    m.customProgramCacheKey = () => 'solid' + mode;
    return m;
  };
  solidMats = [0, 1, 2, 3].map(solid);
  // Baked soft contact shadows: radial falloff on a flat quad (instanced under nodes, single under platforms).
  const shadow = (k) => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: `attribute float aAlpha; varying vec2 vUv; varying float vA;
      void main() {
        vUv = uv;
        #ifdef USE_INSTANCING
          vA = aAlpha; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.);
        #else
          vA = 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
        #endif
      }`,
    fragmentShader: `varying vec2 vUv; varying float vA;
      void main() { float d = 1.0 - smoothstep(0.0, 1.0, length(vUv - 0.5) * 2.0); gl_FragColor = vec4(0.0, 0.0, 0.0, d * sqrt(d) * vA * ${k.toFixed(2)}); }`,
  });
  shadowMat = shadow(THEME.shadow);
  floorShadowMat = shadow(0.22);   // stronger reads as a black hole on the dark stage
  floorShadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  // Glass plates: tinted clearcoat, edges get more opaque at grazing angles (cheap fresnel, no transmission).
  glassMat = (color) => {
    const m = new THREE.MeshPhysicalMaterial({ color, roughness: 0.22, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06, transparent: true, depthWrite: false, opacity: 0.12, envMapIntensity: 0.6 });
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>',
        'diffuseColor.a = clamp(diffuseColor.a * (1.0 + 5.0 * pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 3.0)), 0.0, 1.0);\n#include <opaque_fragment>');
    };
    m.customProgramCacheKey = () => 'glass';
    return m;
  };
  tubeMat = (ca, cb, len) => new THREE.ShaderMaterial({
    uniforms: { uTime, uA: { value: new THREE.Color(ca) }, uB: { value: new THREE.Color(cb) }, uLen: { value: len }, uAlpha: { value: 0 }, uPulse: { value: 0 } },
    transparent: true, depthWrite: false,
    vertexShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv = uv; vec4 wp = modelMatrix*vec4(position,1.); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition-wp.xyz); gl_Position = projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uA; uniform vec3 uB; uniform float uLen; uniform float uAlpha; uniform float uPulse;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        if (uAlpha < 0.004) discard;
        float core = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
        float p = fract((uTime*22.0 - vUv.x*uLen)/34.0);
        float pulse = pow(1.0 - p, 7.0) * uPulse;
        float ends = smoothstep(0.0, 0.06, vUv.x)*smoothstep(1.0, 0.94, vUv.x);
        vec3 col = mix(uA, uB, vUv.x)*(0.7 + 1.8*pulse);
        gl_FragColor = vec4(col, uAlpha*core*ends);
      }`,
  });
  shellMat = (color) => new THREE.ShaderMaterial({
    uniforms: { uTime, uC: { value: new THREE.Color(color) }, uAlpha: { value: 0 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){ vec4 wp = modelMatrix*vec4(position,1.); vP = position; vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition-wp.xyz); gl_Position = projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uC; uniform float uAlpha; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){
        if (uAlpha < 0.004) discard;
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float rim = pow(f, 3.0);
        float lat = smoothstep(0.93, 1.0, abs(sin(vP.y*9.0 + uTime*0.4)))*0.25;
        gl_FragColor = vec4(uC*(0.05 + 1.1*rim + lat*(0.3+f)), uAlpha);
      }`,
  });
}

export function initWorldModel() {
  /* ---------------- world model ---------------- */
  parts = new Map();
  clusters = new Map();
  exts = new Map();
  docks = new Map();
  nodes = [];
  // every instanced thing
  nodeByKey = new Map();
  meshes = {};
  linkSet = new LineSet(7, 14, 0.3);
  trackSet = new LineSet(4, 7, 0.35);
  streams = [];
  state.Rsys = 60;
  state.Rext = 120;
  state.overviewDist = 300;
  /* Shape = kind. Each shape is a list of [geometry, animation mode, gate] parts, built once and shared. */
  at = (g, x, y, z) => g.translate(x, y, z);
  merge = (...gs) => mergeGeometries(gs.map((g) => (g.index ? g.toNonIndexed() : g)));
  const discs = (ys, R, h, r) => merge(...ys.map((y) => at(lathe([[0, -h / 2], [R, -h / 2], [R, h / 2], [0, h / 2]], r), 0, y, 0)));
  const pins = [-0.45, -0.15, 0.15, 0.45].flatMap((t) => [[t, 0.9, 0.08, 0.4], [t, -0.9, 0.08, 0.4], [0.9, t, 0.4, 0.08], [-0.9, t, 0.4, 0.08]])
    .map(([x, z, w, d]) => at(new RoundedBoxGeometry(w, 0.06, d, 1, 0.02), x, 0, z));
  G = {
    tower: lathe([[0, -1.2], [0.8, -1.2], [0.45, 1.2], [0, 1.2]], 0.14),
    orbit: new THREE.TorusGeometry(1.35, 0.014, 8, 192).rotateX(Math.PI / 2).rotateZ(0.35),
    disc: lathe([[0, -0.11], [1.1, -0.11], [1.1, 0.11], [0, 0.11]], 0.07),
    arc: at(new THREE.RingGeometry(0.35, 0.92, 48, 1, 0, Math.PI * 0.5).rotateX(-Math.PI / 2), 0, 0.118, 0),
    plates: merge(...[-0.45, 0, 0.45].map((y) => at(slab(rect(1.5, 1.5), 0.24, 0.16, 0.05, 3), 0, y, 0))),
    panel: new RoundedBoxGeometry(1.9, 1.3, 0.28, 4, 0.1),
    db: discs([-0.5, 0, 0.5], 1, 0.42, 0.1),
    tube: lathe([[0.4, -1.2], [0.5, -1.2], [0.5, 1.2], [0.4, 1.2]], 0.035, true).rotateZ(Math.PI / 2),
    packet: new RoundedBoxGeometry(0.32, 0.32, 0.32, 2, 0.07),
    bucket: merge(...[-0.3, 0.3].map((y) => at(slab(rect(1.9, 1.3), 0.2, 0.5, 0.08), 0, y, 0))),
    chip: merge(slab(rect(1.4, 1.4), 0.14, 0.22, 0.06), ...pins),
    hex: slab(regular(6, 1), 0.12, 0.25, 0.07),
    ring: lathe([[0.6, -0.1], [0.9, -0.1], [0.9, 0.1], [0.6, 0.1]], 0.07, true),
    fn: new THREE.SphereGeometry(1, 32, 20), proxy: new THREE.OctahedronGeometry(1, 0), dot: new THREE.SphereGeometry(1, 24, 14),
    dock: new THREE.TorusGeometry(1, 0.012, 6, 192).rotateX(Math.PI / 2),
    chg: new THREE.TorusGeometry(1, 0.04, 8, 96).rotateX(Math.PI / 2),
    shadow: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  };
  SHAPES = {
    service: [['tower', 0], ['orbit', 1]], job: [['disc', 0], ['arc', 0]], jobCron: [['disc', 0], ['arc', 2]],
    library: [['plates', 0]], tool: [['panel', 0]],
    ext_db: [['db', 0]], ext_queue: [['tube', 0], ['packet', 3, 'hot']], ext_storage: [['bucket', 0]], ext_cloud: [['chip', 0]],
    ext_saas: [['hex', 0]], ext_other: [['ring', 0]],
    fn: [['fn', 0]], proxy: [['proxy', 0]], port: [['dot', 0]], dock: [['dock', 0]],
  };
  AMBER = new THREE.Color(THEME.amber);
  shapeOfPart = (p) => kindOf(p) === 'job' && (p.exposes || []).some((e) => e.type === 'cron') ? 'jobCron' : kindOf(p);
  partScale = (p) => clamp(0.9 + 0.35 * Math.log(1 + (p.size || 300) / 120), 1, 2.6);
  state.iconMesh = null;
}

export function initState() {
  /* ---------------- state ---------------- */
  kindOn = { service: true, job: true, library: true, tool: true };
  state.emph = null;
  state.emphLinks = null;
  state.selected = null;
  state.showChanges = false;
  state.activeKeys = new Set();
  state.focusPart = null;
  dimOf = (id) => (!state.emph || state.emph.has(id) ? 1 : 0.13);
}

export function initLod() {
  /* ---------------- LOD: per-frame visibility ---------------- */
  camPos = camera.position;
}

export function initCameraFlight() {
  /* ---------------- camera flight ---------------- */
  fly = { on: false, t: 0, dur: 1, t0: new V3(), t1: new V3(), d0: new V3(), d1: new V3(), r0: 1, r1: 1, s: new Float64Array(14) };
  fv = new V3();
  state.viewOff = 0;
  flyOverview = () => flyTo(new V3(0, 0, 0), state.overviewDist, { minEl: 0.85, maxEl: 1.0 });
}

export function initPicking() {
  /* ---------------- picking ---------------- */
  ray = new THREE.Raycaster();
  ndc = new THREE.Vector2();
  state.downAt = null;
  stage.addEventListener('pointerdown', (e) => { state.downAt = [e.clientX, e.clientY]; if (fly.on) fly.on = false; });
  stage.addEventListener('click', (e) => {
    if (state.downAt && Math.hypot(e.clientX - state.downAt[0], e.clientY - state.downAt[1]) > 5) return;
    const ent = entFromEvent(e);
    if (!ent) { if (!player.on) select(null); return; }
    if (ent.type === 'flow') return playFlow(ent.id);
    if (ent.type === 'code') return openCode(ent.ref);
    if (ent.type === 'snode') return openLens(ent.node.item);
    select(ent);
  });
  stage.addEventListener('dblclick', (e) => { const ent = entFromEvent(e); if (ent) dive(ent); });
  state.mouse = null;
  state.mouseDirty = false;
  stage.addEventListener('pointermove', (e) => { state.mouse = e; state.mouseDirty = true; });
  stage.addEventListener('pointerleave', () => { state.mouse = null; state.hoverEnt = null; $('#hover').style.display = 'none'; });
}

export function initFlowPlayback() {
  /* ---------------- flow playback ---------------- */
  player = { on: false, playing: false, id: null, steps: [], i: 0, t: 0, speed: 1, voiceEnd: null, part: null, a: new V3(), b: new V3(), title: '' };
  MOVE = 1.1;
  STEP = 3.6;
  pulseTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(150,215,250,.85)'); gr.addColorStop(1, 'rgba(90,200,250,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
  if (VOXEL) pulse = voxCart(cart(THEME.accent));   // a small voxel cart; its cargo glows
  else {
    pulse = new THREE.Sprite(new THREE.SpriteMaterial({ map: pulseTex, color: THEME.pulse, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true }));
    pulse.material.color.multiplyScalar(2.2);   // above the bloom threshold: the flow pulse glows
  }
  pulse.visible = false;
  scene.add(pulse);
  trail = fatLoop([[new V3(), new V3()]], new THREE.Color(THEME.trail).multiplyScalar(1.6), 1, 2);   // refilled each frame
  trail.geometry.attributes.instanceStart.data.setUsage(THREE.DynamicDrawUsage);
  trailGeo = trail.geometry;
  trail.visible = false;
  scene.add(trail);
  pv = new V3();
  $('#fbplay').onclick = () => {
    if (!player.playing && player.i >= player.steps.length - 1 && player.t > stepEnd()) { player.playing = true; gotoStep(0); return; }
    player.playing = !player.playing; playButton(player.playing ? 'playing' : 'paused');
    if (!player.playing) pauseSpeech();
    else if (player.voiceEnd === Infinity) resumeSpeech();
    else if (player.voiceEnd == null) narrate();   // first click after a flow started without a user gesture
  };
  $('#fbvoice').onclick = () => {
    voice.on = !voice.on; renderVoiceButton();
    if (voice.on) narrate(); else { cancelSpeech(); player.voiceEnd = null; }
  };
  $('#fbprev').onclick = () => gotoStep(Math.max(0, player.i - 1));
  $('#fbnext').onclick = () => gotoStep(Math.min(player.steps.length - 1, player.i + 1));
  $('#fbclose').onclick = stopFlow;
  $('#fbspeed').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; player.speed = +b.dataset.s; $('#fbspeed').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
  $('#fbprog').onclick = (e) => { const i = e.target.dataset?.i; if (i != null) gotoStep(+i); };
  $('#fbcap').onclick = (e) => { const r = e.target.closest('[data-ref]'); if (r) openCode(r.dataset.ref); };
}

export function initNavigation() {
  /* ---------------- trackpad & touch navigation ----------------
     Mouse wheel (notches) -> OrbitControls zoom. Trackpad pinch (ctrl+wheel, Safari gesture*) -> zoom about the pointer.
     Trackpad two-finger scroll -> screen-space pan. The device is detected once per session. */
  isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  $('#hint').innerHTML = isMac ? '<b>pinch</b> zoom · <b>two-finger</b> move · <b>drag</b> rotate · <b>Esc</b> back' : '<b>scroll</b> zoom · <b>drag</b> rotate · <b>right-drag</b> move · <b>Esc</b> back';
  state.wheelDevice = null;
  state.lastNotch = 0;
  navPlane = new THREE.Plane();
  navP = new V3();
  navN = new V3();
  navR = new V3();
  navU = new V3();
  stage.addEventListener('wheel', (e) => {
    if (e.ctrlKey) { e.preventDefault(); e.stopImmediatePropagation(); fly.on = false; zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * 0.01)); return; }
    if (isTrackpad(e)) { e.preventDefault(); e.stopImmediatePropagation(); fly.on = false; panBy(e.deltaX, e.deltaY); }
  }, { capture: true, passive: false });
  addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  // never page-zoom
  state.gestureScale = 1;
  gestureOpts = { passive: false };
  document.addEventListener('gesturestart', (e) => { e.preventDefault(); state.gestureScale = 1; fly.on = false; }, gestureOpts);
  document.addEventListener('gesturechange', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, state.gestureScale / e.scale); state.gestureScale = e.scale; }, gestureOpts);
  document.addEventListener('gestureend', (e) => e.preventDefault(), gestureOpts);
}
