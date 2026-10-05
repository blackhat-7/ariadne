#!/usr/bin/env python3
"""ariadne: map any repo into map.json with `claude -p`, then serve the 3D viewer + chat.

  ariadne.py build <repo> [-o map.json] [--base REV] [--jobs 6] [--no-llm]
  ariadne.py assemble <parts.json...> --repo <dir> [-o map.json] [--base REV] [--no-llm]
  ariadne.py serve <map.json> --repo <dir> [--port 7777]
"""
import argparse
import hashlib
import importlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
SCHEMA = HERE / "SCHEMA.md"
# Maps hold excerpts of the mapped code, so they live outside the repo by default.
MAPS = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "ariadne" / "maps"


def repo_dir(arg):
    path = Path(arg).expanduser().resolve()
    if not path.is_dir():
        sys.exit(f"No such folder: {arg}")
    return path


def default_map(repo):
    return MAPS / f"{repo.name}-{hashlib.sha1(str(repo).encode()).hexdigest()[:8]}.map.json"
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
# Outside systems named several ways are merged on a key that drops generic words and expands abbreviations.
EXTERNAL_GENERIC = {"collector", "server", "service", "api", "client"}
EXTERNAL_ALIASES = {"otel": "opentelemetry", "otlp": "opentelemetry", "pg": "postgres", "postgresql": "postgres",
                    "k8s": "kubernetes", "gcs": "google cloud storage"}
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


def run_claude_stream(prompt, cwd, tools, allowed, model, on_tool):
    """`claude -p` with streamed events, calling on_tool(name) for each tool call (for progress)."""
    cmd = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--tools", ",".join(tools),
           "--allowedTools", ",".join(allowed), "--strict-mcp-config", "--no-session-persistence"]
    cmd += ["--model", model] if model else []
    proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            stdin=subprocess.DEVNULL)
    result = None
    for line in proc.stdout:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_use":
                    on_tool(block.get("name", ""))
        elif event.get("type") == "result":
            result = event
    proc.wait()
    if not result or result.get("is_error"):
        raise RuntimeError(f"claude failed: {(result or {}).get('result') or proc.stderr.read()[-500:]}")
    return result.get("result", "")


def extract_json(text):
    """Parse the first JSON object in text (tolerates prose or ``` fences around it)."""
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object in reply")
    return json.loads(text[start:end + 1])


def parse_parts(text):
    """The parts in a mapping reply {"parts": [...]}. When the reply is malformed (an unescaped quote in one
    part), every other part that parses on its own is kept rather than losing the whole batch."""
    try:
        return extract_json(text).get("parts", [])
    except ValueError as e:
        error = e
    decoder, found, i = json.JSONDecoder(), [], text.find("{")
    while i >= 0:
        try:
            obj, end = decoder.raw_decode(text, i)
        except ValueError:
            obj, end = None, i + 1
        if isinstance(obj, dict) and obj.get("id") and obj.get("path"):   # a part, not something inside one
            found.append(obj)
        else:
            end = i + 1
        i = text.find("{", end)
    if not found:
        raise ValueError(f"no parts in reply: {error}")
    return found


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
    code = [f for f in files if SOURCE.search(f) and not TESTS.search(f) and not GENERATED.search(f)
            and not Path(f).parts[0].startswith(".")]
    return sorted(code_slices(code, "."))


def code_slices(code, folder):
    """A single project's parts: folder (when it has code files of its own) and its code subfolders. A subfolder
    holding most of a sizeable codebase (one package) is split the same way; tiny ones stay with their parent."""
    depth = 0 if folder == "." else len(Path(folder).parts)
    inside = [Path(f).parts for f in code if in_dir(f, folder)]
    subs = defaultdict(int)
    for parts in inside:
        if len(parts) > depth + 1:
            subs[str(Path(*parts[:depth + 1]))] += 1
    subs = {d: n for d, n in subs.items() if n >= 3}
    out = {folder} if any(len(parts) == depth + 1 for parts in inside) or not subs else set()
    for d, n in subs.items():
        out |= code_slices(code, d) if n * 2 > len(inside) and n >= 15 else {d}
    return out


def slice_ids(slices):
    names = [Path(s).name or "root" for s in slices]
    return {s: (n if names.count(n) == 1 else s.replace("/", "-")) for s, n in zip(slices, names)}


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
        sys.exit("pass --agent and --model, e.g. --agent claude --model sonnet")
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
            options = ["sonnet", "haiku", "opus"]
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


def file_hashes(repo):
    """path -> content hash of every tracked file: git's index hashes, recomputed for files changed in the
    working tree. Cheap enough to run on every build or branch switch."""
    out = git(repo, "ls-files", "-s", "-z")
    hashes = {}
    for entry in (out or "").split("\0"):
        if "\t" in entry:
            meta, path = entry.split("\t", 1)
            hashes[path] = meta.split()[1]
    changed = git(repo, "ls-files", "-m", "-z") if out is not None else None
    for path in (changed.split("\0") if changed is not None else repo_files(repo)):
        f = repo / path
        if path and f.is_file():
            data = f.read_bytes()   # git's blob hash, so an edit matches the same content once committed
            hashes[path] = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
    return hashes


def snapshot(repo, rev=None):
    """(files, hashes, sizes) of the working tree, or of a git revision without checking it out."""
    if rev is None:
        files = repo_files(repo)
        hashes = file_hashes(repo)
        return files, hashes, {f: (repo / f).stat().st_size for f in files if (repo / f).is_file()}
    hashes, sizes = {}, {}
    for entry in (git(repo, "ls-tree", "-r", "-l", "-z", rev) or "").split("\0"):
        if "\t" in entry:
            meta, path = entry.split("\t", 1)
            _, kind, sha, size = meta.split()
            if kind == "blob" and not IGNORED & set(Path(path).parts[:-1]):
                hashes[path], sizes[path] = sha, int(size) if size.isdigit() else 0
    return sorted(hashes), hashes, sizes


def plan(repo, rev=None, fresh=False):
    """What mapping `rev` (default: the working tree) needs: its slices, which are already in the part
    cache, and a size estimate for the rest. Cheap: no files are read for a revision."""
    files, hashes, sizes = snapshot(repo, rev)
    slices = find_slices(repo, files)
    owner = {}
    for f in files:
        match = [s for s in slices if in_dir(f, s)]
        if match:
            owner.setdefault(max(match, key=len), []).append(f)
    cache = part_cache(repo) / "parts"
    prints = slice_fingerprints(slices, owner, hashes)
    cached = {s: json.loads((cache / f"{prints[s]}.json").read_text()) for s in slices
              if not fresh and (cache / f"{prints[s]}.json").exists()}
    todo = [s for s in slices if s not in cached]
    tokens = source_tokens(todo, owner, sizes)
    ids = slice_ids(slices)
    # With every part cached, a model is still needed for the overview unless that is cached too.
    overview = not todo and overview_path(repo, [dict(cached[s], id=cached[s].get("id") or ids[s])
                                                 for s in slices]).exists()
    return {"files": files, "slices": slices, "owner": owner, "ids": ids, "prints": prints, "sizes": sizes,
            "cached": cached, "todo": todo, "tokens": tokens, "needs_model": not overview}


