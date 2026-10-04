// board.js
// Exports: structs, loadStructures, buildStruct, disposeStruct, setFacing, boardNear, usesOf, usersOf, updateStructs, structNodeAt, flyToBoard, openLens, lensPlace, showLens, setGateLines, spoken, initBoard
// Imports: state: state | nav: remember | drawer: drawer, getJSON, gpop, overlay | hud: I, detail, openCode, showDetail | scene: G, LineSet, SHAPES, camPos, camera, controls, dive, fly, flyTo, kindOn, meshes, nodeByKey, parts, player, pulseTex, recolor, renderer, scene, solidMats | theme: EXT, PORTS, THEME, kindOf, oklch | util: $, V3, clamp, ease, esc, hashStr, smooth, reducedMotion | voice: cancelSpeech, speak, voice | xray: mountXray
// The metro map of a part's code (METRO.md), on an upright board under the part. Each entry point is a coloured line
// running left to right through its main call path; side calls are short spurs; stations shared by lines are interchanges.
// Clicking a station opens the Lens: its callers and callees as file cards around it, or (X-ray) the function's own flowchart.
import * as THREE from 'three';
import { state } from './state.js';
import { drawer, getJSON, gpop, overlay } from './drawer.js';
import { I, detail, openCode, showDetail } from './hud.js';
import { G, LineSet, SHAPES, camPos, camera, controls, dive, fly, flyTo, kindOn, meshes, nodeByKey, parts, player, pulseTex, recolor, renderer, scene, solidMats } from './scene.js';
import { EXT, PORTS, THEME, kindOf, oklch } from './theme.js';
import { $, V3, clamp, ease, esc, hashStr, smooth, reducedMotion } from './util.js';
import { cancelSpeech, speak, speakFlow, voice } from './voice.js';
import { mountXray } from './xray.js';
import { remember } from './nav.js';

export let structs;
// grid: COL world units between columns, ROW between rows; GAP between parallel lines on a shared segment
const COL = 3.6, ROW = 1.5, GAP = 0.14, MAX_SPURS = 3;
const LINE_HUES = [250, 75, 150, 25, 300, 195, 350, 110, 225, 50, 275, 170];
let TXT_W, TXT_H, TXT_FONT, TXT_Q, TXT_CHAR, TXT_DEF, TXT_DIM, textMat, flatMat, zoneMat, WHITE, FILL, tmp, tmpDir;
let legendS = null, hoverLines = null, gateLines = null, lens = null, ride = null, ridePulse = null, xrayOn = false;

const trunc = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const fullName = (it) => (it.kind === 'method' && it.parent ? `${it.parent}.${it.name}` : it.name);
export const spoken = (it) => it.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');

export async function loadStructures() {
  if (!state.codeApi) return;
  for (const p of parts.values()) {
    for (let tries = 0; tries < 200; tries++) {
      let j;
      try { j = await getJSON('/api/structure?part=' + encodeURIComponent(p.id)); } catch { return; }   // endpoint missing
      state.structStatus = j.status;
      if (j.status === 'building') { await new Promise((res) => setTimeout(res, 3000)); continue; }
      if (j.status === 'ready' && j.nodes?.length) { p.structData = j; buildStruct(p); }
      break;
    }
  }
  state.structStatus = 'ready';
}

/* ---------------- geometry helpers (board-local, z = 0) ---------------- */
// Octilinear route a -> b: horizontal, 45° diagonal, vertical, horizontal (each part may be empty).
function route(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, sx = Math.sign(dx) || 1, sy = Math.sign(dy);
  const d = Math.min(Math.abs(dx), Math.abs(dy)), h = (Math.abs(dx) - d) / 2;
  const p1 = new V3(a.x + sx * h, a.y, 0), p2 = new V3(p1.x + sx * d, a.y + sy * d, 0);
  const pts = [new V3(a.x, a.y, 0), p1, p2, new V3(p2.x, b.y, 0), new V3(b.x, b.y, 0)];
  return pts.filter((p, i) => !i || p.distanceTo(pts[i - 1]) > 1e-4);
}

// Shift a polyline sideways by o (mitred joins), for lines running side by side.
function offsetPath(pts, o) {
  if (!o) return pts;
  const nrm = (a, b) => { const d = new V3().subVectors(b, a).normalize(); return new V3(-d.y, d.x, 0); };
  return pts.map((p, i) => {
    const n0 = i > 0 ? nrm(pts[i - 1], p) : null, n1 = i < pts.length - 1 ? nrm(p, pts[i + 1]) : null;
    const m = n0 && n1 ? n0.clone().add(n1).normalize() : n0 || n1;
    return p.clone().addScaledVector(m, n0 && n1 ? o / Math.max(0.3, m.dot(n0)) : o);
  });
}

// Round every inner corner with a quadratic curve.
function rounded(pts, R = 0.5) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], p = pts[i], b = pts[i + 1], la = a.distanceTo(p), lb = p.distanceTo(b), r = Math.min(R, la / 2, lb / 2);
    if (tmp.subVectors(p, a).cross(tmpDir.subVectors(b, p)).lengthSq() < 1e-8) continue;   // straight on: no corner (and no overlapping caps)
    const p0 = p.clone().lerp(a, r / la), p1 = p.clone().lerp(b, r / lb);
    for (let k = 0; k <= 6; k++) { const t = k / 6; out.push(p0.clone().multiplyScalar((1 - t) ** 2).addScaledVector(p, 2 * t * (1 - t)).addScaledVector(p1, t * t)); }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// A leg with cumulative lengths, for moving a pulse along it.
function leg(pts) { const len = [0]; for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + pts[i].distanceTo(pts[i - 1])); return { pts, len }; }
function pointAt(l, u, out) {
  const d = u * l.len[l.len.length - 1];
  let i = 1; while (i < l.len.length - 1 && l.len[i] < d) i++;
  const seg = l.len[i] - l.len[i - 1] || 1;
  return out.lerpVectors(l.pts[i - 1], l.pts[i], clamp((d - l.len[i - 1]) / seg, 0, 1));
}

