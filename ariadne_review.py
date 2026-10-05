"""PR review engine (REVIEW.md): what changed between two revisions, function by function.

Deterministic: git for the changed files and their text, tree-sitter (ariadne_xray, ariadne_gates) for the
functions, their control flow, literals and gates. Never a model.
"""
import difflib
import functools
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from ariadne import EXTERNAL_KINDS, GENERATED, TESTS, guess_kind
from ariadne_gates import gates as find_gates
from ariadne_xray import CASES, CATCHES, CALLS, CLOSURES, ELSE_IFS, FUNCS, IFS, ITERATORS, LANGS, LOOPS, NOISE_WORDS, \
    PROTOCOL, RETURNS, SWITCHES, THROWS, Walk, assigned_name, body_of, clip, function_name, \
    functions as find_functions, get_parser, text, unparen, words

RISKS = ["none", "low", "medium", "high"]
RANK = {r: i for i, r in enumerate(RISKS)}
WRITE_KINDS = {"db", "queue", "storage", "payment"}
PAYMENT = re.compile(r"stripe|paddle|payment|billing|braintree|adyen|checkout\.com")
NETWORK = {"http", "https", "requests", "httpx", "aiohttp", "axios", "fetch", "urlopen", "client", "stub", "grpc",
           "rest", "api"}
QUEUE = {"producer", "publisher", "publish", "produce", "broker", "topic"}
DB = {"db", "sql", "sqlx", "gorm", "tx", "txn", "cursor", "conn", "query", "exec"}
LIMIT_WORDS = {  # literal changes in statements naming these are medium; the phrase names the change
    "timeout": "Timeout", "timeouts": "Timeout", "deadline": "Timeout",
    "interval": "Duration", "ttl": "Duration", "duration": "Duration", "delay": "Duration", "backoff": "Duration",
    "second": "Duration", "seconds": "Duration", "minute": "Duration", "minutes": "Duration", "hour": "Duration",
    "hours": "Duration", "ms": "Duration", "millis": "Duration", "milliseconds": "Duration",
    "retry": "Retries", "retries": "Retries", "attempts": "Retries",
    "size": "Size", "limit": "Limit", "max": "Limit", "min": "Limit", "count": "Limit"}
