"""Refuse to call this build releasable while it still carries private things.

    python scripts/release_check.py

Every item here was added because it is *correct during development* and wrong
the moment somebody else runs the binary. That is the dangerous kind: nothing
looks broken, no test fails, and the thing ships.

This is a blocker list, not a linter. It says what must change before a public
release and exits non-zero while any of it is still true.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Directories whose contents would actually reach a pilot.
SHIPPED = ["web", "src-tauri/src", "sidecar", "data/ai", "scripts"]

# **A Windows path is spelled with a backslash**, and this was written
# `[A-Z]:[\/]`, which is a character class holding one member: `/`. Inside a
# class `\/` is an escape for the slash, not a backslash and a slash. So the
# check saw `D:/EVE_Atlas` and was blind to `D:\EVE_Atlas` - the spelling every
# document here actually uses. It reported one document while six had one, and
# the five it missed are the five a release would have shipped without ever
# being told. A check that cannot fail in the case that matters is worse than no
# check, because the green reads as an answer.
# **One definition each, and each one exercised.** `check_own_patterns` was added
# after `MACHINE_PATH` had been blind to backslashes for its whole life, and it
# then exercised only `MACHINE_PATH`: the email pattern was written out twice
# inline, and the author-path pattern was guarded by nothing.
#
# Both path patterns were also blind in four ways a real machine writes a path: a
# lower-case drive letter, the macOS user directory, a tilde, and the Windows
# user-profile variable. A pattern whose author only types one spelling is the
# same mistake as a deny-list built from the phrasings somebody thought of.
#
# Those four are named here in words rather than written out, for the same reason
# the fixtures below are assembled: spelled plainly, this comment is a machine
# path inside a shipped file and this script blocks its own release over it. It
# did, on the first run - which is the scanner working.
# The user-profile variable is assembled rather than written. Spelled out, the
# pattern itself matches the pattern, and this script blocked its own release over
# its own source - every other branch is a character class, which is why none of
# them had that problem.
PROFILE_VAR = "%" + "USERPROFILE" + "%"

# **A path-separator class, built from a code point rather than written.**
#
# Written as an escape it has now been eaten twice between an editor and this
# file. The second time it became a class holding only `/`, so the backslash
# spelling of a machine path silently stopped matching - and `check_own_patterns`
# reported it on the next run, which is the entire argument for that function
# existing. `cargo`, `clippy` and every other check here would have said nothing.
#
# This is the project's raw-string convention one step further: a literal that
# cannot survive transit should not be written, it should be assembled.
# `re.escape`, not the character itself: inside a regex character class a lone
# backslash escapes the next character, so `[\/]` is a class holding only `/`.
# That is the same mistake one layer down from the one above, and the reason this
# says what it means instead of relying on a reader counting backslashes.
SEPARATOR = "[" + re.escape(chr(92)) + "/]"

MACHINE_PATH = re.compile(
    "[A-Za-z]:" + SEPARATOR + r"(?:EVE_Atlas|Users)"
    r"|/Users/[A-Za-z0-9_.-]+/"
    "|" + re.escape(PROFILE_VAR),
    re.IGNORECASE,
)

# Defined once. It was written out twice, three lines apart in two functions, so a
# fix to one would have silently left the other narrower.
#
# **A filename is not an address.** `128x128@2x.png` - the name Tauri gives a
# doubled-resolution icon - is email-shaped down to the last character: local part
# `128x128`, domain `2x`, and a "TLD" of `png`. It was reported as somebody's personal
# address in this script's own text. The extension is the only thing that tells them
# apart, so the extension is what the pattern refuses.
ASSET_SUFFIXES = (
    "png|jpg|jpeg|gif|svg|webp|ico|icns|css|js|mjs|json|md|py|rs|ps1|html|htm|txt|zip|toml|lock"
)
EMAIL = re.compile(
    # The literal here cannot match itself: the character before it is `+`, which the
    # local part allows, and the character after is `[`, which the domain does not.
    r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+"
    r"\.(?!(?:" + ASSET_SUFFIXES + r")\b)[A-Za-z]{2,}"
)

# Files that only make sense on the machine that made them. Hoisted beside the
# others so `check_own_patterns` can exercise it: it was inline, which is why it
# was one of the three patterns nothing checked.
DEV_LEFTOVER = re.compile(r"(^|/)(scratch|sandbox|playground)|[.](bak|orig|rej|tmp|log)$")

AUTHOR_PATH = re.compile(
    # The same built class, so neither pattern depends on an escape surviving.
    "[A-Za-z]:" + SEPARATOR + "Users" + SEPARATOR + r"[A-Za-z0-9_.-]+"
    r"|/home/[a-z0-9_.-]+/"
    r"|/Users/[A-Za-z0-9_.-]+/"
    r"|~/[A-Za-z0-9_.-]"
    "|" + re.escape(PROFILE_VAR),
    re.IGNORECASE,
)

BLOCKERS: list[tuple[str, str]] = []


def shipped_files():
    for folder in SHIPPED:
        base = ROOT / folder
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if path.is_file() and path.suffix in {".js", ".mjs", ".rs", ".py", ".html", ".css", ".json"}:
                yield path


def check_contact_address():
    """A personal address in a shipped binary attributes every pilot's traffic to
    one person, and sends CCP to the wrong human about somebody else's client."""
    pattern = EMAIL
    # A project or example address is fine; a personal one is not. Rather than
    # guess at which is which, anything that is not an obvious placeholder is
    # reported for a human to confirm.
    allowed = {"you@example.com", "user@example.com"}
    for path in shipped_files():
        text = path.read_text(encoding="utf-8", errors="replace")
        for found in set(pattern.findall(text)):
            if found in allowed:
                continue
            BLOCKERS.append((
                f"{path.relative_to(ROOT)} carries the address {found}",
                "Make it a setting that defaults to empty, or use a project URL. "
                "CCP want a contact route, not a specific person's inbox in every copy.",
            ))


