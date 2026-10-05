// feature.js
// Exports: exitFeature, focusFeature, escFeature, keepFeature, initFeature
// Imports: state: state | hud: I, openCode | scene: camera, exts, findEnt, flowById, flyTo, flyToEnt, parts, playFlow, player, recolor, resolveEnt, select, setEmphasis, stopFlow | theme: EXT, KINDS, PORTS, extOf, kindOf | util: $, V3, clamp, esc
import * as THREE from 'three';
import { state } from './state.js';
import { I, openCode } from './hud.js';
import { camera, exts, findEnt, flowById, flyTo, flyToEnt, parts, playFlow, player, recolor, resolveEnt, select, setEmphasis, stopFlow } from './scene.js';
import { EXT, KINDS, PORTS, extOf, kindOf } from './theme.js';
import { $, V3, clamp, esc } from './util.js';

/* Feature focus: one feature (a system flow, a part's flow, or a whole part) and only what it touches: the parts,
   data stores, outside services and code, with the rest of the map dimmed, and a small card that sums it up.
   The slice comes from the map alone, so the same feature always shows the same thing. */

const STORE = new Set(['db', 'storage', 'queue']);
const isEnt = (id) => parts.has(id) || exts.has(id);
const uniq = (a) => [...new Set(a)];
let feature = null, saved = null;   // the focused slice; the selection to return to on exit

// Entities in first-use order, split into parts, data stores and outside services.
function split(ids) {
  const ex = ids.filter((id) => exts.has(id));
  return { parts: ids.filter((id) => parts.has(id)), stores: ex.filter((id) => STORE.has(extOf(exts.get(id)))), services: ex.filter((id) => !STORE.has(extOf(exts.get(id)))) };
}

// The code a feature runs through: one entry per function (or file, when a step names no function).
function codeOf(steps) {
  const seen = new Map();
  for (const s of steps) {
    const name = s.fn || (s.ref || '').replace(/:\d+$/, '').split('/').pop();
    if (name && !seen.has(name)) seen.set(name, s.ref || '');
  }
  return [...seen].map(([name, ref]) => ({ name, ref }));
}

// System flows (other than `self`) whose steps touch any of `ids`, most shared first, with what they share.
function flowsThrough(ids, self) {
  const mine = new Set(ids);
  return (state.M.systemFlows || []).map((f, i) => ({ id: `system#${i}`, title: f.title, via: uniq((f.steps || []).flatMap((s) => [s.from, s.to])).filter((a) => mine.has(a)) }))
    .filter((f) => f.id !== self && f.via.length).sort((a, b) => b.via.length - a.via.length);
}

function flowSlice(id) {
  const r = flowById(id); if (!r) return null;
  const { f, part } = r, steps = f.steps || [];
  if (!steps.length) return null;
  const who = (a) => (isEnt(a) ? a : part?.id);   // a part flow's inner actors (its functions) belong to the part
  const ids = uniq([part?.id, ...steps.flatMap((s) => [who(s.from), who(s.to)])].filter(Boolean));
  if (!ids.length) return null;
  const pairs = new Set(steps.flatMap((s) => [`${who(s.from)}|${who(s.to)}`, `${who(s.to)}|${who(s.from)}`]));
  const first = steps[0], last = steps.at(-1);
  return {
    id, ids, ...split(ids), code: codeOf(steps), play: id,
    kicker: part ? `Flow in ${part.name}` : 'System flow', title: f.title,
    summary: f.summary || (steps.length > 1 ? `${steps.length} steps, from “${first.text}” to “${last.text}”.` : first.text),
    start: part ? { id: part.id, text: f.trigger || first.fn || '' } : { id: who(first.from), text: first.text },
    flows: flowsThrough(ids, id), flowsLabel: 'Also in',
    link: (L) => pairs.has(`${L.a.id}|${L.b.id}`),
  };
}

function partSlice(p) {
  const callers = uniq(p.links.filter((L) => L.b === p).map((L) => L.a.id));
  const used = uniq([...(p.uses || []).map((u) => u.target), ...p.links.filter((L) => L.a === p).map((L) => L.b.id)].filter(isEnt));
  const own = (p.flows || []).map((f, i) => ({ id: `${p.id}#${i}`, title: f.title, via: [] }));
  return {
    id: p.id, ids: uniq([p.id, ...used, ...callers]), ...split(used), callers, code: codeOf((p.flows || []).flatMap((f) => f.steps || [])),
    kicker: `${KINDS[kindOf(p)].label} · ${p.clusterObj.name}`, title: p.name, summary: p.summary || '',
    start: { id: p.id, entries: (p.exposes || []).map((e) => ({ name: `${(PORTS[e.type] || PORTS.function).label} ${e.what}`, ref: e.ref || '' })) },
    flows: [...own, ...flowsThrough([p.id]).map((f) => ({ ...f, via: [] }))], flowsLabel: 'Flows',
    link: (L) => L.a === p || L.b === p,
  };
}

/* ---------------- the card ---------------- */
function chip(id) {
  const p = parts.get(id);
  if (p) return `<button class="ft-chip" data-id="${esc(id)}" style="--k:${p.clusterObj.color}"><i></i>${esc(p.name)}</button>`;
  const t = EXT[extOf(exts.get(id))];
  return `<button class="ft-chip" data-id="${esc(id)}" style="--k:${t.color}">${t.icon}${esc(id)}</button>`;
}
const MORE = 8;   // code entries shown before "+n"
const row = (label, body) => (body ? `<div class="ft-row"><div class="ft-l">${label}</div>${body}</div>` : '');
const chips = (ids) => (ids.length ? `<div class="ft-chips">${ids.map(chip).join('')}</div>` : '');

