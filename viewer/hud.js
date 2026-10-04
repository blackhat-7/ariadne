// hud.js
// Exports: labelLayer, labels, Label, cand, acc, tmpV, updateLabels, hoverEl, updateHover, hoverHtml, detail, dbody, codeslot, openPanel, closeDetail, rf, goLink, flowHtml, showDetail, openCode, openExcerpt, level, updateCrumbs, stepOut, mini, mg, drawMini, buildSearch, fuzzy, runSearch, renderResults, openSearch, closeSearch, shapeIcons, buildLegend, setKinds, resizable, addHandle, panelMax, panelMin, initLabels, initHoverCard, initDetailPanel, initBreadcrumb, initMinimap, initSearch, initLegend, initResizablePanels
// Imports: state: state | board: buildStruct, disposeStruct, flyToBoard, setFacing, setGateLines, structs | drawer: codeHtml, drawer, dtree, getJSON, openFile | main: act | scene: G, SHAPES, camPos, camera, clusters, controls, dive, docks, entFromEvent, entFromNode, exts, flyOverview, flyToEnt, gotoStep, kindOn, nodes, parts, playFlow, player, recolor, select, setEmphasis, stage | theme: EXT, KINDS, PORTS, VOXEL, extOf, kindOf | util: $, V3, clamp, esc | voxel: voxPreview | voxels: externalModel, partModel
import * as THREE from 'three';
import { state } from './state.js';
import { buildStruct, disposeStruct, flyToBoard, setFacing, setGateLines, structs } from './board.js';
import { codeHtml, drawer, dtree, getJSON, openFile } from './drawer.js';
import { act } from './main.js';
import { G, SHAPES, camPos, camera, clusters, controls, dive, docks, entFromEvent, entFromNode, exts, flyOverview, flyToEnt, gotoStep, kindOn, nodes, parts, playFlow, player, recolor, select, setEmphasis, stage } from './scene.js';
import { EXT, KINDS, PORTS, VOXEL, extOf, kindOf } from './theme.js';
import { $, V3, clamp, esc } from './util.js';
import { voxPreview } from './voxel.js';
import { externalModel, partModel } from './voxels.js';

