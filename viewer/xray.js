// xray.js
// Exports: mountXray, focusChange
// Imports: state: state | drawer: dcode, getJSON, openFile | hud: I | review: diffOps, mergeXray, openChangeLine, reviewFn, xrayRev | scene: exts | theme: EXT, extOf | util: $, clamp, esc
// Function x-ray (XRAY.md): one function as a top-down structured flowchart inside the Lens. The layout is our own and
// deterministic, block by block from the syntax tree: seq stacks, if = decision with yes/no columns that rejoin,
// loop = frame with a back arrow, switch = a row of case columns, try = frame with a catch column, returns/throws = exit pills.
// Long branches collapse to "…", the chart scrolls inside the Lens, an outline shows where you are, and the code drawer's
// cursor and the chart's current step follow each other. In review mode a changed function shows head and base merged
// (review.js): new steps outlined green, removed ones as red ghosts where they were, changed text as old → new.
import { state } from './state.js';
import { dcode, getJSON, openFile } from './drawer.js';
import { I } from './hud.js';
import { diffOps, mergeXray, openChangeLine, reviewFn, xrayRev } from './review.js';
import { exts } from './scene.js';
import { EXT, extOf } from './theme.js';
import { $, clamp, esc } from './util.js';

// Layout grid (px): G between stacked steps, GX between columns, P frame padding, PAD around the chart.
const G = 26, GX = 30, P = 14, RAIL = 18, PAD = 24, CHIP_H = 20, COLLAPSE = 8;
// Node boxes: width clamps, padding, line heights; must match board.css (.xn).
const MINW = 120, MAXW = 320, PADX = 10, PADY = 7, CODE_LH = 16, SMALL_LH = 14, LABEL_LH = 17, HEAD_LH = 18, ICON = 20, TIP = 14;
const F_CODE = '11.5px "JetBrains Mono", monospace', F_SMALL = '10.5px "JetBrains Mono", monospace', F_LABEL = '500 12.5px Inter, sans-serif', F_HEAD = '600 11.5px Inter, sans-serif';
const PILL = new Set(['entry', 'return', 'throw', 'exit']), TERM = new Set(['return', 'throw']), ICONED = new Set(['call', 'effect', 'loop', 'switch', 'try']);

const fetched = new Map();   // "file:line" -> Promise<x-ray>
const labelsOf = new Map();  // "file:start" -> { id: plain-English label }
let X = null;                // the mounted chart
let observer = null, resized = null, measureCtx = null, pending = null;   // pending: { fnId, ci } a change to show once mounted

const textW = (s, font) => { measureCtx.font = font; return measureCtx.measureText(s).width; };

// Lines a sans label wraps to at width w (greedy, like the browser).
function wrapCount(s, font, w) {
  let n = 1, line = 0;
  const space = textW(' ', font);
  for (const word of s.split(/\s+/)) {
    const ww = textW(word, font);
    if (line && line + space + ww > w) { n++; line = ww; } else line += (line ? space : 0) + ww;
  }
  return n;
}

function load(file, line, side = 'head') {
  const k = `/api/xray?file=${encodeURIComponent(file)}&line=${line}${xrayRev(side)}`;
  if (!fetched.has(k)) {
    fetched.set(k, getJSON(k).then((j) => {
      if (j.status !== 'ready' && j.status !== 'unsupported') fetched.delete(k);
      return j;
    }, (e) => {
      fetched.delete(k);   // a failure is not cached: Retry asks again
      return { status: 'error', error: /^404/.test(e.message) ? 'This server has no x-ray yet.' : 'The code server did not answer.' };
    }));
  }
  return fetched.get(k);
}

/* ---------------- mount ---------------- */
// el: the empty x-ray area in the Lens centre card. it: the board item. onCall(node): re-centre the Lens on a call's callee
// (returns false when the callee is not in this part, and the click opens the code instead).
export async function mountXray(el, it, onCall) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  if (!observer) { observer = new MutationObserver(fromDrawer); observer.observe(dcode, { attributes: true, attributeFilter: ['class'], subtree: true }); }
  const me = X = { el, it, onCall, data: null, expanded: new Set(), all: false, cur: null, note: '', busy: false, rv: null, only: false };
  el.innerHTML = `<div class="xr-bar"></div><div class="xr-wrap"><div class="xr-view" tabindex="0" aria-label="Function x-ray"><div class="xr-skel">${'<i></i>'.repeat(7)}</div></div></div>`;
  renderBar();
  let [data] = await Promise.all([load(it.file, it.line), document.fonts.ready]);
  const rv = data.status === 'ready' && reviewFn(it.file, it.line);
  if (rv) {
    const [base, ops] = rv.status === 'modified' ? await Promise.all([load(it.file, rv.base.start, 'base'), diffOps(it.file).catch(() => null)]) : [null, null];
    if (X !== me) return;
    data = mergeXray(data, base?.status === 'ready' ? base : null, rv, ops);
    me.rv = rv; me.only = false;
    if (rv.status === 'modified' && base?.status !== 'ready') me.note = 'The base version could not be x-rayed: changes are marked, removed steps are not shown.';
  }
  if (X !== me) return;
  me.data = data;
  if (data.status !== 'ready') return renderState();
  me.byId = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
  me.fnKey = `${data.fn.file}:${data.fn.start}`;
  me.paths = tracePaths(data.tree);
  renderBar(); renderChart();
  me.view.focus({ preventScroll: true });
  if (!(rv && pending?.fnId === rv.id && showChange(pending.ci))) fromDrawer();   // the drawer may already sit inside this function
}

