// prflow.js
// Exports: initFlow, showFlow, hideFlow, flowShown, setFlow
// Imports: (none)
// The PR's flow as a 2D chart over the map, the reviewer's first view of a change (REVIEW.md). Functions run left to
// right by call depth from the entry points, one lane per entry tree; changed existing code (with its existing callers)
// sits on top and loose functions at the bottom; the tables and queues they touch end on the far right. Without call
// data the functions are grouped by file. Pan and zoom move one transformed layer; nothing here touches the 3D map.

const W = 220, GAPX = 116, GAPY = 14, LANE_GAP = 56, BIG = 60, GRID_MAX = 24;
const STATUS = { added: 'new', modified: 'changed', removed: 'deleted' };
const RES = new Set(['db', 'queue', 'storage']);
const svgI = (d) => `<svg class="fl-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  db: svgI('<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"/>'),
  queue: svgI('<path d="M4 7h16M4 12h16M4 17h10"/>'),
  storage: svgI('<path d="M4 8.5 12 4l8 4.5-8 4.5zM4 8.5v7L12 20l8-4.5v-7"/>'),
  fit: svgI('<path d="M4 9V5.5C4 4.7 4.7 4 5.5 4H9M15 4h3.5c.8 0 1.5.7 1.5 1.5V9M20 15v3.5c0 .8-.7 1.5-1.5 1.5H15M9 20H5.5c-.8 0-1.5-.7-1.5-1.5V15"/>'),
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const short = (path) => path.split('/').slice(-2).join('/');
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

let ov, world, svg, ctl, opts;
let D = null, G = null, cur = null, done = new Set(), focus = null;
const open = new Set();          // lanes expanded past the big-PR cut
const V = { k: 1, x: 0, y: 0 };  // view: screen = world * k + (x, y)

/* ---------------- graph: lanes, columns, visible nodes, edges ---------------- */
function build(data) {
  const fns = data.functions || [], by = new Map(fns.map((f) => [f.id, f])), seen = new Set(), order = [];
  for (const id of [...(data.flow?.order || data.tour || []), ...fns.map((f) => f.id)]) if (by.has(id) && !seen.has(id)) seen.add(id), order.push(id);
  const out = new Map(order.map((id) => [id, []])), inn = new Map(order.map((id) => [id, []]));
  for (const id of order) for (const c of by.get(id).calls || [])
    if (by.has(c.to) && c.to !== id && !out.get(id).some((e) => e.b === c.to)) { const e = { a: id, b: c.to, when: c.when, loop: c.loop }; out.get(id).push(e); inn.get(c.to).push(e); }
  const graph = fns.some((f) => f.calls);

  // Cycles: edges back onto the DFS stack are drawn but ignored for layout; columns = longest path over the rest.
  const roots = (data.flow?.roots || []).filter((id) => by.has(id));
  if (!roots.length) roots.push(...order.filter((id) => !inn.get(id).length));
  const st = new Map();
  const dfs = (id) => { st.set(id, 1); for (const e of out.get(id)) { const s = st.get(e.b); if (s === 1) e.back = true; else if (!s) dfs(e.b); } st.set(id, 2); };
  roots.forEach((r) => st.has(r) || dfs(r));
  for (const id of order) if (!st.has(id)) roots.push(id), dfs(id);
  const col = new Map();
  const depth = (id) => { if (!col.has(id)) col.set(id, Math.max(0, ...inn.get(id).filter((e) => !e.back).map((e) => depth(e.a) + 1))); return col.get(id); };
  order.forEach(depth);

  // Lanes: each tree is claimed by the first lane whose DFS reaches it; changed functions always head the top lane.
  const lanes = [], laneOf = new Map(), kids = new Map(), tdep = new Map();
  const isChg = (id) => by.get(id).status !== 'added';
  const lane = (key, title, grid) => { const l = { key, title, grid, ids: [], tops: [] }; lanes.push(l); return l; };
  const claim = (id, l, d) => { laneOf.set(id, l); tdep.set(id, d); l.ids.push(id); const ks = []; kids.set(id, ks);
    for (const e of out.get(id)) if (!e.back && !laneOf.has(e.b) && !isChg(e.b)) { ks.push(e.b); claim(e.b, l, d + 1); } };
  if (!graph) {
    for (const id of order) { const f = by.get(id).file; laneOf.set(id, lanes.find((l) => l.key === f) || lane(f, f, true)); laneOf.get(id).ids.push(id); }
  } else {
    const chg = order.filter(isChg);
    if (chg.length) { const l = lane('changed', 'Changed existing code'); for (const id of chg) l.tops.push(id), claim(id, l, 0); }
    for (const r of roots) if (!laneOf.has(r) && out.get(r).length) { const l = lane(r, short(by.get(r).file)); l.tops.push(r); claim(r, l, 0); }
    const loose = order.filter((id) => !laneOf.has(id));
    if (loose.length) { const l = lane('other', 'Other changes', true); for (const id of loose) laneOf.set(id, l), l.ids.push(id); }
  }

  // Big PRs: each lane shows its first two levels (grids their first GRID_MAX) until expanded; the selected one always shows.
  const big = order.length > BIG;
  if (big && cur && laneOf.has(cur)) open.add(laneOf.get(cur).key);
  const shown = (id) => { const l = laneOf.get(id); return !big || open.has(l.key) || (l.grid ? l.ids.indexOf(id) < GRID_MAX : tdep.get(id) <= 1); };
  const size = (id) => 1 + (kids.get(id) || []).reduce((s, k) => s + size(k), 0);

  const nodes = new Map(), edges = [];
  const add = (key, o) => { const n = { key, kids: [], ghosts: [], ...o }; nodes.set(key, n); return n; };
  const life = new Map();
  for (const l of data.lifecycles || []) for (const t of l.transitions || []) life.set(t.via, [...(life.get(t.via) || []), `${t.from} → ${t.to}`]);
  for (const id of order) if (shown(id)) { const f = by.get(id); add(id, { type: f.kind === 'query' ? 'q' : 'f', f, lane: laneOf.get(id), col: col.get(id), life: life.get(f.name) }); }
  for (const l of lanes) {
    if (l.grid && big && !open.has(l.key) && l.ids.length > GRID_MAX) add(`more:${l.key}`, { type: 'm', lane: l, n: l.ids.length - GRID_MAX });
    l.items = [...nodes.values()].filter((n) => n.lane === l);
  }
  for (const n of [...nodes.values()]) {
    if (!n.f) continue;
    const hidden = (kids.get(n.key) || []).filter((k) => !nodes.has(k));
    n.kids = (kids.get(n.key) || []).filter((k) => nodes.has(k));
    if (hidden.length) { const m = add(`more:${n.key}`, { type: 'm', lane: n.lane, col: n.col + 1, n: hidden.reduce((s, k) => s + size(k), 0) }); n.kids.push(m.key); edges.push({ a: n.key, b: m.key, kind: 'more' }); }
    for (const e of out.get(n.key) || []) if (nodes.has(e.b)) edges.push({ ...e, kind: 'call' });
    if (isChg(n.key) && !n.lane.grid) {  // existing callers outside this review, by name
      const known = new Set(inn.get(n.key).map((e) => by.get(e.a).name)), names = (n.f.blast?.callers || []).filter((c) => !known.has(c));
      const show = names.length > 4 ? names.slice(0, 3) : names;
      show.forEach((c, i) => { const g = add(`g:${n.key}:${i}`, { type: 'g', label: c, lane: n.lane }); n.ghosts.push(g); edges.push({ a: g.key, b: n.key, kind: 'ghost' }); });
      if (names.length > show.length) { const g = add(`g:${n.key}:+`, { type: 'g', label: `+${names.length - show.length} more`, title: names.slice(3).join('\n'), lane: n.lane }); n.ghosts.push(g); edges.push({ a: g.key, b: n.key, kind: 'ghost' }); }
    }
  }

  // Resources: tables from queries (and from code that has no query of its own), queues and storage from anyone.
  const viaQuery = (id) => out.get(id).some((e) => by.get(e.b).kind === 'query');
  for (const n of [...nodes.values()]) for (const ef of n.f?.effects || []) {
    if (!RES.has(ef.kind) || (ef.kind === 'db' && n.type === 'f' && viaQuery(n.key))) continue;
    const key = `r:${ef.kind}:${ef.target}`, kind = ef.op === 'reads' ? 'read' : 'write';
    if (!nodes.has(key)) add(key, { type: 'r', kind: ef.kind, label: ef.target });
    const e = edges.find((x) => x.a === n.key && x.b === key);
    if (!e) edges.push({ a: n.key, b: key, kind }); else if (kind === 'write') e.kind = 'write';
  }
  return { nodes, edges, lanes, big, graph };
}

/* ---------------- DOM ---------------- */
function card(n) {
  const el = document.createElement('div');
  if (n.type === 'f') {
    const f = n.f, fx = (f.effects || []).map((e) => e.kind === 'queue' || e.op === 'calls' ? `→ ${e.target}` : `${e.op} ${e.target}`).filter((s, i, a) => a.indexOf(s) === i);
    const dot = f.status !== 'added' && (f.risk === 'high' || f.risk === 'medium') ? `<i class="fl-dot ${f.risk}" title="${f.risk} risk change"></i>` : '';
    const pills = fx.slice(0, 3).map((s) => `<span>${esc(clip(s, 30))}</span>`).join('') + (fx.length > 3 ? `<span title="${esc(fx.slice(3).join('\n'))}">+${fx.length - 3}</span>` : '');
    el.className = `fl-x fl-n fl-fn st-${f.status}`;
    el.title = `${f.name}\n${f.file}${f.head ? `:${f.head.start}` : ''}${f.summary ? `\n\n${f.summary}` : ''}`;
    el.innerHTML = `<div class="fl-h"><span class="fl-nm">${esc(f.name)}</span>${dot}<span class="fl-st">${STATUS[f.status] || ''}</span><span class="fl-ck sym i-check"></span></div>
      ${f.summary || n.lane.key !== f.file ? `<div class="fl-sum${f.summary ? '' : ' file'}">${esc(f.summary || short(f.file))}</div>` : ''}
      ${pills ? `<div class="fl-fx">${pills}</div>` : ''}
      <button class="fl-map" data-map title="Show on map"><span class="sym i-scope"></span></button>`;
  } else if (n.type === 'q') {
    const f = n.f;
    el.className = `fl-x fl-n fl-q st-${f.status}`;
    el.title = `${f.name} (query)\n${f.file}${f.summary ? `\n\n${f.summary}` : ''}${n.life ? `\n\n${n.life.join('\n')}` : ''}`;
    el.innerHTML = `${ICON.db}<span class="fl-nm">${esc(f.name)}</span>${n.life ? `<span class="fl-tr">${esc(n.life[0])}${n.life.length > 1 ? ' …' : ''}</span>` : ''}<span class="fl-ck sym i-check"></span>
      <button class="fl-map" data-map title="Show on map"><span class="sym i-scope"></span></button>`;
  } else if (n.type === 'r') {
    el.className = `fl-x fl-n fl-r k-${n.kind}`;
    el.title = `${n.kind === 'db' ? 'Table' : n.kind === 'queue' ? 'Queue' : 'Storage'}: ${n.label}`;
    el.innerHTML = `${ICON[n.kind]}<span>${esc(n.label)}</span>`;
  } else if (n.type === 'g') {
    el.className = 'fl-x fl-n fl-g';
    el.title = n.title || `${n.label}: an existing caller`;
    el.textContent = n.label;
  } else {
    el.className = 'fl-x fl-n fl-more';
    el.title = 'Show the rest of this lane';
    el.textContent = `+${n.n} more`;
  }
  el.dataset.key = n.key;
  return el;
}

function layout() {
  const X = (c) => c * (W + GAPX), N = G.nodes;
  const maxCol = Math.max(0, ...[...N.values()].map((n) => n.col || 0));
  const place = (key, top) => {
    const n = N.get(key); n.x = X(n.col);
    let y = top; for (const k of n.kids) y = place(k, y);
    const gh = n.ghosts.reduce((s, g) => s + g.h + 8, 0) - 8;
    if (n.kids.length) { const a = N.get(n.kids[0]), b = N.get(n.kids.at(-1)); n.y = Math.max(top, (a.y + a.h / 2 + b.y + b.h / 2) / 2 - n.h / 2); } else n.y = top;
    if (gh > 0) n.y = Math.max(n.y, top + gh / 2 - n.h / 2);
    let gy = n.y + n.h / 2 - gh / 2; for (const g of n.ghosts) g.x = n.x - 48 - g.w, g.y = gy, gy += g.h + 8;
    return Math.max(y, n.y + n.h + GAPY, gy + GAPY);
  };
  let top = 0;
  for (const l of G.lanes) {
    l.y = top; let y = top + 36;
    if (l.grid) {
      const per = G.graph ? clamp(maxCol + 1, 3, 5) : 4;
      for (let i = 0; i < l.items.length; i += per) {
        const row = l.items.slice(i, i + per);
        row.forEach((n, j) => { n.x = j * (W + GAPX / 2); n.y = y; });
        y += Math.max(...row.map((n) => n.h)) + GAPY;
      }
    } else for (const id of l.tops) if (N.has(id)) y = place(id, y);
    l.h = y - GAPY + 18 - top; top = l.y + l.h + LANE_GAP;
  }
  // resources: far right, each near the mean height of what touches it
  const body = [...N.values()].filter((n) => n.type !== 'r'), rx = Math.max(...body.map((n) => n.x + n.w)) + GAPX;
  const res = [...N.values()].filter((n) => n.type === 'r');
  for (const r of res) { const ys = G.edges.filter((e) => e.b === r.key).map((e) => N.get(e.a)).map((n) => n.y + n.h / 2); r.want = ys.reduce((s, y) => s + y, 0) / ys.length - r.h / 2; r.x = rx; }
  let ry = -Infinity; for (const r of res.sort((a, b) => a.want - b.want)) { r.y = Math.max(r.want, ry); ry = r.y + r.h + 10; }
  G.x0 = Math.min(...body.map((n) => n.x)) - 22; G.x1 = Math.max(...body.map((n) => n.x + n.w)) + 22;
}

function render() {
  G = build(D);
  focus = null; ov.classList.remove('focus');
  world.querySelectorAll('.fl-x').forEach((e) => e.remove());
  const N = G.nodes;
  for (const n of N.values()) world.append(n.el = card(n));
  for (const n of N.values()) n.w = n.el.offsetWidth, n.h = n.el.offsetHeight;
  layout();
  for (const n of N.values()) n.el.style.translate = `${n.x}px ${n.y}px`;
  for (const l of G.lanes) {
    const b = document.createElement('div'); b.className = 'fl-x fl-lane' + (l.key === 'changed' ? ' fl-chg' : '');
    Object.assign(b.style, { left: `${G.x0}px`, top: `${l.y}px`, width: `${G.x1 - G.x0}px`, height: `${l.h}px` });
    b.innerHTML = `<span class="tag">${esc(l.title)}</span>`;
    world.prepend(b);
  }
  let paths = '';
  G.edges.forEach((e, i) => {
    const a = N.get(e.a), b = N.get(e.b), x0 = a.x + a.w, y0 = a.y + a.h / 2, x1 = b.x, y1 = b.y + b.h / 2;
    const c = Math.max(48, Math.abs(x1 - x0) / 2);
    paths += `<path class="fl-e ${e.kind}${e.back ? ' back' : ''}" data-i="${i}" d="M${x0},${y0} C${x0 + c},${y0} ${x1 - c},${y1} ${x1 - 3},${y1}"/>`;
    if (e.kind !== 'call' || !(e.when || e.loop)) return;
    const t = document.createElement('div'); t.className = 'fl-x fl-w'; t.dataset.i = i;
    t.textContent = (e.loop ? '↻ ' : '') + (e.when || '');
    t.title = [e.loop, e.when && `when ${e.when}`].filter(Boolean).join('\n');
    // above the line where it arrives, or where it leaves when the target has existing callers drawn on its left
    if (b.ghosts.length) t.classList.add('src'), t.style.translate = `${x0 + 10}px ${y0 - 3}px`; else t.style.translate = `${x1 - 10}px ${y1 - 3}px`;
    world.append(t); e.label = t;
  });
  svg.innerHTML = `<defs><marker id="flA" viewBox="0 0 8 8" refX="5" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 .8 7 4 0 7.2z" fill="context-stroke"/></marker></defs>${paths}`;
  G.edges.forEach((e, i) => { e.el = svg.querySelector(`[data-i="${i}"]`); });
  const all = [...N.values()];
  G.bx = Math.min(G.x0, ...all.map((n) => n.x)); G.by = Math.min(0, ...all.map((n) => n.y));
  G.bw = Math.max(...all.map((n) => n.x + n.w)) - G.bx; G.bh = Math.max(...G.lanes.map((l) => l.y + l.h), ...all.map((n) => n.y + n.h)) - G.by;
  mark();
}