/* SF-Symbols-style line icons (Lucide geometry, 24px grid). */
// Size, fill and stroke are set on the element too, so an icon stays small and outlined even before hud.css applies.
const ic = (d, cls = '') => `<svg class="ic ${cls}" width="14" height="14" viewBox="0 0 24 24" fill="${cls === 'fill' ? 'currentColor' : 'none'}" stroke="${cls === 'fill' ? 'none' : 'currentColor'}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const I = {
  search: ic('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  chevR: ic('<path d="m9 6 6 6-6 6"/>'),
  chevL: ic('<path d="m15 6-6 6 6 6"/>'),
  chevD: ic('<path d="m6 9 6 6 6-6"/>'),
  inArrow: ic('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
  outArrow: ic('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  play: ic('<path d="M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.5-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7z"/>', 'fill'),
  pause: ic('<rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/>', 'fill'),
  back: ic('<path d="M19 5.6v12.8a.8.8 0 0 1-1.2.7L8.5 12.7a.8.8 0 0 1 0-1.4l9.3-6.4a.8.8 0 0 1 1.2.7z"/><rect x="5" y="5" width="2.6" height="14" rx="1"/>', 'fill'),
  fwd: ic('<path d="M5 5.6v12.8a.8.8 0 0 0 1.2.7l9.3-6.4a.8.8 0 0 0 0-1.4L6.2 4.9A.8.8 0 0 0 5 5.6z"/><rect x="16.4" y="5" width="2.6" height="14" rx="1"/>', 'fill'),
  replay: ic('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>'),
  x: ic('<path d="M18 6 6 18M6 6l12 12"/>'),
  speaker: ic('<path d="M11 5.2a.8.8 0 0 0-1.3-.6L6.3 7.5a2 2 0 0 1-1.3.5H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1a2 2 0 0 1 1.3.5l3.4 2.9a.8.8 0 0 0 1.3-.6z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18.5 6a8.5 8.5 0 0 1 0 12"/>'),
  speakerOff: ic('<path d="M11 5.2a.8.8 0 0 0-1.3-.6L6.3 7.5a2 2 0 0 1-1.3.5H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1a2 2 0 0 1 1.3.5l3.4 2.9a.8.8 0 0 0 1.3-.6z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>'),
  layers: ic('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'),
  flow: ic('<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7.5a3.5 3.5 0 0 0 0-7h-7a3.5 3.5 0 0 1 0-7H16"/>'),
  fn: ic('<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/>'),
  method: ic('<path d="M12 3.5 20.5 12 12 20.5 3.5 12z"/>'),
  type: ic('<rect x="4" y="4" width="16" height="16" rx="3.5"/>'),
  file: ic('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  tag: ic('<path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9z"/><circle cx="8" cy="8" r="1.4"/>'),
  globe: ic('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  entry: ic('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>'),
  radio: ic('<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.2"/>'),
  cube: ic('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>'),
  info: ic('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4.5M12 8h.01"/>'),
  code: ic('<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>'),
  xray: ic('<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M12 7.5v3M9 12.5h6M12 12.5v4M9.5 16.5h5"/>'),
  spark: ic('<path d="M11 3.5 12.6 8.4 17.5 10 12.6 11.6 11 16.5 9.4 11.6 4.5 10 9.4 8.4z"/><path d="M18 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'),
  branch: ic('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-11.5 6.5"/>'),
  shield: ic('<path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/>'),
  flag: ic('<path d="M5 21V4.5M5 4.5h11.5l-2.2 4 2.2 4H5"/>'),
  env: ic('<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="m7 10 3 2.5L7 15M12.5 15h4.5"/>'),
  config: ic('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  focus: ic('<circle cx="12" cy="12" r="3"/><path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/>'),
  states: ic('<rect x="2.5" y="9" width="7" height="6" rx="3"/><rect x="14.5" y="9" width="7" height="6" rx="3"/><path d="M9.5 12h5M12.5 10l2 2-2 2"/>'),
};
// Colours for code-structure items (methods, functions, types).
const SNODE = { type: { color: 'var(--green)', icon: I.type }, method: { color: 'var(--violet)', icon: I.method }, function: { color: 'var(--cyan)', icon: I.fn } };

export let labelLayer, labels, cand, acc, tmpV, hoverEl, detail, dbody, codeslot, rf, goLink, mini, mg, panelMax, panelMin;
let accent = '#22d3ee';

export class Label {
  constructor(html, cls, pos, prio, opts = {}) {
    this.el = document.createElement('div'); this.el.className = 'lb ' + cls; this.el.innerHTML = html;
    if (opts.style) this.el.style.cssText = opts.style;
    this.pos = pos; this.prio = prio; this.mode = opts.mode || 'above'; this.dy = opts.dy ?? 6;
    this.want = 0; this.cur = 0; this.w = 0; this.h = 0; this.x0 = 0; this.y0 = 0; this.ok = false; this.boost = 0;
    this.attached = false; this.shown = false; this.pe = false; this.sx = this.sy = this.so = NaN; this.ent = opts.ent || null;
    if (this.ent) { this.el.classList.add('click'); this.el._ent = this.ent; }
    labels.push(this);
  }
}

export function updateLabels(dt) {
  const W = innerWidth, H = innerHeight;
  let fresh = null;
  for (const L of labels) if (L.want > 0.01 && !L.attached) { labelLayer.appendChild(L.el); L.attached = L.shown = true; (fresh ||= []).push(L); }
  if (fresh) for (const L of fresh) { L.w = L.el.offsetWidth; L.h = L.el.offsetHeight; }
  cand.length = 0;
  for (const L of labels) {
    L.ok = false;
    if (L.want <= 0.01) continue;
    tmpV.copy(L.pos).project(camera);
    if (tmpV.z > 1 || tmpV.z < -1) continue;
    const x = (tmpV.x * 0.5 + 0.5) * W, y = (-tmpV.y * 0.5 + 0.5) * H;
    if (L.mode === 'above') { L.x0 = x - L.w / 2; L.y0 = y - L.dy - L.h; }
    else if (L.mode === 'right') { L.x0 = x + L.dy; L.y0 = y - 2; }
    else if (L.mode === 'left') { L.x0 = x - L.dy - L.w; L.y0 = y - 2; }
    else if (L.mode === 'below') { L.x0 = x - L.w / 2; L.y0 = y + L.dy; }
    else { L.x0 = x - L.w / 2; L.y0 = y - L.h / 2; }
    if (L.x0 > W || L.y0 > H || L.x0 + L.w < 0 || L.y0 + L.h < 0) continue;
    L.score = L.prio * (0.55 + 0.45 * L.want) + (L.cur > 0.5 ? 6 : 0) + L.boost;
    cand.push(L);
  }
  cand.sort((a, b) => b.score - a.score);
  let n = 0;
  const hit = (L, y) => { for (let i = 0; i < n; i++) { const A = acc[i]; if (L.x0 < A.x0 + A.w + 14 && L.x0 + L.w + 14 > A.x0 && y < A.y0 + A.h + 8 && y + L.h + 8 > A.y0) return A; } return null; };
  for (const L of cand) {
    const A = hit(L, L.y0);
    // In the way of a placed label: slide just clear of it (at most its own height plus the gap) rather than vanish.
    const y = !A ? L.y0 : [A.y0 + A.h + 8, A.y0 - 8 - L.h].find((y) => Math.abs(y - L.y0) <= L.h + 8 && !hit(L, y));
    if (y !== undefined) { L.y0 = y; acc[n++] = L; L.ok = true; }
  }
  const k = Math.min(1, dt * 10);
  for (const L of labels) {
    if (!L.attached) continue;
    const target = L.ok ? L.want : 0;
    L.cur += (target - L.cur) * k;
    if (L.cur < 0.02 && target === 0) { if (L.shown) { L.el.style.display = 'none'; L.shown = false; } continue; }
    if (!L.shown) { L.el.style.display = ''; L.shown = true; }
    // write styles only when they change: an idle view costs no style recalculation
    const x = Math.round(L.x0), y = Math.round(L.y0), o = Math.round(L.cur * 100);
    if (x !== L.sx || y !== L.sy) { L.sx = x; L.sy = y; L.el.style.transform = `translate3d(${x}px,${y}px,0)`; }
    if (o !== L.so) { L.so = o; L.el.style.opacity = o / 100; }
    const pe = L.cur > 0.4;
    if (pe !== L.pe) { L.pe = pe; L.el.style.pointerEvents = pe ? '' : 'none'; }
  }
}

/* ---------------- hover readout ----------------
   Hovering a node shows a slim frosted readout docked to a screen corner away from the cursor,
   inside the free 3D area, with a faint leader line from the node. Nothing floats over the scene. */
const DWELL = 250, LINGER = 300;
let leader, roShown = false, roTimer = 0, roNext = null, roAnchor = null;
const roCam = [0, 0, 0, 0, 0, 0];

export function updateHover() {
  const m = state.mouse;
  if (!m || m.pointerType === 'touch' || m.buttons) { state.hoverEnt = null; stage.style.cursor = ''; hideReadout(); return; }
  const ent = entFromEvent(m);
  state.hoverEnt = ent;
  stage.style.cursor = ent ? 'pointer' : '';
  const html = ent ? hoverHtml(ent) : '';
  if (!html) {
    if (roShown) { if (!roTimer) roTimer = setTimeout(hideReadout, LINGER); }
    else hideReadout();
    return;
  }
  if (html === (roShown ? hoverEl._html : roNext?.html) && (roShown || roTimer)) { if (roShown) { clearTimeout(roTimer); roTimer = 0; } return; }
  clearTimeout(roTimer); roTimer = 0;
  roNext = { html, anchor: anchorOf(ent) };
  if (roShown) showReadout(); else roTimer = setTimeout(showReadout, DWELL);
}

function anchorOf(ent) {
  if (ent.node?.pos) return ent.node.pos;
  if (ent.type === 'cluster') return clusters.get(ent.id)?.pos;
  if (ent.type === 'dock') return docks.get(ent.id.slice(5))?.pos;
  return null;
}

function showReadout() {
  roTimer = 0;
  if (!roNext || !state.mouse || !state.hoverEnt) return hideReadout();
  const fresh = !roShown || hoverEl.style.display === 'none';
  hoverEl.innerHTML = hoverEl._html = roNext.html; roAnchor = roNext.anchor;
  if (!placeReadout()) return hideReadout();
  if (fresh) { hoverEl.classList.remove('in'); void hoverEl.offsetWidth; hoverEl.classList.add('in'); }
  roCam.splice(0, 6, camPos.x, camPos.y, camPos.z, controls.target.x, controls.target.y, controls.target.z);
  if (!roShown) { roShown = true; requestAnimationFrame(trackReadout); }
  drawLeader();
}

export function hideReadout() {
  clearTimeout(roTimer); roTimer = 0; roNext = null;
  if (!hoverEl) return;
  roShown = false; hoverEl._html = ''; hoverEl.style.display = 'none'; leader.style.display = 'none';
}

// The free 3D area: the screen minus the detail panel and the code drawer.
function freeArea() {
  let r = innerWidth;
  for (const el of [detail, drawer]) if (el.classList.contains('open')) r = Math.min(r, el.getBoundingClientRect().left);
  return { l: 0, r };
}

// Lowest y the readout may reach in the column [x0, x1]: above any bottom-docked HUD there.
function floorAt(x0, x1) {
  let b = innerHeight - 16;
  for (const el of [$('#left'), $('#chat'), $('#flowbar'), $('#boardLegend')]) {
    const r = el?.getBoundingClientRect();
    if (r && r.width && r.bottom > innerHeight - 48 && r.left < x1 && r.right > x0) b = Math.min(b, r.top - 10);
  }
  return b;
}

function placeReadout() {
  const f = freeArea(), room = f.r - f.l - 32;
  if (room < 220) return false;
  hoverEl.style.display = 'block';
  hoverEl.style.maxWidth = Math.min(340, room) + 'px';
  const w = hoverEl.offsetWidth, h = hoverEl.offsetHeight;
  const right = state.mouse.clientX < (f.l + f.r) / 2;
  const x = right ? f.r - 16 - w : f.l + 16;
  const y = Math.max(16, floorAt(x, x + w) - h);
  hoverEl.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
  hoverEl.dataset.side = right ? 'right' : 'left';
  hoverEl._box = [x, y, w, h];
  return true;
}

function drawLeader() {
  if (!roAnchor) { leader.style.display = 'none'; return; }
  tmpV.copy(roAnchor).project(camera);
  if (tmpV.z > 1 || tmpV.z < -1) { leader.style.display = 'none'; return; }
  const px = (tmpV.x * 0.5 + 0.5) * innerWidth, py = (-tmpV.y * 0.5 + 0.5) * innerHeight;
  const [x, y, w, h] = hoverEl._box;
  const qx = clamp(px, x + 12, x + w - 12), qy = clamp(py, y, y + h);
  leader.style.display = '';
  leader.firstChild.setAttribute('d', `M${px.toFixed(1)} ${py.toFixed(1)}L${qx.toFixed(1)} ${qy.toFixed(1)}`);
  leader.lastChild.setAttribute('cx', px.toFixed(1)); leader.lastChild.setAttribute('cy', py.toFixed(1));
}

// Runs only while the readout is up: hides it as soon as the camera moves (drag, zoom, pan, fly).
function trackReadout() {
  if (!roShown) return;
  const t = controls.target;
  const moved = Math.abs(camPos.x - roCam[0]) + Math.abs(camPos.y - roCam[1]) + Math.abs(camPos.z - roCam[2]) + Math.abs(t.x - roCam[3]) + Math.abs(t.y - roCam[4]) + Math.abs(t.z - roCam[5]) > 1e-3;
  if (moved || hoverEl.style.display === 'none') return hideReadout();
  drawLeader();
  requestAnimationFrame(trackReadout);
}

// Indexes of a type's methods on its board.
const methodsOf = (t) => t.node.owner.struct.items.filter((m) => m.kind === 'method' && m.parent === t.name && m.dir === t.dir).map((m) => m.i);

// Break long identifiers at '.', '_', '/' and camelCase humps.
const wrapName = (s) => esc(s).replace(/([._/])/g, '$1<wbr>').replace(/([a-z0-9])([A-Z])/g, '$1<wbr>$2');
const fileLine = (ref) => { const m = /^(.*?)(?::(\d+))?$/.exec(ref || ''); return m[1].split('/').slice(-2).join('/') + (m[2] ? ':' + m[2] : ''); };
const pill = (text, color, cls = '') => `<span class="pill ${cls}"${color ? ` style="--k:${color}"` : ''}>${esc(text)}</span>`;
const stat = (icon, n, label, cls = '') => `<span class="st ${cls}">${icon}<b>${n}</b>${esc(label)}</span>`;

function readout({ kind, color, name, sub, subColor, file, stats, summary, notes, code }) {
  return `<div class="ro-hd">${pill(kind, color)}${sub ? pill(sub, subColor, 'soft') : ''}</div>
    <div class="ro-nm${code ? ' mono' : ''}">${wrapName(name)}</div>${summary ? `<div class="ro-sum">${esc(summary)}</div>` : ''}${notes ? `<div class="ro-notes">${esc(notes)}</div>` : ''}
    ${file || stats?.length ? `<div class="ro-ft">${file ? `<span class="ro-ref">${I.file}${esc(fileLine(file))}</span>` : ''}${(stats || []).join('')}</div>` : ''}`;
}

export function hoverHtml(ent) {
  if (ent.type === 'part') {
    const p = parts.get(ent.id), ins = p.links.filter((L) => L.b === p).length;
    return readout({ kind: p.kind, color: KINDS[kindOf(p)].color, name: p.name, sub: p.clusterObj.name, subColor: p.clusterObj.color, file: p.path, summary: p.summary,
      stats: [stat(I.inArrow, ins, 'used by', 'amber'), stat(I.outArrow, (p.uses || []).length, 'uses', 'cyan'), stat(I.flow, (p.flows || []).length, 'flows')] });
  }
  if (ent.type === 'external') { const e = exts.get(ent.id); return readout({ kind: EXT[extOf(e)].label, color: EXT[extOf(e)].color, name: e.id, sub: 'external', stats: [stat(I.inArrow, e.users.size, e.users.size === 1 ? 'part uses it' : 'parts use it', 'amber')] }); }
  if (ent.type === 'dock') { const d = docks.get(ent.id.slice(5)); return readout({ kind: 'outside systems', color: EXT[d.kind].color, name: d.name, summary: d.members.map((e) => e.id).join(', '), stats: [stat(I.globe, d.members.length, 'systems')] }); }
  if (ent.type === 'cluster') { const c = clusters.get(ent.id); return readout({ kind: 'domain', color: c.color, name: c.name, summary: c.summary, stats: [stat(I.layers, c.parts.length, 'parts')] }); }
  if (ent.type === 'snode') {
    const it = ent.node.item, p = ent.node.owner;
    const types = (it.usesT || []).map((i) => p.struct.items[i].name);
    const notes = [types.length && `Uses types: ${types.slice(0, 6).join(', ')}${types.length > 6 ? ` +${types.length - 6}` : ''}`,
      it.effects?.length && `Touches: ${it.effects.map((e) => e.target).join(', ')}`, it.lines?.length && `On: ${it.lines.map((L) => L.label).join(' · ')}`].filter(Boolean).join('\n');
    return readout({ code: true, kind: it.kind, color: SNODE[it.kind]?.color, name: it.kind === 'method' && it.parent ? it.parent + '.' + it.name : it.name, notes,
      sub: it.kind === 'method' && it.parent ? it.parent : p.name, subColor: it.kind === 'method' ? SNODE.type.color : p.clusterObj.color, file: `${it.file}:${it.line}`,
      stats: it.kind === 'type'
        ? [stat(I.inArrow, it.users?.length || 0, 'used by', 'green'), stat(I.method, methodsOf(it).length, 'methods', 'violet')]
        : [stat(I.inArrow, it.callers.length, 'callers', 'amber'), stat(I.outArrow, it.callees.length, 'calls', 'cyan'), stat(I.tag, it.usesT?.length || 0, 'types', 'green')] });
  }
  if (!ent.node || ent.type === 'flow' || ent.type === 'code') return '';
  const n = ent.node, p = n.owner;
  if (n.type === 'port') { const t = PORTS[n.expose.type] || PORTS.function; return readout({ code: true, kind: t.label, color: t.color, name: n.expose.what, sub: p.name, subColor: p.clusterObj.color, file: n.ref, summary: `How work enters ${p.name}` }); }
  const f = p.flows[n.flow];
  return readout({ code: true, kind: n.type === 'proxy' ? 'calls out' : 'step', color: n.type === 'proxy' ? 'var(--blue)' : 'var(--cyan)', name: n.name, sub: p.name, subColor: p.clusterObj.color, file: n.ref,
    summary: f.steps[n.step].text, stats: [stat(I.flow, n.step + 1, `of ${f.steps.length} steps in “${f.title}”`)] });
}

export function openPanel() { detail.classList.add('open'); document.body.classList.add('detail-open'); }

export function closeDetail() { detail.classList.remove('open'); document.body.classList.remove('detail-open'); codeslot.innerHTML = ''; }

export function flowHtml(id, f) {
  return `<div class="flow" data-flow="${esc(id)}"><div class="fh"><button class="play" data-play="${esc(id)}" title="Play">${I.play}</button><div class="t"><b>${esc(f.title)}</b><small>${esc(f.trigger || '')}</small></div><button class="play fx" data-fflow="${esc(id)}" title="Focus: show only what this flow touches">${I.focus}</button></div>
    <ol>${(f.steps || []).map((s, i) => `<li data-step="${i}" data-sref="${esc(s.ref || '')}"><span class="tx">${esc(s.text)}${s.ref && state.M.code?.[s.ref]?.verified === false ? ' <span class="unv" title="code ref not verified">⚠</span>' : ''}</span><span class="who">${esc(s.from)} → ${esc(s.to)}</span></li>`).join('')}</ol></div>`;
}

// Collapsible section with a small-caps header and a disclosure chevron; closed state is remembered per title.
const closedSecs = new Set();
const sec = (title, body, n) => `<section class="sec${closedSecs.has(title) ? ' closed' : ''}" data-sec="${esc(title)}"><h3 class="sh">${I.chevD}<span>${esc(title)}</span>${n != null ? `<em>${n}</em>` : ''}</h3><div class="sbody">${body}</div></section>`;
const row = (icon, main, sub = '', color = '') => `<div class="item"${color ? ` style="--k:${color}"` : ''}><span class="ii">${icon}</span><div class="t">${main}${sub}</div></div>`;
const head = (pills, title, meta = '') => `<div class="dh"><div class="pills">${pills}</div><h2>${wrapName(title)}</h2>${meta ? `<div class="meta">${meta}</div>` : ''}</div>`;

export function showDetail(ent) {
  let h = '';
  if (ent.type === 'part') {
    const p = parts.get(ent.id), k = kindOf(p), ch = state.M.changes?.[p.id];
    h = head(pill(p.kind, KINDS[k].color) + pill(p.clusterObj.name, p.clusterObj.color, 'soft') + (ch ? pill(`Δ${ch} files`, 'var(--heat)') : ''), p.name, `${esc(p.path || '')}${p.size ? ` · ${p.size} lines` : ''}`) +
      `<p class="lead">${esc(p.summary)}</p>${p.details ? `<p class="dim">${esc(p.details)}</p>` : ''}` +
      `<div class="ctl"><button class="btn tinted" data-fpart="${esc(p.id)}" title="Show only what this part touches">${I.focus}Focus</button></div>`;
    if ((p.exposes || []).length) h += sec('Entry points', p.exposes.map((e) => { const t = PORTS[e.type] || PORTS.function; return `<div class="item"><span class="pt" style="--c:${t.color}">${t.label}</span><div class="t"><b>${esc(e.what)}</b>${rf(e.ref)}</div></div>`; }).join(''), p.exposes.length);
    if ((p.uses || []).length) h += sec('Uses', p.uses.map((u) => { const known = parts.has(u.target) || exts.has(u.target); return row(I.outArrow, `<b>${known ? goLink(u.target) : esc(u.target)}</b> <small>${esc(u.how)}</small>`, rf(u.ref), 'var(--cyan)'); }).join(''), p.uses.length);
    if ((p.publishes || []).length || (p.subscribes || []).length) h += sec('Events', `<div class="chips">${(p.publishes || []).map((t) => `<span class="chip">${I.radio}pub ${esc(t)}</span>`).join('')}${(p.subscribes || []).map((t) => `<span class="chip sub">${I.inArrow}sub ${esc(t)}</span>`).join('')}</div>`);
    const ins = p.links.filter((L) => L.b === p);
    if (ins.length) h += sec('Used by', ins.map((L) => row(I.inArrow, `<b>${goLink(L.a.id, L.a.name)}</b> <small>${esc(L.how)}</small>`, '', 'var(--amber)')).join(''), ins.length);
    if ((p.flows || []).length) h += sec('Flows', p.flows.map((f, i) => flowHtml(`${p.id}#${i}`, f)).join(''), p.flows.length);
    if (p.struct) {
      const S = p.struct, c = { type: 0, method: 0, function: 0 }; for (const it of S.items) if (!it.test || state.showTests) c[it.kind]++;
      h += sec('Code structure', `<div class="stats">${stat(I.type, c.type, 'types', 'green')}${stat(I.method, c.method, 'methods', 'violet')}${stat(I.fn, c.function, 'functions', 'cyan')}</div>
        <p class="meta" title="Explore in 3D draws the code as a metro map: each line follows an entry point through the functions it calls. The Lens shows a function's callers and callees.">Metro: ${S.lines.length} lines through ${S.placed.length} stations · click a station for the Lens</p>
        <div class="ctl"><button class="btn primary" data-struct="${esc(p.id)}">${I.cube}Explore in 3D</button>
        <label class="tog"><input type="checkbox" data-tests ${state.showTests ? 'checked' : ''}><i></i>Tests</label></div>`);
    } else if (state.codeApi && state.structStatus === 'building') h += sec('Code structure', `<div class="skel"><i></i><i></i><i></i></div><p class="meta">Indexing the repo…</p>`);
    h += '<div data-slot="gates"></div><div data-slot="states"></div>';
  } else if (ent.type === 'cluster') {
    const c = clusters.get(ent.id);
    h = head(pill('domain', c.color), c.name) + `<p class="lead">${esc(c.summary)}</p>` +
      sec('Parts', c.parts.map((p) => row(KINDS[kindOf(p)].icon, `<b>${goLink(p.id, p.name)}</b>`, `<small>${esc(p.summary)}</small>`, KINDS[kindOf(p)].color)).join(''), c.parts.length);
  } else if (ent.type === 'dock') {
    const d = docks.get(ent.id.slice(5));
    h = head(pill('outside systems', EXT[d.kind].color), d.name) + `<p class="lead">${d.members.length} outside systems of this kind.</p>` +
      sec('Systems', d.members.map((e) => row(EXT[d.kind].icon, `<b>${goLink(e.id)}</b>`, `<small>${[...e.users].map((id) => esc(parts.get(id)?.name || id)).join(', ') || 'no known users'}</small>`, EXT[d.kind].color)).join(''), d.members.length);
  } else if (ent.type === 'external') {
    const e = exts.get(ent.id);
    h = head(pill(EXT[extOf(e)].label, EXT[extOf(e)].color) + pill('external', '', 'soft'), e.id) + `<p class="lead">An outside system.</p>` +
      sec('Used by', e.links.map((L) => row(I.inArrow, `<b>${goLink(L.a.id, L.a.name)}</b> <small>${esc(L.how)}</small>`, '', 'var(--amber)')).join(''), e.links.length);
    const refs = [...parts.values()].flatMap((p) => (p.uses || []).filter((u) => u.target === e.id).map((u) => ({ p, u })));
    if (refs.length) h += sec('Where in code', refs.map(({ p, u }) => row(I.code, `<small>${esc(p.name)}: ${esc(u.how)}</small>`, rf(u.ref))).join(''), refs.length);
  } else if (ent.type === 'snode') {
    const it = ent.node.item, p = ent.node.owner, S = p.struct;
    const list = (ids) => ids.map((i) => S.items[i]).map((x) => row(SNODE[x.kind]?.icon || I.fn, `<b>${goLink(x.key, x.parent && x.kind === 'method' ? x.parent + '.' + x.name : x.name)}</b>`, rf(x.file + ':' + x.line), SNODE[x.kind]?.color)).join('');
    h = head(pill(it.kind, SNODE[it.kind]?.color) + pill(p.name, p.clusterObj.color, 'soft') + (it.test ? pill('test', '', 'soft') : ''), it.kind === 'method' && it.parent ? it.parent + '.' + it.name : it.name, `${rf(it.file + ':' + it.line)} · used ${it.fanin}×`);
    if (it.grp === 'dead') h += `<p class="note">Possibly unused: no calls in or out, no type uses, and no other part calls it.</p>`;
    if (it.grp === 'ext') h += `<p class="note">Called ${it.outside}× from other parts.</p>`;
    if (it.kind === 'type') {
      const methods = methodsOf(it);
      if (it.users?.length) h += sec('Used by', list(it.users.slice(0, 40)), it.users.length);
      if (methods.length) h += sec('Methods', list(methods), methods.length);
    }
    if (it.callers.length) h += sec('Called by', list(it.callers.slice(0, 40)), it.callers.length);
    if (it.callees.length) h += sec('Calls', list(it.callees.slice(0, 40)), it.callees.length);
    if (it.usesT?.length) h += sec('Uses types', list(it.usesT.slice(0, 40)), it.usesT.length);
  } else if (ent.node) {
    const n = ent.node, p = n.owner;
    if (n.type === 'port') { const t = PORTS[n.expose.type] || PORTS.function; h = head(pill(t.label, t.color) + pill(p.name, p.clusterObj.color, 'soft'), n.expose.what) + `<p class="lead">Entry point of ${goLink(p.id, p.name)}.</p>`; }
    else {
      const f = p.flows[n.flow];
      h = head(pill(n.type === 'proxy' ? 'calls out' : 'function', n.type === 'proxy' ? 'var(--blue)' : 'var(--cyan)') + pill(p.name, p.clusterObj.color, 'soft'), n.name) +
        `<p class="lead">Step in ${goLink(p.id, p.name)}${n.type === 'proxy' ? ` → ${goLink(n.name)}` : ''}</p>` + sec('Flow', flowHtml(`${p.id}#${n.flow}`, f));
    }
    if (n.ref) h += `<div class="code">${codeHtml(n.ref)}</div>`;
  }
  dbody.innerHTML = h; openPanel(); dbody.parentElement.scrollTop = 0;
  if (ent.type === 'part') { fillGates(ent.id); fillStates(ent.id); }
}

