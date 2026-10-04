// nav.js
// Exports: remember, initNav
// Imports: state: state | board: lensPlace, showLens | drawer: closeDrawer, drawer, hist, openFile | hud: I | scene: camPos, controls, flyTo | util: $
/* Back and forward through places: where the camera was, the Lens and the code drawer as they were.
   Every jump (a click, search, the chat, Esc) records the place it leaves, as a browser history entry, so the
   ‹ › buttons, the mouse's back/forward buttons, Alt+←/→ and a trackpad swipe all go back the same way. */
import { state } from './state.js';
import { lensPlace, showLens } from './board.js';
import { closeDrawer, drawer, hist, openFile } from './drawer.js';
import { I } from './hud.js';
import { camPos, controls, flyTo } from './scene.js';
import { $ } from './util.js';

const places = new Map();   // history entry number -> the place as it was when we left it
let cur = 0, top = 0, next = 1, restoring = false, quiet = 0;

function place() {
  const h = drawer.classList.contains('open') && state.curFile ? hist[state.hIdx] : null;
  return { target: controls.target.clone(), dir: camPos.clone().sub(controls.target), lens: lensPlace(),
           file: h?.path === state.curFile ? { ...h } : null };
}

// Called by flyTo before a jump. One user action can fly more than once (to a board, then its station): one entry.
export function remember() {
  if (restoring || performance.now() < quiet) return;
  quiet = performance.now() + 400;
  places.set(cur, place());
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

function buttons() { if (!$('#nav')) return; $('#navback').disabled = cur <= 0; $('#navfwd').disabled = cur >= top; }

export function initNav() {
  history.replaceState({ ...history.state, nav: 0 }, '', location.href);
  document.body.insertAdjacentHTML('beforeend', `<div id="nav" class="hud glass">
    <button id="navback" title="Back (Alt+←)" aria-label="Back">${I.chevL}</button><button id="navfwd" title="Forward (Alt+→)" aria-label="Forward">${I.chevR}</button></div>`);
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
