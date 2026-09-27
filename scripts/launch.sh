#!/usr/bin/env bash
# Launch the desktop shell for a play session, on Linux.
#
# The counterpart to `launch.ps1`, which is what the Windows desktop shortcut
# runs. Same order, same refusals, same reasons - the reasons are written out
# there at length and are not repeated here, only the two that differ.
#
#   stamp -> stage -> BUILD -> verify the binary contains that frontend -> run
#
# The build is not optional. `tauri.conf.json` sets `frontendDist` and no
# `devUrl`, so the frontend is compiled *into* the binary: staging `dist/` and
# launching an existing executable changes nothing at all, silently, while
# `dist/` is correct on disk and every check passes. That cost a session on
# Windows and caught this machine again within the hour.
#
#   ./scripts/launch.sh            the debug build, which carries devtools
#   ./scripts/launch.sh --release  the optimised one
#
# What differs from the Windows script:
#
#   - `python3`, not `python`. Most Linux distributions ship no bare `python`,
#     and the python.org Windows installer ships no `python3.exe`, so neither
#     name is portable and each side states its own. `python-is-python3` makes
#     both work here and is not assumed.
#   - No `.exe`, and the binary is launched with `setsid` rather than
#     `Start-Process` so closing the terminal does not take the window with it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

build=debug
cargo_args=(build --manifest-path src-tauri/Cargo.toml)
for arg in "$@"; do
  case "$arg" in
    --release) build=release; cargo_args+=(--release) ;;
    *) echo "Unknown option: $arg" >&2; echo "Usage: $0 [--release]" >&2; exit 2 ;;
  esac
done

python=python3
command -v "$python" >/dev/null || { echo "No python3 on PATH." >&2; exit 1; }

# Restamp before staging. The page's assets share one cache stamp derived from
# their contents; idempotent, so it only writes when an asset actually changed.
"$python" scripts/stamp_assets.py >/dev/null

# Staging refuses rather than producing a bundle that opens on an empty map, so
# let its complaint through rather than swallowing it.
if ! "$python" scripts/stage_shell.py; then
  echo "Staging failed." >&2
  exit 1
fi

echo "Building (the frontend is compiled into the binary)..."
cargo "${cargo_args[@]}"

exe="src-tauri/target/$build/new-eden-atlas"
[ -x "$exe" ] || { echo "No $build build at $exe" >&2; exit 1; }

# The guard, by identity rather than by clock.
#
# A timestamp guard lived here on the Windows side and this machine defeated it
# within the hour, by the ordinary sequence it was written to catch: a build
# already running when staging wrote new assets embedded the old frontend and
# still finished later, so it was newer and stale at once. Two timestamps answer
# "was this written after that" when the question is "does this contain that".
#
# The page carries one hash over every asset it loads and the build compiles that
# page in, so a stamp present on disk and absent from the executable's bytes
# means the executable does not contain this frontend. No clock is involved, so
# the straddling build is caught: it embedded a different stamp.
staged="dist/web/index.html"
[ -f "$staged" ] || { echo "No staged page at $staged - run scripts/stage_shell.py" >&2; exit 1; }

stamp="$(grep -om1 '?v=[0-9a-f]\{6,\}' "$staged" | cut -c4-)" || true
[ -n "${stamp:-}" ] || { echo "$staged carries no asset stamp - run scripts/stamp_assets.py" >&2; exit 1; }

# -a treats the executable as text so a plain substring search works; the stamp
# is ASCII hex, so nothing is lost. -q because the match is the whole answer.
if ! grep -aqF "?v=$stamp" "$exe"; then
  echo "The $build binary does not contain the staged frontend (stamp $stamp)." >&2
  echo "Re-stage and rebuild, or run scripts/check.sh, which does both in order." >&2
  exit 1
fi
echo "Frontend $stamp is the one compiled in."

# The working directory matters: in a development build the sidecar is found at
# `sidecar/atlas_sidecar.py` relative to where the process starts.
echo "Launching $build build."
setsid "$root/$exe" >/dev/null 2>&1 < /dev/null &