/* ---------------- gates and states (XRAY.md §2, §3) ----------------
   Gates: env vars, feature flags and config a part reads or checks. Hover lights the parts and metro lines involved;
   a click opens a small card with every read and check. States: inferred state machines, drawn as compact diagrams. */
const GATE = { env: [I.env, 'var(--amber)', 'Env var'], flag: [I.flag, 'var(--violet)', 'Feature flag'], config: [I.config, 'var(--sky)', 'Config'] };
const gateLook = (g) => GATE[g.kind] || GATE.config;
const gateParts = (g) => [...new Set([...g.reads, ...g.checks].map((r) => r.part).filter((id) => parts.has(id)))];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
let gatesP = null, gatePin = null, emphSaved = null;
const statesP = new Map();

// Every gate, most important first: checks decide behaviour, so they weigh most, then reach across parts.
function loadGates() {
  gatesP ||= !location.protocol.startsWith('http') ? Promise.resolve([])
    : getJSON('/api/gates').then((j) => (j.gates || []).map((g) => ({ ...g, reads: g.reads || [], checks: g.checks || [], lines: g.lines || [] }))
      .sort((a, b) => b.checks.length * 3 + gateParts(b).length * 2 + b.reads.length - (a.checks.length * 3 + gateParts(a).length * 2 + a.reads.length) || a.name.localeCompare(b.name)), () => []);
  return gatesP;
}