/* ---------------- build ---------------- */
export function buildStruct(p) {
  const j = p.structData, base = (p.path || '').replace(/\/$/, '');
  const S = { part: p, depth: 0, live: false, group: new THREE.Group(), keys: [], facing: NaN, placed: [], text: null, hiddenLines: j.hiddenLines || 0 };
  const items = S.items = j.nodes.map((n, i) => ({ ...n, i, key: `${p.id}~${i}`, callers: [], callees: [], usesT: [], users: [], lines: [], effects: [], local: new V3(), pos: new V3(), placed: false }));
  for (const it of items) {
    const dir = it.file.includes('/') ? it.file.slice(0, it.file.lastIndexOf('/')) : '';
    it.dir = dir.startsWith(base) ? dir.slice(base.length).replace(/^\//, '') || '.' : dir;
  }
  const keep = (it) => state.showTests || !it.test;
  const inG = new Set(items.filter((it) => keep(it) && it.kind !== 'type').map((it) => it.i)), seen = new Set();
  for (const [a, b] of j.calls || []) {
    if (a === b || !inG.has(a) || !inG.has(b) || seen.has(a + ',' + b)) continue;
    seen.add(a + ',' + b); items[a].callees.push(b); items[b].callers.push(a);
  }
  for (const [f, t] of j.uses || []) {   // which data types each function uses
    const a = items[f], b = items[t];
    if (!a || !b || b.kind !== 'type' || !inG.has(f) || !keep(b) || seen.has(f + ':' + t)) continue;
    seen.add(f + ':' + t); a.usesT.push(t); b.users.push(f);
  }
  for (const [k, list] of Object.entries(j.effects || {})) if (items[+k]) items[+k].effects = list;
  const pal = (h) => oklch(0.76, 0.12, h);
  S.lines = (j.lines || []).map((l, idx) => ({ ...l, S, idx, css: pal(LINE_HUES[idx % 12]), color: new THREE.Color(pal(LINE_HUES[idx % 12])), on: true, a: 0,
    trunk: l.trunk.filter((i) => inG.has(i)).map((i) => items[i]), items: [], spurItems: [], legs: [] })).filter((L) => L.trunk.length);
  layout(S, inG);
  drawLines(S);
  // nodes: every function, method and type (detail panel, search and the Lens reach those off the lines too)
  const neutral = new THREE.Color(THEME.board.text);
  for (const it of items) {
    if (!keep(it)) continue;
    it.node = { key: it.key, type: 'snode', alpha: 0, base: it.lines[0]?.color || neutral, pos: it.pos, owner: p, item: it, icons: [] };
    nodeByKey.set(it.key, it.node); S.keys.push(it.key);
  }
  S.dummy = { key: '', alpha: 0, base: neutral };
  buildMeshes(S);
  S.textGroup = new THREE.Group(); overlay.add(S.textGroup);
  S.group.position.set(p.pos.x, p.pos.y - p.r * 1.6 - 3.5, p.pos.z);
  S.near = p.focusDist * 0.62; S.lo = Math.max(S.near, Math.min(S.W, 110) * 0.75); S.hi_ = S.lo * 1.35;
  scene.add(S.group);
  const d = new V3().subVectors(camPos, S.group.position); setFacing(S, Math.atan2(d.x, d.z));
  p.struct = S; structs.set(p.id, S);
  recolor();
  for (const it of items) if (it.node) state.searchItems.push({ sp: p.id, ty: it.kind === 'function' ? 'func' : it.kind, name: fullName(it), sub: `${p.name} · ${it.file.slice(base.length + 1)}:${it.line}${it.placed ? '' : ' · Lens'}`, go: () => dive({ type: 'snode', key: it.key }) });
  if (state.selected?.type === 'part' && state.selected.id === p.id) showDetail(state.selected);
}

// Stations on a grid: each line gets its own row band; a station already placed by an earlier line is an interchange.
function layout(S, inG) {
  const cells = new Map(), at = (c, r) => cells.get(c + ',' + r);
  let maxR = 0;
  const place = (it, c, r, below) => { Object.assign(it, { placed: true, c, r, below }); cells.set(c + ',' + r, it); S.placed.push(it); maxR = Math.max(maxR, r); };
  // A line's new stations go on the first row (at or below the stations it shares, else from the top) where they and
  // the rows just above and below are free: lines that share stations sit close together, and the board stays compact.
  // Stations before the first shared one end just left of it, so the line joins with a short diagonal.
  const cols = (L, r) => {
    const out = [], first = L.trunk.findIndex((it) => it.placed);
    let prev = first > 0 ? { c: L.trunk[first].c - first - 1 } : null;
    for (const it of L.trunk) {
      if (it.placed) { prev = it; continue; }
      let c = prev ? prev.c + 1 : 0;
      while (out.includes(c)) c++;   // the line came back left past its own stations
      if (at(c, r) || at(c, r - 1) || at(c, r + 1) || (it === L.trunk[0] && (at(c - 1, r) || at(c - 2, r)))) return null;   // the entry's name sits to its left
      out.push(c); prev = { c };
    }
    return out;
  };
  for (const L of S.lines) {
    const shared = L.trunk.find((it) => it.placed);
    // nearest free row to the shared station (below first), else the first free row from the top
    const tries = [];
    if (shared) for (let d = 2; d < 400; d++) tries.push(shared.r + d, shared.r - d);
    let row = 0, cs = null;
    for (const r of tries) if (r >= 1 && (cs = cols(L, r))) { row = r; break; }
    if (!cs) for (row = 1; !(cs = cols(L, row)); row++);
    let k = 0;
    for (const it of L.trunk) {
      if (!it.placed) place(it, cs[k++], row, false);
      if (!it.lines.includes(L)) it.lines.push(L);
    }
    const e = L.trunk[0];
    for (const c of [e.c - 1, e.c - 2]) if (!at(c, e.r)) cells.set(c + ',' + e.r, L);   // keep the line's name clear
    L.spurs = [];
    const per = new Map();
    for (const b of L.branches || []) {
      const from = S.items[b.from];
      if (!from?.placed || !from.lines.includes(L) || (per.get(from) || 0) >= MAX_SPURS) continue;
      const nodes = [];
      for (const i of b.nodes) { const x = S.items[i]; if (!x || !inG.has(i) || x.placed) break; nodes.push(x); }
      if (!nodes.length) continue;
      // a spur station's name sits below it, so the cell below must be free too
      const busy = (r) => nodes.some((x, k) => at(from.c + 1 + k, r) || at(from.c + 1 + k, r + 1));
      let r = from.r + 1;
      while (r < from.r + 5 && busy(r)) r++;
      if (busy(r)) continue;
      nodes.forEach((x, k) => { place(x, from.c + 1 + k, r, true); x.lines.push(L); });
      per.set(from, (per.get(from) || 0) + 1);
      L.spurs.push({ from, nodes });
    }
  }
  // board-local positions, centred; room on the left for the line names
  const xs = S.placed.map((it) => it.c * COL), maxLabel = Math.min(34, Math.max(4, ...S.lines.map((L) => L.label.length)));
  const left = (xs.length ? Math.min(...xs) : 0) - 0.9 - maxLabel * TXT_CHAR - 0.6, right = (xs.length ? Math.max(...xs) : 0) + COL * 0.5 + 2.6;
  const off = (left + right) / 2;
  for (const it of S.placed) {
    it.local.set(it.c * COL - off, -it.r * ROW, 0);
    const n = it.lines.length;
    it.rad = n > 1 ? 0.24 + 0.05 * Math.min(4, n - 1) : 0.17;
  }
  S.W = right - left; S.top = 0.5; S.bottom = -(maxR + 1.2) * ROW;
}

// Trunk legs (parallel lines on shared segments are offset), spurs and "+N more" stubs, each a LineSet item per line.
function drawLines(S) {
  S.trunkSet = new LineSet(3, 8, 1); S.trunkSet.mat.linewidth = 4.5;
  S.spurSet = new LineSet(3, 8, 0.9); S.spurSet.mat.linewidth = 2.25;
  const segs = new Map();
  for (const L of S.lines) for (let k = 1; k < L.trunk.length; k++) {
    const a = L.trunk[k - 1], b = L.trunk[k], key = a.i < b.i ? a.i + '-' + b.i : b.i + '-' + a.i;
    if (!segs.has(key)) segs.set(key, { a: a.i < b.i ? a : b, lines: [] });
    const s = segs.get(key); if (!s.lines.includes(L)) s.lines.push(L);
  }
  for (const L of S.lines) {
    for (let k = 1; k < L.trunk.length; k++) {
      const a = L.trunk[k - 1], b = L.trunk[k], key = a.i < b.i ? a.i + '-' + b.i : b.i + '-' + a.i, s = segs.get(key);
      const lo = s.a, hi = lo === a ? b : a, o = (s.lines.indexOf(L) - (s.lines.length - 1) / 2) * GAP;
      let pts = a === b ? [a.local.clone(), a.local.clone()] : offsetPath(route(lo.local, hi.local), o);
      if (lo !== a) pts = pts.slice().reverse();
      pts = rounded(pts).map((v) => v.setZ(0.05));
      L.legs.push(leg(pts)); L.items.push(S.trunkSet.add(pts, L.color, null));
    }
    for (const sp of L.spurs) {
      const pts = route(sp.from.local, sp.nodes[0].local);
      if (sp.nodes[1]) pts.push(sp.nodes[1].local.clone());
      L.spurItems.push(S.spurSet.add(rounded(pts).map((v) => v.setZ(0.04)), L.color, null));
    }
    const end = L.trunk[L.trunk.length - 1].local;
    L.stubEnd = new V3(end.x + 1.1, end.y, 0.04);
    if (L.more) L.spurItems.push(S.spurSet.add([new V3(end.x + 0.3, end.y, 0.04), L.stubEnd.clone()], L.color, null));
  }
  S.spurSet.build(); S.trunkSet.build();
  S.spurSet.obj.renderOrder = 1; S.trunkSet.obj.renderOrder = 2;
  S.group.add(S.spurSet.obj, S.trunkSet.obj);
}

function inst(S, key, geo, mat, list, place, order) {
  const g = geo.clone(), mesh = new THREE.InstancedMesh(g, mat, list.length), m4 = new THREE.Matrix4();
  const col = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
  const al = new THREE.InstancedBufferAttribute(new Float32Array(list.length), 1); al.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aColor', col); g.setAttribute('aAlpha', al);
  list.forEach((e, i) => mesh.setMatrixAt(i, place(e, m4)));
  mesh.frustumCulled = false; mesh.renderOrder = order; mesh.userData = { list, alpha: al, color: col };
  if (key) meshes[key] = mesh;
  S.group.add(mesh);
  return mesh;
}

// Stations (ring + fill), effect badges (the external kinds' own shapes) and the soft folder zones.
function buildMeshes(S) {
  const id = S.part.id, q = new THREE.Quaternion(), v = new V3(), sc = new V3();
  const ring = S.placed.map((it) => ({ node: it.node, color: it.lines.length > 1 ? WHITE : it.lines[0].color }));
  inst(S, `s:${id}:ring`, G.mring, flatMat, ring, (e, m4) => m4.compose(v.copy(e.node.item.local).setZ(0.1), q, sc.setScalar(e.node.item.rad)), 3);
  inst(S, `s:${id}:fill`, G.mdisc, flatMat, S.placed.map((it) => ({ node: it.node, color: FILL })), (e, m4) => m4.compose(v.copy(e.node.item.local).setZ(0.1), q, sc.setScalar(e.node.item.rad)), 3);
  const fx = new Map(), tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.6, 0));
  for (const it of S.placed) it.effects.forEach((e, k) => {
    const kind = EXT[e.kind] ? e.kind : 'other';
    if (!fx.has(kind)) fx.set(kind, []);
    fx.get(kind).push({ node: it.node, color: new THREE.Color(EXT[kind].color), x: it.local.x + it.rad + 0.24 + k * 0.36, y: it.local.y + (it.below ? 0.36 : -0.36) });
  });
  for (const [kind, list] of fx) inst(S, `s:${id}:fx:${kind}`, G[SHAPES['ext_' + kind][0][0]], solidMats[0], list, (e, m4) => m4.compose(v.set(e.x, e.y, 0.2), tilt, sc.setScalar(0.17)), 5);
  // zones: one rounded rect per station tinted by its folder; max blending merges neighbours of a folder into one soft zone
  S.zoneMat = zoneMat.clone();
  const zones = S.placed.map((it) => ({ it, color: new THREE.Color(oklch(0.72, 0.08, hashStr(it.dir) % 360)).multiplyScalar(0.036) }));
  const zm = inst(S, null, G.mzone, S.zoneMat, zones, (e, m4) => m4.compose(v.set(e.it.local.x, e.it.local.y + (e.it.below ? -0.3 : 0.3), -0.1), q, sc.set(COL + 0.6, 1.9, 1)), 0);
  zones.forEach((e, i) => e.color.toArray(zm.userData.color.array, i * 3));
  // zone labels: one per run of same-folder stations on a row, above its first station
  S.zoneLabels = [];
  const done = new Set();
  for (const it of [...S.placed].sort((a, b) => a.r - b.r || a.c - b.c)) {
    if (done.has(it) || it.below) continue;
    let n = 0;
    for (let c = it.c; ; c++) { const x = S.placed.find((y) => y.c === c && y.r === it.r && y.dir === it.dir); if (!x) break; done.add(x); n++; }
    const h = hashStr(it.dir) % 360;
    S.zoneLabels.push({ str: (it.dir === '.' ? S.part.path.split('/').pop() : it.dir.split('/').slice(-2).join('/')) + '/', x: it.local.x - COL / 2 + 0.2, y: it.local.y + 1.25, color: new THREE.Color(oklch(0.8, 0.06, h)), n });
  }
}

