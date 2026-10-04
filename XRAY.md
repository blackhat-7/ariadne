# Below function level: x-ray, gates, states

Contract between the extractors (`ariadne_xray.py`, `ariadne_gates.py`), the server (`ariadne.py`) and the viewer.
Structure always comes from the syntax tree (tree-sitter via `tree-sitter-language-pack`), never from a model.
Every node carries an exact `line`; the viewer opens the code there.

## 1. Function x-ray: `GET /api/xray?file=<repo path>&line=<any line inside the function>`

```jsonc
{
  "status": "ready" | "unsupported" | "error",
  "error": "…",                       // when not ready
  "fn": { "name": "CreateJob", "file": "pkg/scheduler/scheduler.go", "start": 693, "end": 749, "lang": "go" },
  "nodes": [
    { "id": "n0", "kind": "entry", "line": 693, "text": "func (s *TrainingScheduler) CreateJob(ctx, msg)" },
    { "id": "n1", "kind": "decision", "line": 697, "text": "_, err := types.ParseExecutor(provider); err != nil" },
    { "id": "n2", "kind": "return", "line": 698, "text": "return \"\", errors.Wrap(err, ...)", "error": true },
    { "id": "n3", "kind": "loop", "line": 696, "text": "for _, provider := range msg.Providers" },
    { "id": "n4", "kind": "call", "line": 708, "text": "s.getEnabledProviders(msg)", "callee": "getEnabledProviders" },
    { "id": "n5", "kind": "effect", "line": 760, "text": "s.nomadClient.Jobs().Register(&job, nil)", "callee": "Register", "target": "Nomad" },
    { "id": "n6", "kind": "switch", "line": 720, "text": "switch provider" },
    { "id": "n7", "kind": "try", "line": 0, "text": "…" },
    { "id": "n8", "kind": "throw", "line": 0, "text": "…", "error": true },
    { "id": "n9", "kind": "exit", "line": 749, "text": "end" }
  ],
  // Structured, nested, so the viewer can lay it out as a clean flowchart (no free-form graph):
  "tree": { "seq": [ "n0", { "loop": "n3", "body": { "seq": [ { "if": "n1", "then": { "seq": ["n2"] }, "else": null } ] } },
                     "n4", { "switch": "n6", "cases": [ { "label": "\"nomad\"", "body": { "seq": ["n5"] } } ] }, "n9" ] }
}
```

- Node kinds: `entry, decision, loop, switch, try, call, effect, return, throw, exit`. Plain statements that are not calls are dropped; consecutive non-call statements never appear. `error: true` on returns/throws that return or raise an error/exception.
- `call` = a call to a function defined in this repo (best effort by name); `effect` = a call to an outside system (same rules as metro effects: map `uses` refs on that line, else receiver words like db/client/http/publish…, with `target` set when known). Other calls (logging, string helpers, stdlib) are dropped.
- `text` is the source on that line, trimmed, at most 120 chars; conditions are the condition expression only.
- `tree` blocks: `{"seq": [item…]}`; items are a node id or one of `{"if": id, "then": block, "else": block|null}`, `{"loop": id, "body": block}`, `{"switch": id, "cases": [{"label": str, "body": block}]}`, `{"try": id, "body": block, "catch": block|null, "finally": block|null}`.
- Languages: go, python, javascript, typescript, tsx, java, kotlin, rust, csharp, ruby, php, c, cpp. Others → `"status": "unsupported"`.
- Budget: < 50 ms for a 300-line function. Functions > 400 nodes are truncated with an `"…"` node.

### Plain-English labels (optional): `POST /api/xray/explain` body `{file, line, agent, model}`
→ `{"labels": {"n1": "Provider name is not a known executor?", "n3": "For each requested provider", …}}`.
The server sends the function source plus node ids/lines/texts to the chosen agent; it must answer JSON only; unknown ids are dropped; cached per (file, function hash, model) in `~/.cache/ariadne/`. Labels are shown alongside, never instead of, the real code.

## 2. Gates: `GET /api/gates` (whole repo) and `?part=<id>`

```jsonc
{ "gates": [
  { "id": "env:KAFKA_ADDR", "kind": "env" | "flag" | "config", "name": "KAFKA_ADDR",
    "reads": [ { "ref": "src/checkout/main.go:180", "fn": "main", "part": "checkout" } ],
    "checks": [ { "ref": "src/checkout/main.go:418", "fn": "PlaceOrder", "part": "checkout", "text": "if cs.kafkaBrokerSvcAddr != \"\"" } ],
    "default": "\"\"" | null,
    "lines": [ "checkout:L0" ]            // metro lines (part:lineId) whose stations contain a checking function
  } ] }
```
- env: `os.Getenv/LookupEnv`, `process.env.X`, `os.environ[...]/getenv`, `System.getenv`, `ENV[...]`, `std::env::var`, `Environment.GetEnvironmentVariable`, `getenv(`.
- flag: feature-flag SDK calls whose first argument is a string literal (OpenFeature `get*Value`, flagd, GrowthBook `isOn/getFeatureValue`, LaunchDarkly `variation`, Unleash `isEnabled`, …).
- config: struct/config fields loaded from env (follow one hop: variable or field assigned from an env read → later `if`/`switch` on that variable or field = a check).
- `checks` are decisions (if/switch/ternary) that use the gate name or the variable/field it was loaded into. Precision over recall: no check is better than a wrong one.

## 3. States: `GET /api/states?part=<id>`

```jsonc
{ "machines": [
  { "id": "job.State", "subject": "job", "field": "State",
    "states": ["JOB_STATE_REQUESTED", "JOB_STATE_SCHEDULED", "JOB_STATE_RUNNING", "JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED"],
    "transitions": [ { "from": "JOB_STATE_REQUESTED" | null, "to": "JOB_STATE_SCHEDULED", "ref": "pkg/x.go:812", "fn": "scheduleNomadJob" } ],
    "heuristic": true } ] }
```
- A machine = a field/variable whose name matches state|status|phase|stage, assigned constant values (enum members, constants, string literals) in ≥ 2 places with ≥ 3 distinct values. `from` comes from an enclosing `if`/`switch` comparing the same field to a constant, else null.
- Precision over recall; drop machines with fewer than 2 transitions.
