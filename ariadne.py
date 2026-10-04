#!/usr/bin/env python3
"""ariadne: map any repo into map.json with `claude -p`, then serve the 3D viewer + chat.

  ariadne.py build <repo> [-o map.json] [--base REV] [--jobs 6] [--no-llm]
  ariadne.py assemble <parts.json...> --repo <dir> [-o map.json] [--base REV] [--no-llm]
  ariadne.py serve <map.json> --repo <dir> [--port 7777]
"""
import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
SCHEMA = HERE / "SCHEMA.md"
MARKERS = {"go.mod", "package.json", "pyproject.toml", "setup.py", "requirements.txt", "Cargo.toml",
           "pom.xml", "build.gradle", "build.gradle.kts", "project.json", "Gemfile", "composer.json",
           "CMakeLists.txt", "mix.exs", "pubspec.yaml", "Package.swift", "Dockerfile"}
MARKER_SUFFIXES = (".csproj", ".sln", ".slnx")
SOURCE = re.compile(r"\.(go|py|js|jsx|ts|tsx|mjs|rs|java|kt|kts|scala|cs|fs|rb|php|c|cc|cpp|h|hpp|swift|"
                    r"ex|exs|dart|lua|sh|sql)$")
IGNORED = {"node_modules", "vendor", "dist", "build", ".venv", ".git", "__pycache__"}
KINDS = ["service", "job", "library", "tool"]
PALETTE = ["#38bdf8", "#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#fb7185", "#22d3ee", "#a3e635"]
EXTERNAL_KINDS = {
    "db": ["postgres", "mongo", "firestore", "bigquery", "redis", "mysql", "sqlite", "spanner",
           "dynamo", "cassandra", "clickhouse", "elastic", "database", "sql"],
    "queue": ["pubsub", "kafka", "sqs", "sns", "rabbit", "nats", "queue", "cloud tasks"],
    "storage": ["gcs", "s3", "storage", "bucket", "blob"],
    "cloud": ["nomad", "runpod", "cloud run", "kubernetes", "k8s", "lambda", "ec2",
              "gce", "compute", "vertex", "docker", "cloud function"],
    "saas": ["stripe", "slack", "sendgrid", "openai", "anthropic", "claude", "sentry", "linear",
             "github", "twilio", "posthog", "mixpanel", "firebase", "auth0", "datadog", "gmail",
             "google", "paddle", "intercom", "hubspot"],
}
REF_RE = re.compile(r"^(.+):(\d+)$")
CODE_CONTEXT = 6
FN_WINDOW = 5


# ---------- helpers ----------

def git(repo, *args):
    r = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def repo_files(repo):
    """Repo-relative paths of source files (git ls-files when possible), minus ignored dirs."""
    out = git(repo, "ls-files")
    if out is not None:
        files = out.splitlines()
    else:
        files = []
        for root, dirs, names in os.walk(repo):
            dirs[:] = [d for d in dirs if d not in IGNORED]
            files += [os.path.relpath(os.path.join(root, n), repo) for n in names]
    return [f for f in files if not IGNORED & set(Path(f).parts[:-1])]


def count_lines(path):
    try:
        data = path.read_bytes()
    except OSError:
        return 0
    if b"\0" in data[:4096]:
        return 0
    return sum(1 for line in data.splitlines() if line.strip())


def in_dir(file, folder):
    return folder in ("", ".") or file == folder or file.startswith(folder.rstrip("/") + "/")


def run_claude(prompt, cwd, tools, allowed, system=None, timeout=None, model=None):
    """Run `claude -p` and return its final text. Raises RuntimeError on failure."""
    cmd = ["claude", "-p", prompt, "--output-format", "json", "--tools", ",".join(tools),
           "--allowedTools", ",".join(allowed), "--strict-mcp-config", "--no-session-persistence"]
    if system:
        cmd += ["--append-system-prompt", system]
    if model:
        cmd += ["--model", model]
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                           stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"claude timed out after {timeout}s")
    try:
        out = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"claude failed (exit {r.returncode}): {(r.stderr or r.stdout)[-500:]}")
    if out.get("is_error"):
        raise RuntimeError(f"claude error: {out.get('result')}")
    return out.get("result", "")


AGENTS = []  # filled by serve()
CLAUDE_MODELS = ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5",
                 "claude-haiku-4-5-20251001", "claude-fable-5-1"]
MODEL_RE = re.compile(r"[\w./:@+-]{1,120}")


def pi_models():
    """`provider/model` ids pi can use, from `pi --list-models`."""
    try:
        out = subprocess.run(["pi", "--no-extensions", "--list-models"], capture_output=True, text=True,
                             timeout=60, stdin=subprocess.DEVNULL).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    rows = [line.split() for line in out.splitlines()[1:]]
    return [f"{r[0]}/{r[1]}" for r in rows if len(r) >= 2]


def opencode_models():
    try:
        out = subprocess.run(["opencode", "models"], capture_output=True, text=True, timeout=60).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [line.strip() for line in out.splitlines() if "/" in line]


def list_agents():
    """Chat backends: which CLIs are installed and model suggestions for each."""
    return [{"id": "claude", "installed": bool(shutil.which("claude")), "models": CLAUDE_MODELS},
            {"id": "pi", "installed": bool(shutil.which("pi")), "models": pi_models() if shutil.which("pi") else []},
            {"id": "opencode", "installed": bool(shutil.which("opencode")),
             "models": opencode_models() if shutil.which("opencode") else []},
            {"id": "codex", "installed": bool(shutil.which("codex")), "models": []}]