export function disposeStruct(S) {
  if (lens?.S === S) closeLens();
  if (ride?.S === S) stopRide();
  if (hoverLines?.[0]?.S === S) hoverLines = null;
  for (const k of S.keys) nodeByKey.delete(k);
  for (const k of Object.keys(meshes)) if (k.startsWith(`s:${S.part.id}:`)) delete meshes[k];
  S.group.traverse((o) => o.geometry?.dispose()); scene.remove(S.group);
  S.zoneMat.dispose(); S.trunkSet.mat.dispose(); S.spurSet.mat.dispose();
  dropText(S); overlay.remove(S.textGroup);
  state.searchItems = state.searchItems.filter((x) => x.sp !== S.part.id);
  structs.delete(S.part.id); S.part.struct = null;
  if (legendS === S) renderLegend(null);
}

// Turn the board to face the camera (only while it is hidden, so it never spins in view).
// pivotX (board-local): that column stays where it is in the world, so turning never moves the board away from where you look.
export function setFacing(S, az, pivotX) {
  if (pivotX !== undefined) { const before = S.group.localToWorld(new V3(pivotX, 0, 0)); S.group.rotation.y = az; S.group.updateMatrixWorld(true); S.group.position.add(before.sub(S.group.localToWorld(new V3(pivotX, 0, 0)))); }
  S.facing = az; S.group.rotation.y = az; S.group.updateMatrixWorld(true); state.redraw = true;
  S.textGroup.position.copy(S.group.position); S.textGroup.rotation.copy(S.group.rotation); S.textGroup.updateMatrixWorld(true);
  for (const it of S.items) if (it.node) it.pos.copy(it.placed ? it.local : tmp.set(0, (S.top + S.bottom) / 2, 0)).applyMatrix4(S.group.matrixWorld);
}

