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

## What it does

- **The whole cluster, on your disk.** All 8,490 systems, 114 regions and 1,184
  constellations, every gate between them, and CCP's own 2D layout. Pull the network
  cable out and it still draws.
- **Routing that knows where people are dying.** Weight the route away from systems with
  recent kills, straight off ESI. Avoid entries expire on their own. Shortest, safest and
  high sec only, with high sec only enforced.
- **Capital jumps worked out before you light the cyno.** Range per hull, fuel for the
  trip, and what the fatigue will cost you getting home again. Every figure out of the
  SDE, with the fatigue maths pinned to CCP's published worked examples.
- **What can reach you, and in what.** Point it at where a hostile force stages and it
  shows what each class of jump-capable hull covers from there. Maximum skills, no
  jammers assumed, an upper bound. Haulers are labelled as haulers.
- **Everything within N jumps, and every way in.** Which gates they can come through, and
  the systems the network cannot route around. Then the brief over them: escape, hunt or
  recon.
- **Live layers, no API key and no account.** Sovereignty, kills and jumps, incursions,
  faction-warfare frontlines, sov timers, and Thera and Turnur straight from EVE-Scout.
  Every one optional and off until you switch it on. The map draws whether they answer or
  not.
- **Every figure says how old it is and where it came from.** When a layer has not
  answered, it says so instead of drawing you a zero.

It runs as a desktop application or as a plain static page in a browser, from the same
files.

## Installing it

1. Download the **`.msi`** from the [releases page][releases] - about 5 MB, 64-bit
   Windows, and the only file there you need. It is attached to the release rather than
   kept among the repository's files, so browsing the file list will not find it: use
   the link, or **Releases** in the sidebar of the repository page.
2. Run it. **Windows will say it protected your PC**, and the install button is behind
   **More info -> Run anyway**. The installer is unsigned - [why][unsigned], below.
3. It installs like anything else and puts **New Eden Atlas** in the Start menu. On
   Windows 10 without the Edge WebView2 runtime the installer fetches it; Windows 11
   already has it.
4. Open it. The whole map is inside the application, so it draws straight away - no
   account, no API key, no launcher, nothing else to install, nothing to configure.

Uninstall from Add or remove programs. That leaves your live data behind on purpose -
"Where your data lives" below says where it is.

[releases]: https://github.com/Sensitive-Electronics/new-eden-atlas/releases
[unsigned]: #why-the-installer-is-not-signed

## Running it in a browser instead

The viewer also runs as a plain static page in any browser, with no installer at all.
Clone or download this repository - the green **Code** button offers a zip - and from its
root:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

then open <http://127.0.0.1:8765/web/>.

The map, routing, jump planning and the tactical analyser all work there. What the browser
build is **not** is a place to keep a long live history: it is limited to what the browser
allows one site to store, which in normal use is days rather than months, and saving stops
once that is reached. The desktop application is the one to use if you want to keep a
record.

## Where your data lives

Two things are stored, and they are kept apart on purpose.

The **archive** is read-only and ships with the application. Rebuilding it cannot touch
anything you have collected.

The **live store** is yours: everything the tool has observed, with the date it was first
seen and the date it was last confirmed. It lives in the application data directory
alongside the settings, and it is written atomically — a crash mid-save cannot corrupt it,
and a file this build cannot read is left alone rather than replaced.

Nothing is sent anywhere. There is no telemetry, no account on my side, and no server.

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

It is a file you edit rather than a setting in the window - the application does not
raise its own cap.

## Signing in

Optional, and only needed for the things that are specific to your characters. Sign-in uses
EVE's own SSO with PKCE; the refresh token goes into your operating system's credential
store (Credential Manager, Keychain, or your desktop keyring) and never into a file the
application writes. You can forget a character at any time, which removes the credential and the cached
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
date.

## Why the installer is not signed

SmartScreen is objecting to an unsigned installer, not to anything in the file: it does
not look inside, it checks for a signature and for whether it has seen the download
before. Signing means buying a certificate from a certificate authority and renewing it
every year, and its only function is to stop Windows saying that. I am not paying a
yearly fee for a rubber stamp on software I give away, so it ships unsigned and you get
the warning. A lot of third-party EVE tools are in the same position.

If you would rather not click through a warning at all, the browser build above needs no
installer at all - the same application, served as a plain page.

## Building it, and checking it

Nothing in this section is needed to *use* the application - the installer carries
everything, including the map. It is here for building it from source, changing it, or
checking that what is in the repository is what it says it is.

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

**A `.deb` is built and tested; the AppImage is not.** The bundle targets name both
beside the Windows installer. The `.deb` was built and inspected on Linux - hicolor icons
at 32, 128, 256 and 256@2 and a desktop entry that files the application under Utility.
The AppImage fetches its tooling over the network at bundle time, so it is left for a run
somebody is watching.


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

---

By **Sensitive Electronics**, author **Shadowglyph**. The software is MIT licensed — see
`LICENSE`, which also states what the licence does *not* cover.

This is an unofficial tool and is not affiliated with or endorsed by CCP Games.

© 2014 CCP hf. All rights reserved. "EVE", "EVE Online", "CCP", and all related logos and images are trademarks or registered trademarks of CCP hf.
