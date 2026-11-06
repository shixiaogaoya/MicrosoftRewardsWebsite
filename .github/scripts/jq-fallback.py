"""Minimal jq stand-in for the publish fixtures on hosts without jq.

GitHub's Linux runners ship jq, but a bare WSL or Git Bash often does not, and
the local gates run there. This implements exactly the expressions
publish-release.sh and publish-cws.sh use — it is not a generic jq. Anything
outside that set fails loudly (exit 3) instead of guessing: a silent mismatch
here would let a broken release script pass its fixtures.

Usage mirrors the calls those scripts make: jq [-e] [-r] 'EXPRESSION' [FILE],
reading stdin when no file is given.
"""

import json
import re
import sys


class Unsupported(Exception):
    """An expression the scripts do not use — refuse rather than guess."""


def dotted(value, path):
    """Follow a `.a.b.c` path; a non-dict anywhere on the way yields None."""
    for part in [p for p in path.split(".") if p]:
        value = value.get(part) if isinstance(value, dict) else None
    return value


def alternative(value, alt):
    """jq's `//`: a null or false left side falls to the right side."""
    return alt if value is None or value is False else value


def join_strings(values, sep):
    """jq's join: strings as-is, numbers coerced to text (jq 1.7 does too);
    anything else errors rather than guessing."""
    parts = []
    for value in values:
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, bool):
            raise Unsupported("join over a boolean element")
        elif isinstance(value, (int, float)):
            parts.append(str(value))
        else:
            raise Unsupported("join over a non-string element")
    return sep.join(parts)


def collect_versions(doc, list_path, item_path):
    """`[<list_path>[]? | <item_path> // empty]` — unique-sorted versions."""
    channels = dotted(doc, list_path)
    found = set()
    if isinstance(channels, list):
        for channel in channels:
            version = dotted(channel, item_path)
            if version is None or version is False:
                continue
            if not isinstance(version, str):
                raise Unsupported("collected a non-string version")
            found.add(version)
    return sorted(found)


def warning_line(entry):
    reason = alternative(dotted(entry, ".reason"), "")
    description = alternative(dotted(entry, ".description"), "")
    return "- " + reason + "：" + description


def expand_list(value):
    """jq's `X[]?`: iterate a list, nothing for null/absent/non-list."""
    return value if isinstance(value, list) else []


# Simple forms the scripts use, parameterized; the multi-line expressions are
# keyed below by their exact whitespace-normalized text. Every pattern and key
# matches the expression with ALL whitespace removed, so line breaks and
# spacing in the script do not matter.
PATH_RE = re.compile(r"^\.([A-Za-z0-9_.]*)$")
ALT_RE = re.compile(r"^(\.[A-Za-z0-9_.]*)//(\"\"|false|empty)$")
COLLECT_RE = re.compile(
    r"^\[(\.[A-Za-z0-9_.]+)\[\]\?\|(\.[A-Za-z0-9_.]+)//empty\]"
    r"\|unique\|(join\(\"、\"\)|\.\[\])$"
)

LITERALS = {
    "[(.error.status//empty),(.error.message//empty)]|map(select(.!=\"\"))|join(\"：\")":
        lambda doc: join_strings(
            [
                value
                for value in (
                    alternative(dotted(doc, ".error.status"), _MISSING),
                    alternative(dotted(doc, ".error.message"), _MISSING),
                )
                if value is not _MISSING and value != ""
            ],
            "：",
        ),
    "(.error.details//[])[]?|(.warnings//[])[]?|\"- \"+((.reason//\"\")+\"：\"+(.description//\"\"))":
        lambda doc: [
            warning_line(entry)
            for detail in expand_list(alternative(dotted(doc, ".error.details"), []))
            for entry in expand_list(alternative(dotted(detail, ".warnings"), []))
        ],
    "(.warningInfo.warnings//[])[]?|\"- \"+((.reason//\"\")+\"：\"+(.description//\"\"))":
        lambda doc: [
            warning_line(entry)
            for entry in expand_list(alternative(dotted(doc, ".warningInfo.warnings"), []))
        ],
}

_MISSING = object()


def evaluate(expr, doc):
    match = PATH_RE.match(expr)
    if match is not None:
        return doc if expr == "." else dotted(doc, expr)

    match = ALT_RE.match(expr)
    if match is not None:
        path, alt_text = match.group(1), match.group(2)
        value = dotted(doc, path)
        if alt_text == '""':
            return alternative(value, "")
        if alt_text == "false":
            return alternative(value, False)
        return _MISSING if value is None or value is False else value

    match = COLLECT_RE.match(expr)
    if match is not None:
        versions = collect_versions(doc, match.group(1), match.group(2))
        if match.group(3) == "join(\"、\")":
            return join_strings(versions, "、")
        return versions

    literal = LITERALS.get(expr)
    if literal is not None:
        return literal(doc)

    raise Unsupported(expr)


def normalize(expr):
    """Drop whitespace outside string literals; spacing inside them is data."""
    out = []
    in_string = False
    escaped = False
    for ch in expr:
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
        elif not ch.isspace():
            out.append(ch)
    return "".join(out)


def parse_args(argv):
    raw = False
    exit_status = False
    positional = []
    for arg in argv:
        flags = arg[1:]
        if arg.startswith("-") and flags and all(c in "er" for c in flags):
            raw = raw or "r" in flags
            exit_status = exit_status or "e" in flags
        else:
            positional.append(arg)
    return raw, exit_status, positional


def main():
    if sys.stdin.encoding and sys.stdin.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdin.reconfigure(encoding="utf-8")
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout.reconfigure(encoding="utf-8")

    raw, exit_status, positional = parse_args(sys.argv[1:])
    if not positional:
        print("jq-fallback: no expression given", file=sys.stderr)
        return 3
    source = open(positional[1], encoding="utf-8") if len(positional) > 1 else sys.stdin
    try:
        doc = json.load(source)
    except Exception:
        # jq exits 2 on input it cannot parse; the callers treat that as "not
        # JSON" and report it themselves.
        return 2

    expr = normalize(positional[0])
    try:
        result = evaluate(expr, doc)
    except Unsupported as unsupported:
        print(f"jq-fallback: unsupported expression: {unsupported}", file=sys.stderr)
        return 3

    if isinstance(result, list):
        # The `| .[]` forms print one line per element.
        for line in result:
            print(line)
        return 0
    if (result is None or result is False) and exit_status:
        if result is None:
            print("null")
        return 1
    if isinstance(result, str) and raw:
        print(result)
    elif result is None:
        print("null")
    elif result is _MISSING:
        # `// empty` produced nothing at all.
        return 0
    else:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
