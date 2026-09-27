// The desktop shell for New Eden Atlas.
//
// A window subsystem, not an application. Everything the pilot sees is the
// project's own `web/` directory, rendered from the same bytes the browser
// build serves; this process opens a window onto it and supervises whatever
// has to keep running outside a webview.
//
// Three things this deliberately does not have:
//
//   **No file read the webview can name.** The webview renders player-supplied text -
//   alliance names, tickers, killmail entities - and handing that surface an arbitrary
//   file read puts untrusted input one bug away from the filesystem. Every path here is
//   fixed at the application data directory, so there is nothing to traverse.
//
//   **No command nothing calls.** A registered handler is surface whether or not
//   anything reaches it, so a command arrives with its caller.
//
//   **No shell-drawn panel over the map.** The atlas renders here unmodified, and a
//   panel stapled on by the shell is what would make that untrue.

#![cfg_attr(
    all(not(debug_assertions), not(feature = "console")),
    windows_subsystem = "windows"
)]

mod sso;

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Manager, State};

// --- the sidecar, and who owns it -------------------------------------------
//
// PyInstaller's `--onefile` is a bootstrapper: it unpacks to a temp directory
// and spawns the real interpreter as a *child*, so the core ends up holding a
// handle to a process that is not the one doing the work. Killing it orphans
// the worker, and the core reports a clean shutdown either way. That was
// measured in the spike, not inferred - pid 43460 killed, pid 33304 still
// alive - and an orphaned sidecar holding a database or a refresh token is the
// failure that makes people distrust a desktop application.
//
// `--onedir` fixes it for 12 MB: the executable is the process, and the pid
// that answers is the pid that dies. But a packaging change could reintroduce
// the bug silently, so the rule is not left as a convention. The sidecar
// reports its own pid in its handshake and the core refuses a process whose pid
// is not the one it spawned. A supervisor that cannot prove it is supervising
// the right process is not supervising anything.

struct SidecarProcess {
    child: Child,
    // An `Option`, so the reader can be handed to a thread and not replaced with
    // anything. Substituting a decoy child's stdout to have a value of the right type
    // leaves that child dropped without being waited on - a zombie on Unix and a leaked
    // handle on Windows, once per handshake, in the file whose thesis is that the core
    // knows which processes it owns.
    //
    // `None` means "away on a thread", which is a state the type expresses rather than
    // one that needs a decoy to hide.
    reader: Option<BufReader<std::process::ChildStdout>>,
    pid: u32,
}

// **The pid is kept beside the lock, not only inside it.**
//
// Reading it required taking the mutex that `advisor_request` holds for a whole
// exchange, so the one caller that must never wait - the window's close handler -
// had no way to name the process it has to kill. An `AtomicU32` costs nothing and
// is written in exactly two places: set at spawn, cleared at stop. Zero means
// none, which no real pid is.
#[derive(Default)]
struct Sidecar(Mutex<Option<SidecarProcess>>, std::sync::atomic::AtomicU32);

struct Started(Instant);

// Whether the sidecar is up, and why not when it is not.
//
// Never an error that stops the window. The first law of this project is that
// the core works with zero connectivity and zero optional components; a shell
// that refused to draw the map because a helper process was missing would break
// that law at the packaging layer, which is exactly where nobody would look.
#[derive(Default)]
struct SidecarReport(Mutex<String>);

fn spawn_sidecar(program: &PathBuf, argument: Option<&PathBuf>) -> Result<SidecarProcess, String> {
    let mut command = Command::new(program);
    if let Some(script) = argument {
        command.arg(script);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{}: {e}", program.display()))?;

    let pid = child.id();
    let stdout = child.stdout.take().ok_or("the sidecar has no stdout")?;
    // Kept, not made fresh per exchange. A BufReader fills from the pipe and
    // may pull several lines in one read; dropping it after one line throws
    // away everything else it took, and the next read starts after the
    // discarded bytes. With one short line at a time it happens to work, which
    // is the worst way for this to behave - it survives every test and corrupts
    // the first chatty protocol built on it.
    let mut process = SidecarProcess {
        child,
        reader: Some(BufReader::new(stdout)),
        pid,
    };

    match handshake(&mut process) {
        Ok(answered) if answered == pid => Ok(process),
        Ok(answered) => {
            let _ = process.child.kill();
            let _ = process.child.wait();
            Err(format!(
                "spawned pid {pid} but pid {answered} answered - the process this core holds is not the process doing the work, so killing it would orphan the worker. That is what PyInstaller --onefile does; the sidecar must be built --onedir."
            ))
        }
        Err(why) => {
            let _ = process.child.kill();
            let _ = process.child.wait();
            Err(why)
        }
    }
}

// How long the core will wait for a sidecar to say hello.
//
// A sidecar that accepts the greeting and never answers would otherwise block inside
// Tauri's setup hook, which runs after the window is created and before the event loop
// starts: an application that hangs at launch with no error and an unpumped window,
// with `stop_sidecar` never running because it is wired to window destruction, so the
// child is orphaned too.
//
// Absent is handled and crashed is handled. Wedged is the third state, and the one that
// takes the map down with an optional component.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

// How long the advisor may take. A cold local model's first call is frequently ten
// seconds, measured rather than guessed; thirty is the *transport's* ceiling and not the
// model's budget. The budget that governs discarding a slow answer is a separate number
// and belongs where the answer is displayed, because the brief is already on screen
// either way.
const ADVISOR_TIMEOUT: Duration = Duration::from_secs(30);

// A pipe has no read timeout - that is a socket facility - so the blocking read
// happens on a thread this one is willing to abandon. On timeout the child is
// killed, which closes the pipe, which lets the abandoned thread finish.
//
// **Every exchange goes through here.** A read with no timeout is invisible while the
// only caller is a selftest pinging a process it just spawned, and is a window that
// never finishes and never says why once a person is waiting in front of it.
// How many lines the core will discard while looking for the answer to the
// question it asked.
//
// Zero would be stricter and wrong: a dependency inside the sidecar printing a
// banner, a deprecation warning or a progress bar to stdout is ordinary, and
// stderr is already `Stdio::null()` because stdout is the protocol. A small
// budget absorbs that; an unbounded one would let a chattering child hold this
// thread until the deadline on every request.
const DISCARD_LIMIT: usize = 8;

// How long one line from the sidecar may be.
//
// **`read_line` has no length limit**, and this is the pipe rather than the
// socket. A sidecar that writes to stdout and never emits a newline makes the
// core allocate until the timeout fires: measured at 49 GB of private bytes
// across one 5s handshake plus one 30s advisor read, feeding 1 MiB chunks. A
// Rust allocation failure calls `handle_alloc_error`, which **aborts whatever
// the panic strategy is** - so the window vanishes, and with it the map, the
// brief and the planner. An optional component killing the half that is not
// optional is this project's first law broken from the inside.
//
// `sso.rs` caps the structurally identical read at `MAX_REQUEST_LINE`, and its
// comment gives exactly this reasoning. The cap was put on the socket and not
// on the pipe.
//
// Not only an adversarial case. `DISCARD_LIMIT` above names "a banner, a
// deprecation warning or a progress bar" on stdout as ordinary, and a progress
// bar is precisely the thing that emits carriage returns and no newline for its
// whole lifetime.
//
// A megabyte is far past anything this protocol carries: what comes back names
// operations, one relation and one sentence. The large direction is the
// projection going out, which is written rather than read and is bounded before
// it arrives here.
const MAX_SIDECAR_LINE: u64 = 1024 * 1024;

fn write_line(process: &mut SidecarProcess, line: &str) -> Result<(), String> {
    let stdin = process.child.stdin.as_mut().ok_or("the sidecar has no stdin")?;
    writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

fn read_within(process: &mut SidecarProcess, timeout: Duration) -> Result<String, String> {
    let mut reader = process
        .reader
        .take()
        .ok_or("the sidecar's output is already being read")?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut held = String::new();
        // Bounded by `take`, which `BufRead` passes through, so the allocation
        // stops at the cap rather than at the timeout. The borrow ends before
        // the reader is handed back.
        let read = {
            let mut limited = (&mut reader).take(MAX_SIDECAR_LINE);
            limited.read_line(&mut held)
        };
        // Filled to the cap with no newline means the rest of the line is still
        // in the pipe. That is a protocol failure rather than a long answer:
        // truncating it here would leave the remainder to be read as the next
        // reply, which is the permanent desync `answer_to` exists to prevent.
        // `advisor_request` kills the child on a failed exchange, so the
        // remainder dies with it.
        let overlong = read.as_ref().is_ok_and(|count| {
            *count as u64 >= MAX_SIDECAR_LINE && !held.ends_with('\n')
        });
        let outcome = if overlong {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("the sidecar sent more than {MAX_SIDECAR_LINE} bytes without a newline"),
            ))
        } else {
            read.map(|count| (count, held))
        };
        let _ = sender.send((outcome, reader));
    });

    match receiver.recv_timeout(timeout) {
        Ok((Ok((0, _)), _)) => Err("the sidecar closed its output".into()),
        Ok((Ok((_, held)), reader)) => {
            process.reader = Some(reader);
            Ok(held.trim_end().to_string())
        }
        Ok((Err(error), _)) => Err(error.to_string()),
        Err(_) => Err(format!(
            "the sidecar did not answer within {}s. It is optional, so the map draws without it.",
            timeout.as_secs()
        )),
    }
}

fn exchange_within(
    process: &mut SidecarProcess,
    line: &str,
    timeout: Duration,
) -> Result<String, String> {
    // **The reader is checked before the line is written**, not after. Written
    // first, a missing reader means the request is already down the pipe when
    // this returns an error - and the next exchange reads that answer as its
    // own.
    if process.reader.is_none() {
        return Err("the sidecar's output is already being read".into());
    }
    write_line(process, line)?;
    read_within(process, timeout)
}

// **The same discard budget an answer gets, and a pid that has to fit.**
//
// `DISCARD_LIMIT` exists because "a dependency inside the sidecar printing a
// banner, a deprecation warning or a progress bar to stdout is ordinary". The
// handshake read exactly one line, so one banner line at startup made it fail to
// parse and the process be refused entirely - the ordinary case the budget was
// written for, in the one exchange that did not have it.
//
// And the pid was read as a `u64` and narrowed with `as u32`, which truncates. A
// sidecar answering `os.getpid() + 2**32` truncates to the real pid and is
// accepted, so the guard that exists to prove "the pid I spawned is the pid that
// answers" could be satisfied by a process that is not it. `try_from` refuses
// instead: a number that does not fit a pid is not a pid, and this is the check
// the `--onefile` case depends on.
fn handshake(process: &mut SidecarProcess) -> Result<u32, String> {
    // Written once and then read repeatedly, which is `answer_to`'s shape and for
    // its reasons: the reader is checked before the line goes down the pipe, so a
    // failure here cannot leave the request half-sent.
    //
    // The first version of this used `last.is_empty()` to mean "first iteration",
    // which is a flag pretending to be a value: an empty first read - which is what
    // EOF looks like - sent a second `hello` down a pipe that had already closed.
    if process.reader.is_none() {
        return Err("the sidecar's output is already being read".into());
    }
    write_line(process, r#"{"op":"hello"}"#)?;
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    let mut last = String::new();
    for _ in 0..=DISCARD_LIMIT {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(format!("the sidecar did not answer the handshake within {}s", HANDSHAKE_TIMEOUT.as_secs()));
        }
        last = read_within(process, left)?;
        // A banner, not an answer. Discarded and counted, exactly as `answer_to` does.
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&last) else {
            continue;
        };
        let Some(reported) = parsed.get("pid").and_then(serde_json::Value::as_u64) else {
            continue;
        };
        return u32::try_from(reported).map_err(|_| format!("the sidecar reported a pid of {reported}, which is not a process id"));
    }
    Err(format!("the sidecar did not report its pid: {last}"))
}

fn exchange(process: &mut SidecarProcess, line: &str) -> Result<String, String> {
    exchange_within(process, line, ADVISOR_TIMEOUT)
}


// The body both callers share. Separate because the close handler must not block
// to reach it, and a second copy of "kill then wait" is how one of them ends up
// forgetting the wait.
fn stop_sidecar_locked(state: &Sidecar, slot: &mut Option<SidecarProcess>) {
    if let Some(mut running) = slot.take() {
        let _ = running.child.kill();
        let _ = running.child.wait();
    }
    state.1.store(0, std::sync::atomic::Ordering::SeqCst);
}

// Tear the sidecar down for a window that is closing.
//
    // **Never block the main thread here.**
    //
    // `stop_sidecar` takes the same mutex `advisor_request` holds
    // for a whole exchange, and this runs on the main thread. So
    // closing the window while a cold model was thinking froze the
    // close button for up to thirty seconds - which is the exact
    // failure `advisor_request`'s own header says its `async`
    // attribute exists to prevent. The block did not go away, it
    // moved to teardown.
    //
    // `try_lock` first, because the common case is no exchange in
    // flight and that path is unchanged. When it *is* held, the
    // child is killed by the pid this core recorded at spawn -
    // which is the pid `handshake` proved answers, so it is the
    // right process by the same argument the supervisor rests on -
    // and the exchange then fails and unwinds on its own thread.
    //
    // Killing without the lock is safe in the one direction that
    // matters: an orphaned sidecar outliving the window is the
    // failure this file's header exists to prevent, and a killed
    // child that a thread is still reading from returns an error
    // rather than hanging.
    //
    // **Poison is recovered, not skipped.** The release profile
    // unwinds deliberately, so that a panicking worker becomes a
    // sentence - which makes poisoning reachable. Treating it as
    // "nothing to do" leaves one panic anywhere in the application
    // with the child alive, never killed, `Child` not killing on
    // drop, and the sidecar outliving the window while reporting as
    // stopped.
    // The data behind the lock is an `Option<SidecarProcess>` rather
    // than an invariant a panic could have left half-updated, so
    // taking it anyway is safe and is the only arm that still kills.
//
// A function rather than a closure body so the selftest can hold the lock and time
// this. A thirty-second wait is only observable from outside.
fn shutdown_sidecar(state: &Sidecar) {
    match state.0.try_lock() {
        Ok(mut held) => stop_sidecar_locked(state, &mut held),
        Err(std::sync::TryLockError::Poisoned(poisoned)) => {
            stop_sidecar_locked(state, &mut poisoned.into_inner());
        }
        Err(std::sync::TryLockError::WouldBlock) => kill_recorded_pid(state),
    }
}

// Kill the recorded pid without taking the lock.
//
// Used only when an exchange is in flight and the window is closing, where the
// alternative is waiting up to thirty seconds on the main thread. The pid is the
// one `handshake` proved answers, so it is the right process by the same argument
// the supervisor rests on - and an orphaned sidecar outliving the window is the
// failure this file's header exists to prevent, which makes acting the safer
// direction than waiting.
//
// Through the platform's own killer rather than unsafe FFI: it needs no new
// dependency, and the child it names is one this process spawned. Spawned and not
// waited on deliberately - waiting is the thing this path exists to avoid.
fn kill_recorded_pid(state: &Sidecar) {
    let pid = state.1.swap(0, std::sync::atomic::Ordering::SeqCst);
    if pid == 0 {
        return;
    }
    // **Not a bare name on Windows.** `Command::new("taskkill")` is the very hazard
    // `resolve_on_path` exists to close, reintroduced two functions away - and this
    // one runs while the window is closing, which is not a moment anybody watches.
    // %SystemRoot% with a fallback, because the drive is not always C:, exactly as
    // `sso::browser_command` does it for `rundll32.exe`.
    //
    // Unix needs no such care and gets none: Rust does not put the executable's
    // directory or the current directory on PATH there, so a bare `kill` is the
    // ordinary model rather than a hole. That is the same distinction `sso.rs`
    // draws, and copying its shape keeps one argument in one place.
    let mut killer = if cfg!(windows) {
        let root = std::env::var("SystemRoot")
            .or_else(|_| std::env::var("windir"))
            .unwrap_or_else(|_| r"C:\Windows".to_string());
        let mut command = Command::new(format!(r"{root}\System32\taskkill.exe"));
        command.args(["/PID", &pid.to_string(), "/F", "/T"]);
        command
    } else {
        let mut command = Command::new("kill");
        command.args(["-9", &pid.to_string()]);
        command
    };
    let _ = killer.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}

