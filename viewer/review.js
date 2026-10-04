// review.js
// Exports: reviewFn, xrayRev, diffOps, mergeXray, openChangeLine, initReview
// Imports: state: state | board: flyToBoard, openLens, setFacing, setGateLines, spoken | chat: openSettings | drawer: dcode, drawer, getJSON, highlightLines, openFile, postJSON, reloadFile | hud: I, openCode | scene: camPos, controls, fly, flyToEnt, markReview, parts, player, recolor, setEmphasis | util: $, clamp, esc | voice: cancelSpeech, speakFlow, voice | xray: blocksOf, focusChange, headOf, itemIds
// PR review mode (REVIEW.md): the Review panel (PR, stats, narrative, the change list with filters, keys and reviewed
// state), risk on the map, the merged head/base x-ray data, the code drawer's Diff view, the review tour, the branch/PR
// picker and the stale-map banner. Everything shown comes from the server's deterministic review JSON.
import { state } from './state.js';
import { flyToBoard, openLens, setFacing, setGateLines, spoken } from './board.js';
import { dcode, drawer, getJSON, highlightLines, openFile, postJSON, reloadFile } from './drawer.js';
import { openSettings } from './chat.js';
import { I, openCode } from './hud.js';
import { camPos, controls, fly, flyToEnt, markReview, parts, player, recolor, setEmphasis } from './scene.js';
import { $, clamp, esc } from './util.js';
import { cancelSpeech, speakFlow, voice } from './voice.js';
import { blocksOf, focusChange, headOf, itemIds } from './xray.js';

const RANK = { high: 3, medium: 2, low: 1, none: 0 };
const RISK_COLOR = { high: '#ff6b5e', medium: '#f2b04d', low: '#8fd3f0' };
const STATUS = { added: 'new', removed: 'deleted' };
const CAM_KEY = 'ariadne.reviewCam', FILTER_KEY = 'ariadne.reviewFilters';

// data: the review JSON. head: the selected head as the API names it ("<branch>" | "pr:<N>"), '' = the server's own review.
// rows: the visible functions in list order; cur: the highlighted one (its id). done: reviewed function ids.
const R = { data: null, head: '', base: '', rows: [], cur: null, opened: null, on: false, done: new Set(), f: { high: false, hideLow: false, hideTests: true },
  diffs: new Map(), diffOn: true, narr: null, narrBusy: false, narrNote: '', map: null, tour: null, busy: null, error: '', blastSaved: null };
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
  R.busy = 'load'; R.error = ''; render();
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
  try { R.done = new Set(JSON.parse(localStorage.getItem('ariadne.reviewed.' + j.head?.rev) || '[]')); } catch { R.done = new Set(); }
  const hash = head ? `#review=${head.startsWith('pr:') ? head : 'branch:' + head}${base ? '&base=' + encodeURIComponent(base) : ''}` : '#review';
  if (location.hash !== hash) history.replaceState(history.state, '', hash);   // keeps back/forward's entry (nav.js)
  showPanel(true);
  markReview(Object.fromEntries((j.parts || []).filter((p) => RISK_COLOR[p.risk]).map((p) => [p.id, RISK_COLOR[p.risk]])));
  R.cur = null; render();
  loadMapStatus();
  reloadFile();   // a changed file shows as its diff, or as plain code again
}

// Review mode on or off. While on, the panel can be hidden: the diff view, map rings and x-ray marks stay.
function showPanel(on) {
  R.on = on;
  if (!on) { markReview(null); stopTour(); blast(null); $('#dview').hidden = true; }
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
  reloadFile();
}

