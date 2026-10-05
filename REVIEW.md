# PR review: contract

`ariadne pr [--base REV] [--pr N] [folder]` reviews the current checkout (HEAD plus uncommitted changes) against
`--base` (default: the default branch, `origin/HEAD` → main/master/dev). Like GitHub, the diff starts at the merge-base
with the base, and a remote base (`origin/…`) is fetched first. `--pr N` fetches the PR's title, description and URL
with `gh`, and its target branch becomes the base. It serves the usual viewer with the review loaded (`/#review` opens it).
Everything except the optional narrative is deterministic: syntax trees (`ariadne_xray`) and git, never a model.

## Review JSON: `GET /api/review`

```jsonc
{
  "status": "ready" | "building" | "error", "error": "…",
  "base": { "rev": "a1b2c3d…", "short": "a1b2c3d", "ref": "origin/main" },
  "head": { "rev": "…", "short": "…", "dirty": true },
  "pr": { "number": 123, "title": "…", "body": "…", "url": "…" } | null,
  "files": [ { "path": "src/checkout/main.go", "status": "modified" | "added" | "deleted" | "renamed", "old": "…" | null,
               "part": "checkout" | null, "added": 12, "removed": 3, "generated": false, "test": false } ],
  "functions": [ {
      "id": "src/checkout/main.go::PlaceOrder",
      "name": "PlaceOrder", "parent": "checkout" | null, "file": "src/checkout/main.go", "part": "checkout",
      "status": "modified" | "added" | "removed",
      "base": { "start": 306, "end": 425 } | null, "head": { "start": 306, "end": 431 } | null,
      "changes": [ {
          "kind": "condition" | "error_check" | "return" | "throw" | "effect" | "call" | "loop" | "literal" | "signature" | "gate",
          "op": "added" | "removed" | "changed",
          "before": "err != nil" | null, "after": "err == nil" | null,       // code text (x-ray text or literal)
          "base_line": 340 | null, "head_line": 340 | null,
          "target": "Postgres" | null,                                       // effects
          "severity": "high" | "medium" | "low",
          "why": "Error check inverted"                                        // short, deterministic phrase
      } ],
      "risk": "high" | "medium" | "low" | "none",                             // max severity
      "blast": { "entries": [ { "part": "checkout", "line": "L0", "label": "CheckoutService.PlaceOrder (gRPC)" } ],
                 "callers": [ "main" ] }
  } ],
  "gates": [ { "id": "env:KAFKA_ADDR", "name": "KAFKA_ADDR", "kind": "env" | "flag", "op": "added" | "removed" | "changed",
               "refs": [ "src/checkout/main.go:418" ] } ],
  "parts": [ { "id": "checkout", "risk": "high", "functions": [ "src/checkout/main.go::PlaceOrder" ], "lines": [ "L0", "L2" ] } ],
  "stats": { "files": 4, "functions": { "added": 1, "removed": 0, "modified": 3 }, "high": 2, "medium": 3, "low": 5 },
  "tour": [ "src/checkout/main.go::PlaceOrder", "…" ]   // changed functions in call order from the entry points, then the rest
}
```

SQL (`.sql` files): each sqlc named query (`-- name: X :kind`) is a function with `"kind": "query"` and its comment as
`"summary"`; its changes say what it reads or writes and its literal guards (`WHERE job_state = 'scheduled'`); a
removed guard is high. Migrations (other `.sql`, not `*.down.sql`) give `"schema": [{kind: table|enum|index|column,
op, name, detail: [...], ref}]`. `"lifecycles": [{table, field, states, start, transitions: [{from, to, via, ref}]}]`
come from `UPDATE … SET col = 'to' … WHERE col = 'from'` on state-like or enum columns; a new row starts at the
column's default. Generated files (`generated/` folders, "Code generated … DO NOT EDIT" headers) are listed, not reviewed.

Severity rules (deterministic):
- high: error check removed or condition of an error check changed/inverted; error return/throw removed; condition
  inverted (`==`↔`!=`, `<`↔`>=`, added/removed `!`); effect added/removed on db, queue, storage, payment or other
  write-like targets; signature change of a function that has callers outside its file; env/flag gate removed.
- medium: other condition changes; literal changes in conditions, timeouts, limits, retries, sizes, durations; effect
  added/removed on other targets; loop added/removed; gate added.
- low: call added/removed; other literal changes; returns changed without error semantics.
- Generated and test files are listed (flags `generated`/`test`) but their functions are not analysed.

## Diff for the code panel: `GET /api/diff?file=<path>`
`{ "path", "old": "<old path>"|null, "base": [lines]|null, "head": [lines]|null, "hunks": [ { "base_start", "base_len", "head_start", "head_len" } ] }`

## Base-side x-ray: `GET /api/xray?file=<path>&line=<n>&rev=base`
Same as `/api/xray`, computed on the base version of the file (from git), lines in base numbering.

## Narrative (optional): `POST /api/review/narrative` body `{agent, model}`
→ `{ "summary": "2-3 sentences", "items": [ { "text": "…", "refs": ["path:line"] } ], "mismatches": [ "…" ] }`.
Built from the review JSON (facts, not raw guesses) plus the changed hunks; refs are verified like the map's.
`mismatches` compares the PR description (when `--pr` was given) with the facts. Cached by prompt hash.

## Branches, pull requests and the map
- `GET /api/branches[?fresh=1]` → `{current, dirty, default, branches: [{name, rev, short, updated, ahead, behind, remote}],
  prs: [gh pr list JSON] | null, prs_error, selected: {head, base}}`. Cached for 60 s (gh is slow).
- `POST /api/review/select {head, base?}` → the review JSON. `head`: null (the checkout with uncommitted changes), a
  branch or revision, or `"pr:N"` (fetched from origin). One selection per server.
- `GET /api/map/status` → `{shown, built, parts_total, parts_changed, needs_model, est_tokens: [lo, hi],
  est_seconds: [lo, hi], progress}`: how far the shown map is from the selected head and what a refresh costs.
- `POST /api/map/refresh {agent?, model?}` updates the map for the reviewed head in the background: it maps only the
  parts holding the change's files (and not already cached for that content); every other part is kept from the shown
  map as it is, so a PR costs its own parts. `GET /api/map/status` lists them in `parts`. The viewer starts a small
  update by itself (≤ 6 parts, ≤ ~1M tokens) with the model picked in Settings, shows its progress, and asks first
  for anything larger or when no model is picked.
- `GET /api/map/progress` → `{phase: "checking out" | "mapping" | "assembling" | "loading" | "done", elapsed, done,
  error, batches: [done, total] | null, reads}`.