def source_tokens(slices, owner, sizes):
    """Roughly the source mapping reads for these slices: their code, not locks, docs or tests."""
    return sum(sizes.get(f, 0) for s in slices for f in owner.get(s, [])
               if SOURCE.search(f) and not TESTS.search(f) and sizes.get(f, 0) < 1_000_000) // 4


def overview_path(repo, parts):
    """The overview (domains, system flows) is about how parts connect, so it is reused while the parts,
    their kinds and what they use, publish and subscribe to stay the same: edits inside a part don't
    need a new one. Its refs are verified again on every assemble."""
    key = json.dumps(sorted([p["id"], p.get("kind"), sorted({str(u.get("target")) for u in p.get("uses", [])}),
                             sorted(map(str, p.get("publishes", []))), sorted(map(str, p.get("subscribes", [])))]
                            for p in parts))
    return part_cache(repo) / "overview" / (hashlib.sha1(key.encode()).hexdigest()[:20] + ".json")


def slice_fingerprints(slices, owner, hashes):
    """slice -> hash of its files' contents: unchanged slices keep their mapped part across branches."""
    return {s: hashlib.sha1((s + "".join(f"\0{f}={hashes.get(f, '')}" for f in sorted(owner.get(s, []))))
                            .encode()).hexdigest()[:20] for s in slices}


def part_cache(repo):
    """Per-repository cache, shared by the checkout and any git worktrees of it (same git dir)."""
    common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
    key = Path(common.strip()).parent if common else repo
    return MAPS / default_map(key).name.replace(".map.json", ".cache")


class Progress:
    """One live status line on stderr: elapsed time, batches done, tool calls (files read, searches)."""

    def __init__(self, total):
        self.total, self.finished, self.reads, self.calls = total, 0, 0, 0
        self.start, self.lock, self.live = time.time(), threading.Lock(), sys.stderr.isatty()
        self.stopped = threading.Event()
        threading.Thread(target=self.loop, daemon=True).start()

    def line(self):
        m, sec = divmod(int(time.time() - self.start), 60)
        return (f"  {m:02d}:{sec:02d}  batches {self.finished}/{self.total} done"
                f"  ·  {self.reads} files read, {self.calls} tool calls")

    def show(self, note=None):
        with self.lock:
            if note:
                print(("\r\033[K" if self.live else "") + f"  {note}", file=sys.stderr)
            if self.live:
                print("\r\033[K" + self.line(), end="", file=sys.stderr, flush=True)

    def tick(self, tool):
        with self.lock:
            self.calls += 1
            self.reads += tool == "Read"

    def done(self, names, error=None):
        with self.lock:
            self.finished += 1
        self.show(error or f"✓ {names}")

    def loop(self):
        while not self.stopped.wait(1 if self.live else 30):
            if self.live:
                self.show()
            else:
                print(self.line(), file=sys.stderr, flush=True)

    def stop(self):
        self.stopped.set()
        if self.live:
            print("\r\033[K" + self.line(), file=sys.stderr)


def build(args):
    repo = repo_dir(args.repo)
    args.output = args.output or str(default_map(repo))
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    # Parts whose files are unchanged since they were last mapped (on any branch) are reused as they are.
    pl = plan(repo, fresh=args.fresh)
    slices, owner, ids, prints, cached, todo = (pl[k] for k in ("slices", "owner", "ids", "prints", "cached", "todo"))
    if args.only is not None:   # a review's update: map the parts it touches, keep the shown map's others as they are
        cached |= {s: args.reuse[s] for s in slices if s not in cached and s not in args.only and s in args.reuse}
        todo = [s for s in todo if s in args.only]
        slices = [s for s in slices if s in cached or s in todo]
    if not slices:
        sys.exit("no source folders found")
    cache = part_cache(repo) / "parts"
    sizes = {s: sum(count_lines(repo / f) for f in owner.get(s, [])) for s in todo}
    if not todo:
        print(f"All {len(slices)} parts are unchanged since they were last mapped: reusing them.", file=sys.stderr)
        return finish_build(args, repo, slices, ids, cached, [])
    args.batches = args.batches or min(16, len(todo))   # wall time is set by the slowest batch
    args.jobs = args.jobs or args.batches
    batches = batch(todo, sizes, args.batches)
    source = pl["tokens"]
    reuse = f" ({len(cached)} unchanged parts reused)" if cached else ""
    choose_model(args, f"Repo: {len(slices)} slices, {len(todo)} to map{reuse} · {sum(sizes.values()):,} lines "
                       f"(≈ {source:,} tokens of source).\n"
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
                  "\n\nWork fast and stay focused: start from each part's entry points (main, routes, handlers, "
                  "consumers, cron), read only the files its main flows pass through, and skip tests, generated "
                  "code (*.pb.go, *_gen.*, mocks), vendored code and lock files. 2-4 flows per part is enough."
                  "\n\nThen reply with ONLY the JSON object {\"parts\": [...]}, "
                  "no prose, no fences. Other parts in the repo you may reference by id: "
                  + ", ".join(ids[s] for s in slices if s not in group))
        out = work / f"parts-{i}.json"
        try:
            if args.agent == "claude":
                # no Bash: denied shell calls (cat, find) still cost a turn each; Glob lists files
                text = run_claude_stream(prompt, repo, ["Read", "Grep", "Glob"], ["Read", "Grep", "Glob"], args.model,
                                         lambda name: progress.tick(name))
            else:
                text = ask_agent(args.agent, args.model, "", prompt, repo, timeout=3600)
            found = parse_parts(text)
            out.write_text(json.dumps({"parts": found}, indent=1))
            names, paths = {p.get("id") for p in found}, {p.get("path") for p in found}
            lost = [ids[s] for s in group if ids[s] not in names and s not in paths]
            progress.done(", ".join(sorted(n for n in names if n)) + (f" (no reply for {', '.join(lost)})" if lost else ""))
            return out
        except (RuntimeError, ValueError) as e:
            progress.done(None, f"batch {i + 1} failed: {e}")
            return None

    print(f"Mapping {len(todo)} parts in {len(batches)} parallel batches with {args.agent} · {args.model}.",
          file=sys.stderr)
    by_path = {s: s for s in todo} | {ids[s]: s for s in todo}

    def run(groups, first):
        nonlocal progress
        progress = args.progress = Progress(len(groups))   # the server shows it while it refreshes a map
        with ThreadPoolExecutor(args.jobs) as pool:
            done = [p for p in pool.map(map_batch, range(first, first + len(groups)), groups) if p]
        progress.stop()
        return done

    progress = None
    outs = run(batches, 0)
    # A failed batch (agent error, broken reply) costs only its own parts: those are mapped once more.
    got = {by_path.get(p.get("path")) or by_path.get(p.get("id")) for o in outs for p in json.loads(o.read_text())["parts"]}
    missing = [s for s in todo if s not in got]
    if missing:
        print(f"Mapping {len(missing)} missing parts again: {', '.join(ids[s] for s in missing)}", file=sys.stderr)
        outs += run(batch(missing, sizes, min(args.batches, len(missing))), len(batches))
    if not outs and not cached:
        sys.exit("all batches failed")
    # Cache each freshly mapped part under its slice's fingerprint.
    cache.mkdir(parents=True, exist_ok=True)
    for out in outs:
        for part in json.loads(Path(out).read_text()).get("parts", []):
            s = by_path.get(part.get("path")) or by_path.get(part.get("id"))
            if s:
                (cache / f"{prints[s]}.json").write_text(json.dumps(part))
    return finish_build(args, repo, slices, ids, cached, outs)