/* ---------------- board text: one atlas texture laid flat on the board ---------------- */
function dropText(S) {
  if (!S.text) return;
  S.textGroup.remove(S.text.mesh); S.text.tex.dispose(); S.text.mesh.geometry.dispose(); S.text.mesh.material.dispose();
  delete meshes[`s:${S.part.id}:text`]; S.text = null;
}

function buildBoardText(S) {
  for (const o of structs.values()) if (o !== S) dropText(o);
  const list = [], add = (e) => list.push({ size: 1, chip: false, align: 'c', node: S.dummy, color: TXT_DEF.clone(), ...e });
  for (const it of S.placed) {
    const ly = it.local.y + (it.below ? -1 : 1) * (it.rad + 0.3), n = Math.floor((COL - 0.4) / (TXT_CHAR * 0.85));
    add({ kind: 'short', it, node: it.node, str: trunc(it.name, n), chip: true, size: 0.85, lx: it.local.x, ly });
    if (it.kind === 'method' && it.parent) add({ kind: 'long', it, node: it.node, str: trunc(fullName(it), n + 8), chip: true, size: 0.85, lx: it.local.x, ly });
  }
  for (const L of S.lines) {
    const e = L.trunk[0];
    add({ kind: 'line', L, str: trunc(L.label, 34), chip: true, color: L.color.clone(), lx: e.local.x - e.rad - 0.3, ly: e.local.y, align: 'r' });
    if (L.more) add({ kind: 'more', L, str: `+${L.more} more`, size: 0.72, color: TXT_DIM.clone(), lx: L.stubEnd.x + 0.15, ly: L.stubEnd.y, align: 'l' });
  }
  for (const z of S.zoneLabels) add({ kind: 'zone', str: z.str, size: 0.72, color: z.color, lx: z.x, ly: z.y, align: 'l' });
  // Atlas packed in rows, each entry as wide as its text. Channels: a = chip fill, r = text, b = chip hairline.
  const W = TXT_W, H = TXT_H, g = document.createElement('canvas').getContext('2d'), font = `500 ${TXT_FONT}px "JetBrains Mono",ui-monospace,Menlo,monospace`;
  g.font = font;
  let x = 0, y = 0;
  for (const e of list) {
    e.w = Math.ceil(g.measureText(e.str).width + (e.chip ? 0.55 : 0.17) * H);
    if (x + e.w > W) { x = 0; y += H; }
    e.x = x; e.y = y; x += e.w + 2;
  }
  const cv = g.canvas; cv.width = W; cv.height = Math.min(y + H, renderer.capabilities.maxTextureSize);
  g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle'; g.globalCompositeOperation = 'lighter';
  const py = H / 8, ch = H - 2 * py, r = H * 0.19;
  for (const e of list) {
    if (e.chip) {
      g.beginPath(); g.roundRect(e.x + 1.5, e.y + py, e.w - 3, ch, r); g.fillStyle = '#00ff00'; g.fill();
      const hair = g.createLinearGradient(0, e.y + py, 0, e.y + py + ch);   // lit top edge: subtle depth
      hair.addColorStop(0, '#0000ff'); hair.addColorStop(1, '#000040');
      g.beginPath(); g.roundRect(e.x + 2, e.y + py + 0.5, e.w - 4, ch - 1, r - 0.5); g.strokeStyle = hair; g.lineWidth = H / 40; g.stroke();
    }
    g.fillStyle = '#ff0000'; g.fillText(e.str, e.x + e.w / 2, e.y + H / 2 + 1);
  }
  const tex = new THREE.CanvasTexture(cv); tex.anisotropy = renderer.capabilities.getMaxAnisotropy(); tex.minFilter = THREE.LinearMipmapLinearFilter;
  const mat = textMat.clone(); mat.uniforms.uMap.value = tex;
  const geo = new THREE.PlaneGeometry(1, 1), mesh = new THREE.InstancedMesh(geo, mat, list.length);
  const col = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3), al = new THREE.InstancedBufferAttribute(new Float32Array(list.length), 1);
  al.setUsage(THREE.DynamicDrawUsage);
  const rect = new Float32Array(list.length * 4);   // u0, v0, u1, v1 (canvas is flipped on upload)
  list.forEach((e, i) => rect.set([e.x / W, 1 - (e.y + H) / cv.height, (e.x + e.w) / W, 1 - e.y / cv.height], i * 4));
  geo.setAttribute('aRect', new THREE.InstancedBufferAttribute(rect, 4)); geo.setAttribute('aColor', col); geo.setAttribute('aAlpha', al);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new V3(), sc = new V3();
  list.forEach((e, i) => {
    const w = TXT_Q * e.size * e.w / H, cx = e.align === 'l' ? e.lx + w / 2 : e.align === 'r' ? e.lx - w / 2 : e.lx;
    mesh.setMatrixAt(i, m4.compose(v.set(cx, e.ly, 0.1), q, sc.set(w, TXT_Q * e.size, 1)));
  });
  mesh.frustumCulled = false; mesh.renderOrder = 4; mesh.userData = { list, alpha: al, color: col };
  S.textGroup.add(mesh); meshes[`s:${S.part.id}:text`] = mesh;
  S.text = { mesh, tex, list };
  recolor();
}

/* ---------------- queries used by the HUD and the code drawer ---------------- */
// Items linked to a board item, for the detail panel: the types a function uses, the functions using a type.
export const usesOf = (it) => (it.usesT || []).map((i) => it.node.owner.struct.items[i]);
export const usersOf = (it) => (it.users || []).map((i) => it.node.owner.struct.items[i]);

const boardLocal = (S, v) => S.group.worldToLocal(tmp.copy(v));

// Near the board, or between it and its part above (so flying from the part down to the board never loses focus).
export function boardNear(S, v) { const l = boardLocal(S, v); return Math.abs(l.x) < S.W / 2 + 4 && l.y < S.top + S.part.r * 1.6 + 6 && l.y > S.bottom - 4 && Math.abs(l.z) < 10; }

// The station a code location belongs to (smallest enclosing span, else by name).
export function structNodeAt(part, path, line, word) {
  const S = part?.struct; if (!S) return null;
  let best = null;
  for (const it of S.placed) if (it.file === path && line >= it.line && line <= Math.max(it.end, it.line) && (!best || it.end - it.line < best.end - best.line)) best = it;
  if (!best && word) best = S.placed.find((it) => it.name === word) || null;
  return best;
}

/* ---------------- camera ---------------- */
const boardDir = (S) => new V3(Math.sin(S.facing), 0.12, Math.cos(S.facing));

// Entering a board makes its part the focus, which then holds while the view stays on the board (neighbouring boards can overlap).
function flyToStation(S, it, dist = 12, dur, hist) {
  state.focusPart = S.part;
  flyTo(it.pos, dist, { dir: boardDir(S), minEl: 0.04, maxEl: 0.18, dur, hist });
}