// Review: show change ci of function fnId in the x-ray (now if it is mounted, else when it is). True when shown now.
export function focusChange(fnId, ci) {
  pending = { fnId, ci };
  return !!(X?.rv?.id === fnId && X.chart?.isConnected && showChange(ci));
}

function showChange(ci) {
  const n = X.data.nodes.find((x) => x.changes?.includes(ci)); if (!n) return false;
  if (X.hidden.has(n.id)) { X.expanded.add(X.hidden.get(n.id)); renderChart(); }
  setCur(n.id, { scroll: false, sync: false });
  X.chart.querySelector('.xn.cur')?.scrollIntoView({ block: 'center', inline: 'center' });
  return true;
}

// unsupported / error: calm, inline, with a way on.
function renderState() {
  const d = X.data, lang = d.fn?.lang || X.it.file.split('.').pop();
  X.el.querySelector('.xr-view').innerHTML = `<div class="xr-state">${I.xray}
    <b>${d.status === 'unsupported' ? `No x-ray for ${esc(lang)} yet` : 'Couldn’t x-ray this function'}</b>
    <span>${esc(d.error || (d.status === 'unsupported' ? 'This language is not supported.' : 'Something went wrong.'))}</span>
    <div class="xr-acts"><button class="btn" data-xa="code">${I.code}Open code</button>${d.status === 'error' ? `<button class="btn" data-xa="retry">${I.replay}Retry</button>` : ''}</div></div>`;
  X.el.querySelector('.xr-bar').innerHTML = '';
  X.el.onclick = (e) => {
    const a = e.target.closest('[data-xa]')?.dataset.xa;
    if (a === 'code') openFile(X.it.file, X.it.line);
    else if (a === 'retry') mountXray(X.el, X.it, X.onCall);
  };
}

function renderBar() {
  const bar = X.el.querySelector('.xr-bar'), d = X.data, ready = d?.status === 'ready';
  const has = ready && labelsOf.has(X.fnKey), n = ready ? d.nodes.length : 0;
  bar.innerHTML = `<button class="btn tinted xr-explain" data-xa="explain" ${ready && !X.busy ? '' : 'disabled'}>${X.busy ? '<span class="spin"></span>Explaining…' : `${I.spark}${has ? 'Explain again' : 'Explain in plain English'}`}</button>
    ${ready && X.rv ? `<button class="btn${X.only ? ' on' : ''}" data-xa="only" aria-pressed="${X.only}" title="Fold steps that did not change">Changes only</button><span class="rv-key"><i class="add"></i>new<i class="del"></i>removed<i class="ch"></i>changed</span>` : ''}
    ${ready && !X.only && hasCollapsible(d.tree) ? `<button class="btn" data-xa="all">${X.all ? 'Collapse long branches' : 'Expand all'}</button>` : ''}
    <span class="xr-meta">${ready ? `${n} steps · lines ${d.fn.start}–${d.fn.end}${d.fn.lang ? ` · ${esc(d.fn.lang)}` : ''}` : ''}</span>
    <span class="xr-keys"><kbd>↑</kbd><kbd>↓</kbd> step <kbd>↵</kbd> open <kbd>x</kbd> close</span>
    ${X.note ? `<div class="xr-note">${X.note}</div>` : ''}`;
}

/* ---------------- tree helpers ---------------- */
const blocksOf = (o) => ('if' in o ? [o.then, o.else] : 'loop' in o ? [o.body] : 'switch' in o ? o.cases.map((c) => c.body) : 'try' in o ? [o.body, o.catch, o.finally] : 'seq' in o ? [o] : []).filter(Boolean);
const headOf = (o) => (typeof o === 'string' ? o : o.if ?? o.loop ?? o.switch ?? o.try ?? null);
function countIds(b) { let n = 0; for (const x of b?.seq || []) n += typeof x === 'string' ? 1 : 1 + blocksOf(x).reduce((a, c) => a + countIds(c), 0); return n; }
function idsIn(b, out = []) { for (const x of b?.seq || []) { const h = headOf(x); if (h) out.push(h); if (typeof x !== 'string') blocksOf(x).forEach((c) => idsIn(c, out)); } return out; }
const itemIds = (x) => (typeof x === 'string' ? [x] : [headOf(x), ...blocksOf(x).flatMap((c) => idsIn(c))].filter(Boolean));
const changed = (id) => !!(X.byId[id]?.rv || X.byId[id]?.changes?.length);
// Changes only: an item with no new, removed or changed step in it (entry and exit always stay)
const quiet = (x) => X.only && !(typeof x === 'string' && /^(entry|exit)$/.test(X.byId[x]?.kind)) && !itemIds(x).some(changed);
function hasCollapsible(b) { return (b.seq || []).some((x) => typeof x !== 'string' && blocksOf(x).some((c) => (countIds(c) > COLLAPSE && countIds(c) <= X.data.nodes.length * 0.6) || hasCollapsible(c))); }
// A block ends the function when its last step returns or throws (or is an if whose both branches do).
function ends(b) {
  const last = b?.seq?.[b.seq.length - 1];
  if (last == null) return false;
  if (typeof last === 'string') return TERM.has(X.byId[last]?.kind);
  if ('if' in last) return !!last.else && ends(last.then) && ends(last.else);
  if ('try' in last) return ends(last.body) && (!last.catch || ends(last.catch));
  return false;
}

