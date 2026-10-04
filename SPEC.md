# Ariadne: data format and API

## Files

```
ariadne.py        CLI: build | assemble | serve   (Python 3 stdlib only)
viewer/           the 3D app: ES modules + CSS, three.js from a CDN, no build step
SCHEMA.md         what mapping agents write (parts)
DESIGN.md         visual design brief
```

## 1. Parts

Mapping agents write `parts-*.json` files, each `{"parts": [...]}`. See [SCHEMA.md](SCHEMA.md).

## 2. map.json (made by `ariadne.py assemble`, read by the viewer)

```jsonc
{
  "title": "shop",
  "summary": "One or two sentences: what the whole system does.",
  "revision": "1a2b3c4 2026-01-31",
  "clusters": [ {"id": "checkout", "name": "Checkout", "summary": "one line", "color": "#38bdf8"} ],
  "parts": [ /* part schema + */ {"cluster": "checkout", "size": 1234 /* lines of code */} ],
  "externals": [ {"id": "Postgres", "kind": "db | queue | cloud | saas | storage | other"} ],
  "links": [ {"from": "orders-api", "to": "payments-worker", "how": "Kafka: order.created", "weight": 3} ],
  "systemFlows": [ {"title": "A customer checks out", "steps": [ {"from": "web", "to": "orders-api", "text": "...", "ref": "path:line"} ]} ],
  "code": { "services/orders-api/store.go:42": {"start": 36, "lines": ["..."], "verified": true} },
  "changes": { "orders-api": 4 }   // optional: files changed per part since --base
}
```

- Every `ref` has an entry in `code` (±6 lines). `verified` is false when the file/line is missing or `fn` is not within 5 lines; the viewer marks those with ⚠.
- Flow actors (`from`/`to`) are a part id, an external id, or a function local to that part.
- `links` come from parts' `uses` plus matching `publishes`/`subscribes` topics.

## 3. Server API (`ariadne.py serve map.json --repo <dir>`)

| Endpoint | Returns |
|---|---|
| `GET /` , `/*.js`, `/*.css` | the viewer |
| `GET /map.json` | the map |
| `GET /api/tree?dir=` | `{"files": [...]}` repo files under a folder |
| `GET /api/file?path=` | `{"path", "lines": [...]}` a whole text file (confined to the repo) |
| `GET /api/grep?q=&dir=` | `{"hits": [{"ref", "text", "def"}]}` whole-word identifier search, definitions first |
| `GET /api/structure?part=` | `{"status", "nodes": [...], "calls": [[i,j]], "uses": [[fn,type]]}` functions, types, methods and their links (via code-review-graph) |
| `GET /api/agents` | `{"agents": [{"id", "installed", "models"}]}` chat backends |
| `POST /api/chat` | `{"reply", "actions"}` |

`POST /api/chat` body: `{"agent": "claude|pi|opencode|codex", "model": "...", "messages": [{"role", "content"}], "view": {"focus", "flow"}}`.
The chosen CLI runs read-only in the repo with the map and the action protocol in its prompt; a trailing ```actions JSON block becomes `actions`.

## 4. View actions

- `{"type": "focus", "id": "<part|cluster|external id>"}` fly there
- `{"type": "play", "flow": "<partId>#<index>" | "system#<index>"}` play a flow
- `{"type": "highlight", "ids": [...]}` highlight these, dim the rest
- `{"type": "filter", "kinds": ["service","job","library","tool"]}`
- `{"type": "overview"}`
- `{"type": "code", "ref": "path:line"}` open the code

Run them from the console with `window.ariadne.act(action)`, or from a link: `http://host:7777/#act=<url-encoded JSON array>`.