// A station: fly to it. An item off the lines: frame the metro and open the Lens on it. Nothing: frame the start of the lines.
export function flyToBoard(S, it) {
  if (it?.placed) return flyToStation(S, it);
  const tanH = Math.tan((camera.fov * Math.PI) / 360), viewW = innerWidth - (detail.classList.contains('open') ? detail.offsetWidth + 32 : 0);
  const fw = Math.min(S.W, Math.max(300, viewW) / 7 * TXT_CHAR), e = S.lines[0]?.trunk[0];   // start at the first line's name
  const cx = clamp(e ? e.local.x - Math.min(34, S.lines[0].label.length) * TXT_CHAR - 1 + fw / 2 : 0, -S.W / 2 + fw / 2, S.W / 2 - fw / 2);
  const h = Math.min(S.top - S.bottom, 20), w = (fw + 2) * innerHeight / Math.max(300, viewW);
  const dist = clamp(Math.max(h, w) / (2 * tanH) * 1.05, 12, S.lo * 0.9);
  state.focusPart = S.part;
  flyTo(S.group.localToWorld(new V3(cx, S.top - Math.min(h, dist * tanH * 2) / 2, 0)), dist, { dir: boardDir(S), minEl: 0.04, maxEl: 0.18 });
  if (it) openLens(it);
}

/* ---------------- per frame ---------------- */
export function updateStructs(dt, fp) {
  const k = Math.min(1, dt * 6);
  let top = null;
  for (const S of structs.values()) {
    const p = S.part;
    if (p === fp && S.depth < 0.05 && !fly.on) {
      const d = tmpDir.subVectors(camPos, S.group.position), az = Math.atan2(d.x, d.z);
      if (Math.abs(Math.atan2(Math.sin(az - S.facing), Math.cos(az - S.facing))) > 0.3) setFacing(S, az, clamp(boardLocal(S, controls.target).x, -S.W / 2, S.W / 2));
    }
    const l = boardLocal(S, camPos);
    const dBoard = Math.hypot(l.x - clamp(l.x, -S.W / 2, S.W / 2), l.y - clamp(l.y, S.bottom, S.top), l.z);
    // shows when you zoom in past the part, or from further away when you look at the board head-on
    camera.getWorldDirection(tmpDir);
    const level = 1 - smooth(0.45, 0.7, Math.asin(clamp(-tmpDir.y, -1, 1)));
    const want = (p === fp || lens?.S === S) && kindOn[kindOf(p)] && l.z > 0 ? Math.max(1 - smooth(S.near, S.near * 1.3, dBoard), level * (1 - smooth(S.lo, S.hi_, dBoard))) : 0;
    S.depth += (want - S.depth) * Math.min(1, dt * 5);
    if (Math.abs(want - S.depth) < 0.002) S.depth = want;   // settle, so an idle view stops changing
    const vis = S.depth >= 0.003;   // a hidden board is not drawn at all
    if (S.group.visible !== vis) { S.group.visible = vis; state.redraw = true; }
    if (!vis && !S.live) continue;
    S.live = S.depth >= 0.003;
    if (!top || S.depth > top.depth) top = S;
    // emphasis: the ridden line, else the hovered legend line, else a gate's lines, else the lines through the hovered station
    const hov = state.hoverEnt?.node?.owner === p && state.hoverEnt.node.item?.placed ? state.hoverEnt.node.item : null;
    const gl = gateLines?.filter((L) => L.S === S);
    const fl = ride?.S === S ? ride.lines : hoverLines?.[0]?.S === S ? hoverLines : gl?.length ? gl : hov?.lines.length ? hov.lines : null;
    for (const L of S.lines) {
      const lit = fl && fl.includes(L), t = S.depth * (L.on ? (fl ? (lit ? 1 : 0.1) : 0.85) : 0);
      L.a += (t - L.a) * k; if (Math.abs(t - L.a) < 0.003) L.a = t;
      for (const x of L.items) S.trunkSet.setAlpha(x, L.a, lit ? 1 : 0);
      for (const x of L.spurItems) S.spurSet.setAlpha(x, L.a * 0.75, 0);
    }
    S.trunkSet.flush(); S.spurSet.flush();
    for (const it of S.placed) {
      const on = it.lines.some((L) => L.on), lit = !fl || it === hov || it.lines.some((L) => fl.includes(L));
      const t = S.depth * (on ? (lit ? 1 : 0.15) : 0);
      it.node.alpha += (t - it.node.alpha) * k; if (Math.abs(t - it.node.alpha) < 0.003) it.node.alpha = t;
      it.dn = camPos.distanceTo(it.pos);
    }
    const za = S.zoneMat.uniforms.uA, zv = S.depth * (fl ? 0.55 : 1);
    if (za.value !== zv) { za.value = zv; state.redraw = true; }
    if (S.depth > 0.01 && !S.text) buildBoardText(S);
    if (S.text) {
      const arr = S.text.mesh.userData.alpha.array, list = S.text.list;
      let changed = false;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        let v;
        if (e.it) {
          const a = Math.min(1, e.it.node.alpha * 1.15), near = e.it.kind === 'method' && e.it.parent && e.it.dn < 11 ? 1 : 0;   // switch, never cross-fade
          v = e.kind === 'short' ? a * (1 - near) : a * near;
        } else v = e.kind === 'zone' ? S.depth * (fl ? 0.25 : 0.7) : Math.min(1, e.L.a * 1.18) * (e.kind === 'more' ? 0.75 : 1);
        v = Math.fround(v);
        if (arr[i] !== v) { arr[i] = v; changed = true; }
      }
      if (changed) { S.text.mesh.userData.alpha.needsUpdate = true; state.redraw = true; }
      if (S.textGroup.visible !== S.depth > 0.01) { S.textGroup.visible = S.depth > 0.01; state.redraw = true; }
    }
  }
  const show = !!top && top.depth > 0.5 && !player.on && !lens;
  if (show && top !== legendS) renderLegend(top);
  $('#boardLegend').hidden = !show;
  document.body.classList.toggle('metro-on', show || !!lens);
  if (ride && (player.on || ride.S !== legendS)) stopRide();
  updateRide(dt);
  if (lens) placeLens();
}

// Light the metro lines a gate controls ("part:lineId" refs), or none.
export function setGateLines(refs) {
  gateLines = refs?.map((r) => { const k = r.lastIndexOf(':'); return parts.get(r.slice(0, k))?.struct?.lines.find((L) => L.id === r.slice(k + 1)); }).filter(Boolean) || null;
  state.redraw = true;
}

/* ---------------- line legend ---------------- */
function renderLegend(S) {
  legendS = S;
  const el = $('#boardLegend');
  if (!S) { el.innerHTML = ''; return; }
  const rows = S.lines.map((L, i) => {
    const t = PORTS[L.kind] || PORTS.function;
    return `<div class="ml-row${L.on ? '' : ' off'}" data-l="${i}" style="--c:${L.css}">
      <label class="ml-sw" title="Show or hide this line"><input type="checkbox"${L.on ? ' checked' : ''}><i></i></label>
      <button class="ml-nm" title="${esc(L.label)}"><span class="pt" style="--c:${t.color}">${t.label}</span><span class="t">${esc(L.label)}</span></button>
      <span class="ml-n" title="functions this entry reaches">${L.reach}</span>
      <button class="ml-go" title="Ride this line">${I.play}</button></div>`;
  }).join('');
  el.innerHTML = `<div class="ml-hd"><span class="tag">Lines</span><b>${esc(S.part.name)}</b><span class="ml-cnt">${S.placed.length} stations</span></div>
    <div class="ml-list">${rows || '<div class="ml-ft">No entry points found</div>'}</div>
    <div class="ml-ft">${S.hiddenLines ? `+${S.hiddenLines} smaller entry points not drawn · ` : ''}<span title="The Lens: a function's callers and callees as cards around it">click a station for the Lens</span> · <kbd>/</kbd> search any function</div>`;
}

