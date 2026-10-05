"""Function x-ray: the control flow of one function as a small structured flowchart (see XRAY.md section 1).

Structure comes only from the tree-sitter syntax tree. Kept: decisions, loops, switches, try blocks, returns,
throws, calls to the repo's own functions and calls to outside systems. Everything else is dropped.
"""
import json
import re
from pathlib import Path

from tree_sitter_language_pack import get_parser

LANGS = {".go": "go", ".py": "python", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
         ".cjs": "javascript", ".ts": "typescript", ".tsx": "tsx", ".java": "java", ".kt": "kotlin", ".rs": "rust",
         ".cs": "csharp", ".rb": "ruby", ".php": "php", ".c": "c", ".h": "cpp", ".cc": "cpp", ".cpp": "cpp",
         ".hpp": "cpp"}

MAX_NODES = 400
MAX_TEXT = 120
MAX_LABEL = 80

# Node types across the supported grammars. Names that mean different things in two grammars are
# disambiguated where they are used (Rust's try_expression is the `?` operator).
BLOCKS = {"block", "statement_block", "compound_statement", "function_body", "body_statement", "statements",
          "constructor_body", "do_block"}
CLOSURES = {"func_literal", "lambda", "arrow_function", "function_expression", "function", "lambda_expression",
            "lambda_literal", "anonymous_function", "closure_expression", "anonymous_method_expression",
            "anonymous_function_creation_expression", "generator_function"}
FUNCS = CLOSURES | {"function_declaration", "method_declaration", "function_definition", "method_definition",
                    "generator_function_declaration", "constructor_declaration", "compact_constructor_declaration",
                    "secondary_constructor", "function_item", "local_function_statement", "method",
                    "singleton_method", "operator_declaration", "accessor_declaration"}
IFS = {"if_statement", "if_expression", "if", "unless", "if_modifier", "unless_modifier"}
ELSE_IFS = {"elif_clause", "else_if_clause", "elsif"}
LOOPS = {"for_statement", "for_in_statement", "enhanced_for_statement", "foreach_statement", "for_range_loop",
         "while_statement", "do_statement", "do_while_statement", "for_expression", "while_expression",
         "loop_expression", "while", "until", "for", "while_modifier", "until_modifier"}
DO_LOOPS = {"do_statement", "do_while_statement"}
SWITCHES = {"expression_switch_statement", "type_switch_statement", "select_statement", "switch_statement",
            "switch_expression", "match_statement", "match_expression", "when_expression", "case"}
SWITCH_BODIES = {"switch_body", "switch_block", "match_block", "compound_statement", "block"}
CASES = {"expression_case", "default_case", "type_case", "communication_case", "case_clause", "switch_case",
         "switch_default", "switch_block_statement_group", "switch_rule", "when_entry", "match_arm",
         "switch_section", "switch_expression_arm", "case_statement", "default_statement", "when"}
FALLTHROUGH = {"c", "cpp", "csharp", "java", "javascript", "typescript", "tsx", "php"}  # stacked `case a: case b:`
TRIES = {"try_statement", "try_expression", "try_with_resources_statement"}
CATCHES = {"except_clause", "except_group_clause", "catch_clause", "catch_block", "rescue"}
FINALLIES = {"finally_clause", "finally_block", "ensure"}
RETURNS = {"return_statement", "return_expression", "return"}
THROWS = {"throw_statement", "throw_expression", "raise_statement"}
CALLS = {"call_expression", "call", "method_invocation", "invocation_expression", "function_call_expression",
         "member_call_expression", "scoped_call_expression", "nullsafe_member_call_expression"}
NEWS = {"new_expression", "object_creation_expression"}  # kept only when the class is a known name
ASSIGNS = {"variable_declarator", "short_var_declaration", "assignment_expression", "assignment", "var_spec",
           "let_declaration", "property_declaration", "init_declarator", "public_field_definition",
           "field_definition", "pair", "const_spec", "expression_list", "variable_declaration"}