// Light (or with null, un-light) a gate's parts on the map and its metro lines; the emphasis it replaced comes back after.
function lightGate(g) {
  if (g) {
    emphSaved ||= { emph: state.emph, links: state.emphLinks };
    setEmphasis(gateParts(g)); emphSaved.mine = state.emph; setGateLines(g.lines);
  } else {
    if (emphSaved && state.emph === emphSaved.mine) { state.emph = emphSaved.emph; state.emphLinks = emphSaved.links; }
    emphSaved = null; setGateLines(null);
  }
  state.redraw = true;
}

async function fillGates(pid) {
  const all = await loadGates(), slot = dbody.querySelector('[data-slot="gates"]');
  if (!slot) return;
  const mine = all.filter((g) => gateParts(g).includes(pid));
  if (!mine.length) return slot.remove();
  slot.outerHTML = sec('Config switches', mine.map((g) => {
    const [icon, color] = gateLook(g), r = g.reads.filter((x) => x.part === pid).length, c = g.checks.filter((x) => x.part === pid).length, more = gateParts(g).length - 1;
    return `<div class="item gate" data-gate="${all.indexOf(g)}" tabindex="0" style="--k:${color}"><span class="ii">${icon}</span><div class="t"><b class="mono">${esc(g.name)}</b>${g.default != null ? `<span class="gdef" title="default">= ${esc(g.default)}</span>` : ''}
      <small>${plural(r, 'read')} · ${plural(c, 'check')}${more > 0 ? ` · also ${plural(more, 'other part')}` : ''}</small></div></div>`;
  }).join(''), mine.length);
}

// The card: every read and check of a gate, each opening the code.
async function openGateCard(g, anchor) {
  const all = await loadGates(), card = $('#gatecard'), [icon, color, kind] = gateLook(g), name = (id) => parts.get(id)?.name || id || '';
  const rows = (list, check) => list.map((r) => `<button class="gc-row" data-ref="${esc(r.ref)}" title="${esc(r.ref)}"><span class="gc-fn">${esc(r.fn || '')}</span><span class="gc-pt">${esc(name(r.part))}</span><span class="gc-rf">${esc(fileLine(r.ref))}</span>${check && r.text ? `<code>${esc(r.text)}</code>` : ''}</button>`).join('');
  card.dataset.gate = all.indexOf(g);
  card.style.setProperty('--k', color);
  card.innerHTML = `<div class="gc-hd"><span class="ii">${icon}</span><div class="gc-id"><b>${esc(g.name)}</b><small>${kind}${g.default != null ? ` · default <code>${esc(g.default)}</code>` : ''}</small></div><button class="gc-x" title="Close (Esc)">${I.x}</button></div>
    <div class="gc-body">${g.checks.length ? `<div class="gc-sh">Checked in <em>${g.checks.length}</em></div>${rows(g.checks, true)}` : ''}
    ${g.reads.length ? `<div class="gc-sh">Read in <em>${g.reads.length}</em></div>${rows(g.reads, false)}` : ''}
    ${!g.checks.length && !g.reads.length ? '<p class="gc-ft">No reads or checks found.</p>' : ''}</div>
    <p class="gc-ft">Lit on the map: ${plural(gateParts(g).length, 'part')}${g.lines.length ? ` · ${plural(g.lines.length, 'metro line')}` : ''}</p>`;
  card.hidden = false;
  // beside its anchor: left of the detail panel, else right of the top-left panel
  const a = anchor.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight;
  const left = a.left - w - 12 >= 8 ? a.left - w - 12 : Math.min(a.right + 12, innerWidth - w - 8);
  card.style.left = Math.round(left) + 'px'; card.style.top = Math.round(clamp(a.top - 8, 8, innerHeight - h - 8)) + 'px';
  card.querySelector('.gc-x').focus({ preventScroll: true });
}

