# New Eden Atlas

> The Ministry of Assessment charts the systems in and near Amarr space, and charts them
> for what they are worth. This charts the whole cluster for what is in it: 8,490 systems,
> every gate between them, and the arithmetic to fly it. Filed under the authority of no
> empire and endorsed by none. Where it has been told something it says who told it and
> when; where it has not, it says that instead.

An offline map and tactical planner for EVE Online, built from CCP's official Static Data
Export. It draws the whole cluster, plans stargate routes, works out capital jump ranges,
fuel and fatigue, and analyses the gate network around a system — **with the network
switched off**.

By **Sensitive Electronics**, author **Shadowglyph**. The software is MIT licensed — see
`LICENSE`, which also states what the licence does *not* cover.

This is an unofficial tool and is not affiliated with or endorsed by CCP Games.

© 2014 CCP hf. All rights reserved. "EVE", "EVE Online", "CCP", and all related logos and images are trademarks or registered trademarks of CCP hf.

## What it does

- **The whole cluster, offline.** 8,490 systems, 114 regions, 1,184 constellations, every
  stargate link, CCP's own 2D layout, security and coordinates - all of it shipped with the
  application and read from disk.
- **Stargate routing** with an avoidance list that expires on its own, security limits, and
  optional weighting away from systems people have died in recently. "High security only"
  is a restriction rather than a preference: it refuses to route rather than dipping into
  low sec and mentioning it in a footnote.
- **Capital jump planning** - range, fuel and fatigue per hull, with every figure taken from
  the export rather than remembered. The fatigue model is the one part that is not in the
  export, and it is pinned against CCP's own published worked examples.
- **Threat reach.** Given where a hostile force stages, what each class of jump-capable hull
  can reach, at maximum skills and with no jammers assumed. An upper bound, never a
  boundary - and haulers are labelled as haulers, because the two longest-reaching hulls in
  New Eden cannot shoot back.
- **Tactical analysis** - everything within N jumps, every way in, the systems the network
  cannot route around, and escape, hunt or recon briefs built over them.
- **Live layers, every one optional and none needing an account or an API key** -
  sovereignty, kills and jumps, incursions, faction-warfare frontlines, sovereignty timers,
  and Thera and Turnur connections from EVE-Scout, which stay off until you switch them on.
  If any of them cannot be reached the map still draws.
- **Everything is dated, and absence is said out loud.** Every live reading is shown with
  its age and its source. A layer that has not answered says so rather than showing you a
  zero, because "nobody died here" and "nobody asked" are different facts and only one of
  them is safe to act on.

It runs as a desktop application or as a plain static page in a browser, from the same
files.

## Installing it

Windows will say it protected your PC and hide the install button behind **More info ->
Run anyway**. That is SmartScreen objecting to an unsigned installer. It has not found
anything in the file - it does not look inside; it checks for a signature and for
whether it has seen the download before.

Signing means buying a certificate from a certificate authority and renewing it every
year, and its only function is to stop Windows saying that. I am not paying a yearly fee
for a rubber stamp on software I give away, so it ships unsigned and you get the warning.
A lot of third-party EVE tools are in the same position.

If you would rather not click through a warning at all, the browser build needs no
installer and no Rust - see the end of this file.

## Where your data lives

Two things are stored, and they are kept apart on purpose.

The **archive** is read-only and ships with the application. Rebuilding it cannot touch
anything you have collected.

The **live store** is yours: everything the tool has observed, with the date it was first
seen and the date it was last confirmed. It lives in the application data directory
alongside the settings, and it is written atomically — a crash mid-save cannot corrupt it,
and a file this build cannot read is left alone rather than replaced.

Nothing is sent anywhere. There is no telemetry, no account on our side, and no server.

## If the live store fills up

The store is capped at **256 MB**, which is an order of magnitude past an ordinary one. If
you reach it, saving stops and the application tells you so — it will not quietly discard
history or overwrite the file it already has.

To allow more, create a file called `limits.json` in the same folder as the store:

```json
{ "live_store_mb": 1024 }
```

Then restart. The value is in megabytes, is clamped between 16 and 4,096, and anything the
application cannot read falls back to 256 rather than to no limit at all.

This is a file you edit rather than a setting in the window, and that is deliberate: the
cap exists to stop the application filling your disk, so the application does not get to
raise it.

## Signing in

Optional, and only needed for the things that are specific to your characters. Sign-in uses
EVE's own SSO with PKCE; the refresh token goes into your operating system's credential
store (Credential Manager, Keychain, or your desktop keyring) and never into a file we
write. You can forget a character at any time, which removes the credential and the cached
portrait with it.

To use sign-in you need to register your own application with CCP at
<https://developers.eveonline.com>, then copy `sso.json.example` to `sso.json` beside the
application data and put your client id in it. Registering your own is not a formality —
a shared client id means one person's ban is everyone's.