def ask_agent(agent, model, system, prompt, cwd, timeout):
    """One read-only question to the chosen coding agent CLI; returns its final text."""
    if agent == "claude":
        tools = ["Read", "Grep", "Glob"]
        return run_claude(prompt, cwd, tools, tools, system=system, timeout=timeout, model=model)
    if agent == "pi" and not model:
        # pi's own default may come from an extension, and extensions are off (see below).
        try:
            conf = json.loads((Path.home() / ".pi" / "agent" / "settings.json").read_text())
            model = f"{conf['defaultProvider']}/{conf['defaultModel']}"
        except (OSError, ValueError, KeyError):
            pass
        pi = next((a for a in AGENTS if a["id"] == "pi"), {"models": []})
        if model and model not in pi["models"]:
            raise RuntimeError(f"pi's default model ({model}) needs a pi extension, and Ariadne runs pi "
                               "without extensions. Pick a model in Settings.")
    if agent == "pi":
        # Extensions can keep pi alive after it answers, so run without them.
        cmd = ["pi", "-p", "--no-session", "--no-extensions", "--no-skills", "--no-context-files",
               "--tools", "read,grep,find,ls", "--append-system-prompt", system]
        cmd += ["--model", model] if model else []
        return run_cli(cmd + ["--", prompt], cwd, timeout)
    if agent == "opencode":
        # The built-in "plan" agent cannot edit files or run commands.
        cmd = ["opencode", "run", "--agent", "plan"] + (["--model", model] if model else [])
        return re.sub(r"\x1b\[[0-9;]*m", "", run_cli(cmd + [system + "\n\n" + prompt], cwd, timeout))
    if agent == "codex":
        with tempfile.NamedTemporaryFile(suffix=".txt") as last:
            cmd = ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check",
                   "--output-last-message", last.name]
            cmd += ["--model", model] if model else []
            run_cli(cmd + [system + "\n\n" + prompt], cwd, timeout)
            return Path(last.name).read_text()
    raise RuntimeError(f"unknown agent {agent}")


def run_cli(cmd, cwd, timeout):
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                           stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{cmd[0]} timed out after {timeout}s")
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed (exit {r.returncode}): {(r.stderr or r.stdout)[-500:]}")
    return r.stdout


def extract_json(text):
    """Parse the first JSON object in text (tolerates prose or ``` fences around it)."""
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object in reply")
    return json.loads(text[start:end + 1])


# ---------- build ----------

def find_slices(repo, files):
    """Folders that are their own project; a single-project repo is sliced by top-level dirs."""
    projects = {str(Path(f).parent) for f in files
                if Path(f).name in MARKERS or f.endswith(MARKER_SUFFIXES)}
    projects.discard(".")
    # A project inside another (tests/, src/ of a service) belongs to it; folders with no code
    # (dashboards, config) are not parts.
    projects = {p for p in projects if not any(q != p and in_dir(p, q) for q in projects)}
    projects = {p for p in projects if any(in_dir(f, p) and SOURCE.search(f) for f in files)}
    if projects:
        return sorted(projects)
    return sorted({Path(f).parts[0] for f in files if len(Path(f).parts) > 1
                   and not Path(f).parts[0].startswith(".")})


def slice_ids(slices):
    names = [Path(s).name for s in slices]
    return {s: (Path(s).name if names.count(Path(s).name) == 1 else s.replace("/", "-"))
            for s in slices}


def batch(slices, sizes, n):
    """Greedy: biggest slice first into the lightest batch."""
    batches = [[] for _ in range(min(n, len(slices)))]
    load = [0] * len(batches)
    for s in sorted(slices, key=lambda s: -sizes[s]):
        i = load.index(min(load))
        batches[i].append(s)
        load[i] += sizes[s]
    return batches


def choose_model(args, summary):
    """The agent and model come from the user, never a silent default: mapping can use a lot of a
    plan's usage. Flags (--agent, --model, --yes) skip the questions."""
    agents = [a for a in list_agents() if a["installed"]]
    if not agents:
        sys.exit("no agent CLI found: install claude, pi, opencode or codex")
    interactive = sys.stdin.isatty()
    if not (args.agent and args.model) and not interactive:
        sys.exit("pass --agent and --model (e.g. --agent claude --model sonnet); see README for costs")
    print(summary, file=sys.stderr)
    if not args.agent:
        for i, a in enumerate(agents, 1):
            print(f"  {i}) {a['id']}", file=sys.stderr)
        pick = input("Agent: ").strip()
        args.agent = agents[int(pick) - 1]["id"] if pick.isdigit() and 0 < int(pick) <= len(agents) else pick
    agent = next((a for a in agents if a["id"] == args.agent), None)
    if agent is None:
        sys.exit(f"agent {args.agent!r} is not installed")
    while not args.model:
        if agent["id"] == "claude":
            options = ["sonnet  (recommended: near-Opus quality, far less usage)",
                       "haiku   (fastest, cheapest)", "opus    (best, uses the most)"]
        else:
            query = input(f"Search {agent['id']} models (e.g. deepseek, qwen): ").strip().lower()
            options = [m for m in agent["models"] if all(w in m.lower() for w in query.split())][:15]
        for i, o in enumerate(options, 1):
            print(f"  {i}) {o}", file=sys.stderr)
        pick = input("Model (number or name): ").strip()
        if pick.isdigit() and 0 < int(pick) <= len(options):
            args.model = options[int(pick) - 1].split()[0]
        elif pick:
            args.model = pick
    if not MODEL_RE.fullmatch(args.model):
        sys.exit(f"invalid model name: {args.model}")
    if args.yes:
        return
    if not interactive:
        sys.exit("add --yes to run without a terminal")
    if input(f"Use {args.agent} · {args.model}? [y/N] ").strip().lower() != "y":
        sys.exit("cancelled")


