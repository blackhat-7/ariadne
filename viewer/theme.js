// theme.js
// Exports: THEME, oklch, mute, SVG, KINDS, EXT, PORTS, kindOf, extOf, initVocabulary
// Imports: (nothing)


// Colour: oklch (L 0..1, C, hue°) -> '#rrggbb' (sRGB, gamut-clipped). Domain tints share one lightness so no group shouts.
export function oklch(L, C, h) {
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  return '#' + lin.map((x) => { x = Math.min(1, Math.max(0, x)); x = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055; return Math.round(x * 255).toString(16).padStart(2, '0'); }).join('');
}

// Any '#rrggbb' -> the muted domain tint with the same hue (map data brings saturated cluster colours).
export function mute(hex) {
  const n = parseInt(String(hex).slice(1), 16), lin = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]), m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]), s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, b = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return oklch(0.72, Math.min(0.09, Math.hypot(a, b)), Math.atan2(b, a) * 180 / Math.PI);
}

const tint = (h, c = 0.09) => oklch(0.72, c, h);

// 3D colours and material parameters, shared by scene.js, board.js and drawer.js (CSS colours live in base.css).
export const THEME = {
  bgTop: '#0b0d12', bgBottom: '#11141b', bg: 0x0e1117,
  bloom: { strength: 0.32, radius: 0.35, threshold: 0.92 },
  grid: { major: 0x252b36, minor: 0x181c24 },
  orbit: { color: '#8b93a3', opacity: 0.22 },
  accent: '#5ac8fa', neutral: '#8b93a3', amber: tint(75, 0.12),
  link: '#c9ced8', track: tint(200, 0.08), fnNode: '#5ac8fa', pulse: 0xffffff, trail: 0x5ac8fa, beacon: tint(75, 0.12),
  shadow: 0.6,
  board: { edge: '#8b93a3', bundle: '#5b6272', dead: '#5b6272', text: '#c9ced8', textSelf: '#f5f7fa', textStub: '#8b93a3' },
};

export let SVG, KINDS, EXT, PORTS, kindOf, extOf;



export function initVocabulary() {
  /* ---------------- vocabulary ---------------- */
  SVG = (d) => `<svg class="ico" viewBox="0 0 16 16">${d}</svg>`;
  KINDS = {
    service: { color: tint(225), label: 'Service', icon: SVG('<circle cx="8" cy="8" r="5.5"/>') },
    job: { color: tint(300), label: 'Job', icon: SVG('<path d="M8 1.8l6.2 6.2L8 14.2 1.8 8z"/>') },
    library: { color: tint(150), label: 'Library', icon: SVG('<rect x="2.5" y="2.5" width="11" height="11"/>') },
    tool: { color: tint(80), label: 'Tool', icon: SVG('<path d="M8 2l6.5 11.5h-13z"/>') },
  };
  EXT = {
    db: { color: tint(255), label: 'Database', plural: 'Databases', icon: SVG('<ellipse cx="8" cy="3.8" rx="5.5" ry="2"/><path d="M2.5 3.8v8.4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V3.8M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>') },
    queue: { color: tint(350), label: 'Queue / events', plural: 'Queues / events', icon: SVG('<path d="M2 5h9M2 8h12M2 11h9"/><path d="M11.5 5.5L14 8l-2.5 2.5"/>') },
    cloud: { color: tint(240, 0.05), label: 'Compute', plural: 'Cloud compute', icon: SVG('<path d="M4.6 12.5h7a3 3 0 0 0 .3-6 4 4 0 0 0-7.6-1.1 3.6 3.6 0 0 0 .3 7.1z"/>') },
    saas: { color: tint(50), label: 'SaaS / API', plural: 'SaaS / APIs', icon: SVG('<path d="M8 1.8l6.2 6.2L8 14.2 1.8 8z"/><circle cx="8" cy="8" r="1.6"/>') },
    storage: { color: tint(185), label: 'Storage', plural: 'Storage', icon: SVG('<rect x="2" y="3" width="12" height="4.2" rx="1"/><rect x="2" y="8.8" width="12" height="4.2" rx="1"/>') },
    other: { color: tint(260, 0.02), label: 'Other', plural: 'Other', icon: SVG('<circle cx="8" cy="8" r="5"/>') },
  };
  PORTS = {
    http: { label: 'HTTP', color: tint(230, 0.12) }, pubsub: { label: 'PUBSUB', color: tint(350, 0.12) }, cron: { label: 'CRON', color: tint(80, 0.12) },
    cli: { label: 'CLI', color: tint(125, 0.12) }, rpc: { label: 'RPC', color: tint(290, 0.12) }, function: { label: 'FN', color: tint(150, 0.12) },
  };
  kindOf = (p) => KINDS[p.kind] ? p.kind : 'service';
  extOf = (e) => EXT[e.kind] ? e.kind : 'other';
}
