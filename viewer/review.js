// review.js
// Exports: reviewFn, xrayRev, diffOps, mergeXray, openChangeLine, initReview
// Imports: state: state | board: flyToBoard, openLens, setFacing, setGateLines, spoken | chat: openSettings | drawer: dcode, drawer, getJSON, highlightLines, markTree, openFile, postJSON, reloadFile | hud: I, openCode | prflow: flowShown, hideFlow, initFlow, setFlow, showFlow | scene: camPos, controls, fly, flyTo, flyToEnt, markReview, parts, player, recolor, setEmphasis | util: $, V3, clamp, esc | voice: cancelSpeech, speakFlow, voice | xray: blocksOf, focusChange, headOf, itemIds
// PR review mode (REVIEW.md): the Review panel (the PR and its description, changes to existing code, the new code in
// reading order, data, config, tests; keys and reviewed state), the Flow / Map switch, the map resting on the PR's parts,
// the merged head/base x-ray data, the code drawer's Diff view, the review tour, the branch/PR picker and the stale-map
// banner. Everything shown comes from the server's deterministic review JSON.
import { state } from './state.js';
import { flyToBoard, openLens, setFacing, setGateLines, spoken } from './board.js';
import { dcode, drawer, getJSON, highlightLines, markTree, openFile, postJSON, reloadFile } from './drawer.js';
import { openSettings } from './chat.js';
import { I, openCode } from './hud.js';
import { flowShown, hideFlow, initFlow, setFlow, showFlow } from './prflow.js';
import { camPos, controls, fly, flyTo, flyToEnt, markReview, parts, player, recolor, setEmphasis } from './scene.js';
import { $, V3, clamp, esc } from './util.js';
import { cancelSpeech, speakFlow, voice } from './voice.js';
import { blocksOf, focusChange, headOf, itemIds } from './xray.js';

const RANK = { high: 3, medium: 2, low: 1, none: 0 };
const RISK_COLOR = { high: '#ff6b5e', medium: '#f2b04d', low: '#8fd3f0' };
const STATUS = { added: 'new', removed: 'deleted' };
const CAM_KEY = 'ariadne.reviewCam';

// data: the review JSON. head: the selected head as the API names it ("<branch>" | "pr:<N>"), '' = the server's own review.
// rows: the functions in panel order (changed ones, then new code in reading order); cur: the highlighted one (its id).
// done: reviewed function ids. order/depth/via: reading order (reading()). open: sections' open state. more: the full
// description shown; md, mmdSrc, mmd: its HTML, mermaid sources and drawn diagrams. edge: the clicked lifecycle arrow.
const R = { data: null, head: '', base: '', rows: [], cur: null, opened: null, on: false, done: new Set(), order: [], depth: new Map(), via: new Map(),
  analysed: new Set(), dups: new Set(), open: {}, more: false, md: null, mmdSrc: [], mmd: new Map(), edge: null,
  diffs: new Map(), diffOn: true, narr: null, narrBusy: false, narrNote: '', map: null, tour: null, busy: null, error: '', blastSaved: null, camKept: false };
let panel, tourBar, pick = null;

const fnById = (id) => R.data?.functions.find((f) => f.id === id);
const partName = (id) => parts.get(id)?.name || id || 'Outside parts';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const short = (path) => path.split('/').slice(-2).join('/');

/* ---------------- used by the x-ray and the code drawer ---------------- */
// The reviewed function at a head location (the innermost one), or null outside review mode.
export function reviewFn(file, line) {
  if (!R.data || !R.on) return null;
  return R.data.functions.filter((f) => f.file === file && f.head && line >= f.head.start && line <= f.head.end)
    .sort((a, b) => (a.head.end - a.head.start) - (b.head.end - b.head.start))[0] || null;
}

// Query suffix for /api/xray in review mode: the base's version, or the selected head's while the map shows another
// version (otherwise the shown tree already is the head). The server knows the selection.
export const xrayRev = (side) => (!R.data || !R.on ? '' : side === 'base' ? '&rev=base' : R.map?.shown === false ? '&rev=head' : '');

function loadDiff(file) {
  if (!R.diffs.has(file)) R.diffs.set(file, getJSON(`/api/diff?file=${encodeURIComponent(file)}`).catch((e) => { R.diffs.delete(file); throw e; }));
  return R.diffs.get(file);
}
export const diffOps = (file) => loadDiff(file).then((d) => d.ops);

/* ---------------- merged x-ray: head plus base ghosts ----------------
   Every node gets rv: 'add' | 'del' | 'chg' | undefined. A base node pairs with a head node of the same kind when its line
   maps to that head line with the same text (unchanged), when a change record names both lines (changed), or when both
   sit in the same changed stretch of lines (changed). Unpaired head nodes on added lines are new; unpaired base nodes on
   removed lines come back as ghost subtrees, placed where their lines were. Each change attaches to the node it is about. */
const KIND_OF = { condition: 'decision', error_check: 'decision', gate: 'decision', return: 'return', throw: 'throw', effect: 'effect', call: 'call', loop: 'loop', signature: 'entry' };

export function mergeXray(head, base, fn, ops) {
  const nodes = head.nodes.map((n) => ({ ...n, changes: [] })), tree = JSON.parse(JSON.stringify(head.tree));
  if (fn.status === 'added' || !ops) {
    if (fn.status === 'added') for (const n of nodes) n.rv = 'add';
    attach(nodes, fn, new Map());
    return { ...head, nodes, tree };
  }
  const b2h = new Map(), at = new Map(), gapB = new Map(), gapH = new Map(), addH = new Set(), delB = new Set();
  let last = 0, gap = 0;
  for (const [o, b, h] of ops) {
    if (o === '=') { b2h.set(b, h); last = h; gap++; }
    else if (o === '+') { last = h; gapH.set(h, gap); addH.add(h); }
    else { at.set(b, last + 0.5); gapB.set(b, gap); delB.add(b); }
  }
  const pair = new Map(), used = new Set(), mark = (b, h) => { pair.set(b.id, h); used.add(h); if (h.text !== b.text) { h.rv = 'chg'; h.old = b.text; h.view = inline(b.text, h.text); } h.baseLine = b.line; };
  const free = (n) => !used.has(n);
  if (base) {
    for (const b of base.nodes) {
      const h = nodes.find((n) => free(n) && n.kind === b.kind && (b.kind === 'entry' || b.kind === 'exit' || (n.text === b.text && b2h.get(b.line) === n.line)));
      if (h) mark(b, h);
    }
    for (const c of fn.changes) {
      if (!c.base_line || !c.head_line) continue;
      const b = base.nodes.find((x) => !pair.has(x.id) && x.line === c.base_line && (!KIND_OF[c.kind] || x.kind === KIND_OF[c.kind]));
      const h = b && nodes.find((n) => free(n) && n.line === c.head_line && n.kind === b.kind);
      if (h) mark(b, h);
    }
    for (const b of base.nodes) {
      if (pair.has(b.id) || !gapB.has(b.line)) continue;
      const h = nodes.find((n) => free(n) && n.kind === b.kind && gapH.get(n.line) === gapB.get(b.line));
      if (h) mark(b, h);
    }
  }
  for (const n of nodes) if (free(n) && addH.has(n.line) && n.kind !== 'exit') n.rv = 'add';
  // ghosts: base subtrees whose header was removed, re-keyed "b:<id>"
  const ghosts = new Map();
  if (base) for (const b of base.nodes) if (!pair.has(b.id) && delB.has(b.line)) ghosts.set(b.id, { ...b, id: 'b:' + b.id, rv: 'del', baseLine: b.line, at: at.get(b.line), changes: [] });
  nodes.push(...ghosts.values());
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const lineOf = (id) => byId[id]?.at ?? byId[id]?.line ?? 0;
  const ghostOf = (item) => {
    if (typeof item === 'string') return ghosts.has(item) ? 'b:' + item : null;
    const hd = headOf(item);
    if (hd != null && !ghosts.has(hd)) return null;
    const blk = (b) => (b ? { seq: (b.seq || []).map(ghostOf).filter(Boolean) } : b);
    if ('if' in item) return { if: 'b:' + hd, then: blk(item.then), else: blk(item.else) };
    if ('loop' in item) return { loop: 'b:' + hd, body: blk(item.body) };
    if ('switch' in item) return { switch: 'b:' + hd, cases: item.cases.map((c) => ({ label: c.label, body: blk(c.body) })) };
    if ('try' in item) return { try: 'b:' + hd, body: blk(item.body), catch: blk(item.catch), finally: blk(item.finally) };
    return null;
  };
  const walk = (block) => {
    for (const item of block?.seq || []) {
      const g = ghostOf(item);
      if (g) place(tree, g, lineOf(headOf(g)), lineOf);
      else if (typeof item !== 'string') blocksOf(item).forEach(walk);
    }
  };
  if (base) walk(base.tree);
  attach(nodes, fn, b2h);
  return { ...head, nodes, tree };
}