function closeGateCard() {
  if ($('#gatecard').hidden) return false;
  $('#gatecard').hidden = true; gatePin = null; lightGate(null);
  document.querySelectorAll('[data-gate].on').forEach((el) => el.classList.remove('on'));
  return true;
}

async function pinGate(i, anchor) {
  const g = (await loadGates())[+i]; if (!g) return;
  if (gatePin === g) return closeGateCard();
  document.querySelectorAll('[data-gate].on').forEach((el) => el.classList.remove('on'));
  anchor.classList.add('on');
  gatePin = g; lightGate(g); openGateCard(g, anchor);
}

// The system-wide list in the top-left panel, and gates in search.
async function initGateList() {
  const all = await loadGates();
  if (!all.length) return;
  $('#crumbs').insertAdjacentHTML('beforebegin', '<button id="gatesbtn" class="tag" aria-expanded="false" title="Env vars and feature flags that switch how the code behaves"></button>');
  $('#crumbs').insertAdjacentHTML('beforebegin', `<div id="gatelist" hidden>${all.map((g, i) => {
    const [icon, color] = gateLook(g);
    return `<button class="gl-row" data-gate="${i}" style="--k:${color}"><span class="gi">${icon}</span><span class="nm">${esc(g.name)}</span><em>${g.checks.length ? plural(g.checks.length, 'check') : plural(g.reads.length, 'read')} · ${plural(gateParts(g).length, 'part')}</em></button>`;
  }).join('')}</div>`);
  const btn = $('#gatesbtn'), list = $('#gatelist');
  const label = () => { btn.innerHTML = `Config switches (${all.length}) ${list.hidden ? '▸' : '▾'}`; btn.setAttribute('aria-expanded', !list.hidden); };
  label();
  btn.onclick = () => { list.hidden = !list.hidden; label(); if (list.hidden) closeGateCard(); };
  list.onclick = (e) => { const r = e.target.closest('[data-gate]'); if (r) pinGate(r.dataset.gate, r); };
  hoverGates(list);
  all.forEach((g, i) => state.searchItems.push({ ty: 'gate', name: g.name, sub: `${gateLook(g)[2]} · ${plural(g.checks.length, 'check')}, ${plural(g.reads.length, 'read')}`, go: () => {
    list.hidden = false; label(); const r = list.querySelector(`[data-gate="${i}"]`); r.scrollIntoView({ block: 'nearest' }); if (gatePin !== g) pinGate(i, r);
  } }));
}

// Hovering a gate row lights it; leaving goes back to the pinned gate (if any).
function hoverGates(el) {
  let cur = null;
  el.addEventListener('mouseover', async (e) => {
    const r = e.target.closest('[data-gate]'); if (!r || r === cur) return;
    cur = r; const g = (await loadGates())[+r.dataset.gate];
    if (cur === r) lightGate(g);
  });
  el.addEventListener('mouseout', (e) => {
    if (!cur || cur.contains(e.relatedTarget)) return;
    cur = null; lightGate(gatePin);
  });
}

async function fillStates(pid) {
  if (!statesP.has(pid)) statesP.set(pid, getJSON('/api/states?part=' + encodeURIComponent(pid)).then((j) => j.machines || [], () => []));
  const machines = (await statesP.get(pid)).filter((m) => m.states?.length && m.transitions?.length >= 2), slot = dbody.querySelector('[data-slot="states"]');
  if (!slot) return;
  if (!machines.length) return slot.remove();
  slot.outerHTML = sec('States', machines.map(machineHtml).join(''), machines.length);
}

const INFERRED = 'Inferred from the code, not declared: a field named like state, status, phase or stage that is set to constant values in several places. '
  + 'Each arrow is one of those assignments; its “from” state is guessed from an enclosing if or switch. It can miss or misread transitions.';
let svgCtx = null;

