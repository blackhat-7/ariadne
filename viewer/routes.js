// routes.js
// Exports: buildRoutes, updateRoutes
// Imports: state: state | hud: Label | scene: LineSet, camera, curve, entFromEvent, exts, parts, player, playFlow, stage | theme: THEME | util: $, V3, esc
// The map's system flows drawn on the overview as metro routes: one calm colour each, an arc per step (routes that
// share a segment fan out side by side), a terminus ring where the route starts, and numbered stops that show only
// while the route is lit. The chips in the top-left panel are its legend: hovering a chip (or a route) lights that route
// end to end and lists its steps, a click plays it. At rest the routes are faint, and they fade as you zoom into a domain.
import * as THREE from 'three';
import { state } from './state.js';
import { Label } from './hud.js';
import { LineSet, camera, curve, entFromEvent, exts, parts, player, playFlow, stage } from './scene.js';
import { THEME } from './theme.js';
import { $, V3, esc } from './util.js';

const REST = 0.2, LIT = 0.95, OTHERS = 0.035;   // route alpha: at rest, lit, and the others while one is lit
let set = null, routes = [], playR = null, chipHover = -1, rayHover = -1, shown = -1, playing = null, curStop = null, ptr = null, ptrDirty = false;
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), hits = [];
ray.params.Line2 = { threshold: 8 };   // px either side of the line

const station = (id) => parts.get(id) || exts.get(id);
const name = (id) => station(id)?.name || id;
const openOf = (s) => s.clusterObj?.open || 0;   // how far a station's domain has opened up (externals never do)
const ringPts = (s, r) => Array.from({ length: 49 }, (_, k) => new V3(s.pos.x + Math.cos(k / 48 * Math.PI * 2) * r, s.pos.y - s.r * 0.9, s.pos.z + Math.sin(k / 48 * Math.PI * 2) * r));

export function buildRoutes() {
  const flows = state.M.systemFlows || [], lanes = new Map(), starts = new Map();
  if (!flows.length) return;
  const pair = (s) => [s.from, s.to].sort().join('\n');
  flows.forEach((f, i) => { for (const s of f.steps || []) { const l = lanes.get(pair(s)) || []; if (!l.includes(i)) l.push(i); lanes.set(pair(s), l); } });
  // colours halved, base gain doubled: the same line, with pulses soft enough not to bloom into blobs
  set = new LineSet(18, 60, 1.9); set.mat.linewidth = 2;
  routes = flows.map((f, i) => {
    const css = THEME.route[i % THEME.route.length], color = new THREE.Color(css).multiplyScalar(0.5), R = { i, id: `system#${i}`, f, css, steps: [] }, stops = new Map();
    (f.steps || []).forEach((s, j) => {
      const a = station(s.from), b = station(s.to);
      if (!a || !b || a === b) { R.steps.push(null); return; }
      // routes sharing a segment bow apart around the middle, and meet again at the stations like metro lines
      const l = lanes.get(pair(s)), lane = l.indexOf(i) - (l.length - 1) / 2;
      const crv = curve(a.pos, b.pos, 0.1, (s.from < s.to ? 1 : -1) * lane * 0.06);
      // the stop sits just under the station it arrives at (its name is above); a station reached twice shows both numbers
      let stop = stops.get(b);
      if (stop) stop.el.textContent += ` · ${j + 1}`;
      else stops.set(b, stop = new Label(String(j + 1), 'lb-stop', b.pos, 72, { style: `--c:${css}`, mode: 'below', dy: 3, ent: { type: 'flow', id: R.id } }));
      R.steps.push({ a, b, stop, item: set.add(crv.getPoints(40), color, R) });
    });
    R.start = R.steps.find(Boolean)?.a;
    if (R.start) { const k = starts.get(R.start) || 0; starts.set(R.start, k + 1); R.ring = set.add(ringPts(R.start, R.start.r * 2 + 1 + k), color, R); }
    return R;
  });
  set.build();

  const box = $('#sysflows');
  box.hidden = !routes.length;
  box.innerHTML = `<div class="rt-hd">Main flows</div>${routes.map((R) => `<button data-route="${R.i}" style="--c:${R.css}"><i class="sw"></i><span>${esc(R.f.title)}</span></button>`).join('')}`;
  box.onclick = (e) => { const b = e.target.closest('[data-route]'); if (b) playFlow(routes[+b.dataset.route].id); };
  box.onpointerover = (e) => { const b = e.target.closest('[data-route]'); if (b) chipHover = +b.dataset.route; };
  box.onpointerleave = () => { chipHover = -1; };
  stage.addEventListener('pointermove', (e) => { ptr = e; ptrDirty = true; });
  stage.addEventListener('pointerleave', () => { ptr = null; ptrDirty = true; });
  // A click on a route line (nothing else under the pointer) plays it.
  stage.addEventListener('click', (e) => {
    if (rayHover < 0 || (state.downAt && Math.hypot(e.clientX - state.downAt[0], e.clientY - state.downAt[1]) > 5) || entFromEvent(e)) return;
    playFlow(routes[rayHover].id);
  });
}