def check_committed_client_id():
    """A registered application id in a public tree is a shared fate.

    It is not a secret - PKCE means a public client needs none - but it is an
    identity. If every fork ships one id then as far as CCP are concerned every
    token on the planet belongs to that application: one fork's misbehaviour
    shares the rate limit, a revocation kills every install, and a ban lands on
    whoever registered it.

    It is committed deliberately in the private build, on the plan that the
    public tree will be fresh. This is that plan made executable, because a plan
    that has to be remembered on release day by whoever happens to run the push
    is not a plan.
    """
    path = ROOT / "sso.json"
    if not path.exists():
        return
    import json
    try:
        client_id = json.loads(path.read_text(encoding="utf-8")).get("client_id", "")
    except (ValueError, OSError):
        return
    if client_id.strip():
        BLOCKERS.append((
            f"sso.json commits a real client id ({client_id[:6]}..., {len(client_id)} chars)",
            "Clear it. The application reads %APPDATA%/dev.shadowglyph.new-eden-atlas/sso.json "
            "and only that one - load_config is never handed the repository's directory - so "
            "this file is inert at runtime and matters only because it ships. A shared id "
            "makes one fork's ban everyone's.",
        ))


# Documents that exist for the people building this and not for the people using it.
# None is secret; publishing a design record tells a reader exactly what the tool is for
# and where it is going, which for an intel tool is a disclosure rather than
# documentation.
#
# **Listed rather than guessed**, so adding one is a decision rather than a pattern
# somebody hopes is wide enough. A maintainer keeping a working record adds its name
# here, and the release then refuses to ship it until they say otherwise.
PRIVATE_DOCS: list[str] = []
PRIVATE_DOC_PATTERNS = ("Visual", "Handoff", "Audit", "Roadmap", "Sweep", "Linux Check")


def check_private_documents():
    """The development record is not release documentation.

    A fresh public tree clears history; it does not clear content. These files
    copy across unless somebody removes them, and the moment to decide that is
    not the moment you are keen to ship.
    """
    found = [d for d in PRIVATE_DOCS if (ROOT / d).exists()]
    found += [p.name for p in ROOT.glob("*.md")
              if any(p.name.startswith(prefix) for prefix in PRIVATE_DOC_PATTERNS)]
    if found:
        BLOCKERS.append((
            f"{len(found)} internal document(s) are in the tree",
            "Decide deliberately whether each ships: " + ", ".join(sorted(set(found))[:4])
            + ". The design record names the roadmap, the Overlord and Spymaster views, and "
              "placing characters in hostile space.",
        ))