def build(args):
    repo = Path(args.repo).resolve()
    files = repo_files(repo)
    slices = find_slices(repo, files)
    if not slices:
        sys.exit("no source folders found")
    # nested projects: each file counts toward its nearest slice
    owner = {}
    for f in files:
        match = [s for s in slices if in_dir(f, s)]
        if match:
            owner.setdefault(max(match, key=len), []).append(f)
    sizes = {s: sum(count_lines(repo / f) for f in owner.get(s, [])) for s in slices}
    ids = slice_ids(slices)
    batches = batch(slices, sizes, args.batches)
    source = sum((repo / f).stat().st_size for fs in owner.values() for f in fs
                 if (repo / f).is_file() and (repo / f).stat().st_size < 1_000_000) // 4
    choose_model(args, f"Repo: {len(slices)} slices · {sum(sizes.values()):,} lines (≈ {source:,} tokens of source).\n"
                       f"Mapping reads much of it: expect very roughly {source * 3 // 10:,}–{source:,} tokens, "
                       f"in {len(batches)} parallel batches.")
    args.yes = True  # assemble below uses the same choice
    work = Path(args.output).resolve().with_suffix(".parts")
    work.mkdir(parents=True, exist_ok=True)
    schema = SCHEMA.read_text()
    nested = {s: [o for o in slices if o != s and in_dir(o, s)] for s in slices}

    def map_batch(i, group):
        lines = []
        for s in group:
            skip = f" (skip nested: {', '.join(nested[s])})" if nested[s] else ""
            lines.append(f"- id \"{ids[s]}\", path \"{s}\", ~{sizes[s]} lines{skip}")
        prompt = (f"{schema}\n\nYou are mapping this repository (cwd = repo root). "
                  f"Your assigned folders, one part each:\n" + "\n".join(lines) +
                  "\n\nRead the code, then reply with ONLY the JSON object {\"parts\": [...]}, "
                  "no prose, no fences. Other parts in the repo you may reference by id: "
                  + ", ".join(ids[s] for s in slices if s not in group))
        out = work / f"parts-{i}.json"
        try:
            if args.agent == "claude":
                text = run_claude(prompt, repo, ["Read", "Grep", "Glob", "Bash"],
                                  ["Read", "Grep", "Glob", "Bash(git ls-files:*)"], model=args.model)
            else:
                text = ask_agent(args.agent, args.model, "", prompt, repo, timeout=3600)
            out.write_text(json.dumps(extract_json(text), indent=1))
            print(f"batch {i}: {len(group)} slices -> {out}", file=sys.stderr)
            return out
        except (RuntimeError, ValueError) as e:
            print(f"batch {i} failed: {e}", file=sys.stderr)
            return None

    with ThreadPoolExecutor(args.jobs) as pool:
        outs = [p for p in pool.map(map_batch, range(len(batches)), batches) if p]
    if not outs:
        sys.exit("all batches failed")
    args.parts, args.repo = [str(p) for p in outs], str(repo)
    assemble(args)


# ---------- assemble ----------

def refs_of(part):
    """(ref, fn) pairs used anywhere in a part."""
    for e in part.get("exposes", []) + part.get("uses", []):
        if e.get("ref"):
            yield e["ref"], None
    for flow in part.get("flows", []):
        for step in flow.get("steps", []):
            if step.get("ref"):
                yield step["ref"], step.get("fn")


def check_ref(repo, ref, fn):
    """Return a code entry {start, lines, verified} for path:line."""
    m = REF_RE.match(ref)
    if not m:
        return {"start": 0, "lines": [], "verified": False}
    path, line = (repo / m[1]).resolve(), int(m[2])
    try:
        if repo not in path.parents:
            raise OSError("outside repo")
        text = path.read_text(errors="replace").splitlines()
    except OSError:
        return {"start": line, "lines": [], "verified": False}
    if not 1 <= line <= len(text):
        return {"start": line, "lines": [], "verified": False}
    start = max(1, line - CODE_CONTEXT)
    ok = True
    if fn:
        name = fn.split(".")[-1].strip("()")
        window = text[max(0, line - 1 - FN_WINDOW): line + FN_WINDOW]
        ok = any(name in w for w in window)
    return {"start": start, "lines": text[start - 1: line + CODE_CONTEXT], "verified": ok}


def guess_kind(name):
    low = name.lower()
    for kind, words in EXTERNAL_KINDS.items():
        if any(w in low for w in words):
            return kind
    return "other"


def make_links(parts):
    links = {}
    for p in parts:
        for u in p.get("uses", []):
            t = u.get("target")
            if not t or t == p["id"]:
                continue
            link = links.setdefault((p["id"], t), {"from": p["id"], "to": t, "how": u.get("how", ""), "weight": 0})
            link["weight"] += 1
    for p in parts:
        for topic in p.get("publishes", []):
            for q in parts:
                if q is not p and topic in q.get("subscribes", []):
                    links[(p["id"], q["id"], topic)] = {"from": p["id"], "to": q["id"],
                                                        "how": f"PubSub: {topic}", "weight": 1}
    return list(links.values())