def finish_build(args, repo, slices, ids, cached, outs):
    """Assemble reused and freshly mapped parts into the map."""
    work = Path(args.output).resolve().with_suffix(".parts")
    work.mkdir(parents=True, exist_ok=True)
    reused = work / "parts-cached.json"
    reused.write_text(json.dumps({"parts": [cached[s] for s in slices if s in cached]}, indent=1))
    args.parts, args.repo, args.yes = [str(reused)] + [str(p) for p in outs], str(repo), True
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


def external_key(name):
    """'OTel Collector', 'OTLP collector' and 'OpenTelemetry' -> 'opentelemetry'; 'Pub/Sub' and 'PubSub' -> 'pubsub';
    'Postgres Replica' stays apart."""
    words = [EXTERNAL_ALIASES.get(w, w) for w in re.findall(r"[a-z0-9]+", name.lower())]
    return "".join([w for w in words if w not in EXTERNAL_GENERIC] or words).replace(" ", "")


def merge_externals(parts, flows, kinds, externals):
    """One outside system per thing: aliases are renamed, everywhere, to their most used (then longest) spelling."""
    used = Counter(u["target"] for p in parts for u in p.get("uses", []) if u.get("target") in externals)
    groups = defaultdict(list)
    for e in sorted(externals):
        groups[external_key(e)].append(e)
    rename = {}
    for names in groups.values():
        best = max(names, key=lambda n: (used[n], len(n)))
        rename |= {n: best for n in names if n != best}
    for p in parts:
        for u in p.get("uses", []):
            if u.get("target") in rename:
                u["target"] = rename[u["target"]]
    steps = [s for p in parts for f in p.get("flows", []) for s in f.get("steps", [])]
    for s in steps + [s for f in flows for s in f["steps"]]:
        for k in ("from", "to"):
            if s.get(k) in rename:
                s[k] = rename[s[k]]
    merged = {}
    for e, k in kinds.items():   # an alias's specific kind beats another's "other"
        if k != "other" or rename.get(e, e) not in merged:
            merged[rename.get(e, e)] = k
    return {rename.get(e, e) for e in externals}, merged


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
    repo = repo_dir(args.repo)
    args.output = args.output or "map.json"
    parts, ids = [], set()
    for f in args.parts:
        for p in json.loads(Path(f).read_text()).get("parts", []):
            if p.get("id") and p["id"] not in ids:
                ids.add(p["id"])
                parts.append(p)
            else:
                print(f"skipping part without id or duplicate: {p.get('id')}", file=sys.stderr)
    part_ids = [p["id"] for p in parts]

    code = [f for f in repo_files(repo) if SOURCE.search(f) and not TESTS.search(f)]   # sizes count code, not locks or docs
    for p in parts:
        # a file counts for the deepest part holding it: the root part is not the whole repo
        p["size"] = sum(count_lines(repo / f) for f in code if in_dir(f, p.get("path", "")) and not any(
            q is not p and len(q.get("path", "")) > len(p.get("path", "")) and in_dir(f, q.get("path", "")) for q in parts))

    # Outside systems are what parts declare they use; other flow actors are their own functions.
    externals = {u["target"] for p in parts for u in p.get("uses", []) if u.get("target")} - ids
    known_refs = {r for p in parts for r, _ in refs_of(p)}

    overview = overview_path(repo, parts)
    if args.no_llm:
        summary, clusters, flows, kinds = "", folder_clusters(parts), [], {}
    elif overview.exists() and not args.fresh:
        summary, clusters, flows, kinds = json.loads(overview.read_text())
    else:
        choose_model(args, f"Assembling {len(parts)} parts: one call to name domains and find system flows.")
        try:
            summary, clusters, flows, kinds = llm_overview(parts, part_ids, externals, known_refs, repo,
                                                           args.agent, args.model)
            overview.parent.mkdir(parents=True, exist_ok=True)
            overview.write_text(json.dumps([summary, clusters, flows, kinds]))
        except (RuntimeError, ValueError) as e:
            print(f"overview failed, clustering by folder: {e}", file=sys.stderr)
            summary, clusters, flows, kinds = "", folder_clusters(parts), [], {}
    externals, kinds = merge_externals(parts, flows, kinds, externals)   # after the overview: its cache key stays put
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

You can drive the view, and the user sees it move. Whenever they ask to see/show something, or a
place in the map would help, include actions. End EVERY answer with a fenced block named actions
holding a JSON array (use [] when nothing fits); never write the JSON anywhere else. Allowed actions:
- {"type":"focus","id":"<part, cluster or external id>"}   fly the camera there
- {"type":"play","flow":"<partId>#<index>"} or {"type":"play","flow":"system#<index>"}   play a flow
- {"type":"highlight","ids":["<id>", ...]}   glow these, dim the rest ([] clears)
- {"type":"feature","flow":"<partId>#<index>" or "system#<index>"} or {"type":"feature","part":"<part id>"}
  show only what that feature touches, with a summary card (best for "what does X involve")
- {"type":"filter","kinds":["service","job","library","tool"]}   show only these kinds
- {"type":"overview"}   fly back out to the whole system
- {"type":"code","ref":"<repo path:line>"}   open the code panel at any file and line in the repo
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
# Models don't always fence the block as asked: accept ```actions / ```json / bare JSON arrays of actions.
ACTIONS_RE = re.compile(r'```(?:actions|json)?\s*(\[\s*\{.*?\}\s*\])\s*```|(\[\s*\{\s*"type"\s*:.*?\}\s*\])', re.S)


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