// For each step: the steps on its way from the entry (preceding steps of every enclosing sequence and the enclosing headers).
function tracePaths(tree) {
  const paths = new Map();
  const walk = (b, prefix) => {
    const pre = prefix.slice();
    for (const x of b?.seq || []) {
      const h = headOf(x); if (!h) continue;
      paths.set(h, new Set([...pre, h]));
      if (typeof x !== 'string') blocksOf(x).forEach((c) => walk(c, [...pre, h]));
      pre.push(h);
    }
  };
  walk(tree, []);
  return paths;
}

/* ---------------- layout ----------------
   Every block measures to { w, h, ax (its axis, from its left edge), head (first step id), term (ends the function) }
   and draws itself at a given top-left. Sequences line items up on their axes. */
const EMPTY = { w: 0, h: 0, ax: 0, empty: true, term: false, head: null, draw() {} };

function sizeOf(n) {
  const label = X.labels?.[n.id], small = !!label, cf = small ? F_SMALL : F_CODE, clh = small ? SMALL_LH : CODE_LH;
  const lnW = n.line ? Math.ceil(textW(String(n.line), F_SMALL)) + 8 : 0;
  const icon = ICONED.has(n.kind) && n.kind !== 'effect' ? ICON : 0, tips = n.kind === 'decision' ? 2 * TIP : PILL.has(n.kind) ? 8 : 0;   // pills pad 14px a side
  const tw = textW(n.view?.text ?? n.text, cf), headW = n.kind === 'effect' ? ICON + textW(n.target || n.callee || 'outside', F_HEAD) : 0;
  const w = Math.ceil(clamp(Math.max(tw + lnW + icon, headW, label ? textW(label, F_LABEL) : 0) + 2 * PADX + tips + 2, PILL.has(n.kind) ? 56 : MINW, MAXW));
  const inner = w - 2 * PADX - tips;
  const codeLines = Math.min(2, Math.max(1, Math.ceil((tw - 0.5) / (inner - lnW - icon))));
  const labelLines = label ? Math.min(2, wrapCount(label, F_LABEL, inner)) : 0;
  const h = 2 * PADY + codeLines * clh + labelLines * LABEL_LH + (label ? 3 : 0) + (headW ? HEAD_LH : 0);
  return { w, h, lnW, codeLines, labelLines, label };
}

function nodeBox(id) {
  const n = X.byId[id]; if (!n) return null;
  const s = sizeOf(n);
  return { w: s.w, h: s.h, ax: s.w / 2, head: id, term: TERM.has(n.kind), draw: (x, y) => { X.out.nodes.push({ n, x, y, ...s }); X.order.push(id); } };
}

function lay(item, key) {
  if (typeof item === 'string') return nodeBox(item);
  if (!item || typeof item !== 'object') return null;
  if ('if' in item) return ifBox(item, key);
  if ('loop' in item) return loopBox(item, key);
  if ('switch' in item) return switchBox(item, key);
  if ('try' in item) return tryBox(item, key);
  if ('seq' in item) return seqBox(item, key);
  return null;
}

// A branch body: collapsed to one "…" step when long, unless expanded.
function branch(b, key) {
  if (!b?.seq?.length) return EMPTY;
  const n = countIds(b);
  // short branches, and a branch that is most of the function (a body wrapped in one try or loop), stay open
  if (X.expanded.has(key) || (X.only ? !b.seq.every(quiet) : n <= COLLAPSE || n > X.data.nodes.length * 0.6 || X.all)) return seqBox(b, key);
  return moreBox(b, key, n);
}

// One "… N steps" box standing for a block.
function moreBox(b, key, n = countIds(b)) {
  const first = X.byId[headOf(b.seq[0])], text = `${n} step${n === 1 ? '' : 's'}`, w = Math.ceil(clamp(textW(first?.text || '', F_SMALL) + 2 * PADX + 2, 150, 240));
  for (const id of idsIn(b)) X.hidden.set(id, key);
  return { w, h: 44, ax: w / 2, head: null, term: ends(b), draw: (x, y) => { X.out.more.push({ key, x, y, w, h: 44, text, first: first?.text || '', ids: idsIn(b) }); X.order.push('more:' + key); } };
}