def digest(parts):
    keys = ["id", "kind", "summary", "uses", "publishes", "subscribes", "exposes"]
    out = []
    for p in parts:
        d = {k: p[k] for k in keys if p.get(k)}
        d["uses"] = [f"{u.get('target')}: {u.get('how', '')}" for u in p.get("uses", [])]
        d["exposes"] = [e.get("what", "") for e in p.get("exposes", [])]
        d["flowSteps"] = [f"{s.get('from')} -> {s.get('to')} @ {s.get('ref')}"
                          for f in p.get("flows", []) for s in f.get("steps", []) if s.get("ref")]
        out.append(d)
    return json.dumps(out, separators=(",", ":"))


def folder_clusters(parts):
    groups = {}
    for p in parts:
        top = Path(p.get("path", p["id"])).parts[0] if p.get("path") else p["id"]
        groups.setdefault(top, []).append(p["id"])
    return [{"id": g, "name": g.replace("-", " ").replace("_", " ").title(), "summary": "",
             "color": PALETTE[i % len(PALETTE)], "members": m}
            for i, (g, m) in enumerate(sorted(groups.items()))]


def llm_overview(parts, part_ids, externals, known_refs, repo, agent, model):
    """Ask claude for clusters, a system summary and systemFlows; validate the answer."""
    prompt = (
        "Here is a compact digest of every part of a codebase:\n" + digest(parts) +
        "\n\nReply with ONLY a JSON object, no prose:\n"
        '{"summary": "1-2 plain sentences: what the whole system does",\n'
        ' "clusters": [{"id": "kebab-id", "name": "Short Name", "summary": "one line", '
        f'"color": one of {PALETTE}, "members": [part ids]}}],\n'
        ' "systemFlows": [{"title": "A user does X", "steps": [{"from": "id", "to": "id", '
        '"text": "<=12 words", "ref": "path:line"}]}],\n'
        f' "externalKinds": {{"<external name>": one of {sorted(EXTERNAL_KINDS) + ["other"]}}}}}\n'
        "External names: " + ", ".join(sorted(externals)) + "\n"
        "Rules: 4-7 clusters; every part id in exactly one cluster. 2-4 systemFlows that cross "
        "parts; step from/to must be part ids or external names from the digest; every ref must "
        "be copied from flowSteps in the digest (omit ref if none fits). Do not invent.")
    data = extract_json(ask_agent(agent, model, "", prompt, repo, timeout=900))
    clusters, seen = [], set()
    for i, c in enumerate(data.get("clusters", [])):
        members = [m for m in c.get("members", []) if m in part_ids and m not in seen]
        if not c.get("id") or not members:
            continue
        seen.update(members)
        color = c.get("color") if c.get("color") in PALETTE else PALETTE[i % len(PALETTE)]
        clusters.append({"id": str(c["id"]), "name": c.get("name", c["id"]),
                         "summary": c.get("summary", ""), "color": color, "members": members})
    missing = [p for p in part_ids if p not in seen]
    if missing:
        clusters.append({"id": "other", "name": "Other", "summary": "Parts not grouped elsewhere.",
                         "color": PALETTE[len(clusters) % len(PALETTE)], "members": missing})
    actors = set(part_ids) | externals
    flows = []
    for f in data.get("systemFlows", []):
        steps = []
        for s in f.get("steps", []):
            if s.get("from") in actors and s.get("to") in actors:
                step = {"from": s["from"], "to": s["to"], "text": s.get("text", "")}
                if s.get("ref") in known_refs:
                    step["ref"] = s["ref"]
                steps.append(step)
        if f.get("title") and len(steps) >= 2:
            flows.append({"title": f["title"], "steps": steps})
    kinds = {e: k for e, k in (data.get("externalKinds") or {}).items()
             if e in externals and (k in EXTERNAL_KINDS or k == "other")}
    return str(data.get("summary", "")), clusters, flows, kinds


def assemble(args):
    repo = Path(args.repo).resolve()
    parts, ids = [], set()
    for f in args.parts:
        for p in json.loads(Path(f).read_text()).get("parts", []):
            if p.get("id") and p["id"] not in ids:
                ids.add(p["id"])
                parts.append(p)
            else:
                print(f"skipping part without id or duplicate: {p.get('id')}", file=sys.stderr)
    part_ids = [p["id"] for p in parts]

    files = repo_files(repo)
    for p in parts:
        p["size"] = sum(count_lines(repo / f) for f in files if in_dir(f, p.get("path", "")))

    # Outside systems are what parts declare they use; other flow actors are their own functions.
    externals = {u["target"] for p in parts for u in p.get("uses", []) if u.get("target")} - ids
    known_refs = {r for p in parts for r, _ in refs_of(p)}

    if not args.no_llm:
        choose_model(args, f"Assembling {len(parts)} parts: one call to name domains and find system flows.")
    if args.no_llm:
        summary, clusters, flows, kinds = "", folder_clusters(parts), [], {}
    else:
        try:
            summary, clusters, flows, kinds = llm_overview(parts, part_ids, externals, known_refs, repo,
                                                           args.agent, args.model)
        except (RuntimeError, ValueError) as e:
            print(f"overview failed, clustering by folder: {e}", file=sys.stderr)
            summary, clusters, flows, kinds = "", folder_clusters(parts), [], {}
    for c in clusters:
        for m in c.pop("members"):
            next(p for p in parts if p["id"] == m)["cluster"] = c["id"]

    code = {}
    pairs = [rf for p in parts for rf in refs_of(p)]
    pairs += [(s["ref"], None) for f in flows for s in f["steps"] if s.get("ref")]
    for ref, fn in pairs:
        entry = check_ref(repo, ref, fn)
        if ref in code:
            code[ref]["verified"] &= entry["verified"]
        else:
            code[ref] = entry
    bad = [r for r, e in code.items() if not e["verified"]]
    print(f"{len(parts)} parts, {len(code)} refs, {len(bad)} unverified", file=sys.stderr)
    for r in bad:
        print(f"  unverified: {r}", file=sys.stderr)

    rev = git(repo, "log", "-1", "--format=%h %ad", "--date=short")
    out = {"title": repo.name, "summary": summary, "revision": (rev or "").strip(),
           "clusters": clusters, "parts": parts,
           "externals": [{"id": e, "kind": kinds.get(e) or guess_kind(e)} for e in sorted(externals)],
           "links": make_links(parts), "systemFlows": flows, "code": code}
    if args.base:
        changed = (git(repo, "diff", "--name-only", args.base) or "").splitlines()
        changes = {}
        for f in changed:
            owners = [p for p in parts if p.get("path") and in_dir(f, p["path"])]
            if owners:
                pid = max(owners, key=lambda p: len(p["path"]))["id"]
                changes[pid] = changes.get(pid, 0) + 1
        out["changes"] = changes
    Path(args.output).write_text(json.dumps(out, indent=1))
    print(f"wrote {args.output}", file=sys.stderr)


