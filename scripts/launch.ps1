# Launch the desktop shell for a play session.
#
# What the shortcut on the desktop runs. It exists rather than the shortcut
# pointing straight at the executable, for two reasons.
#
# The frontend is served from `dist/`, which is a copy - so this re-stages
# first, and then it **rebuilds**, which is the part that was missing and cost
# an entire session.
#
# `tauri.conf.json` sets `frontendDist` and no `devUrl`, so the frontend is
# compiled *into the binary*. Staging `dist/` and launching an existing
# executable therefore changes nothing at all: the window shows whatever
# `web/` looked like the last time cargo ran, so re-staging alone is not enough - and a
# launcher claiming to have handled exactly that is an explanation worse than none.
#
# The symptom is brutal because it is silent. Every static check passes, `dist/` is
# correct on disk, the asset stamp is fresh, the suite is green, and the running window
# disagrees with all of it.
#
# `cargo build` on an unchanged tree is a second or two. Anything else invites
# the same hours back.
#
# And the working directory matters. In a development build the sidecar is
# found at `sidecar/atlas_sidecar.py` *relative to where the process starts*,
# so a shortcut with "Start in" pointing anywhere else silently runs without
# one. That resolution is deliberately development-only - a release build runs
# no sidecar rather than one it found lying about - but this launcher is for
# development builds, so it sets the directory explicitly rather than trusting
# whatever the shortcut was given.

param(
    # The debug build by default: it carries devtools, which is the whole point
    # of a session spent poking at it. `-Release` runs the optimised one.
    [switch]$Release
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$python = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { 'python3' }

# Restamp before staging. The page's assets share one cache stamp derived from
# their contents, and a webview will happily serve a cached script under an
# unchanged URL - which once meant a new panel's markup loading beside a cached
# app.js that had no code to show it. Idempotent: it only writes when an asset
# actually changed.
& $python (Join-Path $root 'scripts\stamp_assets.py') | Out-Null

& $python (Join-Path $root 'scripts\stage_shell.py') | Out-Null
if ($LASTEXITCODE -ne 0) {
    # Staging refuses rather than producing a bundle that opens on an empty map,
    # so its complaint is worth reading rather than swallowing.
    & $python (Join-Path $root 'scripts\stage_shell.py')
    Read-Host 'Staging failed - press Enter to close'
    exit 1
}

$build = if ($Release) { 'release' } else { 'debug' }
$exe = Join-Path $root "src-tauri\target\$build\new-eden-atlas.exe"

# Rebuild, because the frontend lives inside the binary. Staged files that the
# executable predates are staged files nobody will ever see.
Write-Host 'Building (the frontend is compiled into the binary)...'
$buildArgs = @('build', '--manifest-path', 'src-tauri/Cargo.toml')
if ($Release) { $buildArgs += '--release' }
& cargo @buildArgs
if ($LASTEXITCODE -ne 0) {
    Read-Host 'Build failed - press Enter to close'
    exit 1
}

if (-not (Test-Path $exe)) {
    Write-Host "No $build build at $exe"
    Read-Host 'Press Enter to close'
    exit 1
}

# No timestamp guard here, deliberately - but a real one, by identity.
#
# There was a timestamp guard, comparing the binary's mtime against the newest
# staged file, and the Linux box defeated it within the hour by the ordinary
# sequence it was written to catch: a build already running when staging wrote new
# assets embedded the old frontend and still finished later, so it was newer and
# stale at once. Two timestamps answer "was this written after that" when the
# question is "does this contain that".
#
# That reasoning is right and the conclusion "no guard is possible here" is too broad.
# Without one, the guarantee that this script "refuses to launch a binary older than the
# frontend beside it" rests on a two-link chain nothing states: the rebuild above, and
# `dist/web/index.html` being a compile dependency.
#
# So the right question is asked instead, the same way `--selftest` asks it. The
# page carries one hash over every asset it loads, `include_str!` puts that page
# inside the binary, and a stamp present in the file on disk and absent from the
# executable means the executable does not contain this frontend. No clock is
# involved, so the straddling build that defeated the old guard is caught by this
# one: it embedded a different stamp.
$staged = Join-Path $root 'dist\web\index.html'
if (-not (Test-Path $staged)) {
    Write-Host "No staged page at $staged - run scripts/stage_shell.py"
    Read-Host 'Press Enter to close'
    exit 1
}
$stamp = [regex]::Match((Get-Content -Raw $staged), '\?v=([0-9a-f]{6,})').Groups[1].Value
if (-not $stamp) {
    Write-Host "$staged carries no asset stamp - run scripts/stamp_assets.py"
    Read-Host 'Press Enter to close'
    exit 1
}
# ISO-8859-1 so every byte maps to one character and the search is a plain
# substring; the stamp is ASCII hex, so nothing is lost. Named by codepage rather
# than as `::Latin1`, which does not exist in Windows PowerShell 5.1 - and 5.1 is
# what `powershell -File scripts/launch.ps1` runs, so the guard would have thrown
# on a null encoding the first time somebody launched with it.
$binary = [System.Text.Encoding]::GetEncoding(28591).GetString([System.IO.File]::ReadAllBytes($exe))
if ($binary.IndexOf("?v=$stamp") -lt 0) {
    Write-Host "The $build binary does not contain the staged frontend (stamp $stamp)."
    Write-Host 'Re-stage and rebuild, or run scripts/check.ps1, which does both in order.'
    Read-Host 'Press Enter to close'
    exit 1
}
Write-Host "Frontend $stamp is the one compiled in."

Write-Host "Launching $build build."

# Started detached. A desktop application does not exit, so waiting on it would
# leave this script - and anything that invoked it - hanging until the window is
# closed.
Start-Process -FilePath $exe -WorkingDirectory $root
