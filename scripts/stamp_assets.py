"""Stamp the page's assets with a hash of the assets themselves.

    python scripts/stamp_assets.py            # rewrite the stamp
    python scripts/stamp_assets.py --check    # report, change nothing

Why this exists, rather than a version string somebody edits.

Every local asset carries one cache stamp so the page cannot load half of a new
viewer and half of an old one. That part was right. What was wrong is that the
stamp was written by hand on the project's first day and never changed again -
and a constant query string does not break a cache, it **pins** one. The URL
never varies, so the file can never invalidate.

What that costs: a new index.html carrying a new panel served alongside a cached
app.js with no code to show it, so the markup is present, the element is hidden,
every static check passes and the feature is invisible. The same constant does the
same thing to the archive URLs.

So the stamp is derived rather than declared. Change any asset and it changes;
forget to run this and the suite says so.
"""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGE = ROOT / "web" / "index.html"
REFERENCE = re.compile(r'(?:src|href)="([A-Za-z0-9_.-]+\.(?:js|css))(?:\?v=[^"]*)?"')


def assets() -> list[str]:
    """Every local script and stylesheet the page loads, in page order."""
    seen: list[str] = []
    for name in REFERENCE.findall(PAGE.read_text(encoding="utf-8")):
        if name not in seen:
            seen.append(name)
    return seen


def hashed() -> list[str]:
    """Every script and stylesheet in web/, not only the ones the page links.

    The page links one script. The other thirty-odd modules are reached by
    `import "./ask-window.js"` with no query string at all, so hashing only what
    `assets()` finds left every one of them outside the digest: an edit to
    `snapshot.js` or `operations.js` changed nothing about the stamp, and the
    docstring above promising a stale stamp fails the suite was true of seven
    files out of forty.

    It became dangerous at step 6, which added a module `app.js` imports **by
    name**. A pilot holding a cached `ask-window.js` from before `TURN_LIMIT`
    existed gets a module-link error and a blank application - the exact failure
    this file was written for, one import away from where it was looking.

    Three kinds of change were invisible to it, and all three are one mistake:
    the set was described by extension and depth rather than by what the page can
    fetch. A file in a subdirectory of `web/` was outside `iterdir()`. A `.mjs` -
    which is what every file under `tests/` is - was outside the suffix list. And
    any other served file, a `.json` of ship data or an `.svg` or a webfont, was
    outside both.

    So the rule is now what it should always have been: **everything under `web/`
    except the page that carries the stamp**. The page is excluded because the
    stamp is written into it, which would make the digest chase its own tail, and
    because a browser refetches the document itself - the stamp exists for what
    the document *loads*.

    Paths are relative and POSIX-spelled, so two files of the same name in
    different directories cannot collide and the digest is the same on every
    machine.
    """
    web = ROOT / "web"
    return sorted(
        path.relative_to(web).as_posix()
        for path in web.rglob("*")
        if path.is_file() and path.name != "index.html"
    )


def stamp() -> str:
    """One hash over every asset, so they invalidate together or not at all.

    Together matters: the failure this guards is a page loading a new stylesheet
    against an old script, and a per-file hash would allow exactly that.
    """
    digest = hashlib.sha256()
    for name in hashed():
        path = ROOT / "web" / name
        digest.update(name.encode("utf-8"))
        digest.update(path.read_bytes() if path.exists() else b"<missing>")
    return digest.hexdigest()[:12]


def rewrite(page: str, value: str) -> str:
    return re.sub(
        r'((?:src|href)="[A-Za-z0-9_.-]+\.(?:js|css))(?:\?v=[^"]*)?"',
        lambda m: f'{m.group(1)}?v={value}"',
        page,
    )


def main() -> int:
    check = "--check" in sys.argv
    page = PAGE.read_text(encoding="utf-8")
    want = stamp()
    updated = rewrite(page, want)

    if check:
        if page == updated:
            print(f"assets are stamped {want}, matching their contents")
            return 0
        print(f"the page's asset stamp is stale; it should be {want}", file=sys.stderr)
        print("run: python scripts/stamp_assets.py", file=sys.stderr)
        return 1

    if page == updated:
        print(f"already stamped {want}")
        return 0
    PAGE.write_text(updated, encoding="utf-8", newline="\n")
    print(f"stamped {len(assets())} assets with {want}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