// Put a ghost item into the innermost head block whose lines surround pos, before the first item that starts after it.
function place(block, item, pos, lineOf) {
  for (const x of block.seq) {
    if (typeof x === 'string') continue;
    const ls = itemIds(x).map(lineOf).filter(Boolean);
    if (!(pos > Math.min(...ls) && pos < Math.max(...ls))) continue;
    const inner = blocksOf(x).find((k) => { const l = (k.seq || []).flatMap((y) => itemIds(y)).map(lineOf).filter(Boolean); return l.length && pos >= Math.min(...l) - 0.5 && pos <= Math.max(...l) + 0.5; });
    if (inner) return place(inner, item, pos, lineOf);
  }
  const i = block.seq.findIndex((x) => lineOf(headOf(x)) > pos);
  block.seq.splice(i < 0 ? block.seq.length : i, 0, item);
}

// Each change goes to the node on its line (of the matching kind), else the closest step above it.
function attach(nodes, fn, b2h) {
  fn.changes.forEach((c, ci) => {
    const want = KIND_OF[c.kind], heads = nodes.filter((n) => n.rv !== 'del' && n.kind !== 'exit');
    let n = null;
    if (c.head_line) n = heads.find((x) => x.line === c.head_line && (!want || x.kind === want)) || heads.find((x) => x.line === c.head_line)
      || heads.filter((x) => x.line <= c.head_line).sort((a, b) => b.line - a.line)[0];
    else if (c.base_line) {
      const gs = nodes.filter((x) => x.rv === 'del');
      n = gs.find((x) => x.baseLine === c.base_line && (!want || x.kind === want)) || gs.find((x) => x.baseLine === c.base_line)
        || nodes.filter((x) => x.baseLine && x.baseLine <= c.base_line).sort((a, b) => b.baseLine - a.baseLine)[0]
        || heads.find((x) => b2h.has(c.base_line) && x.line === b2h.get(c.base_line));
    }
    (n || nodes[0])?.changes.push(ci);
  });
}

// "old → new" inline: the shared start and end stay plain, the differing middle is struck through and then highlighted.
function inline(a, b) {
  const ta = a.match(/\w+|\s+|[^\w\s]+/g) || [], tb = b.match(/\w+|\s+|[^\w\s]+/g) || [];
  let p = 0; while (p < ta.length && p < tb.length && ta[p] === tb[p]) p++;
  let s = 0; while (s < ta.length - p && s < tb.length - p && ta[ta.length - 1 - s] === tb[tb.length - 1 - s]) s++;
  const pre = ta.slice(0, p).join(''), del = ta.slice(p, ta.length - s).join(''), ins = tb.slice(p, tb.length - s).join(''), post = tb.slice(tb.length - s).join('');
  return { text: `${pre}${del} ${ins}${post}`, html: `${esc(pre)}${del ? `<del>${esc(del)}</del>` : ''}${ins ? `<ins>${esc(ins)}</ins>` : ''}${esc(post)}` };
}

/* ---------------- code drawer: Diff view ---------------- */
// drawer.js asks this for a file it opens: the diff's HTML for a changed file with Diff on, else null (plain code).
async function diffHtml(path) {
  const file = R.data && R.on ? R.data.files.find((f) => f.path === path) : null;
  const sw = $('#dview');
  sw.hidden = !file;
  if (!file) return null;
  sw.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'diff') === R.diffOn));
  if (!R.diffOn) return null;
  let d;
  try { d = await loadDiff(path); } catch { return `<div class="state error"><b>Couldn’t load the diff</b>${esc(path)}</div>`; }
  const hb = d.base ? highlightLines(d.base, path) : [], hh = d.head ? highlightLines(d.head, path) : [];
  const rows = [];
  let prev = '=';
  for (const [o, b, h] of d.ops) {
    if (o !== '=' && prev === '=') rows.push(`<div class="d-hunk">${I.chevD}${o === '-' ? `base ${b}` : `line ${h}`}</div>`);
    prev = o;
    if (o === '=') rows.push(`<div class="cl" data-n="${h}"><i>${h}</i><b class="dg"></b><span class="t">${hh[h - 1] || ' '}</span></div>`);
    else if (o === '+') rows.push(`<div class="cl d-add" data-n="${h}"><i>${h}</i><b class="dg">+</b><span class="t">${hh[h - 1] || ' '}</span></div>`);
    else rows.push(`<div class="cl d-del" data-b="${b}"><i>${b}</i><b class="dg">−</b><span class="t">${hb[b - 1] || ' '}</span></div>`);
  }
  return `<div class="d-diff">${rows.join('')}</div>`;
}

// Open a change in the drawer: its head line, or (a removed line) its base line in the diff.
export async function openChangeLine(file, headLine, baseLine) {
  await openFile(file, headLine || 0);
  if (headLine || !baseLine) return;
  const el = dcode.querySelector(`.cl[data-b="${baseLine}"]`);
  if (!el) return;
  dcode.querySelector('.cl.on')?.classList.remove('on');
  el.classList.add('on'); el.scrollIntoView({ block: 'center' });
}

/* ---------------- loading ---------------- */
// The server's current review; with none selected yet, the checkout (with its uncommitted changes) is reviewed.
async function loadReview() {
  R.busy = 'load'; R.error = ''; R.want = null; render();
  let j;
  try { j = await getJSON('/api/review'); } catch { R.busy = null; R.error = 'The server did not answer.'; return render(); }
  R.busy = null;
  if (j.status === 'none') return selectHead('');
  if (j.status !== 'ready') { R.error = j.error || 'The review could not be built.'; return render(); }
  setReview(j, '');
}

// Review a branch or revision ("<name>"), a pull request ("pr:<N>") or the checkout (""); cancellable.
async function selectHead(head, base = '') {
  R.ctl?.abort();
  const ctl = R.ctl = new AbortController();
  R.want = [head, base];   // what Retry asks for again
  R.busy = { h: head }; R.error = ''; closePicker(); render();
  try {
    const j = await postJSON('/api/review/select', base ? { head: head || null, base } : { head: head || null }, { signal: ctl.signal });
    if (R.ctl !== ctl) return;
    R.busy = null; R.ctl = null;
    setReview(j, head, base);
  } catch (e) {
    if (R.ctl !== ctl) return;
    R.busy = null; R.ctl = null;
    if (e.name !== 'AbortError') R.error = `Couldn’t load ${headLabel(head)}: ${e.message}`;
    render();
  }
}
const headLabel = (h) => (!h ? 'the working copy' : h.startsWith('pr:') ? `PR #${h.slice(3)}` : h);

function setReview(j, head, base = '') {
  stopTour();
  R.data = j; R.head = head; R.base = base; R.diffs.clear(); R.narr = null; R.narrNote = ''; R.map = null;
  Object.assign(R, reading(j), { more: false, md: null, mmdSrc: [], mmd: new Map(), edge: null, analysed: new Set(j.functions.map((f) => f.file)),
    dups: new Set(j.functions.map((f) => f.name).filter((n, i, a) => a.indexOf(n) !== i)) });   // same-named functions show their folder
  R.rows = [...R.order.map(fnById).filter((f) => !isNew(f)), ...R.order.map(fnById).filter(isNew)];
  try { R.done = new Set(JSON.parse(localStorage.getItem('ariadne.reviewed.' + j.head?.rev) || '[]')); } catch { R.done = new Set(); }
  const hash = head ? `#review=${head.startsWith('pr:') ? head : 'branch:' + head}${base ? '&base=' + encodeURIComponent(base) : ''}` : '#review';
  if (location.hash !== hash) history.replaceState(history.state, '', hash);   // keeps back/forward's entry (nav.js)
  showPanel(true);
  markReview(Object.fromEntries(j.parts.filter((p) => RISK_COLOR[p.risk]).map((p) => [p.id, RISK_COLOR[p.risk]])));
  R.cur = R.rows[0]?.id || null; R.shownCur = undefined;
  if (j.functions.length) showFlow(j, { cur: R.cur, done: R.done }); else hideFlow();   // the new flow is the first view
  render();
  restOn(j.parts.map((p) => p.id).filter((id) => parts.has(id)));
  loadMapStatus();
  state.reviewFiles = j.files; markTree();
  reloadFile();   // a changed file shows as its diff, or as plain code again
}

// While reviewing, the map rests on the PR's parts: the rest fades as with a selection, and Esc comes back here (scene.js
// setEmphasis). The camera frames them once, unless a camera saved across a re-map reload came back.
function restOn(ids) {
  state.restEmph = ids?.length ? ids : null;
  if (!state.selected && !player.on) setEmphasis(null);
  state.redraw = true;
  if (!state.restEmph || R.camKept) { R.camKept = false; return; }
  const ps = ids.map((id) => parts.get(id));
  if (ps.length === 1) return flyToEnt({ type: 'part', id: ids[0] });
  const c = ps.reduce((a, p) => a.add(p.pos), new V3()).divideScalar(ps.length);
  flyTo(c, clamp(Math.max(...ps.map((p) => c.distanceTo(p.pos) + p.r)) * 2.8, 40, state.overviewDist * 1.2));
}