function mark() {
  for (const n of G.nodes.values()) if (n.f) n.el.classList.toggle('cur', n.key === cur), n.el.classList.toggle('done', done.has(n.key));
}

// Hover: the node, everything upstream and downstream of it; the rest fades.
function hover(key) {
  if (focus === key) return;
  focus = key; ov.classList.toggle('focus', !!key);
  world.querySelectorAll('.hl').forEach((e) => e.classList.remove('hl'));
  if (!key) return;
  const walk = (from, to) => { const s = new Set([key]), q = [key]; while (q.length) { const k = q.pop(); for (const e of G.edges) if (e[from] === k && !s.has(e[to])) s.add(e[to]), q.push(e[to]); } return s; };
  const up = walk('b', 'a'), down = walk('a', 'b');
  for (const k of new Set([...up, ...down])) G.nodes.get(k).el.classList.add('hl');
  for (const e of G.edges) if ((up.has(e.a) && up.has(e.b)) || (down.has(e.a) && down.has(e.b))) e.el.classList.add('hl'), e.label?.classList.add('hl');
}

/* ---------------- view ---------------- */
// The free screen area: right of the review panel, left of an open code drawer.
function area() {
  const r = ov.getBoundingClientRect(), a = { l: 16, t: 16, r: r.width - 16, b: r.height - 16 };
  const p = document.getElementById('review'), d = document.getElementById('drawer');
  if (p && !p.hidden && p.offsetWidth) { const q = p.getBoundingClientRect(); if (q.width < r.width * 0.6) a.l = q.right + 16; else a.t = q.bottom + 8; }
  if (d?.classList.contains('open')) { const q = d.getBoundingClientRect(); if (q.left > r.width * 0.3) a.r = Math.min(a.r, q.left - 16); else a.b = Math.min(a.b, q.top - 8); }
  return a;
}
const apply = () => { world.style.transform = `translate(${V.x}px,${V.y}px) scale(${V.k})`; };
function placeCtl() { const a = area(); ctl.style.top = `${a.t}px`; ctl.style.right = `${ov.clientWidth - a.r}px`; }

