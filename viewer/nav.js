// nav.js
// Exports: remember, restorePlace, resetView, initNav
// Imports: state: state | board: lensPlace, showLens | drawer: closeDrawer, drawer, openFile | feature: exitFeature | hud: I | scene: camPos, controls, flyOverview, flyTo, parts, select, stopFlow | util: $, V3
/* Back and forward through places: where the camera was, the Lens and the code drawer as they were.
   Every jump (a click, search, the chat, Esc) records the place it leaves, as a browser history entry, so the
   ‹ › buttons, the mouse's back/forward buttons, Alt+←/→ and a trackpad swipe all go back the same way. */
import { state } from './state.js';
import { lensPlace, showLens } from './board.js';
import { closeDrawer, drawer, openFile } from './drawer.js';
import { exitFeature } from './feature.js';
import { I } from './hud.js';
import { camPos, controls, flyOverview, flyTo, parts, select, stopFlow } from './scene.js';
import { $, V3 } from './util.js';

const places = new Map();   // history entry number -> the place as it was when we left it
let cur = 0, top = 0, next = 1, restoring = false, quiet = 0;

function place() {
  const open = drawer.classList.contains('open') && state.curFile;
  return { target: controls.target.clone(), dir: camPos.clone().sub(controls.target), lens: lensPlace(),
           file: open ? { path: state.curFile, line: +$('#dcode .cl.on')?.dataset.n || state.curLine } : null };
}

// Called by flyTo before a jump. One user action can fly more than once (to a board, then its station): one entry.
export function remember() {
  if (restoring || performance.now() < quiet) return;
  quiet = performance.now() + 400;
  places.set(cur, place());
  for (const n of places.keys()) if (n > cur) places.delete(n);   // the old forward entries are gone
  cur = top = next++;
  history.pushState({ ...history.state, nav: cur }, '', location.href);
  buttons();
}

function restore(p) {
  restoring = true;
  try {
    showLens(p.lens);
    if (p.file) openFile(p.file.path, p.file.line, true); else closeDrawer();
    flyTo(p.target, p.dir.length(), { dir: p.dir, minEl: -1.5, maxEl: 1.5 });
  } finally { restoring = false; }
}

/* The place is also kept in this browser per map, so reopening Ariadne comes back to it (camera, code, Lens). */
const SAVED = () => `ariadne.place.${state.M.title}.${state.M.revision}`;

function save() {
  const p = place(), it = p.lens?.it;
  try {
    localStorage.setItem(SAVED(), JSON.stringify({ target: p.target.toArray(), dir: p.dir.toArray(), file: p.file,
      lens: it && { part: it.node?.owner?.id, key: it.key, xray: p.lens.xray } }));
  } catch { /* storage blocked */ }
}

// At boot: put the camera, the code drawer and (once the call boards are built) the Lens back. False: nothing saved.
export function restorePlace() {
  let p;
  try { p = JSON.parse(localStorage.getItem(SAVED())); } catch { /* storage blocked */ }
  if (!p?.target) return false;
  controls.target.fromArray(p.target); camPos.fromArray(p.target).add(new V3().fromArray(p.dir));
  if (p.file) openFile(p.file.path, p.file.line, true);
  if (p.lens) {
    state.firstStruct = p.lens.part;   // board.js loads this part's board first
    const open = (tries) => {
      const S = parts.get(p.lens.part)?.struct, it = S?.items.find((x) => x.key === p.lens.key);
      if (!S) return tries > 0 && state.structStatus !== 'ready' && setTimeout(() => open(tries - 1), 300);
      if (!it) return;
      restoring = true;
      try { showLens({ it, xray: p.lens.xray }); } finally { restoring = false; }
    };
    open(200);
  }
  return true;
}

// Lost: close everything (flow, focus, Lens, code, selection) and fly back over the whole system.
export function resetView() {
  stopFlow(); if (state.feature) exitFeature(); showLens(null); closeDrawer(); select(null);
  flyOverview();
}

// The top bar's ‹ › and the code drawer's (same history).
function buttons() {
  if (!$('#nav')) return;
  for (const id of ['#navback', '#dback']) $(id).disabled = cur <= 0;
  for (const id of ['#navfwd', '#dfwd']) $(id).disabled = cur >= top;
}

export function initNav() {
  history.replaceState({ ...history.state, nav: 0 }, '', location.href);
  document.body.insertAdjacentHTML('beforeend', `<div id="nav" class="hud glass">
    <button id="navback" title="Back (Alt+←)" aria-label="Back">${I.chevL}</button><button id="navfwd" title="Forward (Alt+→)" aria-label="Forward">${I.chevR}</button><button id="navhome" title="Reset view: back over the whole system (H)" aria-label="Reset view">${I.home}</button></div>`);
  $('#navhome').onclick = resetView;
  addEventListener('pagehide', save);
  addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  setInterval(save, 3000);   // a crash or a killed tab still comes back close to where you were
  $('#navback').onclick = () => history.back();
  $('#navfwd').onclick = () => history.forward();
  addEventListener('popstate', (e) => {
    const n = e.state?.nav;
    if (n == null || n === cur) return;
    places.set(cur, place());   // so the other direction comes back here
    cur = n; buttons();
    if (places.has(n)) restore(places.get(n));
  });
  buttons();
}