/* ---------------- ride: a train pulse goes station by station, the camera follows, captions and voice ---------------- */
const MOVE = 0.9, STEP = 2.6;

function startRide(L) {
  closeLens(); stopRide();
  if (!ridePulse) {
    ridePulse = new THREE.Sprite(new THREE.SpriteMaterial({ map: pulseTex, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true }));
    ridePulse.material.color.multiplyScalar(2.2); ridePulse.renderOrder = 6; ridePulse.scale.setScalar(1.1);
  }
  L.on = true; renderLegend(L.S);
  ride = { S: L.S, L, lines: [L], i: 0, t: 0, voiceEnd: null, playing: true };
  L.S.group.add(ridePulse); ridePulse.visible = true;
  $('#ride').hidden = false; $('#ride').style.setProperty('--c', L.css);
  gotoStation(0);
}

function stopRide() {
  if (!ride) return;
  ride = null; cancelSpeech();
  ridePulse.visible = false; ridePulse.parent?.remove(ridePulse);
  $('#ride').hidden = true;
}

function gotoStation(i, fromVoice = false) {
  const r = ride, st = r.L.trunk, cur = st[i], prev = st[i - 1];
  r.i = i; r.t = 0;
  $('#ride').innerHTML = `<span class="rd-sw"></span><span class="rd-l" title="${esc(r.L.label)}">${esc(trunc(r.L.label, 30))}</span><span class="rd-n">${i + 1}/${st.length}</span>
    <span class="rd-cap">${prev ? `${esc(prev.name)} <span class="ar">→</span> <b>${esc(cur.name)}</b>` : `starts at <b>${esc(cur.name)}</b>`}</span>
    <button data-r="prev" title="Previous station">${I.back}</button><button data-r="play" title="Play / pause">${r.playing ? I.pause : I.play}</button><button data-r="next" title="Next station">${I.fwd}</button><button data-r="stop" title="Stop (Esc)">${I.x}</button>`;
  if (!fromVoice) narrateRide(r);
  flyToStation(r.S, cur, clamp(camPos.distanceTo(controls.target), 12, 22), i ? 1.1 : 1.4, !i);
}

// The rest of the ride is one utterance that moves the stations itself (no audio pop between them).
function narrateRide(r) {
  const texts = r.L.trunk.map((st, k) => (k ? `then ${spoken(st)}` : `${r.L.label}. Starts at ${spoken(st)}`));
  const ok = voice.on && speakFlow(texts, r.i, 1, (k) => { if (ride === r) gotoStation(k, true); },
    () => { if (ride === r) r.voiceEnd = r.t; });
  r.voiceEnd = ok || (voice.on && speak(texts[r.i], 1, () => { if (ride === r) r.voiceEnd = r.t; })) ? Infinity : null;
}

function updateRide(dt) {
  if (!ride) return;
  state.redraw = true;   // the ride pulse moves
  const r = ride;
  if (r.playing) r.t += dt;
  const lg = r.L.legs[r.i - 1];
  if (lg) pointAt(lg, reducedMotion() ? 1 : ease(clamp(r.t / MOVE, 0, 1)), ridePulse.position);
  else ridePulse.position.copy(r.L.trunk[r.i].local);
  ridePulse.position.z = 0.3;
  const end = r.voiceEnd == null ? STEP : r.voiceEnd === Infinity ? 15 : Math.max(MOVE + 0.2, r.voiceEnd + 0.5);
  if (r.playing && r.t > end) {
    if (r.i < r.L.trunk.length - 1) gotoStation(r.i + 1);
    else { r.playing = false; $('#ride [data-r=play]').innerHTML = I.replay; }
  }
}

/* ---------------- Lens: callers left, callees right, as file cards around the centre ---------------- */
export function openLens(it) {
  const S = it.node?.owner?.struct; if (!S) return;
  remember();   // before the Lens changes, so back returns to the view without it
  stopRide();
  lens = { S, trail: [it] };
  $('#lens').hidden = false;
  renderLens(0);
  if (it.placed) flyToStation(S, it, 14);
}

function recentre(it, dir) {
  const k = lens.trail.indexOf(it);
  if (k >= 0) lens.trail.length = k + 1; else lens.trail.push(it);
  renderLens(dir);
  if (it.placed) flyToStation(lens.S, it, 14, 1.0);
}

// The Lens as a place to come back to (nav.js), and back to it.
export const lensPlace = () => lens && { it: lens.trail[lens.trail.length - 1], xray: xrayOn };
export function showLens(p) { if (!p) return closeLens(); xrayOn = p.xray; openLens(p.it); }

function closeLens() {
  if (!lens) return;
  lens = null; $('#lens').hidden = true; $('#lens').innerHTML = '';
}

function toggleXray() {
  if (!lens || lens.trail[lens.trail.length - 1].kind === 'type') return;
  xrayOn = !xrayOn;
  renderLens(0);
}

// A call in the x-ray: re-centre on its callee when it is in this part (one of the function's callees first).
function xrayCall(n) {
  const S = lens.S, it = lens.trail[lens.trail.length - 1];
  const named = (x) => x.node && x.kind !== 'type' && x.name === n.callee;
  const to = it.callees.map((i) => S.items[i]).find(named) || S.items.find((x) => named(x) && x.file === it.file) || S.items.find(named);
  if (to) recentre(to, 1);
  return !!to;
}

const KIND_LOOK = { function: ['var(--cyan)', 'fn'], method: ['var(--violet)', 'method'], type: ['var(--green)', 'type'] };
const lineDots = (it) => it.lines.map((L) => `<i class="lz-ln" style="--c:${L.css}" title="${esc(L.label)}"></i>`).join('');

function lensCards(S, ids, side) {
  const groups = new Map();
  for (const i of ids) { const x = S.items[i]; if (!x.node) continue; if (!groups.has(x.file)) groups.set(x.file, []); groups.get(x.file).push(x); }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  let budget = 18, h = '', rest = 0, restFiles = 0;
  for (const [file, list] of sorted) {
    if (budget <= 0) { rest += list.length; restFiles++; continue; }
    const shown = list.slice(0, Math.max(2, Math.min(list.length, budget))); budget -= shown.length;
    const fname = file.split('/').pop(), dir = list[0].dir;
    h += `<div class="lz-card" data-side="${side}"><div class="lz-file">${I.file}<b>${esc(fname)}</b><span>${esc(dir === '.' ? '' : dir)}</span><em>${list.length}</em></div>
      ${shown.map((x) => `<button class="lz-row" data-i="${x.i}" data-side="${side}" style="--k:${KIND_LOOK[x.kind]?.[0]}">${x.kind === 'type' ? I.type : x.kind === 'method' ? I.method : I.fn}<span class="nm">${esc(fullName(x))}</span>${lineDots(x)}</button>`).join('')}
      ${list.length > shown.length ? `<div class="lz-more">+${list.length - shown.length} more</div>` : ''}</div>`;
  }
  if (rest) h += `<div class="lz-more">+${rest} more in ${restFiles} file${restFiles > 1 ? 's' : ''}</div>`;
  return h;
}