def is_repo_ref(repo, ref):
    """ref is "path:line" naming a real file inside the repo (any file the chat found, not only map refs)."""
    path, _, line = str(ref or "").rpartition(":")
    return bool(path) and line.isdigit() and read_file(repo, path) is not None


def valid_actions(raw, m, repo):
    ids = ({p["id"] for p in m.get("parts", [])} | {c["id"] for c in m.get("clusters", [])}
           | {e["id"] for e in m.get("externals", [])})
    parts = {p["id"] for p in m.get("parts", [])}
    flows = {f"{p['id']}#{i}" for p in m.get("parts", []) for i in range(len(p.get("flows", [])))}
    flows |= {f"system#{i}" for i in range(len(m.get("systemFlows", [])))}
    out = []
    for a in raw if isinstance(raw, list) else []:
        t = a.get("type") if isinstance(a, dict) else None
        if t == "focus" and a.get("id") in ids:
            out.append({"type": t, "id": a["id"]})
        elif t == "play" and a.get("flow") in flows:
            out.append({"type": t, "flow": a["flow"]})
        elif t == "feature" and a.get("flow") in flows:
            out.append({"type": t, "flow": a["flow"]})
        elif t == "feature" and a.get("part") in parts:
            out.append({"type": t, "part": a["part"]})
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
        elif t == "code" and is_repo_ref(repo, a.get("ref")):
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
    for match in ACTIONS_RE.finditer(text):
        try:
            actions += valid_actions(json.loads(match[1] or match[2]), m, repo)
        except json.JSONDecodeError:
            pass
    text = re.sub(r"\n{3,}", "\n\n", ACTIONS_RE.sub("", text)).strip()
    if not text:   # the model only acted (or did nothing): say so instead of an empty bubble
        text = "; ".join(describe(a) for a in actions) or "I couldn't find that in the map or the code."
    return {"reply": text, "actions": actions}


def describe(action):
    t = action["type"]
    return {"focus": f"Showing {action.get('id')}", "play": f"Playing flow {action.get('flow')}",
            "feature": f"Focusing on {action.get('flow') or action.get('part')}",
            "code": f"Opening `{action.get('ref')}`", "overview": "Back to the overview",
            "highlight": "Highlighting " + ", ".join(action.get("ids", [])),
            "filter": "Showing only " + ", ".join(action.get("kinds", []))}.get(t, t)


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


TESTS = re.compile(r"(^|/)(tests?|__tests__|spec|testdata|fixtures?)/|[._-](test|spec)\.[a-z]+$|(^|/)test_[^/]+\.py$")
GENERATED = re.compile(r"(\.pb\.(go|cc|h)|_pb2(_grpc)?\.py|_grpc\.pb|_gen\.|\.generated\.|(^|/)generated/|/genproto/|/protos?/|/mocks?/|_mock\.)")


class Structure:
    """Functions, types and calls for the whole repo, from code-review-graph (tree-sitter, many
    languages). Built once in a background thread; the repo must be a git checkout."""

    def __init__(self, repo):
        self.repo, self.db, self.error = repo, None, None
        threading.Thread(target=self.build, daemon=True).start()

    def build(self):
        """code-review-graph's database is hundreds of MB, mostly indexes we don't use. Build it in a temp
        dir, keep only functions/types and call edges in a small cache, and reuse that cache until the
        repo's commit or working tree changes."""
        cache = Path.home() / ".cache" / "ariadne" / re.sub(r"\W", "_", str(self.repo))
        compact, stamp = cache / "structure.db", cache / "stamp"
        key = hashlib.sha1(((git(self.repo, "rev-parse", "HEAD") or "") +
                            (git(self.repo, "status", "--porcelain") or "")).encode()).hexdigest()
        if compact.exists() and stamp.exists() and stamp.read_text() == key:
            self.db = compact
            return
        with tempfile.TemporaryDirectory() as tmp:
            r = subprocess.run(["uvx", "code-review-graph", "build", "-q", "--skip-flows", "--repo", str(self.repo),
                                "--data-dir", tmp], capture_output=True, text=True, stdin=subprocess.DEVNULL)
            if r.returncode != 0:
                self.error = "code structure unavailable: " + (r.stderr.strip().splitlines() or ["build failed"])[-1]
                return
            cache.mkdir(parents=True, exist_ok=True)
            for old in cache.glob("graph.db*"):   # the full database older versions kept here
                old.unlink()
            new = cache / "structure.db.tmp"
            new.unlink(missing_ok=True)
            db = sqlite3.connect(new)
            db.execute("ATTACH ? AS g", (str(Path(tmp) / "graph.db"),))
            db.executescript("""
                CREATE TABLE nodes AS SELECT qualified_name, kind, name, parent_name, file_path, line_start,
                    line_end, is_test FROM g.nodes WHERE kind IN ('Class', 'Function', 'Test');
                CREATE TABLE edges AS SELECT kind, source_qualified, target_qualified, file_path
                    FROM g.edges WHERE kind = 'CALLS';
                CREATE INDEX nodes_file ON nodes(file_path);
                CREATE INDEX edges_file ON edges(file_path);""")
            db.commit()
            db.execute("DETACH g")
            db.close()
            new.replace(compact)
            stamp.write_text(key)
        self.db = compact

    def names(self, folders):
        """Names of functions defined under the given repo folders (x-ray: which calls are ours).
        Generated code is left out, or every protobuf getter would show up as a call."""
        if self.db is None:
            return set()
        rows = sqlite3.connect(self.db).execute("SELECT DISTINCT name, file_path FROM nodes WHERE kind != 'Class'")
        root = str(self.repo) + "/"
        return {n for n, f in rows if not GENERATED.search(f) and any(in_dir(f.replace(root, ""), d) for d in folders)}

    def callers(self, rel, name):
        """Names of functions that call `name` defined in rel (from the call graph)."""
        if self.db is None:
            return []
        db = sqlite3.connect(self.db)
        targets = [q for (q,) in db.execute("SELECT qualified_name FROM nodes WHERE file_path = ? AND name = ?",
                                            (str(self.repo / rel), name))]
        if not targets:
            return []
        marks = ",".join("?" * len(targets))
        return sorted({n for (n,) in db.execute(
            f"SELECT DISTINCT n.name FROM edges e JOIN nodes n ON n.qualified_name = e.source_qualified "
            f"WHERE e.target_qualified IN ({marks})", targets)})

    def fn_at(self, rel, line):
        """Name of the innermost function containing rel:line, or None."""
        if self.db is None:
            return None
        row = sqlite3.connect(self.db).execute(
            "SELECT name FROM nodes WHERE kind != 'Class' AND file_path = ? AND line_start <= ? AND line_end >= ? "
            "ORDER BY line_end - line_start LIMIT 1", (str(self.repo / rel), line, line)).fetchone()
        return row[0] if row else None

    def part(self, part, kinds):
        """Code structure of one map part, plus its metro lines and effects (see METRO.md)."""
        folder = part.get("path", "")
        if self.db is None:
            return {"status": "error" if self.error else "building", "error": self.error}
        db = sqlite3.connect(self.db)
        target = self.repo / folder  # a part is a folder, or a single file
        prefix = str(target) if target.is_file() else str(target).rstrip("/") + "/"
        rows = [r for r in db.execute(
            "SELECT qualified_name, kind, name, parent_name, file_path, line_start, line_end, is_test "
            "FROM nodes WHERE kind IN ('Class', 'Function', 'Test') AND file_path LIKE ? || '%'", (prefix,))
            if not GENERATED.search(r[4])]   # protobuf getters etc. would crowd the metro and the Lens
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