function seqBox(b, key) {
  let items = [];
  for (let i = 0; i < b.seq.length; i++) {
    let j = i;
    while (j < b.seq.length && quiet(b.seq[j])) j++;
    if (j - i >= 2 && !X.expanded.has(`${key}~${i}`)) { items.push(moreBox({ seq: b.seq.slice(i, j) }, `${key}~${i}`)); i = j - 1; continue; }
    items.push(lay(b.seq[i], `${key}.${i}`));
  }
  items = items.filter(Boolean);
  if (!items.length) return EMPTY;
  const ax = Math.max(...items.map((i) => i.ax)), right = Math.max(...items.map((i) => i.w - i.ax));
  const h = items.reduce((a, i) => a + i.h, 0) + G * (items.length - 1);
  return {
    w: ax + right, h, ax, head: items[0].head, term: items[items.length - 1].term,
    draw(x, y) {
      const A = x + ax; let cy = y;
      items.forEach((b, i) => {
        if (i && !items[i - 1].term) edge([[A, cy - G], [A, cy]], b.head);
        b.draw(A - b.ax, cy); cy += b.h + G;
      });
    },
  };
}

function ifBox(o, key) {
  const d = nodeBox(o.if); if (!d) return null;
  const T = branch(o.then, key + '.t');
  if (!o.else) {
    if (T.empty) return d;
    // no else: the "no" path runs straight down the axis, the "yes" column hangs to the right and rejoins below
    const off = Math.max(d.w / 2 + 18 - T.ax, 34), right = Math.max(d.w / 2, off + T.w), h = d.h + G + T.h + (T.term ? 0 : G / 2);
    return {
      w: d.w / 2 + right, h, ax: d.w / 2, head: o.if, term: false,
      draw(x, y) {
        const A = x + d.w / 2, my = y + d.h / 2, top = y + d.h + G, cx = A + off + T.ax;
        d.draw(x, y);
        edge([[A + d.w / 2, my], [cx, my], [cx, top]], T.head, { tag: 'yes', arrow: !!T.head });
        T.draw(A + off, top);
        edge([[A, y + d.h], [A, y + h]], null, { tag: 'no', arrow: false });
        if (!T.term) edge([[cx, top + T.h], [cx, y + h], [A, y + h]], null, { arrow: false });
      },
    };
  }
  const E = branch(o.else, key + '.e'), lw = Math.max(T.w, 24), rw = Math.max(E.w, 24);
  const left = Math.max(GX / 2 + lw, d.w / 2), right = Math.max(GX / 2 + rw, d.w / 2);
  const join = !T.term || !E.term, h = d.h + G + Math.max(T.h, E.h) + (join ? G / 2 : 0);
  return {
    w: left + right, h, ax: left, head: o.if, term: !join,
    draw(x, y) {
      const A = x + left, split = y + d.h + G / 2, top = y + d.h + G, jy = y + h;
      const lx = A - GX / 2 - lw + (T.empty ? lw / 2 : T.ax), rx = A + GX / 2 + (E.empty ? rw / 2 : E.ax);
      d.draw(A - d.w / 2, y);
      edge([[A, y + d.h], [A, split], [lx, split], [lx, top]], T.head, { tag: 'yes', arrow: !T.empty });
      edge([[A, y + d.h], [A, split], [rx, split], [rx, top]], E.head, { tag: 'no', arrow: !E.empty });
      T.draw(A - GX / 2 - lw, top); E.draw(A + GX / 2, top);
      if (!T.term) edge([[lx, top + T.h], [lx, jy], [A, jy]], null, { arrow: false });
      if (!E.term) edge([[rx, top + E.h], [rx, jy], [A, jy]], null, { arrow: false });
    },
  };
}

function loopBox(o, key) {
  const hd = nodeBox(o.loop); if (!hd) return null;
  const B = branch(o.body, key + '.b');
  const axIn = Math.max(hd.ax, B.ax), rIn = Math.max(hd.w - hd.ax, B.w - B.ax);
  const w = P + RAIL + axIn + rIn + P, h = P + hd.h + (B.empty ? 0 : G + B.h) + P + 6;
  return {
    w, h, ax: P + RAIL + axIn, head: o.loop, term: false,
    draw(x, y) {
      const A = x + P + RAIL + axIn, hy = y + P + hd.h / 2, rail = x + P + RAIL / 2 - 2;
      X.out.frames.push({ x, y, w, h, kind: 'loop', icon: { x: rail, y: (hy + y + h - P) / 2 } });
      hd.draw(A - hd.w / 2, y + P);
      if (B.empty) return;
      const by = y + P + hd.h + G;
      edge([[A, by - G], [A, by]], B.head);
      B.draw(A - B.ax, by);
      if (!B.term) edge([[A, by + B.h], [A, by + B.h + 9], [rail, by + B.h + 9], [rail, hy], [A - hd.w / 2, hy]], o.loop, { cls: 'back' });
    },
  };
}

