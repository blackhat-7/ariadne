// main.js
// Exports: (none: entry point)
// Imports: state: state | board: initBoard, loadStructures | chat: initChat, initSettings, loadAgents, probeChat | drawer: closeDrawer, closePop, drawer, gpop, initCodeBrowser, initCodeLink, navHist, openFinder, overlay, probeCodeApi, updateBeacon | hud: buildLegend, buildSearch, drawMini, initBreadcrumb, initDetailPanel, initHoverCard, initLabels, initLegend, initMinimap, initResizablePanels, initSearch, level, openCode, openSearch, setKinds, stepOut, updateCrumbs, updateHover, updateLabels | scene: bloom, build, camPos, camera, clusters, composer, controls, exts, findEnt, fly, flyOverview, flyToEnt, initCameraFlight, initFlowPlayback, initLod, initNavigation, initPicking, initShaders, initState, initThreeSetup, initWorldModel, kindOn, parts, playFlow, player, renderer, select, setEmphasis, stopFlow, uTime, updateFly, updateLOD, updatePlayer, updateViewOffset | theme: initVocabulary | util: $, esc, initUtil | voice: initVoice
import * as THREE from 'three';
import { state } from './state.js';
import { initBoard, loadStructures } from './board.js';
import { initChat, initSettings, loadAgents, probeChat } from './chat.js';
import { closeDrawer, closePop, drawer, gpop, initCodeBrowser, initCodeLink, navHist, openFinder, overlay, probeCodeApi, updateBeacon } from './drawer.js';
import { buildLegend, buildSearch, drawMini, initBreadcrumb, initDetailPanel, initHoverCard, initLabels, initLegend, initMinimap, initResizablePanels, initSearch, level, openCode, openSearch, setKinds, stepOut, updateCrumbs, updateHover, updateLabels } from './hud.js';
import { bloom, build, camPos, camera, clusters, composer, controls, exts, findEnt, fly, flyOverview, flyToEnt, initCameraFlight, initFlowPlayback, initLod, initNavigation, initPicking, initShaders, initState, initThreeSetup, initWorldModel, kindOn, parts, playFlow, player, renderer, select, setEmphasis, stopFlow, uTime, updateFly, updateLOD, updatePlayer, updateViewOffset } from './scene.js';
import { initVocabulary } from './theme.js';
import { initVoice } from './voice.js';
import { $, esc, initUtil } from './util.js';

export let clock;

export async function loadMap() {
  for (const url of ['/map.json', 'map.json', 'sample-map.json']) {
    try { const r = await fetch(url, { cache: 'no-store' }); if (r.ok) { state.mapUrl = url; return await r.json(); } } catch { /* try next */ }
  }
  throw new Error('No map found. Serve this folder (python3 -m http.server) or run ariadne.py serve.');
}

/* ---------------- actions (chat + console) ---------------- */
export function act(a) {
  if (!state.M || !a || typeof a !== 'object') return false;
  switch (a.type) {
    case 'focus': { const ent = findEnt(a.id); if (!ent) return false; if (player.on) stopFlow(); select(ent); flyToEnt(ent); return true; }
    case 'play': return playFlow(a.flow);
    case 'highlight': {
      const ids = (a.ids || []).filter((id) => parts.has(id) || exts.has(id) || clusters.has(id));
      if (!ids.length) { setEmphasis(null); return true; }
      const all = new Set(ids); for (const id of ids) clusters.get(id)?.parts.forEach((p) => all.add(p.id));
      setEmphasis([...all]); return true;
    }
    case 'filter': setKinds(a.kinds && a.kinds.length ? a.kinds : Object.keys(kindOn)); return true;
    case 'overview': stopFlow(); select(null); flyOverview(); return true;
    case 'code': openCode(a.ref); return !!a.ref;
    default: return false;
  }
}

export function frame() {
  requestAnimationFrame(frame);
  if (document.hidden) { clock.getDelta(); return; }
  const dt = Math.min(clock.getDelta(), 0.1);
  uTime.value += dt;
  updateFly(dt);
  updateViewOffset(dt);
  controls.enabled = !fly.on;
  controls.update();
  updatePlayer(dt);
  updateLOD(dt);
  updateLabels(dt);
  updateBeacon(dt);
  state.frameNo++;
  if (state.frameNo % 6 === 0) drawMini();
  if (state.frameNo % 10 === 0) updateCrumbs();
  if (state.mouseDirty && state.frameNo % 2 === 0) { state.mouseDirty = false; updateHover(); }
  composer.render();
  renderer.autoClear = false; renderer.clearDepth(); renderer.render(overlay, camera); renderer.autoClear = true;
}