/* ---------------- the panel ---------------- */
function visible() {
  const fs = R.data.functions.filter((f) => (!R.f.high || f.risk === 'high') && (!R.f.hideLow || RANK[f.risk] > 1));
  const groups = new Map();
  for (const f of fs) { const k = f.part || ''; if (!groups.has(k)) groups.set(k, { id: k, fns: [], files: [] }); groups.get(k).fns.push(f); }
  const analysed = new Set(R.data.functions.map((f) => f.file));
  for (const file of R.data.files) {
    if (analysed.has(file.path) || (R.f.hideTests && (file.test || file.generated)) || R.f.high) continue;
    const k = file.part || ''; if (!groups.has(k)) groups.set(k, { id: k, fns: [], files: [] }); groups.get(k).files.push(file);
  }
  const top = (g) => Math.max(0, ...g.fns.map((f) => RANK[f.risk]));
  for (const g of groups.values()) g.fns.sort((a, b) => RANK[b.risk] - RANK[a.risk] || a.name.localeCompare(b.name));
  return [...groups.values()].sort((a, b) => top(b) - top(a) || partName(a.id).localeCompare(partName(b.id)));
}

const dot = (risk) => `<span class="rv-dot ${esc(risk)}" title="${esc(risk)} risk"></span>`;

function chips(f) {
  return f.changes.map((c, ci) => `<button class="rv-chip ${esc(c.severity)}${/invert/i.test(c.why) ? ' inv' : ''}" data-ci="${ci}" title="${esc([c.why, c.before && `before: ${c.before}`, c.after && `after: ${c.after}`, c.target && `target: ${c.target}`].filter(Boolean).join('\n'))}">${esc(c.why)}</button>`).join('');
}

function rowHtml(f) {
  const on = f.id === R.cur, done = R.done.has(f.id), e = f.blast?.entries || [], callers = f.blast?.callers || [];
  return `<div class="rv-row${on ? ' cur' : ''}${done ? ' done' : ''}" data-id="${esc(f.id)}">
    <label class="rv-ck" title="Reviewed (r)"><input type="checkbox"${done ? ' checked' : ''}><i></i></label>
    <div class="rv-main"><div class="rv-nmrow">${dot(f.risk)}<button class="rv-nm" title="${esc(f.file)}${f.head ? ':' + f.head.start : ''}">${esc(f.name)}</button>${STATUS[f.status] ? `<span class="rv-st ${esc(f.status)}">${STATUS[f.status]}</span>` : ''}<span class="rv-file">${esc(short(f.file))}</span></div>
    <div class="rv-chips">${chips(f)}</div>
    ${on && (e.length || callers.length) ? `<div class="rv-blast">${e.length ? `<span>${I.entry}${e.map((x) => esc(x.label)).join(', ')}</span>` : ''}${callers.length ? `<span>${I.inArrow}called by ${esc(callers.slice(0, 4).join(', '))}${callers.length > 4 ? ` +${callers.length - 4}` : ''}</span>` : ''}</div>` : ''}</div></div>`;
}

