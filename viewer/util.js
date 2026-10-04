// util.js
// Exports: $, V3, clamp, smooth, ease, esc, hashStr, rng, spring, reducedMotion, initUtil
// Imports: (three only)
import * as THREE from 'three';

export let $, V3, clamp, smooth, ease, esc;
let motionQuery;

export function hashStr(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

export function rng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Critically damped spring, exact step: s[i] = value, s[i + 1] = velocity. Settles in about 6 / omega seconds, never overshoots.
export function spring(s, i, goal, omega, dt) {
  const y = s[i] - goal, e = Math.exp(-omega * dt), k = (s[i + 1] + omega * y) * dt;
  s[i] = goal + (y + k) * e; s[i + 1] = (s[i + 1] - omega * k) * e;
}

export const reducedMotion = () => motionQuery.matches;

export function initUtil() {
  motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  $ = (s) => document.querySelector(s);
  V3 = THREE.Vector3;
  clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
