# Ariadne visual design: "what if Apple made it"

Direction: visionOS meets a pro Apple app. Calm, precise, crisp. Futuristic through restraint and craft, not neon.

## Principles
- Clarity first: every element must read instantly; decoration never competes with content.
- Deference: the code map is the content; chrome (panels, HUD) recedes.
- Depth: real light, soft shadows, glass layers give hierarchy, not glow.
- One accent: a single active colour; everything else is calm neutrals plus muted domain tints.

## Rendering quality
- Anti-aliasing: MSAA render target (or SMAA pass) after bloom; devicePixelRatio up to 2.
- Lines: `Line2`/`LineMaterial` (fat lines) with constant screen-space width (1–1.5px default, 2px active). No glow on idle lines.
- Text: Inter (Google Fonts) for UI, JetBrains Mono for code identifiers; tabular numbers; labels rendered at device resolution (CSS or SDF), never blurry textures.
- Bloom only on the active/selected element and flow pulse; threshold high, strength low.

## Materials and light
- `MeshPhysicalMaterial`: low roughness glass (transmission off for perf; fake with fresnel + opacity), clearcoat on solid nodes.
- Environment: small `RoomEnvironment` PMREM for soft reflections; one key light + soft fill.
- Soft contact shadows under platforms (baked radial gradient planes, cheap).
- Subtle distance fog / depth fade for far objects.

## Shapes
- Rounded/bevelled geometry everywhere (RoundedBoxGeometry, bevelled extruded hexagons, smooth cylinders 48+ segments).
- Icons: SF Symbols style (Lucide at 1.5px stroke), drawn crisply.
- Consistent proportions and a 4/8px spatial rhythm in screen-space UI.

## Colour
- Background: near-black blue-grey (#0b0d12 → #11141b vertical gradient), no stars.
- Neutrals: 5-step grey scale for text (#f5f7fa, #c9ced8, #8b93a3, #5b6272, #343a46).
- Domain tints: muted, equal-luminance (e.g. oklch L≈0.72, C≈0.09), used at low opacity on surfaces, full on small marks.
- Accent (active/selection): one colour (e.g. #5ac8fa systemCyan-like). Callers/callees/uses: amber, cyan, green at matching luminance.

## Panels (HUD, drawer, readout, chat, settings)
- Frosted glass: `backdrop-filter: blur(24px) saturate(160%)`, rgba(22,25,33,0.62), 0.5px hairline border rgba(255,255,255,0.08), radius 14–18px, soft shadow 0 8px 32px rgba(0,0,0,.35).
- Type scale: 11 / 13 / 15 / 20 / 28; weights 400/500/600; generous line-height; consistent 12/16/24px padding.
- Controls: pill buttons, segmented controls, subtle hover states, focus rings.

## Motion
- Spring easing (critically damped) for camera and panels; 250–450ms; no linear moves.
- Fades and scale-ins at 0.96→1 for panels; labels fade, never pop.
- Respect `prefers-reduced-motion`.

## Performance guardrails
- Keep instancing; shared geometries/materials; no per-frame allocations.
- Target 60fps on a laptop GPU with a large real-world map (50+ parts); measure frame time before/after.

## Second look: Voxel
- Settings → Appearance: Glass (default) | Voxel, saved in localStorage `ariadne.theme`; `?theme=voxel` forces it. Switching reloads.
- Only the world changes (voxel.js + models in voxels.js); layout, picking, LOD, flows, labels, HUD, metro board, Lens and drawer are shared.
- Style: MagicaVoxel-like renders, not Minecraft. Floating islands per domain and dock, small procedural models per kind, a voxel cart for flows.
- Rendering: instanced unit cubes, sun with PCF soft shadows following the focus, GTAO, ACES, cool-to-warm sky, gentle fog, bloom on emissive voxels only.
- Faded things bleach toward the fog instead of turning see-through; the world dissolves (ordered dither) and the sky dims when a call board opens.

## Every UI surface (apply the above consistently)
- Top bar: title + summary panel, search field (Spotlight-like: centered, large, frosted, live results with icons and kind labels), controls hint, settings gear.
- Detail panel: header with kind/domain pills, title, path; sections with small caps headers; lists with icons, hover rows, disclosure chevrons.
- Hover readout and leader line: compact, frosted, crisp; no clutter.
- Code drawer: editor-grade (think Xcode): file tree with SF-style folder/file icons, tabs-like breadcrumb, refined dark syntax theme matching the palette, current-line highlight, smooth scroll, refined scrollbars, grep popover as a frosted menu.
- Flow player: media-controls bar (play/pause/step/speed as SF-style icons, scrubber with step ticks), caption typography.
- Chat dock: iMessage-grade bubbles, composer with send button, agent/model pill, typing indicator, markdown with code chips.
- Settings: macOS-style sheet with segmented control for agent, searchable model list, clear selected state.
- Legend, minimap, breadcrumb, filters: minimal, consistent icons and spacing.
- States: loading (skeleton shimmer, not spinners), empty, error (inline, calm), building-structure progress.
- Scrollbars, focus rings, selection colour, tooltips, keyboard shortcut hints (⌘P, /, Esc) rendered as keycaps.
- Responsive: phone layout as bottom sheets; touch targets ≥ 44px.