PANICS = {"panic", "raise", "fail"}                       # Go panic(), Ruby raise/fail
EXITS = {"exitProcess", "Exit", "exit", "Fatal", "Fatalf", "Fatalln", "abort"}  # end the process: os.Exit, log.Fatal
PANIC_MACROS = {"panic", "unreachable", "todo", "unimplemented", "bail"}
ITERATORS = {"forEach", "for_each", "ForEach", "forEachIndexed", "each", "each_with_index", "each_pair", "each_slice",
             "times", "fold", "repeat"}
SCOPES = {"use", "apply", "let", "run", "also", "with", "synchronized"}  # Kotlin: the lambda runs right here

# Outside-system calls (XRAY.md: receiver words like db/client/http/publish). PART words may sit inside a
# receiver name (cs.cartSvcClient, _db); WHOLE words must be the whole name (requests.get, conn.Exec), since
# inside a name they are too common (adRequestsCounter, threadPool).
EFFECT_PART = {"db", "database", "sql", "sqlx", "gorm", "client", "redis", "valkey", "memcache", "kafka", "producer",
               "publisher", "broker", "stub", "sqs", "sns", "s3", "bucket", "dynamo", "dynamodb",
               "mongo", "smtp", "mailer", "nats", "amqp", "rabbit", "pubsub", "elasticsearch", "opensearch"}
EFFECT_WHOLE = {"http", "https", "requests", "httpx", "aiohttp", "axios", "conn", "connection", "tx", "txn",
                "cursor", "pool", "socket", "consumer", "subscriber", "session"}
EFFECT_CALLEES = {"fetch", "urlopen", "publish", "Publish", "produce", "Produce", "send_message", "sendMessage",
                  "connect", "Connect", "ConnectAsync", "Dial", "DialContext"}
# Methods every type implements; matching them by name links unrelated code.
PROTOCOL = {"Error", "String", "GoString", "MarshalJSON", "UnmarshalJSON", "Close", "Len", "Less", "Swap",
            "ServeHTTP", "Read", "Write", "__init__", "__str__", "__repr__", "toString", "equals", "hashCode"}
# Calls that only adapt a result (`.await.map_err(…)`, `.then(…)`); never shown, and they don't hide the call
# they wrap.
ADAPTERS = {"map_err", "unwrap", "expect", "context", "with_context", "unwrap_or", "unwrap_or_else",
            "unwrap_or_default", "ok_or", "ok_or_else", "then", "catch", "finally", "ConfigureAwait", "GetAwaiter",
            "GetResult"}
CHAIN_LINKS = {"field_expression", "member_expression", "navigation_expression", "member_access_expression",
               "await_expression", "try_expression", "parenthesized_expression", "selector_expression", "attribute",
               "non_null_expression", "conditional_access_expression", "member_binding_expression"}
NOISE_WORDS = {"log", "logger", "logging", "slog", "console", "fmt", "span", "tracer", "trace", "metrics", "meter",
               "strings", "strconv", "json", "math"}


def xray(path: Path, line: int, rel: str, known_functions: set[str], effect_targets: dict[int, str]) -> dict:
    if Path(path).suffix.lower() not in LANGS:
        return xray_text(b"", line, str(path), known_functions, effect_targets)
    try:
        src = Path(path).read_bytes()
    except OSError as e:
        return {"status": "error", "error": f"cannot read {rel}: {e.strerror}"}
    return xray_text(src, line, rel, known_functions, effect_targets)


def xray_text(src: bytes | str, line: int, rel: str, known_functions: set[str], effect_targets: dict[int, str]) -> dict:
    """xray() on source text (e.g. a file at another git revision); the language comes from rel's extension."""
    lang = LANGS.get(Path(rel).suffix.lower())
    if lang is None:
        return {"status": "unsupported", "error": f"no x-ray for {Path(rel).suffix or 'extensionless'} files"}
    if isinstance(src, str):
        src = src.encode()
    rows = src.split(b"\n")
    if not 1 <= line <= len(rows):
        return {"status": "error", "error": f"line {line} is outside {rel} ({len(rows)} lines)"}
    tree = get_parser(lang).parse(src)
    fn = find_function(tree.root_node, line - 1, lang)
    if fn is None:
        return {"status": "error", "error": f"line {line} of {rel} is not inside a function"}
    return Walk(lang, fn, set(known_functions), effect_targets).run(rel)