INVERSE = {("==", "!="), ("===", "!=="), ("<", ">="), (">", "<="), ("is", "is not")}
INVERSE |= {(b, a) for a, b in INVERSE}
NEGATIONS = {"!", "not"}
OP_TOKEN = re.compile(r"===|!==|==|!=|<=|>=|&&|\|\||\w+|\S")
LITERAL_TEXT = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`[^`]*`|\b\d[\w.]*')
STRINGISH = re.compile(r"string|char_literal|^template_string$")
NUMBERISH = re.compile(r"^(integer|float|number|decimal|hex|octal|binary|real|int_literal|float_literal)|"
                       r"(integer|float|number|real)_literal$|^(int|float|imaginary)$")
MAX_CACHE = 4096
_cache = {}


# ---------------------------------------------------------------- git

def git(repo, *args, input=None):
    r = subprocess.run(["git", *args], cwd=repo, capture_output=True, input=input)
    if r.returncode != 0:
        raise RuntimeError(f"git {args[0]}: " + (r.stderr.decode("utf-8", "replace").strip().splitlines()
                                                  or ["failed"])[-1])
    return r.stdout


def rev_parse(repo, rev):
    return git(repo, "rev-parse", "--verify", "--quiet", rev + "^{commit}").decode().strip()


def default_base(repo) -> str:
    """The default branch: origin/HEAD, else main/master/dev (local, then on origin)."""
    try:
        return git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").decode().strip()
    except RuntimeError:
        pass
    for name in ("main", "master", "dev", "origin/main", "origin/master", "origin/dev"):
        try:
            rev_parse(repo, name)
            return name
        except RuntimeError:
            continue
    raise RuntimeError("no default branch (origin/HEAD, main, master or dev); pass a base")


def revs(repo, base, head):
    """(base sha the diff starts from, base ref as given, head sha or None for the working tree).
    Like GitHub's pull request diff, the head is compared from its merge-base with base (git diff base...head),
    so commits that landed on base meanwhile are not counted as changes."""
    ref = base or default_base(repo)
    head_sha = rev_parse(repo, head) if head else None
    return git(repo, "merge-base", ref, head_sha or "HEAD").decode().strip(), ref, head_sha


def fetch_base(repo, ref):
    """Bring a remote base (origin/main) up to date, as GitHub sees it; offline or without access, keep the local copy."""
    if not ref.startswith("origin/"):
        return
    try:
        subprocess.run(["git", "fetch", "--no-tags", "--quiet", "origin", ref.removeprefix("origin/")], cwd=repo,
                       capture_output=True, timeout=30, stdin=subprocess.DEVNULL, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    except subprocess.TimeoutExpired:
        pass


def changed(repo, base_sha, head_sha):
    """[(status, path, old path or None, added, removed)] between base and head (None: working tree)."""
    span = [base_sha, head_sha] if head_sha else [base_sha]
    raw = git(repo, "diff", "-M", "--name-status", "-z", *span).decode("utf-8", "replace").split("\0")
    entries, i = [], 0
    while i < len(raw) - 1:
        code = raw[i]
        if code[0] in "RC":
            entries.append(("renamed" if code[0] == "R" else "added", raw[i + 2], raw[i + 1] if code[0] == "R" else None))
            i += 3
        else:
            entries.append(({"A": "added", "D": "deleted"}.get(code[0], "modified"), raw[i + 1], None))
            i += 2
    counts, raw, i = {}, git(repo, "diff", "-M", "--numstat", "-z", *span).decode("utf-8", "replace").split("\0"), 0
    while i < len(raw) - 1:
        added, removed, path = raw[i].split("\t", 2)
        if not path:  # a rename: old and new path follow
            path, i = raw[i + 2], i + 2
        counts[path] = (int(added) if added.isdigit() else 0, int(removed) if removed.isdigit() else 0)
        i += 1
    out = [(s, p, o, *counts.get(p, (0, 0))) for s, p, o in entries]
    if head_sha is None:
        for p in git(repo, "ls-files", "-z", "--others", "--exclude-standard").decode("utf-8", "replace").split("\0"):
            if p:
                out.append(("added", p, None, line_count(Path(repo) / p), 0))
    return out


def line_count(path):
    try:
        data = path.read_bytes()
    except OSError:
        return 0
    return 0 if b"\0" in data[:4096] else data.count(b"\n") + (not data.endswith(b"\n") and bool(data))


def blob_shas(repo, rev, paths):
    """{path: blob sha} of the given paths at rev."""
    if not paths:
        return {}
    out = {}
    for row in git(repo, "ls-tree", "-r", "-z", rev, "--", *paths).decode("utf-8", "replace").split("\0"):
        if row:
            meta, path = row.split("\t", 1)
            out[path] = meta.split()[2]
    return out


def read_blobs(repo, shas):
    """{sha: bytes} for blob shas, in one git process."""
    shas = sorted(set(shas))
    if not shas:
        return {}
    data, out, pos = git(repo, "cat-file", "--batch", input="".join(s + "\n" for s in shas).encode()), {}, 0
    for sha in shas:
        end = data.index(b"\n", pos)
        header = data[pos:end].split()
        if header[1] == b"missing":
            pos = end + 1
            continue
        size = int(header[2])
        out[sha] = data[end + 1:end + 1 + size]
        pos = end + 1 + size + 1
    return out


def show(repo, rev, path):
    try:
        return git(repo, "show", f"{rev}:{path}")
    except RuntimeError:
        return None


def file_text(repo, rev, path) -> str | None:
    """Text of path at rev (None: the working tree), or None when it is not there."""
    if rev is None:
        data = read_file(Path(repo) / path)
    else:
        data = show(repo, rev, path)
    return None if data is None else data.decode("utf-8", "replace")


def diff_file(repo, base_sha, head_sha, path, old) -> dict:
    """GET /api/diff: both versions of a file (old: its path at base) and their line alignment, 1-based:
    ["=", b, h] | ["-", b, 0] | ["+", 0, h], removals before additions."""
    b, h = file_text(repo, base_sha, old), file_text(repo, head_sha, path)
    b = None if b is None else b.splitlines()
    h = None if h is None else h.splitlines()
    ops = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, b or [], h or [], autojunk=False).get_opcodes():
        if op == "equal":
            ops += [["=", i + 1, j + 1] for i, j in zip(range(i1, i2), range(j1, j2))]
        else:
            ops += [["-", i + 1, 0] for i in range(i1, i2)] + [["+", 0, j + 1] for j in range(j1, j2)]
    return {"path": path, "old": old if old != path else None, "base": b, "head": h, "ops": ops}


# ---------------------------------------------------------------- branches and PRs

def branches(repo) -> dict:
    try:
        default = default_base(repo)
    except RuntimeError:
        default = None
    fmt = "%(refname)%00%(objectname)%00%(committerdate:iso-strict)" + (
        f"%00%(ahead-behind:{default})" if default else "")
    rows = git(repo, "for-each-ref", "--sort=-committerdate", f"--format={fmt}", "refs/heads", "refs/remotes")
    local, remote = [], []
    for row in rows.decode("utf-8", "replace").splitlines():
        ref, sha, updated, *ab = row.split("\0")
        if ref.endswith("/HEAD"):
            continue
        ahead, behind = (int(x) for x in ab[0].split()) if ab and ab[0] else (None, None)
        is_remote = ref.startswith("refs/remotes/")
        name = ref.removeprefix("refs/remotes/" if is_remote else "refs/heads/")
        (remote if is_remote else local).append({"name": name, "rev": sha, "short": sha[:7], "updated": updated,
                                                 "ahead": ahead, "behind": behind, "remote": is_remote})
    names = {b["name"] for b in local}
    remote = [b for b in remote if b["name"].split("/", 1)[-1] not in names]
    out = {"current": git(repo, "branch", "--show-current").decode().strip() or None,
           "dirty": bool(git(repo, "status", "--porcelain").strip()), "default": default,
           "branches": (local + remote)[:50]}
    out.update(pull_requests(repo))
    return out


def gh(repo, *args):
    """Parsed JSON output of a gh command; RuntimeError when gh is missing, fails or times out."""
    if shutil.which("gh") is None:
        raise RuntimeError("gh is not installed")
    try:
        r = subprocess.run(["gh", *args], cwd=repo, capture_output=True, text=True, timeout=20,
                           stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"gh {' '.join(args[:2])} timed out")
    if r.returncode != 0:
        raise RuntimeError((r.stderr.strip().splitlines() or [f"gh {' '.join(args[:2])} failed"])[-1])
    return json.loads(r.stdout or "null")


def pull_requests(repo):
    try:
        url = git(repo, "config", "--get", "remote.origin.url").decode()
    except RuntimeError:
        url = ""
    if "github.com" not in url:
        return {"prs": None, "prs_error": "no GitHub remote"}
    try:
        return {"prs": gh(repo, "pr", "list", "--limit", "50", "--json",
                          "number,title,headRefName,author,updatedAt,isDraft") or []}
    except RuntimeError as e:
        return {"prs": None, "prs_error": str(e)}


def pr_info(repo, n):
    """Title, description and URL of pull request n; only its number when gh can't tell."""
    try:
        return gh(repo, "pr", "view", str(int(n)), "--json", "number,title,body,url,baseRefName")
    except RuntimeError:
        return {"number": int(n), "title": "", "body": "", "url": ""}


def pr_head(repo, n) -> str:
    """Fetch pull request n's head from origin; its commit sha."""
    git(repo, "fetch", "--no-tags", "--quiet", "origin", f"pull/{int(n)}/head")
    return rev_parse(repo, "FETCH_HEAD")


# ---------------------------------------------------------------- review

def review(repo, base=None, head=None, *, part_of, known_functions, effect_targets, callers, metro_entries) -> dict:
    """REVIEW.md review JSON without "pr". head None: the working tree (HEAD plus uncommitted changes)."""
    repo = Path(repo)
    base_sha, ref, head_sha = revs(repo, base, head)
    entries = changed(repo, base_sha, head_sha)
    files, todo, sql, envs = [], [], [], []
    for status, path, old, added, removed in entries:
        gen, test = bool(GENERATED.search(path)), bool(TESTS.search(path))
        files.append({"path": path, "status": status, "old": old, "part": part_of(path), "added": added,
                      "removed": removed, "generated": gen, "test": test})
        if not gen and not test and Path(path).suffix.lower() in LANGS:
            todo.append((status, path, old or path))
        elif not gen and not test and path.endswith(".sql"):
            sql.append((status, path, old or path))
        elif ENV_FILE.search(path):
            envs.append((status, path, old or path))

    base_blobs = blob_shas(repo, base_sha, [o for s, _, o in todo if s != "added"])
    head_text = {}
    if head_sha:
        head_blobs = blob_shas(repo, head_sha, [p for s, p, _ in todo if s != "deleted"])
    else:
        head_blobs = {}
        for s, p, _ in todo:
            if s != "deleted" and (data := read_file(repo / p)) is not None:
                head_text[p] = data
                head_blobs[p] = hashlib.sha1(data).hexdigest()
    jobs, missing = [], set()
    for status, path, old in todo:
        b, h = base_blobs.get(old), head_blobs.get(path)
        known, targets = known_functions(path), effect_targets(path)
        key = (path, old, b, h, frozenset(known), frozenset(targets.items()))
        jobs.append((key, path, b, h, known, targets))
        if key not in _cache:
            missing |= {s for s in (b, h if head_sha else None) if s}
    blobs = read_blobs(repo, missing)
    if len(_cache) > MAX_CACHE:
        _cache.clear()
    fns, gate_parts, local = [], [], {}
    by_path = {f["path"]: f for f in files}
    for key, path, b, h, known, targets in jobs:
        if key not in _cache:
            base_src, head_src = blobs.get(b) if b else None, (blobs.get(h) if head_sha else head_text.get(path)) if h else None
            _cache[key] = {"generated": True} if machine_made(head_src or base_src) else \
                analyse(path, base_src, head_src, known, targets)
        result = _cache[key]
        if result.get("generated"):   # generated code (sqlc, protoc, …) is listed, not reviewed
            by_path[path]["generated"] = True
            continue
        fns += [dict(f, changes=[dict(c) for c in f["changes"]]) for f in result["functions"]]
        gate_parts += result["gates"]
        local[path] = result["names"]

    for f in fns:
        f["part"] = part_of(f["file"])
        found = callers(f["file"], f["name"])
        lines = [dict(e, part=f["part"]) for name in [f["name"], *found] if f["part"] is not None
                 for e in metro_entries(f["part"], name)]
        f["blast"] = {"entries": list({(e["part"], e["line"]): e for e in lines}.values()), "callers": found}
        outside = set(found) - local[f["file"]]
        for c in f["changes"]:
            if c["kind"] == "signature" and outside:
                c["severity"], c["why"] = "high", "Signature changed, called from other files"
        top = max((RANK[c["severity"]] for c in f["changes"]), default=0)
        if f["status"] != "modified":
            top = max(top, 1)
        f["risk"] = RISKS[top]

    sql_out = sql_review(repo, base_sha, head_sha, sql, fns, part_of)   # named queries join fns
    called = connect(fns, local)
    for m in sql_out["lifecycles"]:
        for t in m["transitions"]:
            t["by"] = [f["id"] for f in fns if t["via"] in called[f["id"]]]
    tests = {p: set(re.findall(r"[A-Za-z_]\w*", t)) for p, t in texts(repo, head_sha, [
        f["path"] for f in files if f["test"] and f["status"] != "deleted"]).items()}
    for f in fns:
        f["tests"] = [p for p, names in tests.items() if f["name"] in names]
    for f in files:
        f["role"] = role(f)
    order = flow(fns)
    parts = {}
    for f in fns:
        if f["part"] is not None:
            p = parts.setdefault(f["part"], {"id": f["part"], "risk": "none", "functions": [], "lines": set()})
            p["functions"].append(f["id"])
            p["lines"] |= {e["line"] for e in f["blast"]["entries"]}
            if RANK[f["risk"]] > RANK[p["risk"]]:
                p["risk"] = f["risk"]
    severities = [c["severity"] for f in fns for c in f["changes"]]
    head_rev = head_sha or git(repo, "rev-parse", "HEAD").decode().strip()
    return {
        "status": "ready",
        "base": {"rev": base_sha, "short": base_sha[:7], "ref": ref},
        "head": {"rev": head_rev, "short": head_rev[:7],
                 "dirty": head_sha is None and bool(git(repo, "status", "--porcelain").strip())},
        "files": files,
        "functions": fns,
        "gates": merge_gates(gate_parts),
        "parts": [dict(p, lines=sorted(p["lines"])) for p in parts.values()],
        "stats": {"files": len(files),
                  "functions": {s: sum(f["status"] == s for f in fns) for s in ("added", "removed", "modified")},
                  **{s: severities.count(s) for s in ("high", "medium", "low")}},
        "flow": order,
        "tour": order["order"],
        "config": config_changes(repo, base_sha, head_sha, envs),
        **sql_out,
    }


def read_file(path):
    try:
        return path.read_bytes()
    except OSError:
        return None


def line_of(f):
    return f["file"], (f["head"] or f["base"])["start"]


def connect(fns, local):
    """Each function's call sites become "calls" to the reviewed functions they name (a name shared by several:
    the one in the caller's folder, else none); local: {file: names of its functions}. Returns {id: every name it
    calls}, reviewed or not."""
    by_name, names = {}, {}
    for f in fns:
        by_name.setdefault(f["name"], []).append(f)
    for f in fns:
        sites, f["calls"] = f.pop("sites"), []
        names[f["id"]] = {s[0] for s in sites}
        folder = os.path.dirname(f["file"])
        for name, recv, line, when, loop in sites:
            found = [g for g in by_name.get(name, []) if g is not f and reaches(name, recv, f, g, local)]
            if len(found) > 1:
                found = [g for g in found if os.path.dirname(g["file"]) == folder]
            if len(found) == 1:
                f["calls"].append({"to": found[0]["id"], "line": line, "when": when, "loop": loop})
        # a condition every call shares is the function's precondition, not a branch between its calls
        common = set.intersection(*(set(c["when"]) for c in f["calls"])) if len(f["calls"]) > 1 else set()
        for c in f["calls"]:
            c["when"] = short(" · ".join(reversed([w for w in c["when"] if w not in common][:2]))) or None
    return names


def reaches(name, recv, f, g, local):
    """Whether f calling name through receiver recv ("" for a bare call) can mean g: a query through any store; in
    the same language, and not a name f's own file defines, a method through an object (bare or self: its own file)
    and a plain function bare or through its module or package (pkg.Fn, not re.match). Common names (add, get) never
    reach another file."""
    if g.get("kind") == "query":
        return True
    if g["file"] == f["file"]:
        return True
    if family(g["file"]) != family(f["file"]) or name in local.get(f["file"], ()) or name in COMMON:
        return False
    if g["parent"]:
        return recv not in ("", "self", "this", "cls")
    # a Go function is reached only through its package, whatever the import calls it
    return not recv or family(g["file"]) == "go" or recv in (Path(g["file"]).stem, Path(g["file"]).parent.name)


def family(path):
    lang = LANGS.get(Path(path).suffix.lower())
    return {"typescript": "javascript", "tsx": "javascript", "c": "cpp"}.get(lang, lang)


def flow(fns):
    """{roots, order}: roots are the functions no reviewed function calls, entry points first (main, cmd/, handlers,
    exported), then the ones reaching most; order walks the calls depth-first from them, then the rest by place."""
    by_id = {f["id"]: f for f in fns}
    called = {c["to"] for f in fns for c in f["calls"]}

    def reach(fid, seen):
        if fid not in seen:
            seen.add(fid)
            for c in by_id[fid]["calls"]:
                reach(c["to"], seen)
        return seen

    def entry(f):
        name, go = f["name"], f["file"].endswith(".go")
        if f.get("kind") == "query":
            return 3
        if name == "main" or "/cmd/" in "/" + f["file"] or re.match(r"(?i)handle|serve", name) \
                or "(" in name and not name.startswith("(closure"):
            return 0
        return 2 if name.startswith("_") or go and not name[:1].isupper() else 1

    roots = sorted((f for f in fns if f["id"] not in called),
                   key=lambda f: (entry(f), -len(reach(f["id"], set())), *line_of(f)))
    order, seen = [], set()
    for f in roots + sorted(fns, key=line_of):
        order += preorder(f["id"], by_id, seen)
    return {"roots": [f["id"] for f in roots], "order": order}


def preorder(fid, by_id, seen):
    """Ids reached from fid along calls in source order, depth first, skipping seen ones."""
    out, todo = [], [fid]
    while todo:
        fid = todo.pop()
        if fid not in seen:
            seen.add(fid)
            out.append(fid)
            todo += reversed([c["to"] for c in by_id[fid]["calls"]])
    return out


def texts(repo, rev, paths):
    """{path: text} of paths at rev (None: the working tree), in one git process."""
    if rev is None:
        return {p: d.decode("utf-8", "replace") for p in paths if (d := read_file(Path(repo) / p)) is not None}
    shas = blob_shas(repo, rev, paths)
    blobs = read_blobs(repo, shas.values())
    return {p: blobs[s].decode("utf-8", "replace") for p, s in shas.items() if s in blobs}


ENV_FILE = re.compile(r"(^|/)\.env(\.[\w.-]+)?$|\.env$")
ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$", re.M)
SECRET = re.compile(r"SECRET|TOKEN|PASSWORD|PASSWD|KEY|CREDENTIAL|DSN", re.I)


def config_changes(repo, base_sha, head_sha, envs):
    """Keys added, removed or changed in env files (KEY=VALUE); secret-looking values are hidden."""
    before = texts(repo, base_sha, [o for s, _, o in envs if s != "added"])
    after = texts(repo, head_sha, [p for s, p, _ in envs if s != "deleted"])
    out = []
    for status, path, old in envs:
        b = dict(ENV_LINE.findall(before.get(old, ""))) if status != "added" else {}
        h = dict(ENV_LINE.findall(after.get(path, ""))) if status != "deleted" else {}
        for k in dict.fromkeys([*h, *b]):
            if b.get(k) == h.get(k):
                continue
            op = "added" if k not in b else "removed" if k not in h else "changed"
            value = h.get(k, b.get(k)).strip("'\"")
            out.append({"file": path, "key": k, "op": op, "value": "•••" if SECRET.search(k) and value else clip(value)})
    return out


DEPLOY = re.compile(r"(^|/)(Dockerfile[^/]*|[^/]*\.dockerfile|docker-compose[^/]*|compose\.ya?ml|cloudbuild[^/]*|"
                    r"Procfile|Jenkinsfile|skaffold[^/]*|fly\.toml|app\.ya?ml|serverless\.ya?ml|\.gitlab-ci\.yml|"
                    r"[^/]*\.tf|[^/]*\.tfvars)$|(^|/)(\.github/workflows|k8s|kubernetes|helm|charts|deploy|terraform)/")
DEPS = re.compile(r"(^|/)(go\.(mod|sum|work)|package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|"
                  r"pyproject\.toml|uv\.lock|poetry\.lock|Pipfile(\.lock)?|Cargo\.(toml|lock)|Gemfile(\.lock)?|"
                  r"pom\.xml|build\.gradle(\.kts)?|composer\.(json|lock))$")
DOCS = re.compile(r"\.(md|mdx|rst|adoc|txt)$|(^|/)(docs?/|LICENSE|CHANGELOG)", re.I)
WEB = {".sql", ".css", ".scss", ".sass", ".less", ".html", ".vue", ".svelte"}
CONFIG = re.compile(r"\.(ya?ml|json|toml|ini|cfg|conf|properties|env)$|(^|/)\.env")


def role(f):
    """code | test | generated | config | deploy | deps | docs | other, from the file's path."""
    p = f["path"]
    if f["generated"]:
        return "generated"
    if f["test"]:
        return "test"
    for name, rx in (("deploy", DEPLOY), ("deps", DEPS), ("docs", DOCS)):
        if rx.search(p):
            return name
    if Path(p).suffix.lower() in LANGS or Path(p).suffix.lower() in WEB:
        return "code"
    return "config" if CONFIG.search(p) else "other"


def merge_gates(parts):
    """One entry per gate across files: added/removed when every file agrees, else changed."""
    out = {}
    for g in parts:
        m = out.setdefault(g["id"], dict(g, refs=[]))
        if m["op"] != g["op"]:
            m["op"] = "changed"
        m["refs"] += g["refs"]
    return sorted(out.values(), key=lambda g: g["id"])


def machine_made(data):
    """Generated files say so in their first lines (Go's "Code generated … DO NOT EDIT", "@generated")."""
    return bool(data) and bool(re.search(rb"Code generated .*DO NOT EDIT|@generated|autogenerated", data[:4096], re.I))


# ---------------------------------------------------------------- SQL: queries, schema, lifecycles

SQL_NAME = re.compile(r"^--\s*name:\s*(\w+)\s*:(\w+)", re.M)   # sqlc
SQL_LIT = r"'([^']*)'"
STATE_COL = re.compile(r"(state|status|phase|stage)$", re.I)


def sql_units(text):
    """Named queries (sqlc "-- name: X :kind" blocks, with the comment under the name as their summary); a file
    without names (a migration) is one unit per statement. Each: name, doc, start/end lines, code (no comments)."""
    if not text:
        return {}
    lines, marks = text.splitlines(), [(m.start(), m[1]) for m in SQL_NAME.finditer(text)]
    starts = [text.count("\n", 0, at) for at, _ in marks]
    units = {}
    for k, (at, name) in enumerate(marks):
        end = starts[k + 1] if k + 1 < len(marks) else len(lines)
        body = lines[starts[k] + 1:end]
        doc = " ".join(l.lstrip("- ").strip() for l in body if l.strip().startswith("--")).strip()
        code = " ".join(re.sub(r"--.*", "", l) for l in body).strip()
        units[name] = {"name": name, "doc": doc, "start": starts[k] + 1, "end": end, "code": " ".join(code.split())}
    if not marks:
        line = 0
        bare = "\n".join(re.sub(r"--.*", "", l) for l in lines)   # comments go first: they may hold a ';'
        for stmt in bare.split(";"):
            code = " ".join(stmt.split())
            first = line + next((i for i, l in enumerate(stmt.splitlines()) if l.strip()), 0)
            line += stmt.count("\n")
            if code:
                units[f"{code[:60]}@{first}"] = {"name": code.split("(")[0][:60], "doc": "", "start": first + 1, "end": line + 1, "code": code}
    return units


def top_split(text, sep):
    """text split at sep (a regex) outside parentheses."""
    parts, depth, last = [], 0, 0
    for m in re.finditer(r"\(|\)|" + sep, text, re.I):
        if m[0] == "(":
            depth += 1
        elif m[0] == ")":
            depth -= 1
        elif depth == 0:
            parts.append(text[last:m.start()]); last = m.end()
    return parts + [text[last:]]


def sql_facts(code):
    """What a statement does: its verb and tables, the literal guards in its WHERE, the literal values it sets."""
    verb = (re.match(r"\s*(\w+)", code) or [None, ""])[1].upper()
    up = code.upper()
    tables = re.findall(r"\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|JOIN)\s+([\w.]+)", code, re.I)
    where = code[up.find(" WHERE ") + 7:] if " WHERE " in up else ""
    where = re.split(r"\b(?:ORDER\s+BY|GROUP\s+BY|LIMIT|RETURNING|ON\s+CONFLICT)\b", where, flags=re.I)[0]
    guards = [clip(re.sub(r"\(\s*SELECT\b.*\)", "(…)", g.strip(" ;"))) for g in top_split(where, r"\bAND\b")
              if re.search(SQL_LIT + r"|\bEXISTS\b|\bNULL\b", g)]
    sets = dict(re.findall(r"(\w+)\s*=\s*" + SQL_LIT, code[up.find(" SET ") + 5:].split(" WHERE ")[0])) if " SET " in up else {}
    return {"verb": verb, "tables": list(dict.fromkeys(t for t in tables if not t.lower().startswith("sqlc"))),
            "guards": guards, "sets": sets, "conflict": bool(re.search(r"ON\s+CONFLICT.*DO\s+NOTHING", code, re.I))}


def query_effects(u):
    """The tables a query writes (the first one of INSERT/UPDATE/DELETE) and reads."""
    f = sql_facts(u["code"])
    write = f["verb"] in ("INSERT", "UPDATE", "DELETE")
    return [{"kind": "db", "target": t, "op": "writes" if write and i == 0 else "reads", "line": u["start"]}
            for i, t in enumerate(f["tables"])]


def query_changes(b, h):
    """Change records (like functions') for one named query, base b and head h (either may be None)."""
    out = []
    if not b:   # new: say what it does, briefly
        f = sql_facts(h["code"]); write = f["verb"] in ("INSERT", "UPDATE", "DELETE")
        what = f"{f['verb'].title()} {', '.join(f['tables'][:2])}" if f["tables"] else f["verb"].title()
        out.append(change("effect", "added", None, what, None, h["start"], "medium" if write else "low",
                          ("Writes " if write else "Reads ") + ", ".join(f["tables"][:2])))
        out += [change("condition", "added", None, g, None, h["start"], "low", "Only when " + g) for g in f["guards"][:2]]
        return out
    if not h:
        return [change("effect", "removed", b["code"][:80], None, b["start"], None, "medium", "Query removed")]
    fb, fh = sql_facts(b["code"]), sql_facts(h["code"])
    for g in fb["guards"]:
        if g not in fh["guards"]:
            out.append(change("condition", "removed", g, None, b["start"], h["start"], "high", "Guard removed: " + g))
    for g in fh["guards"]:
        if g not in fb["guards"]:
            out.append(change("condition", "added", None, g, b["start"], h["start"], "medium", "New guard: " + g))
    for col in fb["sets"].keys() | fh["sets"].keys():
        if fb["sets"].get(col) != fh["sets"].get(col):
            out.append(change("literal", "changed", fb["sets"].get(col), fh["sets"].get(col), b["start"], h["start"], "high",
                              f"Sets {col} to {fh['sets'].get(col) or 'nothing'} (was {fb['sets'].get(col) or 'nothing'})"))
    if fb["tables"] != fh["tables"] or fb["verb"] != fh["verb"]:
        out.append(change("effect", "changed", fb["verb"], fh["verb"], b["start"], h["start"], "high", "Now " + fh["verb"].lower() + "s " + ", ".join(fh["tables"])))
    if fb["conflict"] and not fh["conflict"]:
        out.append(change("condition", "removed", "ON CONFLICT DO NOTHING", None, b["start"], h["start"], "medium", "Duplicates no longer skipped"))
    if not out and b["code"] != h["code"]:
        out.append(change("call", "changed", None, None, b["start"], h["start"], "low", "Query changed"))
    return out


def schema_changes(rel, base_units, head_units):
    """New or dropped tables, enums, columns and indexes, from a migration's statements new in head."""
    old = {u["code"] for u in base_units.values()}
    out = []
    for u in head_units.values():
        c = u["code"]
        if c in old:
            continue
        ref = f"{rel}:{u['start']}"
        if m := re.match(r"CREATE TYPE (\w+) AS ENUM \((.*)\)", c, re.I):
            out.append({"kind": "enum", "op": "added", "name": m[1], "detail": re.findall(SQL_LIT, m[2]), "ref": ref})
        elif m := re.match(r"CREATE TABLE (?:IF NOT EXISTS )?([\w.]+) \((.*)\)", c, re.I):
            key = re.search(r"PRIMARY KEY \(([^)]*)\)", m[2], re.I)
            cols = [x.split()[0] for x in top_split(m[2], ",") if x.split() and not re.match(r"\s*(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b", x, re.I)]
            out.append({"kind": "table", "op": "added", "name": m[1], "detail": [f"{len(cols)} columns"] +
                        ([f"key: {', '.join(k.strip() for k in key[1].split(','))}"] if key else []), "ref": ref})
        elif m := re.match(r"CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?(\w+) ON ([\w.]+) ?\(([^)]*)\)", c, re.I):
            out.append({"kind": "index", "op": "added", "name": m[1], "detail": [f"on {m[2]} ({m[3].strip()})"], "ref": ref})
        elif m := re.match(r"ALTER TABLE ([\w.]+) (ADD|DROP) (?:COLUMN )?(?:IF (?:NOT )?EXISTS )?(\w+)", c, re.I):
            out.append({"kind": "column", "op": "added" if m[2].upper() == "ADD" else "removed", "name": f"{m[1]}.{m[3]}", "detail": [], "ref": ref})
        elif m := re.match(r"DROP (TABLE|TYPE|INDEX) (?:IF EXISTS )?([\w.]+)", c, re.I):
            out.append({"kind": m[1].lower(), "op": "removed", "name": m[2], "detail": [], "ref": ref})
    return out


def lifecycles(units, enums, defaults):
    """State machines in the head's queries: UPDATE … SET col = 'to' WHERE … col = 'from' is a transition, a new row
    starts at the column's default. Only state-like columns (state/status/phase/stage) or enum-typed ones count."""
    machines = {}
    for u in units:
        f = sql_facts(u["code"])
        if f["verb"] != "UPDATE" or not f["tables"]:
            continue
        for col, to in f["sets"].items():
            if not (STATE_COL.search(col) or (f["tables"][0], col) in enums):
                continue
            frm = next((v for g in f["guards"] for c, v in re.findall(r"(\w+)\s*=\s*" + SQL_LIT, g) if c == col), None)
            m = machines.setdefault((f["tables"][0], col), {"table": f["tables"][0], "field": col, "transitions": []})
            m["transitions"].append({"from": frm, "to": to, "via": u["name"], "ref": u["ref"]})
    out = []
    for (table, col), m in machines.items():
        states = enums.get((table, col)) or list(dict.fromkeys(s for t in m["transitions"] for s in (t["from"], t["to"]) if s))
        m["start"] = defaults.get((table, col))
        m["states"] = states
        out.append(m)
    return out


def sql_review(repo, base_sha, head_sha, sql, fns, part_of):
    """Named queries as reviewed functions (into fns), schema changes and the lifecycles the queries implement."""
    schema, units, enums, defaults = [], [], {}, {}
    for status, path, old in sql:
        if path.endswith(".down.sql"):   # a migration's rollback: not what the change does
            continue
        bt = None if status == "added" else file_text(repo, base_sha, old)
        ht = None if status == "deleted" else file_text(repo, head_sha, path)
        b, h = sql_units(bt), sql_units(ht)
        if SQL_NAME.search(bt or "") or SQL_NAME.search(ht or ""):   # named queries; otherwise a migration
            for name in dict.fromkeys([*b, *h]):
                bu, hu = b.get(name), h.get(name)
                if bu and hu and bu["code"] == hu["code"]:
                    units.append(dict(hu, ref=f"{path}:{hu['start']}"))
                    continue
                changes = query_changes(bu, hu)
                top = max((RANK[c["severity"]] for c in changes), default=1)
                fns.append({"id": f"{path}::{name}", "name": name, "parent": None, "file": path, "kind": "query",
                            "status": "modified" if bu and hu else "added" if hu else "removed", "summary": sentences((hu or bu)["doc"], name),
                            "base": bu and {"start": bu["start"], "end": bu["end"]}, "head": hu and {"start": hu["start"], "end": hu["end"]},
                            "changes": changes, "risk": RISKS[max(top, 1)], "part": part_of(path), "sites": [],
                            "effects": query_effects(hu or bu),
                            "blast": {"entries": [], "callers": []}})
                if hu:
                    units.append(dict(hu, ref=f"{path}:{hu['start']}"))
        else:
            schema += schema_changes(path, b, h)
        for u in h.values():   # enum types and state defaults, wherever the migration declares them
            for m in re.finditer(r"CREATE TABLE (?:IF NOT EXISTS )?([\w.]+) \((.*)\)", u["code"], re.I):
                for col, typ, rest in (re.match(r"\s*(\w+)\s+(\w+)(.*)", x, re.S).groups() for x in top_split(m[2], ",") if re.match(r"\s*\w+\s+\w+", x)):
                    if d := re.search(r"DEFAULT " + SQL_LIT, rest, re.I):
                        defaults[(m[1], col)] = d[1]
                    enum = next((e["detail"] for e in schema if e["kind"] == "enum" and e["name"] == typ), None)
                    if enum:
                        enums[(m[1], col)] = enum
    return {"schema": schema, "lifecycles": lifecycles(units, enums, defaults)}


# ---------------------------------------------------------------- one file

def analyse(rel, base_src, head_src, known, targets):
    """{"functions": [...], "gates": [...]} for one file; functions carry changes but no part/blast/risk."""
    lang = LANGS[Path(rel).suffix.lower()]
    base = Version(lang, base_src)
    head = Version(lang, head_src)
    base_targets = map_lines(head_src, base_src, targets)
    pairs = match(base.fns, head.fns)
    shared = {n for v in (base, head) for n in {f["name"] for f in v.fns}
              if sum(f["name"] == n for f in v.fns) > 1}  # overloads, same method in two classes
    out = []
    for b, h in pairs:
        if b and h and b["norm"] == h["norm"]:
            continue
        status = "modified" if b and h else "added" if h else "removed"
        f = b or h
        ident = f"{f['parent']}.{f['name']}" if f["name"] in shared and f["parent"] else f["name"]
        own = h or b   # what the function is now; a removed one as it was
        fn = {"id": f"{rel}::{ident}", "name": f["name"], "parent": f["parent"], "file": rel, "status": status,
              "base": span(b), "head": span(h), "changes": [], "summary": summary(own["node"], f["name"]),
              "sites": call_sites(own["node"])}
        if status == "modified":
            bx = Walk(lang, b["node"], set(known), base_targets).run(rel)
            x = Walk(lang, h["node"], set(known), targets).run(rel)
            fn["changes"] = node_changes(flatten(bx), flatten(x)) + literal_changes(b, h)
            if b["sig"] != h["sig"]:
                fn["changes"].append(change("signature", "changed", entry_text(bx), entry_text(x), b["start"],
                                            h["start"], "medium", "Signature changed"))
        else:
            x = Walk(lang, f["node"], set(known), targets if h else base_targets).run(rel)
            fn["changes"] = node_changes(*((flatten(x), []) if b else ([], flatten(x))), effects_only=True)
        fn["effects"] = code_effects(x)
        out.append(fn)
    seen = set()
    for fn in out:  # functions with the same id in both versions but unmatched: keep ids unique
        while fn["id"] in seen:
            fn["id"] += f"@{(fn['head'] or fn['base'])['start']}"
        seen.add(fn["id"])
    gates = gate_changes(rel, base, head, out)
    for fn in out:
        fn["changes"].sort(key=lambda c: (c["head_line"] or c["base_line"] or 0))
    return {"functions": out, "gates": gates, "names": {f["name"] for f in head.fns}}


class Version:
    """One version of a file: its syntax tree and functions."""

    def __init__(self, lang, src):
        self.src, self.fns = src, []
        if src is None:
            return
        self.root = parser(lang).parse(src).root_node
        # one-line anonymous closures outside functions (styled-components props, …) are not worth a row
        nodes = [n for n in find_functions(self.root, lang)
                 if n.start_point[0] < n.end_point[0] or not function_name(n).startswith("(closure")]
        ids = {n.id for n in nodes}
        for n in nodes:
            toks = tokens(n, ids)
            body = body_of(n)
            cut = body.start_byte if body is not None else n.end_byte
            self.fns.append({"node": n, "name": function_name(n), "parent": owner(n), "start": n.start_point[0] + 1,
                             "end": n.end_point[0] + 1, "tokens": toks, "norm": " ".join(t for t, _ in toks),
                             "sig": [t for t, node in toks if node.start_byte < cut and node.end_byte <= cut]})

    def fn_at(self, line):
        inside = [f for f in self.fns if f["start"] <= line <= f["end"]]
        return min(inside, key=lambda f: f["end"] - f["start"], default=None)


@functools.cache
def parser(lang):
    return get_parser(lang)


def tokens(fn, skip):
    """[(text, node)] leaves of fn without comments and without nested functions; strings are one token."""
    out, todo = [], [fn]
    while todo:
        n = todo.pop()
        if n is not fn and n.id in skip:
            out.append(("<fn>", n))
        elif "comment" in n.type:
            continue
        elif n.child_count == 0 or n.is_named and STRINGISH.search(n.type) and not re.search(
                r"content|fragment|start|end|escape", n.type):
            if t := n.text.decode("utf-8", "replace"):
                out.append((t, n))
        else:
            todo += reversed(n.children)
    return out


def owner(fn):
    """Class/type a function belongs to: the enclosing class-like declaration, or a Go method's receiver type."""
    if fn.type == "method_declaration" and (recv := fn.child_by_field_name("receiver")) is not None:
        names = re.findall(r"[A-Za-z_]\w*", recv.text.decode("utf-8", "replace"))
        return names[-1] if names else None
    n = fn.parent
    while n is not None:
        if re.search(r"class|interface|impl_item|trait|object_declaration|module|struct|enum", n.type) \
                and not n.type.endswith(("_body", "_list")):
            name = n.child_by_field_name("name") or n.child_by_field_name("type")
            if name is not None:
                return name.text.decode("utf-8", "replace")
        n = n.parent
    return None


def span(f):
    return {"start": f["start"], "end": f["end"]} if f else None


def match(base, head):
    """[(base fn | None, head fn | None)]: by (parent, name) in order, then by name when unique."""
    pairs, free = [], list(head)
    for b in base:
        h = next((h for h in free if (h["parent"], h["name"]) == (b["parent"], b["name"])), None)
        if h is not None:
            free.remove(h)
        pairs.append([b, h])
    left = [p for p in pairs if p[1] is None]
    for p in left:
        same = [h for h in free if h["name"] == p[0]["name"]]
        if len(same) == 1 and sum(q[0]["name"] == p[0]["name"] for q in left) == 1:
            p[1] = same[0]
            free.remove(same[0])
    return [tuple(p) for p in pairs] + [(None, h) for h in free]


def map_lines(head_src, base_src, targets):
    """Head-line effect targets carried over to the base lines they are unchanged from."""
    if not targets or head_src is None or base_src is None:
        return {}
    b, h = base_src.split(b"\n"), head_src.split(b"\n")
    out = {}
    for blk in difflib.SequenceMatcher(None, b, h, autojunk=False).get_matching_blocks():
        for k in range(blk.size):
            if (t := targets.get(blk.b + k + 1)) is not None:
                out[blk.a + k + 1] = t
    return out


def entry_text(x):
    return next((n["text"] for n in x.get("nodes", []) if n["kind"] == "entry"), None)


# ---------------------------------------------------------------- what a function is for, calls and touches

WRAPPERS = {"decorated_definition", "export_statement", "lexical_declaration", "expression_statement",
            "var_declaration", "const_declaration", "variable_declarator", "variable_declaration", "assignment",
            "assignment_expression", "short_var_declaration", "var_spec", "const_spec", "pair", "field_definition",
            "public_field_definition", "property_declaration"}   # a function's doc comment sits above these
DIRECTIVE = re.compile(r"^(go:|nolint|eslint|prettier|type:|noqa|pylint|@ts-|!|-\*-|#?region|#?endregion|TODO|FIXME|"
                       r"[-=*~_#/]{3})")   # tool directives and section dividers
DOC_END = re.compile(r"^(@\w|:param|:return|(Args|Arguments|Returns|Raises|Parameters|Example)s?:)")
SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9`\"'(])")
WRITE_VERB = re.compile(r"^(exec|insert|update|delete|save|put|set|create|upsert|publish|produce|send|write|push|"
                        r"remove|mark|enqueue|post|patch)", re.I)