function render(s) {
  const st = s.start, codes = s.code.slice(0, MORE);
  const start = st.entries
    ? (st.entries.length ? `<div class="ft-chips">${st.entries.map((e) => `<button class="ft-code" data-ref="${esc(e.ref)}">${esc(e.name)}</button>`).join('')}</div>` : '')
    : st.id && `<div class="ft-start">${chip(st.id)}${st.text ? `<small>${esc(st.text)}</small>` : ''}</div>`;
  $('#feature').innerHTML = `<div class="ft-hd"><span class="ft-k">${I.focus}${esc(s.kicker)}</span><button class="ft-x" title="Close (Esc)">${I.x}</button></div>
    <h2>${esc(s.title)}</h2>${s.summary ? `<p class="ft-sum">${esc(s.summary)}</p>` : ''}
    <div class="ft-rows">
      ${row('Starts at', start)}
      ${row(s.callers ? 'Uses' : 'Parts, in order', chips(s.parts))}
      ${s.callers ? row('Used by', chips(s.callers)) : ''}
      ${row('Data', chips(s.stores))}
      ${row('Outside services', chips(s.services))}
      ${row('Code', codes.length ? `<div class="ft-chips">${codes.map((c) => `<button class="ft-code" data-ref="${esc(c.ref)}" title="${esc(c.ref)}">${esc(c.name)}</button>`).join('')}${s.code.length > MORE ? `<span class="ft-more">+${s.code.length - MORE}</span>` : ''}</div>` : '')}
      ${row(s.flowsLabel, s.flows.slice(0, 6).map((f) => `<button class="ft-flow" data-flow="${esc(f.id)}">${I.flow}<span>${esc(f.title)}${f.via.length ? `<small>via ${esc(f.via.slice(0, 3).map((id) => parts.get(id)?.name || id).join(', '))}${f.via.length > 3 ? ` +${f.via.length - 3}` : ''}</small>` : ''}</span></button>`).join(''))}
    </div>
    ${s.play ? `<div class="ft-foot"><button class="btn tinted" data-play>${I.play}Play this flow</button></div>` : ''}`;
  $('#feature').hidden = false;
}

/* ---------------- the map ---------------- */
// Light the entry point (or a hovered chip) the way a flow step is lit.
function glow(id) {
  if (player.on) return;
  state.activeKeys = new Set(id ? [id] : []); recolor();
}

function apply() {
  feature.sel = state.selected; feature.played = false;
  setEmphasis([...feature.ids, state.selected?.id].filter(Boolean), feature.link); glow(feature.start.id);   // a selection outside the slice stays visible
}

// Frame every entity in the slice, shifted left of the card that covers the right edge.
function frame(s) {
  const sph = new THREE.Box3().setFromPoints(s.ids.map((id) => (parts.get(id) || exts.get(id)).pos)).getBoundingSphere(new THREE.Sphere());
  const half = Math.tan(camera.fov * Math.PI / 360), dist = clamp((sph.radius + 16) * 1.15 / half, 45, state.overviewDist * 1.3);
  const right = new V3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
  const px = innerWidth > 760 ? $('#feature').offsetWidth + 16 : 0;   // on phones the card sits at the bottom
  flyTo(sph.center.addScaledVector(right, px / innerHeight * dist * half), dist);
}

// spec: { flow: 'system#0' | '<partId>#<k>' } or { part: '<partId>' }
export function focusFeature(spec) {
  const s = spec.part ? parts.has(spec.part) && partSlice(parts.get(spec.part)) : spec.flow && flowSlice(spec.flow);
  if (!s) return false;
  if (player.on) stopFlow();
  if (!feature) saved = state.selected;
  feature = state.feature = s;   // scene.js labels the slice's parts and services while state.feature is set
  select(null); apply(); render(s); frame(s);
  return true;
}

export function exitFeature() {
  feature = state.feature = null; $('#feature').hidden = true;
  if (!player.on) state.activeKeys = new Set();
  select(state.selected || (saved && resolveEnt(saved)));   // back to the selection's own emphasis, or none
  saved = null;
}

// Esc: first drop a selection made inside the feature, then leave the feature.
export function escFeature() {
  if (!feature) return false;
  if (state.selected) select(null); else exitFeature();
  return true;
}

// Per frame: selecting things (or a played flow ending) resets emphasis; while a feature is open, it comes back.
export function keepFeature() {
  if (!feature) return;
  if (player.on) feature.played = true;
  else if (feature.played || state.selected !== feature.sel || !state.emph) apply();
}

export function initFeature() {
  document.body.insertAdjacentHTML('beforeend', '<div id="feature" class="hud glass" role="dialog" aria-label="Feature" hidden></div>');
  const card = $('#feature');
  card.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('.ft-x')) return exitFeature();
    if (t.closest('[data-play]')) return playFlow(feature.play);
    const fl = t.closest('[data-flow]'); if (fl) return focusFeature({ flow: fl.dataset.flow });
    const r = t.closest('[data-ref]'); if (r) return r.dataset.ref && openCode(r.dataset.ref);
    const c = t.closest('[data-id]'); if (c) { const ent = findEnt(c.dataset.id); select(ent); flyToEnt(ent); }
  });
  card.addEventListener('mouseover', (e) => { const c = e.target.closest('[data-id]'); if (c) glow(c.dataset.id); });
  card.addEventListener('mouseout', (e) => { const c = e.target.closest('[data-id]'); if (c && !c.contains(e.relatedTarget) && feature) glow(feature.start.id); });
}