def check_redistributed_sde():
    """CCP's Static Data Export is an input, not something to ship.

    It is 94.5 MB - most of the repository - and a public clone should not pay
    for it. The builder reads it; anyone who wants to rebuild can download it.
    """
    tracked = git("ls-files").splitlines()
    sde = [f for f in tracked if f.startswith("source/")]
    if sde:
        size = sum((ROOT / f).stat().st_size for f in sde if (ROOT / f).exists())
        BLOCKERS.append((
            f"{len(sde)} file(s) under source/ are tracked ({size / 1e6:.1f} MB)",
            "CCP's SDE is an input, not a product. Untrack it and say in the README where to "
            "fetch it; the builder needs it, a clone does not.",
        ))


def check_author_identity_in_content():
    """A fresh tree clears the author field, not the files."""
    pattern = EMAIL
    allowed = {"you@example.com", "user@example.com"}
    hits = []
    for name in git("ls-files").splitlines():
        path = ROOT / name
        if not path.is_file() or path.suffix.lower() not in {".md", ".txt", ".json"}:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if any(found not in allowed for found in pattern.findall(text)):
            hits.append(name)
    if hits:
        BLOCKERS.append((
            f"a personal address appears in {len(hits)} tracked document(s)",
            "A fresh tree clears the commit author, not file contents: " + ", ".join(hits[:3]),
        ))


def check_machine_paths_in_docs():
    """An absolute path from one machine is a private detail and a broken instruction."""
    pattern = MACHINE_PATH
    hits = []
    for name in git("ls-files").splitlines():
        path = ROOT / name
        if not path.is_file() or path.suffix.lower() != ".md":
            continue
        try:
            if pattern.search(path.read_text(encoding="utf-8", errors="replace")):
                hits.append(name)
        except OSError:
            continue
    if hits:
        BLOCKERS.append((
            f"{len(hits)} document(s) hardcode a path from this machine",
            "Relative paths work for everyone: " + ", ".join(hits[:3]),
        ))