READ_VERB = re.compile(r"^(get|query|select|find|fetch|read|list|count|scan|load|exists|lookup|search)", re.I)
MAX_GUARD = 60
COMMON = {"add", "get", "set", "put", "append", "update", "remove", "pop", "push", "keys", "values", "items", "map",
          "filter", "find", "join", "split", "run", "start", "stop", "close", "open", "read", "write", "send", "call",
          "apply", "bind", "next", "emit", "on", "off", "has", "delete", "clear", "copy", "sort", "format", "parse",
          "load", "dump", "init", "reset", "render", "build", "create", "list", "count", "index", "match", "test",
          "replace", "search", "insert", "extend", "len", "range", "print", "max", "min", "sum", "all", "any", "main",
          "new", "New", "Get", "Set", "Run", "Start", "Stop", "String", "Error", "Add", "Do", "Send", "Init", "Load"}
JUMPS = RETURNS | THROWS | {"continue_statement", "break_statement", "continue", "break"}
COMPARE = re.compile(r"\s(not in|is not|in|is)\s|(!==|===|!=|==|<=|>=|<(?![-=<])|(?<![-=>])>(?!=))")
FLIP = {"not in": "in", "in": "not in", "is not": "is", "is": "is not", "!==": "===", "===": "!==", "!=": "==",
        "==": "!=", "<=": ">", ">": "<=", ">=": "<", "<": ">="}