function initLoad() {
  /* ---------------- load ---------------- */

}

function initKeyboard() {
  /* ---------------- keyboard ---------------- */
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && state.codeApi) { e.preventDefault(); openFinder(); return; }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && drawer.classList.contains('open')) { e.preventDefault(); navHist(e.key === 'ArrowLeft' ? -1 : 1); return; }
    if (e.target.closest?.('input,textarea')) return;
    if (e.key === '/') { e.preventDefault(); openSearch(); }
    else if (e.key === 'Escape') {
      if (gpop.classList.contains('open')) closePop();
      else if (drawer.classList.contains('open')) closeDrawer();
      else if (player.on) stopFlow(); else stepOut();
    }
    else if (player.on && e.key === ' ') { e.preventDefault(); $('#fbplay').click(); }
    else if (player.on && e.key === 'ArrowRight') $('#fbnext').click();
    else if (player.on && e.key === 'ArrowLeft') $('#fbprev').click();
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.setViewOffset(innerWidth, innerHeight, state.viewOff, 0, innerWidth, innerHeight);
    renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); bloom.resolution.set(innerWidth, innerHeight);
  });
}

function initLoop() {
  /* ---------------- loop ---------------- */
  clock = new THREE.Clock();
  state.frameNo = 0;
}

async function initBoot() {
  /* ---------------- boot ---------------- */
  try {
    state.M = await loadMap();
    document.title = `${state.M.title || 'ariadne'} · ariadne`;
    $('#tname').textContent = state.M.title || 'ariadne';
    $('#summary').textContent = state.M.summary || '';
    $('#rev').textContent = [state.M.revision, state.mapUrl.includes('sample') ? 'sample map' : ''].filter(Boolean).join(' · ');
    $('#sysflows').innerHTML = (state.M.systemFlows || []).map((f, i) => `<button data-play="system#${i}"><b>▶</b>${esc(f.title)}</button>`).join('');
    const nf = (state.M.systemFlows || []).length;
    $('#flowsbtn').hidden = !nf;
    const setFlowsBtn = () => { $('#flowsbtn').textContent = `Flows (${nf}) ${$('#sysflows').hidden ? '▸' : '▾'}`; };
    setFlowsBtn();
    $('#flowsbtn').onclick = () => { $('#sysflows').hidden = !$('#sysflows').hidden; setFlowsBtn(); };
    $('#sysflows').onclick = (e) => { const b = e.target.closest('[data-play]'); if (b) playFlow(b.dataset.play); };
    build(); buildLegend(); buildSearch();
    controls.maxDistance = state.overviewDist * 2.5;
    controls.target.set(0, 0, 0);
    camPos.set(0, Math.sin(0.9) * state.overviewDist * 1.4, Math.cos(0.9) * state.overviewDist * 1.4);
    flyOverview(); fly.dur = 2.2;
    window.ariadne = { act, map: state.M, play: (id) => playFlow(id), state: () => ({ level: level(), selected: state.selected, flow: player.on ? { id: player.id, step: player.i } : null, camera: { target: controls.target.toArray(), distance: camPos.distanceTo(controls.target) }, board: state.focusPart?.struct ? { part: state.focusPart.id, depth: +state.focusPart.struct.depth.toFixed(2) } : null }) };
    frame();
    $('#boot').classList.add('gone');
    probeChat(); loadAgents(); state.codeReady = probeCodeApi(); state.codeReady.then(loadStructures);
  } catch (err) {
    console.error(err);
    $('#boot').innerHTML = `<div class="err">${esc(err.message)}</div>`;
  }
}

// Run every section in the original order (each module's init* sets up its part of the app).
initUtil();
initVocabulary();
initLoad();
initThreeSetup();
initShaders();
initLabels();
initWorldModel();
initState();
initBoard();
initLod();
initCameraFlight();
initPicking();
initHoverCard();
initDetailPanel();
initFlowPlayback();
initBreadcrumb();
initMinimap();
initSearch();
initLegend();
initSettings();
initVoice();
initChat();
initCodeBrowser();
initCodeLink();
initResizablePanels();
initKeyboard();
initNavigation();
initLoop();
await initBoot();

// Deep link: #act=[{...}, ...] runs those actions after boot, 1.5s apart (shareable views, screenshots).
try {
  const m = location.hash.match(/act=(.+)$/);
  const actions = m ? JSON.parse(decodeURIComponent(m[1])) : [];
  // Wait for the code API probe so code actions open the drawer, not the excerpt fallback.
  Promise.resolve(state.codeReady).then(() => actions.forEach((a, i) => setTimeout(() => act(a), 800 + i * 1500)));
} catch (e) { console.warn('bad #act link', e); }