function render() {
  if (!panel || panel.hidden) return;
  const d = R.data;
  const head = `<div class="rv-hd"><span class="tag">Review</span><button class="btn rv-pickbtn" data-rv="pick" title="Review another branch or pull request">${I.branch}${d ? 'Switch' : 'Pick branch'}</button><button class="icon-btn rv-x" data-rv="hide" title="Hide the panel (the review stays on)">${I.x}</button></div>`;
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
  const s = d.stats || {}, fx = s.functions || {}, total = d.functions.length, done = d.functions.filter((f) => R.done.has(f.id)).length;
  const pr = d.pr ? `<a class="rv-title" href="${esc(d.pr.url)}" target="_blank" rel="noopener" title="Open on GitHub">${esc(d.pr.title)} <span>#${d.pr.number}</span></a>`
    : `<div class="rv-title">${esc(R.head ? headLabel(R.head) : d.head?.ref && !/^[0-9a-f]{40}$/.test(d.head.ref) ? d.head.ref : 'Working copy')}</div>`;
  const revs = `<div class="rv-revs mono"><span title="${esc(d.base?.rev || '')}">${esc(d.base?.ref ? `${d.base.ref} ` : '')}${esc(d.base?.short || '?')}</span>${I.outArrow}<span title="${esc(d.head?.rev || '')}">${esc(d.head?.short || '?')}${d.head?.dirty ? ' + uncommitted' : ''}</span></div>`;
  const stats = `<div class="rv-stats"><span><b>${s.files ?? d.files.length}</b> files</span><span><b>${(fx.added || 0) + (fx.removed || 0) + (fx.modified || 0)}</b> functions${fx.added || fx.removed ? ` <em>(${[fx.added && `+${fx.added}`, fx.removed && `−${fx.removed}`].filter(Boolean).join(' ')})</em>` : ''}</span>
    <span class="rv-sev">${['high', 'medium', 'low'].map((k) => `<span class="${k}" title="${k} severity changes">${dot(k)}${s[k] || 0}</span>`).join('')}</span></div>`;
  const gates = (d.gates || []).length ? `<div class="rv-gates">${d.gates.map((g) => `<button class="rv-gate ${esc(g.op)}" data-ref="${esc(g.refs?.[0] || '')}" title="${esc(`${g.kind} ${g.op}: ${(g.refs || []).join(', ')}`)}">${g.kind === 'flag' ? I.flag : I.env}<span>${g.op === 'added' ? '+' : g.op === 'removed' ? '−' : '~'} ${esc(g.name)}</span></button>`).join('')}</div>` : '';
  const empty = !d.functions.length && !d.files.length;
  const groups = empty ? [] : visible();
  R.rows = groups.flatMap((g) => g.fns);
  if (!R.rows.some((f) => f.id === R.cur)) R.cur = R.rows[0]?.id || null;
  const list = empty ? `<div class="rv-state">${I.info}<b>No changes against base</b><span>${esc(d.base?.ref || d.base?.short || 'The base')} and this head have the same code.</span></div>`
    : !groups.length ? `<div class="rv-state"><b>Nothing matches these filters</b><button class="btn" data-rv="clearf">Show all</button></div>`
    : groups.map((g) => `<section class="rv-grp"><h4 data-part="${esc(g.id)}">${g.fns.length ? dot(g.fns[0].risk) : ''}<button title="Show on the map">${esc(partName(g.id))}</button><em>${g.fns.length || plural(g.files.length, 'file')}</em></h4>
        ${g.fns.map(rowHtml).join('')}
        ${g.files.map((f) => `<button class="rv-frow" data-file="${esc(f.path)}" title="${esc(f.path)}">${I.file}<span>${esc(short(f.path))}</span>${f.generated ? '<em>generated</em>' : ''}${f.test ? '<em>test</em>' : ''}<small>+${f.added} −${f.removed}</small></button>`).join('')}</section>`).join('');
  const keep = panel.querySelector('.rv-scroll')?.scrollTop || 0;
  panel.innerHTML = `${head}<div class="rv-scroll">
    <div class="rv-pr">${pr}${revs}${stats}${gates}</div>
    ${mapBanner()}
    <div class="rv-acts">${total ? `<button class="btn primary" data-rv="tour">${I.play}Play review tour</button>` : ''}${empty ? '' : `<button class="btn tinted" data-rv="narr" ${R.narrBusy ? 'disabled' : ''}>${R.narrBusy ? '<span class="spin"></span>Summarizing…' : I.spark + (R.narr ? 'Summarize again' : 'Summarize')}</button>`}</div>
    ${R.narrNote ? `<div class="rv-note">${R.narrNote}</div>` : ''}${narrative()}
    ${total ? `<div class="rv-progress"><div class="rv-bar"><i style="width:${(100 * done) / total}%"></i></div><span><b>${done}/${total}</b> reviewed</span></div>
    <div class="rv-filters" role="group" aria-label="Filters"><button data-f="high" class="${R.f.high ? 'on' : ''}">High only</button><button data-f="hideLow" class="${R.f.hideLow ? 'on' : ''}">Hide low</button><button data-f="hideTests" class="${R.f.hideTests ? 'on' : ''}">Hide tests/generated</button></div>` : ''}
    <div class="rv-list">${list}</div></div>
    <div class="rv-keys">${total ? `<span class="rv-step"><button data-rv="prev" title="Open the previous function (k moves without opening)">${I.chevL}</button><button data-rv="next" title="Open the next function (j moves without opening)">${I.chevR}</button></span>` : '<span><kbd>j</kbd><kbd>k</kbd> move</span>'}<span><kbd>↵</kbd> open</span><span><kbd>]</kbd><kbd>[</kbd> high risk</span><span><kbd>r</kbd> reviewed</span></div>`;
  panel.querySelector('.rv-scroll').scrollTop = keep;
  panel.querySelector('.rv-row.cur')?.scrollIntoView({ block: 'nearest' });
}