ERRORISH = re.compile(r"(?i)\berr\w*|error|exception")


def summary(fn, name):
    """First sentences of fn's doc: its docstring, else the comment right above it. "fooBar does X" → "Does X"."""
    doc = docstring(fn)
    if doc is None:
        n = fn
        while n.parent is not None and n.parent.type in WRAPPERS:
            n = n.parent
        lines, prev, top = [], n.prev_sibling, n.start_point[0]
        while prev is not None and "comment" in prev.type and prev.end_point[0] >= top - 1 and not (
                prev.prev_sibling is not None and prev.prev_sibling.end_point[0] == prev.start_point[0]):  # trailing
            lines[:0] = text(prev).splitlines()
            top, prev = prev.start_point[0], prev.prev_sibling
        doc = "\n".join(lines)
    return sentences(doc, name)


def sentences(doc, name):
    """The first two sentences of a doc comment's first paragraph, without comment marks and directives."""
    para = []
    for line in doc.splitlines():
        line = re.sub(r"\s*\*+/\s*$", "", re.sub(r"^\s*(/\*+|\*+/|//[/!]?|#+|--|\*)\s?", "", line)).strip()
        if DOC_END.match(line) or not line and para:
            break
        if line and not DIRECTIVE.match(line):
            para.append(line)
    s = " ".join(SENTENCE.split(" ".join(para))[:2])
    first, _, rest = s.partition(" ")
    if first.lower() in (name.lower(), name.lower() + "()") and rest[:1].islower():
        s = rest[0].upper() + rest[1:]
    return (s if len(s) <= 240 else s[:239] + "…") or None