def find_function(root, row, lang):
    """The innermost function holding the row; a row on a function's own signature means that function, and a
    one-line closure inside a bigger function (`xs.map(x => x * 2)`) is part of it. Ruby code outside any method
    (Sinatra routes, rake tasks) lives in blocks: the outermost `call do … end` counts."""
    found, block, todo = [], None, [root]
    while todo:  # every node spanning the row, outermost first
        n = todo.pop()
        definition = n.child_by_field_name("definition") if n.type == "decorated_definition" else None
        if definition is not None and definition.type in FUNCS and row < definition.start_point[0]:
            found.append(definition)  # a Python decorator line
            continue
        if n.type in FUNCS:
            found.append(n)
        elif lang == "ruby" and block is None and n.type == "call" and n.child_by_field_name("block") is not None:
            block = n
        todo += reversed([c for c in n.named_children if c.start_point[0] <= row <= c.end_point[0]])
    found = [f for f in found if f.start_point[0] < f.end_point[0] or f is found[0]]
    for fn in found:
        body = body_of(fn)
        if body is None or row < max(body.start_point[0], fn.start_point[0] + 1):
            return fn
    return found[-1] if found else block


def functions(root, lang):
    """Every function a reader would name, in source order: declared functions and methods at any depth,
    closures assigned to a name, and closures outside any function (route handlers). Like find_function,
    a Ruby block outside any method (Sinatra route) counts as a function."""
    out, todo = [], [(root, False)]
    while todo:
        n, inside = todo.pop()
        if n.type in FUNCS:
            if n.type not in CLOSURES or not inside or assigned_name(n) is not None:
                out.append(n)
            inside = True
        elif lang == "ruby" and not inside and n.type == "call" and n.child_by_field_name("block") is not None:
            out.append(n)
            inside = True
        todo += [(c, inside) for c in reversed(n.named_children)]
    return out


def body_of(fn):
    if fn.type == "call":  # a Ruby block (see find_function)
        fn = fn.child_by_field_name("block")
    body = fn.child_by_field_name("body")
    if body is None:
        body = next((c for c in fn.named_children if c.type in ("function_body", "statements", "block")), None)
    return body


def assigned_name(fn):
    """Name a closure is assigned to (`const f = () => …`, `f := func…`), else None."""
    node = fn
    for _ in range(3):
        parent = node.parent
        if parent is None or parent.type not in ASSIGNS:
            return None
        for field in ("name", "left", "pattern", "declarator", "key"):
            target = parent.child_by_field_name(field)
            if target is not None and target != node:
                return text(target)
        if parent.type == "property_declaration":  # Kotlin: val f = { … }
            decl = next((c for c in parent.named_children if c.type == "variable_declaration"), None)
            if decl is not None:
                return text(decl)
        node = parent
    return None


def function_name(fn):
    if fn.type == "call":  # a Ruby block: `post "/send_order_confirmation"`
        return clip(fn.text[:fn.child_by_field_name("block").start_byte - fn.start_byte].decode("utf-8", "replace"))
    name = fn.child_by_field_name("name")
    if name is not None:
        return text(name)
    declarator = fn.child_by_field_name("declarator")  # C/C++: walk to the function_declarator's name
    while declarator is not None and declarator.type != "function_declarator":
        declarator = declarator.child_by_field_name("declarator")
    if declarator is not None:
        return text(declarator.child_by_field_name("declarator")).split("::")[-1]
    if fn.type == "function_declaration":  # Kotlin has no name field
        ident = next((c for c in fn.named_children if c.type == "simple_identifier"), None)
        if ident is not None:
            return text(ident)
    if fn.type == "secondary_constructor":
        return "constructor"
    if (name := assigned_name(fn)) is not None:
        return name
    call = fn.parent
    while call is not None and call.type in ("argument", "arguments", "argument_list", "value_argument",
                                             "value_arguments", "call_suffix", "annotated_lambda"):
        call = call.parent
    if call is not None and call.type in CALLS and call.child_by_field_name("function") != fn:  # a handler
        prefix = call.text[:fn.start_byte - call.start_byte].decode("utf-8", "replace")
        return clip(prefix.rstrip(" ,(\n") + (", …)" if prefix.rstrip().endswith(",") else "(…)"))
    outer = fn.parent
    while outer is not None and outer.type not in FUNCS:
        outer = outer.parent
    return f"(closure in {function_name(outer)})" if outer is not None else "(closure)"