function renderLens(dir) {
  const { S, trail } = lens, it = trail[trail.length - 1], isType = it.kind === 'type', el = $('#lens');
  const left = isType ? it.users : it.callers;
  const right = isType ? S.items.filter((m) => m.kind === 'method' && m.parent === it.name && m.dir === it.dir).map((m) => m.i) : it.callees;
  const [kc, kl] = KIND_LOOK[it.kind] || KIND_LOOK.function;
  const types = it.usesT.map((i) => S.items[i]).filter((t, k, a) => a.findIndex((u) => u.name === t.name) === k);   // same-named types read as one chip
  const empty = (txt) => `<div class="lz-empty">${txt}</div>`;
  const xr = xrayOn && !isType;
  el.classList.toggle('xray', xr);
  const centre = xr ? `<div class="lz-centre xr-card" style="--k:${kc}">
        <div class="xr-hd"><div class="xr-id"><div class="lz-pills"><span class="pill" style="--k:${kc}">${kl}</span>${it.test ? '<span class="pill soft">test</span>' : ''}${lineDots(it)}</div>
          <h2>${esc(fullName(it)).replace(/([._])/g, '$1<wbr>')}</h2><button class="lz-ref" data-lz="code">${I.file}${esc(it.file.split('/').slice(-2).join('/'))}:${it.line}</button></div>
          <button class="xr-tog on" data-lz="xray" aria-pressed="true" title="Back to the card (x)">${I.xray}X-ray<kbd>x</kbd></button></div>
        <div class="xr"></div></div>` : `<div class="lz-centre" style="--k:${kc}">
        <div class="lz-pills"><span class="pill" style="--k:${kc}">${kl}</span>${it.test ? '<span class="pill soft">test</span>' : ''}${lineDots(it)}${it.placed ? '' : '<span class="pill soft">not on a line</span>'}</div>
        <h2>${esc(fullName(it)).replace(/([._])/g, '$1<wbr>')}</h2>
        <button class="lz-ref" data-lz="code">${I.file}${esc(it.file.split('/').slice(-2).join('/'))}:${it.line}</button>
        ${types.length ? `<div class="lz-sh">Uses types</div><div class="lz-chips">${types.map((t) => `<button class="lz-chip" data-i="${t.i}" data-side="r">${I.type}${esc(t.name)}</button>`).join('')}</div>` : ''}
        ${it.effects.length ? `<div class="lz-sh">Touches</div><div class="lz-chips">${it.effects.map((e) => { const x = EXT[e.kind] || EXT.other; return `<button class="lz-chip fx" data-ref="${esc(e.ref)}" style="--k:${x.color}" title="${esc(e.ref)}">${x.icon}${esc(e.target)}</button>`; }).join('')}</div>` : ''}
        ${it.outside && left.length ? `<p class="lz-note">Also called ${it.outside}× from other parts</p>` : ''}
        <div class="lz-btns"><button class="btn primary" data-lz="code">${I.code}Open code</button>${isType ? '' : `<button class="btn" data-lz="xray" title="The function as a flowchart (x)">${I.xray}X-ray</button>`}${it.placed ? `<button class="btn" data-lz="map">${I.flow}Show on metro</button>` : ''}</div>
      </div>`;
  el.innerHTML = `<div class="lz-top"><nav class="lz-crumbs"><button data-crumb="-1">${I.layers}${esc(S.part.name)} metro</button>${trail.map((x, k) => `<span class="sep">${I.chevR}</span>${k === trail.length - 1 ? `<span class="cur">${esc(x.name)}</span>` : `<button data-crumb="${k}">${esc(x.name)}</button>`}`).join('')}</nav>
    <span class="lz-hint"><kbd>esc</kbd> back to metro</span><button class="lz-x" data-lz="close" title="Back to metro (Esc)">${I.x}</button></div>
    <div class="lz-stage"><svg class="lz-arrows" aria-hidden="true"></svg>
      <div class="lz-col" data-col="l"><div class="lz-h">${isType ? 'Used by' : 'Called by'} <em>${left.length}</em></div>${left.length ? lensCards(S, left, 'l') : empty(it.outside ? `Called ${it.outside}× from other parts only` : 'Nothing in this part calls it')}</div>
      <div class="lz-mid">${centre}</div>
      <div class="lz-col" data-col="r"><div class="lz-h">${isType ? 'Methods' : 'Calls'} <em>${right.length}</em></div>${right.length ? lensCards(S, right, 'r') : empty(isType ? 'No methods' : 'Calls nothing in this part')}</div>
    </div>`;
  const stage = el.querySelector('.lz-stage');
  if (dir && !reducedMotion()) stage.animate([{ transform: `translateX(${dir * 56}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.32,.72,0,1)' });
  for (const c of stage.querySelectorAll('.lz-col')) c.addEventListener('scroll', drawArrows, { passive: true });
  placeLens(); requestAnimationFrame(drawArrows);
  if (xr) mountXray(el.querySelector('.xr'), it, xrayCall);
}

// One arrow per file card: into the centre from the callers, out of the centre to the callees.
function drawArrows() {
  const stage = $('#lens .lz-stage'); if (!stage) return;
  const svg = stage.querySelector('svg'), box = stage.getBoundingClientRect(), mid = stage.querySelector('.lz-centre').getBoundingClientRect();
  const cards = [...stage.querySelectorAll('.lz-card')], h = [];
  for (const side of ['l', 'r']) {
    const list = cards.filter((c) => c.dataset.side === side), n = list.length;
    list.forEach((c, k) => {
      const r = c.getBoundingClientRect(), col = c.parentElement.getBoundingClientRect();
      const cy = r.top + 16;
      if (cy < col.top + 24 || cy > col.bottom) return;   // scrolled out of its column
      const my = mid.top + (n > 1 ? 28 + (k / (n - 1)) * Math.max(0, mid.height - 56) : mid.height / 2);
      const [x1, y1, x2, y2] = side === 'l' ? [r.right + 4, cy, mid.left - 6, my] : [mid.right + 4, my, r.left - 6, cy];
      const dx = Math.max(24, (x2 - x1) / 2);
      h.push(`<path class="${side}" d="M${(x1 - box.left).toFixed(1)} ${(y1 - box.top).toFixed(1)}C${(x1 + dx - box.left).toFixed(1)} ${(y1 - box.top).toFixed(1)},${(x2 - dx - box.left).toFixed(1)} ${(y2 - box.top).toFixed(1)},${(x2 - box.left).toFixed(1)} ${(y2 - box.top).toFixed(1)}" marker-end="url(#lzA${side})"/>`);
    });
  }
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  svg.innerHTML = `<defs>${['l', 'r'].map((s) => `<marker id="lzA${s}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0.5L7.5 4L0 7.5z" style="fill:var(--rel-${s === 'l' ? 'caller' : 'callee'})"/></marker>`).join('')}</defs>${h.join('')}`;
}

// Keep the Lens in the free area left of the detail panel and the code drawer.
function placeLens() {
  let r = innerWidth;
  for (const el of [detail, drawer]) if (el.classList.contains('open')) r = Math.min(r, el.getBoundingClientRect().left);
  const right = Math.round(innerWidth - r + 16) + 'px', el = $('#lens');
  if (el.style.right !== right) { el.style.right = right; requestAnimationFrame(drawArrows); }
}

export function initBoard() {
  structs = new Map();   // partId -> board
  state.showTests = false;
  state.structStatus = '';
  // board text: names drawn into one atlas texture and laid flat on the board (no screen-space declutter)
  TXT_W = 4096;   // atlas width in px
  TXT_H = devicePixelRatio > 1 ? 48 : 36;   // atlas row height in px: ~2x the on-screen size at reading distance
  TXT_FONT = Math.round(TXT_H * 0.52);
  TXT_Q = 0.5;
  TXT_CHAR = (TXT_Q / TXT_H) * TXT_FONT * 0.61;   // world width of one monospace character
  // uRows marks the mesh for scene.js, which then leaves its alpha alone
  textMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: null }, uRows: { value: 1 }, uBg: { value: new THREE.Color('#141821') } }, transparent: true, depthWrite: false, depthTest: false,
    vertexShader: `
      attribute vec4 aRect; attribute vec3 aColor; attribute float aAlpha;
      varying vec2 vUv; varying vec3 vC; varying float vA;
      void main(){ vUv = mix(aRect.xy, aRect.zw, uv); vC = aColor; vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.); }`,
    fragmentShader: `
      uniform sampler2D uMap; uniform vec3 uBg; varying vec2 vUv; varying vec3 vC; varying float vA;
      void main(){
        if (vA < 0.01) discard;
        vec4 t = texture2D(uMap, vUv, -0.5); if (t.a < 0.02) discard;
        vec3 c = mix(mix(uBg, vC * 0.45, t.b * 0.5), vC, t.r);
        gl_FragColor = vec4(c, t.a * vA * mix(0.88, 1.0, max(t.r, t.b)));
        #include <colorspace_fragment>
      }`,
  });
  // flat board marks (stations): per-instance colour and alpha, no lighting
  flatMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: `attribute vec3 aColor; attribute float aAlpha; varying vec3 vC; varying float vA;
      void main(){ vC = aColor; vA = aAlpha; gl_Position = aAlpha < 0.004 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.); }`,
    fragmentShader: 'varying vec3 vC; varying float vA; void main(){ gl_FragColor = vec4(vC, vA); }',
  });
  // folder zones: soft rounded rects, max-blended so a folder's neighbouring stations merge into one even tint
  zoneMat = new THREE.ShaderMaterial({
    uniforms: { uA: { value: 0 } }, transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation,
    vertexShader: `attribute vec3 aColor; varying vec3 vC; varying vec2 vP; varying vec2 vS;
      void main(){ vC = aColor; vS = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz)); vP = (uv - 0.5) * vS;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.); }`,
    fragmentShader: `uniform float uA; varying vec3 vC; varying vec2 vP; varying vec2 vS;
      void main(){
        if (uA < 0.004) discard;
        float r = 0.8; vec2 q = abs(vP) - vS * 0.5 + r;
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
        gl_FragColor = vec4(vC * uA * (1.0 - smoothstep(-0.45, 0.0, d)), 1.0);
      }`,
  });
  G.mring = new THREE.RingGeometry(0.7, 1, 48);
  G.mdisc = new THREE.CircleGeometry(0.7, 48);
  G.mzone = new THREE.PlaneGeometry(1, 1);
  TXT_DEF = new THREE.Color(THEME.board.text);
  TXT_DIM = new THREE.Color(THEME.board.textStub);
  WHITE = new THREE.Color('#dfe3ea');   // under the bloom threshold: interchanges stay crisp
  FILL = new THREE.Color('#0e1117');
  tmp = new V3(); tmpDir = new V3();
  document.body.insertAdjacentHTML('beforeend', '<div id="ride" class="hud glass" hidden></div><div id="lens" class="hud glass" hidden></div>');
  const leg = $('#boardLegend'), lineOf = (e) => legendS?.lines[+e.target.closest('[data-l]')?.dataset.l];
  leg.addEventListener('mouseover', (e) => { const L = lineOf(e); hoverLines = L ? [L] : null; });
  leg.addEventListener('mouseleave', () => { hoverLines = null; });
  leg.addEventListener('change', (e) => { const L = lineOf(e); if (L) { L.on = e.target.checked; e.target.closest('.ml-row').classList.toggle('off', !L.on); } });
  leg.addEventListener('click', (e) => {
    const L = lineOf(e); if (!L) return;
    if (e.target.closest('.ml-go')) startRide(L);
    else if (e.target.closest('.ml-nm')) flyToStation(L.S, L.trunk[0], 16);
  });
  $('#ride').addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]'); if (!b || !ride) return;
    const r = ride, a = b.dataset.r;
    if (a === 'stop') stopRide();
    else if (a === 'prev') gotoStation(Math.max(0, r.i - 1));
    else if (a === 'next') gotoStation(Math.min(r.L.trunk.length - 1, r.i + 1));
    else if (!r.playing && r.i === r.L.trunk.length - 1) { r.playing = true; gotoStation(0); }
    else { r.playing = !r.playing; b.innerHTML = r.playing ? I.pause : I.play; if (!r.playing) cancelSpeech(); }
  });
  $('#lens').addEventListener('click', (e) => {
    if (!lens) return;
    const t = e.target, S = lens.S;
    const c = t.closest('[data-crumb]');
    if (c) { const k = +c.dataset.crumb; if (k < 0) return closeLens(); return recentre(lens.trail[k], -1); }
    const row = t.closest('[data-i]'); if (row) return recentre(S.items[+row.dataset.i], row.dataset.side === 'l' ? -1 : 1);
    const fx = t.closest('[data-ref]'); if (fx) return openCode(fx.dataset.ref);
    const a = t.closest('[data-lz]')?.dataset.lz, it = lens.trail[lens.trail.length - 1];
    if (a === 'close') closeLens();
    else if (a === 'code') openCode(`${it.file}:${it.line}`);
    else if (a === 'map') { closeLens(); flyToStation(S, it); }
    else if (a === 'xray') toggleXray();
  });
  addEventListener('resize', () => { if (lens) requestAnimationFrame(drawArrows); });
  // x: the Lens's function as an x-ray flowchart, and back
  addEventListener('keydown', (e) => {
    if (!lens || e.key !== 'x' || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input,textarea,select')) return;
    e.preventDefault(); toggleXray();
  });
  // Esc: back from the Lens to the metro, or stop a ride (the code drawer and its popover close first)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.target.closest?.('input,textarea,select') || drawer.classList.contains('open') || gpop.classList.contains('open')) return;
    if (lens) closeLens(); else if (ride) stopRide(); else return;
    e.stopPropagation();
  }, true);
}
