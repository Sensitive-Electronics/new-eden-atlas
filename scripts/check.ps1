# Everything that has to pass, in the order it has to pass in.
#
# `launch.ps1` does stamp -> stage -> build for a play session; this is the same
# ordering for *checking*. The two steps easiest to leave out are the two whose
# failure surfaces somewhere else entirely:
#
#   - A stale asset stamp fails `tests/assets.test.mjs`, about five thousand
#     assertions into a run, naming a digest rather than the edit that caused it.
#   - An unstaged frontend fails the **selftest**, not the suite. The suite is
#     green, `web/` is correct, and the binary contains an older copy - which is
#     the failure `launch.ps1`'s header covers, arriving through the check
#     instead of through the window.
#
# Neither is a weakness in the checks. Both are ordering mistakes, and an
# ordering mistake is what a script is for.
#
# Nothing here is weakened to make it convenient: the stamp is still written by
# `stamp_assets.py` and still verified by the suite, staging still refuses an
# incomplete bundle, and the selftest still compares the stamp compiled into
# the binary against the one on disk. This only stops them being run in the
# wrong order.
#
#   powershell -ExecutionPolicy Bypass -File scripts/check.ps1
#   ... -Fast       the JavaScript half only; no Rust, no staging
#   ... -Release    also builds and checks the release profile

param(
    # The suite alone. For the loop where the only thing changing is `web/` or
    # `tests/`, which is most of them.
    [switch]$Fast,
    # A release build is a different binary and not only a faster one: it is
    # windows-subsystem with nowhere to print, so it needs the `console`
    # feature, and one check - that a panicking worker is reported rather than
    # killing the application - is a compile-time assertion about the profile
    # and can only mean anything there.
    [switch]$Release
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$python = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { 'python3' }

function Step($name) { Write-Host "`n== $name" -ForegroundColor Cyan }

function Must($what) {
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n$what failed." -ForegroundColor Red
        exit 1
    }
}

# --- the stamp, first, because the suite checks it --------------------------
#
# Idempotent: it only writes when an asset actually changed, so running it
# every time costs nothing and forgetting it costs a whole run.
Step 'Asset stamp'
& $python (Join-Path $root 'scripts\stamp_assets.py')
Must 'Stamping'

# --- the archive, before anything computes over it --------------------------
#
# **This script is everything that has to pass, in the order it has to pass in**, and
# the archive verifier belongs in it. Left to a command somebody has to remember, the
# only thing checking 8,490 systems and 6,989 stargate links is memory: an archive
# rebuilt coherently with 481 links deleted keeps the whole gate green.
#
# Before the suite, because the suite computes over the archive: a broken one should be
# reported as a broken archive rather than as a strange assertion three thousand tests
# in. 12.7 seconds, measured, so there is no speed argument for leaving it out.
#
# **Short where CCP is export is not in the clone.** `data/` is tracked and `source/`
# is not, so five of the nine checks have nothing to compare against. The verifier says
# which did not run and why; it is not asked to pretend, and it is not skipped either.
Step 'Archive'
$sde = Join-Path $root 'source\eve-sde-latest-jsonl.zip'
if (Test-Path $sde) {
    & $python (Join-Path $root 'scripts\verify_offline_map.py')
} else {
    & $python (Join-Path $root 'scripts\verify_offline_map.py') '--without-sde'
}
Must 'The archive'

Step 'Test suite'
& node (Join-Path $root 'tests\run.mjs')
Must 'The suite'

if ($Fast) {
    Write-Host "`nJavaScript half passed. Rust not checked (-Fast)." -ForegroundColor Green
    exit 0
}

# --- the shell, which carries its own copy of the frontend ------------------
#
# Staged before it is built, because the frontend is compiled *into* the
# binary. `dist/web/index.html` is a compile dependency, so cargo re-embeds on
# its own once the staged copy has changed - no `touch` needed, measured.
Step 'Stage the shell'
& $python (Join-Path $root 'scripts\stage_shell.py')
Must 'Staging'

Step 'Build (debug)'
& cargo build --manifest-path src-tauri/Cargo.toml
Must 'The debug build'

Step 'Selftest (debug)'
& cargo run --manifest-path src-tauri/Cargo.toml -- --selftest
Must 'The debug selftest'

if ($Release) {
    Step 'Selftest (release)'
    & cargo run --release --features console --manifest-path src-tauri/Cargo.toml -- --selftest
    Must 'The release selftest'
}

Write-Host "`nAll checks passed." -ForegroundColor Green
