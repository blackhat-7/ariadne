// voxels.js
// Exports: PALETTE, island, partModel, externalModel, cart
// Imports: (nothing)

// Procedural voxel models for the Voxel theme. A model is { voxels: [[x, y, z, r, g, b, emissive]], size: [w, h, d], anim }:
// integer coords, y up, centred on x/z, base at y = 0. Colours are sRGB 0..1 (set them with THREE.SRGBColorSpace); emissive is 0..1.
// Hidden interior voxels are dropped. Every function is pure: the same arguments give the same model. The seed picks a
// variant of each kind (a service's roof, facade, windows and footprint; a job's tower; ...), so no two look alike.

const hex = (h) => [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];
// Theme tints are muted pastels; voxels read better a little richer, so saturation is lifted.
const rgb = (t) => { const c = hex(typeof t === 'string' ? parseInt(t.slice(1), 16) : t), l = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11; return c.map((v) => Math.min(1, Math.max(0, l + (v - l) * 1.5)) * 0.95); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const shade = (c, k) => c.map((v) => Math.min(1, v * k));
const pick = (r, list) => list[Math.floor(r() * list.length)];

export const PALETTE = {
  grass: hex(0x8fbf5a), leaf: hex(0x5f9a4a), pine: hex(0x2f6b4a), blossom: hex(0xf2a7c3), earth: hex(0x8f6446), earthDark: hex(0x75523a),
  stone: hex(0xb3aca1), stoneDark: hex(0x8a8379), rock: hex(0x6a635d),
  wood: hex(0xa8754a), woodDark: hex(0x6e4a30), plank: hex(0xcfa271),
  metal: hex(0x9aa3ae), metalDark: hex(0x4e5560), iron: hex(0x2f343b),
  glass: hex(0x2a3442), window: hex(0xffc978), screen: hex(0x8dffb4), led: hex(0x6fe0ff), red: hex(0xff5a4e),
  gold: hex(0xf0c25a), paper: hex(0xf3e9d2), wax: hex(0xf7f0e2), flame: hex(0xffb347), ember: hex(0xff6a2a), clock: hex(0xfff0c8),
  lamp: hex(0xffd68a), cloud: hex(0xf7f8fc), cloudShade: hex(0xc8d2e6), crystal: hex(0x8fe9ff),
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
    rand: rng(Math.floor(hash(seed, 7, 3, 1) * 4294967296)),   // scrambled, so nearby seeds pick different variants
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

// Filled disc of radius rad around the y axis at height y.
const disc = (g, y, rad, c, e, tag) => { const n = Math.floor(rad); for (let x = -n; x <= n; x++) for (let z = -n; z <= n; z++) if (x * x + z * z <= rad * rad) g.set(x, y, z, c, e, tag); };

// Round clock face of radius rad centred at height cy: iron rim and hands (twelve and three), a glowing face that
// ticks (anim.clock). put(a, y, colour, emissive, tag) places one voxel, a running across the face.
function clockFace(rad, cy, put) {
  const n = Math.floor(rad);
  for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
    const d = a * a + b * b;
    if (d > rad * rad) continue;
    const hand = (a === 0 && b >= 0 && b <= n - 1) || (b === 0 && a >= 0 && a <= n - 2);
    if (d > (rad - 1) ** 2 + 1.5 || hand) put(a, cy + b, P.iron, 0);
    else put(a, cy + b, P.clock, 0.5, 'clock');
  }
}

// A lamp post: thin iron post, a glowing lamp, a little cap.
function lampPost(g, x, y, z, h = 3) {
  g.box(x, y, z, x, y + h - 2, z, P.iron);
  g.set(x, y + h - 1, z, P.lamp, 0.75);
  g.set(x, y + h, z, P.iron);
}

// Trees: a round crown, a pine of stacked cones, or a pink blossom crown. Returns the height used.
function tree(g, x, y, z, type, leaf, s) {
  if (type === 'pine') {
    const ht = 1 + (hash(x, 1, z, s) < 0.5 ? 1 : 0);
    g.box(x, y, z, x, y + ht - 1, z, P.woodDark);
    const tiers = [2, 1.5, 1.5, 1, 0.5, 0];
    tiers.forEach((rad, k) => { for (let a = -2; a <= 2; a++) for (let c = -2; c <= 2; c++) if (Math.abs(a) + Math.abs(c) <= rad * 1.5 && a * a + c * c <= rad * rad + 0.5) g.set(x + a, y + ht + k, z + c, shade(leaf, 0.85 + k * 0.05)); });
    return ht + tiers.length;
  }
  const ht = 2 + (hash(x, 2, z, s) < 0.5 ? 1 : 0), c0 = type === 'blossom' ? P.blossom : leaf;
  g.box(x, y, z, x, y + ht - 1, z, P.woodDark);
  for (let a = -1; a <= 1; a++) for (let b = 0; b <= 2; b++) for (let c = -1; c <= 1; c++) {
    if (Math.abs(a) + Math.abs(b - 1) + Math.abs(c) > 2) continue;
    const spot = type === 'blossom' && hash(x + a, y + b, z + c, s) < 0.18;
    g.set(x + a, y + ht + b, z + c, spot ? P.flowers[2] : shade(c0, 0.85 + b * 0.07));
  }
  return ht + 3;
}

// Floating island. The flat grass top is tinted; `top` is the first free layer above it, where models stand.
export function island(seed, radius, tint) {
  const g = grid(seed), r = g.rand, R = radius, t0 = rgb(tint);
  const ph = [r(), r(), r()].map((v) => v * 6.283), H = Math.round(R * 0.55) + 5;
  const edge = (a) => R * (1 + 0.07 * Math.sin(3 * a + ph[0]) + 0.05 * Math.sin(5 * a + ph[1]) + 0.025 * Math.sin(11 * a + ph[2]));
  const meadow = (x, z) => mix(shade(t0, 0.88), shade(t0, 1.08), noise(x, z, 5, seed));
  const ring = [], outer = [];
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
    if (t > 0.86 && d < e - 0.8) outer.push([x, z]);   // tall decoration: the outer rim, still on solid ground
    // A few glowing crystals hang from the underside.
    if (depth > 6 && hash(x, 3, z, seed) < 0.006) { g.set(x, -depth - 1, z, P.crystal, 0.8); if (hash(x, 4, z, seed) < 0.6) g.set(x, -depth - 2, z, P.crystal, 0.9); }
  }
  // Decoration stays on the rim, clear of the parts in the middle. Each island has its own mix: a favourite tree,
  // flower colours, how many bushes, rocks and lamps.
  const leaf = mix(P.leaf, t0, 0.25), pine = mix(P.pine, t0, 0.15), types = ['round', 'pine', 'blossom'], fav = pick(r, types);
  const flowerA = pick(r, P.flowers), flowerB = pick(r, P.flowers.slice(0, 2)), lush = 0.6 + r() * 0.8;
  const taken = [];   // [x, z, radius] of tall decoration placed so far
  const free = (x, z, rad) => !g.has(x, 1, z) && taken.every(([a, b, q]) => Math.hypot(x - a, z - b) > rad + q);
  const place = (rad, put) => {
    for (let tries = 0; tries < 12; tries++) {
      const [x, z] = outer[Math.floor(r() * outer.length)] || [];
      if (x !== undefined && free(x, z, rad)) { taken.push([x, z, rad]); put(x, z); return [x, z]; }
    }
  };
  // Stepping-stone paths from the rim inward (flush with the grass), each with a lamp post at its outer end.
  for (let i = 0, n = 1 + Math.floor(r() * (R > 14 ? 3 : 2)); i < n; i++) {
    const a = r() * 6.283, e = edge(a), cs = Math.cos(a), sn = Math.sin(a);
    for (let d = e - 1, k = 0; d > e * 0.55; d -= 1.4, k++) {
      const x = Math.round(cs * d), z = Math.round(sn * d), side = k % 2 ? 1 : 0;
      for (const [px, pz] of [[x, z], [x + Math.round(-sn * side), z + Math.round(cs * side)]]) if (g.has(px, 0, pz)) g.set(px, 0, pz, mix(meadow(px, pz), P.stone, 0.55 + hash(px, 7, pz, seed) * 0.2));
    }
    const lx = Math.round(cs * (e - 1.6) - sn * 1.6), lz = Math.round(sn * (e - 1.6) + cs * 1.6);
    if (g.has(lx, 0, lz) && free(lx, lz, 1)) { taken.push([lx, lz, 1]); lampPost(g, lx, 1, lz); }
  }
  for (let i = 0, n = Math.max(1, Math.round(R / 12 + r() * 1.5)); i < n; i++) place(1.5, (x, z) => lampPost(g, x, 1, z));
  for (let i = 0, n = Math.max(1, Math.round((R / 6) * lush)); i < n; i++) {
    const type = r() < 0.6 ? fav : pick(r, types);
    place(type === 'pine' ? 2.2 : 1.6, (x, z) => tree(g, x, 1, z, type, type === 'pine' ? pine : leaf, seed));
  }
  for (let i = 0, n = Math.round((R / 4) * lush); i < n; i++) place(1, (x, z) => {
    const c = r() < 0.5 ? shade(leaf, 0.95) : mix(leaf, P.grass, 0.4), big = r() < 0.5;
    g.set(x, 1, z, c); if (big) g.set(x, 2, z, shade(c, 1.08));
    if (g.has(x + 1, 0, z)) { g.set(x + 1, 1, z, shade(c, 0.92)); if (r() < 0.4) g.set(x + 1, 2, z, flowerA); }
    if (big && g.has(x, 0, z + 1)) g.set(x, 1, z + 1, shade(c, 0.9));
  });
  for (let i = 0, n = Math.round(R / 7 + r() * 2); i < n; i++) place(1, (x, z) => {
    const c = mix(P.rock, P.stoneDark, r() * 0.6);
    g.set(x, 1, z, c); if (r() < 0.6 && g.has(x + 1, 0, z)) g.set(x + 1, 1, z, shade(c, 1.1)); if (r() < 0.4) g.set(x, 2, z, shade(c, 1.15));
  });
  // Flat rim detail: flower patches, grass tufts, pebbles.
  for (const [x, z] of ring) {
    if (g.has(x, 1, z)) continue;
    const h = hash(x, 5, z, seed), patch = noise(x, z, 3, seed + 7);
    if (patch > 0.62 && h < 0.035) g.set(x, 1, z, hash(x, 6, z, seed) < 0.5 ? flowerA : flowerB);
    else if (h < 0.03) g.set(x, 1, z, shade(meadow(x, z), 0.85));
    else if (h < 0.036) g.set(x, 1, z, P.stoneDark);
  }
  const [model, dy] = g.done(0.08);
  model.top = dy + 1;
  return model;
}

