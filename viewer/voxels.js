// voxels.js
// Exports: PALETTE, island, partModel, externalModel, cart
// Imports: (nothing)

// Procedural voxel models for the Voxel theme. A model is { voxels: [[x, y, z, r, g, b, emissive]], size: [w, h, d], anim }:
// integer coords, y up, centred on x/z, base at y = 0. Colours are sRGB 0..1 (set them with THREE.SRGBColorSpace); emissive is 0..1.
// Hidden interior voxels are dropped. Every function is pure: the same arguments give the same model.

const hex = (h) => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];
// Theme tints are muted pastels; voxels read better a little richer, so saturation is lifted.
const rgb = (t) => { const c = hex(typeof t === 'string' ? parseInt(t.slice(1), 16) : t), l = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11; return c.map((v) => Math.min(1, Math.max(0, l + (v - l) * 1.5)) * 0.95); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const shade = (c, k) => c.map((v) => Math.min(1, v * k));

export const PALETTE = {
  grass: hex(0x8fbf5a), leaf: hex(0x5f9a4a), earth: hex(0x8f6446), earthDark: hex(0x75523a),
  stone: hex(0xb3aca1), stoneDark: hex(0x8a8379), rock: hex(0x6a635d),
  wood: hex(0xa8754a), woodDark: hex(0x6e4a30), plank: hex(0xcfa271),
  metal: hex(0x9aa3ae), metalDark: hex(0x4e5560), iron: hex(0x2f343b),
  glass: hex(0x2a3442), window: hex(0xffc978), screen: hex(0x8dffb4), led: hex(0x6fe0ff), red: hex(0xff5a4e),
  gold: hex(0xf0c25a), paper: hex(0xf3e9d2), wax: hex(0xf7f0e2), flame: hex(0xffb347), clock: hex(0xfff0c8),
  cloud: hex(0xf7f8fc), cloudShade: hex(0xc8d2e6), crystal: hex(0x8fe9ff),
  flowers: [hex(0xff8fb1), hex(0xffe27a), hex(0xffffff), hex(0xb79cff)],
};
const P = PALETTE;

// mulberry32, plus a stateless hash for per-voxel colour variation and value noise.
function rng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hash(x, y, z, s) { let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647) + Math.imul(s, 144665); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function noise(x, z, scale, s) {
  const fx = x / scale, fz = z / scale, ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz;
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v), h = (a, b) => hash(ix + a, 0, iz + b, s);
  return (h(0, 0) * (1 - su) + h(1, 0) * su) * (1 - sv) + (h(0, 1) * (1 - su) + h(1, 1) * su) * sv;
}

// Sparse voxel grid. c is a colour or a function (x, y, z) -> colour; tag collects that voxel's output index into anim[tag].
function grid(seed) {
  const cells = new Map(), key = (x, y, z) => x + ',' + y + ',' + z;
  const g = {
    rand: rng(seed),
    set(x, y, z, c, e = 0, tag) { cells.set(key(x, y, z), [x, y, z, typeof c === 'function' ? c(x, y, z) : c, e, tag]); },
    has: (x, y, z) => cells.has(key(x, y, z)),
    del(x, y, z) { cells.delete(key(x, y, z)); },
    box(x0, y0, z0, x1, y1, z1, c, e, tag) { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) g.set(x, y, z, c, e, tag); },
    // Returns the model plus the y shift applied to put the base at 0.
    done(grain = 0.07) {
      const all = [...cells.values()], lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      for (const v of all) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], v[i]); hi[i] = Math.max(hi[i], v[i]); }
      const dx = -Math.floor((lo[0] + hi[0]) / 2), dy = -lo[1], dz = -Math.floor((lo[2] + hi[2]) / 2);
      const voxels = [], anim = {};
      for (const [x, y, z, c, e, tag] of all) {
        if (!e && !tag && g.has(x + 1, y, z) && g.has(x - 1, y, z) && g.has(x, y + 1, z) && g.has(x, y - 1, z) && g.has(x, y, z + 1) && g.has(x, y, z - 1)) continue;
        const k = 1 + (hash(x, y, z, seed) - 0.5) * grain * (e ? 0.4 : 2), w = (hash(z, x, y, seed) - 0.5) * grain * 0.5;
        if (tag) (anim[tag] ||= []).push(voxels.length);
        voxels.push([x + dx, y + dy, z + dz, Math.min(1, c[0] * k + w), Math.min(1, c[1] * k), Math.min(1, c[2] * k - w), e]);
      }
      return [{ voxels, size: [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1], anim }, dy];
    },
  };
  return g;
}