def check_licence():
    """A tree with no licence is a tree nobody may legally use.

    The design record says MIT and names the author; the file itself does not exist,
    and every check here was looking for things that are *wrong* rather than things
    that are *absent*. "Free and open source" is a statement about a file, and without
    it the default is all rights reserved - so a release without one grants nothing to
    the people it was published for.

    Which licence, whose copyright line and what year are the owner's to write. This
    only refuses to call the tree releasable while the answer is nowhere.
    """
    names = ("LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "COPYING")
    if any((ROOT / name).is_file() for name in names):
        return
    BLOCKERS.append((
        "there is no licence file",
        "Add one at the root - the design record says MIT. Without it the default is all "
        "rights reserved, so nobody may use, fork or redistribute the thing being "
        "released, whatever the README says about it.",
    ))


def check_notice_in_the_application():
    """Section 7.1 of CCP's Developer License Agreement prescribes a notice, and this
    tree paraphrased it for a while: "EVE Online and the EVE logo are registered
    trademarks of CCP hf" says the same thing in different words, and the clause
    supplies words. It is now carried verbatim in three places, and whoever installs a
    binary sees exactly one of them - so the window is the copy that matters.

    Held against `LICENSE` rather than against a string written here. A fourth copy in
    the checker is a fourth thing to keep in step, and the one that drifts silently is
    always the copy nobody reads. `LICENSE` is the legal document, so it is the source.

    Which makes this vacuous if `LICENSE` loses the notice, hence two guards: the
    quotation has to be found at all, and it has to look like itself.
    """
    licence = ROOT / "LICENSE"
    readme = ROOT / "README.md"
    page = ROOT / "web" / "index.html"
    if not licence.is_file() or not readme.is_file() or not page.is_file():
        return

    licence_text = licence.read_text(encoding="utf-8", errors="replace")
    prescribed = ""
    for line in licence_text.splitlines():
        if "CCP hf" in line and "All rights reserved" in line:
            prescribed = line.strip()
            break

    # --- the guards, so a missing quotation cannot read as a satisfied one ---
    markers = ("CCP hf", "All rights reserved", "trademarks or registered trademarks",
               "EVE Online")
    if not prescribed or not all(marker in prescribed for marker in markers):
        BLOCKERS.append((
            "LICENSE no longer carries CCP's prescribed notice",
            "Section 7.1 of the Developer License Agreement gives the wording. It is the "
            "source every other copy is checked against, so losing it here disables the "
            "check on the application as well as breaching the clause.",
        ))
        return

    for name, text in ((readme.name, readme.read_text(encoding="utf-8", errors="replace")),
                       ("the application window", page.read_text(encoding="utf-8", errors="replace"))):
        if prescribed in text:
            continue
        BLOCKERS.append((
            "%s does not carry CCP's prescribed notice" % name,
            "Section 7.1 of the Developer License Agreement prescribes the wording, and "
            "LICENSE carries it. A paraphrase is not it. Copy the line from LICENSE "
            "exactly: " + prescribed,
        ))

    # --- and the part that is ours, which the clause does not ask for -------
    # Section 2.7 forbids holding yourself out as CCP; it does not require saying you
    # are not. Somebody who installed a binary should not have to work that out, and
    # this is the only line in the window that tells them.
    lowered = page.read_text(encoding="utf-8", errors="replace").lower()
    if "not affiliated" not in lowered:
        BLOCKERS.append((
            "the application no longer says it is unofficial",
            "CCP's notice establishes whose trademarks these are, not who is behind the "
            "tool. Say both, in the window, where the person who installed it looks.",
        ))


# Tools that must not be credited as an author of a published tree.
#
# Not a judgement about how the code was written - it is that authorship is a claim, an
# AI cannot hold one, and a trailer naming one muddies the only copyright line the
# licence has. `GPT` is deliberately absent: `9S-GPT` is a real system and the archive
# names it.
# **Assembled, not written.** Spelled out, this pattern matches the file that holds it and
# the check reports itself for ever - which is the same reason `SEPARATOR` above is built
# from `chr(92)` and the fixtures further down are joined from pieces. A scanner that
# cannot be run over its own tree is a scanner with an exception in it.
AI_ATTRIBUTION = re.compile("|".join([
    "cl" + "aude", "anthro" + "pic", "open" + "ai", "copi" + "lot", "gem" + "ini",
]), re.I)

# Extensions whose contents are not text worth scanning, as a set of dotted suffixes.
#
# **Not `ASSET_SUFFIXES`**, which looks usable and is not: it is a pipe-joined string built
# for the inside of a regex, so `".png" in ASSET_SUFFIXES` is false for every extension and
# a skip written that way never fires. Separate name, dotted members, so the two cannot be
# mistaken for each other.
BINARY_SUFFIXES = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".webp", ".zip", ".sqlite", ".lock",
})


def check_no_ai_authorship():
    """A published tree credits no AI, in its commits or in its files.

    Both halves, because they fail differently. A `Co-Authored-By` trailer is the credit
    itself and survives a force-push as an unreachable object, so it has to be caught
    before the push rather than after. A file reference is quieter - a generated README
    addressing agents by product name is not a credit, but it dates the tree and it is
    the sort of thing a reader reads as one.

    Scanned rather than remembered: an export is a fresh history, so this runs against
    whatever the export actually contains rather than against what anyone intended.
    """
    commits = git("log", "--format=%B")
    credited = [line.strip() for line in commits.splitlines()
                if line.lower().startswith("co-authored-by:") and AI_ATTRIBUTION.search(line)]
    if credited:
        BLOCKERS.append((
            f"{len(credited)} commit trailer(s) credit an AI as an author",
            "An AI cannot hold authorship, and the trailer muddies the licence's copyright "
            "line. Rewrite the messages before publishing - and note that a force-push "
            "leaves the old commit fetchable by SHA, so this has to be fixed before the "
            f"first push rather than after it. First: {credited[0]}",
        ))

    named = []
    for name in git("ls-files").splitlines():
        path = ROOT / name
        if not path.is_file() or path.suffix.lower() in BINARY_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if AI_ATTRIBUTION.search(text):
            named.append(name)
    if named:
        BLOCKERS.append((
            f"{len(named)} tracked file(s) name an AI tool",
            "Decide deliberately whether each should: " + ", ".join(sorted(named)[:4])
            + ". None of these is a credit on its own, and a reader may take it for one.",
        ))


