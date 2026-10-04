// drawer.js
// Exports: refLine, codeHtml, drawer, dcode, dtree, gpop, treeCache, fileCache, hist, getJSON, probeCodeApi, LANGS, langOf, highlightLines, partOfPath, openFile, renderTree, DEF_RE, indentOf, enclosingFn, lastSeg, codeMatches, overlay, BEACON_AMBER, ringGeo, beaconMat, rippleMat, beacon, beaconRing, ripple, updateBeacon, stepNode, linkCode, applyCodeLink, showCodeLink, clearCodeLink, renderCtx, navHist, closeDrawer, closePop, openFinder, runFinder, renderFinder, closeFinder, initCodeBrowser, initCodeLink
// Imports: state: state | board: structNodeAt | hud: fuzzy, openCode | main: act | scene: camPos, camera, controls, exts, flyTo, nodeByKey, parts, playFlow, player, recolor, resolveEnt, select, setEmphasis | theme: KINDS, THEME, kindOf | util: $, V3, clamp, ease, esc
import * as THREE from 'three';
import { state } from './state.js';
import { structNodeAt } from './board.js';
import { fuzzy, openCode } from './hud.js';
import { act } from './main.js';
import { camPos, camera, controls, exts, flyTo, nodeByKey, parts, playFlow, player, recolor, resolveEnt, select, setEmphasis } from './scene.js';
import { KINDS, THEME, kindOf } from './theme.js';
import { $, V3, clamp, ease, esc } from './util.js';

export let drawer, dcode, dtree, gpop, treeCache, fileCache, hist, LANGS, partOfPath, DEF_RE, indentOf, lastSeg, overlay, BEACON_AMBER, ringGeo, beaconMat, rippleMat, beacon, beaconRing, ripple;

/* ---------------- code rendering ---------------- */
export function refLine(ref) { const m = /:(\d+)$/.exec(ref || ''); return m ? +m[1] : 0; }

export function codeHtml(ref, around) {
  const c = state.M.code?.[ref], line = refLine(ref);
  const head = `<div class="hd"><span>${esc(ref)}</span>${c && c.verified === false ? '<span class="unv" title="Could not verify this line in the repo">⚠ unverified</span>' : ''}</div>`;
  if (!c) return head + `<div class="body"><div class="cl"><i></i>no excerpt</div></div>`;
  let lines = c.lines.map((t, i) => [c.start + i, t]);
  if (around) { const at = line - c.start; lines = lines.slice(Math.max(0, at - around), at + around + 1); }
  return head + `<div class="body">${lines.map(([n, t]) => `<div class="cl${n === line ? ' on' : ''}"><i>${n}</i>${esc(t.replace(/\t/g, '  '))}</div>`).join('')}</div>`;
}

export async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }

export async function probeCodeApi() {
  if (!location.protocol.startsWith('http')) return;
  try { const j = await getJSON('/api/tree?dir=__ariadne_probe__'); state.codeApi = Array.isArray(j.files); } catch { /* plain static server */ }
}

export function langOf(path) {
  const base = path.split('/').pop(), ext = base.includes('.') ? base.split('.').pop().toLowerCase() : base.toLowerCase();
  const l = ext === 'dockerfile' ? 'dockerfile' : LANGS[ext];
  return l && window.hljs?.getLanguage(l) ? l : null;
}

// Highlight the whole file, then split into lines, re-opening spans that cross a line break.
export function highlightLines(lines, path) {
  const lang = langOf(path), text = lines.join('\n');
  if (!lang || text.length > 600000) return lines.map(esc);
  const html = window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  const out = [], open = [];
  let line = '';
  for (const tok of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!tok) continue;
    if (tok === '\n') { out.push(line + '</span>'.repeat(open.length)); line = open.join(''); }
    else if (tok.startsWith('<span')) { open.push(tok); line += tok; }
    else if (tok === '</span>') { open.pop(); line += tok; }
    else line += tok;
  }
  out.push(line + '</span>'.repeat(open.length));
  return out;
}

