# Metro + Lens: contract between server and viewer

The code view of a part. It replaces the layered "call board".

## Server: `GET /api/structure?part=<id>` adds two fields (existing fields unchanged)

```jsonc
{
  "status": "ready", "nodes": [...], "calls": [[i, j]], "uses": [[fn, type]],
  "lines": [
    {
      "id": "L0",
      "label": "POST /orders",        // from the part's `exposes` when an entry is registered there, else the root function name
      "kind": "http | pubsub | cron | cli | rpc | function",
      "entry": 12,                     // node index of the first station
      "trunk": [12, 40, 41, 77],       // main path in call order: at each step, follow the callee that reaches the most nodes
      "branches": [ {"from": 40, "nodes": [55, 56]} ],   // side calls off a trunk station, max depth 2; deeper is counted in "more"
      "more": 3,                       // stations reachable but not drawn
      "reach": 27                      // total distinct nodes this entry reaches
    }
  ],
  "effects": { "77": [ {"target": "Postgres", "kind": "db", "ref": "path:line"} ] }   // node index -> outside systems it touches
}
```

Rules:
- Entry points are (a) functions referenced on the source line of an `exposes` ref in map.json (the route or subscription registration), labelled with `exposes[].what`, plus (b) call-graph roots with no in-part callers, excluding tests, ranked by `reach`. Drop roots with reach < 2. Order lines: exposes first, then by reach. Cap at 12 lines, and say how many were dropped in `"hiddenLines": N` at the top level.
- A line never visits a node twice. Cycles end the path.
- `effects` come from the part's `uses` refs and flow steps whose `to` is an external: the ref's line falls inside node [line, end], take the smallest enclosing node. `kind` is the external's kind from map.json.
- Deterministic.

## Viewer

- Metro map on an upright board under the part, same place as the call board.
  - Each line is a coloured route running left to right through its trunk stations in order. Branches are short spurs.
  - Files and folders are soft tinted background zones that the stations sit in, labelled.
  - A station used by 2+ lines is an interchange: a white ring, and the lines visually converge on it.
  - Effects are small badges at the station, with the same shapes and icons as the external kinds.
  - Octilinear (0/45/90°) segments with rounded corners. Calm, no web. "+N more" stubs.
- Line list: a legend of lines with toggles.
  - Hover a line to highlight its route and dim the rest.
  - ▶ rides it: a train pulse goes station by station, the camera follows gently, captions show "Create → Schedule", and voice speaks them (voice.js).
- Lens: click a station and it opens around that station.
  - Callers on the left, callees on the right, grouped into file cards, each with arrows into or out of the centre.
  - Click a caller or callee to re-centre with a smooth slide. Breadcrumb trail.
  - "Open code" opens the drawer at file:line.
  - Esc returns to the metro.
- Data types: shown in the Lens as "uses types" chips. On the metro, a station's tooltip/readout lists the types it uses.