class Below:
    """Below function level (XRAY.md): x-ray, gates and states, extracted with tree-sitter by
    ariadne_xray / ariadne_gates. Those need tree-sitter-language-pack (installed with Ariadne by uv)."""

    def __init__(self, repo, files, parts, kinds, structure):
        self.repo, self.parts, self.kinds, self.structure = repo, parts, kinds, structure
        self.files = [f for f in files if SOURCE.search(f) and not GENERATED.search(f) and not TESTS.search(f)]
        self.lock, self.all_gates, self.metro, self.known_names = threading.Lock(), None, {}, {}

    def module(self, name):
        try:
            return importlib.import_module(name)
        except ImportError as e:
            raise RuntimeError(f"{e.name} is not installed; install Ariadne with uv (see README)")

    def part_of(self, rel):
        owners = [p for p in self.parts.values() if p.get("path") and in_dir(rel, p["path"])]
        return max(owners, key=lambda p: len(p["path"]))["id"] if owners else None

    def source(self, rel):
        path = (self.repo / rel).resolve()
        if not path.is_relative_to(self.repo) or not path.is_file():
            raise RuntimeError(f"not a file in the repo: {rel}")
        return path

    def targets(self, rel):
        """Outside systems on rel's lines, from the map's verified uses refs."""
        return {int(u["ref"].rsplit(":", 1)[1]): u["target"] for p in self.parts.values()
                for u in p.get("uses", []) if u.get("ref", "").startswith(rel + ":") and u.get("target")}

    def known(self, rel):
        """Our own calls are into the same part or a shared library; other parts are reached over the network."""
        own = self.part_of(rel)
        if own not in self.known_names:   # a scan of the whole call graph: once per part
            folders = [p["path"] for p in self.parts.values() if p.get("path") and (p["id"] == own or p.get("kind") == "library")]
            if self.structure.db is None:   # still building: don't keep the empty answer
                return set()
            self.known_names[own] = self.structure.names(folders or [""])
        return self.known_names[own]

    def xray(self, rel, line, text=None):
        """x-ray of the function at rel:line; text = another version of the file (a branch or the PR base)."""
        mod = self.module("ariadne_xray")
        if text is not None:
            return mod.xray_text(text, line, rel, self.known(rel), {})
        return mod.xray(self.source(rel), line, rel, self.known(rel), self.targets(rel))

    def entries(self, part_id, fn):
        """Metro lines of part_id that pass through fn, as {line, label}."""
        if part_id not in self.parts:
            return []
        hits = set(self.lines_of(part_id, fn))
        return [{"line": L["id"], "label": L["label"]} for L in self.metro[part_id].get("lines", [])
                if f"{part_id}:{L['id']}" in hits]

    def explain(self, rel, line, agent, model):
        mod, result = self.module("ariadne_xray"), self.xray(rel, line)
        if result.get("status") != "ready":
            return {"labels": {}, "error": result.get("error", "nothing to explain")}
        fn = result["fn"]
        text = "\n".join(self.source(rel).read_text(errors="replace").splitlines()[fn["start"] - 1:fn["end"]])
        prompt = mod.explain_prompt(result, text)
        # keyed on the prompt itself, so a changed function or an improved prompt gets fresh labels
        cache = Path.home() / ".cache" / "ariadne" / "labels" / (
            hashlib.sha1(f"{prompt}\0{agent}\0{model}".encode()).hexdigest() + ".json")
        if cache.exists():
            return {"labels": json.loads(cache.read_text())}
        if model and not MODEL_RE.fullmatch(model):
            raise RuntimeError(f"invalid model name: {model}")
        labels = mod.parse_labels(ask_agent(agent, model, "", prompt, self.repo, 300), result)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(labels))
        return {"labels": labels}

    def lines_of(self, part_id, fn):
        """Metro lines (part:lineId) with a station named fn."""
        if part_id not in self.metro:
            self.metro[part_id] = self.structure.part(self.parts[part_id], self.kinds)
        s = self.metro[part_id]
        if s.get("status") != "ready":
            return []
        return [f"{part_id}:{L['id']}" for L in s["lines"]
                if any(s["nodes"][i]["name"] == fn for i in L["trunk"] + [i for b in L["branches"] for i in b["nodes"]])]

    def gates(self, part=None):
        if self.structure.db is None:
            return {"status": "building", "gates": []}
        with self.lock:
            if self.all_gates is None:
                found = self.module("ariadne_gates").gates(self.repo, self.files, self.part_of, self.structure.fn_at)
                for g in found:
                    g["lines"] = sorted({ln for c in g.get("checks", []) if c.get("part") and c.get("fn")
                                         for ln in self.lines_of(c["part"], c["fn"])})
                self.all_gates = found
        gates = [g for g in self.all_gates if part is None or any(
            u.get("part") == part for u in g.get("reads", []) + g.get("checks", []))]
        return {"status": "ready", "gates": gates}

    def states(self, part):
        if self.structure.db is None:
            return {"status": "building", "machines": []}
        path = self.parts[part].get("path", "")
        files = [f for f in self.files if in_dir(f, path)]
        return {"status": "ready", "machines": self.module("ariadne_gates").states(self.repo, files, self.structure.fn_at)}


class View:
    """One mapped tree the server shows: the checkout, or another revision checked out in the cache's worktree."""

    def __init__(self, repo, map_path):
        self.repo, self.map_path = repo, map_path
        self.files = repo_files(repo)
        self.structure = Structure(repo)
        data = json.loads(map_path.read_text())
        self.parts = {p["id"]: p for p in data.get("parts", [])}
        self.kinds = {e["id"]: e.get("kind", "other") for e in data.get("externals", [])}
        self.below = Below(repo, self.files, self.parts, self.kinds, self.structure)