function switchBox(o, key) {
  const hd = nodeBox(o.switch); if (!hd) return null;
  const cols = (o.cases || []).map((c, i) => {
    const b = branch(c.body, `${key}.c${i}`), label = String(c.label ?? 'default'), short = label.length > 22 ? label.slice(0, 21) + '…' : label;
    const half = Math.max(textW(short, F_SMALL) / 2 + 9, 22), l = Math.ceil(Math.max(b.ax, half)), r = Math.ceil(Math.max(b.w - b.ax, half));
    return { b, label, short, l, cw: l + r };   // l: the column's axis from its left edge
  });
  if (!cols.length) return hd;
  // the header sits over the first case, so the main path runs straight down; other cases sit to its right
  const total = cols.reduce((a, c) => a + c.cw, 0) + GX * (cols.length - 1), ax = Math.max(cols[0].l, hd.w / 2), right = Math.max(total - cols[0].l, hd.w / 2);
  const join = cols.some((c) => !c.b.term), colsH = Math.max(...cols.map((c) => CHIP_H + 8 + c.b.h));
  const h = hd.h + G + colsH + (join ? G / 2 : 0);
  return {
    w: ax + right, h, ax, head: o.switch, term: !join,
    draw(x, y) {
      const A = x + ax, bus = y + hd.h + G / 2, top = y + hd.h + G, jy = y + h;
      hd.draw(A - hd.w / 2, y);
      let cx0 = A - cols[0].l;
      for (const c of cols) {
        const cx = cx0 + c.l, by = top + CHIP_H + 8;
        edge([[A, y + hd.h], [A, bus], [cx, bus], [cx, top]], c.b.head || o.switch);
        X.out.tags.push({ x: cx, y: top, text: c.short, title: c.label, cls: 'case' });
        if (!c.b.empty) { edge([[cx, top + CHIP_H], [cx, by]], c.b.head, { arrow: false }); c.b.draw(cx - c.b.ax, by); }
        if (!c.b.term) edge([[cx, c.b.empty ? top + CHIP_H : by + c.b.h], [cx, jy], [A, jy]], null, { arrow: false });
        cx0 += c.cw + GX;
      }
    },
  };
}

function tryBox(o, key) {
  const hd = nodeBox(o.try); if (!hd) return null;
  const B = branch(o.body, key + '.b'), C = o.catch ? branch(o.catch, key + '.c') : null, F = o.finally ? branch(o.finally, key + '.f') : null;
  const axIn = Math.max(hd.ax, B.ax, F ? F.ax : 0), rIn = Math.max(hd.w - hd.ax, B.w - B.ax, F ? F.w - F.ax : 0);
  const cw = C ? Math.max(C.w, 64) : 0, cax = C ? (C.empty ? cw / 2 : C.ax + (cw - C.w) / 2) : 0;
  const mainH = hd.h + (B.empty ? 0 : G + B.h), catchH = C ? hd.h + G + CHIP_H + 8 + C.h : 0;
  const midH = Math.max(mainH, catchH) + G / 2, fH = F ? G + CHIP_H + 8 + F.h : 0;
  const w = P + axIn + rIn + (C ? GX + cw : 0) + P, h = P + midH + fH + P;
  return {
    w, h, ax: P + axIn, head: o.try, term: false,
    draw(x, y) {
      const A = x + P + axIn, y0 = y + P, jy = y0 + midH;
      X.out.frames.push({ x, y, w, h, kind: 'try' });
      hd.draw(A - hd.w / 2, y0);
      let bottom = y0 + hd.h;
      if (!B.empty) { edge([[A, bottom], [A, bottom + G]], B.head); B.draw(A - B.ax, bottom + G); bottom += G + B.h; }
      if (!B.term) edge([[A, bottom], [A, jy]], null, { arrow: false });
      if (C) {
        const cl = A + rIn + GX, cx = cl + cax, my = y0 + hd.h / 2, top = y0 + hd.h + G;
        edge([[A + hd.w / 2, my], [cx, my], [cx, top]], C.head, { cls: 'err' });
        X.out.tags.push({ x: cx, y: top, text: 'catch', cls: 'catch' });
        const cy = top + CHIP_H + 8;
        if (!C.empty) { edge([[cx, top + CHIP_H], [cx, cy]], C.head, { arrow: false }); C.draw(cx - C.ax, cy); }
        if (!C.term) edge([[cx, C.empty ? top + CHIP_H : cy + C.h], [cx, jy], [A, jy]], null, { arrow: false });
      }
      if (F) {
        const ft = jy + G;
        edge([[A, jy], [A, ft]], F.head);
        X.out.tags.push({ x: A, y: ft, text: 'finally', cls: 'fin' });
        if (!F.empty) { edge([[A, ft + CHIP_H], [A, ft + CHIP_H + 8]], F.head, { arrow: false }); F.draw(A - F.ax, ft + CHIP_H + 8); }
      }
    },
  };
}