/* ---------------- parts ---------------- */

// opts.size: lines of code (a service grows a floor for roughly every 2.5x more code, 2 to 7 floors).
export function partModel(kind, seed, tint, opts = {}) {
  const g = grid(seed), r = g.rand, t0 = rgb(tint);
  ({ service, job, library, tool })[kind](g, r, t0, opts, seed);
  return g.done()[0];
}

// Facades: wall colour (a function for patterned walls), trim for corners, floor bands and roof slab, lit and dark windows.
const FACADES = {
  brick: (t0) => { const b = mix(hex(0xa4553e), t0, 0.25); return { wall: (x, y, z) => shade(b, (y % 2 ? 1 : 0.9) * (0.95 + hash(x + (y % 2), y, z, 3) * 0.1)), trim: hex(0xd9ccb4), lit: P.window, dark: P.glass }; },
  concrete: (t0) => { const c = mix(hex(0xb9b3a9), t0, 0.4); return { wall: (x, y, z) => shade(c, (x + z) % 3 === 0 ? 0.93 : 1), trim: shade(c, 0.78), lit: hex(0xffe2ad), dark: P.glass }; },
  glass: (t0) => { const c = mix(hex(0x2f4562), t0, 0.35); return { wall: c, trim: P.metal, lit: hex(0xd4eaff), dark: shade(c, 0.75), glass: true }; },
  timber: (t0) => { const w = mix(P.plank, t0, 0.25); return { wall: (x, y, z) => shade(w, (x + z) % 2 ? 1 : 0.88), trim: P.woodDark, lit: hex(0xffb763), dark: P.glass }; },
};