// Where the sidecar is, in a packaged build and in a checkout.
//
// Packaged, it sits beside the executable as a --onedir directory. In a
// checkout there is no packaged sidecar at all, so the source is run through
// whichever interpreter is on the path. Neither is required: absent means the
// shell runs without one and says so.
// The first file named `name` on PATH, as an absolute path.
//
// Deliberately not `Command::new(name)`: see the comment where this is used. On
// Windows the executable extensions are tried in the order `PATHEXT` gives,
// falling back to the one that matters here.
fn resolve_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let suffixes: Vec<String> = if cfg!(windows) {
        let mut found: Vec<String> = std::env::var("PATHEXT")
            .unwrap_or_default()
            .split(';')
            .filter(|part| !part.is_empty())
            .map(|part| part.to_ascii_lowercase())
            .collect();
        if found.is_empty() {
            found.push(".exe".to_string());
        }
        found
    } else {
        vec![String::new()]
    };
    for directory in std::env::split_paths(&path) {
        if directory.as_os_str().is_empty() {
            continue;
        }
        // Only the suffixes, which is `""` on Unix and `PATHEXT` on Windows. An
        // extensionless candidate was tried first and that is wrong on Windows: a
        // file named `python` with no extension is not executable there, so
        // returning it hands `CreateProcess` something it cannot run - and a real
        // `python.exe` two directories later never gets looked at.
        for suffix in &suffixes {
            let candidate = directory.join(format!("{name}{suffix}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn locate_sidecar(app: &tauri::AppHandle) -> Option<(PathBuf, Option<PathBuf>)> {
    if let Ok(resources) = app.path().resource_dir() {
        let packaged = resources
            .join("sidecar")
            .join("atlas-sidecar")
            .join(if cfg!(windows) {
                "atlas-sidecar.exe"
            } else {
                "atlas-sidecar"
            });
        if packaged.is_file() {
            return Some((packaged, None));
        }
    }
    // The checkout fallback, and it is a DEVELOPMENT-ONLY branch on purpose.
    //
    // It runs `sidecar/atlas_sidecar.py` relative to the process's current
    // directory. In a release build that would mean: anyone who can write into
    // whatever directory the application happens to start in gets arbitrary
    // Python executed as the user at every launch. A shortcut with "Start in"
    // pointing at Downloads, a network share, a USB drive - none of that should
    // be a code-execution path, and until something is actually bundled this
    // was the *only* branch that ever fired, because nothing packages a sidecar
    // yet and `resource_dir()` therefore never contains one.
    //
    // So a release build runs no sidecar at all rather than one it found lying
    // about. That is the correct behaviour for an optional component: absent is
    // a supported state, and it is far better than trusted-because-nearby.
    //
    // When the sidecar is genuinely shipped it goes in `bundle.resources` and is
    // found by the branch above, whose location the installer controls.
    #[cfg(debug_assertions)]
    {
        let source = std::env::current_dir()
            .ok()?
            .join("sidecar")
            .join("atlas_sidecar.py");
        if source.is_file() {
            // **Resolved on PATH, never handed over as a bare name.**
            //
            // `Command::new("python")` becomes `CreateProcess` with a bare name,
            // and Windows searches *the running executable's own directory* before
            // PATH. Measured with a planted `python.exe`: it wins. `sso.rs` spends
            // twenty lines closing this exact hazard for `rundll32.exe` and pins it
            // to a fixed System32 path; the branch one function over guarded the
            // script path and not the interpreter name.
            //
            // There is no fixed path for an interpreter, so PATH is walked here and
            // the first real file is used. The executable's directory and the
            // current directory are not consulted unless the person running this
            // has genuinely put them on PATH, which is their own decision rather
            // than an accident of process creation.
            let interpreter = if cfg!(windows) { "python" } else { "python3" };
            let resolved = match resolve_on_path(interpreter) {
                Some(found) => found,
                // Windows: a bare name is searched against this executable's own
                // directory before PATH, so there is nothing safe to fall back to.
                // No interpreter means no sidecar, which is a supported state.
                #[cfg(windows)]
                None => return None,
                // Unix: a bare name is the ordinary model, per the distinction
                // `sso.rs` draws - Rust adds neither the executable's directory nor
                // the current directory to PATH. Falling back keeps the informative
                // "python3: not found" from the spawn rather than reporting that no
                // sidecar is present when the script plainly is.
                #[cfg(not(windows))]
                None => PathBuf::from(interpreter),
            };
            return Some((resolved, Some(source)));
        }
    }
    None
}

// --- what the webview may ask -------------------------------------------------
//
// Three commands: `shell_status`, which only reads, and the two store commands.
//
// **A stale security comment is worse than none**, because it is the thing a reviewer
// trusts instead of looking. So this says what the containment rests on rather than
// what the surface used to be, and `tests/contract.test.mjs` holds the handler list
// against `CORE_COMMANDS` and `ADVISOR_COMMANDS` so the two cannot drift apart
// silently.
//
// The webview never names a path. `store_path` is fixed at
// `app_data_dir()/live-store.json`, so there is no traversal and no choice of target:
// the webview can ask for *the* store to be read or written and nothing else. It
// starts no processes and holds no token.
// --- the advisor hop ---------------------------------------------------------
//
// **The core relays and does not read.** It holds the refresh tokens, which
// makes it the most privileged process here, and the reason it must not proxy
// the model at all is that untrusted text does not belong in the most
// privileged place. The projection carries no player-written text by
// construction; the pilot's question is the first free text ever to cross this
// process, and it crosses opaquely: nothing below logs it, stores it, inspects
// it or branches on it. In particular it never reaches `SidecarReport`, which
// `shell_status` hands back to the webview.
//
// `serde_json::Value` in and out is the identity transform - the envelope is
// already JSON when the webview hands it over, and re-serialising it is not
// inspection. JSON escapes newlines, so one envelope is always one line and the
// NDJSON framing cannot be broken by anything inside the payload.

// One boolean. Not the pid, not the supervisor's note - `shell_status` reports
// both and is deliberately unreached from the page for exactly that reason.
// "Is there an advisor" is a question the window needs answered to decide
// whether to offer an opener at all; everything else about the process is the
// core's business.
// **A bare `bool`, not a struct.**
//
// `payloadOf` in `app.js` wraps whatever a typed command returns into the one
// field `CORE_REPLY_FIELD` declares for it - here, `running`. A struct
// serialising to `{"running":true}` therefore arrived as
// `{"running":{"running":true}}`, `replyFault` refused it as "payload.running
// is object, expected boolean", `callCore` threw, and
// `refreshAdvisorAvailability` swallowed it to false.
//
// The effect was that the opener could never appear in a desktop build: the
// entire window was unreachable, silently, with every test passing. The other
// six commands all return the bare value for exactly this reason.
#[tauri::command]
fn advisor_status(sidecar: State<'_, Sidecar>) -> bool {
    // **`try_lock`, because a blocking one answers the wrong question slowly.**
    //
    // `advisor_request` holds this lock for the length of an exchange, up to
    // `ADVISOR_TIMEOUT`. A blocking read here would queue behind it and answer
    // "is there an advisor" half a minute after it was asked - and the caller
    // is a window deciding whether to draw an opener, which is the sort of
    // thing that must never wait on an optional process.
    //
    // A held lock is itself the answer. Nothing takes it except an exchange
    // with a live sidecar, so contended means running.
    //
    // Poison is recovered rather than skipped, the same as `stop_sidecar`: the
    // data behind it is an Option, not an invariant a panic could have left
    // half-updated, and reporting "no advisor" because something unrelated
    // panicked would be a wrong answer rather than a missing one.
    let mut slot = match sidecar.0.try_lock() {
        Ok(slot) => slot,
        // A held lock is itself the answer: nothing takes it except an exchange
        // with a live sidecar, so contended means running.
        Err(std::sync::TryLockError::WouldBlock) => return true,
        Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
    };
    // **Reaped before it is answered.** `is_some()` alone says a process was
    // *spawned*, not that it is alive - a child that crashed, was OOM-killed or
    // was killed from outside leaves `Some(..)` behind and the core would keep
    // reporting a dead pid as running. That is the wrong direction: the window
    // would offer an opener for a process that is gone.
    let exited = matches!(slot.as_mut().map(|process| process.child.try_wait()), Some(Ok(Some(_))));
    if exited {
        slot.take();
    }
    slot.is_some()
}

// **`async`, so the blocking read leaves the event-loop thread.**
//
// A synchronous `#[tauri::command]` runs on the main thread - this file already
// records that distinction where `token_forget` and `token_begin` differ - and
// this one blocks for up to `ADVISOR_TIMEOUT` holding a lock. That froze the
// map, the brief, the planner and the window's own close button for thirty
// seconds while a cold model thought, which is an optional layer becoming a
// dependency: the first law this project has.
//
// `#[tauri::command(async)]` keeps the body synchronous and moves it off that
// thread, which is the smallest change that makes the law hold.
#[tauri::command(async)]
fn advisor_request(
    sidecar: State<'_, Sidecar>,
    envelope: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // Refused before it is written, because a non-object crashes the far end.
    // The sidecar calls `.get` on what it parses; `null`, `5` or `[]` raise
    // there and end the process, and nothing respawns it - so one malformed
    // call from the webview would remove the advisor for the rest of the
    // session. Checking that this is an object is not reading it.
    if !envelope.is_object() {
        return Err("an advisor request is an envelope, which is an object".into());
    }
    // **The id, read by the core, which is not reading the question.**
    //
    // Correlation is the core's own business - it is the field that says which
    // request an answer belongs to, and matching on it is what a supervisor
    // does. The payload beside it is still relayed without being looked at.
    let asked = envelope
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let line = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;
    let mut slot = match sidecar.0.lock() {
        Ok(held) => held,
        Err(poisoned) => poisoned.into_inner(),
    };
    let process = slot
        .as_mut()
        .ok_or("the advisor is not running in this build")?;
    match answer_to(process, &line, &asked) {
        Ok(answer) => Ok(answer),
        Err(error) => {
            // **A failed exchange kills the process rather than leaving it.**
            //
            // On timeout the read is abandoned on its thread and the reply may
            // still arrive. If the process lived, that late answer would be
            // read as the answer to the *next* question - a reply about one
            // brief handed back for another, with a correct-looking envelope
            // and an id from the wrong turn. Every later exchange would be off
            // by one. Killing it closes the pipe, ends the abandoned thread,
            // and makes the next request honestly report no advisor.
            if let Some(mut dead) = slot.take() {
                let _ = dead.child.kill();
                let _ = dead.child.wait();
            }
            Err(error)
        }
    }
}

// Write once, then read until the line that answers **this** question.
//
// A successful read of the *wrong* line was the hole. The failure arm below
// kills the child precisely so a late answer cannot be read as the next
// question's - but a stray line that parses as JSON came back through the
// success arm instead, with an id from nowhere. `consider` correctly refuses
// it, and then refuses every later one too, because the pipe stays one line
// behind for the rest of the session with the process alive and reporting
// healthy. There is no recovery short of restarting the application.
//
// One `print()` added anywhere inside the sidecar reaches that state.
fn answer_to(
    process: &mut SidecarProcess,
    line: &str,
    asked: &str,
) -> Result<serde_json::Value, String> {
    if process.reader.is_none() {
        return Err("the sidecar's output is already being read".into());
    }
    write_line(process, line)?;
    let deadline = Instant::now() + ADVISOR_TIMEOUT;
    for _ in 0..=DISCARD_LIMIT {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(format!(
                "the sidecar did not answer within {}s. It is optional, so the map draws without it.",
                ADVISOR_TIMEOUT.as_secs()
            ));
        }
        let held = read_within(process, left)?;
        let parsed: serde_json::Value = match serde_json::from_str(&held) {
            Ok(parsed) => parsed,
            // Not an answer. Discarded rather than returned, and counted.
            Err(_) => continue,
        };
        let carried = parsed.get("id").and_then(serde_json::Value::as_str).unwrap_or_default();
        if asked.is_empty() || carried == asked {
            return Ok(parsed);
        }
    }
    Err("the sidecar is answering a different question; its output is out of step".into())
}

#[derive(Serialize)]
struct ShellStatus {
    shell: &'static str,
    version: &'static str,
    startup_ms: u128,
    sidecar_running: bool,
    sidecar_pid: Option<u32>,
    sidecar_note: String,
}

#[tauri::command]
fn shell_status(
    started: State<'_, Started>,
    sidecar: State<'_, Sidecar>,
    report: State<'_, SidecarReport>,
) -> ShellStatus {
    let running = sidecar
        .0
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|process| process.pid));
    ShellStatus {
        shell: "tauri",
        version: env!("CARGO_PKG_VERSION"),
        startup_ms: started.0.elapsed().as_millis(),
        sidecar_running: running.is_some(),
        sidecar_pid: running,
        sidecar_note: report
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone(),
    }
}

// --- the live store, which the core keeps and the webview owns -------------------
//
// Two commands and no third. The sighting store's logic stays in JavaScript
// where its assertions are; what crosses this boundary is the serialised store,
// never a question about it. There is deliberately no `sightings.query`:
// answering one would mean a second implementation of tested code, in a second
// language, that could disagree with the first.
//
// What this buys is the removal of a hard limit rather than a convenience. A
// browser's local storage holds a few megabytes - about twenty-five thousand
// observations - and a thirty-character vault passes that inside a year, with a
// busy one passing it five times over. The tier that can have thirty characters
// is this one, and this one has no quota.

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no application data directory: {e}"))?;
    std::fs::create_dir_all(&directory).map_err(|e| format!("{}: {e}", directory.display()))?;
    Ok(directory.join("live-store.json"))
}

// Three outcomes, and collapsing the first two is the failure this guards.
//
//   Ok(None)    there is no file, which is a first run and means an empty store
//   Err(..)     there is a file and it cannot be read, which means leave it
//               alone and refuse to write over it
//   Ok(Some(_)) it read
//
// A corrupt file reported as "nothing here" becomes an empty store that looks
// like a first run, and the next write replaces a damaged history with no
// history at all. The distinction costs one enum and saves the only copy.
#[tauri::command]
fn sightings_load(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    load_store(&store_path(&app)?)
}

// Split from the command so it can be checked without a window. The command is
// Tauri plumbing; this is the policy, and the policy is the part that can be
// wrong in a way nobody notices until the only copy is gone.
fn load_store(path: &std::path::Path) -> Result<Option<serde_json::Value>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    // An empty file is damage, not absence: something truncated it. Saying
    // "first run" here would hand back an empty store and invite the write that
    // makes the loss permanent.
    if text.trim().is_empty() {
        return Err(format!("{} is empty", path.display()));
    }
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    // A store is an object. `4`, `"x"` and `[]` are valid JSON and are not a
    // store, and handing one back reaches the viewer as a store with no
    // sightings - which degrades to empty and is then written over, destroying
    // whatever the file really held. Damage, like the other two.
    if !value.is_object() {
        return Err(format!(
            "{} holds {} rather than a store",
            path.display(),
            match value {
                serde_json::Value::Array(_) => "a list",
                serde_json::Value::Null => "null",
                serde_json::Value::Number(_) => "a number",
                serde_json::Value::String(_) => "a string",
                _ => "a value",
            }
        ));
    }
    Ok(Some(value))
}

// Written to a neighbour, flushed, then renamed over the target.
//
// This is the whole of "a crashed core does not wipe history", and the naive
// implementation is how history gets wiped: opening the real file for writing
// truncates it first, so a crash - or a full disk - half way through leaves a
// file that is neither the old store nor the new one. The rename is atomic on
// every platform this ships to, so the target is either entirely the previous
// save or entirely this one, and never a prefix of either.
#[tauri::command]
fn sightings_save(app: tauri::AppHandle, store: serde_json::Value) -> Result<u64, String> {
    save_store(&store_path(&app)?, &store)
}

// What this tier will write, and the honest limit of the bound.
//
// The core exists because local storage has a hard quota of a few megabytes and
// a pilot's history outgrows it. "No quota" was taken literally: this command
// accepted any value the page sent and wrote it, so anything running in the
// webview could fill the volume.
//
// The bound is on what reaches the disk, not on what reaches memory. By the
// time this runs, serde has already materialised the value - a cap here cannot
// unspend that, and pretending otherwise would be the more dangerous kind of
// wrong. What it does prevent is a runaway store consuming the volume the
// operating system and the archive also live on.
//
// Generous on purpose: a thirty-character store serialises to about 25 MB, so
// this is an order of magnitude above any real one. A store that reaches it is
// not a long history, it is a bug or an attack, and either deserves a refusal
// that names itself rather than a disk with no room left on it.
const MAX_STORE_BYTES: usize = 256 * 1024 * 1024;