# ---------- serve ----------

CHAT_PROTOCOL = """You are the guide inside "ariadne", a 3D map of this codebase. Answer in short plain
markdown (a few sentences or bullets). Use Read/Grep/Glob on the repo when the map is not enough;
cite code as path:line.

You can drive the view. End EVERY answer with a fenced block named actions holding a JSON array
(use [] when nothing fits). Allowed actions:
- {"type":"focus","id":"<part, cluster or external id>"}   fly the camera there
- {"type":"play","flow":"<partId>#<index>"} or {"type":"play","flow":"system#<index>"}   play a flow
- {"type":"highlight","ids":["<id>", ...]}   glow these, dim the rest ([] clears)
- {"type":"filter","kinds":["service","job","library","tool"]}   show only these kinds
- {"type":"overview"}   fly back out to the whole system
- {"type":"code","ref":"<path:line from the map>"}   open that code panel
Only use ids, flows and refs that appear in the map below.

Example ending:
```actions
[{"type":"focus","id":"orders-api"},{"type":"play","flow":"orders-api#0"}]
```
Another:
```actions
[{"type":"highlight","ids":["tracker","Postgres"]}]
```
"""
ACTIONS_RE = re.compile(r"```actions\s*\n(.*?)```\s*$", re.S)


def chat_digest(m):
    lines = [f"# {m.get('title')}: {m.get('summary', '')}", "## clusters"]
    lines += [f"- {c['id']}: {c.get('name')} — {c.get('summary', '')}" for c in m.get("clusters", [])]
    lines.append("## parts (id [kind, cluster] path: summary; flows by index; refs)")
    for p in m.get("parts", []):
        lines.append(f"- {p['id']} [{p.get('kind')}, {p.get('cluster')}] {p.get('path')}: {p.get('summary', '')}")
        for i, f in enumerate(p.get("flows", [])):
            lines.append(f"  - flow {p['id']}#{i}: {f.get('title')}")
        refs = sorted({r for r, _ in refs_of(p)})
        if refs:
            lines.append(f"  - refs: {' '.join(refs)}")
    lines.append("## externals: " + ", ".join(e["id"] for e in m.get("externals", [])))
    lines.append("## system flows")
    lines += [f"- system#{i}: {f.get('title')}" for i, f in enumerate(m.get("systemFlows", []))]
    return "\n".join(lines)


def valid_actions(raw, m):
    ids = ({p["id"] for p in m.get("parts", [])} | {c["id"] for c in m.get("clusters", [])}
           | {e["id"] for e in m.get("externals", [])})
    flows = {f"{p['id']}#{i}" for p in m.get("parts", []) for i in range(len(p.get("flows", [])))}
    flows |= {f"system#{i}" for i in range(len(m.get("systemFlows", [])))}
    out = []
    for a in raw if isinstance(raw, list) else []:
        t = a.get("type") if isinstance(a, dict) else None
        if t == "focus" and a.get("id") in ids:
            out.append({"type": t, "id": a["id"]})
        elif t == "play" and a.get("flow") in flows:
            out.append({"type": t, "flow": a["flow"]})
        elif t == "highlight" and isinstance(a.get("ids"), list):
            keep = [i for i in a["ids"] if i in ids]
            if keep or not a["ids"]:
                out.append({"type": t, "ids": keep})
        elif t == "filter" and isinstance(a.get("kinds"), list):
            keep = [k for k in a["kinds"] if k in KINDS]
            if keep:
                out.append({"type": t, "kinds": keep})
        elif t == "overview":
            out.append({"type": t})
        elif t == "code" and a.get("ref") in m.get("code", {}):
            out.append({"type": t, "ref": a["ref"]})
    return out


def chat(body, map_path, repo):
    m = json.loads(Path(map_path).read_text())
    msgs = [x for x in body.get("messages", []) if x.get("content")]
    if not msgs:
        return {"reply": "Ask me something about the code.", "actions": []}
    system = (CHAT_PROTOCOL + "\n# Map\n" + chat_digest(m) +
              "\n\n# Current view\n" + json.dumps(body.get("view") or {}))
    history = "\n\n".join(f"{x.get('role', 'user').upper()}: {x['content']}" for x in msgs[:-1])
    prompt = (f"Conversation so far:\n{history}\n\n" if history else "") + \
             f"USER: {msgs[-1]['content']}\n\nAnswer the last USER message."
    agent, model = body.get("agent") or "claude", body.get("model") or ""
    installed = {a["id"] for a in AGENTS if a["installed"]}
    if agent not in installed:
        return {"reply": f"{agent} is not installed on the server.", "actions": []}
    if model and not MODEL_RE.fullmatch(model):
        return {"reply": f"Invalid model name: {model}", "actions": []}
    try:
        text = ask_agent(agent, model, system, prompt, repo, timeout=300)
    except RuntimeError as e:
        return {"reply": f"Chat failed: {e}", "actions": []}
    actions = []
    match = ACTIONS_RE.search(text.rstrip() + "\n")
    if match:
        text = text[:match.start()].rstrip()
        try:
            actions = valid_actions(json.loads(match[1]), m)
        except json.JSONDecodeError:
            pass
    return {"reply": text, "actions": actions}