// Office building. Floors follow code size; the seed picks footprint (square, L, side wing), facade, window pattern,
// roof (flat with antenna or dish, pitched, dome, spire, rooftop garden) and details (awning, sign, AC units).
function service(g, r, t0, { size = 300 }) {
  const F = Math.max(2, Math.min(7, Math.round(1 + Math.log(Math.max(size, 1) / 80) / Math.log(2.5)))), FH = 3;
  const fac = FACADES[pick(r, Object.keys(FACADES))](t0), pattern = pick(r, ['grid', 'bands', 'sparse']), litP = 0.25 + r() * 0.35;
  const shape = pick(r, ['square', 'L', 'wing']), roof = pick(r, ['flat', 'pitched', 'dome', 'spire', 'garden']), ws = Math.floor(r() * 1e6);
  const blocks = shape === 'square' ? [[-3, 3, -3, 3, F]]
    : shape === 'L' ? [[-3, 3, -3, 0, F], [-3, 0, 1, 3, Math.max(1, F - 1 - (r() < 0.5 ? 1 : 0))]]
    : [[-4, 1, -3, 3, F], [2, 4, -2, 2, Math.max(1, Math.min(F - 1, 1 + Math.floor(r() * 2)))]];
  const top = (b) => 1 + b[4] * FH, roofC = shade(t0, 0.85);
  g.box(-5, 0, -5, 5, 0, 5, (x, y, z) => (Math.abs(x) === 5 || Math.abs(z) === 5 ? P.stoneDark : P.stone));
  for (const b of blocks) g.box(b[0], 1, b[2], b[1], top(b), b[3], fac.wall);
  // Outward faces: corners and floor bands in trim, windows by pattern, lit or dark per window.
  for (const [x0, x1, z0, z1, f] of blocks) {
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = 1; y < 1 + f * FH; y++) {
      const ox = (x === x1 && !g.has(x + 1, y, z)) || (x === x0 && !g.has(x - 1, y, z));
      const oz = (z === z1 && !g.has(x, y, z + 1)) || (z === z0 && !g.has(x, y, z - 1));
      if (!ox && !oz) continue;
      const k = Math.floor((y - 1) / FH), j = (y - 1) % FH;
      if ((ox && oz) || j === 0) { g.set(x, y, z, fac.trim); continue; }
      const a = oz ? x - x0 : z - z0, face = oz ? (z === z1 ? 0 : 1) : (x === x1 ? 2 : 3);
      const win = pattern === 'bands' || (pattern === 'grid' ? a % 2 === 1 : a % 3 === 1 && hash(a, k, face, ws) < 0.8);
      if (!win) continue;
      const lit = hash(pattern === 'bands' ? a >> 1 : a, k, face, ws + 1) < litP;
      g.set(x, y, z, lit ? fac.lit : fac.dark, lit ? 0.55 : 0);
    }
  }
  for (const b of blocks) g.box(b[0], top(b), b[2], b[1], top(b), b[3], fac.trim);
  // Door on the front-most block, with an awning or a lamp; maybe a glowing sign.
  const front = blocks.reduce((m, b) => (b[3] > m[3] ? b : m)), dx = Math.round((front[0] + front[1]) / 2), fz = front[3];
  g.box(dx, 1, fz, dx, 2, fz, fac.glass ? fac.lit : P.woodDark, fac.glass ? 0.6 : 0);
  if (r() < 0.55) for (let x = dx - 1; x <= dx + 1; x++) g.set(x, 3, fz + 1, x % 2 ? t0 : P.paper);
  else g.set(dx + 1, 3, fz + 1, P.lamp, 0.9);
  const neon = mix(t0, [1, 1, 1], 0.35), main = blocks[0], yT = top(main);
  if (r() < 0.65) {
    const sx = g.has(main[1] + 1, yT - 2, main[3] - 1) ? main[0] - 1 : main[1] + 1;
    g.box(sx, yT - 4, main[3] - 1, sx, yT - 2, main[3] - 1, neon, 0.8);
    g.set(sx, yT - 1, main[3] - 1, P.iron);
  } else if (front[4] > 1) g.box(dx - 1, 4, fz + 1, dx + 1, 4, fz + 1, neon, 0.7);
  // AC units hanging under side windows.
  for (let i = 0, n = Math.floor(r() * 3); i < n; i++) {
    const b = pick(r, blocks), side = r() < 0.5, x = side ? b[1] + 1 : b[0] - 1, z = b[2] + 1 + Math.floor(r() * (b[3] - b[2] - 1)), y = 1 + FH * (1 + Math.floor(r() * (b[4] - 1 || 1)));
    if (y < top(b) && !g.has(x, y, z) && g.has(side ? x - 1 : x + 1, y, z)) g.set(x, y, z, P.metal);
  }
  // Lower blocks: a parapet edge and sometimes an AC box.
  for (const b of blocks.slice(1)) {
    const y = top(b) + 1;
    for (let x = b[0]; x <= b[1]; x++) for (let z = b[2]; z <= b[3]; z++) if ((x === b[0] || x === b[1] || z === b[2] || z === b[3]) && !g.has(x, y, z)) g.set(x, y, z, roofC);
    if (r() < 0.6) g.set(Math.round((b[0] + b[1]) / 2), y, Math.round((b[2] + b[3]) / 2), P.metal);
  }
  roofs[roof](g, r, main, yT, t0, fac);
}

const parapet = (g, [x0, x1, z0, z1], y, c) => { for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (x === x0 || x === x1 || z === z0 || z === z1) g.set(x, y, z, c); };