// One machine as a compact diagram: states as rounded nodes in a row (≤ 3) or around an ellipse, transitions as labelled arrows.
function machineHtml(m) {
  svgCtx ||= document.createElement('canvas').getContext('2d');
  svgCtx.font = '500 11px Inter, sans-serif';
  const pre = commonPrefix(m.states), short = (s) => s.slice(pre.length) || s, W = 352, NH = 24;
  const n = m.states.length, room = n <= 3 ? W / n - 10 : 140;   // a node's widest, so neighbours never touch
  const nodes = m.states.map((s) => { const t = fit(short(s), room - 18); return { s, t, w: Math.ceil(svgCtx.measureText(t).width) + 18 }; });
  const maxW = Math.max(...nodes.map((x) => x.w));
  let H;
  if (n <= 3) { H = 80; nodes.forEach((x, i) => { x.x = (W * (i + 0.5)) / n; x.y = 44; }); }
  else {
    const rx = W / 2 - maxW / 2 - 6, ry = clamp(n * 22, 72, 132); H = 2 * ry + NH + 34;
    nodes.forEach((x, i) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / n; x.x = W / 2 + rx * Math.cos(a); x.y = H / 2 + 4 + ry * Math.sin(a); });
  }
  const at = Object.fromEntries(nodes.map((x) => [x.s, x]));
  // where the segment from a node's centre towards (tx, ty) leaves its box
  const rim = (x, tx, ty, pad = 3) => { const dx = tx - x.x, dy = ty - x.y, k = 1 / Math.max(Math.abs(dx) / (x.w / 2 + pad), Math.abs(dy) / (NH / 2 + pad), 1e-6); return [x.x + dx * k, x.y + dy * k]; };
  const groups = new Map();
  for (const t of m.transitions) { if (!at[t.to] || (t.from != null && !at[t.from])) continue; const k = `${t.from}\u0000${t.to}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  const f = (v) => v.toFixed(1), edges = [];
  for (const list of groups.values()) {
    const { from, to } = list[0], b = at[to];
    if (from == null) {   // set from no known state: a short arrow from a dot just above the node
      const sy = b.y - NH / 2 - 22;
      edges.push({ list, d: `M${f(b.x)} ${f(sy)}L${f(b.x)} ${f(b.y - NH / 2 - 4)}`, lx: b.x, ly: sy - 6, start: [b.x, sy] });
      continue;
    }
    const a = at[from];
    let d, lx, ly;
    if (a === b) {   // self loop above the node
      const x0 = a.x - 8, x1 = a.x + 8, y0 = a.y - NH / 2;
      d = `M${f(x0)} ${f(y0)}C${f(x0 - 10)} ${f(y0 - 26)},${f(x1 + 10)} ${f(y0 - 26)},${f(x1)} ${f(y0 - 2)}`; lx = a.x; ly = y0 - 24;
    } else {
      // curve to the right of the travel direction, so A→B and B→A never overlap
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, bend = n <= 3 ? 16 : 18;
      const qx = mx - (dy / len) * bend, qy = my + (dx / len) * bend;
      const [sx, sy] = rim(a, qx, qy), [ex, ey] = rim(b, qx, qy, 4);
      // the label sits just outside the curve, anchored away from it
      const nx = -dy / len, ny = dx / len;
      d = `M${f(sx)} ${f(sy)}Q${f(qx)} ${f(qy)} ${f(ex)} ${f(ey)}`; lx = (sx + 2 * qx + ex) / 4 + nx * 6; ly = (sy + 2 * qy + ey) / 4 + ny * 9 + 3;
      edges.push({ list, d, lx, ly, anchor: nx > 0.45 ? 'start' : nx < -0.45 ? 'end' : 'middle' });
      continue;
    }
    edges.push({ list, d, lx, ly });
  }
  // labels: one or two function names (the rest as +n); the view box grows to fit them
  svgCtx.font = '10px "JetBrains Mono", monospace';
  for (const e of edges) {
    const uniq = e.list.filter((t, i) => e.list.findIndex((u) => (u.fn || '?') === (t.fn || '?')) === i), budget = n <= 3 ? W / n - 8 : 170;
    e.shown = uniq.slice(0, 2);
    if (svgCtx.measureText(e.shown.map((t) => t.fn || '?').join(', ') + (uniq.length > 2 ? ` +${uniq.length - 2}` : '')).width > budget) e.shown = uniq.slice(0, 1);
    e.more = uniq.length - e.shown.length;
    e.names = e.shown.map((t) => fit(t.fn || '?', budget - (e.more ? 26 : 0)));
    const w = svgCtx.measureText(e.names.join(', ') + (e.more ? ` +${e.more}` : '')).width;
    e.x0 = e.anchor === 'start' ? e.lx : e.anchor === 'end' ? e.lx - w : e.lx - w / 2; e.x1 = e.x0 + w;
  }
  const top = Math.min(0, ...edges.map((e) => e.ly - 12)), x0 = Math.min(0, ...edges.map((e) => e.x0 - 4)), x1 = Math.max(W, ...edges.map((e) => e.x1 + 4));
  const label = (e) => e.shown.map((t, i) => `${i ? '<tspan>, </tspan>' : ''}<tspan data-ref="${esc(t.ref)}">${esc(e.names[i])}</tspan>`).join('') + (e.more ? `<tspan> +${e.more}</tspan>` : '');
  const tip = (e) => e.list.map((t) => `${t.from == null ? 'start' : short(t.from)} → ${short(t.to)}: ${t.fn || '?'} (${t.ref})`).join('\n');
  return `<div class="sm"><div class="sm-hd"><span class="ii" style="--k:var(--lavender)">${I.states}</span><b class="mono">${esc(m.subject ? `${m.subject}.${m.field}` : m.field || m.id)}</b>
      ${m.heuristic ? `<span class="sm-inf" tabindex="0" title="${esc(INFERRED)}">inferred</span>` : ''}${pre ? `<small class="mono" title="common prefix of the states">${esc(pre)}…</small>` : ''}</div>
    <svg class="sm-g" viewBox="${f(x0)} ${f(top)} ${f(x1 - x0)} ${f(H - top)}" width="100%" role="img" aria-label="${esc(`${m.field} states: ${m.states.join(', ')}`)}">
      <defs><marker id="smA" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 .8 7.2 4 0 7.2z"/></marker></defs>
      ${edges.map((e) => `<g class="sm-e" data-ref="${esc(e.list[0].ref)}"><title>${esc(tip(e))}</title><path class="hit" d="${e.d}"/><path d="${e.d}" marker-end="url(#smA)"/>${e.start ? `<circle cx="${f(e.start[0])}" cy="${f(e.start[1])}" r="3.5"/>` : ''}<text x="${f(e.lx)}" y="${f(e.ly)}"${e.anchor ? ` text-anchor="${e.anchor}"` : ''}>${label(e)}</text></g>`).join('')}
      ${nodes.map((x) => `<g class="sm-n"><title>${esc(x.s)}</title><rect x="${f(x.x - x.w / 2)}" y="${f(x.y - NH / 2)}" width="${x.w}" height="${NH}" rx="12"/><text x="${f(x.x)}" y="${f(x.y + 4)}">${esc(x.t)}</text></g>`).join('')}
    </svg></div>`;
}

// Text cut with an ellipsis to fit w px in svgCtx's current font.
function fit(t, w) {
  if (svgCtx.measureText(t).width <= w) return t;
  while (t.length > 1 && svgCtx.measureText(t + '…').width > w) t = t.slice(0, -1);
  return t + '…';
}

// Shared leading words of the state names (to "_" or "."), shown once instead of on every node.
function commonPrefix(list) {
  let p = list[0] || '';
  for (const s of list) while (!s.startsWith(p)) p = p.slice(0, -1);
  let cut = Math.max(p.lastIndexOf('_'), p.lastIndexOf('.')) + 1;
  if (!cut) for (let i = p.length; i > 0; i--) if (list.every((s) => /[A-Z]/.test(s[i] || ''))) { cut = i; break; }   // camelCase: JobState|Running
  return cut > 1 && list.every((s) => s.length > cut) ? p.slice(0, cut) : '';
}

export function openCode(ref) {
  if (!ref) return;
  if (state.codeApi) { const m = /^(.*):(\d+)$/.exec(ref); return m ? openFile(m[1], +m[2]) : openFile(ref, 0); }
  openExcerpt(ref);
}

export function openExcerpt(ref) {
  codeslot.innerHTML = `<div class="code">${codeHtml(ref).replace('</span>', '</span><button class="x" data-closecode title="Close code">×</button>')}</div>`;
  openPanel(); dbody.parentElement.scrollTop = 0;
  codeslot.querySelector('.cl.on')?.scrollIntoView({ block: 'center' });
}

/* ---------------- breadcrumb / levels ---------------- */
export function level() {
  const t = controls.target, d = camPos.distanceTo(t);
  // A part names the place only once the camera is nearer its own framing distance than its domain's,
  // else a part that happens to be mid-view while a domain is framed would claim the breadcrumb.
  const fp = state.focusPart, near = fp && Math.max(fp.focusDist * 1.2, (fp.focusDist + fp.clusterObj.r * 2.5) / 2);
  let part = fp && fp.unfold > 0.35 && camPos.distanceTo(fp.pos) < near ? fp : null;
  let cluster = null, cbest = 1e9;
  for (const c of clusters.values()) { if (!c.shell) continue; const dd = c.pos.distanceTo(t); if (c.open > 0.5 && dd < c.r * 1.3 && dd < cbest) { cbest = dd; cluster = c; } }
  if (part) cluster = part.clusterObj;
  let ext = null;
  for (const dk of docks.values()) if (dk.pos.distanceTo(t) < dk.r + 6 && d < dk.r * 5 + 80) ext = dk;
  return { part, cluster, ext };
}

export function updateCrumbs() {
  const { part, cluster, ext } = level();
  const key = [part?.id, cluster?.id, ext?.id, player.on && player.id].join('|');
  if (key === state.crumbKey) return; state.crumbKey = key;
  const items = [['overview', 'System']];
  if (ext && !cluster) items.push([`external:${ext.id}`, ext.name]);
  if (cluster) items.push([`cluster:${cluster.id}`, cluster.name]);
  if (part) items.push([`part:${part.id}`, part.name]);
  if (player.on) items.push(['', player.title]);
  $('#crumbs').innerHTML = items.map(([k, n], i) => i === items.length - 1 ? `<span class="cur">${esc(n)}</span>` : `<button data-crumb="${esc(k)}">${esc(n)}</button><span class="sep">${I.chevR}</span>`).join('');
}

export function stepOut() {
  const { part, cluster, ext } = level();
  if (state.selected && state.selected.node && state.selected.owner && camPos.distanceTo(state.selected.node.pos) < 16) { const p = state.selected.owner; select({ type: 'part', id: p.id, node: p.node }); flyToEnt({ type: 'part', id: p.id }); }
  else if (part) { select(null); flyToEnt({ type: 'cluster', id: part.clusterObj.id }); }
  else if (cluster || ext) { select(null); flyOverview(); }
  else select(null);
}

export function drawMini() {
  const W = mini.width, s = (W / 2 - 14) / (state.Rext * 1.08), cx = W / 2;
  const X = (x) => cx + x * s, Z = (z) => cx + z * s;
  mg.clearRect(0, 0, W, W);
  mg.strokeStyle = 'rgba(255,255,255,.08)'; mg.lineWidth = 2; mg.beginPath(); mg.arc(cx, cx, state.Rext * s, 0, Math.PI * 2); mg.stroke();
  for (const c of clusters.values()) {
    if (!c.shell) continue;
    mg.fillStyle = c.color + '1c'; mg.strokeStyle = c.color + '80'; mg.lineWidth = 2;
    mg.beginPath(); mg.arc(X(c.pos.x), Z(c.pos.z), c.r * s, 0, Math.PI * 2); mg.fill(); mg.stroke();
  }
  for (const p of parts.values()) { if (!kindOn[kindOf(p)]) continue; mg.fillStyle = KINDS[kindOf(p)].color; mg.beginPath(); mg.arc(X(p.pos.x), Z(p.pos.z), 3, 0, Math.PI * 2); mg.fill(); }
  for (const d of docks.values()) { mg.strokeStyle = EXT[d.kind].color + 'aa'; mg.lineWidth = 2.5; mg.beginPath(); mg.arc(X(d.pos.x), Z(d.pos.z), Math.max(5, d.r * s), 0, Math.PI * 2); mg.stroke(); }
  const t = controls.target, az = Math.atan2(t.x - camPos.x, t.z - camPos.z), d = camPos.distanceTo(t);
  const vw = clamp(d * Math.tan(25 * Math.PI / 180) * camera.aspect * s, 10, W);
  mg.save(); mg.translate(X(t.x), Z(t.z)); mg.rotate(-az + Math.PI);
  const g = mg.createLinearGradient(0, 0, 0, -Math.min(W, d * s));
  g.addColorStop(0, accent + '55'); g.addColorStop(1, accent + '00');
  mg.fillStyle = g;
  mg.beginPath(); mg.moveTo(0, 0); mg.lineTo(-vw / 2, -Math.min(W, d * s)); mg.lineTo(vw / 2, -Math.min(W, d * s)); mg.closePath(); mg.fill();
  mg.restore();
  mg.fillStyle = '#fff'; mg.strokeStyle = accent; mg.lineWidth = 3; mg.beginPath(); mg.arc(X(t.x), Z(t.z), 6, 0, Math.PI * 2); mg.fill(); mg.stroke();
}

export function buildSearch() {
  state.searchItems = [];
  for (const p of parts.values()) state.searchItems.push({ ty: p.kind, name: p.name, sub: `${p.id} · ${p.clusterObj.name} — ${p.summary || ''}`, go: () => dive({ type: 'part', id: p.id }), feature: { part: p.id } });
  for (const c of clusters.values()) if (c.shell) state.searchItems.push({ ty: 'domain', name: c.name, sub: c.summary, go: () => dive({ type: 'cluster', id: c.id }) });
  for (const d of docks.values()) state.searchItems.push({ ty: 'systems', name: d.name, sub: `${d.members.length} outside systems`, go: () => dive({ type: 'dock', id: d.id }) });
  for (const e of exts.values()) state.searchItems.push({ ty: e.kind || 'ext', name: e.id, sub: `external · used by ${e.users.size}`, go: () => dive({ type: 'external', id: e.id }) });
  (state.M.systemFlows || []).forEach((f, i) => state.searchItems.push({ ty: 'flow', name: f.title, sub: 'system flow', go: () => playFlow(`system#${i}`), feature: { flow: `system#${i}` } }));
  for (const p of parts.values()) (p.flows || []).forEach((f, i) => state.searchItems.push({ ty: 'flow', name: f.title, sub: `${p.name} · ${f.trigger || ''}`, go: () => playFlow(`${p.id}#${i}`), feature: { flow: `${p.id}#${i}` } }));
  for (const n of nodes) if (n.type === 'fn') state.searchItems.push({ ty: 'func', name: n.name, sub: `${n.owner.name} · ${n.owner.flows[n.flow].title}`, go: () => dive(entFromNode(n)) });
  initGateList();
}

