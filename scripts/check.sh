#!/usr/bin/env bash
# Everything that has to pass, in the order it has to pass in. Linux side.
#
# The counterpart to `check.ps1`. Its header explains why the order is the
# point; the short version is that the two steps easiest to forget are the two
# whose failure surfaces somewhere else entirely:
#
#   - A stale asset stamp fails `tests/assets.test.mjs` thousands of assertions
#     into a run, naming a digest rather than the edit that caused it.
#   - An unstaged frontend fails the *selftest*, not the suite. The suite is
#     green, `web/` is correct, and the binary contains an older copy.
#
# Nothing here is weakened to make it convenient. The stamp is still written by
# `stamp_assets.py` and still verified by the suite, staging still refuses an
# incomplete bundle, and the selftest still compares the stamp compiled into the
# binary against the one on disk. This only stops them being run in the wrong
# order.
#
#   ./scripts/check.sh              everything
#   ./scripts/check.sh --fast       the JavaScript half only; no Rust, no staging
#   ./scripts/check.sh --release    also build and selftest the release profile
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

fast=0
release=0
for arg in "$@"; do
  case "$arg" in
    --fast) fast=1 ;;
    --release) release=1 ;;
    *) echo "Unknown option: $arg" >&2; echo "Usage: $0 [--fast] [--release]" >&2; exit 2 ;;
  esac
done

python=python3
command -v "$python" >/dev/null || { echo "No python3 on PATH." >&2; exit 1; }

step() { printf '\n== %s\n' "$1"; }

# --- the stamp, first, because the suite checks it --------------------------
step 'Asset stamp'
"$python" scripts/stamp_assets.py

# --- the archive, before anything computes over it --------------------------
#
# Before the suite, because the suite computes over the archive: a broken one should be
# reported as a broken archive rather than as a strange assertion three thousand tests
# in.
#
# Short where CCP is export is not in the clone: `data/` is tracked and `source/` is
# not, so five of the nine checks have nothing to compare against. The verifier names
# which did not run.
step 'Archive'
if [ -f source/eve-sde-latest-jsonl.zip ]; then
  "$python" scripts/verify_offline_map.py
else
  "$python" scripts/verify_offline_map.py --without-sde
fi

step 'Test suite'
node tests/run.mjs

if [ "$fast" -eq 1 ]; then
  printf '\nJavaScript half passed. Rust not checked (--fast).\n'
  exit 0
fi

# --- the shell, which carries its own copy of the frontend ------------------
#
# Staged before it is built, because the frontend is compiled *into* the binary.
# `dist/web/index.html` is a compile dependency, so cargo re-embeds on its own
# once the staged copy has changed.
step 'Stage the shell'
"$python" scripts/stage_shell.py

step 'Build (debug)'
cargo build --manifest-path src-tauri/Cargo.toml

step 'Selftest (debug)'
cargo run --manifest-path src-tauri/Cargo.toml -- --selftest

if [ "$release" -eq 1 ]; then
  # A release build is a different binary and not only a faster one: one check -
  # that a panicking worker is reported rather than killing the application - is
  # a compile-time assertion about the profile and can only mean anything there.
  # The `console` feature exists because the Windows release build is
  # windows-subsystem with nowhere to print; it is harmless here and keeps both
  # platforms checking the same binary shape.
  step 'Selftest (release)'
  cargo run --release --features console --manifest-path src-tauri/Cargo.toml -- --selftest
fi

printf '\nAll checks passed.\n'