// Floating island. The flat grass top is tinted; `top` is the first free layer above it, where models stand.
export function island(seed, radius, tint) {
  const g = grid(seed), r = g.rand, R = radius, t0 = rgb(tint);
  const ph = [r(), r(), r()].map((v) => v * 6.283), H = Math.round(R * 0.55) + 5;
  const edge = (a) => R * (1 + 0.07 * Math.sin(3 * a + ph[0]) + 0.05 * Math.sin(5 * a + ph[1]) + 0.025 * Math.sin(11 * a + ph[2]));
  const meadow = (x, z) => mix(shade(t0, 0.88), shade(t0, 1.08), noise(x, z, 5, seed));
  const ring = [];
  for (let x = -Math.ceil(R * 1.2); x <= R * 1.2; x++) for (let z = -Math.ceil(R * 1.2); z <= R * 1.2; z++) {
    const d = Math.hypot(x, z), e = edge(Math.atan2(z, x));
    if (d > e) continue;
    const t = d / e, lump = noise(x, z, 4, seed + 1);
    const depth = 3 + Math.round((H - 3) * (1 - t) ** 0.85 * (0.6 + 0.8 * lump) + noise(x, z, 1.7, seed + 4) * 2);
    const soil = 2 + Math.round(noise(x, z, 3, seed + 2) * 1.5);
    for (let y = -depth; y <= 0; y++) {
      const L = -y;
      let c;
      if (L === 0) c = meadow(x, z);
      else if (L === 1 && t > 0.9 && hash(x, 2, z, seed) < 0.55) c = shade(meadow(x, z), 0.8);
      else if (L <= soil) c = mix(P.earth, P.earthDark, (L - 1) / soil);
      else c = mix(mix(P.stone, P.stoneDark, noise(x + y, z, 3, seed + 3)), P.rock, Math.min(1, (L - soil) / H));
      g.set(x, y, z, c);
    }
    if (t > 0.78) ring.push([x, z]);
    // A few glowing crystals hang from the underside.
    if (depth > 6 && hash(x, 3, z, seed) < 0.006) { g.set(x, -depth - 1, z, P.crystal, 0.8); if (hash(x, 4, z, seed) < 0.6) g.set(x, -depth - 2, z, P.crystal, 0.9); }
  }
  // Rim decoration: flowers, grass tufts, pebbles and, on larger islands, a few trees.
  for (const [x, z] of ring) {
    const h = hash(x, 5, z, seed);
    if (h < 0.02) g.set(x, 1, z, P.flowers[Math.floor(hash(x, 6, z, seed) * 4)]);
    else if (h < 0.05) g.set(x, 1, z, shade(meadow(x, z), 0.85));
    else if (h < 0.057) g.set(x, 1, z, P.stone);
  }
  for (let i = 0, n = Math.floor(R / 7); i < n; i++) {
    const [x, z] = ring[Math.floor(r() * ring.length)], ht = 2 + Math.floor(r() * 2), leaf = mix(P.leaf, t0, 0.25);
    g.box(x, 1, z, x, ht, z, P.woodDark);
    for (let a = -1; a <= 1; a++) for (let b = 0; b <= 2; b++) for (let c = -1; c <= 1; c++) {
      if (Math.abs(a) + Math.abs(b - 1) + Math.abs(c) <= 2) g.set(x + a, ht + 1 + b, z + c, (x, y) => shade(leaf, 0.85 + (y - ht) * 0.06));
    }
  }
  const [model, dy] = g.done(0.08);
  model.top = dy + 1;
  return model;
}

/* ---------------- parts ---------------- */