export function fuzzy(q, s) {
  s = s.toLowerCase(); let i = 0, score = 0, last = -2;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) { score += (last === j - 1 ? 3 : 1) + (j === 0 || /[\s._\-/·:]/.test(s[j - 1]) ? 2 : 0); last = j; i++; }
  }
  return i === q.length ? score + (s.startsWith(q) ? 6 : 0) - s.length * 0.01 : -1;
}

export function runSearch() {
  const q = $('#q').value.trim().toLowerCase();
  state.results = !q ? [] : state.searchItems.map((it) => ({ it, s: Math.max(fuzzy(q, it.name), fuzzy(q, it.sub) * 0.4) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s).slice(0, 9).map((r) => r.it);
  state.rIdx = 0; renderResults();
}

// Icon, colour and label for a search result type.
function resultLook(ty) {
  if (KINDS[ty]) return [KINDS[ty].icon, KINDS[ty].color, KINDS[ty].label];
  if (EXT[ty]) return [EXT[ty].icon, EXT[ty].color, EXT[ty].label];
  return {
    domain: [I.layers, 'var(--lavender)', 'Domain'], systems: [I.globe, 'var(--blue)', 'Systems'], ext: [I.globe, 'var(--blue)', 'External'],
    flow: [I.flow, 'var(--cyan)', 'Flow'], func: [I.fn, 'var(--cyan)', 'Function'], gate: [I.flag, 'var(--violet)', 'Config switch'], method: [I.method, 'var(--violet)', 'Method'], type: [I.type, 'var(--green)', 'Type'],
  }[ty] || [I.code, 'var(--dim)', ty];
}

export function renderResults() {
  const q = $('#q').value.trim();
  $('#results').innerHTML = !q ? '' : !state.results.length ? `<div class="empty">No results for “${esc(q)}”</div>` : state.results.map((r, i) => {
    const [icon, color, label] = resultLook(r.ty);
    return `<div data-i="${i}" class="res${i === state.rIdx ? ' on' : ''}"><span class="ri" style="--k:${color}">${icon}</span><span class="rt"><span class="nm">${esc(r.name)}</span><span class="sb">${esc(r.sub)}</span></span><span class="ty">${esc(label)}</span>${i === state.rIdx && r.feature ? `<button class="rfx" data-feat title="Focus (⇧↵)">${I.focus}Focus</button>` : ''}${i === state.rIdx ? '<kbd>↵</kbd>' : ''}</div>`;
  }).join('');
  $('#results').querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  $('#search').classList.toggle('has', !!q);
}

export function openSearch() { $('#search').classList.add('open'); $('#searchbtn').style.display = 'none'; $('#q').value = ''; state.results = []; renderResults(); $('#q').focus(); }

export function closeSearch() { $('#search').classList.remove('open'); $('#searchbtn').style.display = ''; $('#q').blur(); }

/* ---------------- legend & filters ---------------- */
// Render the real 3D shapes once into small images for the legend.
export function shapeIcons() {
  const out = {}, r2 = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r2.setPixelRatio(1); r2.setSize(64, 64);
  const sc = new THREE.Scene(), dl = new THREE.DirectionalLight(0xffffff, 2.2);
  dl.position.set(2, 4, 3); sc.add(new THREE.AmbientLight(0xffffff, 0.8), dl);
  const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 50); cam.position.set(3.4, 2.8, 4.4); cam.lookAt(0, 0, 0);
  const tint = (k) => new THREE.MeshStandardMaterial({ color: k, roughness: 0.55, emissive: k, emissiveIntensity: 0.15 });
  const shots = { service: 'service', job: 'jobCron', library: 'library', tool: 'tool', ...Object.fromEntries(Object.keys(EXT).map((k) => ['ext_' + k, 'ext_' + k])) };
  for (const [name, shape] of Object.entries(shots)) {
    const color = name.startsWith('ext_') ? EXT[name.slice(4)].color : '#9be7f5';
    let g, mat;
    if (VOXEL) { g = voxPreview(name.startsWith('ext_') ? externalModel(name.slice(4), 1, color) : partModel(name, 1, color)); mat = g.material; }
    else { mat = tint(color); g = new THREE.Group(); for (const [geo] of SHAPES[shape]) g.add(new THREE.Mesh(G[geo], mat)); }
    sc.add(g); r2.render(sc, cam); out[name] = r2.domElement.toDataURL(); sc.remove(g); mat.dispose();
  }
  r2.dispose(); r2.forceContextLoss();
  return out;
}

export function buildLegend() {
  const ic = shapeIcons();
  $('#legkinds').innerHTML = Object.entries(KINDS).map(([k, v]) => `<button class="row" data-kind="${k}" title="Show/hide ${v.label.toLowerCase()}s" style="--k:${v.color}"><img class="shp" src="${ic[k]}" alt="">${v.label}<span class="n">${[...parts.values()].filter((p) => kindOf(p) === k).length}</span></button>`).join('');
  const used = new Set([...exts.values()].map(extOf));
  $('#legext').innerHTML = Object.entries(EXT).filter(([k]) => used.has(k)).map(([k, v]) => `<div class="row" style="--k:${v.color}"><img class="shp" src="${ic['ext_' + k]}" alt="">${v.label}</div>`).join('');
  if (!state.M.changes || !Object.keys(state.M.changes).length) $('#chgbtn').style.display = 'none';
  // link kinds: the same solid / dashed / dotted as the 3D lines and streams (links.js STYLE); the arrowhead marks the callee
  const sw = (dash, cls = '') => `<svg class="lk ${cls}" viewBox="0 0 24 8"><path d="M1 4h17" stroke-dasharray="${dash}"/><path d="m17 1 4 3-4 3z" class="hd"/></svg>`;
  $('#leglinks').innerHTML = [[sw(''), 'call'], [sw('3.5 2.5'), 'event / queue'], [sw('0.1 3'), 'reads / writes data'],
    ['<span class="beam"></span>', 'traffic between domains'], [sw('', 'ent'), 'where traffic enters']]
    .map(([s, t]) => `<div class="row">${s}${t}</div>`).join('') + '<div class="note">arrow points at who is called · thicker = more · hover a group to name its links</div>';
}

export function setKinds(kinds) {
  for (const k of Object.keys(kindOn)) kindOn[k] = kinds.includes(k);
  document.querySelectorAll('[data-kind]').forEach((b) => b.classList.toggle('off', !kindOn[b.dataset.kind]));
}

/* ---------------- resizable panels ----------------
   Sizes live in CSS variables (--w/--h/--tw) so phone media queries can still force full-screen. */
export function resizable(handle, target, { key, cssVar, axis, min, max, sign = -1, onChange }) {
  const load = () => { try { return +localStorage.getItem('ariadne.size.' + key) || 0; } catch { return 0; } };
  const save = (v) => { try { v ? localStorage.setItem('ariadne.size.' + key, String(Math.round(v))) : localStorage.removeItem('ariadne.size.' + key); } catch { /* storage blocked */ } };
  const set = (v) => { if (v) target.style.setProperty(cssVar, v + 'px'); else target.style.removeProperty(cssVar); onChange?.(); };
  const size = () => (axis === 'x' ? (cssVar === '--tw' ? dtree.offsetWidth : target.offsetWidth) : target.offsetHeight);
  set(load() && clamp(load(), min(), max()));
  let start = null;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    start = { p: axis === 'x' ? e.clientX : e.clientY, s: size() };
    handle.classList.add('drag'); document.body.classList.add('resizing');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    const d = (axis === 'x' ? e.clientX : e.clientY) - start.p;
    set(clamp(start.s + sign * d, min(), max()));
  });
  const end = () => { if (!start) return; start = null; handle.classList.remove('drag'); document.body.classList.remove('resizing'); save(size()); };
  handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', (e) => { e.stopPropagation(); set(0); save(0); });
}

export function addHandle(panel, axis) { const h = document.createElement('div'); h.className = 'rz ' + axis; h.title = 'Drag to resize · double-click to reset'; panel.appendChild(h); return h; }

export function initLabels() {
  /* ---------------- labels ---------------- */
  labelLayer = $('#labels');
  labels = [];
  cand = [];
  acc = [];
  tmpV = new V3();
}