// Roofs on a service's main block [x0, x1, z0, z1]; yT is its roof slab.
const roofs = {
  flat(g, r, [x0, x1, z0, z1], yT, t0) {
    parapet(g, [x0, x1, z0, z1], yT + 1, shade(t0, 0.8));
    if (r() < 0.5) { g.box(x0 + 1, yT + 1, z0 + 1, x0 + 1, yT + 5, z0 + 1, P.metalDark); g.set(x0 + 1, yT + 6, z0 + 1, P.red, 1); g.set(x0 + 2, yT + 3, z0 + 1, P.metalDark); }
    else {   // dish: post, a 3x3 plate tipped to the sky, the feed glowing
      g.set(x1 - 2, yT + 1, z0 + 2, P.metalDark);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) g.set(x1 - 2 + a, yT + 3 + b, z0 + (b > 0 ? 1 : 2), a || b ? P.metal : P.metalDark);
      g.set(x1 - 2, yT + 3, z0 + 3, P.led, 0.9);
    }
    g.box(x1 - 2, yT + 1, z1 - 2, x1 - 1, yT + 2, z1 - 1, P.metal);
    g.set(x1 - 1, yT + 2, z1 - 1, P.metalDark);
  },
  // Gable roof over the longer axis, in the tint, with a stone chimney.
  pitched(g, r, [x0, x1, z0, z1], yT, t0, fac) {
    const alongX = x1 - x0 >= z1 - z0, [s0, s1, lo, hi] = alongX ? [x0, x1, z0, z1] : [z0, z1, x0, x1], put = (s, y, t, c) => (alongX ? g.set(s, y, t, c) : g.set(t, y, s, c));
    let k = 0;
    for (; lo - 1 + k <= hi + 1 - k; k++) for (let s = s0 - 1; s <= s1 + 1; s++) for (let t = lo - 1 + k; t <= hi + 1 - k; t++) {
      const edge = t === lo - 1 + k || t === hi + 1 - k;
      if (edge) put(s, yT + k, t, shade(t0, (lo - 1 + k === hi + 1 - k ? 0.7 : 0.82) + (k % 2) * 0.06));
      else if (s >= s0 && s <= s1) put(s, yT + k, t, fac.wall);
    }
    for (let y = yT + 1; y < yT + k + 1; y++) put(s0 + 1, y, lo + 1, P.stoneDark);
  },
  // Drum with a ring of lit windows, a dome in a tinted copper, a glowing finial.
  dome(g, r, [x0, x1, z0, z1], yT, t0) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, R = Math.min(x1 - x0, z1 - z0) / 2 + 0.4, cu = mix(t0, hex(0x7fbfa6), 0.4);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d <= R) g.set(x, yT + 1, z, d > R - 1 && (x + z) % 2 ? P.window : P.stone, d > R - 1 && (x + z) % 2 ? 0.8 : 0);
      for (let y = 0; y <= R; y++) if (d * d + y * y <= R * R) g.set(x, yT + 2 + y, z, shade(cu, 0.85 + y * 0.06 + ((x + z) % 3 === 0 ? -0.08 : 0)));
    }
    const ty = yT + 3 + Math.floor(R);
    g.set(Math.round(cx), ty, Math.round(cz), P.gold); g.set(Math.round(cx), ty + 1, Math.round(cz), P.gold, 0.7);
  },
  // Stepped pyramid in the tint, then a thin mast with a light.
  spire(g, r, [x0, x1, z0, z1], yT, t0) {
    let k = 0;
    for (; x0 + k <= x1 - k && z0 + k <= z1 - k; k++) parapet(g, [x0 + k, x1 - k, z0 + k, z1 - k], yT + 1 + k, shade(t0, 0.75 + k * 0.07));
    const cx = Math.round((x0 + x1) / 2), cz = Math.round((z0 + z1) / 2), h = 3 + Math.floor(r() * 3);
    g.box(cx, yT + k, cz, cx, yT + k + h, cz, P.metal);
    g.set(cx, yT + k + h + 1, cz, r() < 0.5 ? P.red : P.lamp, 1);
  },
  // Grass roof inside a stone parapet: bushes, flowers, a small tree and a lantern.
  garden(g, r, [x0, x1, z0, z1], yT, t0) {
    g.box(x0 + 1, yT, z0 + 1, x1 - 1, yT, z1 - 1, mix(P.grass, t0, 0.2));
    parapet(g, [x0, x1, z0, z1], yT + 1, P.stone);
    const leaf = mix(P.leaf, t0, 0.2);
    for (let x = x0 + 1; x < x1; x++) for (let z = z0 + 1; z < z1; z++) {
      const h = r();
      if (h < 0.2) g.set(x, yT + 1, z, shade(leaf, 0.9 + r() * 0.2));
      else if (h < 0.32) g.set(x, yT + 1, z, pick(r, P.flowers));
    }
    if (x1 - x0 >= 4 && z1 - z0 >= 4) tree(g, x0 + 2, yT + 1, z0 + 2, pick(r, ['round', 'blossom']), leaf, x0 + z1);
    g.set(x1 - 1, yT + 1, z1 - 1, P.iron); g.set(x1 - 1, yT + 2, z1 - 1, P.lamp, 1);
  },
};

// Jobs: a clock tower, a windmill, an observatory or a water tower with a clock. Clock faces and the windmill hub tick.
function job(g, r, t0) {
  pick(r, [clockTower, windmill, observatory, waterTower])(g, r, t0);
}

// Clock tower: tinted shaft, stone clock box with a glowing face on every side, pointed tinted roof, gold spire.
function clockTower(g, r, t0) {
  const sh = 7 + Math.floor(r() * 3), cb = sh + 1;   // shaft top, clock box bottom
  g.box(-4, 0, -4, 4, 0, 4, P.stoneDark);
  g.box(-3, 1, -3, 3, 1, 3, P.stone);
  g.box(-2, 2, -2, 2, sh, 2, (x, y, z) => (Math.abs(x) === 2 && Math.abs(z) === 2 ? P.stone : shade(t0, 0.95 + (y - 2) * 0.015)));
  for (const [x, z] of [[0, 2], [0, -2], [2, 0], [-2, 0]]) g.box(x, 5, z, x, 6, z, P.window, 0.8);
  g.box(0, 2, 2, 0, 3, 2, P.woodDark);
  g.box(-3, cb, -3, 3, cb + 6, 3, P.stone);
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) if (Math.abs(x) === 4 || Math.abs(z) === 4) { g.set(x, cb, z, P.stoneDark); g.set(x, cb + 7, z, P.stoneDark); }
  clockFace(3, cb + 3, (a, y, c, e, tag) => { for (const [x, z] of [[a, 3], [-a, -3], [3, -a], [-3, a]]) g.set(x, y, z, c, e, tag); });
  const steep = r() < 0.5 ? 2 : 1;
  for (let k = 0; k <= 3; k++) g.box(-3 + k, cb + 8 + k * steep, -3 + k, 3 - k, cb + 7 + (k + 1) * steep, 3 - k, shade(t0, 0.8 + k * 0.06));
  const yt = cb + 8 + 4 * steep;
  g.box(0, yt, 0, 0, yt + 1, 0, P.gold);
  g.set(0, yt + 2, 0, P.gold, 0.6);
}