DEFINITION = r"(func|def|class|type|interface|struct|enum|trait|fn|function|const|let|var)\s+(\([^)]*\)\s*)?"


def read_file(repo, rel):
    """Whole text file inside repo, or None (outside repo, missing, binary, or huge)."""
    path = (repo / rel).resolve()
    if not path.is_relative_to(repo) or not path.is_file() or path.stat().st_size > 2_000_000:
        return None
    data = path.read_bytes()
    if b"\0" in data[:8000]:
        return None
    return {"path": rel, "lines": data.decode("utf-8", "replace").splitlines()}


def grep(repo, files, name, folder=""):
    """Where an identifier appears, definitions first. Whole-word, at most 200 hits."""
    if not re.fullmatch(r"[A-Za-z_][\w.]{0,80}", name):
        return []
    word = re.compile(r"\b" + re.escape(name) + r"\b")
    define = re.compile(DEFINITION + re.escape(name.split(".")[-1]) + r"\b")
    hits = []
    for f in files:
        if not in_dir(f, folder) or not (doc := read_file(repo, f)):
            continue
        for i, line in enumerate(doc["lines"], 1):
            if word.search(line):
                hits.append({"ref": f"{f}:{i}", "text": line.strip()[:200], "def": bool(define.search(line))})
                if len(hits) >= 200:
                    break
    return sorted(hits, key=lambda h: not h["def"])


# Methods every type implements; matching them by name links unrelated code.
PROTOCOL = {"Error", "String", "GoString", "MarshalJSON", "UnmarshalJSON", "Close", "Len", "Less", "Swap",
            "ServeHTTP", "Read", "Write", "__init__", "__str__", "__repr__", "toString", "equals", "hashCode"}


def qualified_names(body):
    """(qualifier, name) for every identifier; qualifier is what precedes a '.', else None.
    In `a.b().c`, c's qualifier is "" (dotted, but not a plain name)."""
    out = set()
    for m in re.finditer(r"[A-Za-z_]\w*", body):
        before = body[max(0, m.start() - 80):m.start()].rstrip()  # look back a little, not the whole body
        if before.endswith("."):
            prev = re.search(r"([A-Za-z_]\w*)\s*$", before[:-1])
            out.add((prev.group(1) if prev else "", m.group()))
        else:
            out.add((None, m.group()))
    return out


def name_match(rows, funcs, i, qualifier, name, words):
    """Functions of this part that `qualifier.name` inside function i most likely refers to."""
    cands = [j for j in funcs.get(name, []) if j != i]
    if not cands or len(cands) > 3:
        return []
    caller_parent, caller_dir = rows[i][3], str(Path(rows[i][4]).parent)
    methods = [j for j in cands if rows[j][3]]
    if methods:
        if name in PROTOCOL or qualifier is None:
            return []
        q = qualifier.lower()
        typed = [j for j in methods if rows[j][3] == caller_parent or rows[j][3] in words
                 or len(q) > 2 and (rows[j][3].lower().endswith(q) or q.endswith(rows[j][3].lower()))]
        return typed or (methods if len(methods) == 1 else [])
    if qualifier:  # pkg.Func: the package must match the function's folder
        return [j for j in cands if Path(rows[j][4]).parent.name == qualifier]
    same_dir = [j for j in cands if str(Path(rows[j][4]).parent) == caller_dir]
    return same_dir or (cands if len(cands) == 1 else [])