export async function openFile(path, line, fromHist) {
  drawer.classList.add('open'); closePop();
  if (!fromHist) { hist.splice(state.hIdx + 1); hist.push({ path, line }); state.hIdx = hist.length - 1; }
  $('#dback').disabled = state.hIdx <= 0; $('#dfwd').disabled = state.hIdx >= hist.length - 1;
  const dirs = path.split('/'), name = dirs.pop();
  const chev = '<span class="sym i-chev"></span>';
  $('#dpath').innerHTML = `<bdi>${dirs.map((d) => `<span>${esc(d)}</span>${chev}`).join('')}<b><span class="sym i-code"></span>${esc(name)}</b>${line ? `<span class="ln">:${line}</span>` : ''}</bdi>`;
  $('#dpath').title = path + (line ? ':' + line : '');
  const p = partOfPath(path);
  $('#dpart').hidden = !p;
  if (p) { $('#dpart').innerHTML = `<span class="dot"></span>${esc(p.name)}`; $('#dpart').title = 'Show on the map'; $('#dpart').style.setProperty('--k', KINDS[kindOf(p)].color); $('#dpart').onclick = () => act({ type: 'focus', id: p.id }); }
  const fresh = state.curFile !== path;
  if (fresh) {
    state.curFile = path;
    dcode.innerHTML = `<div class="sk">${Array.from({ length: 16 }, (_, i) => `<div class="skeleton" style="width:${24 + ((i * 37) % 56)}%"></div>`).join('')}</div>`;
    const diff = await state.diffHtml?.(path);   // review mode: a changed file opens as its diff (review.js)
    if (state.curFile !== path) return;
    if (diff) dcode.innerHTML = diff;
    else {
      let lines = fileCache.get(path);
      if (!lines) {
        try { lines = (await getJSON('/api/file?path=' + encodeURIComponent(path))).lines; fileCache.set(path, lines); }
        catch {
          const ex = state.M.code?.[`${path}:${line}`];
          dcode.innerHTML = ex ? `<div class="note">File not readable on the server; showing the stored excerpt.</div><div class="code">${codeHtml(`${path}:${line}`)}</div>` : `<div class="state error"><b>Couldn’t open this file</b>${esc(path)}</div>`;
          renderTree(p, path); return;
        }
      }
      if (state.curFile !== path) return;
      const hl = highlightLines(lines, path);
      dcode.innerHTML = hl.map((h, i) => `<div class="cl" data-n="${i + 1}"><i>${i + 1}</i><span class="t">${h || ' '}</span></div>`).join('');
    }
  }
  dcode.querySelector('.cl.on')?.classList.remove('on');
  const el = line && dcode.querySelector(`.cl[data-n="${line}"]`);
  // New file: jump. Same file: smooth scroll (CSS scroll-behavior, off under reduced motion).
  if (el) { el.classList.add('on'); el.scrollIntoView({ block: 'center', behavior: fresh ? 'instant' : 'auto' }); } else dcode.scrollTo({ top: 0, behavior: 'instant' });
  renderTree(p, path);
  linkCode(path, line, null);
}