function edge(pts, to, { tag = '', arrow = true, cls = '' } = {}) {
  pts = pts.filter((p, i) => !i || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  if (pts.length < 2) return;
  X.out.edges.push({ pts, to, arrow, cls });
  if (tag) { const [a, b] = pts.slice(-2); X.out.tags.push({ x: a[0] + (a[0] === b[0] ? 6 : 0), y: a[1] + (a[0] === b[0] ? 3 : -15), text: tag, cls: 'yn ' + tag, left: true }); }
}

// Orthogonal polyline with softly rounded corners.
function pathD(pts, r = 7) {
  const f = (v) => +v.toFixed(1);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], [cx, cy] = pts[i + 1];
    const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by), rr = Math.min(r, l1 / 2, l2 / 2);
    d += `L${f(bx - ((bx - ax) / l1) * rr)} ${f(by - ((by - ay) / l1) * rr)}Q${f(bx)} ${f(by)} ${f(bx + ((cx - bx) / l2) * rr)} ${f(by + ((cy - by) / l2) * rr)}`;
  }
  const e = pts[pts.length - 1];
  return d + `L${f(e[0])} ${f(e[1])}`;
}

/* ---------------- render ---------------- */
const effectLook = (n) => {
  const t = (n.target || '').toLowerCase(), e = [...exts.values()].find((x) => x.id.toLowerCase() === t || x.id.toLowerCase().includes(t));
  return EXT[e ? extOf(e) : 'other'];
};

function nodeHtml({ n, x, y, w, h, lnW, codeLines, labelLines, label }) {
  const icon = { call: I.fn, loop: I.replay, switch: I.branch, try: I.shield }[n.kind] || '';
  const fx = n.kind === 'effect' ? effectLook(n) : null;
  const cs = X.rv ? (n.changes || []).map((ci) => X.rv.changes[ci]).sort((a, b) => /invert/i.test(b.why) - /invert/i.test(a.why) || 'hml'.indexOf(a.severity[0]) - 'hml'.indexOf(b.severity[0])) : [];
  const inv = cs[0] && /invert/i.test(cs[0].why);
  const tip = [label, n.old != null ? `was: ${n.old}` : '', n.text, ...cs.map((c) => `• ${c.why}`), n.kind === 'call' && n.callee ? `Click: x-ray of ${n.callee}` : '', n.rv === 'del' ? `removed · base line ${n.baseLine}` : `line ${n.line}`].filter(Boolean).join('\n');
  return `<button class="xn k-${esc(n.kind)}${n.error ? ' err' : ''}${n.rv ? ' rv-' + n.rv : ''}" data-id="${esc(n.id)}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px${fx ? `;--k:${fx.color}` : ''}" title="${esc(tip)}">
    ${label ? `<span class="xl" style="-webkit-line-clamp:${labelLines}">${esc(label)}</span>` : ''}
    ${fx ? `<span class="xt">${fx.icon}${esc(n.target || n.callee || 'outside')}</span>` : ''}
    ${cs.length ? `<span class="rv-bdg ${esc(cs[0].severity)}${inv ? ' inv' : ''}">${inv ? '⇄ ' : ''}${esc(cs[0].why)}${cs.length > 1 ? ` <em>+${cs.length - 1}</em>` : ''}</span>` : ''}
    <span class="xrow${label ? ' small' : ''}">${n.line ? `<i class="ln" style="width:${lnW - 8}px">${n.line}</i>` : ''}${icon}<span class="xc" style="-webkit-line-clamp:${codeLines}">${n.view ? n.view.html : esc(n.text)}</span></span></button>`;
}

function renderChart() {
  const view = X.el.querySelector('.xr-view'), keep = X.view === view ? [view.scrollLeft, view.scrollTop] : null;
  if (X.view !== view) { resized ||= new ResizeObserver(() => { if (X?.view?.isConnected) renderOutline(); }); resized.disconnect(); resized.observe(view); }
  X.view = view;
  X.labels = labelsOf.get(X.fnKey);
  X.out = { nodes: [], edges: [], frames: [], tags: [], more: [] };
  X.order = []; X.hidden = new Map();
  const root = seqBox(X.data.tree, 'r') || EMPTY;
  root.draw(PAD, PAD);
  const W = Math.ceil(root.w + 2 * PAD), H = Math.ceil(root.h + 2 * PAD), O = X.out;
  X.size = [W, H];
  const frames = O.frames.map((f) => `<rect class="xf ${f.kind}" x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="14"/>`).join('');
  const edges = O.edges.map((e) => `<path class="xe ${e.cls}" data-to="${esc(e.to || '')}" d="${pathD(e.pts)}"${e.arrow ? ' marker-end="url(#xrA)"' : ''}/>`).join('');
  view.innerHTML = `<div class="xr-chart" style="width:${W}px;height:${H}px">
    <svg width="${W}" height="${H}" aria-hidden="true"><defs><marker id="xrA" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 .8 7.2 4 0 7.2z"/></marker></defs>${frames}${edges}</svg>
    ${O.frames.filter((f) => f.icon).map((f) => `<span class="xloop" style="left:${f.icon.x}px;top:${f.icon.y}px" title="repeats">↺</span>`).join('')}
    ${O.tags.map((t) => `<span class="xtag ${t.cls}" style="left:${t.x}px;top:${t.y}px"${t.title ? ` title="${esc(t.title)}"` : ''}>${esc(t.text)}</span>`).join('')}
    ${O.nodes.map(nodeHtml).join('')}
    ${O.more.map((m) => `<button class="xn more" data-more="${esc(m.key)}" style="left:${m.x}px;top:${m.y}px;width:${m.w}px;height:${m.h}px" title="Expand: ${esc(m.text)}"><b>… ${esc(m.text)}</b><span>${esc(m.first)}</span></button>`).join('')}
  </div>`;
  if (keep) [view.scrollLeft, view.scrollTop] = keep;
  else { const e = O.nodes[0]; if (e) view.scrollLeft = e.x + e.w / 2 - view.clientWidth / 2; }   // a wide chart opens on its entry
  X.chart = view.firstElementChild;
  renderOutline();
  if (X.cur) setCur(X.cur, { scroll: false, sync: false });
  wire();
}