export function partModel(kind, seed, tint) {
  const g = grid(seed), r = g.rand, t0 = rgb(tint);
  ({ service, job, library, tool })[kind](g, r, t0);
  return g.done()[0];
}

// Office tower: tinted walls, stone corner pillars and ledges, warm windows, antenna with a red beacon.
function service(g, r, t0) {
  const floors = 2 + (r() < 0.5 ? 1 : 0), top = 2 + floors * 4;
  g.box(-5, 0, -5, 5, 0, 5, P.stoneDark);
  g.box(-4, 1, -4, 4, 1, 4, P.stone);
  g.box(-3, 2, -3, 3, top - 1, 3, (x, y, z) => (Math.abs(x) === 3 && Math.abs(z) === 3 ? P.stone : shade(t0, 0.95 + (y - 2) * 0.012)));
  for (let f = 0; f < floors; f++) {
    const y0 = 3 + f * 4;
    if (f > 0) for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) if (Math.abs(x) === 4 || Math.abs(z) === 4) g.set(x, y0 - 1, z, P.stone);
    for (const w of [-2, 0, 2]) {
      for (const [sx, sz, along] of [[0, 3, 'x'], [0, -3, 'x'], [3, 0, 'z'], [-3, 0, 'z']]) {
        if (f === 0 && sz === 3 && w === 0) continue;
        const lit = r() < 0.7, c = lit ? P.window : P.glass, e = lit ? 0.9 : 0;
        for (let y = y0; y <= y0 + 1; y++) along === 'x' ? g.set(w, y, sz, c, e) : g.set(sx, y, w, c, e);
      }
    }
  }
  g.box(0, 2, 3, 0, 4, 3, P.woodDark);
  g.set(0, 5, 4, P.window, 0.7);
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) {
    g.set(x, top, z, P.stone);
    if ((Math.abs(x) === 4 || Math.abs(z) === 4) && (x + z) % 2 === 0) g.set(x, top + 1, z, shade(t0, 0.75));
  }
  g.box(-2, top + 1, -2, -1, top + 2, -1, P.metal);
  g.box(1, top + 1, 1, 1, top + 4, 1, P.metalDark);
  g.set(1, top + 5, 1, P.red, 1);
}

// Clock tower: tinted shaft, stone clock box with a glowing face on every side (anim.clock), pointed tinted roof, gold spire.
function job(g, r, t0) {
  g.box(-4, 0, -4, 4, 0, 4, P.stoneDark);
  g.box(-3, 1, -3, 3, 1, 3, P.stone);
  g.box(-2, 2, -2, 2, 8, 2, (x, y, z) => (Math.abs(x) === 2 && Math.abs(z) === 2 ? P.stone : shade(t0, 0.95 + (y - 2) * 0.015)));
  for (const [x, z] of [[0, 2], [0, -2], [2, 0], [-2, 0]]) g.box(x, 5, z, x, 6, z, P.window, 0.8);
  g.box(-3, 9, -3, 3, 15, 3, P.stone);
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) if (Math.abs(x) === 4 || Math.abs(z) === 4) { g.set(x, 9, z, P.stoneDark); g.set(x, 16, z, P.stoneDark); }
  for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) {
    const d = a * a + b * b, y = 12 + b;
    if (d > 9) continue;
    const hand = (a === 0 && b >= 0 && b <= 2) || (b === 0 && a >= 0 && a <= 1);
    for (const [x, z] of [[a, 3], [-a, -3], [3, -a], [-3, a]]) {
      if (d > 5) g.set(x, y, z, P.iron);
      else if (hand) g.set(x, y, z, P.iron);
      else g.set(x, y, z, P.clock, 0.5, 'clock');
    }
  }
  for (let k = 0; k <= 3; k++) g.box(-3 + k, 17 + k, -3 + k, 3 - k, 17 + k, 3 - k, shade(t0, 0.8 + k * 0.06));
  g.box(0, 21, 0, 0, 22, 0, P.gold);
  g.set(0, 23, 0, P.gold, 0.6);
}