// Review mode on or off. While on, the panel can be hidden: the diff view, map rings and x-ray marks stay.
function showPanel(on) {
  R.on = on;
  if (!on) { markReview(null); stopTour(); blast(null); hideFlow(); restOn(null); $('#dview').hidden = true; }
  hidePanel(false);
}

function hidePanel(hide) {
  panel.hidden = !R.on || hide;
  document.body.classList.toggle('review-on', !panel.hidden);   // the panel takes the top-left panel's place
  const b = $('#rvbtn');
  b.hidden = !panel.hidden;
  b.innerHTML = R.on ? `${I.branch}Review · ${esc(R.head ? headLabel(R.head) : 'working copy')}` : 'Review a branch…';
  b.title = R.on ? 'Show the review panel' : 'Review a branch or pull request';
  $('#rvexit').hidden = !(R.on && hide);
  if (!panel.hidden && R.data) render();
}

function exitReview() {
  R.ctl?.abort();
  showPanel(false);
  history.replaceState(history.state, '', location.pathname + location.search);
  state.reviewFiles = null; markTree();
  reloadFile();
}

/* ---------------- the panel ----------------
   In the reviewer's order: what the PR is for, changes to existing behaviour (riskiest), the new code in reading order
   (call depth as indent), then data, config and deploy, tests and generated files, each a quiet collapsible section. */
const isNew = (f) => f.status === 'added';

// Reading order (the flow's, else the server's list) and, walking calls from the flow's roots, each function's depth
// and the call that first reaches it (its condition shows on hover).
function reading(d) {
  const ids = new Set(d.functions.map((f) => f.id)), depth = new Map(), via = new Map();
  const walk = (id, k) => { if (depth.has(id)) return; depth.set(id, k); for (const c of fnById(id)?.calls || []) { if (!depth.has(c.to)) via.set(c.to, c); walk(c.to, k + 1); } };
  for (const r of d.flow?.roots || []) walk(r, 0);
  const order = (d.flow?.order || d.functions.map((f) => f.id)).filter((id) => ids.has(id));
  return { order, depth, via };
}

const dot = (risk) => `<span class="rv-dot ${esc(risk)}" title="${esc(risk)} risk"></span>`;

// Change chips, riskiest first; repeats of one change fold into one chip (×n). With max, the rest is a count.
function chips(f, keep = () => true, max = Infinity) {
  const by = new Map();
  f.changes.forEach((c, ci) => { if (keep(c)) by.has(c.why) ? by.get(c.why).n++ : by.set(c.why, { c, ci, n: 1 }); });
  const all = [...by.values()].sort((a, b) => RANK[b.c.severity] - RANK[a.c.severity]), rest = all.length - max;
  return all.slice(0, max).map(({ c, ci, n }) => `<button class="rv-chip ${esc(c.severity)}${/invert/i.test(c.why) ? ' inv' : ''}" data-ci="${ci}" title="${esc([c.why, c.before && `before: ${c.before}`, c.after && `after: ${c.after}`, c.target && `target: ${c.target}`].filter(Boolean).join('\n'))}">${esc(c.why)}${n > 1 ? ` <em>×${n}</em>` : ''}</button>`).join('')
    + (rest > 0 ? `<span class="rv-chip-more" title="Open it to see every change">+${rest} more</span>` : '');
}

// "writes orders · calls payments": what the function touches, by operation.
function effectText(f) {
  const by = new Map();
  for (const e of f.effects || []) by.set(e.op, new Set([...(by.get(e.op) || []), e.target]));
  return [...by].map(([op, ts]) => `${op} ${[...ts].join(', ')}`).join(' · ');
}

// Long names break at camelCase humps and separators, not mid-word.
const wrapName = (s) => esc(s).replace(/([._/])/g, '$1<wbr>').replace(/([a-z0-9])([A-Z])/g, '$1<wbr>$2');
// A file: its name, then its folder (the last two levels, muted), so same-named files tell apart.
const fileRow = (f, icon = I.file) => `<button class="rv-frow" data-file="${esc(f.path)}" title="${esc(f.path)}">${icon}<span>${esc(f.path.split('/').pop())}</span><em>${esc(f.path.split('/').slice(-3, -1).join('/'))}</em>${f.added != null ? `<small>+${f.added} −${f.removed}</small>` : ''}</button>`;
const names = (ids) => ids.map((id) => fnById(id)?.name || id.split('::').pop());

// A row: name, summary, effects. A changed function adds its riskiest change chips and who reaches it; new code is
// indented by call depth and keeps only chips that matter (medium and high, not already said by its effects).
function rowHtml(f) {
  const on = f.id === R.cur, done = R.done.has(f.id), fresh = isNew(f), fx = effectText(f), b = f.blast || { entries: [], callers: [] };
  const said = new Set((f.effects || []).map((e) => `${e.op} ${e.target}`.toLowerCase()));
  const ch = chips(f, fresh ? (c) => RANK[c.severity] > 1 && !said.has(c.why.toLowerCase()) : undefined, 3);
  const call = R.via.get(f.id), when = call && [call.loop, call.when && `when ${call.when}`].filter(Boolean).join(', ');
  const who = !fresh && (b.callers.length || b.entries.length) ? `<div class="rv-who">${I.inArrow}${b.callers.length ? `called by ${esc(b.callers.slice(0, 4).join(', '))}${b.callers.length > 4 ? ` +${b.callers.length - 4}` : ''}` : ''}${b.entries.length ? `${b.callers.length ? ' · ' : ''}reached from ${esc(b.entries.map((x) => x.label).join(', '))}` : ''}</div>` : '';
  return `<div class="rv-row${on ? ' cur' : ''}${done ? ' done' : ''}" data-id="${esc(f.id)}"${fresh ? ` style="--d:${Math.min(R.depth.get(f.id) || 0, 4)}"` : ''}${when ? ` title="${esc(`Called ${when}`)}"` : ''}>
    <label class="rv-ck" title="Reviewed (r)"><input type="checkbox"${done ? ' checked' : ''}><i></i></label>
    <div class="rv-main"><div class="rv-nmrow"><button class="rv-nm" title="${esc(f.file)}${f.head ? ':' + f.head.start : ''}">${wrapName(f.name)}</button>${R.dups.has(f.name) ? `<span class="rv-in">${esc(f.file.split('/').slice(-2, -1)[0] || '')}</span>` : ''}${STATUS[f.status] && !fresh ? `<span class="rv-st ${esc(f.status)}">${STATUS[f.status]}</span>` : ''}</div>
    ${f.summary ? `<div class="rv-sum" title="${esc(f.summary)}">${esc(f.summary)}</div>` : ''}${fx ? `<div class="rv-fx" title="${esc(fx)}">${esc(fx)}</div>` : ''}${who}${ch ? `<div class="rv-chips">${ch}</div>` : ''}</div></div>`;
}

// A quiet collapsible section; its open state survives re-renders (R.open, kept by the toggle listener).
function sec(id, title, count, body, open = false) {
  if (!body) return '';
  return `<details class="rv-sec" data-sec="${id}"${R.open[id] ?? open ? ' open' : ''}><summary>${I.chevR}<span>${title}</span>${count ? `<em>${count}</em>` : ''}</summary><div class="rv-body">${body}</div></details>`;
}

/* ---------------- the PR description: a small safe markdown renderer ----------------
   Everything is escaped; headings, paragraphs, lists, quotes, code, inline code, links (http only) and bold are
   rebuilt. ```mermaid blocks become diagrams once mermaid (loaded only for them) draws them, else stay code. */