/* ---------------- outline: the whole chart in miniature, with the visible window ---------------- */
function renderOutline() {
  const wrap = X.el.querySelector('.xr-wrap'), view = X.view, [W, H] = X.size;
  wrap.querySelector('.xr-outline')?.remove();
  if (W <= view.clientWidth + 4 && H <= view.clientHeight + 4) return;
  const s = Math.min(96 / W, Math.max(80, view.clientHeight * 0.6) / H), ow = Math.ceil(W * s), oh = Math.ceil(H * s);
  if ((view.clientWidth - W) / 2 < ow + 30) return;   // only in free room beside the chart, never over it
  const kindCls = (n) => (n.rv ? 'rv-' + n.rv : n.error ? 'err' : n.kind);
  wrap.insertAdjacentHTML('beforeend', `<div class="xr-outline" title="Outline: click or drag to move"><svg width="${ow}" height="${oh}">
    ${X.out.frames.map((f) => `<rect class="of" x="${f.x * s}" y="${f.y * s}" width="${f.w * s}" height="${f.h * s}" rx="2"/>`).join('')}
    ${X.out.nodes.map((o) => `<rect class="on ${kindCls(o.n)}" x="${o.x * s}" y="${o.y * s}" width="${Math.max(2, o.w * s)}" height="${Math.max(1.5, o.h * s)}" rx="1"/>`).join('')}
    ${X.out.more.map((m) => `<rect class="on more" x="${m.x * s}" y="${m.y * s}" width="${m.w * s}" height="${m.h * s}" rx="1"/>`).join('')}
    <rect class="ov" rx="2"/></svg></div>`);
  const ol = wrap.querySelector('.xr-outline'), vr = ol.querySelector('.ov');
  const sync = () => { vr.setAttribute('x', view.scrollLeft * s); vr.setAttribute('y', view.scrollTop * s); vr.setAttribute('width', Math.min(ow, view.clientWidth * s)); vr.setAttribute('height', Math.min(oh, view.clientHeight * s)); };
  const go = (e) => { const r = ol.querySelector('svg').getBoundingClientRect(); view.scrollTo({ left: (e.clientX - r.left) / s - view.clientWidth / 2, top: (e.clientY - r.top) / s - view.clientHeight / 2, behavior: 'instant' }); };
  ol.onpointerdown = (e) => { e.preventDefault(); ol.setPointerCapture(e.pointerId); go(e); ol.onpointermove = go; };
  ol.onpointerup = ol.onpointercancel = () => { ol.onpointermove = null; };
  view.onscroll = sync; sync();
}

/* ---------------- interaction ---------------- */
function wire() {
  const view = X.view;
  view.onmouseover = (e) => { const b = e.target.closest('.xn[data-id]'); trace(b ? b.dataset.id : null); };
  view.onmouseleave = () => trace(null);
  X.el.onclick = (e) => {
    const a = e.target.closest('[data-xa]')?.dataset.xa;
    if (a === 'explain') return explain();
    if (a === 'all') { X.all = !X.all; renderBar(); return renderChart(); }
    if (a === 'only') { X.only = !X.only; X.expanded.clear(); renderBar(); return renderChart(); }
    if (a === 'pick') { $('#settings').hidden = false; $('#model').focus(); return; }
    const m = e.target.closest('[data-more]'); if (m) return expand(m.dataset.more);
    const b = e.target.closest('.xn[data-id]'); if (b) activate(b.dataset.id, true);
  };
  view.onkeydown = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key, order = X.order;
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'j' || k === 'k') {
      e.preventDefault();
      const cur = X.cur ? order.indexOf(X.hidden.has(X.cur) ? 'more:' + X.hidden.get(X.cur) : X.cur) : -1;
      const next = order[clamp(cur + (k === 'ArrowDown' || k === 'j' ? 1 : -1), 0, order.length - 1)];
      if (next) setCur(next.startsWith('more:') ? X.data.nodes.find((n) => X.hidden.get(n.id) === next.slice(5))?.id : next, { scroll: true, sync: true });
    } else if (k === 'Enter' && X.cur) {
      e.preventDefault();
      if (X.hidden.has(X.cur)) expand(X.hidden.get(X.cur)); else activate(X.cur, false);
    } else if (k === 'Home' || k === 'End') { e.preventDefault(); const ids = order.filter((o) => !o.startsWith('more:')); setCur(ids[k === 'Home' ? 0 : ids.length - 1], { scroll: true, sync: true }); }
  };
}