// Stack of chunky books: covers in tint-led colours, cream page edges, gold spine bands, a ribbon and a lit candle.
function library(g, r, t0) {
  const covers = [t0, mix(t0, hex(0xa8443a), 0.7), mix(t0, hex(0x37598a), 0.7), mix(t0, hex(0xd9a441), 0.65)];
  for (let i = covers.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [covers[i], covers[j]] = [covers[j], covers[i]]; }
  covers.unshift(t0);
  const books = [[13, 4, 9], [11, 3, 8], [10, 4, 7], [8, 3, 6]];
  let y0 = 0, last;
  books.forEach(([w, h, d], i) => {
    const ox = i ? Math.round((r() - 0.5) * 2) : 0, oz = i ? Math.round((r() - 0.5) * 2) : 0;
    const x0 = ox - (w >> 1), x1 = x0 + w - 1, z0 = oz - (d >> 1), z1 = z0 + d - 1, y1 = y0 + h - 1, cov = covers[i], spineX = i % 2 === 0;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const cover = y === y0 || y === y1, spine = spineX ? x === x0 : z === z0;
      if (cover || spine) {
        const band = spine && !cover && (spineX ? z === z0 + 1 || z === z1 - 1 : x === x0 + 1 || x === x1 - 1);
        g.set(x, y, z, band ? P.gold : shade(cov, cover ? 1 : 0.88));
      } else if (spineX ? x < x1 && z > z0 && z < z1 : z < z1 && x > x0 && x < x1) {
        g.set(x, y, z, shade(P.paper, y % 2 ? 1 : 0.94));
      }
    }
    last = [x0, x1, y1, z0, z1, ox, oz];
    y0 = y1 + 1;
  });
  const [, , , z0b, , ox, oz] = last;
  g.box(ox + 1, y0 - 3, z0b - 1, ox + 1, y0 - 1, z0b - 1, hex(0xc0392b));
  g.box(ox - 1, y0, oz, ox - 1, y0 + 2, oz, P.wax);
  g.set(ox - 1, y0 + 3, oz, P.flame, 1);
  g.box(ox - 2, y0, oz - 1, ox, y0, oz + 1, P.gold);
}

// Workbench with a tinted apron, a little monitor showing a glowing ">_", keyboard, toolbox and hammer.
function tool(g, r, t0) {
  for (const [x, z] of [[-5, -2], [5, -2], [-5, 2], [5, 2]]) g.box(x, 0, z, x, 3, z, P.woodDark);
  for (let x = -5; x <= 5; x++) if (x % 2 === 0) g.box(x, 1, -2, x, 1, 2, P.wood);
  for (let x = -6; x <= 6; x++) for (let z = -3; z <= 3; z++) {
    if (Math.abs(x) === 6 || Math.abs(z) === 3) g.set(x, 4, z, shade(t0, 0.9));
    g.set(x, 5, z, Math.abs(x) === 6 || Math.abs(z) === 3 ? P.wood : shade(P.plank, z % 2 ? 1 : 0.92));
  }
  g.box(-1, 6, -3, 1, 6, -2, P.metalDark);
  g.set(0, 7, -3, P.metalDark);
  g.box(-3, 8, -3, 3, 12, -2, P.iron);
  const glyph = ['X....', '.X...', 'X..XX'];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) {
    const on = glyph[row][col] === 'X';
    g.set(col - 2, 11 - row, -2, on ? P.screen : mix(P.glass, P.screen, 0.12), on ? 1 : 0.15);
  }
  g.box(-2, 6, 0, 2, 6, 1, P.metalDark);
  for (let x = -2; x <= 2; x++) g.set(x, 6, 1, P.metal);
  g.box(3, 6, -1, 5, 7, 1, t0);
  g.box(3, 8, 0, 5, 8, 0, P.metal);
  g.set(4, 8, 0, P.iron);
  g.box(-5, 6, 1, -3, 6, 1, P.wood);
  g.box(-5, 6, 0, -5, 7, 2, P.metal);
}

/* ---------------- externals ---------------- */

export function externalModel(kind, seed, tint) {
  const g = grid(seed), r = g.rand, t0 = rgb(tint);
  const crates = ({ db, queue, storage, cloud, saas, other })[kind](g, r, t0);
  const model = g.done()[0];
  if (crates) model.anim = { crates: Array.from({ length: crates }, (_, i) => model.anim['crate' + i]) };
  return model;
}