// **The cap is adjustable, and the webview cannot adjust it.**
//
// Most pilots will never approach 256 MB. A few - a long-running spy network,
// years of sovereignty history - genuinely will, and telling them to rebuild
// the application from source is not an instruction anybody can act on.
//
// So it reads an optional `limits.json` from the application data directory,
// beside `sso.json` and the store itself:
//
//     { "live_store_mb": 1024 }
//
// That directory is chosen by the operating system and written by the person
// who owns the machine. **The page cannot reach it**: the webview names no
// paths, there is no command that writes an arbitrary file, and nothing here
// takes a limit as an argument. A cap the thing being capped can raise is not a
// cap, so this is a file the person who owns the machine edits rather than a setting in the
// interface.
//
// Clamped at both ends, because "adjustable" must not become either "off" or
// "fill the volume". A missing file, a missing field, a zero, a string or
// anything unparseable falls back to the default rather than to no limit; and
// the ceiling is there because a store past four gigabytes is not a long
// history, it is a bug, and the refusal that names itself is still the kinder
// outcome than a disk with no room left on it.
const MIN_STORE_MB: usize = 16;
const MAX_STORE_MB: usize = 4096;
const LIMITS_FILE: &str = "limits.json";

fn store_limit_bytes(directory: &std::path::Path) -> usize {
    let chosen = std::fs::read_to_string(directory.join(LIMITS_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|parsed| {
            parsed
                .get("live_store_mb")
                .and_then(serde_json::Value::as_u64)
                .map(|mb| (mb as usize).clamp(MIN_STORE_MB, MAX_STORE_MB))
        })
        .unwrap_or(MAX_STORE_BYTES / (1024 * 1024));
    chosen * 1024 * 1024
}

// Separated so the limit can be checked without allocating it. A guard tested
// only by building the thing it guards against is a guard nobody tests.
fn store_size_fault(len: usize, limit: usize) -> Option<String> {
    if len <= limit {
        return None;
    }
    // **The instruction travels with the refusal.** Whoever is reading this
    // sentence is, by definition, the one person who needs to know the cap can
    // be raised - so it says how here, rather than only in a README they have no
    // reason to be looking at. `concat!` rather than a split literal, per the
    // project's convention, and a raw string for the part carrying quotes.
    // The braces are doubled because `format!` reads them.
    Some(format!(
        concat!(
            "the live store would be {} MB, past the {} MB this will write - nothing was saved and the file on disk is unchanged. ",
            r#"To allow more, put {{"live_store_mb": {}}} in limits.json in the same folder as this store, then restart."#
        ),
        len / (1024 * 1024),
        limit / (1024 * 1024),
        ((len / (1024 * 1024)) * 2).clamp(MIN_STORE_MB, MAX_STORE_MB)
    ))
}

// One save at a time in this process, and a temp name no other process can
// collide with.
//
// The rename makes a save atomic against a *crash*. It does nothing about a
// second save, and a fixed temp name makes that failure vicious rather than
// merely wrong. Two threads both `File::create` the same
// `live-store.json.writing`: the second truncates the first's file, finishes,
// and renames it into place - at which point the first thread's still-open
// handle is pointing at `live-store.json` itself, and it writes its payload
// straight into the live store at offset zero, non-atomically, with no
// possibility of rollback. Then its rename fails and it reports an error, while
// the save that returned `Ok` is the one whose bytes were overwritten.
// Reproduced five times out of five.
//
// The viewer has five independent ESI layers that each save when they finish,
// so two saves in flight is ordinary rather than exotic.
//
// The lock serialises this process. The unique name covers what a lock cannot:
// a second copy of the application running against the same data directory, and
// a stale `.writing` file left by a process that was killed.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

fn save_store(path: &std::path::Path, store: &serde_json::Value) -> Result<u64, String> {
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let temporary = path.with_extension(format!(
        "json.writing.{}.{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let text = serde_json::to_string(store).map_err(|e| e.to_string())?;
    // Read from the directory being written to, so an override lives beside the
    // store it governs and applies from the next save rather than the next
    // build.
    let limit = store_limit_bytes(path.parent().unwrap_or(std::path::Path::new(".")));
    if let Some(fault) = store_size_fault(text.len(), limit) {
        return Err(fault);
    }

    // Every failure after the file exists takes it away again.
    //
    // Cleaning up only on a failed rename leaves the partial scratch file on disk
    // whenever `write_all` fails part way through, which a full volume does routinely
    // - and because the name carries pid *and* nanos so that no two writers collide,
    // the next attempt makes a second one and nothing removes either. The directory
    // then accumulates multi-megabyte files with names a pilot has no reason to
    // recognise, in the tier chosen because it has no quota to stop it.
    let written = (|| -> Result<(), String> {
        let mut file = std::fs::File::create(&temporary)
            .map_err(|e| format!("{}: {e}", temporary.display()))?;
        file.write_all(text.as_bytes())
            .map_err(|e| format!("{}: {e}", temporary.display()))?;
        // Without this the rename can land before the bytes do, and a power
        // loss leaves an intact name pointing at an incomplete file - which is
        // the failure the rename was supposed to prevent, arriving anyway.
        file.sync_all()
            .map_err(|e| format!("{}: {e}", temporary.display()))?;
        Ok(())
    })();
    if let Err(why) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(why);
    }

    std::fs::rename(&temporary, path).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        format!("{}: {e}", path.display())
    })?;

    // The rename itself is not durable on POSIX until the directory holding it
    // is synced. `sync_all` above makes the *bytes* durable; without this the
    // name can still be lost to a power cut, leaving the previous store - whole,
    // and older than the pilot believes. Not corruption, but the comment above
    // claimed a durability it did not provide on that platform.
    //
    // Unix only: Windows does not allow opening a directory as a file, and
    // NTFS's rename does not need it. Best effort - a failure here means the
    // save succeeded and may not survive a power cut, which is not worth
    // refusing a save that already landed.
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        let _ = std::fs::File::open(parent).and_then(|dir| dir.sync_all());
    }

    Ok(text.len() as u64)
}

// --- the vault --------------------------------------------------------------------
//
// Three commands, and none of them hands the webview a token. `token_begin`
// runs the whole sign-in in this process and returns only what a pilot would
// see on screen; `token_characters` reads the non-secret list; `token_forget`
// removes a character and its credential.
//
// The first vault slice requests exactly one scope, and it has to request one.
//
// It asked for none, on the reasoning that a token with no scopes still
// identifies its character - which is true, and is everything that listing
// characters requires. CCP's documentation says the rest of it: a refresh token
// is returned only when "any valid scope was requested in the initial redirect
// to the SSO using the authorization code flow". No scopes, no refresh token.
//
// `tokens_from` requires a refresh token, so this would not have failed
// quietly - the exchange reports "the reply carried no refresh_token" and no
// character is ever stored. It would have failed on the first real sign-in,
// which is a poor place to read CCP's documentation.
//
// `publicData` is the smallest scope that satisfies that condition. It grants
// nothing this application reads - the character's identity is in the token
// itself, not behind the scope - so the slice still cannot fetch anything and
// still cannot touch the sighting store. The minimum-scope rule is unchanged;
// the minimum is one rather than zero.
const FIRST_SLICE_SCOPES: [&str; 1] = ["publicData"];

// The application's data directory, resolved the way Tauri resolves it.
//
// `vault_dir` below is the answer whenever there is an `AppHandle`, and it is
// the one the running application uses. The headless checks have no handle, and
// the version they used instead read `%APPDATA%` and fell back to the system
// temp directory - which is Windows-only, and on Linux resolved to
// `/tmp/dev.shadowglyph.new-eden-atlas`, a path that has never existed.
//
// The consequence was not a wrong answer, it was a check that could not see the
// file it exists to check. It passed on Windows because the two paths coincide
// there, and reported "no EVE application is configured" on a machine where one
// is - the single case where a configuration check earns its keep is a machine
// the author is not sitting at. Found by the Linux box, 2026-09-20.
//
// Written out by hand rather than taking a dependency for three lines, and kept
// next to `vault_dir` so the two are read together. If Tauri ever changes where
// it puts application data, this is the other half.
const APP_IDENTIFIER: &str = "dev.shadowglyph.new-eden-atlas";

fn app_data_directory() -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
    };
    base.unwrap_or_else(std::env::temp_dir).join(APP_IDENTIFIER)
}

fn vault_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("no application data directory: {e}"))
}

#[tauri::command]
fn token_characters(app: tauri::AppHandle) -> Result<Vec<sso::VaultEntry>, String> {
    // The strict read. An unreadable list is an error the pilot sees, never an
    // empty list the window presents as "no characters".
    sso::load_vault_state(&vault_dir(&app)?)
}

#[tauri::command]
fn token_forget(app: tauri::AppHandle, character_id: i64) -> Result<(), String> {
    // Read first, delete second, write third, and the order is the whole of it.
    //
    // Strict, because the last line writes: rewriting a list that could not be
    // read would drop every other character from it, and this is the one place
    // in the application where deletion is what the pilot asked for - which
    // makes a silent extra deletion here especially hard to notice.
    //
    // It reads *before* touching the credential so that an unreadable list
    // refuses having done nothing at all. The credential still goes before the
    // list is rewritten: if that write then fails, the character stays on
    // screen with a credential already revoked, and pressing Forget again
    // finishes the job - `forget_refresh` treats an absent credential as
    // success. The other order leaves a pilot believing they revoked a
    // credential that is still in the operating system's store, which is the
    // failure that cannot be noticed from inside the application.
    let directory = vault_dir(&app)?;
    let mut entries = sso::load_vault_state(&directory)?;
    sso::forget_refresh(character_id)?;
    // The cached portrait goes with the character. It is the only other thing
    // on disk that names them, and leaving it behind would mean "forget" left a
    // picture of the pilot in the application data directory.
    //
    // Not fatal if it fails: the credential is already gone, the character is
    // about to leave the list, and refusing the whole removal over a leftover
    // JPEG would strand the pilot in a worse state than the one they asked for.
    let portrait = sso::forget_portrait(&directory, character_id);
    entries.retain(|e| e.character_id != character_id);
    sso::save_vault(&directory, &entries).map_err(|why| {
        format!("the credential was removed, but the character list could not be updated: {why} The character is still listed; removing it again will finish this.")
    })?;
    // Said last, because by now everything the pilot asked for has happened
    // except this, and it is the only part they might want to finish by hand.
    portrait

}

// A character's portrait, as a data URI, or nothing.
//
// Deliberately cannot fail. Every outcome a caller could act on differently -
// offline, a 404 for a character with no portrait, a slow CDN - produces the
// same correct behaviour in the panel, which is a row without a picture. An
// Err here would put a red sentence under the character list because a
// decoration did not load.
//
// Cache first and network second, and the cache is never revalidated: a
// portrait changes when a pilot resculpts, which is rare enough that a stale
// one is a better trade than a request per row per launch. Forgetting the
// character removes it, and signing in again fetches it afresh.
#[tauri::command]
async fn character_portrait(app: tauri::AppHandle, character_id: i64) -> Result<Option<String>, String> {
    let directory = match vault_dir(&app) {
        Ok(directory) => directory,
        Err(_) => return Ok(None),
    };
    if character_id <= 0 {
        return Ok(None);
    }
    if let Some(bytes) = sso::cached_portrait(&directory, character_id) {
        return Ok(Some(sso::portrait_data_uri(&bytes)));
    }
    // Off the UI thread: this is a network round trip to a CDN.
    let fetched = tauri::async_runtime::spawn_blocking(move || sso::fetch_portrait(character_id))
        .await;
    let bytes = match fetched {
        Ok(Ok(bytes)) => bytes,
        // A panicking worker, a refused request, a character with no portrait.
        // All the same answer here.
        _ => return Ok(None),
    };
    // A failed write is not a reason to withhold the picture we already have.
    let _ = sso::store_portrait(&directory, character_id, &bytes);
    Ok(Some(sso::portrait_data_uri(&bytes)))
}

#[tauri::command]
async fn token_begin(app: tauri::AppHandle) -> Result<sso::VaultEntry, String> {
    let directory = vault_dir(&app)?;
    // Read before anything else happens, and discard the result: this is a
    // refusal, not a load. A sign-in that ends by writing a list it could not
    // read would delete every character already in it, and by then a browser
    // has been opened, a consent given and a credential stored - so the failure
    // arrives after the pilot has done everything right. Failing here costs a
    // click and nothing else.
    sso::load_vault_state(&directory)?;
    let config = sso::load_config(&directory);
    if let Some(fault) = config.fault() {
        return Err(fault);
    }

    let pkce = sso::Pkce::generate();
    let state = sso::random_state();
    let url = sso::authorize_url(&config, &pkce, &state, &FIRST_SLICE_SCOPES);

    // The port is held before the pilot is sent anywhere.
    //
    // Opening the browser first meant a port already taken by something else
    // was discovered only after the pilot had signed in and consented - by
    // which time CCP had minted a code and delivered it to whatever was
    // squatting the port. It also lost the race with a pilot who has consented
    // before: CCP redirect immediately in that case, and the redirect can
    // arrive before the listener is up.
    let listeners = sso::bind_callback(config.callback_port)?;

    sso::open_in_browser(&url)?;

    // Blocking work off the UI thread. The listener waits minutes, because a
    // pilot may have to log in and read a consent screen.
    let waited = {
        let state = state.clone();
        tauri::async_runtime::spawn_blocking(move || {
            sso::wait_on(&listeners, &state, Duration::from_secs(300))
        })
        .await
        .map_err(|e| format!("the sign-in wait failed: {e}"))?
    };
    let callback = waited?;

    let config2 = config.clone();
    let tokens = tauri::async_runtime::spawn_blocking(move || {
        sso::exchange_code(&config2, &pkce, &callback.code)
    })
    .await
    .map_err(|e| format!("the exchange failed: {e}"))??;

    let client_id = config.client_id.clone();
    let access = tokens.access.expose().to_string();
    let character = tauri::async_runtime::spawn_blocking(move || {
        let jwks = sso::fetch_jwks()?;
        sso::character_from(&access, &jwks, &client_id)
    })
    .await
    .map_err(|e| format!("token validation failed: {e}"))??;

    // The refresh token goes to the operating system and nowhere else. It is
    // stored before the character is listed: a listed character whose
    // credential failed to store is one the pilot believes is signed in.
    sso::store_refresh(character.id, &tokens.refresh)?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let entry = sso::VaultEntry {
        character_id: character.id,
        name: character.name,
        scopes: character.scopes,
        added_at: now,
        last_refresh_at: now,
        last_refresh_error: None,
    };
    // Strict again: the file may have changed since the check above, and this
    // call writes. The credential is already stored at this point, so a failure
    // here says so rather than pretending the sign-in did not happen.
    let mut entries = sso::load_vault_state(&directory).map_err(|why| {
        format!(
            "{why} The sign-in itself worked and the credential is stored; fix or remove that file and sign in again."
        )
    })?;
    sso::upsert(&mut entries, entry.clone());
    // A credential the application cannot list is a credential the pilot cannot
    // revoke from here. `token_forget` is only reachable from a row in the
    // vault, so a stored refresh token with no entry beside it can only be
    // removed by hand in the operating system's credential store - after an
    // operation that told the pilot the sign-in failed.
    //
    // So the credential is taken back out, and if even that fails the error
    // names the character id and where to look, because that is the only thing
    // left that helps.
    if let Err(why) = sso::save_vault(&directory, &entries) {
        return Err(match sso::forget_refresh(entry.character_id) {
            Ok(()) => format!(
                "the sign-in worked but the character list could not be saved: {why} The credential was removed again, so nothing was left behind."
            ),
            Err(also) => format!(
                "the sign-in worked but the character list could not be saved: {why} The stored credential could not be removed either ({also}), so character {} still has a refresh token in this machine's credential store under \"New Eden Atlas\". Remove it by hand if you do not intend to sign in again.",
                entry.character_id
            ),
        });
    }
    Ok(entry)
}