def docstring(fn):
    """A Python function's docstring, else None."""
    body = fn.child_by_field_name("body")
    first = body.named_children[0] if body is not None and body.named_children else None
    if first is not None and first.type == "expression_statement":
        first = first.named_children[0]
    if first is None or first.type != "string":
        return None
    return re.sub(r"^[rRuUbB]*(\"\"\"|'''|\"|')|(\"\"\"|'''|\"|')$", "", text(first))


def call_sites(fn):
    """[(callee name, receiver's last word, line, when, loop)] of the calls in fn, in source order. Calls in nested
    named functions are theirs; an unnamed closure (callback, goroutine) runs as part of fn."""
    out, todo = [], [fn]
    while todo:
        n = todo.pop()
        if n is not fn and n.type in FUNCS and not (n.type in CLOSURES and assigned_name(n) is None):
            continue
        if n.type in CALLS:
            name, recv = Walk.callee(n)
            if name and name not in PROTOCOL and not words(recv) & NOISE_WORDS:
                out.append((n.start_byte, name, (re.findall(r"\w+", recv) or [""])[-1], n.start_point[0] + 1,
                            *guard(n, fn)))
        todo += n.named_children
    return [s[1:] for s in sorted(out)]


def guard(n, fn):
    """(when, loop) of the call n inside fn: the branches it sits in and the guard clauses before it (`if x { return }`
    means "not: x"; error checks are left out), innermost first; and the innermost loop around it."""
    when, loop, child, p = [], None, n, n.parent
    while p is not None and p != fn:
        prev = child.prev_named_sibling
        while prev is not None:
            if prev.type in IFS and exits(prev) and not ERRORISH.search(
                    c := text(prev.child_by_field_name("condition"))):
                when.append(negate(unparen(c)))
            prev = prev.prev_named_sibling
        t = p.type
        if t in IFS or t in ELSE_IFS:
            cond = p.child_by_field_name("condition")
            alts = p.children_by_field_name("alternative")
            if cond is not None and child not in (cond, p.child_by_field_name("initializer")):
                when += [negate(unparen(text(e.child_by_field_name("condition")))) for e in reversed(alts)
                         if e.type in ELSE_IFS and e.start_byte < child.start_byte]   # Python: earlier elifs
                c = unparen(text(cond))
                when.append(negate(c) if (child in alts) != t.startswith("unless") else c)
        elif t in CASES and child not in (p.child_by_field_name("value"), p.child_by_field_name("pattern")):
            label = re.match(r"\s*(?:case\s+|when\s+)?(.*?)\s*(?::(?!=)|=>|->|\bthen\b|$)", text(p).split("\n")[0])[1]
            switch = p.parent if p.parent is not None and p.parent.type in SWITCHES else p.parent and p.parent.parent
            subject = switch and (switch.child_by_field_name("value") or switch.child_by_field_name("subject")
                                  or switch.child_by_field_name("condition"))
            when.append(f"{unparen(text(subject))}: {label}" if subject is not None else label or "default")
        elif t in CATCHES:
            when.append("on error")
        elif loop is None and t in LOOPS and child == (p.child_by_field_name("body") or p.named_children[-1]):
            loop = text(p)[:child.start_byte - p.start_byte]
        elif loop is None and t in CALLS and Walk.callee(p)[0] in ITERATORS and child.start_byte > p.start_byte:
            loop = text(p)[:child.start_byte - p.start_byte]   # xs.forEach(x => …)
        child, p = p, p.parent
    return when, short(loop).rstrip(" {:(") if loop else None