export function initHoverCard() {
  hoverEl = $('#hover');
  state.hoverEnt = null;
  document.body.insertAdjacentHTML('beforeend', '<svg id="leader" aria-hidden="true" style="display:none"><path/><circle r="3"/></svg>');
  leader = $('#leader');
  // Any press, wheel zoom or trackpad pan hides the readout at once.
  stage.addEventListener('pointerdown', hideReadout);
  stage.addEventListener('wheel', hideReadout, { passive: true });
}

export function initDetailPanel() {
  /* ---------------- detail panel ---------------- */
  detail = $('#detail');
  dbody = $('#dbody');
  codeslot = $('#codeslot');
  $('#dclose').onclick = () => select(null);
  $('#dclose').innerHTML = I.x;
  initFlowBar();
  rf = (ref) => ref ? `<span class="rf" data-ref="${esc(ref)}">${esc(ref)}${state.M.code?.[ref]?.verified === false ? ' <span class="unv">⚠</span>' : ''}</span>` : '';
  goLink = (id, text) => `<span class="go" data-go="${esc(id)}">${esc(text ?? id)}</span>`;
  document.body.insertAdjacentHTML('beforeend', '<div id="gatecard" class="hud glass" role="dialog" aria-label="Gate" hidden></div>');
  hoverGates(detail);
  $('#gatecard').addEventListener('click', (e) => {
    if (e.target.closest('.gc-x')) return closeGateCard();
    const r = e.target.closest('[data-ref]'); if (r) openCode(r.dataset.ref);
  });
  addEventListener('pointerdown', (e) => { if (!e.target.closest('#gatecard,[data-gate],#drawer,#gpop')) closeGateCard(); });
  // Esc closes the gate card first (before the drawer, the Lens or stepping out)
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && closeGateCard()) e.stopImmediatePropagation(); }, true);
  detail.addEventListener('keydown', (e) => { const g = e.target.closest?.('[data-gate]'); if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pinGate(g.dataset.gate, g); } });
  detail.addEventListener('click', (e) => {
    const t = e.target;
    const gt = t.closest('[data-gate]'); if (gt) return pinGate(gt.dataset.gate, gt);
    const sh = t.closest('.sh');
    if (sh) { const s = sh.parentElement, c = s.classList.toggle('closed'); closedSecs[c ? 'add' : 'delete'](s.dataset.sec); return; }
    if (t.closest('[data-closecode]')) { codeslot.innerHTML = ''; if (!state.selected) closeDetail(); return; }
    const r = t.closest('[data-ref]'); if (r) return openCode(r.dataset.ref);
    const g = t.closest('[data-go]'); if (g) return act({ type: 'focus', id: g.dataset.go });
    const pl = t.closest('[data-play]'); if (pl) return playFlow(pl.dataset.play);
    const fx = t.closest('[data-fflow],[data-fpart]'); if (fx) return act({ type: 'feature', flow: fx.dataset.fflow, part: fx.dataset.fpart });
    const sb = t.closest('[data-struct]');
    if (sb) { const S = parts.get(sb.dataset.struct).struct; const d = new V3().subVectors(camPos, S.group.position); if (S.depth < 0.05) setFacing(S, Math.atan2(d.x, d.z)); return flyToBoard(S); }
    if (t.closest('[data-tests]')) { state.showTests = t.checked; for (const S of [...structs.values()]) { const p = S.part; disposeStruct(S); buildStruct(p); } return; }
    const li = t.closest('li[data-step]');
    if (li) {
      const fid = li.closest('[data-flow]').dataset.flow;
      if (player.on && player.id === fid) gotoStep(+li.dataset.step);
      if (li.dataset.sref) openCode(li.dataset.sref);
    }
  });
}

export function initBreadcrumb() {
  state.crumbKey = '';
  $('#crumbs').onclick = (e) => {
    const b = e.target.closest('[data-crumb]'); if (!b) return;
    const [t, id] = b.dataset.crumb.split(/:(.*)/);
    if (t === 'overview') act({ type: 'overview' }); else act({ type: 'focus', id });
  };
}

export function initMinimap() {
  /* ---------------- minimap ---------------- */
  mini = $('#minicv');
  mg = mini.getContext('2d');
  const c = getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) accent = c;
  mini.addEventListener('click', (e) => {
    const r = mini.getBoundingClientRect(), W = mini.width, s = (W / 2 - 14) / (state.Rext * 1.08);
    const x = ((e.clientX - r.left) / r.width * W - W / 2) / s, z = ((e.clientY - r.top) / r.height * W - W / 2) / s;
    let best = null, bd = 1e9;
    for (const c of clusters.values()) { if (!c.shell) continue; const d = Math.hypot(c.pos.x - x, c.pos.z - z); if (d < c.r * 1.2 && d < bd) { bd = d; best = c; } }
    if (best) dive({ type: 'cluster', id: best.id }); else act({ type: 'overview' });
  });
}

export function initSearch() {
  /* ---------------- search ---------------- */
  state.searchItems = [];
  state.results = [];
  state.rIdx = 0;
  $('#searchbtn').onclick = openSearch;
  $('#searchbtn').insertAdjacentHTML('afterbegin', I.search);
  // Spotlight layout: icon + field + esc keycap, live results, then a footer of keyboard hints.
  const q = $('#q'), bar = document.createElement('div'); bar.className = 'sbar';
  q.replaceWith(bar);
  bar.innerHTML = I.search; bar.append(q);
  bar.insertAdjacentHTML('beforeend', '<kbd>esc</kbd>');
  $('#search').insertAdjacentHTML('beforeend', '<div class="sfoot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>⇧↵</kbd> focus</span><span><kbd>esc</kbd> close</span></div>');
  $('#results').addEventListener('mousemove', (e) => { const d = e.target.closest('[data-i]'); if (d && +d.dataset.i !== state.rIdx) { state.rIdx = +d.dataset.i; renderResults(); } });
  $('#q').addEventListener('input', runSearch);
  $('#q').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { state.rIdx = Math.min(state.results.length - 1, state.rIdx + 1); renderResults(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { state.rIdx = Math.max(0, state.rIdx - 1); renderResults(); e.preventDefault(); }
    else if (e.key === 'Enter' && state.results[state.rIdx]) { const r = state.results[state.rIdx]; closeSearch(); if (e.shiftKey && r.feature) act({ type: 'feature', ...r.feature }); else r.go(); }
    else if (e.key === 'Escape') { closeSearch(); e.stopPropagation(); }
  });
  $('#results').onclick = (e) => { const d = e.target.closest('[data-i]'); if (d) { const r = state.results[+d.dataset.i]; closeSearch(); if (e.target.closest('[data-feat]')) act({ type: 'feature', ...r.feature }); else r.go(); } };
  $('#q').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('#q')) closeSearch(); }, 150));
}

export function initLegend() {
  $('#legkinds').onclick = (e) => { const b = e.target.closest('[data-kind]'); if (!b) return; kindOn[b.dataset.kind] = !kindOn[b.dataset.kind]; b.classList.toggle('off', !kindOn[b.dataset.kind]); };
  $('#legmin').onclick = () => { const l = $('#legend'); l.classList.toggle('min'); setLegBtn(); };
  const setLegBtn = () => { $('#legmin').innerHTML = `${I.info}Legend${$('#legend').classList.contains('min') ? I.chevR : I.chevD}`; };
  setLegBtn();
  $('#chgbtn').onclick = () => { state.showChanges = !state.showChanges; $('#chgbtn').classList.toggle('on', state.showChanges); document.body.classList.toggle('show-changes', state.showChanges); recolor(); };
}

// Media-control icons for the flow bar. scene.js writes ⏸ / ▶ / ↻ into the play button; swap them for icons.
function initFlowBar() {
  const play = $('#fbplay'), glyphs = { '⏸': I.pause, '▶': I.play, '↻': I.replay };
  const swap = () => { const g = glyphs[play.textContent]; if (g) { play.innerHTML = g; play.classList.toggle('playing', g === I.pause); } };
  new MutationObserver(swap).observe(play, { childList: true });
  swap();
  $('#fbprev').innerHTML = I.back; $('#fbnext').innerHTML = I.fwd; $('#fbclose').innerHTML = I.x;
}

export function initResizablePanels() {
  panelMax = () => innerWidth - 200;
  panelMin = () => 280;
  resizable(addHandle(drawer, 'x'), drawer, { key: 'drawer', cssVar: '--w', axis: 'x', min: panelMin, max: panelMax });
  resizable(addHandle(detail, 'x'), detail, { key: 'detail', cssVar: '--w', axis: 'x', min: panelMin, max: panelMax, onChange: () => document.body.style.setProperty('--dw', detail.style.getPropertyValue('--w') || '400px') });
  resizable(addHandle($('#chatbox'), 'x'), $('#chatbox'), { key: 'chat-w', cssVar: '--w', axis: 'x', min: panelMin, max: panelMax });
  resizable(addHandle($('#chatbox'), 'y'), $('#chatbox'), { key: 'chat-h', cssVar: '--h', axis: 'y', min: () => 200, max: () => innerHeight - 100 });
  resizable($('#dsplit'), drawer, { key: 'tree', cssVar: '--tw', axis: 'x', sign: 1, min: () => 120, max: () => Math.max(200, (drawer.offsetWidth || innerWidth * 0.55) * 0.6) });
}