// --- the headless check --------------------------------------------------------
//
// A screenshot proves the map drew and proves nothing about the process
// boundary. This runs the parts that need no window and prints what it found,
// so a packaged build can be checked without somebody sitting in front of it.
//
//     cargo run --manifest-path src-tauri/Cargo.toml -- --selftest
//     cargo run --manifest-path src-tauri/Cargo.toml --release --features console -- --selftest
//
// The feature exists because a release build is a windows-subsystem binary with
// nowhere to print.
fn selftest(root: PathBuf) -> i32 {
    let mut failures = 0;
    let mut check = |name: &str, result: Result<String, String>| match result {
        Ok(detail) => println!("  ok    {name}: {detail}"),
        Err(why) => {
            println!("  FAIL  {name}: {why}");
            failures += 1;
        }
    };

    let dist = root.join("dist");

    // Does this binary contain the frontend on disk, rather than merely
    // postdate it.
    //
    // The first version of this compared two timestamps - binary newer than
    // dist - and the Linux box defeated it within the hour, by the ordinary
    // sequence it was written to catch. A build was already running when
    // staging wrote new assets: the embed had read `dist/` before those files
    // landed, so the binary carried the old frontend, but it *finished*
    // afterwards, so its mtime was newer. The check passed and reported "the
    // window would show what is on disk". It did not.
    //
    // Two timestamps answer "was this written after that". The question is
    // "does this contain that", and the two differ exactly when a build
    // straddles a staging - which is not exotic. On a cold Tauri build that
    // window is minutes wide.
    //
    // So it compares identities instead. `scripts/stamp_assets.py` already
    // derives one hash over every asset the page loads, in page order, and
    // writes it into `index.html` as `?v=<hex>` - so the frontend already
    // carries its own name. `include_str!` takes the copy the compiler saw;
    // the other is read from disk now.
    //
    // The `include_str!` earns its place twice. It is the only way to see the
    // embedded copy from here, and it makes `dist/web/index.html` a compile
    // dependency - so changing any asset changes the stamp, changes this file's
    // input, and forces the re-embed that a changed `dist/` alone does not
    // always trigger. That was the other half of why re-staging and relaunching
    // changed nothing.
    const EMBEDDED_INDEX: &str = include_str!("../../dist/web/index.html");

    fn asset_stamp(html: &str) -> Option<&str> {
        html.split("?v=").nth(1)?.split(|c: char| !c.is_ascii_hexdigit()).next()
    }

    check(
        "this binary contains the frontend staged beside it",
        {
            let on_disk = std::fs::read_to_string(dist.join("web").join("index.html"));
            match (asset_stamp(EMBEDDED_INDEX), on_disk.as_deref().ok().and_then(asset_stamp)) {
                (Some(built), Some(staged)) if built == staged =>
                    Ok(format!("both are {built}")),
                (Some(built), Some(staged)) => Err(format!(
                    "this binary was built from frontend {built} and {staged} is staged - re-stage and rebuild, or run scripts/check.ps1, which does both in order"
                )),
                (None, _) => Err("the embedded index.html carries no asset stamp - run scripts/stamp_assets.py and rebuild".into()),
                (_, None) => Err("dist/web/index.html is missing or carries no asset stamp - run scripts/stage_shell.py".into()),
            }
        },
    );

    check(
        "the frontend is staged beside the archive",
        if dist.join("web").join("index.html").is_file()
            && dist.join("data").join("regions.json").is_file()
        {
            Ok("dist/web and dist/data are both present".into())
        } else {
            Err("run scripts/stage_shell.py: the window would open on an empty map".into())
        },
    );

    // Resolved, not a bare name: this check should exercise the same lookup the
    // shell does, and a bare name here would search the running executable's own
    // directory first on Windows - the hazard `resolve_on_path` exists to close.
    let interpreter_name = if cfg!(windows) { "python" } else { "python3" };
    let interpreter = resolve_on_path(interpreter_name)
        .unwrap_or_else(|| PathBuf::from(interpreter_name));
    // `--sidecar <path>` points the check at something else, which is how the
    // pid guard gets tested: a process that reports a pid other than its own
    // must be refused, and the only way to see that is to run one.
    let script = std::env::args()
        .position(|argument| argument == "--sidecar")
        .and_then(|index| std::env::args().nth(index + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("sidecar").join("atlas_sidecar.py"));
    let interpreter2 = interpreter.clone();
    let script2 = script.clone();
    check(
        "the sidecar answers, and it is the process we spawned",
        spawn_sidecar(&interpreter, Some(&script)).and_then(|mut process| {
            let pid = process.pid;
            // `HANDSHAKE_TIMEOUT`, not the advisor's: this is a handshake-class
            // message, and bounding it by the model's budget makes a headless
            // check hang six times longer than the code it is checking would.
            let reply = exchange_within(&mut process, r#"{"op":"ping"}"#, HANDSHAKE_TIMEOUT);
            let _ = process.child.kill();
            let _ = process.child.wait();
            reply.map(|line| format!("pid {pid} verified, said {line}"))
        }),
    );

    // --- the supervisor's own guards -------------------------------------------
    //
    // Four things the shell promises about the process it owns, none of which had
    // a check: that a pid which cannot be a pid is refused, that an ordinary
    // banner line does not refuse the whole process, that the interpreter is
    // resolved rather than searched for beside the executable, and that closing
    // the window does not wait for a model.

    // **A pid that does not fit is not a pid.** It was read as a `u64` and
    // narrowed with `as u32`, so a sidecar answering `os.getpid() + 2**32`
    // truncated to the real pid and was accepted - satisfying the guard that
    // exists to prove the process answering is the one we spawned.
    // **Not the shared temp directory.** These two fixtures are written and then
    // *executed*, so a predictable path anyone can write to is a file this check
    // hands to an interpreter having verified nothing about it - the same class as
    // the bare-name hazard `resolve_on_path` exists to close, one directory over.
    // They live under the build's own output instead, and are removed after use
    // rather than left lying about for the next run to trust.
    let fixtures = root.join("src-tauri").join("target").join("selftest-fixtures");
    let _ = std::fs::create_dir_all(&fixtures);
    let liar = fixtures.join("wide-pid.py");
    let liar_source = "import json,os,sys\nfor line in sys.stdin:\n    sys.stdout.write(json.dumps({\"pid\": os.getpid() + 2**32}) + \"\\n\")\n    sys.stdout.flush()\n";
    check(
        "a sidecar reporting a pid too large to be one is refused",
        // `spawn_sidecar` handshakes before it hands the process back, so the
        // refusal happens there and the whole chain failing is the pass. The first
        // version of this check matched on `handshake` inside the closure, which
        // that closure never reaches - it reported the correct refusal as a FAIL.
        match std::fs::write(&liar, liar_source)
            .map_err(|e| e.to_string())
            .and_then(|()| spawn_sidecar(&interpreter, Some(&liar)))
        {
            Ok(mut process) => {
                let accepted = process.pid;
                let _ = process.child.kill();
                let _ = process.child.wait();
                Err(format!("it was accepted as pid {accepted}"))
            }
            Err(why) => Ok(format!("refused: {why}")),
        },
    );
    let _ = std::fs::remove_file(&liar);

    // **A banner line is ordinary.** `DISCARD_LIMIT` exists because "a dependency
    // inside the sidecar printing a banner, a deprecation warning or a progress
    // bar to stdout is ordinary" - and the handshake read exactly one line, so one
    // banner made the process be refused entirely.
    let chatty = fixtures.join("banner.py");
    let chatty_source = "import json,os,sys\nprint(\"loading extension pack 3.1\")\nsys.stdout.flush()\nfor line in sys.stdin:\n    sys.stdout.write(json.dumps({\"pid\": os.getpid()}) + \"\\n\")\n    sys.stdout.flush()\n";
    check(
        "a banner line before the handshake is absorbed rather than fatal",
        std::fs::write(&chatty, chatty_source)
            .map_err(|e| e.to_string())
            .and_then(|()| spawn_sidecar(&interpreter, Some(&chatty)))
            .and_then(|mut process| {
                let spawned = process.pid;
                let outcome = handshake(&mut process);
                let _ = process.child.kill();
                let _ = process.child.wait();
                match outcome {
                    Ok(pid) if pid == spawned => Ok(format!("the banner was discarded and pid {pid} verified")),
                    Ok(pid) => Err(format!("it reported pid {pid}, not the {spawned} we spawned")),
                    Err(why) => Err(format!("the banner was fatal: {why}")),
                }
            }),
    );
    let _ = std::fs::remove_file(&chatty);
    // Empty now, so it leaves nothing behind at all; kept if anything else is in it.
    let _ = std::fs::remove_dir(&fixtures);

    // **The interpreter is resolved on PATH.** `Command::new("python")` becomes
    // `CreateProcess` with a bare name, and Windows searches the running
    // executable's own directory before PATH. `sso.rs` spends twenty lines closing
    // this for `rundll32.exe`; the branch one function over guarded the script path
    // and not the interpreter name.
    check(
        "the interpreter is resolved to an absolute path, not left as a bare name",
        match resolve_on_path(interpreter_name) {
            None => Err(format!("{interpreter_name} is not on PATH, so this machine cannot answer the question")),
            Some(found) => {
                if !found.is_absolute() {
                    Err(format!("{} is not absolute", found.display()))
                } else if !found.is_file() {
                    Err(format!("{} is not a file", found.display()))
                } else {
                    let beside = std::env::current_exe().ok().and_then(|exe| exe.parent().map(PathBuf::from));
                    let planted = beside.as_ref().is_some_and(|dir| found.parent() == Some(dir.as_path()));
                    if planted {
                        Err(format!("{} sits beside this executable, which is the directory that must not win", found.display()))
                    } else {
                        Ok(format!("resolved to {}", found.display()))
                    }
                }
            }
        },
    );

    // **Closing the window does not wait for a model.** `stop_sidecar` took the
    // same mutex `advisor_request` holds for a whole exchange, from the main
    // thread, so the close button froze for up to thirty seconds - the exact
    // failure `advisor_request`'s own header says its `async` attribute exists to
    // prevent. The block had moved to teardown.
    //
    // Timed, because a wait is only observable from outside. The lock is held for
    // the duration, which is what an exchange in flight looks like.
    check(
        "closing the window with an exchange in flight does not block",
        spawn_sidecar(&interpreter, Some(&script)).and_then(|process| {
            let pid = process.pid;
            let state = Sidecar(Mutex::new(Some(process)), std::sync::atomic::AtomicU32::new(pid));
            let held = state.0.lock().map_err(|_| "the fresh lock was poisoned".to_string())?;
            let began = Instant::now();
            shutdown_sidecar(&state);
            let waited = began.elapsed();
            drop(held);
            let recorded = state.1.load(std::sync::atomic::Ordering::SeqCst);
            // Whatever is left is cleaned up, so the check owns no process either way.
            if let Ok(mut slot) = state.0.lock() {
                stop_sidecar_locked(&state, &mut slot);
            }
            if waited >= Duration::from_secs(1) {
                Err(format!("it waited {waited:?}, which is the block this exists to refuse"))
            } else if recorded != 0 {
                Err(format!("it returned fast but left pid {recorded} recorded, so nothing killed it"))
            } else {
                Ok(format!("returned in {waited:?} and the recorded pid was cleared"))
            }
        }),
    );

    // --- the advisor hop, end to end -------------------------------------------
    //
    // The webview builds an envelope, the core relays it as one NDJSON line, the
    // sidecar answers with an envelope of its own, and the id survives the round trip -
    // which is what the advisor's two staleness checks rest on.
    //
    // The question is the interesting part. It is the first free text ever to
    // cross this process, and the rule written down before the code was that the
    // core relays it opaquely and the far end never hands it back. A refusal is
    // exactly where an echo would be most natural to write and least likely to
    // be noticed, so it is checked on the refusal path rather than a happy one.
    check(
        "an advisor envelope round-trips, and the question does not come back",
        spawn_sidecar(&interpreter2, Some(&script2)).and_then(|mut process| {
            const SECRET: &str = "which gate is camped right now";
            let asked = format!(
                r#"{{"v":1,"id":"c-selftest-1","op":"advisor.ask","payload":{{"projection":{{}},"question":"{SECRET}"}}}}"#
            );
            let reply = exchange(&mut process, &asked);
            let _ = process.child.kill();
            let _ = process.child.wait();
            let line = reply?;
            let parsed: serde_json::Value = serde_json::from_str(&line)
                .map_err(|e| format!("the advisor answered {line:?}: {e}"))?;
            if parsed.get("id").and_then(serde_json::Value::as_str) != Some("c-selftest-1") {
                return Err(format!("the reply did not carry the request id: {line}"));
            }
            if parsed.get("ok").and_then(serde_json::Value::as_bool) != Some(false) {
                return Err(format!("a build with no model must refuse rather than answer: {line}"));
            }
            if line.contains(SECRET) {
                return Err(format!("the question came back in the reply: {line}"));
            }
            let code = parsed
                .get("error")
                .and_then(|error| error.get("code"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            Ok(format!("id echoed, refused as {code}, question not echoed"))
        }),
    );

    // --- the live store, which holds the only copy of the pilot's history -------
    //
    // Checked here rather than trusted, because every failure in this area is
    // silent: an empty store looks like a clean first run, and a truncated file
    // looks like a store.
    let scratch = std::env::temp_dir().join(format!("atlas-store-check-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&scratch);
    let path = scratch.join("live-store.json");
    let _ = std::fs::remove_file(&path);

    check(
        "no file is a first run, not damage",
        match load_store(&path) {
            Ok(None) => Ok("absent, so the store starts empty".into()),
            Ok(Some(_)) => Err("read a store from nothing".into()),
            Err(why) => Err(format!("reported damage where there is no file: {why}")),
        },
    );

    let first = serde_json::json!({ "schema": 1, "sightings": { "observations": [1, 2, 3] } });
    check(
        "a save round-trips",
        save_store(&path, &first)
            .and_then(|bytes| match load_store(&path) {
                Ok(Some(back)) if back == first => Ok(format!("{bytes} bytes back exactly")),
                Ok(other) => Err(format!("read back something else: {other:?}")),
                Err(why) => Err(why),
            }),
    );

    // Any scratch sibling, not one exact name.
    //
    // Not one exact name. `save_store`'s temp name carries a pid and a nanosecond
    // stamp so that two writers cannot collide, so a check written against a fixed
    // name cannot fail for any implementation - including one that leaves a scratch
    // file behind on every call. A check that cannot fail reads exactly like
    // coverage.
    let strays = |where_: &std::path::Path| -> Vec<String> {
        std::fs::read_dir(where_)
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok())
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .filter(|name| name.contains(".writing"))
                    .collect()
            })
            .unwrap_or_default()
    };
    // The bound on what reaches the disk. Checked at the boundary rather than
    // by building a quarter of a gigabyte, and checked on both sides of it so
    // "refuses everything" cannot pass for "refuses too much".
    check(
        "a store past the size bound is refused, naming both numbers",
        match store_size_fault(MAX_STORE_BYTES + 1, MAX_STORE_BYTES) {
            // The instruction is part of the refusal, not a nicety: the only
            // person who ever reads this sentence is the one who needs to raise
            // the cap, and a README is not where they are.
            Some(why)
                if why.contains("256 MB")
                    && why.contains("unchanged")
                    && why.contains("limits.json")
                    && why.contains("live_store_mb") =>
            {
                Ok(format!("refused, and says how to raise it: {}", why.split(" - ").nth(1).unwrap_or(&why)))
            }
            Some(why) => Err(format!("refused without saying enough: {why}")),
            None => Err("a store past the bound was accepted".into()),
        },
    );
    check(
        "a store at the bound is still written",
        match store_size_fault(MAX_STORE_BYTES, MAX_STORE_BYTES) {
            None => Ok("the limit is inclusive, so a store exactly at it is not lost".into()),
            Some(why) => Err(format!("refused a store that fits: {why}")),
        },
    );

    // The limit is adjustable by the person who owns the machine, and by nobody
    // else. What is checked here is that every bad spelling of the override
    // falls back to the default rather than to no limit, and that the clamp
    // holds at both ends - "adjustable" turning into "off" is the one outcome
    // that would make the guard decorative.
    {
        let scratch = std::env::temp_dir().join(format!("atlas-limits-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&scratch);
        let mb = |bytes: usize| bytes / (1024 * 1024);
        let with = |text: Option<&str>| {
            match text {
                Some(body) => { let _ = std::fs::write(scratch.join(LIMITS_FILE), body); }
                None => { let _ = std::fs::remove_file(scratch.join(LIMITS_FILE)); }
            }
            mb(store_limit_bytes(&scratch))
        };
        let default_mb = mb(MAX_STORE_BYTES);
        let cases: Vec<(&str, usize, usize)> = vec![
            ("no file at all", with(None), default_mb),
            ("an empty object", with(Some("{}")), default_mb),
            ("unparseable json", with(Some("{not json")), default_mb),
            ("a string instead of a number", with(Some(r#"{"live_store_mb":"lots"}"#)), default_mb),
            ("a negative number", with(Some(r#"{"live_store_mb":-1}"#)), default_mb),
            ("zero", with(Some(r#"{"live_store_mb":0}"#)), MIN_STORE_MB),
            ("below the floor", with(Some(r#"{"live_store_mb":1}"#)), MIN_STORE_MB),
            ("a real increase", with(Some(r#"{"live_store_mb":1024}"#)), 1024),
            ("past the ceiling", with(Some(r#"{"live_store_mb":99999999}"#)), MAX_STORE_MB),
        ];
        let _ = std::fs::remove_dir_all(&scratch);
        let wrong: Vec<String> = cases
            .iter()
            .filter(|(_, got, want)| got != want)
            .map(|(name, got, want)| format!("{name}: {got} MB, expected {want}"))
            .collect();
        check(
            "the store limit is adjustable, clamped at both ends, and never absent",
            if wrong.is_empty() {
                Ok(format!("{} spellings, default {default_mb} MB, floor {MIN_STORE_MB}, ceiling {MAX_STORE_MB}", cases.len()))
            } else {
                Err(wrong.join("; "))
            },
        );
    }

    check(
        "a save leaves no scratch file beside the store",
        match strays(&scratch) {
            left if left.is_empty() => Ok("nothing left beside it".into()),
            left => Err(format!("{} scratch file(s) left: {left:?}", left.len())),
        },
    );

    // And the failing save, which is the one that leaks. A write that fails after the
    // file exists must take it away again - and a check injecting its failure at
    // `File::create` never runs that path at all.
    {
        let full = scratch.join("read-only-target");
        let _ = std::fs::create_dir_all(&full);
        let target = full.join("live-store.json");
        // A directory where the store should be: create succeeds nowhere, but
        // on every platform this fails inside save_store rather than before it.
        let _ = std::fs::create_dir_all(&target);
        let outcome = save_store(&target, &serde_json::json!({ "x": 1 }));
        check(
            "a save that fails leaves no scratch file behind",
            match (outcome, strays(&full)) {
                (Err(_), left) if left.is_empty() => Ok("failed and cleaned up after itself".into()),
                (Err(_), left) => Err(format!("failed and left {} scratch file(s): {left:?}", left.len())),
                (Ok(_), _) => Err("the save was expected to fail and did not".into()),
            },
        );
    }

    // Planting a fixture is itself fallible, and a panic here would end the run at
    // this line - losing every check below it, with nothing in the output to say
    // which ones never ran. A read-only temp directory or a full disk is all it
    // takes. So a failed plant is a failed check, like everything else here.
    let plant = |bytes: &str| -> Result<String, String> {
        std::fs::write(&path, bytes).map_err(|e| format!("could not write the fixture: {e}"))?;
        Ok("planted".to_string())
    };

    // The distinction the whole design rests on. A corrupt file must report as
    // damage, because reporting it as absence hands back an empty store and
    // invites the write that makes the loss permanent.
    if let Err(why) = plant("{ this is not json") {
        check("a corrupt file is damage, not absence", Err(why));
    } else {
    check(
        "a corrupt file is damage, not absence",
        match load_store(&path) {
            Err(_) => Ok("refused, so nothing will be written over it".into()),
            Ok(None) => Err("reported as a first run, which would replace it with an empty store".into()),
            Ok(Some(_)) => Err("parsed something out of a corrupt file".into()),
        },
    );
    }
    check(
        "and the corrupt bytes are still there",
        match std::fs::read_to_string(&path) {
            Ok(text) if text == "{ this is not json" => Ok("left exactly as found".into()),
            Ok(_) => Err("the file was altered by reading it".into()),
            Err(why) => Err(why.to_string()),
        },
    );

    // An empty file is truncation, not a first run - something got part way.
    // Valid JSON that is not a store is damage for the same reason: handed back,
    // it reaches the viewer as a store with no sightings, degrades to empty, and
    // is then written over the file that really held something.
    for (text, what) in [("4", "a number"), ("\"x\"", "a string"), ("[1,2]", "a list"), ("null", "null")] {
        check(
            &format!("{what} in the store file is damage, not a store"),
            plant(text).and_then(|_| match load_store(&path) {
                Err(_) => Ok("refused".into()),
                Ok(other) => Err(format!("accepted as a store: {other:?}")),
            }),
        );
    }


    check(
        "an empty file is damage too",
        plant("").and_then(|_| match load_store(&path) {
            Err(_) => Ok("refused rather than treated as a clean boot".into()),
            _ => Err("an empty file was read as absence".into()),
        }),
    );

    // Concurrent saves must not produce a mixture.
    //
    // This replaces a check that could not fail. The previous version made a
    // save fail by writing to a path whose parent did not exist, then asserted
    // an unrelated file was untouched - true of any implementation, including
    // the naive truncating write the comment on save_store calls "how history
    // gets wiped". Replacing the whole function with a bare fs::write left every
    // store check green, which a hostile audit proved by doing exactly that.
    //
    // So this exercises the interleaving the temp-and-rename actually exists
    // for. Eight threads save eight distinguishable payloads at once; the file
    // afterwards must parse and must be exactly one of them. Against a fixed
    // temp name it is a mixture, or a truncated prefix of one written directly
    // into the live store.
    {
        let target = scratch.join("concurrent.json");
        let payloads: Vec<serde_json::Value> = (0..8)
            .map(|n| serde_json::json!({ "writer": n, "filler": "x".repeat(40_000) }))
            .collect();
        std::thread::scope(|scope| {
            for payload in &payloads {
                let path = target.clone();
                scope.spawn(move || {
                    let _ = save_store(&path, payload);
                });
            }
        });
        check(
            "concurrent saves leave one whole store, never a mixture",
            match load_store(&target) {
                Ok(Some(value)) if payloads.contains(&value) => {
                    Ok(format!("writer {} won cleanly", value["writer"]))
                }
                Ok(Some(_)) => Err("the file parsed but is not any one save".into()),
                Ok(None) => Err("no file survived eight saves".into()),
                Err(why) => Err(format!("the store was corrupted: {why}")),
            },
        );
        // The property the rename actually provides, stated as something a reader
        // can observe: at no instant is the target a prefix of anything. A
        // watcher sampling the file while a large save runs must only ever see
        // a whole store - the old one or the new one, never half of either.
        //
        // This is what the concurrency check above could not see. Eight small
        // saves each complete in a single write syscall, so the naive
        // truncating write wins that test by being too fast to catch. Make the
        // payload large enough to span many syscalls and the difference is
        // immediate: a truncating write leaves the file unparseable for most of
        // its duration, because it emptied the target before it had the bytes.
        let watched = scratch.join("watched.json");
        let small = serde_json::json!({ "which": "old" });
        save_store(&watched, &small).ok();
        let large = serde_json::json!({ "which": "new", "filler": "y".repeat(6_000_000) });
        let mut partial = 0;
        let mut samples = 0;
        let mut staged = 0;
        // Several rounds, because the window is narrow and a test that catches
        // the fault one time in five is worse than no test: it would be dismissed
        // as flaky by the first person it failed for. A truncating write is
        // caught in every round; this one has to be clean in all of them.
        for _ in 0..5 {
            std::thread::scope(|scope| {
                let writer = scope.spawn(|| save_store(&watched, &large));
                while !writer.is_finished() {
                    samples += 1;
                    if let Ok(text) = std::fs::read_to_string(&watched) {
                        if serde_json::from_str::<serde_json::Value>(&text).is_err() {
                            partial += 1;
                        }
                    }
                    // The mechanism, not the symptom. A truncated target is
                    // only visible for the microseconds between the truncate
                    // and the first write landing, so sampling for it catches
                    // the fault about two runs in three - reliable enough to
                    // accuse, not reliable enough to trust. The scratch file
                    // exists for the *whole* duration of a temp-and-rename
                    // save, so observing it is deterministic, and never
                    // observing one says the save went straight at the target.
                    if let Ok(entries) = std::fs::read_dir(&scratch) {
                        if entries.flatten().any(|e| {
                            e.file_name().to_string_lossy().contains("watched.json.writing.")
                        }) {
                            staged += 1;
                        }
                    }
                }
            });
            save_store(&watched, &small).ok();
        }
        check(
            "a save is staged beside the store, never written into it",
            if staged > 0 && partial == 0 {
                Ok(format!("{staged} of {samples} samples saw the scratch file, and none saw a partial store"))
            } else if staged == 0 {
                Err(format!(
                    "no scratch file existed during {samples} samples of a six-megabyte save - the bytes went straight at the live store"
                ))
            } else {
                Err(format!("{partial} of {samples} samples caught a truncated store"))
            },
        );

        // What the lock is for, as opposed to what the unique temp name is for.
        //
        // Unique names stop two saves corrupting each other. They do nothing
        // about *order*: a large save started first can still finish last and
        // rename its older content over a smaller, newer one, so the file ends
        // up holding data the application already superseded. Nothing would
        // look wrong - the store is whole and parses - it is simply out of date,
        // and the next read believes it.
        //
        // Deleting the lock leaves every other store check green, which is how
        // this gap was found. The property it actually provides is that saves
        // land in the order they were requested.
        let ordered = scratch.join("ordered.json");
        let older = serde_json::json!({ "generation": "older", "filler": "z".repeat(4_000_000) });
        let newer = serde_json::json!({ "generation": "newer" });
        std::thread::scope(|scope| {
            let path = ordered.clone();
            let first = &older;
            scope.spawn(move || {
                let _ = save_store(&path, first);
            });
            std::thread::sleep(Duration::from_millis(5));
            let path = ordered.clone();
            let second = &newer;
            scope.spawn(move || {
                let _ = save_store(&path, second);
            });
        });
        check(
            "the save requested last is the one on disk",
            match load_store(&ordered) {
                Ok(Some(value)) if value["generation"] == "newer" =>
                    Ok("a slower earlier save did not overwrite a newer one".into()),
                Ok(Some(value)) =>
                    Err(format!("the file holds the {} save", value["generation"])),
                other => Err(format!("unreadable: {other:?}")),
            },
        );

        check(
            "and no temporary file is left behind",
            match std::fs::read_dir(&scratch) {
                Ok(entries) => {
                    let strays: Vec<_> = entries
                        .flatten()
                        .map(|e| e.file_name().to_string_lossy().into_owned())
                        .filter(|name| name.contains(".writing"))
                        .collect();
                    if strays.is_empty() {
                        Ok("the directory holds only finished stores".into())
                    } else {
                        Err(format!("left {strays:?}"))
                    }
                }
                Err(why) => Err(why.to_string()),
            },
        );
    }

    // A save that cannot complete must leave the previous save intact. This is
    // the whole of "a crashed core does not wipe history": the naive write opens
    // the real file and truncates it before it knows whether it can finish.
    let good = serde_json::json!({ "schema": 1, "keep": "me" });
    save_store(&path, &good).ok();
    let blocked = scratch.join("nowhere").join("deeper").join("live-store.json");
    let failed = save_store(&blocked, &serde_json::json!({ "schema": 1 }));
    check(
        "a save that fails does not touch the previous one",
        match (failed, load_store(&path)) {
            (Err(_), Ok(Some(back))) if back == good => Ok("the earlier save is still there".into()),
            (Ok(_), _) => Err("a write to an impossible path reported success".into()),
            (_, other) => Err(format!("the earlier save did not survive: {other:?}")),
        },
    );

    let _ = std::fs::remove_dir_all(&scratch);

    // --- EVE SSO, everything that can be checked without CCP ---------------------
    //
    // None of this needs a registered application or a network. What it does
    // need is to be checked at all: an undeclared module is how someone later
    // "just adds the vault" and ships a PKCE implementation that has never run.

    // RFC 7636's own test vector, not a round trip of our own output. A
    // derivation checked against itself proves the two halves agree and nothing
    // about whether either is right - and getting S256 subtly wrong produces a
    // challenge CCP rejects with a message about the client, not the hash.
    check(
        "the code challenge matches RFC 7636's vector",
        match sso::challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").as_str() {
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" => Ok("S256, base64url, unpadded".into()),
            other => Err(format!("derived {other}")),
        },
    );

    let config = sso::SsoConfig {
        client_id: "test-client".into(),
        callback_port: 47625,
    };
    let pkce = sso::Pkce::generate();
    let state = sso::random_state();
    let url = sso::authorize_url(&config, &pkce, &state, &[]);
    check(
        "the authorize URL carries the challenge and not the verifier",
        if url.contains("code_challenge_method=S256")
            && url.contains(&sso::encode(&pkce.challenge))
            && !url.contains(pkce.verifier.expose())
        {
            Ok("challenge sent, verifier kept".into())
        } else {
            Err(url.to_string())
        },
    );
    check(
        "and a loopback redirect with the state",
        if url.contains(&sso::encode("http://localhost:47625/callback")) && url.contains(&sso::encode(&state)) {
            Ok("redirect_uri and state present".into())
        } else {
            Err(url.to_string())
        },
    );

    // A refusal from CCP is an answer, and a clearer one than a missing code.
    check(
        "an SSO refusal is reported as a refusal",
        match sso::parse_callback(
            "GET /callback?error=access_denied&error_description=Nope&state=s HTTP/1.1",
        ) {
            Ok(callback) if callback.refusal.as_deref() == Some("access_denied") =>
                Ok("carried as a refusal, for the caller to check the state first".into()),
            Ok(callback) => Err(format!("carried the wrong reason: {:?}", callback.refusal)),
            Err(why) => Err(format!("reported as something else: {why}")),
        },
    );

    // A redirect carrying the wrong state is not this sign-in. Exercised through
    // a real socket, because the check that matters is the one in the listener
    // rather than the one a caller might remember to make.
    let expected = "the-state-we-started-with";
    let listening = std::thread::spawn(move || {
        sso::wait_for_callback(47625, expected, std::time::Duration::from_secs(5))
    });
    std::thread::sleep(std::time::Duration::from_millis(150));
    let spoke = std::net::TcpStream::connect(("127.0.0.1", 47625)).map(|mut stream| {
        let _ = stream.write_all(b"GET /callback?code=abc&state=some-other-sign-in HTTP/1.1\r\n\r\n");
        let _ = stream.flush();
    });
    check(
        "a redirect from another sign-in cannot end this one",
        match (spoke, listening.join()) {
            (Ok(_), Ok(Ok(_))) => Err("a redirect from a different sign-in was accepted".into()),
            // Ignored rather than fatal, so the wait runs out instead - and the
            // timeout says the redirects were seen, because a wait that ends in
            // silence having discarded three answers is a bad thing to debug.
            (Ok(_), Ok(Err(why))) if why.contains("ignored") => Ok(why),
            (Ok(_), Ok(Err(why))) => Err(format!("ended for the wrong reason: {why}")),
            (Err(why), _) => Err(format!("could not reach the listener: {why}")),
            (_, Err(_)) => Err("the listener panicked".into()),
        },
    );
    // And the port is free again, so a refusal does not leave a listener behind
    // that the next sign-in cannot bind over.
    check(
        "the listener is gone afterwards",
        match std::net::TcpListener::bind(("127.0.0.1", 47625)) {
            Ok(_) => Ok("the port was released".into()),
            Err(why) => Err(format!("still bound: {why}")),
        },
    );

    // Percent-decoding by byte index panics when the index lands inside a multi-byte
    // character, and `%` followed by a euro sign is enough. Under `panic = "abort"`
    // that is a process abort rather than a lost thread - window gone, sidecar
    // orphaned, from about thirty bytes sent by any local process while a sign-in is
    // open. The profile unwinds; the check stays because the bug
    // is the panic, not the strategy.
    check(
        "a malformed percent-escape cannot bring the process down",
        {
            let mut survived = 0;
            for line in [
                "GET /callback?code=%\u{20AC}X&state=s HTTP/1.1",
                "GET /callback?code=%E2&state=s HTTP/1.1",
                "GET /callback?code=%&state=s HTTP/1.1",
                "GET /callback?code=%ZZ&state=s HTTP/1.1",
                "GET /callback?code=\u{1F600}%\u{1F600}&state=s HTTP/1.1",
                "GET /callback?code=%%%%&state=s HTTP/1.1",
                "GET /callback?state=s&code=%F0%9F%98%80 HTTP/1.1",
            ] {
                let _ = sso::parse_callback(line);
                survived += 1;
            }
            Ok(format!("{survived} malformed escapes decoded without panicking"))
        },
    );

    // A sidecar that accepts the greeting and never answers blocks the setup hook -
    // after the window is created and before the event loop starts - so the
    // application hangs at launch with no error and no timeout, and the child is
    // orphaned because `stop_sidecar` is wired to window destruction. Absent is
    // handled and crashed is handled; wedged is
    // the one that took the map down, which the first law does not allow an
    // optional component to do.
    {
        let wedged = std::env::temp_dir().join(format!("atlas-wedged-{}.py", std::process::id()));
        let _ = std::fs::write(&wedged, "import sys
for line in sys.stdin:
    pass
");
        let interpreter = if cfg!(windows) { "python" } else { "python3" };
        let began = Instant::now();
        let outcome = spawn_sidecar(&PathBuf::from(interpreter), Some(&wedged));
        let waited = began.elapsed();
        let _ = std::fs::remove_file(&wedged);
        check(
            "a sidecar that never answers is given up on",
            match outcome {
                Err(why) if waited < Duration::from_secs(15) =>
                    Ok(format!("refused after {waited:?}: {}", why.chars().take(60).collect::<String>())),
                Err(_) => Err(format!("took {waited:?} to give up")),
                Ok(_) => Err("a silent sidecar was accepted as healthy".into()),
            },
        );
    }

    // And a sidecar that talks without ever finishing a line must not be able
    // to exhaust memory.
    //
    // `read_line` has no length limit. Measured against the earlier build, a
    // child writing 1 MiB chunks with no newline drove the core to **49 GB** of
    // private bytes across one handshake and one advisor read before the
    // timeouts fired. A Rust allocation failure aborts whatever the panic
    // strategy is, so that is the window vanishing - the map, the brief and the
    // planner taken down by the one component that is supposed to be optional.
    //
    // The same cap has been on the sign-in socket since it was written; this is
    // the pipe. Two megabytes is past `MAX_SIDECAR_LINE` and small enough that
    // this check costs milliseconds.
    {
        let flood = std::env::temp_dir().join(format!("atlas-flood-{}.py", std::process::id()));
        let _ = std::fs::write(&flood, "import sys
sys.stdout.write(\"x\" * (2 * 1024 * 1024))
sys.stdout.flush()
");
        let interpreter = if cfg!(windows) { "python" } else { "python3" };
        let began = Instant::now();
        let outcome = spawn_sidecar(&PathBuf::from(interpreter), Some(&flood));
        let waited = began.elapsed();
        let _ = std::fs::remove_file(&flood);
        check(
            "a sidecar that never ends a line is refused rather than allocated for",
            match outcome {
                Ok(_) => Err("an unbounded line was accepted as a handshake".into()),
                Err(why) if !why.contains("without a newline") =>
                    Err(format!("refused, but for the wrong reason: {why}")),
                Err(_) if waited >= Duration::from_secs(5) =>
                    Err(format!("took {waited:?}, so it read to the timeout rather than to the cap")),
                Err(why) => Ok(format!("{waited:?}: {}", why.chars().take(70).collect::<String>())),
            },
        );
    }

    // A slow client must not hold the listener past the sign-in's own timeout.
    //
    // The size cap bounds memory, not time: one byte every few seconds
    // satisfies every individual read and can pin the accept loop for hours
    // while the genuine redirect waits behind it. Measured against the earlier
    // build, a four-second sign-in was still blocked twenty-four seconds later.
    {
        let waiting = std::thread::spawn(move || {
            let began = Instant::now();
            let outcome = sso::wait_for_callback(47631, "drip", Duration::from_secs(6));
            (outcome, began.elapsed())
        });
        std::thread::sleep(Duration::from_millis(150));
        let dripper = std::thread::spawn(|| {
            if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", 47631)) {
                for _ in 0..40 {
                    if stream.write_all(b"G").is_err() {
                        return;
                    }
                    let _ = stream.flush();
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        });
        // The real redirect arrives while the dripper is still dripping.
        std::thread::sleep(Duration::from_millis(500));
        let real = std::net::TcpStream::connect(("127.0.0.1", 47631)).map(|mut stream| {
            let _ = stream.write_all(b"GET /callback?code=abc&state=drip HTTP/1.1\r\n\r\n");
            let _ = stream.flush();
        });
        let (outcome, took) = waiting.join().unwrap_or((Err("panicked".into()), Duration::ZERO));
        drop(dripper);
        check(
            "a slow client cannot block the real redirect",
            match (real, outcome) {
                (Ok(_), Ok(callback)) if callback.state == "drip" =>
                    Ok(format!("the callback arrived in {took:?} despite a dripping socket")),
                (Ok(_), other) => Err(format!("the sign-in did not complete: {other:?}")),
                (Err(why), _) => Err(format!("could not reach the listener: {why}")),
            },
        );
    }

    // Two more shapes of stray socket, either of which ends a sign-in if unguarded.
    // `read_line` has no length cap, so a client streaming bytes without a newline
    // grows the buffer until the allocator gives up - and an allocation failure aborts
    // whatever the panic strategy is. Two non-UTF-8 bytes fail the read immediately,
    // which propagates.
    {
        let waiting = std::thread::spawn(move || {
            sso::wait_for_callback(47632, "survives-junk", Duration::from_secs(8))
        });
        std::thread::sleep(Duration::from_millis(150));
        // A megabyte with no newline in it.
        if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", 47632)) {
            let _ = stream.write_all(&vec![b'A'; 1024 * 1024]);
            let _ = stream.flush();
        }
        // And bytes that are not text at all.
        if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", 47632)) {
            let _ = stream.write_all(&[0xff, 0xfe, 0x00, 0x01]);
            let _ = stream.flush();
        }
        std::thread::sleep(Duration::from_millis(200));
        let real = std::net::TcpStream::connect(("127.0.0.1", 47632)).map(|mut stream| {
            let _ = stream.write_all(b"GET /callback?code=abc&state=survives-junk HTTP/1.1\r\n\r\n");
            let _ = stream.flush();
        });
        check(
            "an oversized or non-text request does not end a sign-in",
            match (real, waiting.join()) {
                (Ok(_), Ok(Ok(callback))) if callback.state == "survives-junk" =>
                    Ok("a megabyte without a newline and four junk bytes were both ignored".into()),
                (Ok(_), Ok(other)) => Err(format!("the sign-in ended early: {other:?}")),
                (Err(why), _) => Err(format!("could not reach the listener: {why}")),
                (_, Err(_)) => Err("the listener panicked".into()),
            },
        );
    }

    // The configuration the shell will actually read, read the same way.
    //
    // `load_config` was dead code - the Linux build listed it among six unused
    // warnings on the unwired path - and a config reader that has never run is
    // how a typo becomes `invalid_client` from a server rather than a sentence
    // from this application.
    //
    // The client id is printed as a length and a prefix. It is not a secret,
    // and PKCE exists so a public client needs none - but it is an identity,
    // and there is no reason for a full one to sit in a terminal scrollback.
    {
        let directory = app_data_directory();
        // Absent and unconfigured are different answers. A machine that has never been
        // signed in on is not misconfigured, and saying so sends the reader looking for
        // a typo in a file that is not there.
        let present = directory.join(sso::CONFIG_FILE).is_file();
        let config = sso::load_config(&directory);
        check(
            "the SSO configuration reads",
            match config.fault() {
                Some(_) if !present => Ok(format!(
                    "no {} beside the application's data at {} - nothing to read, which is a first run rather than a fault",
                    sso::CONFIG_FILE,
                    directory.display()
                )),
                None => Ok(format!(
                    "client id {}... ({} chars), redirect {}",
                    config.client_id.chars().take(6).collect::<String>(),
                    config.client_id.len(),
                    config.redirect_uri()
                )),
                Some(why) => Err(why.chars().take(90).collect::<String>()),
            },
        );
        // The URL as CCP will actually receive it. An authorize request missing a
        // parameter is refused with a message about that parameter, which is
        // useless for finding out why it was missing.
        // Built with the scopes the application actually sends, not with an
        // empty list. A check that invents its own input can pass while the
        // URL the pilot is sent to is wrong - which is exactly what happened:
        // this probe said the shape was right while the real request asked for
        // no scopes and would have come back with no refresh token.
        let probe = sso::authorize_url(&config, &sso::Pkce::generate(), "probe-state", &FIRST_SLICE_SCOPES);
        check(
            "the authorize URL carries every parameter CCP requires",
            {
                let missing: Vec<&str> = ["response_type=code", "client_id=", "redirect_uri=",
                                          "state=", "code_challenge=", "code_challenge_method=S256"]
                    .into_iter()
                    .filter(|needle| !probe.contains(needle))
                    .collect();
                // An empty client id is only a fault when there is a config to
                // have read it from. On a machine that has never been signed in
                // on, the id is legitimately blank and the URL is legitimately
                // unusable - reporting that as a malformed URL sends the reader
                // to look for a bug in the builder rather than for a file that
                // was never created.
                let blank: Vec<&str> = ["client_id=&", "redirect_uri=&", "state=&", "code_challenge=&"]
                    .into_iter()
                    .filter(|needle| probe.contains(needle))
                    .filter(|needle| present || *needle != "client_id=&")
                    .collect();
                if missing.is_empty() && blank.is_empty() {
                    Ok(format!(
                        "{}{}...",
                        if present { "" } else { "no config here, so no client id - " },
                        probe.chars().take(110).collect::<String>()
                    ))
                } else {
                    Err(format!("missing {missing:?}, empty {blank:?} in {probe}"))
                }
            },
        );

        // The URL has to survive being handed to a browser, which is a separate
        // question from being built correctly - and the one that actually
        // failed. cmd treats an unquoted & as a command separator, so the
        // browser received one parameter and CCP reported, accurately and
        // uselessly, that client_id was required.
        let (program, args) = sso::browser_command(&probe);
        check(
            "the browser is launched without a command interpreter",
            if program.to_lowercase().contains("cmd") || program.to_lowercase().contains("powershell") {
                Err(format!("{program} parses its arguments; an authorize URL is mostly ampersands"))
            } else if args.last().map(String::as_str) == Some(probe.as_str()) {
                Ok(format!("{program}, with the whole URL as one argument"))
            } else {
                Err(format!("{program} does not receive the URL intact: {args:?}"))
            },
        );
        // And an absolute path, which is a different failure from the one above.
        //
        // Windows resolves a bare program name against the running executable's
        // own directory before System32. A `rundll32.exe` written beside this
        // binary would run as the pilot the moment they press "Add a character"
        // - and the binary lives in a user-writable directory for a portable
        // copy, for a build run out of Downloads, and for scripts/launch.ps1.
        check(
            "the browser launcher is an absolute path, not a bare name",
            {
                let absolute = if cfg!(windows) {
                    let bytes = program.as_bytes();
                    bytes.len() > 2 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/')
                } else {
                    program.starts_with('/')
                };
                // Absolute is mandatory on Windows, where a bare name resolves
                // against the executable's own directory before System32. On
                // Unix a bare name is the ordinary PATH model and not that
                // hole, so it is allowed - but it still has to resolve to
                // something, which is checked below.
                if absolute || !cfg!(windows) {
                    Ok(program.to_string())
                } else {
                    Err(format!(
                        "{program} is a bare name: Windows searches the executable's own directory before System32, so a planted file beside this binary would run instead"
                    ))
                }
            },
        );

        // Does the launcher this build chose actually exist on this machine?
        //
        // This was a paragraph in a handoff note asking a person on another
        // operating system to run `command -v xdg-open` and report back, because
        // the path had been written as a constant from a machine that could not
        // test it. A question a program can answer about the computer it is
        // running on does not belong in a document that goes stale.
        //
        // Failing here does not stop the map drawing. It stops sign-in, which
        // is worth saying out loud on the machine it is true of.
        check(
            "the browser launcher exists on this machine",
            if sso::browser_launcher_exists(&program) {
                Ok(format!("{program} is there"))
            } else {
                Err(format!(
                    "{program} does not exist here, so sign-in cannot open a browser. Everything else works; say where the launcher lives on this system."
                ))
            },
        );

        // Checked against CCP's own documented example rather than against what
        // this code happens to produce.
        check(
            "the authorize URL matches CCP's documented shape",
            {
                let mut wrong = Vec::new();
                if !probe.starts_with("https://login.eveonline.com/v2/oauth/authorize/?") {
                    wrong.push("the endpoint or its trailing slash");
                }
                if !probe.contains("code_challenge_method=S256") { wrong.push("S256"); }
                // A scope has to be there, and it is not a style preference:
                // CCP return a refresh token only when the authorize request
                // asked for at least one valid scope. An empty `scope=` is
                // worse than none - it invites being read as a scope whose name
                // is the empty string - so the parameter must be present and
                // carry something.
                if !probe.contains("&scope=") {
                    wrong.push("no scope at all, so CCP would return no refresh token");
                } else if probe.contains("&scope=&") || probe.ends_with("&scope=") {
                    wrong.push("an empty scope parameter");
                }
                if wrong.is_empty() {
                    Ok("endpoint, S256, and a non-empty scope".into())
                } else {
                    Err(format!("{wrong:?} in {probe}"))
                }
            },
        );
        check(
            "and a scope, when there is one, is sent",
            {
                let scoped = sso::authorize_url(&config, &sso::Pkce::generate(), "s",
                    &["esi-location.read_location.v1"]);
                if scoped.contains("&scope=esi-location.read_location.v1") {
                    Ok("present and unencoded where it is legal to be".into())
                } else {
                    Err(format!("scope missing from {scoped}"))
                }
            },
        );

        // And the URL genuinely is the shape that breaks a shell, so the check
        // above is not guarding a hazard that has stopped existing.
        check(
            "and the URL is the kind a shell would split",
            if probe.matches('&').count() >= 4 {
                Ok(format!("{} ampersands", probe.matches('&').count()))
            } else {
                Err("the authorize URL no longer has ampersands to split on".into())
            },
        );

        check(
            "and the redirect matches what must be registered",
            if config.redirect_uri() == "http://localhost:47624/callback" {
                Ok("character for character".into())
            } else {
                Err(format!("would use {}", config.redirect_uri()))
            },
        );
    }

    // --- the exchange, as far as it can go without CCP -----------------------
    //
    // The body is built separately from the request precisely so this can be
    // checked: whether this is a PKCE exchange at all comes down to the
    // verifier being present and no secret being anywhere near it.
    {
        let config = sso::SsoConfig { client_id: "test-client".into(), callback_port: 47624 };
        let pkce = sso::Pkce::generate();
        let code = sso::Secret::new("THE-AUTHORIZATION-CODE");
        let body = sso::exchange_body(&config, &pkce, &code);
        check(
            "the exchange sends the verifier and the code",
            if body.contains(pkce.verifier.expose()) && body.contains("THE-AUTHORIZATION-CODE")
                && body.contains("grant_type=authorization_code") {
                Ok("both present, as an authorization_code grant".into())
            } else {
                Err("the body is missing the verifier or the code".into())
            },
        );
        check(
            "and carries no client secret",
            if !body.contains("client_secret") && !body.contains("secret") {
                Ok("PKCE only - a public client needs none, and none is stored".into())
            } else {
                Err(format!("the body mentions a secret: {body}"))
            },
        );
        let refreshed = sso::refresh_body(&config, &sso::Secret::new("A-REFRESH-TOKEN"));
        check(
            "a refresh sends the token and no secret",
            if refreshed.contains("grant_type=refresh_token")
                && refreshed.contains("A-REFRESH-TOKEN")
                && !refreshed.contains("secret") {
                Ok("refresh_token grant, no secret".into())
            } else {
                Err(format!("unexpected refresh body: {refreshed}"))
            },
        );
    }

    // --- what a validated token is allowed to mean ---------------------------
    //
    // The claim interpretation, checkable without crypto because it is split
    // from the signature check. The signature is what makes the claims
    // trustworthy; this is what they are permitted to say afterwards.
    {
        use serde_json::json;
        let ok = sso::character_from_claims("CHARACTER:EVE:2117884248", "Some Pilot", &json!(""), 99);
        check(
            "a character subject yields that character",
            match ok {
                Ok(c) if c.id == 2117884248 && c.name == "Some Pilot" => Ok("id and name read".into()),
                other => Err(format!("{other:?}")),
            },
        );
        for subject in ["CORPORATION:EVE:98000001", "CHARACTER:EVE:abc", "CHARACTER:EVE:0",
                        "CHARACTER:EVE:-5", "2117884248", ""] {
            check(
                &format!("{subject:?} is refused as a character"),
                match sso::character_from_claims(subject, "x", &json!(""), 99) {
                    Err(_) => Ok("refused".into()),
                    Ok(c) => Err(format!("accepted as character {}", c.id)),
                },
            );
        }

        // Scopes arrive as a string when there is one and a list when there are
        // several. A client that assumes the list reads a single-scope token as
        // having none, which silently disables whatever that scope was for.
        let scopes = |value: serde_json::Value| {
            sso::character_from_claims("CHARACTER:EVE:1", "x", &value, 99)
                .map(|c| c.scopes.join(","))
                .unwrap_or_default()
        };
        check(
            "scopes are read in both shapes the claim can take",
            {
                let single = scopes(json!("esi-location.read_location.v1"));
                let many = scopes(json!(["esi-location.read_location.v1", "esi-fleets.read_fleet.v1"]));
                let spaced = scopes(json!("esi-location.read_location.v1 esi-fleets.read_fleet.v1"));
                let none = scopes(json!(""));
                if single == "esi-location.read_location.v1"
                    && many.split(',').count() == 2
                    && spaced.split(',').count() == 2
                    && none.is_empty() {
                    Ok("a string, a space-separated string, a list, and none".into())
                } else {
                    Err(format!("single={single:?} many={many:?} spaced={spaced:?} none={none:?}"))
                }
            },
        );
    }

    // --- signature failures that need no valid signature ---------------------
    {
        let jwks = r#"{"keys":[{"kid":"known","n":"abc","e":"AQAB","alg":"RS256"}]}"#;
        for (token, why) in [
            ("not-a-token", "malformed"),
            // Header with no kid: {"alg":"RS256"}
            ("eyJhbGciOiJSUzI1NiJ9.e30.x", "no signing key named"),
            // Header naming a key the set does not have: {"alg":"RS256","kid":"other"}
            ("eyJhbGciOiJSUzI1NiIsImtpZCI6Im90aGVyIn0.e30.x", "unknown signing key"),
        ] {
            check(
                &format!("an access token that is {why} is refused"),
                match sso::character_from(token, jwks, "test-client") {
                    Err(_) => Ok("refused".into()),
                    Ok(c) => Err(format!("accepted, yielding character {}", c.id)),
                },
            );
        }
    }

    // A token that actually reaches the signature check.
    //
    // The three refusals above all happen *before* any crypto runs - a
    // malformed token fails at the header, an unnamed or unknown key fails at
    // the lookup. So none of them touched jsonwebtoken's verifier, and the
    // build shipped with no crypto provider selected at all. The first thing to
    // discover that was a real sign-in, where the library panicked inside a
    // worker: caught in a debug build, and silently fatal in release, which at the
    // time set `panic = "abort"`. That profile setting has since been removed - see
    // the check below - but the missing provider was a real bug either way.
    //
    // This uses the RSA public key published as an example in RFC 7517 - a
    // public key from a specification, so nothing secret enters the repository
    // and no private key has to be generated. The signature cannot verify, and
    // that is the point: reaching a signature failure proves the verifier ran.
    {
        const RFC7517_N: &str = "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw";
        const RFC7517_E: &str = "AQAB";
        let jwks = format!(
            r#"{{"keys":[{{"kid":"spec-example","n":"{RFC7517_N}","e":"{RFC7517_E}","alg":"RS256"}}]}}"#
        );
        // Header {"alg":"RS256","kid":"spec-example"}, a claims body, and a
        // signature that is merely bytes.
        let token = "eyJhbGciOiJSUzI1NiIsImtpZCI6InNwZWMtZXhhbXBsZSJ9.eyJzdWIiOiJDSEFSQUNURVI6RVZFOjEiLCJleHAiOjk5OTk5OTk5OTl9.aGVsbG8";
        // No placeholder to be overwritten. The `Err("not run")` that used to
        // initialise this was never read - the match below assigns on both arms
        // - and a value that cannot be observed is a value that lies about
        // whether a path exists.
        let outcome = match std::panic::catch_unwind(|| sso::character_from(token, &jwks, "test-client")) {
            Ok(result) => result.map(|c| format!("unexpectedly accepted character {}", c.id)),
            Err(_) => Err("the verifier PANICKED - no crypto provider is selected".to_string()),
        };
        check(
            "the signature verifier runs rather than panicking",
            match outcome {
                Err(why) if why.contains("PANICKED") => Err(why),
                Err(why) if why.contains("did not validate") =>
                    Ok(format!("reached the signature check and refused: {}", why.chars().take(60).collect::<String>())),
                Err(why) => Err(format!("failed before the signature check: {why}")),
                Ok(what) => Err(what),
            },
        );
    }

    // --- an unreadable character list ------------------------------------------
    //
    // The store law applied to the vault: absent is an empty list, unreadable is an
    // error. Separate checks, because one code path for both does not produce "the list
    // looks wrong" - it produces the list being silently replaced with an empty one by
    // the next write, with the refresh tokens left orphaned in the operating system's
    // credential store where nothing in the application can reach them again.
    {
        let vault = std::env::temp_dir().join(format!("atlas-vault-check-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::create_dir_all(&vault);
        let file = vault.join(sso::VAULT_FILE);

        check(
            "no character list at all is an empty vault, not an error",
            match sso::load_vault_state(&vault) {
                Ok(entries) if entries.is_empty() => Ok("a first run reads as no characters".into()),
                Ok(entries) => Err(format!("invented {} character(s)", entries.len())),
                Err(why) => Err(format!("a first run reported a failure: {why}")),
            },
        );

        let _ = std::fs::write(&file, "{ this is not a character list");
        check(
            "an unreadable character list is reported, never read as empty",
            match sso::load_vault_state(&vault) {
                Err(why) if why.contains("left alone") => Ok("refused and said the file was kept".into()),
                Err(why) => Err(format!("reported, but did not say the file was kept: {why}")),
                Ok(entries) => Err(format!(
                    "returned {} character(s) - a corrupt file read as an empty vault, which the next write would make permanent",
                    entries.len()
                )),
            },
        );

        let _ = std::fs::write(&file, "
");
        check(
            "a half-written character list is not an empty one",
            match sso::load_vault_state(&vault) {
                Err(_) => Ok("an empty file is treated as a crash mid-write".into()),
                Ok(entries) => Err(format!("read a truncated file as {} character(s)", entries.len())),
            },
        );

        // And the round trip, so the strict reader is not merely strict.
        let entry = sso::VaultEntry {
            character_id: 90000001,
            name: "Test Pilot".into(),
            scopes: vec!["publicData".into()],
            added_at: 1,
            last_refresh_at: 2,
            last_refresh_error: None,
        };
        let mut entries = Vec::new();
        sso::upsert(&mut entries, entry.clone());
        let saved = sso::save_vault(&vault, &entries);
        check(
            "a saved character list reads back as itself",
            match saved.and_then(|()| sso::load_vault_state(&vault)) {
                Ok(read) if read.len() == 1 && read[0].character_id == 90000001 => {
                    Ok(format!("{} character round-tripped", read.len()))
                }
                Ok(read) => Err(format!("read back {} entries", read.len())),
                Err(why) => Err(why),
            },
        );

        // Re-authorising must not duplicate, and must keep when it was added.
        let again = sso::VaultEntry { added_at: 999, last_refresh_at: 3, ..entry };
        let mut entries = sso::load_vault_state(&vault).unwrap_or_default();
        sso::upsert(&mut entries, again);
        check(
            "signing the same character in again updates rather than duplicates",
            if entries.len() == 1 && entries[0].added_at == 1 && entries[0].last_refresh_at == 3 {
                Ok("one entry, original added_at kept, refresh time moved".into())
            } else {
                Err(format!(
                    "{} entries, added_at {}, last_refresh_at {}",
                    entries.len(), entries[0].added_at, entries[0].last_refresh_at
                ))
            },
        );

        // Two writers at once, which is the vault's real concurrency and had no
        // check at all. `token_forget` is a synchronous command and runs on the
        // main thread; `token_begin` is async and finishes its save on the
        // runtime - so a forget clicked while a sign-in completes is exactly
        // this. The old scratch name was one per process, so the second writer
        // truncated the first's file and renamed the splice into place.
        //
        // CHECKED AS A MECHANISM, BECAUSE THE SYMPTOM DOES NOT SHOW UP.
        //
        // The first version of this check raced two saves of very different
        // sizes for twenty-four rounds and asserted the file still parsed. With
        // the lock removed and the per-process name restored, it passed - the
        // window is too narrow to hit without a payload of megabytes and an
        // unlucky interleaving. It would have shipped as proof of a fix it
        // could not detect.
        //
        // What actually prevents the splice is that no two writers can choose
        // the same scratch path, so that is what is checked, directly and
        // deterministically. A counter, not a clock: SystemTime's granularity
        // is coarser than this loop, and a timestamp-based name collides here.
        {
            let target = vault.join("live-store.json");
            let mut names = std::collections::HashSet::new();
            let mut collisions = 0;
            std::thread::scope(|scope| {
                let handles: Vec<_> = (0..8)
                    .map(|_| scope.spawn(|| {
                        (0..500).map(|_| sso::scratch_path(&target)).collect::<Vec<_>>()
                    }))
                    .collect();
                for handle in handles {
                    for name in handle.join().unwrap_or_default() {
                        if !names.insert(name) {
                            collisions += 1;
                        }
                    }
                }
            });
            check(
                "no two vault writers can choose the same scratch file",
                if collisions == 0 {
                    Ok(format!("{} names from 8 threads, all distinct", names.len()))
                } else {
                    Err(format!(
                        "{collisions} collision(s) in {} names - two writers would truncate each other and rename the splice into place",
                        names.len() + collisions
                    ))
                },
            );
        }

        // And the round trip under real concurrency, which is worth having as
        // well: it is not what catches the bug, but it is what would notice a
        // fix that made the names unique and broke something else.
        {
            let wide: Vec<sso::VaultEntry> = (0..400)
                .map(|n| sso::VaultEntry {
                    character_id: 91_000_000 + n,
                    name: "A Pilot With A Reasonably Long Name".into(),
                    scopes: vec!["esi-location.read_location.v1".into()],
                    added_at: n,
                    last_refresh_at: n,
                    last_refresh_error: None,
                })
                .collect();
            let narrow = vec![wide[0].clone()];
            let mut unreadable = 0;
            for _ in 0..24 {
                std::thread::scope(|scope| {
                    scope.spawn(|| { let _ = sso::save_vault(&vault, &wide); });
                    scope.spawn(|| { let _ = sso::save_vault(&vault, &narrow); });
                });
                if sso::load_vault_state(&vault).is_err() {
                    unreadable += 1;
                }
            }
            let left = std::fs::read_dir(&vault)
                .map(|entries| {
                    entries
                        .filter_map(|entry| entry.ok())
                        .filter(|entry| entry.file_name().to_string_lossy().contains(".writing"))
                        .count()
                })
                .unwrap_or(0);
            check(
                "concurrent vault saves leave a readable file and no scratch",
                if unreadable == 0 && left == 0 {
                    Ok("24 rounds of two concurrent writers".into())
                } else {
                    Err(format!("{unreadable} of 24 rounds unreadable, {left} scratch file(s) left"))
                },
            );
        }

        let _ = std::fs::remove_dir_all(&vault);
    }

    // --- the cached portrait ---------------------------------------------------
    //
    // A portrait is the only other thing on disk that names a character, so
    // "forget" has to take it with the credential and the list entry. Checked
    // here without a network: the fetch is CCP's business, the cache is ours.
    {
        let cache = std::env::temp_dir().join(format!("atlas-portrait-check-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cache);
        let _ = std::fs::create_dir_all(&cache);
        const WHO: i64 = 92000001;

        check(
            "no cached portrait is not an error",
            match sso::cached_portrait(&cache, WHO) {
                None => Ok("a character with no picture yet reads as no picture".into()),
                Some(bytes) => Err(format!("invented {} bytes", bytes.len())),
            },
        );

        let pretend = b"\xff\xd8\xff\xe0 not really a jpeg, but bytes are bytes";
        let stored = sso::store_portrait(&cache, WHO, pretend);
        check(
            "a portrait is cached and read back byte for byte",
            match stored.map(|()| sso::cached_portrait(&cache, WHO)) {
                Ok(Some(back)) if back == pretend => Ok(format!("{} bytes round-tripped", back.len())),
                Ok(Some(back)) => Err(format!("read back {} different bytes", back.len())),
                Ok(None) => Err("stored and then could not be read".into()),
                Err(why) => Err(why),
            },
        );

        check(
            "a cached portrait leaves no scratch file",
            match std::fs::read_dir(sso::portrait_dir(&cache)) {
                Ok(entries) => {
                    let strays: Vec<String> = entries
                        .filter_map(|entry| entry.ok())
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .filter(|name| name.contains(".writing"))
                        .collect();
                    if strays.is_empty() {
                        Ok("only the portrait itself".into())
                    } else {
                        Err(format!("{strays:?}"))
                    }
                }
                Err(why) => Err(why.to_string()),
            },
        );

        // The webview can only display what the page's own policy allows, and
        // that policy is `img-src 'self' data:`. A URI of any other shape would
        // be refused by the webview and show as a blank frame with no error
        // anywhere, which is the hardest kind of broken to see.
        let uri = sso::portrait_data_uri(pretend);
        check(
            "a portrait is handed over as a data URI the page's policy permits",
            if uri.starts_with("data:image/jpeg;base64,") && uri.len() > 30 {
                Ok(format!("{}...", uri.chars().take(34).collect::<String>()))
            } else {
                Err(format!("{}...", uri.chars().take(40).collect::<String>()))
            },
        );

        let forgotten = sso::forget_portrait(&cache, WHO);
        check(
            "forgetting a character deletes its cached portrait",
            match forgotten.map(|()| sso::cached_portrait(&cache, WHO)) {
                Ok(None) if !sso::portrait_path(&cache, WHO).exists() =>
                    Ok("the file is gone from disk, not merely unreadable".into()),
                Ok(None) => Err("unreadable, but the file is still there".into()),
                Ok(Some(_)) => Err("the portrait survived being forgotten".into()),
                Err(why) => Err(why),
            },
        );

        check(
            "forgetting a portrait that was never cached is not an error",
            match sso::forget_portrait(&cache, WHO) {
                Ok(()) => Ok("absent is success - the caller asked for it gone and it is".into()),
                Err(why) => Err(why),
            },
        );

        // The one that matters, and the reason the others exist: token_forget
        // must call this at all. A portrait cache that is only ever added to is
        // a picture of a pilot left in the application data directory after
        // they asked to be forgotten.
        let source = include_str!("main.rs");
        check(
            "token_forget removes the portrait as well as the credential",
            {
                let body = source
                    .split("fn token_forget")
                    .nth(1)
                    .and_then(|rest| rest.split("async fn").next())
                    .unwrap_or("");
                let has = |needle: &str| body.contains(needle);
                let missing: Vec<&str> = ["forget_refresh", "forget_portrait", "save_vault"]
                    .into_iter()
                    .filter(|needle| !has(needle))
                    .collect();
                if missing.is_empty() {
                    Ok("credential, portrait and list entry all removed in one place".into())
                } else {
                    Err(format!("token_forget never calls {missing:?}"))
                }
            },
        );

        let _ = std::fs::remove_dir_all(&cache);
    }

    // --- a panicking worker --------------------------------------------------
    //
    // Every fallible step of `token_begin` runs on a blocking worker, and each
    // `.await` on one ends in `.map_err(|e| format!("... failed: {e}"))`. Those
    // arms are reachable only if a panicking worker unwinds. Under
    // `panic = "abort"` the process dies first, every one of them is dead code,
    // and the pilot gets a window that vanishes instead of a sentence.
    //
    // That is not hypothetical and it is not about care taken in this file. Our
    // own code in those workers has no unwrap, no expect and no indexing that
    // can fail; every panic they can produce belongs to a dependency. One
    // already did - jsonwebtoken panics rather than erroring when no crypto
    // provider is selected - and it was readable only because it was caught in
    // a debug build. The same defect in a release build would have said nothing
    // at all.
    //
    // So this runs the mechanism rather than asserting it. A thread, not a
    // Tauri worker, because the mechanism under test is the runtime's unwinding
    // and it is the same one.
    {
        const NAME: &str = "a panicking worker is reported rather than killing the application";
        #[cfg(panic = "abort")]
        check(
            NAME,
            Err::<String, String>(
                "this build sets panic = abort, under which a panic in any worker ends the process and every error message in token_begin is unreachable"
                    .into(),
            ),
        );
        #[cfg(not(panic = "abort"))]
        {
            let previous = std::panic::take_hook();
            std::panic::set_hook(Box::new(|_| {}));   // the panic is expected; do not print it
            let worker = std::thread::spawn(|| -> String { panic!("a dependency gave up") });
            let outcome = worker.join();
            std::panic::set_hook(previous);
            check(
                NAME,
                match outcome {
                    Err(_) => Ok("the worker's panic came back as a value the caller can report".into()),
                    Ok(_) => Err("the worker did not panic, so the check proved nothing".into()),
                },
            );
        }
    }

    // --- the credential store ------------------------------------------------
    //
    // Exercised against the real operating-system store, because the whole
    // reason this application has a Rust core is that a refresh token must not
    // live in browser storage. A wrapper that has never stored anything proves
    // nothing about that.
    {
        const PROBE: i64 = -424242;   // never a real character id
        let secret = sso::Secret::new("a-refresh-token-that-is-not-real");
        let stored = sso::store_refresh(PROBE, &secret);
        let loaded = sso::load_refresh(PROBE);
        let forgotten = sso::forget_refresh(PROBE);
        let after = sso::load_refresh(PROBE);
        check(
            "a refresh token round-trips through the OS credential store",
            match (&stored, &loaded) {
                (Ok(()), Ok(Some(back))) if back.expose() == secret.expose() =>
                    Ok("stored and read back".into()),
                (Ok(()), Ok(other)) => Err(format!("read back {other:?}")),
                (Err(why), _) | (_, Err(why)) => Err(why.clone()),
            },
        );
        // This one cannot pass on its own evidence.
        //
        // It read `(forgotten, after)` alone, and on a machine where the store
        // refused the write it passed anyway: forgetting an absent credential is
        // success - the next check says so deliberately - and reading an empty
        // store gives `Ok(None)`. So it reported "gone from the store, not
        // merely hidden" having never had anything to remove, sitting directly
        // beneath the failure that said nothing was ever stored.
        //
        // It is the pair that is the evidence. If the store never took the
        // token, this check has not been run rather than passed, and says so.
        // Found by the Linux box, 2026-09-20, on a machine with no default
        // keyring collection.
        check(
            "and forgetting it actually removes it",
            match (&stored, &forgotten, &after) {
                (Err(_), _, _) => Err(
                    "not run: nothing was stored above, so there was nothing to remove and a pass here would mean nothing"
                        .into(),
                ),
                (_, Ok(()), Ok(None)) => Ok("gone from the store, not merely hidden".into()),
                (_, Ok(()), Ok(Some(_))) => Err("the credential survived being forgotten".into()),
                (_, Err(why), _) | (_, _, Err(why)) => Err(why.clone()),
            },
        );
        check(
            "forgetting a character that was never stored is not an error",
            match sso::forget_refresh(PROBE) {
                Ok(()) => Ok("absent is success - the caller asked for it gone and it is".into()),
                Err(why) => Err(why),
            },
        );
    }

    // A credential must not be printable.
    //
    // The hazard is not that anyone writes `println!("{code}")` on purpose. It
    // is one `{:?}` in a log line, one panic carrying a struct, one `.expect()`
    // on a Result holding it - and the code is on disk in plain text, where it
    // buys a refresh token, which is a long-lived character credential.
    let leaky = sso::Callback {
        code: sso::Secret::new("SUPER-SECRET-AUTHORIZATION-CODE"),
        state: "a-state".into(),
        refusal: None,
    };
    check(
        "an authorization code is not printable",
        if !format!("{leaky:?}").contains("SUPER-SECRET-AUTHORIZATION-CODE") {
            Ok(format!("{leaky:?}"))
        } else {
            Err("Debug printed the code verbatim".into())
        },
    );
    let secret_pkce = sso::Pkce::generate();
    check(
        "nor is a code verifier",
        if !format!("{secret_pkce:?}").contains(secret_pkce.verifier.expose()) {
            Ok("redacted, with the challenge still shown for diagnosis".into())
        } else {
            Err("Debug printed the verifier verbatim".into())
        },
    );

    // The refusal a pilot sees may name why it failed - access_denied, a state
    // mismatch - and must never quote the code back.
    let mismatch = {
        let expected = "expected-state";
        let waiting = std::thread::spawn(move || {
            sso::wait_for_callback(47626, expected, std::time::Duration::from_secs(5))
        });
        std::thread::sleep(std::time::Duration::from_millis(150));
        let _ = std::net::TcpStream::connect(("127.0.0.1", 47626)).map(|mut stream| {
            let _ = stream.write_all(
                b"GET /callback?code=LEAKY-CODE-VALUE&state=wrong HTTP/1.1\r\n\r\n",
            );
            let _ = stream.flush();
        });
        waiting.join().unwrap_or(Err("the listener panicked".into()))
    };
    check(
        "an ignored redirect is never quoted back",
        match mismatch {
            Err(why) if why.contains("LEAKY-CODE-VALUE") =>
                Err(format!("the message quoted the code: {why}")),
            Err(why) => Ok(format!("says what happened without the code: {}", why.chars().take(60).collect::<String>())),
            Ok(_) => Err("the mismatched redirect was accepted".into()),
        },
    );

    // An unconfigured application refuses locally rather than asking CCP to
    // reject it, which returns `invalid_client` and sends the diagnosis to the
    // wrong place.
    check(
        "an unregistered application says so without calling CCP",
        match sso::SsoConfig::default().fault() {
            Some(why) if why.contains("developers.eveonline.com") && why.contains("47624") =>
                Ok("names where to register and what callback to use".into()),
            Some(why) => Err(format!("unhelpful: {why}")),
            None => Err("an empty client id was treated as configured".into()),
        },
    );

    // The redirect CCP registers says "localhost", and a browser resolves that
    // to ::1 first on Windows. A listener that only answers on 127.0.0.1 works
    // by falling back after a refusal and hangs when a firewall drops instead,
    // which is a sign-in that spins forever with nothing in any log.
    for family in ["::1", "127.0.0.1"] {
        let waiting = std::thread::spawn(move || {
            sso::wait_for_callback(47627, "family-check", std::time::Duration::from_secs(5))
        });
        std::thread::sleep(std::time::Duration::from_millis(150));
        let reached = std::net::TcpStream::connect((family, 47627)).map(|mut stream| {
            let _ = stream.write_all(
                b"GET /callback?code=abc&state=family-check HTTP/1.1\r\n\r\n",
            );
            let _ = stream.flush();
        });
        check(
            &format!("the sign-in redirect is answered on {family}"),
            match (reached, waiting.join()) {
                (Ok(_), Ok(Ok(callback))) if callback.state == "family-check" =>
                    Ok("the callback arrived".into()),
                (Ok(_), Ok(other)) => Err(format!("connected but got {other:?}")),
                (Err(why), _) => Err(format!("could not reach it: {why}")),
                (_, Err(_)) => Err("the listener panicked".into()),
            },
        );
    }

    // A socket that connects and says nothing at all.
    //
    // This is what a browser preconnect actually is, and it is the case the
    // check below names in its comment and does not exercise: all three of its
    // "noise" requests are complete request lines. The motivating bug was a
    // silent socket, so the silent socket is worth its own check.
    //
    // It reports the cost rather than asserting it. A silent connection is ended
    // by the socket's read timeout rather than by the request budget, because
    // the budget is only consulted between reads and a silent socket never
    // produces a second one - so the measured time is two budgets, serially.
    //
    // Deliberately not a timing assertion: the margin that would catch a
    // regression from three seconds to five is the same margin that fails on a
    // loaded machine, and a flaky check is worse than a reported number. The
    // number is in the output for a human to read.
    {
        let waiting = std::thread::spawn(move || {
            sso::wait_for_callback(47634, "survives-silence", Duration::from_secs(20))
        });
        std::thread::sleep(Duration::from_millis(150));
        let started = std::time::Instant::now();
        // Held open, deliberately never written to, and not dropped until the
        // sign-in has finished - a preconnect the browser is still holding.
        let silent: Vec<_> = (0..2)
            .filter_map(|_| std::net::TcpStream::connect(("127.0.0.1", 47634)).ok())
            .collect();
        let real = std::net::TcpStream::connect(("127.0.0.1", 47634)).map(|mut stream| {
            let _ = stream.write_all(b"GET /callback?code=abc&state=survives-silence HTTP/1.1\r\n\r\n");
            let _ = stream.flush();
        });
        let outcome = waiting.join();
        let took = started.elapsed();
        drop(silent);
        check(
            "sockets that connect and send nothing do not end a sign-in",
            match (real, outcome) {
                (Ok(_), Ok(Ok(callback))) if callback.state == "survives-silence" => {
                    Ok(format!("two silent preconnects ignored, callback arrived after {took:?}"))
                }
                (Ok(_), Ok(other)) => Err(format!("the sign-in ended early: {other:?}")),
                (Err(why), _) => Err(format!("could not reach the listener: {why}")),
                (_, Err(_)) => Err("the listener panicked".into()),
            },
        );
    }

    // A browser opening a speculative connection, or asking for a favicon, must
    // not end a sign-in the pilot is still approving.
    {
        let waiting = std::thread::spawn(move || {
            sso::wait_for_callback(47628, "survives-noise", std::time::Duration::from_secs(6))
        });
        std::thread::sleep(std::time::Duration::from_millis(150));
        for noise in [
            &b"GET /favicon.ico HTTP/1.1\r\n\r\n"[..],
            &b"GET / HTTP/1.1\r\n\r\n"[..],
            &b"GET /callback HTTP/1.1\r\n\r\n"[..],
        ] {
            if let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", 47628)) {
                let _ = stream.write_all(noise);
                let _ = stream.flush();
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        let real = std::net::TcpStream::connect(("127.0.0.1", 47628)).map(|mut stream| {
            let _ = stream.write_all(
                b"GET /callback?code=abc&state=survives-noise HTTP/1.1\r\n\r\n",
            );
            let _ = stream.flush();
        });
        check(
            "stray connections do not end a sign-in",
            match (real, waiting.join()) {
                (Ok(_), Ok(Ok(callback))) if callback.state == "survives-noise" =>
                    Ok("three noise requests ignored, the real one answered".into()),
                (Ok(_), Ok(other)) => Err(format!("the sign-in ended early: {other:?}")),
                (Err(why), _) => Err(format!("could not reach the listener: {why}")),
                (_, Err(_)) => Err("the listener panicked".into()),
            },
        );
    }

    // One sign-in, two sockets: whichever family answers, both must close, or
    // the next token.begin cannot bind the port it already half-owns.
    check(
        "both loopback listeners are released together",
        match (
            std::net::TcpListener::bind(("127.0.0.1", 47628)),
            std::net::TcpListener::bind(("::1", 47628)),
        ) {
            (Ok(_), Ok(_)) => Ok("IPv4 and IPv6 both free after the callback".into()),
            (Err(why), _) => Err(format!("127.0.0.1 still held: {why}")),
            (_, Err(why)) => Err(format!("::1 still held: {why}")),
        },
    );

    // Single use is structural rather than enforced by a slot: `token_begin` creates
    // the verifier, moves it into the exchange and drops it, so there is nothing to
    // redeem twice and no holder type to check.

    failures
}

// The repository root, from wherever the binary was started.
//
// `cargo run` runs from the manifest directory, a packaged build from anywhere
// at all, and a developer from the project root. Walking up for a marker is the
// only one of those that works in all three.
fn project_root() -> PathBuf {
    let mut candidate = std::env::current_dir().unwrap_or_default();
    loop {
        if candidate.join("web").join("index.html").is_file() {
            return candidate;
        }
        if !candidate.pop() {
            return std::env::current_dir().unwrap_or_default();
        }
    }
}

fn main() {
    // TEMPORARY: reach CCP's public signing-key endpoint and say what happened.
    // No credentials, no token, one GET. Removed once the exchange is proven.
    if std::env::args().any(|argument| argument == "--probe-network") {
        match sso::fetch_jwks() {
            Ok(body) => println!("jwks ok, {} bytes, starts {}", body.len(),
                body.chars().take(60).collect::<String>()),
            Err(why) => println!("jwks FAILED: {why}"),
        }
        std::process::exit(0);
    }

    // A diagnostic for the portrait path, because every failure in it is
    // deliberately silent in the window: the command answers Ok(None) for
    // offline, for a character with no picture and for a refused request, and
    // the page swallows the rest, so a row with no face says nothing about why.
    // That is right for a pilot and useless for finding out what happened.
    if let Some(index) = std::env::args().position(|argument| argument == "--portrait") {
        let id: i64 = std::env::args()
            .nth(index + 1)
            .and_then(|raw| raw.parse().ok())
            .unwrap_or(0);
        println!("url: {}", sso::portrait_url(id));
        match sso::fetch_portrait(id) {
            Ok(bytes) => println!("fetched {} bytes", bytes.len()),
            Err(why) => println!("FAILED: {why}"),
        }
        std::process::exit(0);
    }

    if std::env::args().any(|argument| argument == "--selftest") {
        let root = project_root();
        println!("New Eden Atlas shell, headless checks (from {}):", root.display());
        let failures = selftest(root);
        println!(
            "{}",
            if failures == 0 {
                "all checks passed"
            } else {
                "SOME CHECKS FAILED"
            }
        );
        std::process::exit(i32::from(failures != 0));
    }

    tauri::Builder::default()
        .manage(Started(Instant::now()))
        .manage(Sidecar::default())
        .manage(SidecarReport::default())
        .invoke_handler(tauri::generate_handler![
            shell_status, sightings_load, sightings_save,
            token_begin, token_characters, token_forget, character_portrait,
            advisor_status, advisor_request
        ])
        // A supervised process must not outlive the window that started it.
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<Sidecar>() {
                    shutdown_sidecar(&state);
                }
            }
        })
        .setup(|app| {
            // Optional, and reported rather than enforced. Nothing in the
            // viewer needs it yet, and the law says the core works with zero
            // optional components - so a missing or misbehaving sidecar leaves
            // a note and a window that still draws the map.
            let note = match locate_sidecar(app.handle()) {
                None => "no sidecar present; the shell is running without one".to_string(),
                Some((program, argument)) => match spawn_sidecar(&program, argument.as_ref()) {
                    Ok(process) => {
                        let pid = process.pid;
                        {
                            let sidecar = app.state::<Sidecar>();
                            let mut slot = sidecar
                                .0
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            *slot = Some(process);
                            // Recorded beside the lock as well as inside it, so the
                            // close handler can name this process without waiting for
                            // an exchange to finish. Set here and cleared in exactly
                            // one other place, `stop_sidecar_locked`.
                            sidecar.1.store(pid, std::sync::atomic::Ordering::SeqCst);
                        }
                        format!("sidecar running as pid {pid}")
                    }
                    Err(why) => format!("the sidecar did not start: {why}"),
                },
            };
            {
                let slot = app.state::<SidecarReport>();
                let mut report = slot
                    .0
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                *report = note;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the shell failed to start");
}