function narrative() {
  const n = R.narr; if (!n) return '';
  return `<div class="rv-narr"><p>${esc(n.summary)}</p>${(n.items || []).length ? `<ul>${n.items.map((it) => `<li>${esc(it.text)}${(it.refs || []).map((r) => `<button class="rv-ref" data-ref="${esc(r)}">${esc(short(r))}</button>`).join('')}</li>`).join('')}</ul>` : ''}
    ${(n.mismatches || []).map((m) => `<div class="rv-warn">${I.info}<span><b>Differs from the PR description:</b> ${esc(m)}</span></div>`).join('')}</div>`;
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

// Fly to the function's part and open the Lens x-ray on it, the diff at the change (ci, else the first), linked.
function openFn(f, ci = 0) {
  R.cur = R.opened = f.id; render(); blast(null);
  const c = f.changes[ci] || f.changes[0], it = f.status !== 'removed' && itemOf(f);
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
  if (j.progress && !j.progress.done) watchMap();
}

const range = ([lo, hi] = [0, 0], f = String) => (f(lo) === f(hi) ? f(lo) : `${f(lo)}–${f(hi)}`);
const fmtSecs = (s) => (s < 120 ? `${s} s` : `${Math.round(s / 60)} min`);
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function mapBanner() {
  const m = R.map, p = m?.progress; if (!m) return '';
  if (p && !p.done) {
    const [d, t] = p.batches || [0, 0], pct = t ? Math.max(4, (100 * d) / t) : 4;
    return `<div class="rv-banner run"><b>Updating the map: ${esc(p.phase || 'working')}…</b><div class="rv-bar"><i style="width:${pct}%"></i></div><span>${t ? `${d}/${t} batches · ` : ''}${p.reads || 0} files read · ${fmtSecs(p.elapsed || 0)}</span></div>`;
  }
  if (p?.error || m.error) return `<div class="rv-banner error">${I.info}<div><b>The map update failed.</b><div class="rv-err">${esc(p?.error || m.error)}</div><button class="btn" data-rv="remap">${I.replay}Try again</button></div></div>`;
  if (m.shown) return '';
  return `<div class="rv-banner">${I.info}<div><b>Map shows another version:</b> ${m.parts_changed} of ${m.parts_total} parts differ. Their summaries and flows may not match this code.
    <button class="btn" data-rv="remap">${I.replay}${m.needs_model ? 'Update map…' : 'Update map (quick, no model)'}</button></div></div>`;
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
async function watchMap() {
  const m = R.map;
  if (m.watching) return;
  m.watching = true;
  for (;;) {
    await new Promise((res) => setTimeout(res, 1500));
    let p; try { p = await getJSON('/api/map/progress'); } catch { continue; }
    if (R.map !== m) return;
    m.progress = p; render();
    if (p.error) { m.watching = false; return; }
    if (p.done) break;
  }
  try { sessionStorage.setItem(CAM_KEY, JSON.stringify({ t: controls.target.toArray(), p: camPos.toArray() })); } catch { /* storage blocked */ }
  location.reload();
}

/* ---------------- tour ---------------- */
const tourList = () => (R.data.tour || []).map(fnById).filter(Boolean);

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
    <div id="rvdlg" class="hud glass" role="dialog" aria-label="Confirm" hidden></div>`);
  panel = $('#review'); tourBar = $('#rvtour');
  try { Object.assign(R.f, JSON.parse(localStorage.getItem(FILTER_KEY) || '{}')); } catch { /* storage blocked */ }
  state.diffHtml = diffHtml;
  $('#dview').onclick = (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    R.diffOn = b.dataset.v === 'diff';
    reloadFile();
  };
  $('#rvbtn').onclick = () => R.on ? hidePanel(false) : openPicker();
  $('#rvbtn').insertAdjacentHTML('afterend', `<button id="rvexit" class="icon-btn" title="Leave review mode" hidden>${I.x}</button>`);
  $('#rvexit').onclick = () => exitReview();

  panel.addEventListener('click', (e) => {
    const t = e.target, a = t.closest('[data-rv]')?.dataset.rv;
    if (a === 'pick') return openPicker();   // (no event argument: a click is not a refresh)
    if (a === 'hide') return hidePanel(true);
    if (a === 'cancel') { R.ctl?.abort(); R.ctl = null; R.busy = null; return render(); }
    if (a === 'retry') return R.head ? selectHead(R.head, R.base) : loadReview();
    if (a === 'dismiss') { R.error = ''; return render(); }
    if (a === 'clearf') { Object.assign(R.f, { high: false, hideLow: false, hideTests: false }); return render(); }
    if (a === 'tour') return playTour();
    if (a === 'narr') return summarize();
    if (a === 'settings') return openSettings();
    if (a === 'remap') return confirmRemap();
    if (a === 'prev' || a === 'next') {   // the highlighted row first, if it was never opened
      if (R.opened === R.cur) move(a === 'next' ? 1 : -1);
      return R.cur && openFn(fnById(R.cur));
    }
    const fb = t.closest('[data-f]');
    if (fb) { R.f[fb.dataset.f] = !R.f[fb.dataset.f]; try { localStorage.setItem(FILTER_KEY, JSON.stringify(R.f)); } catch { /* storage blocked */ } return render(); }
    const ref = t.closest('[data-ref]'); if (ref?.dataset.ref) return openCode(ref.dataset.ref);
    const file = t.closest('[data-file]'); if (file) return openFile(file.dataset.file, 0);
    const ph = t.closest('[data-part]'); if (ph && parts.has(ph.dataset.part)) return flyToEnt({ type: 'part', id: ph.dataset.part });
    const row = t.closest('.rv-row'); if (!row) return;
    if (t.closest('.rv-ck')) { if (t.matches('input')) toggleDone(row.dataset.id); return; }
    const f = fnById(row.dataset.id), chip = t.closest('[data-ci]');
    openFn(f, chip ? +chip.dataset.ci : 0);
  });
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
    if (cam) { sessionStorage.removeItem(CAM_KEY); fly.on = false; controls.target.fromArray(cam.t); camPos.fromArray(cam.p); state.redraw = true; }
  } catch { /* storage blocked */ }

  // #review loads the server's review, #review=pr:123 / #review=branch:name a chosen one; a review already loaded opens too.
  const m = /(?:^#|&)review(?:=([^&]*))?(?:&base=([^&]*))?/.exec(location.hash);
  if (m?.[1]) { showPanel(true); const h = decodeURIComponent(m[1]); selectHead(h.startsWith('branch:') ? h.slice(7) : h, m[2] ? decodeURIComponent(m[2]) : ''); }
  else if (m) { showPanel(true); loadReview(); }
  else getJSON('/api/review').then((j) => { if (j.status === 'ready') { showPanel(true); loadReview(); } }, () => {});
}