def exits(stmt):
    """True for an if without else whose branch ends in return, throw, continue or break: a guard clause."""
    if stmt.child_by_field_name("alternative") is not None or stmt.child_by_field_name("condition") is None:
        return False
    last = stmt.child_by_field_name("consequence")
    while last is not None and last.type not in JUMPS and last.named_children:
        last = last.named_children[-1]
    return last is not None and last.type in JUMPS


def negate(c):
    """c negated readably: without its leading ! / not, or with its one comparison flipped, else "not: c"."""
    if not re.search(r"&&|\|\||\band\b|\bor\b|\?", c):
        if m := re.fullmatch(r"(?:!|not\s+)\s*([\w.]+(?:\(.*\))?)", c):
            return m[1]
        ops = list(COMPARE.finditer(c))
        if len(ops) == 1:
            op = ops[0][1] or ops[0][2]
            return c[:ops[0].start(ops[0].lastindex)] + FLIP[op] + c[ops[0].end(ops[0].lastindex):]
    return "not: " + c


def short(s):
    s = " ".join(s.split())
    return s if len(s) <= MAX_GUARD else s[:MAX_GUARD - 1] + "…"


def code_effects(x):
    """The outside systems a function's x-ray calls, one entry per (kind, target, op)."""
    out = {}
    for n in x.get("nodes", []) if x.get("status") == "ready" else []:
        if n["kind"] == "effect":
            callee = n.get("callee") or ""
            op = "writes" if WRITE_VERB.match(callee) else "reads" if READ_VERB.match(callee) else "calls"
            kind, target = effect_kind(n), n.get("target") or callee_text(n)
            out.setdefault((kind, target, op), {"kind": kind, "target": target, "op": op, "line": n["line"]})
    return list(out.values())