## Clearing history

From the **Live history** shelf. It names how many records are going and what is kept
before you confirm, and it never removes anything still open: an open sighting is current
state, not history. You can export the whole log to a file first, and import one later.

A sync never deletes. When something stops being reported its record is *closed* with a
date, because the disappearance is itself worth knowing.

## Building it, and checking it

Node and Python are enough for the map, the suite and the browser build. Rust and the Tauri
CLI are needed only for the desktop shell.

Commands are run from the project root. The interpreter is `python` on Windows and
`python3` on Linux and macOS; neither name exists everywhere, so substitute the one your
machine has.

```sh
node tests/run.mjs                 # the offline suite, no Rust and no network
python3 scripts/verify_offline_map.py --without-sde
```

Everything that has to pass, in the order it has to pass in:

```sh
powershell -ExecutionPolicy Bypass -File scripts/check.ps1   # Windows
powershell -ExecutionPolicy Bypass -File scripts/check.ps1 -Fast      # the suite alone
powershell -ExecutionPolicy Bypass -File scripts/check.ps1 -Release   # and the release profile
./scripts/check.sh                                           # Linux and macOS
```

It stamps the page's assets, verifies the archive, runs the suite, stages, builds and
selftests, in that order.

### After editing anything under `web/`

Restamp, or the suite fails thousands of assertions in and names a digest rather than your
edit:

```sh
python3 scripts/stamp_assets.py
```

The stamp is a digest of **every `.js` and `.css` under `web/`**, not only the files the
page links — the page links one script and the rest are reached by import with no query
string, so a digest over the links alone would leave every module outside it. `check.ps1`
does this first, so this is only for running things by hand.

Before publishing a build, check what would go out with it:

```sh
python3 scripts/release_check.py
```

It refuses a build that would carry somebody's personal details, a client id that is not
yours, a placeholder icon, a missing trademark notice, or anything in the tree that was
never meant to leave it.

### The desktop shell

Needs Rust and the Tauri CLI. Tauri 2 needs Rust 1.77.2 or newer, which is later than some
distributions package, so install it through rustup rather than using the system compiler —
otherwise it fails at compile time rather than at install time.

```sh
cargo tauri dev
cargo tauri build
cargo run --manifest-path src-tauri/Cargo.toml -- --selftest
```

**The frontend is compiled into the binary.** There is no dev server, so editing `web/` and
re-staging is not enough on its own: without a rebuild the window shows whatever `web/`
looked like the last time cargo ran. Nothing reports it: the staged copy is correct on
disk and every check passes. This re-stages *and* rebuilds, and refuses to launch a binary
that does not contain the frontend staged beside it:

```sh
powershell -ExecutionPolicy Bypass -File scripts/launch.ps1
```

Check the release profile too, which is a different binary and not only a faster one. It is
a windows-subsystem build with nowhere to print, so it needs the console feature; and one
check — that a panicking worker is reported rather than killing the application — is a
compile-time assertion about the profile, so it can only mean anything there:

```sh
cargo run --release --features console --manifest-path src-tauri/Cargo.toml -- --selftest
```

The Python sidecar is optional, and if you build one it must be built as a directory rather
than a single file: a single-file bundle unpacks and spawns the real interpreter as a
*child*, so the core would hold a handle to a process that is not the one doing the work.
The core verifies that the pid it spawned is the pid that answers and refuses anything else.

**No Linux package is configured.** The bundle targets name the Windows installer only.
`cargo tauri dev` and the selftest run fine without one, so nothing on Linux will tell you
it is missing; a `.deb` or an AppImage installs PNGs by exact name, and `cargo tauri icon`
generates that whole set from one square image.

### Rebuilding the archive

`data/` is in this repository, so nothing below is needed to *use* the application. It is
needed to rebuild the archive, or to check it against the thing it was built from.

CCP's Static Data Export is an input rather than a product, so it is not committed. Fetch
the **JSONL** export from <https://developers.eveonline.com/static-data> and put it at
`source/eve-sde-latest-jsonl.zip`, then:

```sh
python3 scripts/build_offline_map.py
python3 scripts/verify_offline_map.py
```

The verifier re-derives every system, link, name, security value and position from the zip
and compares it to the archive, as a **second implementation** of the builder's readers —
a check that calls the code it is checking cannot fail. Five of its nine checks need the
export; without it, `--without-sde` runs the other four and says which did not run and
why. It never reports a check that did not run as one that passed.

## Running it in a browser instead

The viewer also runs as a plain static page, with no Rust and no desktop shell. From the
project root:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

then open <http://127.0.0.1:8765/web/>.

The map, routing, jump planning and the tactical analyser all work there. What the browser
build is **not** is a place to keep a long live history: it is limited to what the browser
allows one site to store, which in normal use is days rather than months, and saving stops
once that is reached. The desktop application is the one to use if you want to keep a
record.
