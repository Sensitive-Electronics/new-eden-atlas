"""The supervised process, and the handshake that proves the core owns it.

There is no work here yet, and that is deliberate. The record is explicit that
the sidecar should *earn* each responsibility rather than inherit a category:
the deterministic brain is JavaScript today, it carries the whole test suite,
and moving it to Python wholesale would discard tested code for nothing. This
file exists to hold the process boundary open until something needs it - a
RedisQ listener that must survive a window closing, SQLite, credential
handling, anything that must keep running when no window is open.

What it does do is answer `hello` with its own pid, and that is not decoration.

PyInstaller's `--onefile` unpacks to a temp directory and spawns the real
interpreter as a child, so a core that killed the process it spawned would
leave the worker running. The spike measured exactly that: parent 43460 killed,
child 33304 still alive. `--onedir` fixes it, but a packaging change could
reintroduce it silently and the core would report a clean shutdown either way.

So the pid is reported and the core refuses any process whose pid is not the one
it spawned. Build this with:

    pyinstaller --onedir --name atlas-sidecar sidecar/atlas_sidecar.py

**Never --onefile.** The core will notice, and refuse to supervise it.
"""

from __future__ import annotations

import json
import os
import sys


# Must match `CONTRACT_VERSION` in `web/contract.js`. Declared rather than
# echoed from the request: a peer that agrees with whatever version it is told
# is a peer that cannot disagree, which is the whole of what a version is for.
# `tests/contract.test.mjs` holds the two numbers together.
CONTRACT_VERSION = 1

# The ops that arrive as envelopes rather than as the bare handshake lines.
ADVISOR_OPS = ("advisor.consider", "advisor.ask")


def refusal(request: dict, code: str, message: str) -> dict:
    """A reply envelope carrying no answer.

    **The question is never echoed.** Not in the message, not in a payload,
    not anywhere - a failure envelope carries a code and a sentence this side
    wrote. The pilot's text arrives, is used, and does not come back out.
    """
    return {
        "v": CONTRACT_VERSION,
        "id": str(request.get("id", "")),
        "ok": False,
        "error": {"code": code, "message": message},
    }


def answer(request: dict) -> dict:
    # **An envelope is an object.** `main()` guarded only `json.loads`, so a
    # well-formed `null`, `5` or `[]` reached this line and `.get` raised - and
    # a raise here ends the loop, ends the process, and nothing respawns it. One
    # malformed call from the webview removed the advisor for the rest of the
    # session. The core refuses a non-object now as well; this is the same rule
    # on the side that would actually die of it.
    if not isinstance(request, dict):
        return refusal({}, "malformed", "a request is an object")
    operation = request.get("op")
    if operation == "hello":
        return {
            "op": "hello",
            "pid": os.getpid(),
            "python": sys.version.split()[0],
        }
    if operation == "ping":
        return {"op": "ping", "pid": os.getpid()}
    if operation in ADVISOR_OPS:
        # The version is checked before anything else, because a peer speaking a
        # different contract may have meant something else by every field below.
        if request.get("v") != CONTRACT_VERSION:
            return refusal(
                request,
                "version-mismatch",
                f"this advisor speaks contract v{CONTRACT_VERSION}",
            )
        # There is no model wired to this process yet, and that is a refusal
        # rather than an empty answer. An empty answer would reach the window as
        # a brief with nothing in it, which reads as "the advisor looked and
        # found nothing to say" - the absence-of-observation mistake this
        # project spends most of its rules on.
        return refusal(
            request,
            "upstream-refused",
            "no model is configured in this build, so there is nothing to answer with",
        )
    # **A refusal envelope, and no pid.**
    #
    # This answered with `{"op":…, "pid":…, "error":…}`: no version, and the
    # process id handed to the webview. `advisor.available` was deliberately
    # narrowed to one boolean and `shell_status` deliberately left unreached so
    # that the page would never learn the sidecar's pid - and this gave it away
    # through the other door, relayed verbatim by the core. The handshake ops
    # above still report a pid, to the core, which is what the pid is for.
    return refusal(request, "unknown-op", "this advisor does not answer that")


def main() -> int:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        if line == "quit":
            break
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            request = {"op": None, "error": str(error)}
        # **One line may not end the loop.**
        #
        # Everything below runs on input the core relayed from the webview, and
        # an exception anywhere in it kills a process that nothing respawns -
        # so the advisor would be gone until the application restarted, from a
        # single bad request. A refusal is an answer; a dead process is not.
        try:
            reply = answer(request)
        except Exception as error:  # noqa: BLE001 - a crash here is worse
            reply = refusal(request if isinstance(request, dict) else {}, "refused", str(error))
        # Flushed every time, or a reply sits in a pipe while the core waits for
        # it and the whole exchange looks like a hang.
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