const disc = (g, y, rad, c, e, tag) => { for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) if (x * x + z * z <= rad * rad) g.set(x, y, z, c, e, tag); };

// Three stacked tinted drums with glowing seams (the database icon), metal lid and dome.
function db(g, r, t0) {
  for (let s = 0; s < 3; s++) {
    for (let k = 0; k < 3; k++) disc(g, s * 4 + k, 4.6, k === 2 ? mix(t0, [1, 1, 1], 0.18) : shade(t0, 0.92 + k * 0.04));
    if (s < 2) disc(g, s * 4 + 3, 4.1, mix(P.led, t0, 0.3), 0.45);
  }
  disc(g, 11, 4.1, P.metal);
  disc(g, 12, 2.6, P.metalDark);
  g.set(0, 13, 0, P.metal);
  g.set(3, 1, 4, P.screen, 1);
  g.set(2, 1, 4, P.led, 1);
}

// Short conveyor: legs, tinted side rails with flow lights, dark slatted belt, three crates (anim.crates, one index list per crate).
function queue(g, r, t0) {
  for (const x of [-6, 6]) for (const z of [-2, 2]) g.box(x, 0, z, x, 2, z, P.metalDark);
  g.box(-6, 1, -2, 6, 1, -2, P.metalDark);
  g.box(-6, 1, 2, 6, 1, 2, P.metalDark);
  for (let x = -7; x <= 7; x++) {
    for (let z = -1; z <= 1; z++) g.set(x, 3, z, Math.abs(x) === 7 ? P.metal : x % 3 === 0 ? P.metalDark : P.iron);
    for (const z of [-2, 2]) { g.set(x, 3, z, x % 3 === 0 && Math.abs(x) < 7 ? P.led : t0, x % 3 === 0 && Math.abs(x) < 7 ? 0.8 : 0); g.set(x, 4, z, shade(t0, 0.85)); }
  }
  // 3x3x3 crates: dark wood edges, plank faces, a tinted label on top.
  [-5, -1, 3].forEach((cx, i) => {
    for (let x = cx; x <= cx + 2; x++) for (let y = 4; y <= 6; y++) for (let z = -1; z <= 1; z++) {
      const ex = (x !== cx + 1) + (y !== 5) + (z !== 0);
      g.set(x, y, z, ex >= 2 ? P.woodDark : y === 6 ? t0 : P.plank, 0, 'crate' + i);
    }
  });
  return 3;
}

// Treasure chest: tinted panels, dark wood frame, metal straps, gold lock, warm light leaking from the lid seam.
function storage(g, r, t0) {
  for (let x = -5; x <= 5; x++) for (let z = -3; z <= 3; z++) {
    const strap = Math.abs(x) === 3, edgeX = Math.abs(x) === 5, edgeZ = Math.abs(z) === 3;
    for (let y = 0; y <= 4; y++) g.set(x, y, z, strap ? P.metalDark : (edgeX && edgeZ) || y === 0 || y === 4 ? P.woodDark : t0);
    if (Math.abs(x) <= 4 && Math.abs(z) <= 2) g.set(x, 5, z, P.gold, 0.8);
    for (let y = 6; y <= 8; y++) if (y < 8 || Math.abs(z) <= 2) g.set(x, y, z, strap ? P.metalDark : edgeX || y === 6 ? P.woodDark : shade(t0, 1.06));
  }
  g.box(-1, 3, 3, 1, 6, 3, P.gold);
  g.box(0, 4, 4, 0, 5, 4, P.gold, 0.4);
  g.set(0, 4, 3, P.iron);
}

