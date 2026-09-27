"""Stage the frontend and the archive together for the desktop shell.

Why this exists, rather than pointing Tauri at the repository root.

`data-service.js` fetches the archive from `../data`, relative to `web/`,
because the browser build serves the repository root. Bundling only `web/`
puts the archive *above* the app root, where the asset protocol will not
follow - and the failure is silent: the window opens on an empty map with no
error anywhere. That was found in the spike and is the reason this script
exists at all.

Pointing `frontendDist` at the repository root instead would bundle `source/`,
which is 94.5 MB of SDE zip.

So the shell gets its own root containing exactly `web/` and the parts of
`data/` the viewer actually reads. The browser build is untouched: it keeps
serving the repository root, and both see the same relative layout.

What is deliberately *not* staged:

    data/ai/          9.8 MB of exports for AI agents reading the repository.
                      Nothing in web/ loads them.
    data/eve_map.sqlite
                      Read only by scripts/. The record is explicit that
                      putting SQLite behind the sidecar is a new capability
                      rather than a relocation of an existing one, so it is
                      not shipped until something reads it.

Leaving them out is a real risk, though, and it is the same silent failure in
a new place: add a fetch to the viewer, and the browser build works while the
shell serves a 404 onto an empty map. So the staging list is not trusted. Every
`${DATA_ROOT}/...` in web/ is read back out of the source and checked against
what was staged, and this script fails rather than producing a bundle that will
open on nothing.

    python scripts/stage_shell.py            # stage into dist/
    python scripts/stage_shell.py --check    # verify only, change nothing
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

# What the viewer loads. Directories are staged whole.
STAGED = [
    Path("web"),
    Path("data/regions.json"),
    Path("data/ships.json"),
    Path("data/eve_map_all.json"),
    Path("data/regions"),
]

# **Two spellings, because the viewer has two.** This matched only
# `${DATA_ROOT}/...`, so a literal `../data/ships.json` - which is what a module
# writes when somebody inlines a path - was invisible to a check whose stated job
# is refusing to stage a viewer that fetches something it does not cover.
DATA_REFERENCE = re.compile(
    r"\$\{DATA_ROOT\}/([^`\"'\s)]+)"
    r"|(?:\.\./)+data/([^`\"'\s)]+)"
)


def staged_paths() -> set[Path]:
    """Every repository-relative path the staging list covers."""
    covered: set[Path] = set()
    for entry in STAGED:
        source = ROOT / entry
        if source.is_dir():
            covered.update(item.relative_to(ROOT) for item in source.rglob("*") if item.is_file())
        elif source.is_file():
            covered.add(entry)
    return covered


def required_paths() -> list[tuple[str, str]]:
    """What web/ says it will fetch, read out of web/ rather than assumed.

    A reference carrying an interpolation - `regions/${regionFile(name)}` - is
    a whole directory's worth of requests, so its directory is what must be
    present. A literal one names a single file.


    **Every file under `web/`, not `web/*.js`.** The glob was flat and
    `.js`-only, so five kinds of reference were outside a check that reads as
    covering all of them: `index.html`, a stylesheet's `url()`, anything in a
    subdirectory, a `.mjs`, and a literal path rather than an interpolated one.
    `web/` is flat and all-`.js` today, which is exactly why this was invisible.

    Read as bytes and decoded loosely, because a font or an image under `web/`
    would otherwise stop the build with a decode error rather than a finding.
    """
    wanted: list[tuple[str, str]] = []
    web = ROOT / "web"
    for source in sorted(path for path in web.rglob("*") if path.is_file()):
        text = source.read_bytes().decode("utf-8", errors="replace")
        for interpolated, literal in DATA_REFERENCE.findall(text):
            reference = interpolated or literal
            if reference:
                wanted.append((source.relative_to(web).as_posix(), reference))
    return wanted


def check_coverage(covered: set[Path]) -> list[str]:
    problems = []
    for origin, reference in required_paths():
        if "${" in reference:
            directory = reference.split("${")[0].rstrip("/")
            if not directory:
                problems.append(f"{origin}: cannot tell what `{reference}` fetches")
                continue
            if not any(str(path).replace("\\", "/").startswith(f"data/{directory}/") for path in covered):
                problems.append(f"{origin}: nothing staged under data/{directory}/ for `{reference}`")
        elif Path("data") / reference not in covered:
            problems.append(f"{origin}: data/{reference} is fetched but not staged")
    return problems


def stage(entry: Path) -> tuple[int, int]:
    """Copy what changed. Returns (copied, skipped)."""
    source, target = ROOT / entry, DIST / entry
    files = [source] if source.is_file() else [p for p in source.rglob("*") if p.is_file()]
    copied = skipped = 0
    for item in files:
        destination = target if source.is_file() else target / item.relative_to(source)
        if destination.exists():
            current, existing = item.stat(), destination.stat()
            # Size and mtime first, because the archive is 12 MB and this runs on
            # every build. A rebuild rewrites mtime, which is what we want to
            # notice.
            #
            # **But equal size and the same whole second is not evidence.** `int()`
            # truncates, so a file rewritten inside the same second as the last
            # staging looked unchanged - and `index.html` is exactly that file on
            # every run, because the asset stamp it carries is a fixed-length hex
            # string. Re-stamping changes twelve characters and not one byte of
            # length. The binary would then carry a page with the previous stamp,
            # which is the "unstaged frontend fails the selftest rather than the
            # suite" failure this script exists to prevent.
            #
            # So the ambiguous case is resolved by reading the bytes. It is the only
            # case that costs anything, and a file that really is unchanged is read
            # once rather than copied.
            if current.st_size == existing.st_size:
                if int(current.st_mtime) < int(existing.st_mtime):
                    skipped += 1
                    continue
                if (int(current.st_mtime) == int(existing.st_mtime)
                        and item.read_bytes() == destination.read_bytes()):
                    skipped += 1
                    continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, destination)
        copied += 1
    return copied, skipped


def prune(covered: set[Path]) -> int:
    """Remove anything in dist/ the staging list no longer covers.

    A stale file here is worse than a missing one: it would be bundled, and it
    would be a copy of something the repository has since changed or deleted.
    """
    removed = 0
    for item in DIST.rglob("*"):
        if item.is_file() and item.relative_to(DIST) not in covered:
            item.unlink()
            removed += 1
    for directory in sorted((p for p in DIST.rglob("*") if p.is_dir()), reverse=True):
        if not any(directory.iterdir()):
            directory.rmdir()
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify coverage without writing anything")
    arguments = parser.parse_args()

    covered = staged_paths()
    if not covered:
        print("nothing to stage: the archive has not been built", file=sys.stderr)
        return 1

    problems = check_coverage(covered)
    if problems:
        print("the shell would open on an empty map:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        print("\nadd the path to STAGED in this script, or stop fetching it.", file=sys.stderr)
        return 1

    references = len(required_paths())
    if arguments.check:
        print(f"staging covers all {references} archive references made by web/")
        return 0

    DIST.mkdir(exist_ok=True)
    copied = skipped = 0
    for entry in STAGED:
        added, kept = stage(entry)
        copied += added
        skipped += kept
    removed = prune(covered)

    megabytes = sum(p.stat().st_size for p in DIST.rglob("*") if p.is_file()) / 1_000_000
    print(f"staged dist/: {copied} copied, {skipped} unchanged, {removed} removed, {megabytes:.2f} MB")
    print(f"all {references} archive references made by web/ resolve inside it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