# ---------------------------------------------------------------- control-flow changes

def flatten(x):
    """X-ray nodes in source order, each with "check" (a decision whose then-branch returns/throws an error)
    and "absorb" (ids of those error exits)."""
    if x.get("status") != "ready":
        return []
    nodes = {n["id"]: dict(n) for n in x["nodes"]}
    out = []

    def block(b):
        for item in (b or {}).get("seq", []):
            if isinstance(item, str):
                if nodes[item]["kind"] not in ("entry", "exit"):
                    out.append(nodes[item])
            elif "if" in item:
                d = nodes[item["if"]]
                exits = [i for i in item["then"]["seq"] if isinstance(i, str)
                         and nodes[i]["kind"] in ("return", "throw") and nodes[i].get("error")]
                d["check"], d["absorb"] = bool(exits), exits
                out.append(d)
                block(item["then"])
                block(item["else"])
            elif "loop" in item:
                out.append(nodes[item["loop"]])
                block(item["body"])
            elif "switch" in item:
                out.append(nodes[item["switch"]])
                for case in item["cases"]:
                    block(case["body"])
            elif "try" in item:
                for part in ("body", "catch", "finally"):
                    block(item[part])
    block(x["tree"])
    return out


def key(n):
    return n["kind"], " ".join(n["text"].split())


def node_changes(base, head, effects_only=False):
    """Changes between two flattened x-rays, aligned so that moved or unchanged steps don't show."""
    out, gone, new = [], [], []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, [key(n) for n in base], [key(n) for n in head],
                                                      autojunk=False).get_opcodes():
        if op == "equal":
            continue
        bs, hs, last = base[i1:i2], head[j1:j2], -1
        for b in bs:
            j = next((j for j in range(last + 1, len(hs)) if similar(b, hs[j])), None)
            if j is None:
                gone.append(b)
                continue
            new += hs[last + 1:j]
            last = j
            if (c := changed_node(b, hs[j])) is not None:
                out.append(c)
        new += hs[last + 1:]
    absorbed = {i for n in gone + new if n.get("check") for i in n["absorb"]}
    for n in gone:
        if (c := one_side(n, "removed", absorbed)) and (not effects_only or c["kind"] == "effect"):
            out.append(c)
    for n in new:
        if (c := one_side(n, "added", absorbed)) and (not effects_only or c["kind"] == "effect"):
            out.append(c)
    return out


def similar(b, h):
    if b["kind"] != h["kind"] or b.get("callee") != h.get("callee"):
        return False
    return masked(b["text"]) == masked(h["text"]) or inversion(b["text"], h["text"]) is not None \
        or difflib.SequenceMatcher(None, OP_TOKEN.findall(b["text"]), OP_TOKEN.findall(h["text"])).ratio() >= 0.6


def masked(s):
    return " ".join(LITERAL_TEXT.sub("#", s).split())


def inversion(a, b):
    """"!= → ==" style description when b is a inverted, else None."""
    ta, tb = OP_TOKEN.findall(a), OP_TOKEN.findall(b)
    if len(ta) == len(tb):
        diff = [(x, y) for x, y in zip(ta, tb) if x != y]
        if len(diff) == 1 and diff[0] in INVERSE:
            return f"{diff[0][0]} → {diff[0][1]}"
        return None
    longer, shorter, verb = (tb, ta, "added") if len(tb) > len(ta) else (ta, tb, "removed")
    if len(longer) - len(shorter) == 1:
        for i, t in enumerate(longer):
            if t in NEGATIONS and longer[:i] + longer[i + 1:] == shorter:
                return f"{verb} {t}"
    if len(longer) - len(shorter) == 3 and longer[:2] == ["!", "("] and longer[-1] == ")" \
            and longer[2:-1] == shorter:
        return f"{verb} !"
    return None