NARRATIVE_PROMPT = """You are reviewing a code change. Below are FACTS found deterministically from the syntax
trees (trust them) and the changed hunks. Write a short review for a busy reviewer:
- "summary": 2-3 plain sentences on what the change does and its main risk.
- "items": the 3-8 things worth a reviewer's attention, most important first, each {"text", "refs"} where refs are
  "path:line" in the NEW version taken from the facts or hunks.
- "mismatches": things the PR description claims that the facts contradict or don't show, and important facts it
  doesn't mention ([] when there is no description or nothing to say).
Reply with ONLY the JSON object {"summary": "...", "items": [...], "mismatches": [...]}, no prose, no fences.
"""


class Reviews:
    """PR review (REVIEW.md): the selected head and base, their review, and the map of that head.
    A head other than the checkout is mapped in a git worktree in the cache; the part cache is shared,
    so only parts whose files differ are mapped again."""

    def __init__(self, root, view):
        self.root, self.view, self.home, self.lock = root, view, view.map_path, threading.Lock()
        self.head = self.base = self.rev = self.pr = self.result = self.job = None
        self.branch_list = (0, None)

    def engine(self):
        return self.view.below.module("ariadne_review")

    def compute(self):
        b = self.view.below
        r = self.engine().review(self.root, self.base, self.rev, part_of=b.part_of, known_functions=b.known,
                                 effect_targets=b.targets, callers=b.structure.callers, metro_entries=b.entries)
        return dict(r, pr=self.pr)

    def select(self, head=None, base=None, pr=None):
        """head: None (the checkout with uncommitted changes), a branch or revision, or "pr:N"."""
        engine = self.engine()
        if head and head.startswith("pr:"):
            pr = head[3:]
            rev = engine.pr_head(self.root, pr)
        else:
            rev = engine.rev_parse(self.root, head) if head else None
        with self.lock:
            self.pr = engine.pr_info(self.root, pr) if pr else None
            # a pull request is diffed against the branch it targets, fetched fresh, as on GitHub
            if not base and self.pr and self.pr.get("baseRefName"):
                base = "origin/" + self.pr["baseRefName"]
            engine.fetch_base(self.root, base or engine.default_base(self.root))
            self.head, self.base, self.rev = head or None, base or None, rev
            self.result = self.compute()
        tree, out, _ = self.target(rev)
        if out.exists() and self.view.map_path != out and not self.running():
            self.refresh(None, None, build_map=False)   # this head was mapped before: show that map
        return self.result

    def target(self, rev):
        """(tree, map file, revision to check out) that maps rev."""
        if rev is None or rev == (git(self.root, "rev-parse", "HEAD") or "").strip():
            return self.root, self.home, None
        cache = part_cache(self.root)
        return cache / "worktree" / self.root.name, cache / "maps" / f"{rev[:12]}.map.json", rev   # named like the repo: the map's title

    def update_plan(self):
        """What updating the map for the reviewed head maps: the parts holding the change's files that aren't
        cached for this content. The shown map's other parts are kept as they are, so a PR costs its own parts."""
        tree, out, rev = self.target(self.rev)
        pl = plan(self.root, rev)
        files = [f["path"] for f in self.result["files"]] if self.result else pl["files"]
        only = {max((s for s in pl["slices"] if in_dir(f, s)), key=len, default=None) for f in files} - {None}
        todo = [s for s in pl["todo"] if s in only]
        reuse = {p["path"]: {k: v for k, v in p.items() if k not in ("size", "cluster")} for p in self.view.parts.values() if p.get("path")}
        return pl, only, todo, reuse

    def status(self):
        """How far the shown map is from the selected head, and what refreshing it would cost."""
        tree, out, rev = self.target(self.rev)
        pl, _, todo, _ = self.update_plan()
        changed, tokens, model = len(todo), source_tokens(todo, pl["owner"], pl["sizes"]), bool(todo) or pl["needs_model"]
        return {"shown": self.view.map_path == out, "built": out.exists() and not changed,
                "parts_total": len(pl["slices"]), "parts_changed": changed, "needs_model": model,
                "parts": [pl["ids"][s] for s in todo],
                "est_tokens": [tokens * 3 // 10, tokens] if changed else [0, 0],
                "est_seconds": [60, 240] if changed else [20, 90] if model else [2, 30],
                "progress": self.progress()}

    def running(self):
        return self.job is not None and not self.job["done"]

    def refresh(self, agent, model, build_map=True):
        tree, out, rev = self.target(self.rev)
        with self.lock:
            if self.running():
                raise RuntimeError("a map refresh is already running")
            _, only, _, reuse = self.update_plan()
            args = argparse.Namespace(repo=str(tree), output=str(out), agent=agent or None, model=model or None,
                                      yes=True, fresh=False, batches=None, jobs=None, base=None, no_llm=False,
                                      progress=None, only=only, reuse=reuse)
            self.job = job = {"args": args, "start": time.time(), "phase": "preparing", "done": False, "error": None}
        threading.Thread(target=self.run, args=(job, tree, out, rev, build_map), daemon=True).start()

    def run(self, job, tree, out, rev, build_map):
        try:
            if rev:
                job["phase"] = "checking out"
                checkout(self.root, tree, rev)
            if build_map or not out.exists():
                job["phase"] = "mapping"
                out.parent.mkdir(parents=True, exist_ok=True)
                build(job["args"])
            job["phase"] = "loading"
            view = View(tree, out)
            with self.lock:
                self.view = view
                if self.result:
                    self.result = self.compute()
            job["phase"] = "done"
        except SystemExit as e:   # build stops with sys.exit on unrecoverable errors
            job["error"] = str(e.code)
        except (RuntimeError, ValueError, OSError) as e:
            job["error"] = str(e)
        finally:
            job["done"] = True

    def progress(self):
        job = self.job
        if job is None:
            return None
        p = job["args"].progress
        assembling = job["phase"] == "mapping" and p is not None and p.stopped.is_set()
        return {"phase": "assembling" if assembling else job["phase"], "elapsed": int(time.time() - job["start"]), "done": job["done"],
                "error": job["error"], "batches": [p.finished, p.total] if p else None,
                "reads": p.reads if p else 0}

    def branches(self, fresh=False):
        """Branches and pull requests; cached briefly because listing PRs with gh takes seconds."""
        at, found = self.branch_list
        if fresh or found is None or time.time() - at > 60:
            found = self.engine().branches(self.root)
            self.branch_list = (time.time(), found)
        return dict(found, selected={"head": self.head, "base": self.base})

    def old_path(self, rel):
        """rel's path at the review's base (a renamed file had another one)."""
        if not self.result:
            raise RuntimeError("no review selected")
        return next((f["old"] for f in self.result["files"] if f["path"] == rel and f["old"]), rel)

    def source(self, rel, side):
        """Text of rel in the reviewed base or head (None when it is not there)."""
        if side == "base":
            return self.engine().file_text(self.root, self.result and self.result["base"]["rev"], self.old_path(rel))
        return self.engine().file_text(self.root, self.rev, rel)

    def diff(self, rel):
        return self.engine().diff_file(self.root, self.result and self.result["base"]["rev"], self.rev, rel,
                                       self.old_path(rel))

    def narrative(self, agent, model):
        r = self.result
        if not r:
            raise RuntimeError("no review selected")
        facts = []
        for f in r["functions"]:
            facts.append(f"{f['file']}::{f['name']} {f['status']}, risk {f['risk']}, "
                         f"callers {', '.join(f['blast']['callers'][:8]) or 'none'}")
            facts += [f"  - {c['severity']}: {c['why']}" + (f" ({c['before']} -> {c['after']})" if c.get("before") and c.get("after") else "")
                      + (f" @ {f['file']}:{c['head_line']}" if c.get("head_line") else "") for c in f["changes"]]
        facts += [f"gate {g['id']} {g['op']}" for g in r["gates"]]
        paths = [x["path"] for x in r["files"] if not x["generated"] and not x["test"]][:30]
        span = [r["base"]["rev"]] + ([self.rev] if self.rev else [])
        hunks = (git(self.root, "diff", "-U3", *span, "--", *paths) or "") if paths else ""
        pr = r["pr"]
        prompt = (NARRATIVE_PROMPT + "\n# PR description\n" + (f"{pr['title']}\n{pr['body']}" if pr else "(none)")
                  + "\n\n# Facts\n" + "\n".join(facts) + "\n\n# Hunks\n" + hunks[:60000])
        cache = Path.home() / ".cache" / "ariadne" / "narratives" / (
            hashlib.sha1(f"{prompt}\0{agent}\0{model}".encode()).hexdigest() + ".json")
        if cache.exists():
            return json.loads(cache.read_text())
        out = extract_json(ask_agent(agent, model, "", prompt, self.root, 600))
        lengths = {}

        def verified(ref):
            m = REF_RE.match(ref) if isinstance(ref, str) else None
            if not m or m[1] not in paths:
                return False
            if m[1] not in lengths:
                lengths[m[1]] = len((self.source(m[1], "head") or "").splitlines())
            return 1 <= int(m[2]) <= lengths[m[1]]

        items = [{"text": str(i["text"]), "refs": [x for x in i.get("refs", []) if verified(x)]}
                 for i in out.get("items", []) if isinstance(i, dict) and i.get("text")]
        result = {"summary": str(out.get("summary", "")), "items": items,
                  "mismatches": [str(x) for x in out.get("mismatches", []) if x]}
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(result))
        return result


