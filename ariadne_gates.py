"""Gates and state machines below function level (XRAY.md sections 2 and 3).

Gates are env reads and feature-flag reads, plus the decisions that check them (directly, or
one hop through the variable or field the value was assigned to). States are fields named
*state/status/phase/stage* that are assigned constants in several places (test files skipped).
Structure comes from tree-sitter syntax trees; a regex only pre-filters files for speed.
Precision over recall: when unsure, report nothing.
"""

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from tree_sitter_language_pack import get_parser

LANGS = {".go": "go", ".py": "python", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
         ".jsx": "javascript", ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
         ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".rs": "rust", ".cs": "csharp", ".rb": "ruby",
         ".php": "php", ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp"}

# --- syntax node kinds, across the supported grammars ---
CALLS = {"call_expression", "call", "method_invocation", "invocation_expression", "function_call_expression",
         "member_call_expression", "scoped_call_expression"}
ARG_LISTS = {"argument_list", "arguments", "value_arguments", "call_suffix"}
ARG_WRAPPERS = {"argument", "value_argument"}
MEMBERS = {"selector_expression", "attribute", "member_expression", "field_access", "navigation_expression",
           "field_expression", "member_access_expression", "scoped_identifier", "qualified_identifier",
           "scope_resolution", "class_constant_access_expression", "directly_assignable_expression"}
IDENTS = {"identifier", "simple_identifier", "variable_name", "constant", "field_identifier"}
STRINGS = {"interpreted_string_literal", "raw_string_literal", "string", "string_literal", "encapsed_string",
           "verbatim_string_literal", "template_string", "raw_string"}
LITERALS = STRINGS | {"integer", "float", "number", "int_literal", "float_literal", "integer_literal", "real_literal",
                      "decimal_integer_literal", "decimal_floating_point_literal", "number_literal", "true", "false",
                      "none", "null", "nil", "null_literal", "boolean_literal", "boolean"}
FUNCTIONS = {"function_declaration", "method_declaration", "func_literal", "function_definition", "function_item",
             "method", "singleton_method", "arrow_function", "function_expression", "function",
             "generator_function_declaration", "method_definition", "constructor_declaration",
             "local_function_statement", "lambda_expression", "lambda_literal", "anonymous_function",
             "closure_expression", "lambda", "secondary_constructor", "anonymous_function_creation_expression"}
# decision node -> keyword shown before its condition (None = ternary, shown as "cond ?")
DECISIONS = {"if_statement": "if", "if_expression": "if", "if": "if", "elif_clause": "elif", "elsif": "elsif",
             "unless": "unless", "if_modifier": "if", "unless_modifier": "unless", "expression_switch_statement":
             "switch", "switch_statement": "switch", "switch_expression": "switch", "match_expression": "match",
             "match_statement": "match", "when_expression": "when", "case": "case", "ternary_expression": None,
             "conditional_expression": None, "conditional": None}
BODIES = {"switch_body", "switch_block", "match_block", "compound_statement", "block"}
SWITCHES = {"expression_switch_statement", "switch_statement", "switch_expression", "match_expression",
            "match_statement", "when_expression", "case"}
ASSIGNS = {"short_var_declaration", "assignment_statement", "var_spec", "assignment", "assignment_expression",
           "variable_declarator", "let_declaration", "property_declaration", "init_declarator", "keyed_element"}

# --- what counts as an env read or a flag read ---
ENV_CALL = re.compile(r"(os\.Getenv|os\.LookupEnv|syscall\.Getenv|os\.getenv|(os\.)?environ\.get|(std::)?getenv|"
                      r"secure_getenv|System\.getenv|(std::)?env::var(_os)?|(System\.)?Environment\."
                      r"GetEnvironmentVariable|ENV\.fetch|Deno\.env\.get)")
ENV_OBJECT = re.compile(r"os\.environ|environ|process\.env|import\.meta\.env|ENV|\$_ENV")
FLAG_SDK = re.compile(r"(?i:(get|fetch|use)_?(boolean|bool|string|integer|int|number|float|double|long|object|"
                      r"struct|json)_?(flag_?)?(value|details)(_?async)?)")
FLAG_GENERIC = re.compile(r"(?i:is_?on|is_?off|get_?feature_?value|eval_?feature|is_?enabled|get_?value(_?async)?|"
                          r"((bool|string|int|float64|float|number|json)_?)?variation(_?detail)?)")
FLAG_RECEIVER = re.compile(r"(?i)flag|feature|unleash|configcat|growthbook|launchdarkly|\bld|\bgb\b|toggle|"
                           r"openfeature|\bff")
GO_FLAG = re.compile(r"(Boolean|String|Int|Float|Object)(Value)?(Details)?")
FLAG_NAME = re.compile(r"[A-Za-z][\w.:/-]{0,79}")
ENV_NAME = re.compile(r"[A-Za-z_][\w.-]{0,79}")
PREFILTER = re.compile(r"getenv|Getenv|LookupEnv|environ|process\.env|meta\.env|GetEnvironmentVariable|ENV\[|"
                       r"ENV\.fetch|env::var|\$_ENV|Deno\.env|\.(Boolean|String|Int|Float|Object)(Value)?(Details)?\(\s*ctx|"
                       rf"\b({FLAG_SDK.pattern}|{FLAG_GENERIC.pattern}|(?i:\w*(flag|feature)\w*))\s*\(")
# wrappers the value passes through and stays "the env value" (int(...), .lower(), Optional.ofNullable, ...)
CONVERT = re.compile(r"(?i)int|float|bool|str|string|number|parseint|parsefloat|parsebool|atoi|parse(int|bool|float|"
                     r"duration)|ofnullable|toint|toboolean|tolong|trimspace|trim|strip|lower|upper|tolower|"
                     r"toupper|tolowercase|touppercase|to_i|to_s|to_string|to_sym|unwrap|unwrap_or|unwrap_or_else|"
                     r"orelse|expect|ok|value_or|getorelse|getordefault")
DEFAULT_METHOD = re.compile(r"orElse|unwrap_or|unwrap_or_else|value_or|getOrElse|getOrDefault")
DEFAULT_ARG = re.compile(r"\(\s*(\|_\|\s*)?(\"[^\"]*\"|'[^']*'|-?\d[\d.]*|true|false)"
                         r"(\.to_string\(\)|\.into\(\)|\.to_owned\(\))?\s*\)")
PASS_OPS = {"||", "??", "?:", "or", "==", "!=", "===", "!==", "in"}
DEFAULT_OPS = {"||", "??", "?:", "or"}
CONST_DEF = re.compile(r"(?m)\b([A-Za-z_]\w*)\s*(?::\s*[\w.]+\s*)?(?::=|=)\s*[\"']([^\"'\\\n]+)[\"']\s*[;,]?\s*$")

STATE_WORD = re.compile(r"(?i)state|status|phase|stage")
STATE_FIELD = re.compile(r"(?i)(state|status|phase|stage)$")
TEST_FILE = re.compile(r"(^|/)(tests?|__tests__|spec)/|_test\.(go|py)$|(^|/)test_[^/]*\.py$|\.(test|spec)\.[jt]sx?$|"
                       r"Tests?\.(java|kt|cs)$|_spec\.rb$")
STATE_PREFILTER = re.compile(r"(?i:state|status|phase|stage)\w*\s*(:=|=(?!=)|:)\s*"  # an assignment of a constant
                             r"([\"'`:]|[\w.:>-]*([A-Z][A-Z0-9_]{2,}|(?i:state|status|phase|stage)))")
PREVIOUS = re.compile(r"(?i)(prev|previous|old|from)")
QUERY = re.compile(r"(?i)(get|list|find|count|select|query|search|filter|fetch|load|read)")
UPPER = re.compile(r"[A-Z][A-Z0-9_]+")
PROTO_ENUM = re.compile(r"[A-Z]\w*[a-z]\w*?_([A-Z][A-Z0-9_]+)")  # Go protobuf: JobState_JOB_STATE_LOST


class Src:
    """One parsed source file."""

    def __init__(self, repo, rel, text=None):
        self.rel, self.lang, self.text = rel, LANGS.get(Path(rel).suffix.lower()), text
        if text is None:
            try:
                self.text = (repo / rel).read_bytes()
            except OSError:
                self.text = b""
        self._root = None

    @property
    def root(self):
        if self._root is None:
            self._root = _parser(self.lang).parse(self.text).root_node
        return self._root

    def t(self, node):
        return self.text[node.start_byte:node.end_byte].decode("utf-8", "replace")

    def nodes(self, root=None):
        stack = [root or self.root]
        while stack:
            n = stack.pop()
            yield n
            stack.extend(reversed(n.children))

    def decisions(self):
        """[(decision node, condition node, check text)] in this file."""
        if not hasattr(self, "_decisions"):
            self._decisions = []
            for n in self.nodes():
                if n.type in DECISIONS and (cond := _condition(n)) is not None:
                    text = " ".join(self.t(_unparen(cond)).split())
                    kw = DECISIONS[n.type]
                    self._decisions.append((n, cond, (f"{kw} {text}" if kw else f"{text} ?")[:120]))
        return self._decisions


_parsers = {}


def _parser(lang):
    if lang not in _parsers:
        _parsers[lang] = get_parser(lang)
    return _parsers[lang]


def _condition(n):
    if n.type == "conditional_expression" and n.child_by_field_name("condition") is None:
        named = n.named_children  # python: body if condition else alternative
        return named[1] if len(named) == 3 else None
    if n.type == "when_expression":
        return next((c for c in n.named_children if c.type == "when_subject"), None)
    for f in ("condition", "value", "subject"):
        if (c := n.child_by_field_name(f)) is not None:
            return c
    return None


def _unparen(n):
    while n.type in ("parenthesized_expression", "condition_clause", "when_subject") and n.named_child_count == 1:
        n = n.named_children[0]
    if n.type == "condition_clause" and (v := n.child_by_field_name("value")) is not None:
        return v
    return n


def _inside(n, outer):
    return outer is not None and outer.start_byte <= n.start_byte and n.end_byte <= outer.end_byte


def _ancestors(n):
    while (n := n.parent) is not None:
        yield n


def _function_of(n):
    return next((a for a in _ancestors(n) if a.type in FUNCTIONS), None)


def _line(n):
    return n.start_point[0] + 1


def _last(text):
    return re.split(r"\.|->|::", text)[-1].strip().lstrip("@$")


def _string(src, n):
    """Value of a plain string literal (no interpolation), else None."""
    if n.type not in STRINGS or any("interpolation" in c.type or "substitution" in c.type for c in n.children):
        return None
    m = re.fullmatch(r"[A-Za-z@]*(\"\"\"|'''|\"|'|`)(.*)\1", src.t(n), re.S)
    return m[2] if m else None


def _call_parts(src, call):
    """(callee text, [argument nodes]) of a call node."""
    args = call.child_by_field_name("arguments")
    if args is None:
        args = next((c for c in call.children if c.type in ARG_LISTS), None)
    if args is None:
        return None, []
    if args.type == "call_suffix":  # kotlin
        args = next((c for c in args.named_children if c.type == "value_arguments"), args)
    callee = "".join(src.text[call.start_byte:args.start_byte].decode("utf-8", "replace").split())
    out = []
    for a in args.named_children:
        if a.type in ARG_WRAPPERS and a.named_child_count:
            a = a.named_children[-1]
        elif a.type == "pair" and (v := a.child_by_field_name("value")) is not None:  # ruby flag_key: "x"
            a = v
        if a.type != "comment":
            out.append(a)
    return callee, out


def _name_arg(src, arg, consts):
    """A literal string argument, or an identifier bound to a unique string constant in the file."""
    if arg is None:
        return None
    if (s := _string(src, arg)) is not None:
        return s
    return consts.get(src.t(arg)) if arg.type in IDENTS else None


def _consts(src):
    found = [(m[1], m[2]) for m in CONST_DEF.finditer(src.text.decode("utf-8", "replace"))]
    count = Counter(k for k, _ in found)
    return {k: v for k, v in found if count[k] == 1}


def _literal(src, n):
    """Source text of a literal; strings re-quoted with double quotes so equal defaults compare equal."""
    if n is None or n.type not in LITERALS:
        return None
    if n.type in STRINGS:
        s = _string(src, n)
        return None if s is None else json.dumps(s)
    return src.t(n)


# ---------------------------------------------------------------- gates

def _reads(src, consts):
    """Env and flag reads in a file: [(kind, name, node, default, binding)]; binding is set for destructuring."""
    out = []
    for n in src.nodes():
        t = n.type
        if t in CALLS:
            callee, args = _call_parts(src, n)
            if not callee:
                continue
            last = _last(callee)
            if ENV_CALL.fullmatch(callee):
                name = _name_arg(src, args[0] if args else None, consts)
                if name and ENV_NAME.fullmatch(name):
                    d = _literal(src, args[1]) if len(args) > 1 and re.search(r"getenv|environ|ENV", callee) else None
                    out.append(("env", name, n, d, None))
            elif src.lang == "go" and GO_FLAG.fullmatch(last) and len(args) >= 3 and _string(src, args[0]) is None:
                name = _name_arg(src, args[1], consts)
                if name and FLAG_NAME.fullmatch(name) and re.search(r"(?i)ctx|context", src.t(args[0])):
                    out.append(("flag", name, n, _literal(src, args[2]), None))
            elif _is_flag_call(callee, last):
                name = _name_arg(src, args[0] if args else None, consts)
                if name and FLAG_NAME.fullmatch(name):
                    d = _literal(src, args[1]) if len(args) > 1 and FLAG_SDK.fullmatch(last) else None
                    out.append(("flag", name, n, d, None))
        elif t in ("subscript", "subscript_expression", "element_reference") and n.named_child_count == 2:
            obj, key = n.named_children
            if ENV_OBJECT.fullmatch(src.t(obj)) and (name := _string(src, key)) and ENV_NAME.fullmatch(name):
                out.append(("env", name, n, None, None))
        elif t == "member_expression":
            obj, prop = n.child_by_field_name("object"), n.child_by_field_name("property")
            if obj is not None and prop is not None and src.t(obj) in ("process.env", "import.meta.env") \
                    and not _is_assign_target(n):
                out.append(("env", src.t(prop), n, None, None))
        elif t == "variable_declarator" and src.lang in ("javascript", "typescript", "tsx"):
            out += _destructured(src, n)
    return out


def _is_flag_call(callee, last):
    if FLAG_SDK.fullmatch(last):
        return True
    if FLAG_GENERIC.fullmatch(last):
        return bool(FLAG_RECEIVER.search(callee[:-len(last)]))
    key = last.lower().replace("_", "")  # app wrappers: check_feature_flag, getFeatureFlagValue, isFeatureEnabled
    if "flag" in key:
        return bool(re.search(r"get|check|is|value|enabled|eval|variant", key)) and key != "getflags"
    return "feature" in key and bool(re.search(r"enabled|active|featureon|value", key))


def _is_assign_target(n):
    p = n.parent
    return p is not None and p.type in ASSIGNS and p.child_by_field_name("left") == n


def _destructured(src, decl):
    """const { A = "d", B, C: c } = process.env"""
    pattern, value = decl.child_by_field_name("name"), decl.child_by_field_name("value")
    if pattern is None or value is None or pattern.type != "object_pattern" \
            or src.t(value) not in ("process.env", "import.meta.env"):
        return []
    out = []
    for p in pattern.named_children:
        if p.type == "shorthand_property_identifier_pattern":
            out.append(("env", src.t(p), p, None, ("var", src.t(p), p)))
        elif p.type == "object_assignment_pattern":
            left, right = p.child_by_field_name("left"), p.child_by_field_name("right")
            if left is not None and left.type == "shorthand_property_identifier_pattern":
                out.append(("env", src.t(left), p, _literal(src, right), ("var", src.t(left), p)))
        elif p.type == "pair_pattern":
            key, val = p.child_by_field_name("key"), p.child_by_field_name("value")
            if key is not None and val is not None and val.type == "identifier":
                out.append(("env", src.t(key).strip("'\""), p, None, ("var", src.t(val), p)))
    return out


def _climb(src, read):
    """Follow the read value up through wrappers to the variable or field it is stored in.
    Returns (binding or None, default or None); binding = ("var" | "field", name, assignment node)."""
    n, default = read, None
    while (p := n.parent) is not None:
        t = p.type
        if t in ("parenthesized_expression", "await_expression", "await", "non_null_expression",
                 "expression_list", "literal_element", "value_argument", "argument"):
            if t == "expression_list" and p.parent is not None and p.parent.type not in ASSIGNS:
                return None, default
            n = p
            continue
        if p.child_count == 3 and p.children[0] == n and src.t(p.children[1]) in PASS_OPS:
            if src.t(p.children[1]) in DEFAULT_OPS:
                default = default or _literal(src, p.children[2])
            n = p
            continue
        if t in ARG_LISTS:
            call = p.parent.parent if t == "value_arguments" and p.parent is not None else p.parent
            if call is None or call.type not in CALLS or p.named_child_count != 1:
                return None, default
            callee, _ = _call_parts(src, call)
            if not callee or not CONVERT.fullmatch(_last(callee)):
                return None, default
            n = call
            continue
        if t in MEMBERS | CALLS | {"navigation_suffix"}:
            # method chain on the value: value.lower(), env::var(..).unwrap_or(..), ENV.fetch(..).to_i
            call = p if t in CALLS else p.parent
            if call is None or call.type not in CALLS or call.children[0] not in (n, p):
                return None, default
            callee, args = _call_parts(src, call)
            if callee is None and t == "call":  # ruby `x.to_i` without parens
                method = p.child_by_field_name("method")
                name = src.t(method) if method is not None else ""
            else:
                name = _last(callee or "")
            if not CONVERT.fullmatch(name):
                return None, default
            if DEFAULT_METHOD.fullmatch(name):
                tail = src.text[call.start_byte:call.end_byte].decode("utf-8", "replace")
                m = DEFAULT_ARG.search(tail[len(src.t(n)):])
                default = default or (m[2] if m and m.start() == tail[len(src.t(n)):].find("(") else None)
            n = call
            continue
        if t in ASSIGNS:
            return _target(src, p, n), default
        return None, default
    return None, default


def _target(src, assign, value):
    """The variable or field `value` is stored into by `assign`."""
    t = assign.type
    if t == "keyed_element":
        key, val = assign.named_children[0], assign.named_children[-1]
        return ("field", src.t(key), assign) if _inside(value, val) and not _inside(value, key) else None
    left = (assign.child_by_field_name("left") or assign.child_by_field_name("name")
            or assign.child_by_field_name("pattern") or assign.child_by_field_name("declarator"))
    if t == "property_declaration":
        left = next((c for c in assign.named_children if c.type == "variable_declaration"), None)
        left = left.named_children[0] if left is not None and left.named_child_count else None
    elif t == "assignment" and left is None and assign.named_child_count == 2:  # kotlin
        left = assign.named_children[0]
    if left is None or _inside(value, left):
        return None
    if left.type == "expression_list":
        right = assign.child_by_field_name("right") or assign.child_by_field_name("value")
        if right is None or right.named_child_count != 1:
            return None
        left = left.named_children[0]
    while left.type in ("pointer_declarator", "reference_declarator") and left.named_child_count:
        left = left.named_children[-1]
    if left.type in IDENTS:
        return ("var", src.t(left), assign)
    if left.type == "instance_variable" or left.type in MEMBERS or (left.type == "call" and src.lang == "ruby"):
        name = _last(src.t(left))
        return ("field", name, assign) if re.fullmatch(r"\w+", name) else None
    return None


def _reassigned(src, scope, name, assign):
    """Start of the next non-literal assignment to `name` in scope after `assign` (end of file if none)."""
    for n in src.nodes(scope):
        if n.type in ASSIGNS and n.start_byte > assign.start_byte:
            left = (n.child_by_field_name("left") or n.child_by_field_name("name")
                    or n.child_by_field_name("pattern") or n.child_by_field_name("declarator"))
            right = n.child_by_field_name("right") or n.child_by_field_name("value")
            if right is not None and right.type == "expression_list" and right.named_child_count == 1:
                right = right.named_children[0]
            if left is not None and name in (src.t(c) for c in [left, *left.named_children]) \
                    and _literal(src, right) is None:  # `x = "fallback"` keeps the env meaning
                return n.start_byte
    return len(src.text)


def _tested(src, n, cond):
    """False when the reference at n only feeds a call inside the condition (match connect(port) is no check)."""
    for a in _ancestors(n):
        if a == cond:
            return True
        if a.type == "token_tree":  # rust macro arguments
            return False
        if a.type in ARG_LISTS:
            call = a.parent if a.parent is not None and a.parent.type in CALLS else None
            if call is None or not CONVERT.fullmatch(_last(_call_parts(src, call)[0] or "")):
                return False
    return True


def _refs_var(src, cond, name):
    for n in src.nodes(cond):
        if n.type in IDENTS | {"shorthand_property_identifier"} and src.t(n) == name:
            p = n.parent
            if (p is None or p.type not in MEMBERS or p.named_children[0] == n) and _tested(src, n, cond):
                return True
    return False


def _refs_field(src, cond, fields):
    found = set()
    for n in src.nodes(cond):
        if n.type == "instance_variable" or (n.type in MEMBERS and n.named_child_count >= 2) \
                or (n.type == "call" and src.lang == "ruby" and n.child_by_field_name("arguments") is None
                    and n.child_by_field_name("receiver") is not None):
            name = _last(src.t(n))
            if name in fields and _tested(src, n, cond):
                found.add(name)
    return found


def gates(repo, files, part_of, fn_at, texts=None):
    """XRAY.md gates (without "lines") for repo-relative source files. texts: {file: bytes} to use instead of
    the files on disk (another git revision)."""
    repo, texts = Path(repo), texts or {}
    srcs = {f: Src(repo, f, texts.get(f)) for f in files if LANGS.get(Path(f).suffix.lower())}
    found = {}  # gate id -> {"kind", "name", "reads": {ref: node info}, "checks": {ref: text}, "defaults": []}
    fields = defaultdict(lambda: defaultdict(set))  # part -> field -> gate ids
    fn_cache = {}

    def fn(rel, line):
        if (rel, line) not in fn_cache:
            fn_cache[rel, line] = fn_at(rel, line)
        return fn_cache[rel, line]

    def gate(kind, name):
        return found.setdefault(f"{kind}:{name}", {"kind": kind, "name": name, "reads": {}, "checks": {},
                                                   "defaults": []})

    def check(g, src, decision, text):
        g["checks"].setdefault(f"{src.rel}:{_line(decision)}", (src.rel, _line(decision), text))

    for src in srcs.values():
        if not PREFILTER.search(src.text.decode("utf-8", "replace")):
            continue
        reads = _reads(src, _consts(src))
        for kind, name, node, default, binding in reads:
            g = gate(kind, name)
            g["reads"].setdefault(f"{src.rel}:{_line(node)}", (src.rel, _line(node)))
            for d, cond, text in src.decisions():
                if _inside(node, cond):
                    check(g, src, d, text)
            if binding is None:
                binding, climbed = _climb(src, node)
                default = default or climbed
            if default is None and kind == "env" and binding and binding[0] == "var":
                default = _fallback_default(src, binding)
            if default is not None:
                g["defaults"].append(default)
            if binding is None:
                continue
            what, bound, assign = binding
            if what == "field":
                fields[part_of(src.rel) or src.rel][bound].add(f"{kind}:{name}")
                continue
            scope = _function_of(assign) or src.root
            until = _reassigned(src, scope, bound, assign)
            for d, cond, text in src.decisions():
                if _inside(d, scope) and assign.end_byte <= cond.start_byte < until and _refs_var(src, cond, bound):
                    check(g, src, d, text)

    for src in srcs.values():
        part_fields = fields.get(part_of(src.rel) or src.rel)
        if not part_fields:
            continue
        words = re.compile(r"\b(" + "|".join(map(re.escape, part_fields)) + r")\b")
        if not words.search(src.text.decode("utf-8", "replace")):
            continue
        for d, cond, text in src.decisions():
            for field in _refs_field(src, cond, part_fields):
                for gid in part_fields[field]:
                    check(found[gid], src, d, text)

    out = []
    for gid, g in sorted(found.items()):
        out.append({
            "id": gid, "kind": g["kind"], "name": g["name"],
            "reads": [{"ref": ref, "fn": fn(rel, line), "part": part_of(rel)}
                      for ref, (rel, line) in sorted(g["reads"].items())],
            "checks": [{"ref": ref, "fn": fn(rel, line), "part": part_of(rel), "text": text}
                       for ref, (rel, line, text) in sorted(g["checks"].items())],
            "default": g["defaults"][0] if len(set(g["defaults"])) == 1 else None,  # only when all reads agree
        })
    return out


def _fallback_default(src, binding):
    """x := os.Getenv("X"); if x == "" { x = "d" }   (or v, ok := os.LookupEnv("X"); if !ok { v = "d" })"""
    _, var, assign = binding
    left = assign.child_by_field_name("left")
    names = [src.t(c) for c in left.named_children] if left is not None and left.type == "expression_list" else []
    empty = {f'{var} == ""', f"{var} == nil", f"!{var}", f"not {var}", f"{var} is None", f"{var} == null",
             f"{var} === undefined", f"{var} == NULL", f"{var} == nullptr", f"{var}.nil?", f"{var}.empty?"}
    if len(names) == 2:
        empty.add(f"!{names[1]}")
    scope = _function_of(assign) or src.root
    for d, cond, _ in src.decisions():
        body = d.child_by_field_name("consequence") or d.child_by_field_name("body")
        if body is None or not _inside(d, scope) or d.start_byte < assign.end_byte \
                or " ".join(src.t(_unparen(cond)).split()) not in empty:
            continue
        for n in src.nodes(body):
            target, right = n.child_by_field_name("left"), n.child_by_field_name("right")
            if n.type in ASSIGNS and target is not None and right is not None and src.t(target) == var:
                if right.type == "expression_list" and right.named_child_count == 1:
                    right = right.named_children[0]
                return _literal(src, right)
        return None
    return None


# ---------------------------------------------------------------- states

def _state_value(src, n, field):
    """Normalised constant name if `n` is a constant (enum member, const, string literal), else None."""
    if (s := _string(src, n)) is not None:
        return s if s.strip() and len(s) <= 60 else None
    if n.type == "simple_symbol":
        return src.t(n)[1:]
    if n.type not in IDENTS | MEMBERS:
        return None
    text = src.t(n)
    if not re.fullmatch(r"[A-Za-z_][\w]*((\.|::|->)[A-Za-z_]\w*)*", text):
        return None
    last = _last(text)
    if last in ("True", "False", "None", "TRUE", "FALSE", "NULL"):
        return None
    if not UPPER.fullmatch(last):
        if not (last[:1].isupper() and STATE_WORD.search(text) and last != field
                and not STATE_WORD.search(last[-6:])):  # PreviousState, job.State: a variable, not a constant
            return None
    m = PROTO_ENUM.fullmatch(last)
    return m[1] if m else last


def _assignments(src):
    """State assignments in a file: [(field, receiver, family, value, node)]."""
    out = []
    for n in src.nodes():
        if n.type not in ASSIGNS:
            continue
        right = (n.child_by_field_name("right") or n.child_by_field_name("value")
                 or (n.named_children[-1] if n.named_child_count else None))
        if right is None:
            continue
        if right.type in ("expression_list", "literal_element") and right.named_child_count == 1:
            right = right.named_children[0]
        target = _target(src, n, right)
        if target is None or target[0] != "field" or not STATE_FIELD.search(target[1]):
            continue  # fields only: local variables named state are mostly scratch values
        field = target[1]
        if n.type == "keyed_element" and any(a.type == "keyed_element" and PREVIOUS.match(src.t(a.named_children[0]))
                                             for a in _ancestors(n)):
            continue  # PreviousState: X{JobState: ...} is the from side, read by _from_literal
        if n.type == "keyed_element" and _is_query(src, n) or _function_of(n) is None:
            continue  # lookup filters and static tables are not transitions
        value = _state_value(src, right, field)
        if value is None:
            continue
        left = n.child_by_field_name("left")
        if left is not None and left.type == "expression_list" and left.named_child_count == 1:
            left = left.named_children[0]
        receiver = None
        if left is not None and left.type in MEMBERS | {"call"}:
            parts = re.split(r"\.|->|::", src.t(left))
            receiver = re.search(r"\w+", parts[-2]) if len(parts) >= 2 else None  # profiles[i].Status -> profiles
            receiver = receiver and receiver[0]
        out.append((field, receiver, _family(src, right), value, n))
    return out


def _family(src, n):
    """Which constant set a value comes from: db.JobStateRequested -> "db.JobState", a string literal -> its
    node type. Keeps unrelated Status fields of one part apart."""
    if n.type in STRINGS or n.type == "simple_symbol":
        return n.type
    text = src.t(n)
    last = _last(text)
    m = re.match(r"(?i).*?(state|status|phase|stage)", last)
    return text[:len(text) - len(last)] + (m[0] if m else "")


def _is_query(src, keyed):
    """GetJobsByStateParams{JobState: X} filters a lookup; it does not set a state."""
    lit = keyed.parent.parent if keyed.parent is not None else None
    kind = lit.child_by_field_name("type") if lit is not None and lit.type == "composite_literal" else None
    call = next((a for a in _ancestors(keyed) if a.type in CALLS), None)
    names = [_last(src.t(kind)) if kind is not None else "", _last(_call_parts(src, call)[0] or "") if call else ""]
    return any(QUERY.match(x) for x in names)


def _from(src, assign, field):
    """`from` state: an enclosing if/switch comparing the same field to a constant, else a sibling Previous* literal."""
    fn = _function_of(assign)
    chain = [assign]
    for a in _ancestors(assign):
        if a == fn:
            break
        if a.type in ("if_statement", "if_expression", "if", "elif_clause", "elsif"):
            body = a.child_by_field_name("consequence") or a.child_by_field_name("body")
            cond = _condition(a)
            if cond is not None and _inside(assign, body) and not re.search(r"\|\||\bor\b", src.t(cond)):
                hits = [v for c in src.nodes(cond) if (v := _compared(src, c, field))]
                if len(hits) == 1:
                    return hits[0]
        elif a.type in SWITCHES:
            subject = _condition(a)
            if subject is not None and _last(src.t(_unparen(subject))) == field:
                case = chain[-2] if chain[-1].type in BODIES and len(chain) > 1 else chain[-1]
                return _case_label(src, case, field)
        chain.append(a)
    return _from_literal(src, assign, field)


def _compared(src, n, field):
    if n.child_count != 3 or src.t(n.children[1]) not in ("==", "===", "is", "eq"):
        return None
    a, b = n.children[0], n.children[2]
    for x, y in ((a, b), (b, a)):
        if _last(src.t(x)) == field and (v := _state_value(src, y, field)):
            return v
    return None


def _case_label(src, case, field):
    """The single constant label of a case clause."""
    label = (case.child_by_field_name("value") or case.child_by_field_name("pattern")
             or next((c for c in case.named_children if c.type in ("switch_label", "constant_pattern",
                                                                   "when_condition", "pattern")), None))
    if label is None:
        return None
    while label.named_child_count == 1 and _state_value(src, label, field) is None:
        label = label.named_children[0]
    return _state_value(src, label, field)


def _from_literal(src, assign, field):
    """Go: X{PreviousState: S{JobState: A}, NewState: S{JobState: B}} -> from A."""
    if assign.type != "keyed_element":
        return None
    for lit in _ancestors(assign):
        if lit.type != "literal_value":
            continue
        for kv in lit.named_children:
            if kv.type == "keyed_element" and PREVIOUS.match(src.t(kv.named_children[0])):
                for n in src.nodes(kv):
                    if n.type == "keyed_element" and src.t(n.named_children[0]) == field:
                        right = n.named_children[-1]
                        if right.type == "literal_element" and right.named_child_count == 1:
                            right = right.named_children[0]
                        if v := _state_value(src, right, field):
                            return v
                return None
    return None


def states(repo, files, fn_at):
    """XRAY.md state machines across the given repo-relative files (test files are skipped)."""
    repo = Path(repo)
    groups = defaultdict(list)  # (field, constant family) -> rows
    for f in files:
        if not LANGS.get(Path(f).suffix.lower()) or TEST_FILE.search(f):
            continue
        src = Src(repo, f)
        if not STATE_PREFILTER.search(src.text.decode("utf-8", "replace")):
            continue
        for field, receiver, family, value, node in _assignments(src):
            before = _from(src, node, field)
            groups[field, family].append((src.rel, _line(node), receiver, before if before != value else None, value))
    machines = []
    for (field, _), rows in sorted(groups.items()):
        rows = sorted(set(rows), key=lambda r: (r[0], r[1]))
        seen = set()  # one transition per (file, function, from, to)
        rows = [r for r in rows if not ((k := (r[0], fn_at(r[0], r[1]), r[3], r[4])) in seen or seen.add(k))]
        names = list(dict.fromkeys(s for r in rows for s in (r[3], r[4]) if s))
        if len(rows) < 2 or len(names) < 3:
            continue
        receivers = Counter(r[2] for r in rows if r[2] and len(r[2]) > 1 and r[2] not in ("self", "this", "cls"))
        subject = receivers.most_common(1)[0][0] if receivers else None
        machines.append({
            "id": f"{subject}.{field}" if subject else field, "subject": subject, "field": field,
            "states": names,
            "transitions": [{"from": fr, "to": to, "ref": f"{rel}:{line}", "fn": fn_at(rel, line)}
                            for rel, line, _, fr, to in rows],
            "heuristic": True,
        })
    ids = Counter(m["id"] for m in machines)
    for m in machines:  # two constant sets on one field name: keep ids unique
        if ids[m["id"]] > 1:
            m["id"] += f"#{m['states'][-1]}"
    return machines