def text(node):
    return node.text.decode("utf-8", "replace")


def clip(s):
    s = " ".join(s.split())
    return s if len(s) <= MAX_TEXT else s[:MAX_TEXT - 1] + "…"


def unparen(s):
    s = s.strip()
    if s.startswith("(") and s.endswith(")"):
        depth = 0
        for i, ch in enumerate(s):
            depth += {"(": 1, ")": -1}.get(ch, 0)
            if depth == 0 and i < len(s) - 1:
                return s  # `(a) && (b)`: the outer parens are not one pair
        return s[1:-1].strip()
    return s


def words(s):
    """Lowercase words of identifiers: cs.cartSvcClient -> {cs, cart, svc, client}."""
    return {w.lower() for w in re.findall(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+", s)}


class Walk:
    def __init__(self, lang, fn, known, effect_targets):
        self.lang, self.fn, self.known = lang, fn, known
        self.nodes, self.full = [], False
        self.targets = self.ref_calls(effect_targets)

    def run(self, rel):
        fn, body = self.fn, body_of(self.fn)
        start, end = fn.start_point[0] + 1, fn.end_point[0] + 1
        sig_end = body.start_byte if body is not None else fn.start_byte + len(fn.text.split(b"\n")[0])
        sig_end = min([sig_end] + [c.start_byte for c in fn.children if c.type == "comment"])
        sig = fn.text[:sig_end - fn.start_byte]
        seq = [self.add("entry", fn, re.sub(r"\s*(\{|:|=>|=)$", "", clip(sig.decode("utf-8", "replace"))) or "function")]
        tail = self.tail(body)
        if tail is None:
            seq += self.block([body])["seq"]
        else:  # the tail expression is the return value
            seq += self.block([c for c in body.named_children if c != tail] if tail != body else [])["seq"]
            self.visit(tail, seq)
            self.emit(seq, self.add("return", tail, clip(text(tail)), **self.error(tail)))
        self.full = False
        seq.append(self.add("exit", fn, "…" if len(self.nodes) > MAX_NODES else "end", line=end))
        return {"status": "ready",
                "fn": {"name": function_name(fn), "file": rel, "start": start, "end": end, "lang": self.lang},
                "nodes": self.nodes, "tree": {"seq": seq}}

    def tail(self, body):
        """The expression a function returns without `return`: an expression body (x => x + 1, fun f() = g(),
        C# `=> expr`) or Rust's trailing block expression."""
        if body is None:
            return None
        if body.type == "arrow_expression_clause" or body.type == "function_body" and body.text.startswith(b"="):
            last = body.named_children[0] if body.named_children else None
        elif body.type not in BLOCKS:
            last = body
        elif self.lang == "rust":
            last = next((c for c in reversed(body.named_children) if c.type != "line_comment"), None)
            if last is not None and not (last.type.endswith("_expression") or last.type == "identifier"):
                return None
        else:
            return None
        if last is None or last.type in IFS | SWITCHES | LOOPS | {"block", "macro_invocation"}:
            return None
        return last

    # ---- nodes ----

    def add(self, kind, node, txt, line=None, **extra):
        """New node id, or None once the budget is spent (the walk then stops and the exit node reads "…")."""
        if self.full:
            return None
        nid = f"n{len(self.nodes)}"
        self.nodes.append({"id": nid, "kind": kind, "line": line or node.start_point[0] + 1, "text": txt, **extra})
        self.full = len(self.nodes) > MAX_NODES
        return nid

    def emit(self, out, nid):
        if nid is not None:
            out.append(nid)

    def wrap(self, out, nid, item, build):
        """Append a structured item; build() walks its blocks after the head node got its id."""
        if nid is not None:
            out.append({item: nid, **build()})

    def block(self, nodes):
        out = []
        for n in nodes:
            if n is not None:
                self.visit(n, out)
        return {"seq": out}

    # ---- walk ----

    def visit(self, n, out, calls_only=False):
        if self.full:
            return
        t = n.type
        if t in FUNCS:
            # A nested closure passed along (callback, defer, goroutine) contributes its calls; named or
            # assigned functions run only when called, so they are skipped.
            if t in CLOSURES and assigned_name(n) is None:
                for c in n.named_children:
                    self.visit(c, out, True)
            return
        if t == "comment":
            return
        if not calls_only:
            if t in IFS:
                return self.if_item(n, out, ())
            if t in LOOPS:
                return self.loop_item(n, out)
            if t in SWITCHES:
                return self.switch_item(n, out)
            if (t in TRIES and self.lang != "rust") or self.lang == "ruby" and t in ("begin", "body_statement") \
                    and any(c.type in CATCHES | FINALLIES for c in n.named_children):
                return self.try_item(n, out)
            if t in RETURNS or t == "jump_expression" and n.text.startswith(b"return"):
                for c in n.named_children:
                    self.visit(c, out)
                return self.emit(out, self.add("return", n, clip(text(n)).rstrip(";"), **self.error(n)))
            if t in THROWS or t == "jump_expression" and n.text.startswith(b"throw"):
                for c in n.named_children:
                    self.visit(c, out)
                return self.emit(out, self.add("throw", n, clip(text(n)).rstrip(";"), error=True))
            if t == "macro_invocation" and text(n.child_by_field_name("macro")).split("::")[-1] in PANIC_MACROS:
                return self.emit(out, self.add("throw", n, clip(text(n)), error=True))
        if t in CALLS or t in NEWS:
            callee, receiver = self.callee(n)
            if not calls_only and (closure := self.wrapped_closure(n, callee)) is not None:
                if callee in SCOPES:
                    self.visit_callee(n, closure, out)
                    out += self.block([body_of(closure) or closure])["seq"]
                    return
                return self.iterator_loop(n, closure, out)
            for c in n.named_children:
                self.visit(c, out, calls_only)
            if not calls_only and t in CALLS and (callee in PANICS and not receiver or callee in EXITS):
                return self.emit(out, self.add("throw", n, clip(text(n)), error=not text(n).endswith("(0)")))
            return self.call(n, out)
        for c in n.named_children:
            self.visit(c, out, calls_only)

    def if_item(self, n, out, extra_alts):
        cond, init = n.child_by_field_name("condition"), n.child_by_field_name("initializer")
        for c in (init, cond):
            if c is not None:
                self.visit(c, out)
        txt = unparen(text(cond)) if cond is not None else ""
        if init is not None:
            txt = f"{text(init)}; {txt}"
        if n.type.startswith("unless"):
            txt = f"unless {txt}"
        node = self.add("decision", n, clip(txt))
        self.wrap(out, node, "if", lambda: {"then": self.block([n.child_by_field_name("consequence")
                                                               or n.child_by_field_name("body")]),
                                            "else": self.else_block(n, extra_alts)})

    def else_block(self, n, extra_alts):
        alts = [*n.children_by_field_name("alternative"), *extra_alts]
        if not alts:
            return None
        if alts[0].type in ELSE_IFS:  # elif/elseif/elsif: a nested if, carrying the remaining alternatives
            inner = []
            self.if_item(alts[0], inner, alts[1:])
            return {"seq": inner}
        return self.block(alts)

    def loop_item(self, n, out):
        body = n.child_by_field_name("body") or next(
            (c for c in reversed(n.named_children) if c.type in ("control_structure_body", "block", "do")), None)
        for c in n.named_children:
            if c != body:
                self.visit(c, out)
        if body is None:
            header = text(n)
        else:
            src = n.text
            before = src[:body.start_byte - n.start_byte].decode("utf-8", "replace")
            after = src[body.end_byte - n.start_byte:].decode("utf-8", "replace") if n.type in DO_LOOPS else ""
            header = f"{before} … {after}" if after.strip() else before
        self.wrap(out, self.add("loop", n, clip(header).rstrip(" {:")), "loop", lambda: {"body": self.block([body])})

    def wrapped_closure(self, call, callee):
        """The closure of an iterator call (xs.forEach(x => …), xs.each do |x|) or a Kotlin scope call (use { … })."""
        if callee in ITERATORS or callee in SCOPES and self.lang == "kotlin":
            return self.closure_arg(call)
        return None

    def visit_callee(self, call, closure, out):
        callee = call.child_by_field_name("function") or call.child_by_field_name("receiver") or call.named_children[0]
        if callee is not None and callee != closure:
            self.visit(callee, out)

    def iterator_loop(self, call, closure, out):
        self.visit_callee(call, closure, out)
        header = call.text[:closure.start_byte - call.start_byte].decode("utf-8", "replace")
        body = body_of(closure) or closure
        self.wrap(out, self.add("loop", call, clip(header).rstrip(" ({")), "loop", lambda: {"body": self.block([body])})

    def closure_arg(self, call):
        """The closure handed to an iterator call (forEach(x => …), each do |x| … end, forEach { … })."""
        todo = [(c, 0) for c in call.named_children]
        while todo:
            node, depth = todo.pop(0)
            if node.type in CLOSURES or node.type in ("do_block", "block") and self.lang == "ruby":
                return node
            if depth < 3 and node.type not in CALLS:
                todo += [(c, depth + 1) for c in node.named_children]
        return None

    def switch_item(self, n, out):
        cases, first = [], None
        for c in n.named_children:
            if c.type in CASES or c.type == "else" and n.type == "case":
                cases.append(c)
            elif c.type in SWITCH_BODIES and any(g.type in CASES for g in c.named_children):
                cases += [g for g in c.named_children if g.type in CASES]
            else:
                self.visit(c, out)
        if cases:
            first = cases[0]
        header = n.text[:first.start_byte - n.start_byte] if first is not None else n.text.split(b"\n")[0]
        node = self.add("switch", n, clip(header.decode("utf-8", "replace")).rstrip(" {:"))

        def build():
            result, pending = [], []
            for case in cases:
                label, body = self.case_parts(case)
                if not body and self.lang in FALLTHROUGH and case is not cases[-1]:
                    pending.append(label)
                    continue
                result.append({"label": clip(", ".join(pending + [label])), "body": self.block(body)})
                pending = []
            return {"cases": result}
        self.wrap(out, node, "switch", build)

    def case_parts(self, case):
        """(label, body nodes): what comes before the case's `:`/`->`/`=>` is its label, the rest its body."""
        children = case.children
        sep = next((i for i, c in enumerate(children) if not c.is_named and c.type in (":", "->", "=>")), None)
        if sep is not None:
            label = [c for c in children[:sep] if c.is_named and c.type != "comment"]
            body = [c for c in children[sep + 1:] if c.is_named]
            label += [c for c in body if c.type == "switch_label"]  # Java: `case 1: case 2:` in one group
            body = [c for c in body if c.type != "switch_label"]
        else:
            fields = {"pattern", "value", "label"}
            label = [c for i, c in enumerate(children) if case.field_name_for_child(i) in fields]
            body = [c for c in case.named_children if c not in label]
        label_text = ", ".join(re.sub(r"^(case|when)\s+", "", text(c)) for c in label)
        if not label_text:
            label_text = text(children[0]) if children else "default"
        body = [c for c in body if c.type not in ("break_statement", "comment")]
        return label_text.rstrip(":").strip(), body

    def try_item(self, n, out):
        body = [c for c in n.named_children if c.type not in CATCHES | FINALLIES]
        catches = [c for c in n.named_children if c.type in CATCHES]
        finals = [c for c in n.named_children if c.type in FINALLIES]
        first = n.text.split(b"\n")[0].decode("utf-8", "replace").split("{")[0]
        node = self.add("try", n, clip(first).rstrip(" :") if n.type != "body_statement" else "begin")

        def build():
            return {"body": self.block(body),
                    "catch": self.block(catches) if catches else None,
                    "finally": self.block(finals) if finals else None}
        self.wrap(out, node, "try", build)

    # ---- calls ----

    @staticmethod
    def callee(n):
        """(callee name, receiver text) of a call or constructor."""
        name = n.child_by_field_name("name") or n.child_by_field_name("method")
        if name is not None and n.type not in NEWS:
            recv = n.child_by_field_name("object") or n.child_by_field_name("receiver") \
                   or n.child_by_field_name("scope")
            return text(name), text(recv) if recv is not None else ""
        fn = (n.child_by_field_name("function") or n.child_by_field_name("constructor")
              or n.child_by_field_name("type") or (n.named_children[0] if n.named_children else None))
        if fn is None or fn.type in CLOSURES:  # (func(){ … })(): only the calls inside count
            return "", ""
        s = re.sub(r"(<[^<>]*>|\[[^\[\]]*\])\s*$", "", text(fn))  # drop trailing generic arguments
        idents = list(re.finditer(r"[A-Za-z_$][\w$]*", s))
        if not idents:
            return "", ""
        last = idents[-1]
        return last.group(), s[:last.start()].rstrip(".:->?!& \n\t")

    def classify(self, n):
        """("effect" | "call", callee, target) for a call worth showing, else None."""
        t = n.type
        callee, receiver = self.callee(n)
        target = self.targets.get(n.id)
        if target is not None:
            return "effect", callee, target
        if callee in ADAPTERS or self.wrapped_closure(n, callee) is not None:
            return None
        names = re.findall(r"[A-Za-z_]\w*", re.sub(r"\"[^\"]*\"|'[^']*'", "", receiver))
        recv_words = words(" ".join(names))
        outside = recv_words & EFFECT_PART or any(w.strip("_").lower() in EFFECT_WHOLE for w in names)
        if t in CALLS and (outside and not callee.startswith(("New", "new")) or callee in EFFECT_CALLEES):
            return "effect", callee, None
        if callee in self.known and callee not in PROTOCOL and not recv_words & NOISE_WORDS \
                and not self.in_log_call(n):
            return "call", callee, None
        return None

    def in_log_call(self, n):
        """True when n only feeds a logging call: logger->Info(eventName(…))."""
        p = n.parent
        while p is not None and p.type not in FUNCS and not p.type.endswith(("_statement", "_declaration")) \
                and p.type not in ("block", "do_block", "statements", "body_statement", "statement_block"):
            if p.type in CALLS and words(self.callee(p)[1]) & NOISE_WORDS:
                return True
            p = p.parent
        return False

    def chain_parent(self, n):
        """The call that n is a link of (n.b() in n.b().c()), else None."""
        p = n.parent
        while p is not None and p.type in CHAIN_LINKS:
            p = p.parent
        if p is None or p.type not in CALLS:
            return None
        args = p.child_by_field_name("arguments") or next(
            (c for c in p.named_children if c.type in ("argument_list", "arguments", "value_arguments", "call_suffix")),
            None)
        return p if args is None or n.end_byte <= args.start_byte else None

    def call(self, n, out):
        found = self.classify(n)
        if found is None:
            return
        outer = self.chain_parent(n)
        if outer is not None and self.classify(outer) is not None:  # the chain is shown by its outer link
            return
        kind, callee, target = found
        shown = n.parent if n.parent is not None and n.parent.type in ("defer_statement", "go_statement") else n
        extra = {"callee": callee}
        if target is not None:
            extra["target"] = target
        self.emit(out, self.add(kind, n, clip(text(shown)).rstrip(";"), **extra))

    def ref_calls(self, effect_targets):
        """Call node id -> target for each verified `uses` ref line in this function. Of the calls on that line,
        the outermost one starting there wins; if none starts there, the innermost one spanning it."""
        fn = self.fn
        lines = {ln: tg for ln, tg in effect_targets.items() if fn.start_point[0] < ln <= fn.end_point[0] + 1}
        if not lines:
            return {}
        calls, todo = [], [fn]
        while todo:
            node = todo.pop()
            if node.type in CALLS:
                calls.append(node)
            todo += node.named_children
        out = {}
        for ln, target in lines.items():
            row = ln - 1
            starting = [c for c in calls if c.start_point[0] == row]
            spanning = [c for c in calls if c.start_point[0] <= row <= c.end_point[0]]
            if starting:
                pick = min(starting, key=lambda c: (c.start_byte, -c.end_byte))
            elif spanning:
                pick = min(spanning, key=lambda c: c.end_byte - c.start_byte)
            else:
                continue
            out[pick.id] = target
        return out

    def error(self, n):
        """error: true when a return hands back an error."""
        if self.lang == "go":
            values = n.named_children[0].named_children if n.named_children else []
            if n.named_children and n.named_children[0].type != "expression_list":
                values = n.named_children
            last = text(values[-1]) if values else "nil"
            return {"error": True} if last != "nil" and re.search(r"(?i)err", last) else {}
        s = text(n)
        if re.search(r"\bErr\(|\b(?:err|error|Error|exception|Exception)\b|Errorf|Exception\(|Error\(|status\(\s*[45]\d\d", s):
            return {"error": True}
        return {}


def explain_prompt(result: dict, source: str) -> str:
    """Prompt asking an agent for plain-English labels of the x-ray's steps. source is the function's code
    (or the whole file)."""
    fn = result["fn"]
    lines = source.splitlines()
    if len(lines) > fn["end"] - fn["start"] + 1:  # handed the whole file
        lines = lines[fn["start"] - 1:fn["end"]]
    numbered = "\n".join(f"{fn['start'] + i:>5}  {ln}" for i, ln in enumerate(lines))
    steps = "\n".join(f"{n['id']} | {n['kind']}{' (' + n['target'] + ')' if 'target' in n else ''} | line {n['line']}"
                      f" | {n['text']}" for n in result["nodes"] if n["kind"] not in ("entry", "exit"))
    return f"""You label the steps of a flowchart of one function, in plain English, for someone new to the code.

Function `{fn['name']}` in {fn['file']} ({fn['lang']}, lines {fn['start']}-{fn['end']}):

{numbered}

Steps (id | kind | line | code):
{steps}

For every step give a short label of at most {MAX_LABEL} characters saying what it means, not how it is written:
- decision: a yes/no question whose YES means the condition as written is TRUE (the flowchart's yes
  branch is the condition being true). `err != nil` is "Did generating the order ID fail?", never
  "Did it succeed?"; `len(items) == 0` is "Is the cart empty?"
- loop: "For each …" or "While …"
- switch: what is being chosen between
- call / effect: what it does, and with which outside system for effects
- return / throw: what comes back or what failed
Answer with ONLY a JSON object mapping step id to label, e.g. {{"n1": "Did generating the order ID fail?"}}.
No markdown, no explanation."""


def parse_labels(text: str, result: dict) -> dict:
    """The {node_id: label} object from an agent's answer, keeping only known ids and short labels."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object in reply")
    raw = json.loads(text[start:end + 1])
    ids = {n["id"] for n in result.get("nodes", [])}
    labels = {}
    for nid, label in raw.items() if isinstance(raw, dict) else ():
        if nid in ids and isinstance(label, str) and (label := " ".join(label.split())):
            labels[nid] = label if len(label) <= MAX_LABEL else label[:MAX_LABEL - 1] + "…"
    return labels