// Windmill: tapered whitewashed tower, tinted cap, four lattice sails on a hub that ticks.
function windmill(g, r, t0) {
  disc(g, 0, 4.6, P.stoneDark);
  const wall = mix(hex(0xe8e0d0), t0, 0.2);
  for (let y = 1; y <= 11; y++) disc(g, y, 3.4 - y * 0.12, (x, yy, z) => shade(wall, (x + z + yy) % 4 === 0 ? 0.92 : 1));
  g.box(0, 1, 3, 0, 2, 3, P.woodDark);
  g.set(0, 3, 3, P.lamp, 0.8);
  for (const [x, z] of [[0, 3], [-3, 0], [3, 0]]) g.set(x, 6, z, P.window, 0.85);
  g.set(0, 9, 2, P.window, 0.85);
  for (let k = 0; k <= 3; k++) disc(g, 12 + k, 2.9 - k * 0.8, shade(t0, 0.8 + k * 0.06));
  g.box(0, 12, 3, 0, 12, 4, P.woodDark);
  g.set(0, 12, 5, P.clock, 0.6, 'clock');
  const tilt = r() < 0.5;   // an X or a + of sails
  for (const [dx, dy] of tilt ? [[1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let t = 1; t <= 7; t++) {
      const x = dx * t, y = 12 + dy * t;
      if (y < 2) break;
      g.set(x, y, 5, P.woodDark);
      if (t < 2) continue;
      const [sx, sy] = tilt ? [x, y - dy] : [x + dy, y - dx];   // the sail cloth beside the spar
      g.set(sx, sy, 5, (t + 1) % 3 === 0 ? P.woodDark : P.paper);
    }
  }
}

// Observatory: round stone hall with lit windows, a tinted metal dome with a glowing slit and a brass telescope.
function observatory(g, r, t0) {
  disc(g, 0, 5.4, P.stoneDark);
  const wall = mix(P.stone, t0, 0.25), dome = mix(P.metal, t0, 0.45);
  for (let y = 1; y <= 5; y++) disc(g, y, 4.4, y === 5 ? P.stone : wall);
  for (const [x, z] of [[-4, 0], [4, 0], [-3, -3], [3, -3], [0, -4]]) g.box(x, 2, z, x, 3, z, P.window, 0.85);
  g.box(0, 1, 4, 0, 2, 4, P.woodDark);
  g.box(-1, 3, 4, 1, 3, 4, P.stone);
  for (let x = -5; x <= 5; x++) for (let y = 0; y <= 5; y++) for (let z = -5; z <= 5; z++) {
    if (x * x + y * y + z * z > 19) continue;
    const slit = x === 0 && z >= 0 && y >= 1 && x * x + y * y + z * z > 11;
    g.set(x, 6 + y, z, slit ? P.window : shade(dome, 0.88 + y * 0.04 + ((x + 5) % 3 === 0 ? 0.08 : 0)), slit ? 0.5 : 0, slit ? 'clock' : undefined);
  }
  for (let t = 0; t <= 4; t++) g.box(0, 8 + t, 2 + t, 0, 8 + t, 2 + t, t === 4 ? P.metalDark : P.gold);
  g.set(1, 7, 3, P.gold);
}

// Water tower: braced legs, a tinted stave tank with a clock on two sides, a conical roof.
function waterTower(g, r, t0) {
  for (const x of [-3, 3]) for (const z of [-3, 3]) g.box(x, 0, z, x, 8, z, P.woodDark);
  for (let t = 0; t <= 6; t++) for (const [x, z] of [[-3 + t, -3], [-3 + t, 3], [-3, -3 + t], [3, -3 + t]]) g.set(x, 1 + (t < 4 ? t : 6 - t) + 2, z, P.wood);
  g.box(-1, 0, -1, 1, 0, 1, P.stoneDark);
  g.box(0, 1, 0, 0, 8, 0, P.metalDark);
  disc(g, 9, 4.6, P.plank);
  for (let y = 10; y <= 16; y++) disc(g, y, 4.2, (x, yy, z) => (yy === 11 || yy === 15 ? P.metalDark : shade(t0, (x + 7 * z + 50) % 2 ? 1 : 0.9)));
  for (const s of [1, -1]) clockFace(3, 13, (a, y, c, e, tag) => g.set(a * s, y, 5 * s, c, e, tag));
  for (let k = 0; k <= 4; k++) disc(g, 17 + k, 4.8 - k * 1.1, shade(t0, 0.7 + k * 0.05));
  g.set(0, 22, 0, P.gold); g.set(0, 23, 0, P.red, 1);
  for (let y = 1; y <= 9; y += 2) g.set(4, y, 3, P.iron);
}

// Libraries: a stack of books, an archive hall with columns, or scroll racks.
function library(g, r, t0) {
  pick(r, [books, archive, scrolls])(g, r, t0);
}

// Stack of chunky books: covers in tint-led colours, cream page edges, gold spine bands, a ribbon and a lit candle.
function books(g, r, t0) {
  const covers = [t0, mix(t0, hex(0xa8443a), 0.7), mix(t0, hex(0x37598a), 0.7), mix(t0, hex(0xd9a441), 0.65)];
  for (let i = covers.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [covers[i], covers[j]] = [covers[j], covers[i]]; }
  covers.unshift(t0);
  const all = [[13, 4, 9], [11, 3, 8], [10, 4, 7], [8, 3, 6], [7, 2, 5]], stack = all.slice(0, 3 + Math.floor(r() * 3));
  let y0 = 0, last;
  stack.forEach(([w, h, d], i) => {
    const ox = i ? Math.round((r() - 0.5) * 2) : 0, oz = i ? Math.round((r() - 0.5) * 2) : 0;
    const x0 = ox - (w >> 1), x1 = x0 + w - 1, z0 = oz - (d >> 1), z1 = z0 + d - 1, y1 = y0 + h - 1, cov = covers[i % covers.length], spineX = i % 2 === 0;
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

// Archive hall: stepped base, a colonnade, a tinted frieze and pediment, a glowing doorway and two braziers.
function archive(g, r, t0) {
  const marble = mix(P.paper, P.stone, 0.35), wall = mix(P.stone, t0, 0.2), cols = r() < 0.5 ? [-5, -3, 3, 5] : [-5, -2, 2, 5];
  g.box(-7, 0, -6, 7, 0, 6, P.stoneDark);
  g.box(-6, 1, -5, 6, 1, 5, P.stone);
  g.box(-5, 2, -4, 5, 7, 2, wall);
  for (const x of [-5, -3, 3, 5]) for (const z of [-4, 0]) g.box(x, 4, z, x, 6, z, P.window, 0.75);
  g.box(-1, 2, 2, 1, 5, 2, P.window, 0.7);
  for (const x of cols) { g.box(x, 2, 4, x, 7, 4, (xx, y) => (y === 2 || y === 7 ? P.stone : shade(marble, xx % 2 ? 1 : 0.95))); }
  g.box(-6, 8, -5, 6, 8, 5, P.stone);
  for (let x = -6; x <= 6; x++) g.set(x, 8, 5, x % 2 ? t0 : shade(t0, 0.8));
  for (let k = 0; k <= 6; k++) for (let x = -6 + k; x <= 6 - k; x++) for (let z = -5; z <= 5; z++) {
    const edge = x === -6 + k || x === 6 - k;
    if (edge) g.set(x, 9 + k, z, shade(t0, 0.75 + (z % 2 ? 0.05 : 0)));
    else if (z === 5) g.set(x, 9 + k, z, k === 2 && x === 0 ? P.gold : marble);
  }
  for (const x of [-6, 6]) { g.set(x, 2, 6, P.iron); g.set(x, 3, 6, P.flame, 1); }
}

// Scroll racks: two wooden racks of scrolls with tinted ties, a reading table with an open scroll and a lantern.
function scrolls(g, r, t0) {
  g.box(-7, 0, -4, 7, 0, 4, (x, y, z) => shade(P.plank, (x + z) % 2 ? 0.85 : 0.78));
  const tie = [t0, hex(0xc0392b), P.gold];
  for (const x0 of [-7, 1]) {
    const x1 = x0 + 6;
    for (const x of [x0, x1]) g.box(x, 1, -3, x, 10, -1, P.woodDark);
    for (const sy of [1, 4, 7, 10]) g.box(x0, sy, -3, x1, sy, -1, P.wood);
    g.box(x0, 1, -4, x1, 10, -4, shade(P.woodDark, 0.8));
    for (const sy of [1, 4, 7]) for (let x = x0 + 1; x < x1; x++) for (let row = 1; row <= 2; row++) {
      if (hash(x, sy + row, x0, 5) < 0.2) continue;
      const end = hash(x, sy, row, 9) < 0.5;
      g.set(x, sy + row, -1, end ? shade(P.paper, 0.9) : P.paper);
      g.set(x, sy + row, -2, hash(x, row, sy, 3) < 0.3 ? pick(r, tie) : P.paper);
    }
  }
  for (const x of [-3, 3]) for (const z of [1, 3]) g.box(x, 1, z, x, 2, z, P.woodDark);
  g.box(-4, 3, 1, 4, 3, 3, P.wood);
  g.box(-2, 4, 2, 2, 4, 2, P.paper);
  g.set(-3, 4, 2, P.woodDark); g.set(3, 4, 2, P.woodDark);
  g.set(1, 4, 1, t0);
  g.set(4, 4, 3, P.iron); g.set(4, 5, 3, P.lamp, 1); g.set(4, 6, 3, P.iron);
}

// Tools: a workbench with a monitor, a forge with a glowing ember, or a terminal kiosk.
function tool(g, r, t0) {
  pick(r, [workbench, forge, kiosk])(g, r, t0);
}

// A ">_" prompt, 5 x 3, glowing green.
const PROMPT = ['X....', '.X...', 'X..XX'];
function prompt(put) {
  for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) {
    const on = PROMPT[row][col] === 'X';
    put(col, row, on ? P.screen : mix(P.glass, P.screen, 0.12), on ? 1 : 0.15);
  }
}

// Workbench with a tinted apron, a little monitor showing a glowing ">_", keyboard, toolbox and hammer.
function workbench(g, r, t0) {
  for (const [x, z] of [[-5, -2], [5, -2], [-5, 2], [5, 2]]) g.box(x, 0, z, x, 3, z, P.woodDark);
  for (let x = -5; x <= 5; x++) if (x % 2 === 0) g.box(x, 1, -2, x, 1, 2, P.wood);
  for (let x = -6; x <= 6; x++) for (let z = -3; z <= 3; z++) {
    if (Math.abs(x) === 6 || Math.abs(z) === 3) g.set(x, 4, z, shade(t0, 0.9));
    g.set(x, 5, z, Math.abs(x) === 6 || Math.abs(z) === 3 ? P.wood : shade(P.plank, z % 2 ? 1 : 0.92));
  }
  g.box(-1, 6, -3, 1, 6, -2, P.metalDark);
  g.set(0, 7, -3, P.metalDark);
  g.box(-3, 8, -3, 3, 12, -2, P.iron);
  prompt((col, row, c, e) => g.set(col - 2, 11 - row, -2, c, e));
  g.box(-2, 6, 0, 2, 6, 1, P.metalDark);
  for (let x = -2; x <= 2; x++) g.set(x, 6, 1, P.metal);
  g.box(3, 6, -1, 5, 7, 1, t0);
  g.box(3, 8, 0, 5, 8, 0, P.metal);
  g.set(4, 8, 0, P.iron);
  g.box(-5, 6, 1, -3, 6, 1, P.wood);
  g.box(-5, 6, 0, -5, 7, 2, P.metal);
}

// Forge: brick hearth with glowing embers, tinted hood and a tall chimney, an anvil with a hot ingot, a water bucket.
function forge(g, r, t0) {
  g.box(-7, 0, -4, 6, 0, 4, P.stoneDark);
  const brick = (x, y, z) => shade(mix(hex(0x9a5a44), P.stone, 0.3), (y + (x + z) % 2) % 2 ? 1 : 0.88);
  g.box(-6, 1, -4, -1, 4, 0, brick);
  for (let x = -5; x <= -2; x++) for (let y = 2; y <= 3; y++) g.set(x, y, 0, y === 2 ? P.ember : P.flame, y === 2 ? 1 : 0.7);
  g.box(-5, 2, -1, -2, 2, -1, P.ember, 1);
  g.box(-6, 5, -4, -1, 5, 1, shade(t0, 0.85));
  g.box(-5, 6, -3, -2, 6, 0, shade(t0, 0.75));
  g.box(-4, 7, -3, -3, 12, -2, brick);
  g.box(-4, 13, -3, -3, 13, -2, P.iron);
  if (r() < 0.6) g.set(-4, 14, -2, P.ember, 0.6);
  g.box(2, 1, 0, 3, 2, 0, P.iron);
  g.box(1, 3, -1, 4, 3, 1, P.iron);
  g.set(5, 3, 0, P.iron);
  g.set(3, 4, 0, P.ember, 1);
  g.box(4, 1, 2, 5, 2, 3, P.woodDark);
  g.box(4, 2, 2, 5, 2, 3, P.led, 0.3);
  g.box(0, 1, -3, 1, 1, -2, P.iron);
  g.set(0, 2, -3, P.iron);
  g.box(-1, 1, 2, -1, 3, 2, P.woodDark);
  g.set(-1, 4, 2, P.metal);
}

// Terminal kiosk: a tinted cabinet with a big ">_" screen, keyboard ledge, glowing marquee and a striped cap.
function kiosk(g, r, t0) {
  g.box(-5, 0, -4, 5, 0, 4, P.stoneDark);
  g.box(-3, 1, -2, 3, 11, 1, (x, y) => shade(t0, 0.85 + (y % 3 === 0 ? 0.08 : 0)));
  g.box(-3, 6, 2, 3, 6, 3, P.metalDark);
  for (let x = -2; x <= 2; x++) g.set(x, 6, 3, x % 2 ? P.metal : P.metalDark);
  g.box(-3, 7, 2, 3, 7, 2, P.iron);
  g.box(-3, 8, 1, 3, 11, 1, P.iron);
  prompt((col, row, c, e) => g.set(col - 2, 10 - row, 1, c, e));
  g.box(-3, 12, -2, 3, 13, 1, P.iron);
  for (let x = -2; x <= 2; x++) g.set(x, 12, 2, mix(t0, [1, 1, 1], 0.4), 0.8);
  for (let x = -4; x <= 4; x++) for (let z = -3; z <= 2; z++) g.set(x, 14, z, (x + 10) % 2 ? t0 : P.paper);
  g.box(-1, 1, -3, 1, 4, -3, P.metalDark);
  g.set(0, 3, -4, P.led, 1);
  if (r() < 0.6) { g.box(4, 1, 1, 4, 2, 1, P.woodDark); g.box(3, 3, 1, 4, 3, 2, P.wood); }
}

/* ---------------- externals ---------------- */

// opts.name: the external's name (a SaaS kiosk shows its initial).
export function externalModel(kind, seed, tint, opts = {}) {
  const g = grid(seed), r = g.rand, t0 = rgb(tint);
  const crates = ({ db, queue, storage, cloud, saas, other })[kind](g, r, t0, opts);
  const model = g.done()[0];
  if (crates) model.anim = { crates: Array.from({ length: crates }, (_, i) => model.anim['crate' + i]) };
  return model;
}

// Databases: three stacked drums, a tall silo, or a wide tank.
function db(g, r, t0) {
  pick(r, [drums, silo, tank])(g, r, t0);
}

// Three stacked tinted drums with glowing seams (the database icon), metal lid and dome.
function drums(g, r, t0) {
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

// Silo: tall tinted cylinder with metal hoops and glowing bands, a dome, a ladder and a beacon.
function silo(g, r, t0) {
  disc(g, 0, 4.4, P.stoneDark);
  const h = 14 + Math.floor(r() * 4);
  for (let y = 1; y <= h; y++) disc(g, y, 3.6, y % 5 === 0 ? (y % 10 === 0 ? mix(P.led, t0, 0.3) : P.metal) : shade(t0, 0.9 + (y % 2) * 0.05), y % 10 === 0 ? 0.5 : 0);
  for (let y = 1; y <= 3; y++) disc(g, h + y, Math.sqrt(13 - y * y * 1.3), shade(mix(t0, P.metal, 0.4), 0.95 + y * 0.04));
  g.set(0, h + 4, 0, P.red, 1);
  for (let y = 1; y <= h; y++) { g.set(-1, y, 4, P.iron); g.set(1, y, 4, P.iron); if (y % 2 === 0) g.set(0, y, 4, P.metalDark); }
  g.set(3, 2, 3, P.screen, 1);
}

// Tank: wide squat tinted tank with ribs, a railed shallow roof, a glowing gauge and an outlet pipe.
function tank(g, r, t0) {
  for (let y = 0; y <= 5; y++) disc(g, y, 5.4, (x, yy, z) => (y === 0 || y === 5 || (Math.abs(x) === Math.abs(z) && x) ? P.metalDark : shade(t0, 0.9 + yy * 0.02)));
  disc(g, 6, 4.4, mix(t0, P.metal, 0.5));
  disc(g, 7, 2.4, mix(t0, P.metal, 0.6));
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) if (Math.abs(Math.hypot(x, z) - 4.8) < 0.5 && (x + z) % 2 === 0) g.set(x, 6, z, P.iron);
  g.box(-1, 2, 6, 1, 4, 6, P.iron);
  g.set(0, 3, 6, P.screen, 1);
  g.box(6, 1, 0, 7, 1, 0, P.metal);
  g.box(7, 0, 0, 7, 0, 0, P.metalDark);
  g.set(5, 3, -3, P.led, 1);
}

// Queues: a conveyor with riding crates, or a pipe with a valve wheel and glowing sight glasses.
function queue(g, r, t0) {
  return r() < 0.6 ? conveyor(g, r, t0) : pipe(g, r, t0);
}

// Short conveyor: legs, tinted side rails with flow lights, dark slatted belt, three crates (anim.crates, one index list per crate).
function conveyor(g, r, t0) {
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

// Pipe: a fat tinted pipe on two stands, flanges, glowing sight glasses along it, a valve wheel on top.
function pipe(g, r, t0) {
  const cy = 4;
  for (const x of [-5, 5]) { g.box(x, 0, -2, x, 2, 2, P.metalDark); g.box(x - 1, 0, -2, x + 1, 0, 2, P.stoneDark); }
  for (let x = -8; x <= 8; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) {
    const d = y * y + z * z, flange = Math.abs(x) === 8 || Math.abs(x) === 3;
    if (d > (flange ? 6 : 3.5)) continue;
    const glass = !flange && z === 1 && y === 1 && x % 2 === 0;
    g.set(x, cy + y, z, flange ? P.metal : glass ? mix(P.led, t0, 0.3) : shade(t0, 0.9 + y * 0.04), glass ? 0.8 : 0);
  }
  g.box(0, cy + 2, 0, 0, cy + 4, 0, P.metalDark);
  const wheel = r() < 0.5 ? P.red : P.gold;
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    const d = x * x + z * z;
    if ((d >= 3 && d <= 5) || ((x === 0 || z === 0) && d <= 4)) g.set(x, cy + 5, z, d >= 3 ? wheel : P.metalDark);
  }
  g.box(1, cy + 2, -2, 1, cy + 3, -2, P.metalDark);
  g.set(1, cy + 3, -3, P.screen, 1);
}

// Storage: a treasure chest, a stack of crates, or a vault door.
function storage(g, r, t0) {
  pick(r, [chest, crates, vault])(g, r, t0);
}

// Treasure chest: tinted panels, dark wood frame, metal straps, gold lock, warm light leaking from the lid seam.
function chest(g, r, t0) {
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

// Crate stack on a pallet: 5x5x5 crates with dark edges, plank faces and tinted labels, a lantern on top.
function crates(g, r, t0) {
  g.box(-8, 0, -3, 8, 0, 3, P.woodDark);
  const crate = (cx, cy, cz, c) => {
    for (let x = cx; x < cx + 5; x++) for (let y = cy; y < cy + 5; y++) for (let z = cz; z < cz + 5; z++) {
      const ex = (x === cx || x === cx + 4) + (y === cy || y === cy + 4) + (z === cz || z === cz + 4);
      g.set(x, y, z, ex >= 2 ? P.woodDark : y === cy + 2 && (x === cx + 2 || z === cz + 2) ? t0 : shade(c, (x + y + z) % 2 ? 1 : 0.92));
    }
  };
  const spots = [-8, -2, 4].filter(() => r() < 0.8);
  if (!spots.length) spots.push(-2);
  spots.forEach((x) => crate(x, 1, -2, mix(P.plank, P.wood, r() * 0.4)));
  const up = spots.length === 3 && r() < 0.5 ? [spots[0], spots[2]] : [spots[0]];
  up.forEach((x) => crate(x + Math.round(r()), 6, -2 - Math.round(r()), mix(P.plank, t0, 0.2)));
  g.set(up[0] + 2, 11, 0, P.iron); g.set(up[0] + 2, 12, 0, P.lamp, 1); g.set(up[0] + 2, 13, 0, P.iron);
}

// Vault: a stone wall with a round tinted metal door, gold bolts, a glowing seam, a spoked wheel and a keypad.
function vault(g, r, t0) {
  g.box(-7, 0, -3, 7, 0, 2, P.stoneDark);
  g.box(-6, 1, -2, 6, 12, 0, (x, y) => shade(mix(P.stone, P.stoneDark, 0.5), (x + y * 3) % 5 === 0 ? 0.9 : 1));
  g.box(-7, 13, -3, 7, 13, 1, P.stone);
  const cy = 6.5, door = mix(P.metal, t0, 0.4);
  for (let x = -5; x <= 5; x++) for (let y = 1; y <= 12; y++) {
    const d = Math.hypot(x, y - cy);
    if (d > 5.3) continue;
    if (d > 4.6) g.set(x, y, 1, P.gold, 0.4);
    else { g.set(x, y, 1, shade(door, 0.9 + (d < 2 ? 0.1 : 0))); if (Math.abs(d - 3.8) < 0.4 && (x + y) % 2) g.set(x, y, 2, P.gold); }
  }
  for (let k = -2; k <= 2; k++) { g.set(k, 6, 2, P.iron); g.set(0, 6 + k, 2, P.iron); }
  g.set(0, 6, 3, P.metalDark);
  g.box(-1, 7, 2, 1, 7, 2, P.iron);
  g.box(5, 5, 1, 5, 6, 1, P.iron); g.set(5, 6, 2, P.led, 1); g.set(5, 5, 2, P.screen, 1);
}

// Fluffy cloud with a cave in front showing a small server rack with blinking LEDs. The seed shapes the puffs:
// how many, how wide and how tall the cloud spreads.
function cloud(g, r, t0) {
  const spread = 4 + r() * 2.5, lift = 3 + r() * 2.5, n = 4 + Math.floor(r() * 4);
  const puffs = [[0, 5, 0, 4.4 + r() * 0.6], [0, 3, 2.5, 3]];
  for (let i = 0; i < n; i++) {
    const s = (i % 2 ? 1 : -1) * (0.4 + r() * 0.6);
    puffs.push([s * spread, 3 + r() * lift, (r() - 0.5) * 3, 2.4 + r() * 1.4]);
  }
  const white = mix(P.cloud, t0, 0.12), under = mix(P.cloudShade, t0, 0.2);
  for (let x = -11; x <= 11; x++) for (let y = 0; y <= 13; y++) for (let z = -6; z <= 6; z++) {
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

// SaaS: a signpost, or a little kiosk with the service's initial glowing on its sign.
function saas(g, r, t0, opts) {
  return r() < 0.5 ? signpost(g, r, t0) : saasKiosk(g, r, t0, opts);
}

// Signpost on a little mound: two tinted arrow boards and a hanging lantern.
function signpost(g, r, t0) {
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

// 3x5 capital letters, rows top to bottom.
const FONT = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111', F: '111100110100100',
  G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100', Q: '010101101110011', R: '110101110101101',
  S: '011100010001110', T: '111010010010010', U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111',
};

// Kiosk: counter and back wall in the tint, a striped awning, a dark sign board with a glowing initial on top.
function saasKiosk(g, r, t0, { name = '' }) {
  const letter = FONT[(name.match(/[a-z]/i) || [])[0]?.toUpperCase()] || FONT[pick(r, Object.keys(FONT))];
  g.box(-5, 0, -4, 5, 0, 4, P.stoneDark);
  g.box(-4, 1, 1, 4, 3, 2, shade(t0, 0.9));
  g.box(-4, 4, 1, 4, 4, 3, P.plank);
  g.box(-4, 1, -3, 4, 8, -3, shade(t0, 0.75));
  for (const x of [-4, 4]) g.box(x, 5, 2, x, 8, 2, P.woodDark);
  for (let x = -5; x <= 5; x++) for (let z = -4; z <= 3; z++) g.set(x, 9, z, (x + 10) % 2 ? t0 : P.paper);
  for (let x = -5; x <= 5; x++) g.set(x, 8, 3, (x + 10) % 2 ? t0 : P.paper);
  g.box(-3, 10, -1, 3, 16, -1, P.iron);
  for (let i = 0; i < 15; i++) if (letter[i] === '1') g.set((i % 3) - 1, 15 - Math.floor(i / 3), 0, mix(t0, [1, 1, 1], 0.55), 0.9);
  g.set(-2, 5, 2, P.screen, 0.8); g.set(2, 5, 2, P.lamp, 1);
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