def check_version_is_declared_once():
    """Four files declare this application's version, and shipping 0.0.0 is the default.

    `Cargo.toml` and `tauri.conf.json` carry the crate and bundle version - the one Windows
    shows in Programs and Features and the one the installer filename carries. `esi.js` and
    `sso.rs` carry the version CCP sees in the user agent. Nothing made them agree, and a
    working tree's natural value for the first two is `0.0.0`, so the shipped artefact
    announces itself as unreleased while telling CCP it is 1.0.

    The user agent carries major.minor by convention, so it is held to the leading two
    components rather than to the whole string.
    """
    manifest = ROOT / "src-tauri" / "tauri.conf.json"
    cargo = ROOT / "src-tauri" / "Cargo.toml"
    esi = ROOT / "web" / "esi.js"
    sso = ROOT / "src-tauri" / "src" / "sso.rs"
    if not all(p.is_file() for p in (manifest, cargo, esi, sso)):
        return

    def first(pattern, path):
        found = re.search(pattern, path.read_text(encoding="utf-8", errors="replace"))
        return found.group(1) if found else None

    bundle = first(r'"version"\s*:\s*"([^"]+)"', manifest)
    crate = first(r'(?m)^version\s*=\s*"([^"]+)"', cargo)
    agent = first(r'VERSION\s*=\s*"([^"]+)"', esi)
    core = first(r'USER_AGENT:\s*&str\s*=\s*"[^/]+/([0-9][^ )(;]*)', sso)

    missing = [name for name, value in
               (("tauri.conf.json", bundle), ("Cargo.toml", crate),
                ("web/esi.js", agent), ("src-tauri/src/sso.rs", core)) if not value]
    if missing:
        BLOCKERS.append((
            "a version could not be read from %d file(s)" % len(missing),
            "Checked so the four cannot drift: " + ", ".join(missing) + ". If a declaration "
            "moved, move this check with it rather than leaving it reading nothing.",
        ))
        return

    # Unreleased is the default, and the default must not be what ships.
    zeroes = [name for name, value in
              (("tauri.conf.json", bundle), ("Cargo.toml", crate)) if value.startswith("0.")]
    if zeroes:
        BLOCKERS.append((
            "the build would ship as version %s" % bundle,
            "%s still carry a pre-release version. That is the number Windows shows in "
            "Programs and Features and the one the installer filename carries, while the "
            "user agent tells CCP %s." % (" and ".join(zeroes), agent),
        ))

    def major_minor(value):
        return ".".join(value.split(".")[:2])

    declared = {
        "tauri.conf.json": major_minor(bundle),
        "Cargo.toml": major_minor(crate),
        "web/esi.js": major_minor(agent),
        "src-tauri/src/sso.rs": major_minor(core),
    }
    if len(set(declared.values())) > 1:
        BLOCKERS.append((
            "%d files disagree about the version" % len(set(declared.values())),
            "One application, one version: "
            + ", ".join(f"{name} says {value}" for name, value in sorted(declared.items()))
            + ". The user agent is held to major.minor, which is what it carries.",
        ))


# The spike's placeholder icons, by content. Recorded so restoring one is caught
# even under a different name or size.
PLACEHOLDER_ICONS = {
    "dc8d0b7521af072341619b1a29ddf876fd158d4e40fe74e72f4128a4c5bb2c6a",  # icon.ico, 1,456 bytes
    "69fc1bc65de8a170c8b37f87b532655d172f5b941377e4a78f8a3b90cd4e8fff",  # icon.png, 1,434 bytes
}


def check_placeholder_icon():
    """Every icon the bundle carries, not the one that was checked first.

    `icon.png` is 1,434 bytes - the same placeholder, bundled alongside `icon.ico`
    by `tauri.conf.json` - and was checked by nothing. The directory is read rather
    than a list of names: a bundle that grows a 512x512 the day somebody adds a
    Linux target would otherwise be outside this again.

    By identity rather than by size. This was `size < 8_000`, which read the
    placeholder's weight as the thing that made it a placeholder. The day the Linux
    sizes arrived that became unsatisfiable: **all 3,435** real 32x32 PNGs shipped
    on an Ubuntu 24.04 desktop are under 8,000 bytes, the largest 6,411, and so are
    162 of 173 real 128x128s. A 32x32 icon cannot reach 8 KB without being padded,
    so the check demanded exactly what it was written to forbid - a file made big
    rather than made well. The docstring above anticipated the directory growing
    and not the threshold going with it.

    A digest names the file the project actually wants gone, and stops being wrong
    the moment a real icon happens to be small - which a flat vector mark always is.
    Same correction as the frontend staleness guard: ask what it *is*, not what it
    weighs.
    """
    icons = ROOT / "src-tauri" / "icons"
    if not icons.is_dir():
        return
    found = sorted(path for path in icons.iterdir() if path.is_file())
    if not found:
        BLOCKERS.append((
            "src-tauri/icons holds no icon at all",
            "The bundle needs one. It is the first thing anyone sees.",
        ))
        return
    for icon in found:
        digest = hashlib.sha256(icon.read_bytes()).hexdigest()
        if digest in PLACEHOLDER_ICONS:
            BLOCKERS.append((
                f"src-tauri/icons/{icon.name} is still the spike's placeholder",
                "Draw a real icon, or run scripts/make_icons.py. It is the first thing anyone sees.",
            ))