def change(kind, op, before, after, base_line, head_line, severity, why, target=None):
    return {"kind": kind, "op": op, "before": before, "after": after, "base_line": base_line, "head_line": head_line,
            "target": target, "severity": severity, "why": why}


def changed_node(b, h):
    """The change between two aligned steps of the same kind, or None when only literals moved (those are
    reported as literal changes)."""
    if b["text"] == h["text"] or masked(b["text"]) == masked(h["text"]):
        return None
    k, args = b["kind"], (b["text"], h["text"], b["line"], h["line"])
    if k == "decision":
        check, inv = b.get("check") or h.get("check"), inversion(b["text"], h["text"])
        if inv:
            return change("error_check" if check else "condition", "changed", *args, "high",
                          "Error check inverted" if check else f"Condition inverted: {inv}")
        if check:
            return change("error_check", "changed", *args, "high", "Error check condition changed")
        return change("condition", "changed", *args, "medium", "Condition changed")
    if k == "switch":
        return change("condition", "changed", *args, "medium", "Switch subject changed")
    if k == "loop":
        return change("loop", "changed", *args, "medium", "Loop changed")
    if k in ("return", "throw"):
        if b.get("error") and not h.get("error"):
            return change(k, "changed", *args, "high", f"Error {k} replaced")
        return change(k, "changed", *args, "low", f"{k.capitalize()} changed")
    if k == "effect":
        return change("effect", "changed", *args, "low", f"Arguments changed ({callee_text(h)})", h.get("target"))
    if k == "call":
        return change("call", "changed", *args, "low", f"Arguments changed ({h.get('callee')})")
    return None


def one_side(n, op, absorbed):
    """The change for a step only one side has."""
    added = op == "added"
    before, after = (None, n["text"]) if added else (n["text"], None)
    lines = (None, n["line"]) if added else (n["line"], None)
    k = n["kind"]
    if k == "decision":
        if n.get("check"):
            return change("error_check", op, before, after, *lines, "low" if added else "high",
                          "Error check added" if added else "Error check removed")
        return change("condition", op, before, after, *lines, "medium", "New condition" if added else "Condition removed")
    if k == "switch":
        return change("condition", op, before, after, *lines, "medium", "New switch" if added else "Switch removed")
    if k == "loop":
        return change("loop", op, before, after, *lines, "medium", "New loop" if added else "Loop removed")
    if k in ("return", "throw"):
        if n["id"] in absorbed:
            return None
        if n.get("error"):
            return change(k, op, before, after, *lines, "low" if added else "high",
                          f"Error {k} added" if added else f"Error {k} removed")
        return change(k, op, before, after, *lines, "low", f"{k.capitalize()} {op}")
    if k == "effect":
        kind = effect_kind(n)
        what = n.get("target") or kind
        severity = "high" if kind in WRITE_KINDS else "medium"
        why = f"New {what} call ({callee_text(n)})" if added else f"{what} call removed ({callee_text(n)})"
        return change("effect", op, before, after, *lines, severity, why[0].upper() + why[1:], n.get("target"))
    if k == "call":
        return change("call", op, before, after, *lines, "low", f"New call: {n['callee']}" if added
                      else f"Call removed: {n['callee']}")
    return None


def callee_text(n):
    return re.sub(r"^(defer|go|await)\s+", "", n["text"].split("(")[0].strip()) or n.get("callee") or "call"


def effect_kind(n):
    """db | queue | storage | payment | cloud | saas | network | outside, from the map target, else the callee."""
    s = (n.get("target") or callee_text(n)).lower()
    if PAYMENT.search(s):
        return "payment"
    if n.get("target"):
        kind = guess_kind(s)
        return "outside" if kind == "other" else kind
    w = words(s) | set(re.findall(r"\w+", s))
    for kind, names in EXTERNAL_KINDS.items():
        if w & set(names):
            return kind
    if w & QUEUE:
        return "queue"
    if w & DB:
        return "db"
    if w & NETWORK:
        return "network"
    return "outside"


# ---------------------------------------------------------------- literals

def literal_changes(b, h):
    """Number and string literals that changed between two versions of a function."""
    out = []
    bt, ht = b["tokens"], h["tokens"]
    sm = difflib.SequenceMatcher(None, [t for t, _ in bt], [t for t, _ in ht], autojunk=False)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op != "replace" or i2 - i1 != j2 - j1:
            continue
        for (before, bn), (after, hn) in zip(bt[i1:i2], ht[j1:j2]):
            if not (is_literal(bn) and is_literal(hn)):
                continue
            stmt, in_cond = statement(hn, h["node"])
            ws = words(stmt)
            name = next((LIMIT_WORDS[w] for w in sorted(ws) if w in LIMIT_WORDS), None)
            severity = "medium" if name or in_cond else "low"
            label = name or ("Condition value" if in_cond else "Value")
            out.append(change("literal", "changed", before, after, bn.start_point[0] + 1, hn.start_point[0] + 1,
                              severity, f"{label} changed: {clip(before)} → {clip(after)}"))
    return out


def is_literal(n):
    return bool(NUMBERISH.search(n.type) or STRINGISH.search(n.type))


def statement(n, fn):
    """(text of the statement holding n, whether n sits in a condition)."""
    while n.parent is not None and n.parent != fn:
        p = n.parent
        if p.child_by_field_name("condition") == n:
            return clip(n.text.decode("utf-8", "replace")), True
        if p.type in ("block", "statement_block", "compound_statement", "function_body", "body_statement",
                      "statements", "constructor_body", "do_block", "module", "source_file", "class_body",
                      "declaration_list"):
            break
        n = p
    return clip(n.text.decode("utf-8", "replace")), False


# ---------------------------------------------------------------- gates

def gate_items(rel, version):
    """[(gate id, kind, name, line, text)] for the env/flag reads and checks in one version of a file."""
    if version.src is None:
        return []
    out = []
    for g in find_gates(Path("."), [rel], lambda _: None, lambda *_: None, texts={rel: version.src}):
        for r in g["reads"]:
            out.append((g["id"], g["kind"], g["name"], int(r["ref"].rsplit(":", 1)[1]), "read"))
        for c in g["checks"]:
            out.append((g["id"], g["kind"], g["name"], int(c["ref"].rsplit(":", 1)[1]), c["text"]))
    return out


def gate_changes(rel, base, head, fns):
    """Per-file gate entries, and gate changes added to the changed functions."""
    by_side = {}
    for side, version in (("base", base), ("head", head)):
        spans = {(f[side]["start"], f[side]["end"]): f for f in fns if f[side]}
        items = []
        for gid, kind, name, line, txt in gate_items(rel, version):
            f = version.fn_at(line)
            owner_fn = spans.get((f["start"], f["end"])) if f else None
            items.append((gid, kind, name, line, txt, owner_fn))
        by_side[side] = items
    out = []
    for gid in sorted({i[0] for s in by_side.values() for i in s}):
        b = [i for i in by_side["base"] if i[0] == gid]
        h = [i for i in by_side["head"] if i[0] == gid]
        bc = {(i[5]["id"], i[4]) for i in b if i[5]}
        hc = {(i[5]["id"], i[4]) for i in h if i[5]}
        if bc == hc:
            continue
        kind, name = (b or h)[0][1:3]
        op = "added" if not b else "removed" if not h else "changed"
        side = b if op == "removed" else h
        out.append({"id": gid, "name": name, "kind": kind, "op": op,
                    "refs": sorted({f"{rel}:{i[3]}" for i in side if i[5]}, key=lambda r: int(r.rsplit(":", 1)[1]))})
        for f in fns:
            fb = [i for i in b if i[5] is f]
            fh = [i for i in h if i[5] is f]
            if fh and not fb:
                f["changes"].append(change("gate", "added", None, name, None, fh[0][3], "medium",
                                           f"New {kind} gate {name}"))
            elif fb and not fh:  # high when the gate is gone from the file, not just from this function
                f["changes"].append(change("gate", "removed", name, None, fb[0][3], None,
                                           "high" if op == "removed" else "medium",
                                           f"{kind.capitalize()} gate removed: {name}"))
    return out