class Structure:
    """Functions, types and calls for the whole repo, from code-review-graph (tree-sitter, many
    languages). Built once in a background thread; the repo must be a git checkout."""

    def __init__(self, repo):
        self.repo, self.db, self.error = repo, None, None
        threading.Thread(target=self.build, daemon=True).start()

    def build(self):
        data = Path.home() / ".cache" / "ariadne" / re.sub(r"\W", "_", str(self.repo))
        r = subprocess.run(["uvx", "code-review-graph", "build", "-q", "--skip-flows", "--repo", str(self.repo),
                            "--data-dir", str(data)], capture_output=True, text=True, stdin=subprocess.DEVNULL)
        if r.returncode != 0:
            self.error = "code structure unavailable: " + (r.stderr.strip().splitlines() or ["build failed"])[-1]
            return
        self.db = data / "graph.db"

    def part(self, part, kinds):
        """Code structure of one map part, plus its metro lines and effects (see METRO.md)."""
        folder = part.get("path", "")
        if self.db is None:
            return {"status": "error" if self.error else "building", "error": self.error}
        db = sqlite3.connect(self.db)
        target = self.repo / folder  # a part is a folder, or a single file
        prefix = str(target) if target.is_file() else str(target).rstrip("/") + "/"
        rows = db.execute("SELECT qualified_name, kind, name, parent_name, file_path, line_start, line_end, is_test "
                          "FROM nodes WHERE kind IN ('Class', 'Function', 'Test') AND file_path LIKE ? || '%'",
                          (prefix,)).fetchall()
        index = {r[0]: i for i, r in enumerate(rows)}
        calls, fanin = {}, [0] * len(rows)
        for src, dst in db.execute("SELECT source_qualified, target_qualified FROM edges WHERE kind = 'CALLS' "
                                   "AND file_path LIKE ? || '%'", (prefix,)):
            if src in index and dst in index and src != dst:
                calls[(index[src], index[dst])] = 1
                fanin[index[dst]] += 1
        # The parser misses calls it cannot resolve (pkg.Func, field.Method) and functions passed as
        # values (route handlers). Recover them, and type usage, by scanning each body for the
        # names of this part's own functions and types; names with more than 3 owners are skipped.
        funcs, types = defaultdict(list), defaultdict(list)
        for i, (_, kind, name, parent, *_rest) in enumerate(rows):
            (types if kind == "Class" else funcs)[name].append(i)
        uses, texts = set(), {}
        for i, (_, kind, name, parent, path, start, end, _t) in enumerate(rows):
            if kind == "Class" or not start:
                continue
            if path not in texts:
                texts[path] = Path(path).read_text(errors="replace").splitlines()
            body = "\n".join(texts[path][start - 1:end])
            body = re.sub(r'"(?:\\.|[^"\\\n])*"|(?:^|\s)(?://|#).*', " ", body)  # drop strings and comments
            words = set(re.findall(r"[A-Za-z_]\w*", body))
            for j in sorted({j for q, w in qualified_names(body) for j in name_match(rows, funcs, i, q, w, words)}):
                if (i, j) not in calls:
                    calls[(i, j)] = 1
                    fanin[j] += 1
            for word in sorted(words):
                for j in types.get(word, []) if len(types.get(word, [])) <= 3 else []:
                    if rows[j][2] != parent:
                        uses.add((i, j))
        outside = defaultdict(int)
        for (dst,) in db.execute("SELECT target_qualified FROM edges WHERE kind = 'CALLS' "
                                 "AND file_path NOT LIKE ? || '%'", (prefix,)):
            if dst in index:
                outside[index[dst]] += 1
        root = str(self.repo) + "/"
        nodes = [{"name": name, "kind": "type" if kind == "Class" else "method" if parent else "function",
                  "parent": parent, "file": path.replace(root, ""), "line": start, "end": end,
                  "test": bool(test) or kind == "Test", "fanin": fanin[i], "outside": outside[i]}
                 for i, (_, kind, name, parent, path, start, end, test) in enumerate(rows)]
        lines, hidden = metro_lines(nodes, calls, funcs, part, self.repo)
        return {"status": "ready", "nodes": nodes, "calls": list(calls), "uses": sorted(uses),
                "lines": lines, "hiddenLines": hidden, "effects": effects(nodes, part, kinds)}


MAX_LINES = 12


def metro_lines(nodes, calls, funcs, part, repo):
    """Entry points (exposed handlers, then call-graph roots) and the route each one takes.
    Tests and mocks are left off the map."""
    off = {i for i, n in enumerate(nodes) if n["test"] or "mock" in n["file"].lower()}
    out = defaultdict(list)
    for i, j in sorted(calls):
        if i not in off and j not in off:
            out[i].append(j)
    reach = {}

    def reach_of(i):
        if i not in reach:
            seen, todo = {i}, [i]
            while todo:
                for j in out[todo.pop()]:
                    if j not in seen:
                        seen.add(j)
                        todo.append(j)
            reach[i] = len(seen)
        return reach[i]

    def best(i, seen):
        """Unvisited callees of i, the one reaching the most nodes first."""
        return sorted((j for j in out[i] if j not in seen), key=lambda j: (-reach_of(j), j))

    entries = []  # (label, kind, node)
    for e in part.get("exposes", []):
        m = REF_RE.match(e.get("ref", ""))
        doc = m and read_file(repo, m[1])
        if not doc:
            continue
        # The registration statement: from the ref line until its brackets close, at most 5 lines.
        text, n = "", int(m[2]) - 1
        for line in doc["lines"][n:n + 5]:
            text += line + "\n"
            if text.count("(") <= text.count(")"):
                break
        # The handler is the last function named as a value (not followed by "."), preferring the owner
        # whose type is the named receiver (r.handlers.Get -> Handlers.Get). Else the registering function.
        names = [w for w in re.findall(r"\b([A-Za-z_]\w*)\b(?!\s*\.)", text) if set(funcs.get(w, [])) - off]
        if names:
            receivers = {r.lower() for r in re.findall(r"(\w+)\s*\.\s*" + names[-1] + r"\b", text)}
            node = max(set(funcs[names[-1]]) - off,
                       key=lambda j: ((nodes[j]["parent"] or "").lower() in receivers, reach_of(j), -j))
        else:
            node = enclosing(nodes, m[1], int(m[2]))
        if node is not None and node not in off:
            entries.append((e.get("what", ""), e.get("type", "function"), node))
    called = {j for js in out.values() for j in js}
    entries += [(nodes[i]["name"], "function", i)
                for i in sorted(range(len(nodes)), key=lambda i: (-reach_of(i), i))
                if i not in called and i not in off and reach_of(i) >= 2]
    taken, unique = set(), []
    for e in entries:
        if e[2] not in taken:
            taken.add(e[2])
            unique.append(e)
    lines = []
    for label, kind, entry in unique[:MAX_LINES]:
        trunk, seen = [entry], {entry}
        while nxt := best(trunk[-1], seen):
            trunk.append(nxt[0])
            seen.add(nxt[0])
        branches = []
        for s in trunk:
            for j in best(s, seen):
                if j not in seen:  # an earlier spur of this station may have taken it
                    spur = [j] + best(j, seen | {j})[:1]
                    seen.update(spur)
                    branches.append({"from": s, "nodes": spur})
        lines.append({"id": f"L{len(lines)}", "label": label, "kind": kind, "entry": entry, "trunk": trunk,
                      "branches": branches, "more": reach_of(entry) - len(seen), "reach": reach_of(entry)})
    return lines, max(0, len(unique) - MAX_LINES)