// Fluffy cloud with a cave in front showing a small server rack with blinking LEDs.
function cloud(g, r, t0) {
  const puffs = [[0, 5, 0, 4.6], [-4.5, 3.5, 0.5, 3.4], [4.5, 3.5, -0.5, 3.4], [-1.5, 7.5, -1, 3.3], [2.5, 6.5, 1, 3], [0, 3, 2.5, 3]];
  for (const p of puffs) { p[0] += (r() - 0.5) * 1.2; p[1] += (r() - 0.5) * 0.8; }
  const white = mix(P.cloud, t0, 0.12), under = mix(P.cloudShade, t0, 0.2);
  for (let x = -9; x <= 9; x++) for (let y = 0; y <= 12; y++) for (let z = -6; z <= 6; z++) {
    if (puffs.some(([px, py, pz, pr]) => (x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2 <= pr * pr)) g.set(x, y, z, mix(under, white, Math.min(1, y / 7)));
  }
  for (let x = -2; x <= 2; x++) for (let y = 0; y <= 6; y++) for (let z = 0; z <= 7; z++) g.del(x, y, z);
  g.box(-2, 0, -1, 2, 0, 1, under);
  g.box(-1, 1, -1, 1, 5, 0, P.iron);
  const leds = [P.led, P.screen, P.gold];
  for (let y = 1; y <= 5; y++) for (let x = -1; x <= 1; x++) {
    const on = y % 2 === 0 && (x !== 0 || y === 4);
    g.set(x, y, 1, on ? leds[(x + y + 3) % 3] : y % 2 ? P.metalDark : P.metal, on ? 1 : 0);
  }
}

// Signpost on a little mound: two tinted arrow boards and a hanging lantern.
function saas(g, r, t0) {
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (x * x + z * z <= 5) g.set(x, 0, z, P.stoneDark);
  g.box(-1, 1, -1, 1, 1, 1, PALETTE.grass);
  g.box(0, 1, 0, 0, 12, 0, P.woodDark);
  const board = (cells, c) => cells.forEach(([x, y, z, edge]) => g.set(x, y, z, edge ? shade(c, 0.72) : c));
  const a = [], b = [];
  for (let y = 8; y <= 10; y++) for (let x = 1; x <= 6; x++) a.push([x, y, 0, y !== 9 || x === 1 || x === 6]);
  a.push([7, 9, 0, true]);
  for (let y = 4; y <= 6; y++) for (let x = -1; x >= -5; x--) b.push([x, y, 0, y !== 5 || x === -1 || x === -5]);
  b.push([-6, 5, 0, true]);
  board(a, t0);
  board(b, mix(t0, P.plank, 0.45));
  for (let x = 2; x <= 5; x++) g.set(x, 9, 0, shade(t0, 0.55));
  g.box(-2, 12, 0, -1, 12, 0, P.iron);
  g.set(-2, 11, 0, P.iron);
  g.set(-2, 10, 0, P.flame, 1);
  g.set(-2, 9, 0, P.iron);
}

// Rounded cube with a softly glowing equator band.
function other(g, r, t0) {
  for (let x = -4; x <= 4; x++) for (let y = -4; y <= 4; y++) for (let z = -4; z <= 4; z++) {
    if (x ** 4 + y ** 4 + z ** 4 > 4.6 ** 4) continue;
    g.set(x, y + 4, z, y === 0 ? mix(t0, [1, 1, 1], 0.45) : mix(t0, [1, 1, 1], y > 0 ? y * 0.03 : 0), y === 0 ? 0.35 : 0);
  }
}

// Small open cart with dark wheels carrying a glowing gem; the gem and rim glow in the tint.
export function cart(tint) {
  const g = grid(7), t0 = rgb(tint), glow = mix(t0, [1, 1, 1], 0.5);
  for (const x of [-2, 2]) for (const z of [-3, 3]) g.box(x, 0, z, x, 1, z, P.iron);
  g.box(-3, 1, -2, 3, 1, 2, shade(t0, 0.8));
  for (let x = -3; x <= 3; x++) for (let z = -2; z <= 2; z++) if (Math.abs(x) === 3 || Math.abs(z) === 2) { g.set(x, 2, z, t0); g.set(x, 3, z, glow, 0.2); }
  g.box(-1, 2, -1, 1, 2, 1, glow, 0.8);
  g.box(0, 3, -1, 0, 3, 1, glow, 0.8);
  g.box(-1, 3, 0, 1, 3, 0, glow, 0.8);
  g.set(0, 4, 0, [1, 1, 1], 1);
  return g.done(0.04)[0];
}