function inl(s) {
  const code = [];
  return esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^\[( |x)\] /i, (_, x) => (x === ' ' ? '☐ ' : '☑ '))
    .replace(/\u0000(\d+)\u0000/g, (_, k) => `<code>${code[k]}</code>`);
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)/, BLOCK = /^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/;
function md(src) {
  const out = [], ls = src.split('\n');
  for (let i = 0; i < ls.length;) {
    const l = ls[i]; let m;
    if ((m = /^\s*(```|~~~)\s*([\w-]*)/.exec(l))) {
      const code = []; for (i++; i < ls.length && !ls[i].trim().startsWith(m[1]); i++) code.push(ls[i]);
      i++;
      const c = code.join('\n'), pre = `<pre><code>${esc(c)}</code></pre>`;
      out.push(m[2] === 'mermaid' ? `<div class="rv-mmd" data-k="${R.mmdSrc.push(c) - 1}">${pre}</div>` : pre);
    } else if ((m = /^(#{1,6})\s+(.*)/.exec(l))) { out.push(`<h${m[1].length < 3 ? 4 : 5}>${inl(m[2].replace(/\s#+$/, ''))}</h${m[1].length < 3 ? 4 : 5}>`); i++; }
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; }
    else if (/^\s*>/.test(l)) { const q = []; for (; i < ls.length && /^\s*>/.test(ls[i]); i++) q.push(ls[i].replace(/^\s*>\s?/, '')); out.push(`<blockquote>${md(q.join('\n'))}</blockquote>`); }
    else if ((m = LIST.exec(l))) {
      const ol = /\d/.test(m[2]), items = [];
      for (; i < ls.length && (m = LIST.exec(ls[i]) || (ls[i].trim() && /^\s{2,}/.test(ls[i]) && items.length && [null, '', '', ls[i].trim()])); i++) {
        if (m[2]) items.push([m[1].length >= 2, m[3]]); else items[items.length - 1][1] += ' ' + m[3];
      }
      out.push(`<${ol ? 'ol' : 'ul'}>${items.map(([sub, t]) => `<li${sub ? ' class="sub"' : ''}>${inl(t)}</li>`).join('')}</${ol ? 'ol' : 'ul'}>`);
    } else if (!l.trim()) i++;
    else { const p = []; for (; i < ls.length && ls[i].trim() && (!p.length || !BLOCK.test(ls[i])); i++) p.push(ls[i].trim()); out.push(`<p>${inl(p.join(' '))}</p>`); }
  }
  return out.join('');
}

// The first plain paragraph (a quoted note only if there is nothing else), for the 3-line preview.
function firstPara(src) {
  const blocks = src.split(/\n\s*\n/).map((x) => x.trim()).filter((x) => x && !/^(#|```|~~~|[-*_]{3})/.test(x));
  const b = blocks.find((x) => !x.startsWith('>')) || blocks[0] || '';
  return b.split('\n').map((x) => x.replace(/^\s*>\s?/, '').trim()).join(' ');
}

const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
let mermaidP = null;
// Draw each mermaid block once (cached per review in R.mmd); a failure leaves the code block.
function drawMermaid() {
  for (const el of panel.querySelectorAll('.rv-mmd')) {
    const k = +el.dataset.k, cache = R.mmd;
    if (cache.get(k)) { el.innerHTML = cache.get(k); continue; }
    if (cache.has(k)) continue;   // drawing, or failed
    cache.set(k, null);
    mermaidP ||= import(MERMAID).then(({ default: mm }) => {
      mm.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', fontFamily: 'Inter, system-ui, sans-serif',
        themeVariables: { darkMode: true, background: 'transparent', primaryColor: '#1a1e27', primaryBorderColor: '#5b6272', primaryTextColor: '#f5f7fa', secondaryColor: '#1a1e27',
          tertiaryColor: '#14171e', lineColor: '#8b93a3', textColor: '#c9ced8', edgeLabelBackground: '#14171e', clusterBkg: '#14171e', clusterBorder: '#343a46', fontSize: '13px' } });
      return mm;
    });
    const id = `rvmmd${k}x${Date.now()}`;
    mermaidP.then((mm) => mm.render(id, R.mmdSrc[k])).then(({ svg }) => {
      cache.set(k, svg);
      const at = R.mmd === cache && panel.querySelector(`.rv-mmd[data-k="${k}"]`); if (at) at.innerHTML = svg;
    }, () => { cache.set(k, ''); document.getElementById('d' + id)?.remove(); });
  }
}

function about(d) {
  // (comments out, and a leading "Description"-style heading: the section already says so)
  const body = (d.pr?.body || '').replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').trim().replace(/^#+\s*(description|summary|overview|about)\s*#*\n/i, ''), first = body && firstPara(body);
  const text = !body ? '' : R.more ? `<div class="rv-md">${R.md ||= md(body)}</div><button class="rv-more" data-rv="less">Less</button>`
    : `<div class="rv-md rv-pre">${inl(first)}</div>${body.length > first.length + 4 ? '<button class="rv-more" data-rv="more">More</button>' : ''}`;
  const narr = d.functions.length || d.files.length ? `<button class="rv-more rv-narrbtn" data-rv="narr" ${R.narrBusy ? 'disabled' : ''}>${R.narrBusy ? '<span class="spin"></span>Summarizing…' : I.spark + (R.narr ? 'Summarize again' : 'Summarize the change')}</button>` : '';
  return `${text}${R.narrNote ? `<div class="rv-note">${R.narrNote}</div>` : ''}${narrative()}${narr ? `<div class="rv-abt-acts">${narr}</div>` : ''}`;
}

// A state machine the change's queries implement, as a small left-to-right diagram: states by distance from the start,
// each arrow is the query that moves a row along. Hover names it and its callers; a click shows them below to open.
function lifecycles(list) {
  return (list || []).map((m, mi) => {
    const rank = new Map([[m.start ?? m.transitions[0]?.from, 0]]);
    for (let k = 0; k < m.states.length; k++) for (const t of m.transitions) if (rank.has(t.from) && !rank.has(t.to)) rank.set(t.to, rank.get(t.from) + 1);
    for (const st of m.states) if (!rank.has(st)) rank.set(st, 0);
    const cols = [], W = 104, H = 34, X = (r) => 6 + r * W;
    for (const [st, r] of rank) (cols[r] ||= []).push(st);
    const rows = Math.max(...cols.map((c) => c.length)), height = rows * H + 8, pos = new Map();
    cols.forEach((c, r) => c.forEach((st, i) => pos.set(st, [X(r), 4 + (height - c.length * H) / 2 + i * H])));
    const out = new Set(m.transitions.map((t) => t.from));
    const tone = (st) => (/fail|error|cancel|reject/i.test(st) ? 'bad' : /succe|done|complete|ok/i.test(st) ? 'good' : st === m.start ? 'start' : '');
    const edges = m.transitions.map((t, ti) => {
      if (!pos.has(t.from) || !pos.has(t.to)) return '';
      const [x1, y1] = pos.get(t.from), [x2, y2] = pos.get(t.to), a = x1 + 84, b = x2, by = names(t.by || []);
      return `<path class="rv-le${R.edge === `${mi}:${ti}` ? ' on' : ''}" data-edge="${mi}:${ti}" d="M${a} ${y1 + 13}C${a + 12} ${y1 + 13} ${b - 12} ${y2 + 13} ${b - 3} ${y2 + 13}" marker-end="url(#rvArrow)"><title>${esc(t.via)}${by.length ? `, called by ${esc(by.join(', '))}` : ''}</title></path>`;
    }).join('');
    const nodes = [...pos].map(([st, [x, y]]) => `<g class="rv-ls ${tone(st)}${out.has(st) ? '' : ' end'}"><rect x="${x}" y="${y}" width="84" height="26" rx="13"/><text x="${x + 42}" y="${y + 17}">${esc(st)}</text></g>`).join('');
    const [ei, ti] = (R.edge || '').split(':').map(Number), t = ei === mi && m.transitions[ti];
    const cap = t ? `<div class="rv-lcap"><b>${esc(t.from)} → ${esc(t.to)}</b> by <button class="rv-ref" data-ref="${esc(t.ref)}">${esc(t.via)}</button>${(t.by || []).length ? `, called by ${t.by.map((id) => `<button class="rv-ref" data-fn="${esc(id)}">${esc(names([id])[0])}</button>`).join('')}` : ''}</div>` : '';
    return `<div class="rv-lc"><div class="rv-cap mono">${esc(m.table)}.${esc(m.field)}</div>
      <svg class="rv-life" viewBox="0 0 ${X(cols.length - 1) + 92} ${height}" width="${X(cols.length - 1) + 92}" height="${height}"><defs><marker id="rvArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z"/></marker></defs>${edges}${nodes}</svg>${cap}</div>`;
  }).join('');
}

// Tables, enums, columns and indexes the change adds or drops (from its migrations).
function schema(list) {
  return (list || []).map((x) => `<button class="rv-schema ${esc(x.op)}" data-ref="${esc(x.ref)}" title="${esc(x.ref)}"><span class="k">${x.op === 'removed' ? '−' : '+'} ${esc(x.kind)}</span><b class="mono">${esc(x.name)}</b>${x.detail.length ? `<small>${esc(x.detail.join(' · '))}</small>` : ''}</button>`).join('');
}

const OP = { added: '+', removed: '−', changed: '~' };
// Env keys by file (value muted), flags and env reads the code gained or lost, then deploy, config and dependency files.
function config(d, files) {
  const byFile = new Map();
  for (const c of d.config || []) (byFile.get(c.file) || byFile.set(c.file, []).get(c.file)).push(c);
  const keys = [...byFile].map(([file, cs]) => `${fileRow(d.files.find((f) => f.path === file) || { path: file }, I.env)}
    ${cs.map((c) => `<div class="rv-kv ${esc(c.op)}"><i>${OP[c.op]}</i><b>${esc(c.key)}</b>${c.value != null ? `<small title="${esc(c.value)}">${esc(c.value)}</small>` : ''}</div>`).join('')}`).join('');
  const gates = d.gates.map((g) => `<button class="rv-kv ${esc(g.op)}" data-ref="${esc(g.refs[0] || '')}" title="${esc(`${g.kind} ${g.op}: ${g.refs.join(', ')}`)}"><i>${OP[g.op] || '~'}</i><b>${esc(g.name)}</b><small>${g.kind === 'flag' ? 'flag' : 'read by the code'}</small></button>`).join('');
  return keys + gates + files.filter((f) => !byFile.has(f.path)).map((f) => fileRow(f)).join('');
}

function render() {
  if (!panel || panel.hidden) return;
  const d = R.data;
  const view = d && !R.busy && d.functions.length ? `<div class="seg rv-view"><button data-rv="flow" class="${flowShown() ? 'on' : ''}" title="The new code as a flow">Flow</button><button data-rv="map" class="${flowShown() ? '' : 'on'}" title="The system map">Map</button></div>` : '';
  const head = `<div class="rv-hd"><span class="tag">Review</span>${view}${d && !R.busy && d.functions.length ? `<button class="icon-btn" data-rv="tour" title="Play the review tour, in reading order">${I.play}</button>` : ''}<button class="icon-btn" data-rv="pick" title="Review another branch or pull request">${I.branch}</button><button class="icon-btn rv-x" data-rv="hide" title="Hide the panel (the review stays on)">${I.x}</button></div>`;
  if (R.busy) {
    const sel = R.busy !== 'load', what = sel ? `Loading ${esc(headLabel(R.busy.h))}…` : 'Loading the review…';
    panel.innerHTML = `${head}<div class="rv-busy"><div class="rv-prog"><i></i></div><b>${what}</b><span>Reading the diff and x-raying changed functions.</span>${sel ? '<button class="btn" data-rv="cancel">Cancel</button>' : ''}<div class="skel"><i></i><i></i><i></i></div></div>`;
    return;
  }
  if (!d || R.error) {
    panel.innerHTML = `${head}<div class="rv-state error">${I.info}<b>${d ? 'Couldn’t switch' : 'No review'}</b><span>${esc(R.error || 'Nothing to review yet.')}</span>
      <div class="rv-acts"><button class="btn primary" data-rv="pick">${I.branch}Pick a branch or PR</button><button class="btn" data-rv="retry">${I.replay}Retry</button>${d ? '<button class="btn" data-rv="dismiss">Back to the review</button>' : ''}</div></div>`;
    return;
  }
  const s = d.stats, fx = s.functions, total = d.functions.length, done = d.functions.filter((f) => R.done.has(f.id)).length;
  const pr = d.pr ? `<a class="rv-title" href="${esc(d.pr.url)}" target="_blank" rel="noopener" title="Open on GitHub">${esc(d.pr.title)} <span>#${d.pr.number}</span></a>`
    : `<div class="rv-title">${esc(R.head ? headLabel(R.head) : 'Working copy')}</div>`;
  const revs = `<div class="rv-revs mono"><span title="${esc(d.base.rev)}">${esc(`${d.base.ref} ${d.base.short}`)}</span>${I.outArrow}<span title="${esc(d.head.rev)}">${esc(d.head.short)}${d.head.dirty ? ' + uncommitted' : ''}</span></div>`;
  const stats = total + d.files.length === 0 ? '' : `<div class="rv-stats">${[plural(total, 'function'), fx.added && `${fx.added} new`, fx.modified && `${fx.modified} changed`, fx.removed && `${fx.removed} deleted`, plural(s.files, 'file')].filter(Boolean).map((x) => `<span>${x}</span>`).join(' · ')}${s.high ? ` · <button class="rv-hi" data-rv="high" title="Next high-risk change (])">${s.high} high risk</button>` : ''}</div>`;
  const prog = total ? `<div class="rv-done" title="${done} of ${total} reviewed"><i style="width:${(100 * done / total).toFixed(1)}%"></i></div>` : '';
  if (!R.rows.some((f) => f.id === R.cur)) R.cur = R.rows[0]?.id || null;
  const role = (f) => f.role || (f.test ? 'test' : f.generated ? 'generated' : R.analysed.has(f.path) ? 'code' : 'other');
  const files = (...rs) => d.files.filter((f) => rs.includes(role(f)));
  const changed = R.rows.filter((f) => !isNew(f)), fresh = R.rows.filter(isNew);
  const deploy = files('deploy', 'config', 'deps'), tests = files('test'), gen = files('generated');
  const others = files('code', 'docs', 'other').filter((f) => !R.analysed.has(f.path)), nCfg = (d.config || []).length + d.gates.length + deploy.length;
  const covered = d.functions.some((f) => f.tests) ? d.functions.filter((f) => f.tests?.length).length : -1;
  const body = !total && !d.files.length ? `<div class="rv-state">${I.info}<b>No changes against base</b><span>${esc(d.base.ref)} and this head have the same code.</span></div>`
    : sec('about', 'About', '', about(d), true)
      + sec('changed', 'Changes existing behaviour', changed.length, changed.map(rowHtml).join(''), true)
      + sec('new', 'New code', fresh.length, fresh.map(rowHtml).join(''), true)
      + sec('data', 'Data', (d.lifecycles?.length || 0) + (d.schema?.length || 0), lifecycles(d.lifecycles) + schema(d.schema))
      + sec('config', 'Config & deploy', nCfg, nCfg ? config(d, deploy) : '')
      + sec('other', 'Other files', others.length, others.map((f) => fileRow(f)).join(''))
      + sec('tests', 'Tests & generated', [tests.length && plural(tests.length, 'test'), gen.length && `${gen.length} generated`].filter(Boolean).join(' · '),
        tests.length + gen.length ? `${covered >= 0 ? `<div class="rv-cov">${covered} of ${total} functions are mentioned in tests</div>` : ''}${tests.map((f) => fileRow(f)).join('')}${gen.length ? `<div class="rv-cap">Generated</div>${gen.map((f) => fileRow(f)).join('')}` : ''}` : '');
  const keep = panel.querySelector('.rv-scroll')?.scrollTop || 0;
  panel.innerHTML = `${head}<div class="rv-scroll">
    <div class="rv-pr">${pr}${revs}${stats}${prog}</div>
    ${mapBanner()}${body}</div>
    ${total ? `<div class="rv-keys" title="Keys: j / k move · ↵ open · ] / [ next high risk · r mark reviewed"><span class="rv-step"><button data-rv="prev" title="Previous (k)">${I.chevL}</button><button data-rv="next" title="Next (j)">${I.chevR}</button></span><span>${R.rows.findIndex((f) => f.id === R.cur) + 1} of ${R.rows.length}</span></div>` : ''}`;
  panel.querySelector('.rv-scroll').scrollTop = keep;
  if (R.shownCur !== undefined && R.shownCur !== R.cur) panel.querySelector('.rv-row.cur')?.scrollIntoView({ block: 'nearest' });   // only when the selection moves
  R.shownCur = R.cur;
  if (R.more) drawMermaid();
  if (flowShown()) setFlow({ cur: R.cur, done: R.done });
}

function narrative() {
  const n = R.narr; if (!n) return '';
  return `<div class="rv-narr"><p>${esc(n.summary)}</p>${n.items.length ? `<ul>${n.items.map((it) => `<li>${esc(it.text)}${it.refs.map((r) => `<button class="rv-ref" data-ref="${esc(r)}">${esc(short(r))}</button>`).join('')}</li>`).join('')}</ul>` : ''}
    ${n.mismatches.map((m) => `<div class="rv-warn">${I.info}<span><b>Differs from the PR description:</b> ${esc(m)}</span></div>`).join('')}</div>`;
}

/* ---------------- selection, opening, blast radius ---------------- */
function move(step) {
  if (!R.rows.length) return;
  const i = R.rows.findIndex((f) => f.id === R.cur);
  R.cur = R.rows[clamp(i + step, 0, R.rows.length - 1)].id;
  render(); blast(fnById(R.cur));
}

function nextHigh(step) {
  const hs = R.rows.filter((f) => f.risk === 'high'); if (!hs.length) return;
  const i = R.rows.findIndex((f) => f.id === R.cur);
  const next = step > 0 ? hs.find((f) => R.rows.indexOf(f) > i) || hs[0] : [...hs].reverse().find((f) => R.rows.indexOf(f) < i) || hs[hs.length - 1];
  R.cur = next.id; render(); openFn(next);
}

// Flow or map: the flow canvas over the map, or the map with the review's parts in focus.
function setView(flow) {
  if (flow) showFlow(R.data, { cur: R.cur, done: R.done }); else hideFlow();
  render();
}

function toggleDone(id) {
  const f = fnById(id); if (!f) return;
  R.done.has(id) ? R.done.delete(id) : R.done.add(id);
  try { localStorage.setItem('ariadne.reviewed.' + R.data.head?.rev, JSON.stringify([...R.done])); } catch { /* storage blocked */ }
  render();
}

// The board item of a reviewed function, once its part's metro is built.
function itemOf(f) {
  const S = parts.get(f.part)?.struct; if (!S || !f.head) return null;
  const c = S.items.filter((x) => x.node && x.kind !== 'type' && x.file === f.file && x.name === f.name);
  return c.find((x) => x.line >= f.head.start && x.line <= f.head.end) || c[0] || null;
}

// Open the function's diff in the code drawer at the change (ci; new code: its start, changed code: its first change).
// On the map it also flies to the function's part and opens the Lens x-ray on it, linked; the flow stays put.
function openFn(f, ci = null) {
  R.cur = R.opened = f.id; render(); blast(null);
  const c = ci == null && isNew(f) ? null : f.changes[ci ?? 0], it = f.status !== 'removed' && itemOf(f);
  if (flowShown()) return openChangeLine(f.file, c ? c.head_line : f.head?.start, c ? c.base_line : f.base?.start);
  if (it) {
    const S = it.node.owner.struct;
    if (S.depth < 0.05) { const d = camPos.clone().sub(S.group.position); setFacing(S, Math.atan2(d.x, d.z)); }
    // the Lens already shows this function's x-ray: just move to the change
    if (focusChange(f.id, c ? f.changes.indexOf(c) : -1) && !$('#lens').hidden) return openChangeLine(f.file, c ? c.head_line : f.head?.start, c ? c.base_line : f.base?.start);
    if (it.placed) openLens(it); else flyToBoard(S, it);
    if (!$('#lens').classList.contains('xray')) $('#lens [data-lz="xray"]')?.click();
  } else if (parts.has(f.part)) flyToEnt({ type: 'part', id: f.part });
  openChangeLine(f.file, c ? c.head_line : f.head?.start, c ? c.base_line : f.base?.start);
}

// Hovered or highlighted row: its part and entry parts on the map, its metro entry lines and its callers' stations lit.
function blast(f) {
  if (!f) {
    if (R.blastSaved) { state.emph = R.blastSaved.emph; state.emphLinks = R.blastSaved.links; state.activeKeys = R.blastSaved.keys; R.blastSaved = null; setGateLines(null); recolor(); }
    return;
  }
  if (player.on) return;
  R.blastSaved ||= { emph: state.emph, links: state.emphLinks, keys: state.activeKeys };
  const b = f.blast || { entries: [], callers: [] }, ids = [f.part, ...b.entries.map((e) => e.part)].filter((id) => parts.has(id));
  setEmphasis(ids.length ? ids : null);
  setGateLines(b.entries.map((e) => `${e.part}:${e.line}`));
  const keys = new Set(), S = parts.get(f.part)?.struct, it = itemOf(f);
  if (it) keys.add(it.key);
  if (S) for (const x of S.items) if (x.node && b.callers.includes(x.name)) keys.add(x.key);
  state.activeKeys = keys; recolor();
}

/* ---------------- narrative ---------------- */
async function summarize() {
  const cfg = state.chatCfg || {};
  if (!state.agentList?.length) { R.narrNote = 'No chat agent is available on this server, so there is nothing to summarize with.'; return render(); }
  if (!cfg.picked) { R.narrNote = 'Pick an agent and model first: the summary uses your own model usage. <button class="lnk" data-rv="settings">Choose a model</button>'; render(); return openSettings(); }
  R.narrBusy = true; R.narrNote = ''; render();
  try {
    R.narr = await postJSON('/api/review/narrative', { agent: cfg.agent, model: cfg.model });
  } catch (e) { R.narrNote = `Couldn’t summarize: ${esc(e.message)}`; }
  R.narrBusy = false; render();
}

/* ---------------- map of the reviewed version ----------------
   The 3D map may show another version than the reviewed head. Updating it is a background job on the server; when it
   needs a model it costs time and usage, so it only starts after a confirmation naming the agent, model and estimates.
   Selecting a head whose map was built before switches by itself (no model); either way the page reloads the new map
   when the job is done, keeping the camera and the review. */
async function loadMapStatus() {
  const d = R.data;
  let j; try { j = await getJSON('/api/map/status'); } catch { return; }
  if (R.data !== d) return;
  R.map = j; render();
  if (j.progress && !j.progress.done) return watchMap();
  // Show the change on the map by itself: a quick update always, a small one with the model picked in Settings.
  // A large one (a first map of a big repo) waits for a confirmation instead (confirmRemap).
  const cfg = state.chatCfg || {};
  if (j.current || R.auto === d.head.rev) return;
  if (!j.needs_model || (cfg.picked && j.parts_changed <= AUTO.parts && j.est_tokens[1] <= AUTO.tokens)) { R.auto = d.head.rev; remap(); }
}
const AUTO = { parts: 6, tokens: 1_000_000 };

const range = ([lo, hi] = [0, 0], f = String) => (f(lo) === f(hi) ? f(lo) : `${f(lo)}–${f(hi)}`);
const fmtSecs = (s) => (s < 120 ? `${s} s` : `${Math.round(s / 60)} min`);
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function mapBanner() {
  const m = R.map, p = m?.progress; if (!m) return '';
  if (p && !p.done) {
    const cfg = state.chatCfg || {}, who = m.needs_model && cfg.agent ? ` · ${cfg.agent}${cfg.model ? ` · ${cfg.model}` : ''}` : '';
    const what = { 'checking out': 'Checking out this version', mapping: `Mapping ${(m.parts || []).join(', ')}`, assembling: 'Naming domains and flows', loading: 'Loading the new map' }[p.phase] || 'Preparing';
    return `<div class="rv-banner run"><b>Updating the map for this change</b><div class="rv-bar"><i style="width:${progressPct(m, p).toFixed(1)}%"></i></div><span>${esc(what)}${p.phase === 'mapping' ? ` · ${p.reads || 0} files read` : ''}${esc(who)} · ${fmtSecs(p.elapsed || 0)}</span></div>`;
  }
  if (p?.error || m.error) return `<div class="rv-banner error">${I.info}<div><b>The map update failed.</b><div class="rv-err">${esc(p?.error || m.error)}</div><button class="btn" data-rv="remap">${I.replay}Try again</button></div></div>`;
  if (m.current) return '';
  if (m.needs_model && !state.chatCfg?.picked) return `<div class="rv-banner slim">${I.info}<span>To map this change, <button class="lnk" data-rv="settings">pick a model</button></span></div>`;
  return `<div class="rv-banner slim" title="${m.parts_changed} of ${m.parts_total} parts differ from this version: their summaries and flows may not match the code.">${I.info}<span>The map is from another version</span>
    <button class="btn" data-rv="remap">${m.needs_model ? 'Update…' : 'Update (quick)'}</button></div>`;
}

// Never start anything slow or paid without this confirmation: agent, model, time and token estimate.
function confirmRemap() {
  const m = R.map;
  if (!m.needs_model) return remap();
  const cfg = state.chatCfg || {}, dlg = $('#rvdlg'), ok = state.agentList?.length && cfg.picked;
  dlg.innerHTML = `<h3>Update the map for ${esc(R.data.head?.short || 'this version')}?</h3>
    <p>${m.parts_changed} of ${m.parts_total} parts changed; your agent reads them again and rebuilds their summaries and flows. Unchanged parts come from the cache.</p>
    <dl><dt>Agent</dt><dd>${ok ? `<b>${esc(cfg.agent)}</b> · ${esc(cfg.model || 'default model')}` : '<span class="dim">none picked</span>'} <button class="lnk" data-rv="settings">Change</button></dd>
      <dt>Time</dt><dd>about ${range(m.est_seconds, fmtSecs)}</dd><dt>Usage</dt><dd>roughly ${range(m.est_tokens, fmtTok)} tokens of your ${ok ? `${esc(cfg.agent)} · ${esc(cfg.model || 'default')}` : 'agent'}</dd></dl>
    ${ok ? '' : `<p class="rv-err">${state.agentList?.length ? 'Pick an agent and model in Settings first.' : 'No agent is available on this server.'}</p>`}
    <div class="rv-dlg-acts"><button class="btn" data-rv="dlgno">Cancel</button><button class="btn primary" data-rv="dlgyes" ${ok ? '' : 'disabled'}>Update map</button></div>`;
  dlg.hidden = false; dlg.querySelector(ok ? '[data-rv=dlgyes]' : '[data-rv=dlgno]').focus();
}

async function remap() {
  $('#rvdlg').hidden = true;
  const m = R.map, cfg = state.chatCfg || {};
  m.error = ''; m.progress = { phase: 'starting', done: false, elapsed: 0 }; render();
  try {
    await postJSON('/api/map/refresh', m.needs_model ? { agent: cfg.agent, model: cfg.model } : {});
  } catch (e) { m.progress = null; m.error = e.message; return render(); }
  watchMap();
}

// Poll a running map job; when it is done, reload with the same camera and review (the hash keeps the review).
// Each stage owns a stretch of the bar and eases across it over its usual time, never reaching its end before the
// stage really ends; finished mapping batches push it along too. [start %, end %, usual seconds]
const STAGES = { preparing: [0, 4, 3], 'checking out': [4, 8, 6], mapping: [8, 78, 0], assembling: [78, 96, 45], loading: [96, 100, 4] };
function progressPct(m, p) {
  const [a, b, usual] = STAGES[p.phase] || STAGES.preparing;
  const t = (Date.now() - (m.phaseAt || Date.now())) / 1000, typical = p.phase === 'mapping' ? (m.est_seconds[0] + m.est_seconds[1]) / 2 * 0.7 : usual;
  const f = Math.min(0.95, Math.max(1 - Math.exp(-1.2 * t / Math.max(1, typical)), p.batches?.[1] ? 0.95 * p.batches[0] / p.batches[1] : 0));
  return a + (b - a) * f;
}

async function watchMap() {
  const m = R.map;
  if (m.watching) return;
  m.watching = true;
  for (;;) {
    await new Promise((res) => setTimeout(res, 1000));
    let p; try { p = await getJSON('/api/map/progress'); } catch { continue; }
    if (R.map !== m) return;
    if (p.phase !== m.phase) { m.phase = p.phase; m.phaseAt = Date.now(); }
    m.progress = p; render();
    if (p.error) { m.watching = false; return; }
    if (p.done) break;
  }
  try { sessionStorage.setItem(CAM_KEY, JSON.stringify({ t: controls.target.toArray(), p: camPos.toArray() })); } catch { /* storage blocked */ }
  location.reload();
}

/* ---------------- tour ---------------- */
const tourList = () => R.order.map(fnById);

function playTour() {
  const list = tourList(); if (!list.length) return;
  R.tour = { list, i: 0, playing: voice.on };
  tourBar.hidden = false; document.body.classList.add('rv-touring');
  gotoStop(0);
}

function stopTour() {
  if (!R.tour) return;
  R.tour = null; cancelSpeech(); tourBar.hidden = true; document.body.classList.remove('rv-touring');
}

function gotoStop(i, fromVoice = false) {
  const t = R.tour, f = t.list[i];
  t.i = i;
  openFn(f);
  tourBar.style.right = (drawer.classList.contains('open') ? drawer.offsetWidth + 16 : 16) + 'px';
  tourBar.innerHTML = `<div class="tb-top"><span class="tag">Review tour</span><span class="tb-n">${i + 1}/${t.list.length}</span>${dot(f.risk)}<b class="mono">${esc(f.name)}</b><span class="tb-pt">${esc(partName(f.part))}${STATUS[f.status] ? ` · ${STATUS[f.status]}` : ''}</span>
    <button class="fbb" data-t="prev" title="Previous (←)">${I.back}</button><button class="fbb" data-t="play" title="${voice.ok ? 'Narrate (Space)' : 'Voice is not available in this browser'}" ${voice.ok ? '' : 'disabled'}>${t.playing ? I.pause : I.speaker}</button><button class="fbb" data-t="next" title="Next (→)">${I.fwd}</button><button class="fbb" data-t="stop" title="Stop (Esc)">${I.x}</button></div>
    <div class="tb-cap">${chips(f) || '<span class="dim">No analysed changes</span>'}</div>
    <div class="tb-prog">${t.list.map((x, k) => `<i class="${k === i ? 'on' : k < i ? 'past' : ''}"></i>`).join('')}</div>`;
  if (t.playing && !fromVoice) narrate();
}

function narrate() {
  const t = R.tour;
  const texts = t.list.map((f) => `${spoken(f)}, in ${partName(f.part)}. ${f.changes.map((c) => c.why).join('. ') || 'No analysed changes'}`);
  t.playing = speakFlow(texts, t.i, 1, (k) => { if (R.tour === t) gotoStop(k, true); }, () => { if (R.tour === t) { t.playing = false; tourBar.querySelector('[data-t=play]').innerHTML = I.speaker; } });
}

/* ---------------- branch / PR picker ---------------- */
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!(s >= 0)) return '';
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : s < 86400 * 45 ? `${Math.round(s / 86400)} d ago` : new Date(iso).toLocaleDateString();
};

async function openPicker(fresh = false) {
  const el = $('#rvpick');
  pick ||= { tab: 'prs', q: '', i: 0, data: null, base: R.base };
  pick.base = R.base;
  el.hidden = false;
  renderPicker();
  el.querySelector('input').focus();
  if (fresh || !pick.data || Date.now() - pick.at > 30000) {
    if (fresh) { pick.data = null; renderPicker(); }
    try { pick.data = await getJSON(`/api/branches${fresh ? '?fresh=1' : ''}`); pick.at = Date.now(); pick.err = ''; if (!pick.data.prs) pick.tab = 'branches'; }
    catch { pick.err = 'The server did not answer.'; }
    if (!el.hidden) renderPicker();
  }
}

function closePicker() { $('#rvpick').hidden = true; }

function pickItems() {
  const d = pick.data; if (!d) return [];
  const q = pick.q.trim().toLowerCase(), has = (...s) => !q || s.some((x) => String(x || '').toLowerCase().includes(q));
  if (pick.tab === 'prs') return (d.prs || []).filter((p) => has(p.title, p.number, p.headRefName, p.author?.login)).map((p) => ({ head: 'pr:' + p.number, p }));
  return [...(has('working copy', d.current) ? [{ head: '', wc: true }] : []), ...d.branches.filter((b) => has(b.name)).map((b) => ({ head: b.name, b }))];
}

// Re-rendering keeps the search field focused with its caret, so typing and the keys never lose their place.
function renderPicker() {
  const el = $('#rvpick'), d = pick.data, items = pickItems(), act = document.activeElement;
  const caret = act?.matches?.('#rvpick input') ? act.selectionStart : act === document.body || el.contains(act) ? pick.q.length : -1;
  pick.i = clamp(pick.i, 0, Math.max(0, items.length - 1));
  const list = pick.err ? `<div class="rv-state error"><b>Couldn’t list branches</b><span>${esc(pick.err)}</span></div>`
    : !d ? '<div class="skel"><i></i><i></i><i></i><i></i></div>'
    : pick.tab === 'prs' && !d.prs ? `<div class="rv-state"><b>No pull requests</b><span>${esc(d.prs_error || 'The GitHub CLI (gh) is not available or not signed in.')}</span></div>`
    : !items.length ? `<div class="rv-state"><b>No matches</b></div>`
    : items.map((x, k) => x.wc
      ? `<button class="pk-row${k === pick.i ? ' on' : ''}" data-k="${k}">${I.code}<span class="pk-t"><b>Working copy</b><small class="mono">${esc(d.current)}${d.dirty ? ' + uncommitted changes' : ''}</small></span><em class="cur">checkout</em></button>`
      : x.p
      ? `<button class="pk-row${k === pick.i ? ' on' : ''}" data-k="${k}"><span class="pk-n">#${x.p.number}</span><span class="pk-t"><b>${esc(x.p.title)}</b><small>${esc(x.p.headRefName)} · ${esc(x.p.author?.login || '')} · ${esc(ago(x.p.updatedAt))}</small></span>${x.p.isDraft ? '<em>draft</em>' : ''}</button>`
      : `<button class="pk-row${k === pick.i ? ' on' : ''}" data-k="${k}">${I.branch}<span class="pk-t"><b class="mono">${esc(x.b.name)}</b><small>${x.b.ahead ? `${x.b.ahead} ahead` : 'nothing ahead'}${x.b.behind ? ` · ${x.b.behind} behind` : ''} · ${esc(ago(x.b.updated))}${x.b.remote ? ' · remote' : ''}</small></span>${x.b.name === d.current ? `<em class="cur">current${d.dirty ? ' · uncommitted' : ''}</em>` : ''}</button>`).join('');
  const bases = d ? d.branches.map((b) => `<option value="${esc(b.rev)}"${pick.base === b.rev ? ' selected' : ''}>${esc(b.name)} (${esc(b.short)})</option>`).join('') : '';
  el.innerHTML = `<div class="pk-hd"><h3>Review a branch or pull request</h3><button class="icon-btn" data-pk="fresh" title="Refresh the lists (asks GitHub again)">${I.replay}</button><button class="icon-btn" data-pk="close" title="Close (Esc)">${I.x}</button></div>
    <div class="pk-search">${I.search}<input placeholder="Search ${pick.tab === 'prs' ? 'pull requests' : 'branches'}" value="${esc(pick.q)}" autocomplete="off" spellcheck="false"></div>
    <div class="seg pk-tabs"><button data-tab="prs" class="${pick.tab === 'prs' ? 'on' : ''}">Pull requests${d?.prs ? ` <em>${d.prs.length}</em>` : ''}</button><button data-tab="branches" class="${pick.tab === 'branches' ? 'on' : ''}">Branches${d ? ` <em>${d.branches.length}</em>` : ''}</button></div>
    <div class="pk-list">${list}</div>
    <label class="pk-base">Base<select class="field"><option value="">merge-base with ${esc(d?.default || 'the default branch')}</option>${bases}</select></label>
    <div class="pk-ft"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> review</span><span><kbd>tab</kbd> switch list</span><span><kbd>esc</kbd> close</span></div>`;
  el.querySelector('.pk-row.on')?.scrollIntoView({ block: 'nearest' });
  if (caret >= 0) { const inp = el.querySelector('input'); inp.focus(); inp.setSelectionRange(caret, caret); }
}

/* ---------------- init ---------------- */
export function initReview() {
  document.body.insertAdjacentHTML('beforeend', `<aside id="review" class="hud glass" aria-label="Review" hidden></aside>
    <div id="rvtour" class="hud glass" hidden></div><div id="rvpick" class="hud glass" role="dialog" aria-label="Pick a branch" hidden></div>
    <div id="rvdlg" class="hud glass" role="dialog" aria-label="Confirm" hidden></div><div id="rvzoom" class="hud glass" title="Close (Esc)" hidden></div>`);
  $('#rvzoom').onclick = () => { $('#rvzoom').hidden = true; };   // a description diagram, enlarged
  panel = $('#review'); tourBar = $('#rvtour');
  initFlow({
    onOpen: (id) => { const f = fnById(id); if (f) openFn(f); },
    onMap: (id) => { const f = fnById(id); hideFlow(); if (f) openFn(f); else render(); },
    onClose: () => render(),
  });
  state.diffHtml = diffHtml;
  $('#dview').onclick = (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    R.diffOn = b.dataset.v === 'diff';
    reloadFile();
  };
  $('#rvbtn').onclick = () => R.on ? hidePanel(false) : openPicker();
  $('#rvbtn').insertAdjacentHTML('afterend', `<button id="rvexit" class="icon-btn" title="Leave review mode" hidden>${I.x}</button>`);
  $('#rvexit').onclick = () => exitReview();
  addEventListener('ariadne:model', () => { if (R.on && R.data) loadMapStatus(); });   // a model was just picked: a waiting update can start
  hidePanel(false);   // not reviewing yet: shows the "Review a branch…" button

  panel.addEventListener('click', (e) => {
    const t = e.target, a = t.closest('[data-rv]')?.dataset.rv;
    if (a === 'pick') return openPicker();   // (no event argument: a click is not a refresh)
    if (a === 'hide') return hidePanel(true);
    if (a === 'cancel') { R.ctl?.abort(); R.ctl = null; R.busy = null; return render(); }
    if (a === 'retry') return R.want ? selectHead(...R.want) : loadReview();
    if (a === 'dismiss') { R.error = ''; return render(); }
    if (a === 'flow' || a === 'map') return setView(a === 'flow');
    if (a === 'more' || a === 'less') { R.more = a === 'more'; return render(); }
    if (a === 'high') return nextHigh(1);
    if (a === 'tour') return playTour();
    if (a === 'narr') return summarize();
    if (a === 'settings') return openSettings();
    if (a === 'remap') return confirmRemap();
    if (a === 'prev' || a === 'next') {   // the highlighted row first, if it was never opened
      if (R.opened === R.cur) move(a === 'next' ? 1 : -1);
      return R.cur && openFn(fnById(R.cur));
    }
    const edge = t.closest('[data-edge]'); if (edge) { R.edge = R.edge === edge.dataset.edge ? null : edge.dataset.edge; return render(); }
    const fn = t.closest('[data-fn]'); if (fn) return openFn(fnById(fn.dataset.fn));
    const ref = t.closest('[data-ref]'); if (ref?.dataset.ref) return openCode(ref.dataset.ref);
    const file = t.closest('[data-file]'); if (file) return openFile(file.dataset.file, 0);
    if (t.closest('.rv-mmd svg')) { const z = $('#rvzoom'); z.innerHTML = t.closest('svg').outerHTML; z.hidden = false; return; }
    const row = t.closest('.rv-row'); if (!row) return;
    if (t.closest('.rv-ck')) { if (t.matches('input')) toggleDone(row.dataset.id); return; }
    const f = fnById(row.dataset.id), chip = t.closest('[data-ci]');
    openFn(f, chip ? +chip.dataset.ci : null);
  });
  panel.addEventListener('toggle', (e) => { const k = e.target.dataset?.sec; if (k) R.open[k] = e.target.open; }, true);
  let hov = null;
  panel.addEventListener('mouseover', (e) => { const r = e.target.closest('.rv-row'); if (r?.dataset.id !== hov) { hov = r?.dataset.id || null; blast(hov && fnById(hov)); } });
  panel.addEventListener('mouseleave', () => { hov = null; blast(null); });

  tourBar.addEventListener('click', (e) => {
    const a = e.target.closest('[data-t]')?.dataset.t, t = R.tour; if (!t) return;
    const chip = e.target.closest('[data-ci]'); if (chip) return openFn(t.list[t.i], +chip.dataset.ci);
    if (a === 'stop') stopTour();
    else if (a === 'prev') { cancelSpeech(); t.playing = false; gotoStop(Math.max(0, t.i - 1)); }
    else if (a === 'next') { cancelSpeech(); t.playing = false; gotoStop(Math.min(t.list.length - 1, t.i + 1)); }
    else if (a === 'play') { if (t.playing) { cancelSpeech(); t.playing = false; } else { voice.on = true; narrate(); } e.target.closest('[data-t]').innerHTML = t.playing ? I.pause : I.speaker; }
  });

  const pk = $('#rvpick');
  pk.addEventListener('input', (e) => { if (e.target.matches('input')) { pick.q = e.target.value; pick.i = 0; renderPicker(); } });
  pk.addEventListener('change', (e) => { if (e.target.matches('select')) pick.base = e.target.value; });
  pk.addEventListener('click', (e) => {
    if (e.target.closest('[data-pk=close]')) return closePicker();
    if (e.target.closest('[data-pk=fresh]')) return openPicker(true);
    const tab = e.target.closest('[data-tab]'); if (tab) { pick.tab = tab.dataset.tab; pick.i = 0; return renderPicker(); }
    const row = e.target.closest('[data-k]'); if (row) { const x = pickItems()[+row.dataset.k]; if (x) selectHead(x.head, pick.base); }
  });
  pk.addEventListener('keydown', (e) => {
    if (e.target.matches('select')) return;
    const items = pickItems();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pick.i = clamp(pick.i + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1); renderPicker(); }
    else if (e.key === 'Enter' && items[pick.i]) { e.preventDefault(); selectHead(items[pick.i].head, pick.base); }
    else if (e.key === 'Tab' && !e.shiftKey && e.target.matches('input')) { e.preventDefault(); pick.tab = pick.tab === 'prs' ? 'branches' : 'prs'; pick.i = 0; renderPicker(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
    e.stopPropagation();
  });

  const dlg = $('#rvdlg');
  dlg.addEventListener('click', (e) => {
    const a = e.target.closest('[data-rv]')?.dataset.rv;
    if (a === 'dlgno') dlg.hidden = true; else if (a === 'dlgyes') remap(); else if (a === 'settings') { dlg.hidden = true; openSettings(); }
  });
  dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') { dlg.hidden = true; e.stopPropagation(); } });

  // Review keys, in the capture phase so j/k move the list even while the x-ray has focus (its ↑/↓ still step).
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#rvzoom').hidden) { $('#rvzoom').hidden = true; e.stopPropagation(); return; }
    if (!R.data || panel.hidden || R.busy || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input,textarea,select') || !$('#rvpick').hidden || !$('#rvdlg').hidden || !$('#settings').hidden) return;
    const k = e.key, inXray = !!e.target.closest?.('.xr-view');
    if (R.tour && !player.on && (k === 'ArrowRight' || k === 'ArrowLeft' || k === 'Escape' || k === ' ')) {
      e.preventDefault(); e.stopPropagation();
      tourBar.querySelector(`[data-t=${k === 'ArrowRight' ? 'next' : k === 'ArrowLeft' ? 'prev' : k === 'Escape' ? 'stop' : 'play'}]`)?.click();
      return;
    }
    if (k === 'j' || k === 'k') move(k === 'j' ? 1 : -1);
    else if (k === ']' || k === '[') nextHigh(k === ']' ? 1 : -1);
    else if (k === 'r' && R.cur) toggleDone(R.cur);
    else if (k === 'Enter' && !inXray && !e.target.closest?.('button,a') && R.cur) openFn(fnById(R.cur));
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);

  // A camera saved before a re-map reload comes back.
  try {
    const cam = JSON.parse(sessionStorage.getItem(CAM_KEY) || 'null');
    if (cam) { sessionStorage.removeItem(CAM_KEY); R.camKept = true; fly.on = false; controls.target.fromArray(cam.t); camPos.fromArray(cam.p); state.redraw = true; }
  } catch { /* storage blocked */ }

  // #review loads the server's review, #review=pr:123 / #review=branch:name a chosen one; a review already loaded opens too.
  const m = /(?:^#|&)review(?:=([^&]*))?(?:&base=([^&]*))?/.exec(location.hash);
  if (m?.[1]) { showPanel(true); const h = decodeURIComponent(m[1]); selectHead(h.startsWith('branch:') ? h.slice(7) : h, m[2] ? decodeURIComponent(m[2]) : ''); }
  else if (m) { showPanel(true); loadReview(); }
  else getJSON('/api/review').then((j) => { if (j.status === 'ready') { showPanel(true); loadReview(); } }, () => {});
}