def enclosing(nodes, file, line):
    """Index of the smallest node in file whose [line, end] holds line, or None."""
    inside = [i for i, n in enumerate(nodes) if n["file"] == file and n["line"] and n["line"] <= line <= n["end"]]
    return min(inside, key=lambda i: (nodes[i]["end"] - nodes[i]["line"], i), default=None)


def effects(nodes, part, kinds):
    """node index -> outside systems it touches, from uses refs and flow steps into externals."""
    refs = [(u.get("target"), u.get("ref", "")) for u in part.get("uses", [])]
    refs += [(s.get("to"), s.get("ref", "")) for f in part.get("flows", []) for s in f.get("steps", [])]
    found = defaultdict(dict)
    for target, ref in sorted(set(refs), key=str):
        m = REF_RE.match(ref or "")
        if target in kinds and m and (i := enclosing(nodes, m[1], int(m[2]))) is not None:
            found[str(i)].setdefault(target, {"target": target, "kind": kinds[target], "ref": ref})
    return {i: list(t.values()) for i, t in found.items()}


def serve(args):
    map_path, repo = Path(args.map).resolve(), Path(args.repo).resolve()
    index = HERE / "viewer" / "index.html"
    files = repo_files(repo)
    AGENTS[:] = list_agents()
    structure = Structure(repo)
    data = json.loads(map_path.read_text())
    parts = {p["id"]: p for p in data.get("parts", [])}
    kinds = {e["id"]: e.get("kind", "other") for e in data.get("externals", [])}

    class Handler(BaseHTTPRequestHandler):
        def send(self, code, data, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-cache")  # always pick up a rebuilt map or viewer
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            url = urlparse(self.path)
            path, arg = url.path, lambda k: parse_qs(url.query).get(k, [""])[0]
            # Read-only code browsing, confined to the repo.
            if path == "/api/agents":
                return self.send(200, json.dumps({"agents": AGENTS}).encode(), "application/json")
            if path == "/api/structure":
                if arg("part") not in parts:
                    return self.send(404, b'{"error": "unknown part"}', "application/json")
                return self.send(200, json.dumps(structure.part(parts[arg("part")], kinds)).encode(), "application/json")
            if path == "/api/tree":
                found = [f for f in files if in_dir(f, arg("dir"))][:5000]
                return self.send(200, json.dumps({"files": found}).encode(), "application/json")
            if path == "/api/file":
                doc = read_file(repo, arg("path"))
                return self.send(200 if doc else 404, json.dumps(doc or {"error": "not a readable file"}).encode(), "application/json")
            if path == "/api/grep":
                hits = grep(repo, files, arg("q"), arg("dir"))
                return self.send(200, json.dumps({"hits": hits}).encode(), "application/json")
            src = {"/": (index, "text/html; charset=utf-8"),
                   "/index.html": (index, "text/html; charset=utf-8"),
                   "/map.json": (map_path, "application/json")}.get(path)
            if src is None and re.fullmatch(r"/[\w.-]+\.(js|css)", path):
                kind = "text/javascript" if path.endswith(".js") else "text/css"
                src = (index.parent / path[1:], kind + "; charset=utf-8")
            if src and src[0].exists():
                self.send(200, src[0].read_bytes(), src[1])
            else:
                self.send(404, b"not found", "text/plain")

        def do_POST(self):
            if self.path != "/api/chat":
                return self.send(404, b"not found", "text/plain")
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                result = chat(body, map_path, repo)
            except (ValueError, AttributeError) as e:
                result = {"reply": f"Bad request: {e}", "actions": []}
            self.send(200, json.dumps(result).encode(), "application/json")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"ariadne on http://{args.host}:{args.port}", file=sys.stderr)
    server.serve_forever()


def main():
    ap = argparse.ArgumentParser(description="Map a codebase and serve the 3D viewer.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="map a repo with an agent CLI, then assemble")
    b.add_argument("repo")
    b.add_argument("--jobs", type=int, default=6, help="concurrent claude runs")
    b.add_argument("--batches", type=int, default=7, help="number of slice batches")
    a = sub.add_parser("assemble", help="merge part files into map.json")
    a.add_argument("parts", nargs="+")
    a.add_argument("--repo", required=True)
    for p in (a, b):
        p.add_argument("-o", "--output", default="map.json")
        p.add_argument("--base", help="git revision to count changed files against")
        p.add_argument("--no-llm", action="store_true", help="cluster by folder, no system flows")
        p.add_argument("--agent", help="claude | pi | opencode | codex (asked if missing)")
        p.add_argument("--model", help="e.g. sonnet, haiku, opus, deepseek/deepseek-flash (asked if missing)")
        p.add_argument("--yes", action="store_true", help="don't ask for confirmation")
    s = sub.add_parser("serve", help="serve viewer, map and chat")
    s.add_argument("map")
    s.add_argument("--repo", required=True)
    s.add_argument("--port", type=int, default=7777)
    s.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to allow other devices")
    args = ap.parse_args()
    {"build": build, "assemble": assemble, "serve": serve}[args.cmd](args)


if __name__ == "__main__":
    main()
