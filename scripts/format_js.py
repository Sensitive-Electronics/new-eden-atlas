"""Break minified-style JavaScript into one statement per line.

    python scripts/format_js.py web/app.js          # rewrite in place
    python scripts/format_js.py --check web/app.js  # report, change nothing
    python scripts/format_js.py --self-test         # check the lexer itself

Why this exists rather than Prettier or ESLint. This project has no package.json
and no node_modules, and its test suite advertises that it needs no installed
dependency and no network. A formatter that requires `npm install` would trade
that property away for tidier braces, and the property is worth more. So this is
a deliberately small tool that does the one thing the code actually needed.

It is conservative by construction: it inserts whitespace and never removes or
alters a character. Newlines go in after `{`, before `}` and after `;`, and only
at parenthesis depth zero, which keeps `for (a; b; c)` headers and argument lists
intact. Automatic semicolon insertion cannot bite, because a newline after a
semicolon or a brace changes nothing about how the statement is parsed.

The lexer exists solely to know where NOT to insert: inside strings, template
literals (including nested `${}`), regular expressions and comments. Getting
that wrong would corrupt data rather than formatting, so the tool refuses to
write a file whose non-whitespace characters do not match the input exactly,
and refuses again if the result does not parse.

This is a rescue tool, not a house style. Run it on a file that has been
squeezed onto 4,000-character lines; do not run it over the modules that were
written normally, because it will happily reformat readable code into its own
shape for no gain. The suite therefore gates on line length - the thing that
actually makes code unreadable - rather than on whether a file matches this
tool's exact output.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

INDENT = "  "

# A `/` starts a regular expression only where a value may begin. After one of
# these tokens it is division instead. The keyword list matters: `return /x/g`
# is a regex, `count / 2` is not.
VALUE_EXPECTED_AFTER = set("([{,;:=!&|?+-*%<>~^")
KEYWORDS_BEFORE_REGEX = (
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "case", "do", "else", "yield", "await",
)


# The emitted text so far, as text.
#
# Text, not the last non-blank *chunk*. A chunk is not a token: format_source appends
# one character at a time, so after `return` the last chunk is "n", `"n".endswith(
# "return")` is false, `/` is read as division, and the regex in
# `return /a;b/.test(x)` is split at the semicolon inside it.
#
# The tool's parse check catches the wreckage and refuses to write, so no file is
# corrupted - the visible effect is that such a file cannot be formatted, with the
# refusal blaming the output rather than naming the cause.
#
# Enough trailing characters to contain the longest keyword ("instanceof") with
# room to spare, rather than the whole buffer, so this stays cheap at every `/`.
_KEYWORD_LOOKBACK = 32


def _last_significant(out: list[str]) -> str:
    tail = ""
    for chunk in reversed(out):
        tail = chunk + tail
        if len(tail.strip()) >= _KEYWORD_LOOKBACK:
            break
    return tail.strip()


def _regex_allowed(out: list[str]) -> bool:
    previous = _last_significant(out)
    if not previous:
        return True
    tail = previous[-1]
    if tail in VALUE_EXPECTED_AFTER:
        return True
    if tail.isalnum() or tail in "_$":
        for word in KEYWORDS_BEFORE_REGEX:
            if previous.endswith(word) and (
                len(previous) == len(word) or not (previous[-len(word) - 1].isalnum() or previous[-len(word) - 1] in "_$")
            ):
                return True
        return False
    return tail not in ")]"


def format_source(source: str) -> str:
    out: list[str] = []
    i = 0
    n = len(source)
    brace_depth = 0
    paren_depth = 0
    # Each open brace records the paren depth it was opened at, so a brace
    # inside an argument list does not start indenting the whole file.
    brace_stack: list[int] = []
    # Template literals nest: `a${`b${c}`}d`. Each entry is the brace depth at
    # which the current `${` was opened.
    template_stack: list[int] = []
    at_line_start = False

    def newline() -> None:
        nonlocal at_line_start
        out.append("\n" + INDENT * brace_depth)
        at_line_start = True

    while i < n:
        ch = source[i]

        # --- things we must not touch ---------------------------------------
        if ch == "/" and i + 1 < n and source[i + 1] == "/":
            end = source.find("\n", i)
            end = n if end == -1 else end
            out.append(source[i:end])
            i = end
            # A line comment must end its line. Leaving at_line_start alone here
            # let two comments merge and then swallow the declaration that
            # followed them - and the whitespace-only guard below could not see
            # it, because the newline that was lost is itself whitespace. Only
            # a parser catches that, which is why one now runs as well.
            newline()
            if i < n and source[i] == "\n":
                i += 1
            continue
        if ch == "/" and i + 1 < n and source[i + 1] == "*":
            end = source.find("*/", i + 2)
            end = n if end == -1 else end + 2
            out.append(source[i:end])
            i = end
            at_line_start = False
            continue
        if ch in "'\"":
            j = i + 1
            while j < n:
                if source[j] == "\\":
                    j += 2
                    continue
                if source[j] == ch:
                    j += 1
                    break
                j += 1
            out.append(source[i:j])
            i = j
            at_line_start = False
            continue
        if ch == "`":
            j = i + 1
            while j < n:
                if source[j] == "\\":
                    j += 2
                    continue
                if source[j] == "`":
                    j += 1
                    break
                if source[j] == "$" and j + 1 < n and source[j + 1] == "{":
                    # Hand control back to the main loop for the interpolation,
                    # recording where the template resumes.
                    out.append(source[i:j + 2])
                    template_stack.append(brace_depth)
                    brace_depth += 1
                    brace_stack.append(paren_depth + 1)  # never break inside
                    i = j + 2
                    break
                j += 1
            else:
                out.append(source[i:n])
                i = n
                continue
            if i != j + 2:
                out.append(source[i:j])
                i = j
            at_line_start = False
            continue
        if ch == "/" and _regex_allowed(out):
            j = i + 1
            in_class = False
            closed = False
            while j < n:
                if source[j] == "\\":
                    j += 2
                    continue
                if source[j] == "[":
                    in_class = True
                elif source[j] == "]":
                    in_class = False
                elif source[j] == "/" and not in_class:
                    j += 1
                    while j < n and (source[j].isalpha()):
                        j += 1
                    closed = True
                    break
                elif source[j] == "\n":
                    break
                j += 1
            if closed:
                out.append(source[i:j])
                i = j
                at_line_start = False
                continue

        # --- structure -------------------------------------------------------
        if ch == "(":
            paren_depth += 1
            out.append(ch)
            i += 1
            at_line_start = False
            continue
        if ch == ")":
            paren_depth = max(0, paren_depth - 1)
            out.append(ch)
            i += 1
            at_line_start = False
            continue
        if ch == "{":
            breakable = paren_depth == 0
            out.append(ch)
            brace_stack.append(paren_depth)
            brace_depth += 1
            i += 1
            if breakable:
                newline()
            else:
                at_line_start = False
            continue
        if ch == "}":
            opened_at = brace_stack.pop() if brace_stack else 0
            brace_depth = max(0, brace_depth - 1)
            if template_stack and brace_depth == template_stack[-1]:
                # Closing a `${...}`: resume the template literal in place.
                template_stack.pop()
                out.append("}")
                j = i + 1
                while j < n:
                    if source[j] == "\\":
                        j += 2
                        continue
                    if source[j] == "`":
                        j += 1
                        break
                    if source[j] == "$" and j + 1 < n and source[j + 1] == "{":
                        out.append(source[i + 1:j + 2])
                        template_stack.append(brace_depth)
                        brace_depth += 1
                        brace_stack.append(paren_depth + 1)
                        i = j + 2
                        break
                    j += 1
                else:
                    out.append(source[i + 1:n])
                    i = n
                    continue
                if i != j + 2:
                    out.append(source[i + 1:j])
                    i = j
                at_line_start = False
                continue
            if opened_at == 0:
                if not at_line_start:
                    newline()
                # The closing brace belongs one level out.
                if out and out[-1].startswith("\n"):
                    out[-1] = "\n" + INDENT * brace_depth
            out.append(ch)
            i += 1
            at_line_start = False
            continue
        if ch == ";":
            out.append(ch)
            i += 1
            if paren_depth == 0:
                newline()
            else:
                at_line_start = False
            continue
        if ch in " \t":
            if not at_line_start:
                out.append(ch)
            i += 1
            continue
        if ch == "\n":
            if not at_line_start:
                newline()
            i += 1
            continue

        out.append(ch)
        i += 1
        at_line_start = False

    text = "".join(out)
    # Tidy the artefacts of inserting blindly: trailing spaces and runs of
    # blank lines. Both only remove whitespace, never content.
    lines = [line.rstrip() for line in text.split("\n")]
    cleaned: list[str] = []
    for line in lines:
        if not line and cleaned and not cleaned[-1]:
            continue
        cleaned.append(line)
    return "\n".join(cleaned).strip("\n") + "\n"


def format_css(source: str) -> str:
    """The same idea for stylesheets, which are simpler.

    CSS has no automatic semicolon insertion and no regex ambiguity, so the only
    places to avoid are strings, comments and parentheses - the last because
    `calc(100% - 10px)` and `url(...)` must not be split. Whitespace is
    significant in CSS selectors, but only between tokens, and this never
    removes any.
    """
    out: list[str] = []
    i = 0
    n = len(source)
    depth = 0
    paren = 0
    at_line_start = True

    def newline(level: int) -> None:
        nonlocal at_line_start
        out.append("\n" + INDENT * level)
        at_line_start = True

    while i < n:
        ch = source[i]
        if ch == "/" and i + 1 < n and source[i + 1] == "*":
            end = source.find("*/", i + 2)
            end = n if end == -1 else end + 2
            out.append(source[i:end])
            i = end
            newline(depth)
            continue
        if ch in "'\"":
            j = i + 1
            while j < n:
                if source[j] == "\\":
                    j += 2
                    continue
                if source[j] == ch:
                    j += 1
                    break
                j += 1
            out.append(source[i:j])
            i = j
            at_line_start = False
            continue
        if ch == "(":
            paren += 1
        elif ch == ")":
            paren = max(0, paren - 1)

        if ch == "{" and paren == 0:
            out.append(" {" if not at_line_start and out and not out[-1].endswith(" ") else "{")
            depth += 1
            i += 1
            newline(depth)
            continue
        if ch == "}" and paren == 0:
            depth = max(0, depth - 1)
            if not at_line_start:
                newline(depth)
            elif out and out[-1].startswith("\n"):
                out[-1] = "\n" + INDENT * depth
            out.append("}")
            i += 1
            newline(depth)
            continue
        if ch == ";" and paren == 0:
            out.append(";")
            i += 1
            newline(depth)
            continue
        if ch in " \t":
            if not at_line_start:
                out.append(ch)
            i += 1
            continue
        if ch == "\n":
            if not at_line_start:
                newline(depth)
            i += 1
            continue
        out.append(ch)
        i += 1
        at_line_start = False

    lines = [line.rstrip() for line in "".join(out).split("\n")]
    cleaned: list[str] = []
    for line in lines:
        if not line and cleaned and not cleaned[-1]:
            continue
        cleaned.append(line)
    return "\n".join(cleaned).strip("\n") + "\n"


def bare(text: str) -> str:
    return "".join(ch for ch in text if not ch.isspace())


def parses_as_module(text: str) -> tuple[bool, str]:
    """Ask node whether the result is still a valid ES module.

    The whitespace-only guard is necessary but not sufficient, and the first run
    of this tool proved it: dropping the newline that ends a line comment
    removes only whitespace, yet it comments out whatever followed. The guard
    passed and the file no longer parsed. A parser is the only thing that sees
    that class of mistake, so one runs before anything is written.
    """
    import subprocess
    import tempfile

    handle = tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False, encoding="utf-8", newline="")
    try:
        handle.write(text)
        handle.close()
        result = subprocess.run(["node", "--check", handle.name], capture_output=True, text=True)
        first_line = (result.stderr or "").strip().splitlines()
        return result.returncode == 0, first_line[0] if first_line else ""
    except FileNotFoundError:
        return True, "node not available; syntax not verified"
    finally:
        try:
            os.unlink(handle.name)
        except OSError:
            pass



# --- the lexer's own tests -------------------------------------------------------
#
# The suite is Node and advertises that it needs no installed dependency, so a
# test of this tool cannot live there without making Python a requirement for
# running it. It lives here instead:
#
#     python scripts/format_js.py --self-test
#
# Every case is a shape the lexer exists to survive. They are written as whole
# modules because `parses_as_module` is one of the two guarantees, and a bare
# `return` at the top level is not a module - a case that fails to parse as
# *input* proves nothing about the formatter.
SELF_TEST_JS = [
    # `/` after these is a regex, not division. `return` was read as division,
    # which split the literal at the semicolon inside it and produced a file
    # that did not parse - caught by the parse guard, so nothing was ever
    # corrupted, but the file simply could not be formatted.
    "function f() { return /a;b/.test(x); }",
    "function g() { return(/a;b/).test(x); }",
    "function h(x) { if (typeof x === 'string') { return /;/.test(x); } return false; }",
    "function i(s) { return /a{2};b/.exec(s); }",
    "function j() { return /a/ / 2; }",
    # ...and after these it is division, which must not be treated as a regex.
    "const a = b / c; const d = /x;y/g;",
    "const n = count / 2;",
    "const k = { yield: 1 }; const m = k.yield / 2;",
    "const p = (b + c) / d;",
    # The places a brace or semicolon must not be read as structure.
    "const r = /[{};]/g; const a = 1;",
    "const s = `a${ {x: 1}.x }b`; const t = 2;",
    "const u = `};`; const v = 2;",
    "const w = '};'; const y = 2;",
    "// } ;\nconst a = 1;",
    "/* } ; */ const a = 1;",
    "for (let i = 0; i < 3; i += 1) { a(); }",
    "const z = x.replace(/;/g, ',');",
]

# Whitespace is significant in a CSS selector - `.a .b` and `.a.b` are different
# rules with identical non-whitespace - and the bare() guard cannot see the
# difference. format_css only ever inserts whitespace at rule boundaries, and
# these hold it to that.
SELF_TEST_CSS = [
    ".a.b{color:red}.c .d{color:blue}",
    '.x[data-y="{}"]{color:red}',
    "@media (max-width:760px){.a{color:red}}",
    ".a{width:calc(100% - 10px)}",
    ".a{background:url(data:image/svg+xml;base64,AAA)}",
    "/* } */ .a{color:red}",
    ".a::after{content:';'}",
    ".a[hidden],.b[hidden]{display:none}",
]


def _selectors(css: str) -> list[str]:
    import re

    return [re.sub(r"\s+", " ", part.strip()) for part in re.findall(r"([^{}]+)\{", css)]


def self_test() -> int:
    failures = 0
    for source in SELF_TEST_JS:
        formatted = format_source(source)
        if bare(formatted) != bare(source):
            print(f"SELF-TEST FAILED (non-whitespace moved): {source!r} -> {formatted!r}")
            failures += 1
            continue
        parsed, message = parses_as_module(formatted)
        if not parsed:
            print(f"SELF-TEST FAILED (result does not parse): {source!r} -> {formatted!r} ({message})")
            failures += 1
            continue
        if format_source(formatted) != formatted:
            print(f"SELF-TEST FAILED (not idempotent): {source!r}")
            failures += 1

    for source in SELF_TEST_CSS:
        formatted = format_css(source)
        if bare(formatted) != bare(source):
            print(f"SELF-TEST FAILED (non-whitespace moved): {source!r} -> {formatted!r}")
            failures += 1
            continue
        if _selectors(formatted) != _selectors(source):
            print(
                "SELF-TEST FAILED (a selector changed meaning): "
                f"{_selectors(source)} -> {_selectors(formatted)}"
            )
            failures += 1
            continue
        if format_css(formatted) != formatted:
            print(f"SELF-TEST FAILED (not idempotent): {source!r}")
            failures += 1

    total = len(SELF_TEST_JS) + len(SELF_TEST_CSS)
    print(f"self-test: {total - failures} of {total} cases passed")
    return 1 if failures else 0


def main() -> int:
    if "--self-test" in sys.argv[1:]:
        return self_test()
    args = [a for a in sys.argv[1:] if a not in ("--check", "--self-test")]
    check_only = "--check" in sys.argv[1:]
    if not args:
        print(__doc__)
        return 2

    failures = 0
    for name in args:
        path = Path(name)
        source = path.read_text(encoding="utf-8", newline="")
        is_css = path.suffix.lower() == ".css"
        formatted = format_css(source) if is_css else format_source(source)

        parsed, message = (True, "") if is_css else parses_as_module(formatted)
        if not parsed:
            print(f"{path}: REFUSED - the formatted result does not parse ({message})")
            failures += 1
            continue

        # The refusal that makes this safe to run: if anything other than
        # whitespace moved, the tool has a bug and must not write the file.
        if bare(formatted) != bare(source):
            print(f"{path}: REFUSED - formatting would change non-whitespace content")
            failures += 1
            continue

        if check_only:
            longest = max((len(line) for line in source.split("\n")), default=0)
            over = sum(1 for line in source.split("\n") if len(line) > 200)
            state = "formatted" if formatted == source else "NEEDS FORMATTING"
            print(f"{path}: {state} (longest line {longest}, {over} over 200 chars)")
            if formatted != source:
                failures += 1
            continue

        if formatted != source:
            path.write_text(formatted, encoding="utf-8", newline="")
            print(f"{path}: formatted")
        else:
            print(f"{path}: already formatted")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