function expand(key) {
  X.expanded.add(key);
  renderBar(); renderChart();
  const first = X.chart.querySelector(`.xn[data-id="${CSS.escape(X.cur && !X.hidden.has(X.cur) ? X.cur : '')}"]`);
  first?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// A click or Enter: a call re-centres the Lens on its callee (Enter on the current step too); anything else opens the code.
function activate(id, click) {
  const n = X.byId[id]; if (!n) return;
  if (n.kind === 'call' && n.callee && X.onCall(n)) return;
  setCur(id, { scroll: !click, sync: false });
  if (n.rv === 'del') openChangeLine(X.data.fn.file, 0, n.baseLine); else openFile(X.data.fn.file, n.line || X.data.fn.start);
}

function trace(id) {
  if (X.traced === id) return;
  X.traced = id;
  const chart = X.chart, path = id ? X.paths.get(id) : null;
  chart.classList.toggle('tracing', !!path);
  for (const el of chart.querySelectorAll('.xn.lit,.xe.lit')) el.classList.remove('lit');
  if (!path) return;
  for (const el of chart.querySelectorAll('.xn[data-id]')) if (path.has(el.dataset.id)) el.classList.add('lit');
  for (const el of chart.querySelectorAll('.xe')) if (path.has(el.dataset.to)) el.classList.add('lit');
}

// The current step: ringed, scrolled into view, and (sync) the code drawer follows.
function setCur(id, { scroll, sync }) {
  if (!id || !X.byId[id]) return;
  X.cur = id;
  for (const el of X.chart.querySelectorAll('.xn.cur')) el.classList.remove('cur');
  const el = X.hidden.has(id) ? X.chart.querySelector(`[data-more="${CSS.escape(X.hidden.get(id))}"]`) : X.chart.querySelector(`.xn[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.classList.add('cur');
  if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (sync && document.getElementById('drawer').classList.contains('open')) { const n = X.byId[id]; if (n.rv === 'del') openChangeLine(X.data.fn.file, 0, n.baseLine); else openFile(X.data.fn.file, n.line || X.data.fn.start); }
}

// The drawer's cursor line moved: light the step on that line (else the closest one above it).
function fromDrawer() {
  if (!X?.chart?.isConnected || X.data?.status !== 'ready' || state.curFile !== X.data.fn.file) return;
  const line = +dcode.querySelector('.cl.on')?.dataset.n || 0, fn = X.data.fn;
  if (line < fn.start || line > fn.end || X.byId[X.cur]?.line === line) return;   // already on that line (several steps can share one)
  let best = null;
  for (const n of X.data.nodes) if (n.line && n.rv !== 'del' && n.line <= line && (!best || n.line > best.line || (n.line === best.line && n.kind === 'entry'))) best = n;
  if (best && best.id !== X.cur) setCur(best.id, { scroll: true, sync: false });
}

/* ---------------- plain-English labels ---------------- */
async function explain() {
  const cfg = state.chatCfg || {};
  if (!state.agentList?.length) { X.note = 'No chat agent is available on this server, so there is nothing to explain with.'; return renderBar(); }
  if (!cfg.picked) {
    X.note = `Pick an agent and model first: explaining uses your own model usage. <button class="lnk" data-xa="pick">Choose a model</button>`;
    renderBar(); $('#settings').hidden = false; $('#model').focus();
    return;
  }
  const me = X, fn = X.data.fn;
  X.busy = true; X.note = ''; renderBar();
  try {
    const r = await fetch('/api/xray/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: fn.file, line: fn.start, agent: cfg.agent, model: cfg.model }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error || !j.labels) throw new Error(j.error || (r.status === 404 ? 'This server cannot explain yet.' : `The server answered ${r.status}.`));
    const key = `${fn.file}:${fn.start}`, n = Object.keys(j.labels).length;
    labelsOf.set(key, j.labels);
    me.busy = false;
    if (X?.fnKey !== key || !X.chart?.isConnected) return;   // the Lens moved on; the labels show when it comes back
    X.busy = false;   // the same function may have been re-mounted while the model answered
    X.note = n ? `Plain-English labels added to ${n} steps, above their code.` : 'The model gave no labels for this function.';
    renderBar(); renderChart();
  } catch (e) {
    if (X !== me) return;
    X.busy = false; X.note = `Couldn’t explain: ${esc(e.message)}`; renderBar();
  }
}