function fit(min) {
  const a = area(), w = a.r - a.l, h = a.b - a.t - 44, pad = 24;
  V.k = clamp(Math.min(w / (G.bw + pad * 2), h / (G.bh + pad * 2)), min, 1);
  V.x = a.l + Math.max((w - G.bw * V.k) / 2, pad) - G.bx * V.k;
  V.y = a.t + 44 + Math.max((h - G.bh * V.k) / 2, 0) - G.by * V.k;
  apply();
}

// Pan the selected node into the free area if it is not already well inside it.
function reveal(glide = true) {
  const n = G?.nodes.get(cur); if (!n) return;
  const a = area(), sx = n.x * V.k + V.x, sy = n.y * V.k + V.y, m = 24;
  if (sx >= a.l + m && sx + n.w * V.k <= a.r - m && sy >= a.t + 44 && sy + n.h * V.k <= a.b - m) return;
  V.x = (a.l + a.r) / 2 - (n.x + n.w / 2) * V.k; V.y = (a.t + a.b) / 2 - (n.y + n.h / 2) * V.k;
  world.classList.toggle('glide', glide); apply();
}

/* ---------------- API ---------------- */
export function initFlow(o) {
  opts = o;
  ov = document.createElement('div'); ov.id = 'prflow'; ov.hidden = true;
  ov.innerHTML = `<div class="fl-world"><svg class="fl-edges"></svg></div>
    <div class="fl-ctl glass"><span class="tag">Flow</span><button class="icon-btn" data-act="fit" title="Fit to view">${ICON.fit}</button><button class="icon-btn" data-act="close" title="Close the flow"><span class="sym i-x"></span></button></div>`;
  document.body.append(ov);
  world = ov.querySelector('.fl-world'); svg = ov.querySelector('svg'); ctl = ov.querySelector('.fl-ctl');
  world.addEventListener('transitionend', () => world.classList.remove('glide'));

  let drag = null, moved = false;
  ov.addEventListener('pointerdown', (e) => { if (e.button === 0 && !e.target.closest('.fl-ctl')) drag = { x: e.clientX, y: e.clientY, vx: V.x, vy: V.y, id: e.pointerId }, moved = false; });
  ov.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) {
      if (!moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) { moved = true; ov.setPointerCapture(e.pointerId); ov.classList.add('panning'); hover(null); }
      if (moved) { V.x = drag.vx + e.clientX - drag.x; V.y = drag.vy + e.clientY - drag.y; apply(); }
    } else if (!drag) { const n = e.target.closest('.fl-n'); hover(n && !n.classList.contains('fl-more') ? n.dataset.key : null); }
  });
  const end = () => { drag = null; ov.classList.remove('panning'); };
  ov.addEventListener('pointerup', end); ov.addEventListener('pointercancel', end);
  ov.addEventListener('pointerleave', () => hover(null));
  ov.addEventListener('click', (e) => {
    if (moved) return void (moved = false);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'fit') return fit(0.1);
    if (act === 'close') { hideFlow(); return opts.onClose(); }
    const n = e.target.closest('.fl-n'), node = n && G.nodes.get(n.dataset.key);
    if (!node) return;
    if (node.type === 'm') { open.add(node.lane.key); render(); return; }
    if (!node.f) return;
    if (e.target.closest('[data-map]')) opts.onMap(node.key); else opts.onOpen(node.key);
  });
  ov.addEventListener('wheel', (e) => {
    e.preventDefault(); world.classList.remove('glide');
    const u = e.deltaMode === 1 ? 16 : 1;  // Firefox scrolls in lines
    if (e.ctrlKey) {  // pinch or ctrl+wheel: zoom about the pointer
      const k = clamp(V.k * Math.exp(-clamp(e.deltaY * u, -50, 50) * 0.01), 0.1, 2), r = ov.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      V.x = px - (px - V.x) * k / V.k; V.y = py - (py - V.y) * k / V.k; V.k = k;
    } else { V.x -= e.deltaX * u; V.y -= e.deltaY * u; }
    apply();
  }, { passive: false });

  const dr = document.getElementById('drawer');
  if (dr) new MutationObserver(() => { if (flowShown()) placeCtl(), reveal(); }).observe(dr, { attributes: true, attributeFilter: ['class'] });
  addEventListener('resize', () => flowShown() && placeCtl());
}

export function showFlow(data, s = {}) {
  if (data !== D) open.clear();
  D = data; cur = s.cur ?? null; done = s.done || new Set();
  ov.hidden = false;
  render(); placeCtl(); fit(0.62); reveal(false);
  requestAnimationFrame(() => ov.classList.add('on'));
  if (document.fonts?.status !== 'loaded') document.fonts.ready.then(() => { if (flowShown() && D === data) { render(); fit(0.62); reveal(false); } });
}

export function hideFlow() { if (!ov) return; ov.hidden = true; ov.classList.remove('on'); hover(null); }

export const flowShown = () => !!ov && !ov.hidden;

export function setFlow(s) {
  cur = s.cur ?? null; done = s.done || done;
  if (!flowShown()) return;
  if (cur && !G.nodes.has(cur) && D.functions?.some((f) => f.id === cur)) render();
  mark(); reveal();
}