export async function renderTree(p, path) {
  const dir = p ? p.path.replace(/\/$/, '') : path.split('/').slice(0, -1).join('/');
  if (dtree.dataset.dir !== dir) {
    dtree.dataset.dir = dir; dtree.innerHTML = '';
    let files = treeCache.get(dir);
    if (!files) { try { files = (await getJSON('/api/tree?dir=' + encodeURIComponent(dir))).files; treeCache.set(dir, files); } catch { files = []; } }
    if (dtree.dataset.dir !== dir) return;
    const root = {};
    for (const f of files) { let n = root; const segs = f.slice(dir.length).replace(/^\//, '').split('/'); segs.forEach((s, i) => { n = n[s] ||= i === segs.length - 1 ? f : {}; }); }
    const build = (node, d) => Object.keys(node).sort((a, b) => (typeof node[a] === 'string') - (typeof node[b] === 'string') || a.localeCompare(b)).map((k) =>
      typeof node[k] === 'string' ? `<span class="f" style="--d:${d}" data-file="${esc(node[k])}" title="${esc(node[k])}"><span class="sym i-file"></span>${esc(k)}</span>`
        : `<details style="--d:${d}" data-dir="${esc(k)}"><summary style="--d:${d}"><span class="sym i-chev"></span><span class="sym i-folder"></span>${esc(k)}</summary>${build(node[k], d + 1)}</details>`).join('');
    dtree.innerHTML = `<div class="th tag" title="${esc(dir || 'repo')}">${esc(dir.split('/').pop() || 'repo')}</div>` + (files.length ? build(root, 0) : '<div class="state">No files</div>');
  }
  dtree.querySelector('.f.cur')?.classList.remove('cur');
  const cur = dtree.querySelector(`.f[data-file="${CSS.escape(path)}"]`);
  if (cur) { cur.classList.add('cur'); for (let d = cur.parentElement; d && d !== dtree; d = d.parentElement) if (d.tagName === 'DETAILS') d.open = true; cur.scrollIntoView({ block: 'nearest' }); }
}

export function enclosingFn(lines, line) {
  if (!lines || !line) return null;
  for (let i = line - 1; i >= 0; i--) {
    const t = lines[i];
    if (!DEF_RE.test(t)) continue;
    const m = /^\s*func\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(t) || /\b(?:def|class|function\*?|fn|interface|impl)\s+([A-Za-z_$][\w$]*)/.exec(t) || /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(t);
    const ind = indentOf(t); let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) if (lines[j].trim() && DEF_RE.test(lines[j]) && indentOf(lines[j]) <= ind) { end = j; break; }
    return { name: m ? m[1] : null, start: i + 1, end };
  }
  return null;
}

// Flow steps related to a code location (and optionally an identifier).
export function codeMatches(path, line, word) {
  const fn = enclosingFn(fileCache.get(path), line);
  const all = [];
  for (const p of parts.values()) (p.flows || []).forEach((f, k) => (f.steps || []).forEach((st, i) => all.push({ part: p, flowId: `${p.id}#${k}`, k, i, st, title: f.title })));
  (state.M.systemFlows || []).forEach((f, k) => (f.steps || []).forEach((st, i) => all.push({ part: null, flowId: `system#${k}`, k, i, st, title: f.title })));
  const inFile = (st) => st.ref && st.ref.slice(0, st.ref.lastIndexOf(':')) === path;
  const scored = [];
  for (const m of all) {
    const st = m.st, l = refLine(st.ref);
    let score = 0;
    if (word) { if (st.fn === word || lastSeg(st.from) === word || lastSeg(st.to) === word) score = inFile(st) ? 3 : 2; }
    else if (inFile(st)) {
      if (fn ? l >= fn.start && l < fn.end : Math.abs(l - line) <= 3) score = 3 - Math.min(2, Math.abs(l - line) / 50);
      else if (fn?.name && (lastSeg(st.from) === fn.name || lastSeg(st.to) === fn.name)) score = 1;
    }
    if (score) scored.push({ ...m, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.part ? 0 : 1) - (b.part ? 0 : 1));
  return { fn, matches: scored.slice(0, 12) };
}

export function updateBeacon(dt) {
  if (!beacon.visible) return;
  const b = beacon.userData;
  beacon.position.copy(b.at); beacon.quaternion.copy(camera.quaternion);
  beaconRing.scale.setScalar(b.size);
  b.t += dt;
  const u = clamp(b.t / 0.9, 0, 1);
  ripple.visible = u < 1;
  if (u < 1) state.redraw = true;
  ripple.scale.setScalar(b.size * (1 + 1.6 * ease(u))); rippleMat.opacity = 0.35 * (1 - u);
}

export function stepNode(m) {
  if (!m.part) return null;
  return nodeByKey.get(`${m.part.id}#${m.k}:${m.st.to}`) || nodeByKey.get(`${m.part.id}#${m.k}:${m.st.from}`) || null;
}

export function linkCode(path, line, word) {
  clearTimeout(state.linkTimer);
  state.linkTimer = setTimeout(() => applyCodeLink(path, line, word), 250);
}

export function applyCodeLink(path, line, word) {
  if (!drawer.classList.contains('open') || path !== state.curFile) return;
  const part = partOfPath(path), { fn, matches } = codeMatches(path, line, word);
  state.codeLink = { path, line, word, part, fn, matches, hot: !!word, snode: structNodeAt(part, path, line, word) };
  state.linkSel = 0;
  renderCtx();
  if (!player.on) showCodeLink(false);
}

export function showCodeLink(force) {
  const L = state.codeLink; if (!L) return;
  const m = L.matches[state.linkSel];
  const focusPartObj = m?.part || L.part;
  if (m?.part) L.part = m.part;
  const sn = L.snode && L.snode.node.owner === focusPartObj && (L.part.struct.depth > 0.2 || !m) ? L.snode.node : null;
  const node = sn || (m ? stepNode(m) : null);
  const at = node ? node.pos : focusPartObj ? focusPartObj.pos : m ? (parts.get(m.st.to) || exts.get(m.st.to) || parts.get(m.st.from) || exts.get(m.st.from))?.pos : null;
  // skip the ring when the node is already visibly selected; the node highlight is enough
  const isSel = node && state.selected && (state.selected.key === node.key || state.selected.id === node.key);
  beacon.visible = !!at && !isSel; state.redraw = true;
  if (at) {
    const b = beacon.userData;
    if (b.at !== at) b.t = 0;                                         // new target: one ripple
    b.at = at; b.size = sn ? 0.6 : node ? 1.5 : focusPartObj ? focusPartObj.r * 1.8 : 4;
    const c = node ? node.base : BEACON_AMBER; beaconMat.color.copy(c).lerp(BEACON_AMBER, 0.4); rippleMat.color.copy(beaconMat.color);
  }
  // Related entities: highlight on identifier/selection, otherwise only the beacon.
  const keys = new Set(), ids = new Set(), pts = [];
  if (L.hot) {
    for (const x of L.matches) {
      if (x.part) {
        ids.add(x.part.id); pts.push(x.part.pos);
        for (const a of [x.st.from, x.st.to]) {
          const n = nodeByKey.get(`${x.part.id}#${x.k}:${a}`); if (n) { keys.add(n.key); }
          if (parts.has(a) || exts.has(a)) ids.add(a);
        }
      } else for (const a of [x.st.from, x.st.to]) if (parts.has(a) || exts.has(a)) { ids.add(a); pts.push((parts.get(a) || exts.get(a)).pos); }
    }
    if (L.part) ids.add(L.part.id);
    setEmphasis([...ids], (Lk) => ids.has(Lk.a.id) && ids.has(Lk.b.id));
  } else if (!state.selected) setEmphasis(null);
  else select(resolveEnt(state.selected));
  if (node) keys.add(node.key);
  state.activeKeys = keys; recolor();
  // Gentle framing in the area left of the drawer: only move when the target is clearly elsewhere.
  if (!at) return;
  let target, dist;
  const multiPart = new Set(pts).size > 1;
  if (L.hot && multiPart) {
    const box = new THREE.Box3().setFromPoints([at, ...pts]), sph = box.getBoundingSphere(new THREE.Sphere());
    target = sph.center; dist = clamp(sph.radius * 2.8, 40, state.overviewDist * 1.2);
  } else if (sn) {
    target = sn.pos.clone(); dist = Math.min(camPos.distanceTo(controls.target), 22);
    if (!force && camPos.distanceTo(sn.pos) < 26) return;
  } else if (focusPartObj) {
    target = node ? new V3().lerpVectors(focusPartObj.pos, node.pos, 0.5) : focusPartObj.pos.clone();
    dist = focusPartObj.focusDist;
  } else { target = at.clone(); dist = 60; }
  const curD = camPos.distanceTo(controls.target);
  if (force || controls.target.distanceTo(target) > dist * 0.25 || Math.abs(Math.log(curD / dist)) > 0.5) flyTo(target, dist, { dur: 1.2, hist: !!force });   // following the code as you read is not a jump
}

export function clearCodeLink() {
  clearTimeout(state.linkTimer);
  if (!state.codeLink) return;
  state.codeLink = null; beacon.visible = false; state.redraw = true; $('#dctx').innerHTML = '';
  if (!player.on) { state.activeKeys = new Set(); recolor(); if (state.selected) select(resolveEnt(state.selected)); else setEmphasis(null); }
}

export function renderCtx() {
  const L = state.codeLink, el = $('#dctx');
  const hint = '<span class="hl"><b>Click</b> a name to find uses · <kbd>⇧</kbd> <b>click</b> or <b>select</b> text to show it on the map</span>';
  const lbl = '<span class="lbl tag">On the map</span>';
  if (!L.part && !L.matches.length) { el.innerHTML = `${lbl}<span class="what dimmed">Not inside a mapped part</span>${hint}`; return; }
  const m = L.matches[state.linkSel];
  const show = '<button class="btn" data-ctx="show"><span class="sym i-scope"></span>Show</button>';
  let h = lbl;
  if (m) {
    h += `<span class="what"><b>${esc(m.part ? m.part.name : 'System')}</b><span class="sym i-chev sep"></span>${esc(m.title)}<span class="sep">· step ${m.i + 1}</span></span>
      <button class="btn primary" data-ctx="play"><span class="sym i-play"></span>Play from here</button>${show}`;
    if (L.matches.length > 1) h += `<span class="mchips">${L.matches.map((x, i) => `<button class="mchip${i === state.linkSel ? ' on' : ''}" data-m="${i}" title="${esc(x.st.text)}">${esc(x.part ? x.part.name : 'System')} · ${esc(x.title)} <span>#${x.i + 1}</span></button>`).join('')}</span>`;
  } else h += `<span class="what"><b>${esc(L.part.name)}</b><span class="sep">· not part of a mapped flow${L.fn?.name ? ` (${esc(L.fn.name)})` : ''}</span></span>${show}`;
  if (L.snode) h += `<span class="what sn"><span class="sep">${L.snode.kind}</span> <b>${esc(L.snode.kind === 'method' && L.snode.parent ? L.snode.parent + '.' + L.snode.name : L.snode.name)}</b></span>`;
  el.innerHTML = h + hint;
}

export function navHist(step) { const i = state.hIdx + step; if (i < 0 || i >= hist.length) return; state.hIdx = i; openFile(hist[i].path, hist[i].line, true); }

export function closeDrawer() { drawer.classList.remove('open'); closePop(); clearCodeLink(); }

export function closePop() { gpop.classList.remove('open'); dcode.querySelector('.hlw')?.replaceWith(...(dcode.querySelector('.hlw')?.childNodes || [])); }

export async function openFinder() {
  $('#finder').classList.add('open'); $('#fq').value = ''; $('#fres').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'; $('#fq').focus();
  if (!state.repoFiles) { try { state.repoFiles = (await getJSON('/api/tree?dir=')).files; } catch { state.repoFiles = []; } }
  runFinder();
}

export function runFinder() {
  if (!state.repoFiles) return;   // still loading; openFinder runs us once the list arrives
  const q = $('#fq').value.trim().toLowerCase();
  state.fItems = (q ? state.repoFiles.map((f) => ({ f, s: Math.max(fuzzy(q, f.split('/').pop()) * 2, fuzzy(q, f)) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s) : state.repoFiles.map((f) => ({ f }))).slice(0, 20).map((x) => x.f);
  state.fIdx = 0; renderFinder();
}

export function renderFinder() {
  $('#fres').innerHTML = state.fItems.length ? state.fItems.map((f, i) => { const k = f.lastIndexOf('/'); return `<div data-i="${i}" class="${i === state.fIdx ? 'on' : ''}"><span class="sym i-file"></span><b>${esc(f.slice(k + 1))}</b><span class="dir">${esc(f.slice(0, k + 1))}</span></div>`; }).join('')
    : `<div class="state">${state.repoFiles.length ? 'No matching files' : 'No files available'}</div>`;
  $('#fres .on')?.scrollIntoView({ block: 'nearest' });
}

export function closeFinder() { $('#finder').classList.remove('open'); }

export function initCodeBrowser() {
  /* ---------------- code browser (needs /api/tree, /api/file, /api/grep) ---------------- */
  state.codeApi = false;
  state.repoFiles = null;
  drawer = $('#drawer');
  dcode = $('#dcode');
  dtree = $('#dtree');
  gpop = $('#gpop');
  treeCache = new Map();
  fileCache = new Map();
  hist = [];
  state.hIdx = -1;
  state.curFile = null;
  LANGS = { go: 'go', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby', sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml', json: 'json', sql: 'sql', md: 'markdown', proto: 'protobuf', toml: 'ini', ini: 'ini', css: 'css', html: 'xml', xml: 'xml', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', php: 'php', tf: 'plaintext' };
  if (matchMedia('(max-width:900px)').matches) drawer.classList.add('notree');   // phone: code first, tree on demand
  partOfPath = (path) => [...parts.values()].filter((p) => p.path && (path === p.path || path.startsWith(p.path.replace(/\/$/, '') + '/'))).sort((a, b) => b.path.length - a.path.length)[0] || null;
}

export function initCodeLink() {
  /* ---------------- code -> map link ---------------- */
  DEF_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:(?:public|private|protected|static|async|override|final|abstract|internal)\s+)*(?:func|def|class|function\*?|fn|interface|impl)\b|^\s*(?:async\s+)?(?!(?:if|for|while|switch|catch|return|else)\b)[A-Za-z_$][\w$]*\s*\([^;]*\)\s*(?::\s*[^{=]+)?\{\s*$/;
  indentOf = (t) => /^\s*/.exec(t)[0].replace(/\t/g, '    ').length;
  lastSeg = (a) => String(a).split('.').pop();
  // The code->map marker: a thin camera-facing ring drawn after bloom (overlay scene), one soft ripple on arrival.
  overlay = new THREE.Scene();
  BEACON_AMBER = new THREE.Color(THEME.beacon);
  ringGeo = new THREE.RingGeometry(0.9, 1, 64);
  beaconMat = new THREE.MeshBasicMaterial({ color: BEACON_AMBER, transparent: true, opacity: 0.35, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
  rippleMat = beaconMat.clone();
  beacon = new THREE.Group();
  beaconRing = new THREE.Mesh(ringGeo, beaconMat);
  ripple = new THREE.Mesh(ringGeo, rippleMat);
  beacon.add(beaconRing, ripple);
  beacon.visible = false;
  beacon.userData = { at: new V3(), size: 1, t: 9 };
  overlay.add(beacon);
  state.codeLink = null;
  state.linkTimer = 0;
  state.linkSel = 0;
  $('#dctx').addEventListener('click', (e) => {
    const L = state.codeLink; if (!L) return;
    const c = e.target.closest('[data-m]');
    if (c) { state.linkSel = +c.dataset.m; renderCtx(); showCodeLink(true); return; }
    const a = e.target.closest('[data-ctx]'); if (!a) return;
    if (a.dataset.ctx === 'show') showCodeLink(true);
    else { const m = L.matches[state.linkSel]; if (m) playFlow(m.flowId, m.i); }
  });
  dcode.addEventListener('mouseup', () => {
    const sel = getSelection(), text = sel.toString().trim();
    if (!text || !dcode.contains(sel.anchorNode)) return;
    const lineEl = sel.anchorNode.parentElement?.closest('.cl');
    const word = /^[A-Za-z_]\w*$/.test(text) ? text : (text.match(/[A-Za-z_]\w{2,}/g) || []).find((w) => codeMatches(state.curFile, 0, w).matches.length) || null;
    linkCode(state.curFile, lineEl ? +lineEl.dataset.n : 0, word);
  });
  dtree.addEventListener('click', (e) => {
    const f = e.target.closest('[data-file]'); if (!f) return;
    openFile(f.dataset.file, 0);
    if (matchMedia('(max-width:900px)').matches) drawer.classList.add('notree');   // phone: tree is an overlay, get it out of the way
  });
  $('#dback').onclick = () => navHist(-1);
  $('#dfwd').onclick = () => navHist(1);
  $('#dx').onclick = closeDrawer;
  $('#dfind').onclick = () => openFinder();
  $('#dtreebtn').onclick = () => drawer.classList.toggle('notree');
  // Click any identifier: find the word under the caret and show grep hits.
  dcode.addEventListener('click', async (e) => {
    if (getSelection().toString()) return;
    const lineEl = e.target.closest('.cl'), cline = lineEl ? +lineEl.dataset.n : 0;
    if (lineEl && !e.shiftKey) { dcode.querySelector('.cl.on')?.classList.remove('on'); lineEl.classList.add('on'); }
    const pos = document.caretPositionFromPoint ? document.caretPositionFromPoint(e.clientX, e.clientY) : document.caretRangeFromPoint?.(e.clientX, e.clientY);
    const node = pos?.offsetNode || pos?.startContainer, off = pos?.offset ?? pos?.startOffset;
    if (!node || node.nodeType !== 3 || !node.parentElement.closest('span.t')) { closePop(); if (cline) linkCode(state.curFile, cline, null); return; }
    const t = node.textContent; let a = off, b = off;
    while (a > 0 && /\w/.test(t[a - 1])) a--;
    while (b < t.length && /\w/.test(t[b])) b++;
    const word = t.slice(a, b);
    if (!/^[A-Za-z_]\w*$/.test(word)) { closePop(); if (cline) linkCode(state.curFile, cline, null); return; }
    closePop();
    linkCode(state.curFile, cline, word);
    if (e.shiftKey) return;
    const range = document.createRange(); range.setStart(node, a); range.setEnd(node, b);
    const mark = document.createElement('span'); mark.className = 'hlw'; range.surroundContents(mark);
    const rect = mark.getBoundingClientRect();
    gpop.style.left = Math.min(rect.left, innerWidth - Math.min(560, innerWidth * 0.9) - 8) + 'px';
    gpop.style.top = (rect.bottom + 340 > innerHeight ? Math.max(8, rect.top - 346) : rect.bottom + 6) + 'px';
    gpop.innerHTML = `<div class="gtag"><span class="sym i-search"></span>Searching <b>${esc(word)}</b></div>${'<div class="gh"><span class="skeleton"></span></div>'.repeat(3)}`; gpop.classList.add('open');
    try {
      const { hits } = await getJSON('/api/grep?q=' + encodeURIComponent(word));
      if (!gpop.classList.contains('open')) return;
      gpop.innerHTML = `<div class="gtag"><span class="sym i-search"></span><b>${esc(word)}</b><span>${hits.length}${hits.length >= 200 ? '+' : ''} ${hits.length === 1 ? 'match' : 'matches'}</span></div>` + (hits.length ? hits.map((h) =>
        `<div class="gh" data-ref="${esc(h.ref)}" title="${esc(h.ref)}">${h.def ? '<span class="def">def</span>' : ''}<span class="r">${esc(h.ref)}</span><span class="x">${esc(h.text.trim())}</span></div>`).join('') : '<div class="state">No matches</div>');
    } catch { gpop.innerHTML = '<div class="state error"><b>Search unavailable</b>The code server did not answer.</div>'; }
  });
  gpop.addEventListener('click', (e) => { const h = e.target.closest('[data-ref]'); if (h) openCode(h.dataset.ref); });
  addEventListener('pointerdown', (e) => { if (gpop.classList.contains('open') && !e.target.closest('#gpop,#dcode')) closePop(); });
  // Ctrl+P file finder over the whole repo.
  state.fItems = [];
  state.fIdx = 0;
  $('#fq').addEventListener('input', runFinder);
  $('#fq').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { state.fIdx = Math.min(state.fItems.length - 1, state.fIdx + 1); renderFinder(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { state.fIdx = Math.max(0, state.fIdx - 1); renderFinder(); e.preventDefault(); }
    else if (e.key === 'Enter' && state.fItems[state.fIdx]) { closeFinder(); openFile(state.fItems[state.fIdx], 0); }
    else if (e.key === 'Escape') { closeFinder(); e.stopPropagation(); }
    e.stopPropagation();
  });
  $('#fres').onclick = (e) => { const d = e.target.closest('[data-i]'); if (d) { closeFinder(); openFile(state.fItems[+d.dataset.i], 0); } };
  $('#fq').addEventListener('blur', () => setTimeout(closeFinder, 150));
}