def check_icon_set():
    """Every icon the manifest names exists, and covers the targets it declares.

    Read from `tauri.conf.json` rather than from a list written here, because the
    manifest is what the bundler obeys and a second list would drift from it.

    The sizes are not arbitrary. Windows picks the nearest image in a `.ico` and
    downscales it, so a file holding only 256x256 renders soft at the 16 pixels the
    taskbar and Alt-Tab use. A Linux `.deb` or AppImage installs PNGs by name -
    `32x32.png`, `128x128.png`, `128x128@2x.png` - and `cargo tauri icon <source.png>`
    generates that whole set from one image.
    """
    manifest = ROOT / "src-tauri" / "tauri.conf.json"
    if not manifest.is_file():
        return
    try:
        config = json.loads(manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        BLOCKERS.append((
            f"src-tauri/tauri.conf.json is not valid JSON: {error}",
            "The bundler reads this file; nothing else here can be trusted while it does not parse.",
        ))
        return

    bundle = config.get("bundle") or {}
    declared = bundle.get("icon") or []
    missing = [name for name in declared if not (ROOT / "src-tauri" / name).is_file()]
    if missing:
        BLOCKERS.append((
            f"tauri.conf.json names {len(missing)} icon(s) that do not exist: {', '.join(missing)}",
            "The bundle build fails on this, at the end of a long compile and possibly on "
            "somebody else's machine. Generate the set with: cargo tauri icon <source.png>",
        ))

    # A `.ico` with one image is what Windows downscales for every small size.
    for name in declared:
        path = ROOT / "src-tauri" / name
        if path.suffix.lower() != ".ico" or not path.is_file():
            continue
        raw = path.read_bytes()
        if len(raw) < 6:
            continue
        count = int.from_bytes(raw[4:6], "little")
        if count < 2:
            BLOCKERS.append((
                f"src-tauri/{name} holds {count} image, so Windows downscales it everywhere",
                "An .ico should carry 16, 32, 48 and 256 so the taskbar, Alt-Tab and Explorer "
                "each get a size drawn for them. cargo tauri icon writes all of them.",
            ))

    # Linux bundles install PNGs by name, and this project builds for Linux.
    targets = bundle.get("targets")
    wanted = {"deb", "appimage", "rpm"}
    linux = targets == "all" or (isinstance(targets, list) and wanted & {str(t).lower() for t in targets})
    linux_icons = ("32x32.png", "128x128.png", "128x128@2x.png")
    absent = [name for name in linux_icons if not (ROOT / "src-tauri" / "icons" / name).is_file()]
    if linux and absent:
        BLOCKERS.append((
            f"a Linux bundle is configured and {len(absent)} of its icons are absent: {', '.join(absent)}",
            "A .deb and an AppImage install PNGs by those exact names. cargo tauri icon "
            "<source.png> generates them.",
        ))
    elif absent and isinstance(targets, list):
        BLOCKERS.append((
            f"bundle.targets is {targets}, so no Linux package is built",
            "This project develops and selftests on Linux, and those need no bundle icons - "
            "but nothing here produces a .deb or an AppImage for it. Decide deliberately: add "
            "the targets and the icons (cargo tauri icon), or say in the README that Linux is "
            "run from source.",
        ))


def check_absolute_author_paths():
    """A path under one machine's user directory is a private detail and a bug."""
    pattern = AUTHOR_PATH
    for path in shipped_files():
        text = path.read_text(encoding="utf-8", errors="replace")
        for found in set(pattern.findall(text)):
            BLOCKERS.append((
                f"{path.relative_to(ROOT)} hardcodes the path {found}",
                "Resolve it at runtime instead.",
            ))


def git(*arguments: str) -> str:
    try:
        done = subprocess.run(
            ["git", *arguments], cwd=ROOT, capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as error:
        BLOCKERS.append((f"git could not be run: {error}",
                         "The tree cannot be shown to be clean, so it must not be published."))
        return ""
    return done.stdout


def check_clean_tree():
    """A development tree is not a release.

    What gets posted has to be what was reviewed. An uncommitted edit means the
    artifact and the history disagree, and the disagreement is invisible to
    everyone downloading it - they get the commit, the author tested the edit.
    Untracked files are the same hazard from the other side: a scratch script or
    a captured live store sitting in the tree gets swept into an archive.
    """
    status = git("status", "--porcelain")
    dirty = [line for line in status.splitlines() if line.strip()]
    if not dirty:
        return
    modified = [l for l in dirty if not l.startswith("??")]
    untracked = [l for l in dirty if l.startswith("??")]
    if modified:
        BLOCKERS.append((
            f"{len(modified)} tracked file(s) differ from the last commit",
            "Commit or revert them. What is posted must be what the history says it is: "
            + ", ".join(l[3:] for l in modified[:5]) + ("..." if len(modified) > 5 else ""),
        ))
    if untracked:
        BLOCKERS.append((
            f"{len(untracked)} untracked file(s) are sitting in the tree",
            "Commit them, delete them, or add them to .gitignore. A scratch file in the tree "
            "is a scratch file in the archive: "
            + ", ".join(l[3:] for l in untracked[:5]) + ("..." if len(untracked) > 5 else ""),
        ))


def check_no_build_output_tracked():
    """Build output in the history is somebody else's machine in the download."""
    tracked = git("ls-files").splitlines()
    patterns = ("dist/", "src-tauri/target/", "node_modules/", ".venv/")
    caught = [f for f in tracked if any(f.startswith(p) for p in patterns)]
    caught += [f for f in tracked if f.endswith((".msi", ".exe", ".pdb", ".rlib"))]
    if caught:
        BLOCKERS.append((
            f"{len(caught)} build artefact(s) are tracked in git",
            "Remove them and gitignore the directory: " + ", ".join(caught[:5]),
        ))


def check_no_dev_leftovers():
    """Files that only make sense on the machine that made them."""
    tracked = git("ls-files").splitlines()
    suspicious = [
        f for f in tracked
        if DEV_LEFTOVER.search(f)
    ]
    if suspicious:
        BLOCKERS.append((
            f"{len(suspicious)} development leftover(s) are tracked",
            "These are working files, not part of the product: " + ", ".join(suspicious[:5]),
        ))
    # The spike lived outside the repository and is referenced by absolute path
    # in documents. That is fine in a record and wrong in shipped code.
    #
    # This file is excluded from its own scan. A detector that contains the
    # thing it looks for will always find itself, and a check that cannot pass
    # is a check people learn to ignore.
    marker = "EVE_Atlas" + "_spike"
    for path in shipped_files():
        if path.resolve() == Path(__file__).resolve():
            continue
        if marker in path.read_text(encoding="utf-8", errors="replace"):
            BLOCKERS.append((
                f"{path.relative_to(ROOT)} refers to the spike directory outside the repository",
                "Nothing shipped may depend on a path that exists only on one machine.",
            ))


def check_own_patterns():
    """The blocker list checks the tree; nothing checked the blocker list.

    `check_machine_paths_in_docs` was blind to backslash paths for its whole
    life and said so in green - it reported one document while six had one. The
    defect was invisible from either side alone: the regex reads correctly at a
    glance and the output was a plausible number.

    So each pattern is exercised against a sample it must catch and one it must
    not, here, every run. These are cheap and they are the only thing standing
    between a quiet regex change and a release that ships somebody's home
    directory.
    """
    # `sep` is assembled rather than written, and this is not fussiness. Spelled
    # out, the sample below *is* a machine path inside a shipped file, and
    # `check_absolute_author_paths` scans `scripts/` - so writing the fixture
    # plainly made this script report itself. That is the scanner working
    # correctly, so the fixture moves rather than the check.
    sep = chr(92)
    # Assembled, for the reason `sep` is assembled: spelled out, every one of these
    # fixtures *is* the thing the pattern exists to catch, inside a shipped file
    # that `check_absolute_author_paths` scans - so writing them plainly made this
    # script block its own release. Four of them did, on the first run.
    at = chr(64)
    slash = "/"
    users = slash + "Users" + slash
    nix = slash + "home" + slash
    home = PROFILE_VAR
    tilde = "~" + slash
    cases = [
        (MACHINE_PATH,
         [f"see D:{sep}EVE_Atlas{sep}web", "see D:/EVE_Atlas/web", f"C:{sep}Users{sep}someone",
          # The four spellings this was blind to. A lower-case drive letter is what
          # a shell writes, `/Users/` is macOS, and the last two are what a script
          # writes when somebody "made it portable".
          f"see d:{sep}EVE_Atlas{sep}web", f"{users}someone{slash}EVE_Atlas", f"{home}{sep}EVE_Atlas"],
         ["see the project root", "a relative path web/app.js", "D:EVE_Atlas"]),
        # Assembled, or `check_author_identity_in_content` reports this script as
        # carrying two addresses - which it would be, spelled out.
        (EMAIL,
         [f"mail somebody{at}example.com please", f"a.b-c%d{at}sub.domain.co.uk"],
         # A dot is a dot: the pattern used `.` unescaped, so "a@bXcom" matched and
         # the check was broader than it read.
         ["no address here", f"not-an-address{at}", f"{at}example.com", f"a{at}bXcom",
          # A filename that is email-shaped. Tauri names the doubled-resolution icon
          # this, so a Linux icon set puts one in the tree.
          f"128x128{at}2x.png", f"icon{at}3x.webp", f"sprite{at}2x.svg"]),
        (AUTHOR_PATH,
         [f"C:{sep}Users{sep}someone", f"{nix}someone{slash}", f"c:{sep}users{sep}someone",
          f"{users}someone{slash}", home, f"{tilde}projects"],
         [slash + "usr" + slash + "share", "relative" + slash + "path", "Users without a drive"]),
        # A path pattern, not a code pattern: this one names files that only make
        # sense on the machine that made them.
        (DEV_LEFTOVER,
         ["scratch" + slash + "notes.md", "web" + slash + "sandbox" + slash + "t.js",
          "playground" + slash + "x", "a" + slash + "b.bak", "c.orig", "d.tmp"],
         # The word inside a component, not starting one: a module legitimately
         # called `map-scratch.js` is not a leftover. The first fixture here was
         # `scratchpad_is_a_word.py`, which the pattern is *right* to match - the
         # fixture was wrong, not the check.
         ["web" + slash + "map-scratch.js", "web" + slash + "app.js"]),
    ]
    for pattern, must_match, must_not in cases:
        for sample in must_match:
            if not pattern.search(sample):
                BLOCKERS.append((
                    f"release_check.py cannot see {sample!r}",
                    "One of this script's own patterns stopped matching what it exists to catch. "
                    "Fix the pattern before trusting any result below.",
                ))
        for sample in must_not:
            if pattern.search(sample):
                BLOCKERS.append((
                    f"release_check.py falsely matches {sample!r}",
                    "One of this script's own patterns became too broad, which trains everyone "
                    "to ignore it. Fix the pattern before trusting any result below.",
                ))


def main() -> int:
    check_own_patterns()
    check_clean_tree()
    check_no_build_output_tracked()
    check_no_dev_leftovers()
    check_committed_client_id()
    check_private_documents()
    check_redistributed_sde()
    check_author_identity_in_content()
    check_machine_paths_in_docs()
    check_contact_address()
    check_licence()
    check_icon_set()
    check_notice_in_the_application()
    check_version_is_declared_once()
    check_no_ai_authorship()
    check_placeholder_icon()
    check_absolute_author_paths()

    if not BLOCKERS:
        print("no release blockers found")
        return 0

    print(f"{len(BLOCKERS)} release blocker(s):\n", file=sys.stderr)
    for what, why in BLOCKERS:
        print(f"  {what}\n      {why}\n", file=sys.stderr)
    print("This build is fine for private use and must not be released as it stands.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