// The route under the pointer, if it is visible enough to point at.
function probe() {
  if (!ptr || ptr.buttons || ptr.pointerType === 'touch') return -1;
  ndc.set((ptr.clientX / innerWidth) * 2 - 1, -(ptr.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  hits.length = 0; set.obj.raycast(ray, hits);
  let best = -1, bd = Infinity;
  for (const h of hits) for (const R of routes) for (const s of R.steps) {
    if (s && h.faceIndex >= s.item.start && h.faceIndex < s.item.start + s.item.count && s.item.alpha > 0.08 && h.distance < bd) { bd = h.distance; best = R.i; }
  }
  return best;
}

// The step list beside the top-left panel, level with the route's chip.
function showCard(i) {
  shown = i;
  const card = $('#routecard');
  if (i < 0) { card.hidden = true; return; }
  const R = routes[i], top = $('#top').getBoundingClientRect(), chip = $(`#sysflows [data-route="${i}"]`).getBoundingClientRect();
  card.style.setProperty('--c', R.css);
  card.innerHTML = `<div class="rc-hd"><i class="sw"></i><b>${esc(R.f.title)}</b></div><ol>${(R.f.steps || []).map((s) => `<li><span>${esc(s.text)}</span><em>${esc(name(s.to))}</em></li>`).join('')}</ol><div class="rc-ft">${R.id === playing ? 'Playing' : 'Click to play'}</div>`;
  card.hidden = false;
  card.style.left = Math.round(Math.min(top.right + 10, innerWidth - card.offsetWidth - 8)) + 'px';
  card.style.top = Math.round(Math.max(8, Math.min(chip.top - 10, innerHeight - card.offsetHeight - 8))) + 'px';
}

// Per frame: hover, the playing route, and every route's alpha (faint at rest, lit end to end, fading into a domain).
export function updateRoutes() {
  if (!set) return;
  if (ptrDirty && state.frameNo % 2 === 0) { ptrDirty = false; rayHover = probe(); if (rayHover >= 0 && !state.hoverEnt) stage.style.cursor = 'pointer'; }
  const sys = player.on && !player.part, pid = sys ? player.id : null, hov = chipHover >= 0 ? chipHover : rayHover;
  if (pid !== playing) {
    playing = pid; playR = routes.find((R) => R.id === pid) || null;
    document.querySelectorAll('#sysflows [data-route]').forEach((b) => b.classList.toggle('on', routes[+b.dataset.route].id === pid));
    if (hov >= 0) showCard(hov);   // its footer says whether it is playing
  }
  if (hov !== shown) showCard(hov);
  const cur = playR?.steps[player.i]?.stop || null;
  if (cur !== curStop) { curStop?.el.classList.remove('cur'); cur?.el.classList.add('cur'); curStop = cur; }
  const fp = state.focusPart, fpU = fp?.unfold || 0, fpD = fp?.struct?.depth || 0;
  // a part's own flow playing, or a call board open: the routes step aside
  const rest = player.on && player.part ? 0 : (hov >= 0 || sys ? OTHERS : REST) * (1 - 0.85 * fpU) * (state.emph && !sys ? 0.4 : 1);
  for (const R of routes) {
    const lit = R.i === hov || R.id === pid, play = R.id === pid;
    for (let j = 0; j < R.steps.length; j++) {
      const s = R.steps[j]; if (!s) continue;
      const al = !lit ? rest * (1 - Math.max(openOf(s.a), openOf(s.b))) : !play ? LIT : j === player.i ? 1 : j < player.i ? 0.75 : 0.4;
      set.setAlpha(s.item, al * (1 - fpD), lit && (!play || j === player.i) ? 1 : 0);
      s.stop.want = lit ? 1 - fpD : 0; s.stop.boost = s.stop === cur ? 90 : 30;
    }
    if (R.ring) set.setAlpha(R.ring, (lit ? LIT : rest * (1 - openOf(R.start))) * (1 - fpD));
  }
  set.flush();
}