def checkout(root, tree, rev):
    """Check rev out in the cache's worktree (created on first use)."""
    if (tree / ".git").exists() and git(tree, "checkout", "--quiet", "--detach", "--force", rev) is not None:
        return
    git(root, "worktree", "prune")
    shutil.rmtree(tree, ignore_errors=True)
    tree.parent.mkdir(parents=True, exist_ok=True)
    if git(root, "worktree", "add", "--quiet", "--detach", str(tree), rev) is None:
        raise RuntimeError(f"could not check out {rev[:12]} in {tree}")


def agent_error(body):
    """Why the agent/model in a request can't be used, or None."""
    if not body.get("agent"):
        return "pick an agent and model first"
    if body["agent"] not in {a["id"] for a in AGENTS if a["installed"]}:
        return f"{body['agent']} is not installed on the server"
    if body.get("model") and not MODEL_RE.fullmatch(body["model"]):
        return f"invalid model name: {body['model']}"
    return None


def serve(args):
    if args.target.endswith(".json"):   # older form: serve map.json --repo DIR
        map_path, repo = Path(args.target).expanduser().resolve(), repo_dir(args.repo or ".")
    else:
        repo = repo_dir(args.target)
        map_path = Path(args.map).expanduser().resolve() if args.map else default_map(repo)
    if not map_path.is_file():
        sys.exit(f"No map for {repo} yet. Run: ariadne build {args.target}")
    index = HERE / "viewer" / "index.html"
    # Listing pi/opencode models takes seconds: do it after the server is up.
    agents_ready = threading.Event()
    threading.Thread(target=lambda: (AGENTS.extend(list_agents()), agents_ready.set()), daemon=True).start()
    reviews = Reviews(repo, View(repo, map_path))
    if getattr(args, "review", None) is not None:
        try:
            reviews.select(None, args.review.get("base"), args.review.get("pr"))
        except RuntimeError as e:
            sys.exit(f"review failed: {e}")

    class Handler(BaseHTTPRequestHandler):
        def send(self, code, data, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")  # never a stale viewer after an upgrade or a rebuilt map (some browsers reuse no-cache scripts)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def json(self, result, code=200):
            self.send(code, json.dumps(result).encode(), "application/json")

        def do_GET(self):
            url = urlparse(self.path)
            path, arg = url.path, lambda k: parse_qs(url.query).get(k, [""])[0]
            view = reviews.view
            # Read-only code browsing, confined to the repo.
            if path == "/api/agents":
                agents_ready.wait(30)
                return self.json({"agents": AGENTS})
            if path == "/api/structure":
                if arg("part") not in view.parts:
                    return self.json({"error": "unknown part"}, 404)
                return self.json(view.structure.part(view.parts[arg("part")], view.kinds))
            if path in ("/api/xray", "/api/gates", "/api/states"):
                try:
                    if path == "/api/xray" and arg("rev") in ("base", "head"):
                        text = reviews.source(arg("file"), arg("rev"))
                        result = view.below.xray(arg("file"), int(arg("line") or 0), text) if text is not None else \
                            {"status": "error", "error": f"{arg('file')} is not in the {arg('rev')} version"}
                    elif path == "/api/xray":
                        result = view.below.xray(arg("file"), int(arg("line") or 0))
                    elif path == "/api/gates":
                        result = view.below.gates(arg("part") or None)
                    elif arg("part") in view.parts:
                        result = view.below.states(arg("part"))
                    else:
                        result = {"status": "error", "error": "unknown part"}
                except (RuntimeError, ValueError) as e:
                    result = {"status": "error", "error": str(e)}
                return self.json(result)
            if path in ("/api/review", "/api/branches", "/api/diff", "/api/map/status", "/api/map/progress"):
                try:
                    if path == "/api/review":
                        result = reviews.result or {"status": "none"}
                    elif path == "/api/branches":
                        result = reviews.branches(fresh=arg("fresh") == "1")
                    elif path == "/api/diff":
                        result = reviews.diff(arg("file"))
                    elif path == "/api/map/status":
                        result = reviews.status()
                    else:
                        result = reviews.progress() or {"phase": None, "done": True}
                except (RuntimeError, ValueError) as e:
                    result = {"status": "error", "error": str(e)}
                return self.json(result)
            if path == "/api/tree":
                return self.json({"files": [f for f in view.files if in_dir(f, arg("dir"))][:5000]})
            if path == "/api/file":
                doc = read_file(view.repo, arg("path"))
                return self.json(doc or {"error": "not a readable file"}, 200 if doc else 404)
            if path == "/api/grep":
                return self.json({"hits": grep(view.repo, view.files, arg("q"), arg("dir"))})
            src = {"/": (index, "text/html; charset=utf-8"),
                   "/index.html": (index, "text/html; charset=utf-8"),
                   "/map.json": (view.map_path, "application/json")}.get(path)
            if src is None and re.fullmatch(r"/[\w.-]+\.(js|css)", path):
                kind = "text/javascript" if path.endswith(".js") else "text/css"
                src = (index.parent / path[1:], kind + "; charset=utf-8")
            if src and src[0].exists():
                self.send(200, src[0].read_bytes(), src[1])
            else:
                self.send(404, b"not found", "text/plain")

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                if not isinstance(body, dict):
                    raise ValueError("expected a JSON object")
            except ValueError as e:
                return self.json({"error": f"bad request: {e}"}, 400)
            view = reviews.view
            if self.path in ("/api/xray/explain", "/api/review/narrative"):
                try:
                    agents_ready.wait(30)
                    if error := agent_error(body):
                        raise RuntimeError(error)
                    if self.path == "/api/xray/explain":
                        result = view.below.explain(body["file"], int(body["line"]), body["agent"], body.get("model") or "")
                    else:
                        result = reviews.narrative(body["agent"], body.get("model") or "")
                except (RuntimeError, ValueError, KeyError) as e:
                    result = {"error": str(e)} | ({"labels": {}} if self.path == "/api/xray/explain" else {})
                return self.json(result)
            if self.path in ("/api/review/select", "/api/map/refresh"):
                try:
                    if self.path == "/api/review/select":
                        result = reviews.select(body.get("head"), body.get("base"))
                    else:
                        agents_ready.wait(30)
                        if reviews.status()["needs_model"] and (error := agent_error(body)):
                            raise RuntimeError(error)
                        reviews.refresh(body.get("agent"), body.get("model"))
                        result = {"started": True}
                except (RuntimeError, ValueError) as e:
                    result = {"status": "error", "error": str(e)}
                return self.json(result)
            if self.path != "/api/chat":
                return self.send(404, b"not found", "text/plain")
            agents_ready.wait(30)
            try:
                result = chat(body, view.map_path, view.repo)
            except (ValueError, AttributeError) as e:
                result = {"reply": f"Bad request: {e}", "actions": []}
            self.json(result)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{'127.0.0.1' if args.host == '0.0.0.0' else args.host}:{args.port}"
    print(f"ariadne on {url}", file=sys.stderr)
    if getattr(args, "open_browser", False):   # only now is the port listening
        page = url + ("/#review" if getattr(args, "review", None) is not None else "")
        threading.Thread(target=webbrowser.open, args=(page,), daemon=True).start()
    server.serve_forever()


def main():
    ap = argparse.ArgumentParser(prog="ariadne", description="Map a codebase and explore it in 3D.",
                                 epilog="Run `ariadne` in a repo to map it (first time) and open the viewer.")
    sub = ap.add_subparsers(dest="cmd")
    o = sub.add_parser("open", help="map the repo if needed, then serve it and open the browser (default)")
    b = sub.add_parser("build", help="map a repo with an agent CLI")
    a = sub.add_parser("assemble", help="merge part files into a map (advanced)")
    s = sub.add_parser("serve", help="serve the viewer for a mapped repo")
    r = sub.add_parser("pr", help="review the checkout's changes against the default branch (or --base)")
    r.add_argument("--pr", type=int, help="pull request number, for its title and description (needs gh)")
    for p in (o, b, r):
        p.add_argument("repo", nargs="?", default=".", help="repo folder (default: current folder)")
        p.add_argument("--jobs", type=int, help="parallel agent runs (default: one per batch)")
        p.add_argument("--batches", type=int, help="number of batches (default: by repo size, up to 16)")
    a.add_argument("parts", nargs="+")
    a.add_argument("--repo", required=True)
    for p in (o, b, r):
        p.set_defaults(only=None, reuse=None)   # set by a review's map update (Reviews.refresh)
    for p in (o, b, a, r):
        p.add_argument("-o", "--output", help="map file (default: ~/.local/share/ariadne/maps/)")
        p.add_argument("--base", help="git revision to count changed files against")
        p.add_argument("--no-llm", action="store_true", help="cluster by folder, no system flows")
        p.add_argument("--agent", help="claude | pi | opencode | codex (asked if missing)")
        p.add_argument("--model", help="e.g. sonnet, haiku, deepseek/deepseek-flash (asked if missing)")
        p.add_argument("--yes", action="store_true", help="don't ask for confirmation")
        p.add_argument("--fresh", action="store_true", help="re-map every part, ignoring the cache")
    s.add_argument("target", nargs="?", default=".", help="repo folder (default: current folder)")
    s.add_argument("--map", help="map file (default: the one `ariadne build` wrote)")
    s.add_argument("--repo", help=argparse.SUPPRESS)
    for p in (o, s, r):
        p.add_argument("--port", type=int, default=7777)
        p.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to allow other devices")
    argv = sys.argv[1:]
    if not argv or argv[0] not in {"open", "build", "assemble", "serve", "pr", "-h", "--help"}:
        argv = ["open"] + argv
    args = ap.parse_args(argv)
    if args.cmd in ("open", "pr"):
        repo = repo_dir(args.repo)
        args.output = args.output or str(default_map(repo))
        if not Path(args.output).is_file():
            build(args)
        args.target, args.map, args.repo = str(repo), args.output, None
        args.open_browser = True
        if args.cmd == "pr":   # --base is the review's base here, not the map's
            args.review = {"base": args.base, "pr": args.pr}
        serve(args)
    else:
        {"build": build, "assemble": assemble, "serve": serve}[args.cmd](args)


if __name__ == "__main__":
    main()
