// EVE SSO: the authorization code flow with PKCE, which is what CCP's
// documentation specifies for a local application.
//
// The flow runs in the core rather than the webview. A refresh token is a
// long-lived character credential, CCP's guidance places it in the operating
// system's credential store, and a page has only `localStorage`. The webview
// never sees a token of any kind: not the refresh token, and not the access
// token either, because the core makes the authenticated calls itself.
//
// Nothing in this file talks to CCP. It holds the parts that can be checked
// without a network or a registered application: deriving a challenge from a
// verifier, building the authorize URL, and receiving the one redirect back.

use std::io::{BufReader, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener};
use std::time::{Duration, Instant};

use base64::Engine;
use sha2::{Digest, Sha256};

// Trailing slash, as CCP's own example writes it:
// `https://login.eveonline.com/v2/oauth/authorize/?response_type=code...`
// The form without it is answered too, but a redirect between the two is a
// place a query string can be dropped, and matching the documented shape
// costs nothing.
pub const AUTHORIZE_URL: &str = "https://login.eveonline.com/v2/oauth/authorize/";
pub const TOKEN_URL: &str = "https://login.eveonline.com/v2/oauth/token";
pub const JWKS_URL: &str = "https://login.eveonline.com/oauth/jwks";

// One string for every server this process talks to.
//
// It names the same application, version and publisher as the page, plus the
// tier: a rate limit earned by the map is not one earned by sign-in. CCP ask for
// an application name with version and a contact address; this carries the first,
// and a published build may add a contact route on the page side. There is no
// route from the webview to this constant, so a page cannot present itself to CCP
// as a different application.
pub const USER_AGENT: &str = "NewEdenAtlas/1.0 (Sensitive Electronics; desktop shell)";

// Fixed, and it has to be: CCP match the redirect against the one registered
// with the application, exactly. An ephemeral port would be more polite to the
// machine and would fail every time.
pub const DEFAULT_CALLBACK_PORT: u16 = 47624;

#[derive(Clone, Debug)]
pub struct SsoConfig {
    pub client_id: String,
    pub callback_port: u16,
}

impl Default for SsoConfig {
    fn default() -> Self {
        Self {
            client_id: String::new(),
            callback_port: DEFAULT_CALLBACK_PORT,
        }
    }
}

impl SsoConfig {
    pub fn redirect_uri(&self) -> String {
        format!("http://localhost:{}/callback", self.callback_port)
    }

    // An application that has not been registered cannot authenticate, and
    // saying so plainly beats a failed round trip to CCP that reports
    // `invalid_client`.
    pub fn fault(&self) -> Option<String> {
        if self.client_id.trim().is_empty() {
            return Some(format!(
                "No EVE application is configured. Register one at https://developers.eveonline.com with the callback {} and put its client id in sso.json beside the application's data.",
                self.redirect_uri()
            ));
        }
        None
    }
}

const URL_SAFE: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

// --- a value that cannot be printed by accident ----------------------------------
//
// A redacting Debug on a struct protects the struct. A secret moved out of it
// into a request body is a bare String again, which is where an HTTP client's
// error reports would carry it.
//
// So the secret is a type rather than a field convention. It redacts under
// Debug, has no Display at all - so it cannot be interpolated into a string by
// habit - and is read only through `expose()`, which is deliberately ugly and
// greppable: every place a credential is read can be listed with one search.
//
// It covers the code verifier, the authorization code, and the refresh and
// access tokens. `state` is not a secret - it is an unguessable binding rather
// than a bearer, and it is the useful half of a mismatch report - and the client
// id is an identity, so both stay printable.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}

// Deliberately no Display. `format!("{secret}")` must not compile.

// Best effort, and known to be only that: a String may have been reallocated or
// copied before this runs, so it cannot promise the bytes are gone from memory.
// It costs nothing and closes the easy case. The redacting Debug is the one
// that actually prevents the leak that ships.
impl Drop for Secret {
    fn drop(&mut self) {
        // SAFETY-adjacent note: overwriting the bytes in place, not freeing.
        unsafe {
            for byte in self.0.as_bytes_mut() {
                *byte = 0;
            }
        }
    }
}

// The proof key. The verifier stays in this process; only its hash is sent with
// the authorization request, so an attacker who intercepts the redirect cannot
// exchange the code without also having the verifier.
#[derive(Clone, Debug)]
pub struct Pkce {
    pub verifier: Secret,
    pub challenge: String,
}

// Separated so it can be checked against RFC 7636's own test vector rather than
// against itself. A derivation tested only by round-tripping its own output
// proves the two halves agree and nothing about whether either is right.
pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE.encode(Sha256::digest(verifier.as_bytes()))
}

impl Pkce {
    pub fn new(random: [u8; 32]) -> Self {
        // Base64url of 32 random bytes is 43 characters, which is the minimum
        // length the specification allows and well inside the 128 maximum.
        let verifier = URL_SAFE.encode(random);
        let challenge = challenge_for(&verifier);
        Self {
            verifier: Secret::new(verifier),
            challenge,
        }
    }

    pub fn generate() -> Self {
        let mut bytes = [0u8; 32];
        rand::fill(&mut bytes);
        Self::new(bytes)
    }
}

pub fn random_state() -> String {
    let mut bytes = [0u8; 16];
    rand::fill(&mut bytes);
    URL_SAFE.encode(bytes)
}

// Percent-encoding, hand-rolled because the alternative is a dependency for the
// sake of one function. Everything that is not unreserved is escaped, which is
// stricter than necessary and never wrong.
pub fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

// Scopes are requested per feature rather than as a blanket grant, which is
// CCP's guidance and also the only way a pilot can see what they are agreeing
// to.
//
// An empty list is accepted here and is no longer used by anything: CCP return
// a refresh token only when the authorize request carried at least one valid
// scope, so a scopeless sign-in cannot produce a character that survives a
// restart. See FIRST_SLICE_SCOPES.
pub fn authorize_url(config: &SsoConfig, pkce: &Pkce, state: &str, scopes: &[&str]) -> String {
    // Omitted entirely when empty, rather than sent as `scope=`.
    //
    // RFC 6749 makes the parameter optional, and CCP's documentation does not
    // say what an application requesting none should send. An empty value is
    // the shape most likely to be read as "a scope whose name is the empty
    // string" by something along the way; sending nothing is unambiguous.
    //
    // Kept although nothing requests none any more, because it is still the
    // right answer if anything ever does.
    let scope = if scopes.is_empty() {
        String::new()
    } else {
        format!("&scope={}", encode(&scopes.join(" ")))
    };
    format!(
        "{AUTHORIZE_URL}?response_type=code&redirect_uri={}&client_id={}{scope}&state={}&code_challenge={}&code_challenge_method=S256",
        encode(&config.redirect_uri()),
        encode(&config.client_id),
        encode(state),
        encode(&pkce.challenge),
    )
}

#[derive(Debug, PartialEq)]
pub struct Callback {
    pub code: Secret,
    pub state: String,
    // Set when CCP refused rather than approved. Carried rather than returned
    // as an error so the state can be checked before anyone believes it.
    pub refusal: Option<String>,
}

// Long enough for any real redirect, short enough that a hostile one cannot
// exhaust memory. CCP's codes are well under a hundred bytes.
const MAX_REQUEST_LINE: usize = 8 * 1024;

// How long one connection may take to produce its request line.
//
// The size cap alone is not enough, because it bounds memory and not time. A
// client sending one byte every three seconds satisfies every individual read
// - each one returns inside the socket timeout - and can hold the accept loop
// for hours while the genuine redirect waits behind it. Measured against an
// earlier build: a four-second sign-in was still blocked twenty-four seconds
// later.
//
// A real browser sends its request line in one packet. Three seconds is
// generous for that and useless for a drip.
const REQUEST_BUDGET: Duration = Duration::from_secs(3);

// One request line, bounded in bytes and in time, and never fatal.
//
// Returns None for anything that is not a usable line - a socket that goes
// quiet, one that sends non-UTF-8, one that drips, one that never sends a
// newline. Every one of those belongs to that connection alone: a browser
// opening a speculative socket must not end a sign-in the pilot is still
// approving.
fn read_request_line(stream: &std::net::TcpStream) -> Option<String> {
    let started = Instant::now();
    let mut reader = BufReader::new(stream);
    let mut line = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        if started.elapsed() > REQUEST_BUDGET || line.len() >= MAX_REQUEST_LINE {
            return None;
        }
        match reader.read(&mut byte) {
            Ok(0) => return None,
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => {
                if byte[0] != b'\r' {
                    line.push(byte[0]);
                }
            }
            Err(_) => return None,
        }
    }
    String::from_utf8(line).ok()
}

const NOT_FOUND: &str = "HTTP/1.1 404 Not Found
Content-Length: 0
Connection: close

";

// Whether a request is the sign-in answer at all, as opposed to a browser
// being a browser. An answer carries a code or an error; nothing else does.
pub fn carries_answer(request_line: &str) -> bool {
    let target = match request_line.split_whitespace().nth(1) {
        Some(target) => target,
        None => return false,
    };
    let query = target.split('?').nth(1).unwrap_or("");
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .any(|(name, _)| name == "code" || name == "error")
}

// The query of a redirect, without pulling in a URL parser.
pub fn parse_callback(request_line: &str) -> Result<Callback, String> {
    let target = request_line
        .split_whitespace()
        .nth(1)
        .ok_or("the browser sent a request with no target")?;
    let query = target.split('?').nth(1).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let (name, value) = match pair.split_once('=') {
            Some(parts) => parts,
            None => continue,
        };
        let value = decode(value);
        match name {
            "code" => code = Some(Secret::new(value)),
            "state" => state = Some(value),
            "error" => error = Some(value),
            "error_description" => error = error.or(Some(value)),
            _ => {}
        }
    }
    // A refusal is an answer, and a clearer one than a missing code - but it is
    // only *this* sign-in's answer if it carries this sign-in's state.
    //
    // Returning before the state is compared makes `error=` an unauthenticated way to
    // end a sign-in. Anything able to reach the loopback port can send one, including a
    // page the pilot happens to have open: `<img
    // src="http://localhost:47624/callback?error=...">` is a plain cross-origin GET
    // that a browser sends happily.
    //
    // The text was worse than the interruption. It was returned verbatim inside
    // "EVE SSO refused the sign-in: ...", so whatever shows that error to a
    // pilot would render an attacker's sentence as an official message from
    // CCP - which is a support scam with the application's own voice.
    //
    // So a refusal is carried, not thrown, and the caller checks its state
    // first. The reason is truncated and stripped of control characters: it is
    // remote text, and it is the only remote text in this file that reaches a
    // person.
    match (code, state, error) {
        (_, Some(state), Some(reason)) => Ok(Callback {
            code: Secret::new(String::new()),
            state,
            refusal: Some(sanitise(&reason)),
        }),
        (Some(code), Some(state), None) => Ok(Callback { code, state, refusal: None }),
        // No state at all cannot be matched against anything, so it is not an
        // answer to a question this process asked.
        _ => Err("the redirect carried no authorization code".into()),
    }
}

// Remote text on its way to a person: bounded, single-line, printable.
fn sanitise(reason: &str) -> String {
    let cleaned: String = reason
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect();
    if cleaned.trim().is_empty() {
        "no reason given".into()
    } else {
        cleaned
    }
}

// Percent-decoding that cannot panic.
//
// Slicing the `&str` by byte index - `&value[i + 1..i + 3]` - panics when those
// indices land inside a multi-byte character, and `%` followed by a euro sign is
// enough. Under `panic = "abort"` that is an immediate process abort: the window gone
// and the sidecar orphaned, from about thirty bytes sent by any local process while a
// sign-in is open. The profile unwinds, so the same bug would end the sign-in with a
// message instead - a smaller disaster, not a reason to
// reintroduce it.
//
// Working on bytes throughout removes the hazard rather than guarding it. There
// is no index into the &str left to get wrong.
fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let hex = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    };
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                match (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                    (Some(high), Some(low)) => {
                        out.push(high * 16 + low);
                        index += 3;
                    }
                    _ => {
                        out.push(b'%');
                        index += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// What the browser is left looking at. It is the only interface this flow has,
// and a blank page after a sign-in reads as a failure even when it worked.
fn closing_page(message: &str) -> String {
    // A raw string, because every attribute in here needs quotes and escaping
    // them turns four readable lines into a hedge. There is no line
    // continuation in a raw string, so the tags are separated by real newlines
    // - HTML ignores whitespace between tags, and Content-Length is measured
    // from the body below rather than written by hand, so it follows along.
    let body = format!(
        r#"<!doctype html><meta charset="utf-8"><title>New Eden Atlas</title>
<body style="font:14px system-ui;background:#0d1418;color:#c7d0d5;padding:3rem">
<h1 style="font-size:1.1rem;color:#7fc7e8">New Eden Atlas</h1><p>{message}</p>
<p style="color:#7d8b93">You can close this tab and return to the application.</p>"#
    );
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

// Bind and wait: the whole callback, for callers that have no reason to
// separate the two.
pub fn wait_for_callback(
    port: u16,
    expected_state: &str,
    timeout: Duration,
) -> Result<Callback, String> {
    // Bind and wait, which is what the checks and any simple caller want.
    // `token_begin` uses the two halves separately, because it has to hold
    // the port before it opens a browser.
    let listeners = bind_callback(port)?;
    wait_on(&listeners, expected_state, timeout)
}

// Binding, separated from waiting, so a caller can hold the port *before*
// sending a pilot to CCP.
//
// The order matters. Opening the browser first and binding afterwards has two
// consequences: something else already holding 47624 is discovered only after the pilot
// has signed in and consented, by which time CCP has minted a code and handed it to
// whatever is squatting the port; and CCP redirect immediately when consent was granted
// on a previous sign-in, so the redirect can arrive before the listener is up and be
// refused. Binding first refuses before any code exists.
// Both loopback families, and this is not belt-and-braces.
//
// The redirect registered with CCP says `localhost`, because that is what
// their portal accepts. A browser resolves that name, and on Windows it
// resolves to `::1` *first* - measured, not assumed. An IPv4-only listener
// therefore depends on the browser refusing on IPv6 and retrying on IPv4,
// which works when the connection is *refused* and hangs when a firewall
// silently *drops* it instead.
//
// That motivation is Windows-specific; the code is right on Linux for a
// different reason. There the two binds are simply independent, and not
// because a kernel happens to default a certain way: `IPV6_V6ONLY` governs
// the *wildcard* `[::]`, and `::1` is a specific address, so a `::1`
// listener can never cover `127.0.0.1` whatever the option says. Verified
// with the option forced both ways.
//
// That failure is a sign-in that spins forever with nothing in any log, on
// someone else's machine, and it is close to undiagnosable remotely. Two
// listeners cost twenty lines.
//
// Loopback addresses specifically, never `0.0.0.0` or `[::]`: nothing
// outside this machine may reach this socket even for the seconds it is
// open.
// ON SO_REUSEADDR, BEFORE ANYONE ADDS IT.
//
// The usual advice - set SO_REUSEADDR so a crashed previous attempt does
// not hold the port through TIME_WAIT - is right on Unix and wrong here,
// and Rust's standard library already gets it right on both.
//
//   Unix    std sets SO_REUSEADDR on TcpListener for you. Nothing to do.
//   Windows std does not, and must not. The flag does not mean the same
//           thing: it lets a *second* process bind a port a first is
//           already listening on, which is port hijacking rather than
//           politeness. Windows offers SO_EXCLUSIVEADDRUSE for the
//           opposite reason.
//
// Measured on Windows: a second bind while the first listener is alive is
// refused with "address in use", and a rebind after close succeeds
// immediately.
//
// THE FLAG IS LOAD-BEARING ON UNIX, NOT DECORATIVE. "There is no TIME_WAIT
// window for a listening socket to wait out" is true of a listener that never
// accepted anything, and false of this one: it accepts the callback, and on
// Unix that connection leaves the *server* side in TIME_WAIT. Measured on
// Linux by driving a real client through connect/accept/respond and closing
// server-first:
//
//     SO_REUSEADDR = 1, one socket in TIME_WAIT  ->  rebind SUCCEEDED
//     SO_REUSEADDR = 0, one socket in TIME_WAIT  ->  rebind EADDRINUSE
//
// std sets it, so there is still nothing to do here - but anything that
// replaces this bind with a socket it builds itself, for a timeout or a
// socket2 builder or a custom listener, must keep it. Dropping it fails
// only *after* a callback has actually been served: it works through every
// test and breaks on the second real sign-in.
//
// So: do not set it here, and do not conclude from that that it does not
// matter. If this is ever ported and Linux shows a stale bind, the fix
// belongs on the Unix path, not on this one.
pub fn bind_callback(port: u16) -> Result<Vec<TcpListener>, String> {
    let mut listeners = Vec::new();
    let mut refusals = Vec::new();
    for address in [
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
    ] {
        match TcpListener::bind(address) {
            Ok(listener) => match listener.set_nonblocking(true) {
                Ok(()) => listeners.push(listener),
                Err(error) => refusals.push(format!("{address}: {error}")),
            },
            // One family being unavailable is ordinary - a host with IPv6
            // disabled, or something already holding that port on one stack.
            // Only losing both is fatal.
            Err(error) => refusals.push(format!("{address}: {error}")),
        }
    }
    if listeners.is_empty() {
        return Err(format!(
            "could not listen on port {port} for the sign-in redirect ({}). Something else on this machine is using it; close it and try again.",
            refusals.join("; ")
        ));
    }
    Ok(listeners)
}

// One redirect, then the socket closes.
//
// The listeners are already bound - to the loopback addresses specifically, so
// nothing outside this machine can reach them even for the seconds they are
// open. The state is checked here rather than by the caller: a redirect
// carrying the wrong state is not this sign-in, and treating it as one is how
// an authorization code from elsewhere gets exchanged by a process that was
// waiting for a different answer.
pub fn wait_on(
    listeners: &[TcpListener],
    expected_state: &str,
    timeout: Duration,
) -> Result<Callback, String> {
    // Redirects belonging to some other sign-in. Ignoring them is right, but a
    // wait that ends in silence having quietly discarded three answers is a bad
    // thing to debug, so the timeout says they happened.
    let mut mismatched = 0usize;

    let deadline = Instant::now() + timeout;
    loop {
      // Checked at the top of every pass, unconditionally.
      //
      // Inside `if waiting` it is reached only when a listener returned `WouldBlock`.
      // Two local processes each keeping a connection queued - one is enough when only
      // one family bound - make every pass return `Ok`, so the deadline is never read
      // and the sleep never runs: the documented five-minute timeout cannot fire, the
      // worker is pinned for the life of the process, and the loop spins a
      // core. The genuine redirect queued behind the attacker's sockets.
      if Instant::now() >= deadline {
          return Err(if mismatched > 0 {
              format!(
                  "the sign-in was not completed in time. {mismatched} redirect(s) arrived carrying a different sign-in's state and were ignored - if you started a sign-in twice, finish the most recent one."
              )
          } else {
              "the sign-in was not completed in time".into()
          });
      }
      let mut waiting = false;
      for listener in listeners {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false).ok();
                // REQUEST_BUDGET, not a larger number sitting next to it.
                //
                // For a socket that connects and sends nothing - which is
                // exactly what a browser preconnect is - this timeout is the
                // only thing that ends the read, because the budget above is
                // only consulted between reads and there is never a second
                // one. It was five seconds against a documented bound of
                // three, so the documented bound was not the real one and
                // every speculative socket cost two seconds more than the
                // comment claimed.
                stream.set_read_timeout(Some(REQUEST_BUDGET)).ok();
                // Bounded, and a failure here belongs to this socket alone.
                //
                // `?` here ends the whole sign-in on one unreadable connection - and
                // browsers routinely open speculative sockets that connect and send
                // nothing, so a preconnect arriving before the real redirect kills the
                // sign-in five seconds later with an error naming nothing useful. Two
                // non-UTF-8 bytes do it instantly.
                //
                // The cap matters for the same reason: read_line has no length
                // limit, so a client streaming bytes without a newline grows
                // this string until the allocator gives up. An allocation failure
                // is an abort whatever the panic strategy is, so the cap is the
                // only thing standing between a local process and a dead window.
                let line = match read_request_line(&stream) {
                    Some(line) => line,
                    None => continue,
                };

                // Not every connection is the answer. Browsers open speculative
                // connections, ask for /favicon.ico, and preconnect to hosts
                // they expect to use. Treating the *first* connection as
                // terminal means one of those ends the sign-in before the
                // pilot has finished approving it - and the report would be
                // "the redirect carried no authorization code", which is true
                // of a favicon request and says nothing about what went wrong.
                //
                // So only a request actually carrying an answer is terminal.
                // Anything else is told politely that there is nothing here and
                // the wait continues.
                if !carries_answer(&line) {
                    let _ = stream.write_all(NOT_FOUND.as_bytes());
                    let _ = stream.flush();
                    continue;
                }

                let result = parse_callback(&line);
                let matched = matches!(&result, Ok(callback) if callback.state == expected_state);
                let message = match &result {
                    Ok(_) if !matched =>
                        "This sign-in did not match the one this application started, so it was refused.",
                    Ok(callback) if callback.refusal.is_some() =>
                        "EVE SSO did not approve this sign-in. You can close this tab.",
                    Ok(_) => "Signed in. The application has the authorization it needs.",
                    Err(_) => "The sign-in did not complete.",
                };
                let _ = stream.write_all(closing_page(message).as_bytes());
                let _ = stream.flush();

                // A redirect whose state does not match is somebody else's, and
                // that is as true of a refusal as of a code. It is ignored
                // rather than returned: ending the wait on it would let
                // anything able to reach this port cancel a sign-in, including
                // a page the pilot has open, since an <img> tag pointing at
                // this URL is a plain cross-origin GET a browser sends happily.
                if !matched {
                    mismatched += 1;
                    continue;
                }
                let callback = result?;
                if let Some(reason) = &callback.refusal {
                    return Err(format!("EVE SSO refused the sign-in: {reason}"));
                }
                return Ok(callback);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                waiting = true;
            }
            // Every other accept failure belongs to that connection, not to the
            // sign-in - the same rule the read below follows, and this line used
            // to break it.
            //
            // A client that connects and resets before being accepted produces
            // ECONNABORTED on Unix and WSAECONNRESET on Windows. Any local
            // process can do that deliberately, and a torn-down browser
            // preconnect does it by accident. Returning here killed a sign-in
            // the pilot was still approving, and wasted the code CCP was about
            // to mint.
            Err(_) => {
                waiting = true;
            }
        }
      }
      // Only when nothing was accepted this pass. A pass that did real work
      // goes straight round again.
      if waiting {
        std::thread::sleep(Duration::from_millis(50));
      }
    }
}

// --- configuration ----------------------------------------------------------------
//
// The client id is not a secret - PKCE exists so that a public client needs
// none - but it is an **identity**. If every fork ships one id, then as far as
// CCP are concerned every token on the planet belongs to that application: one
// fork misbehaves and the rate limit is shared, a revocation kills everyone,
// and a ban lands on whoever registered it.
//
// The file is read from beside the application's data and from nowhere else.
// `load_config` is only ever handed `vault_dir`, so there is no fallback to a
// copy in the repository and the word "override" would be wrong: a repository
// copy is not consulted, it is simply never read. A fork maintainer registers
// their own application and writes one file rather than patching Rust.
//
// And there is no client secret. A secret in an open-source desktop
// application is a secret on every pilot's disk.
pub const CONFIG_FILE: &str = "sso.json";

pub fn load_config(directory: &std::path::Path) -> SsoConfig {
    let text = match std::fs::read_to_string(directory.join(CONFIG_FILE)) {
        Ok(text) => text,
        Err(_) => return SsoConfig::default(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        // A malformed config reports through `fault()` as "not configured",
        // which is what it is from the flow's point of view.
        Err(_) => return SsoConfig::default(),
    };
    SsoConfig {
        client_id: parsed
            .get("client_id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        callback_port: parsed
            .get("callback_port")
            .and_then(serde_json::Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port > 0)
            .unwrap_or(DEFAULT_CALLBACK_PORT),
    }
}

// Why there is no "pending sign-in" type here.
//
// An earlier shape held the verifier and the state in a slot between starting a
// sign-in and redeeming it, so that taking it out could enforce single use. That
// slot is gone because `token_begin` now runs the whole flow in one call: the
// verifier is created there, moved into the exchange, and dropped. There is
// nothing left to redeem twice, and nothing to forget to clear.
//
// If the flow is ever split across two commands, the slot comes back - and with
// it the rule that taking a sign-in out consumes it. An authorization code is
// single-use, and so is the verifier that redeems it.

// --- the exchange -----------------------------------------------------------------
//
// The code is spent here, once, for an access token and a refresh token. This is
// the only place in the application that talks to an authorization server, and
// the only place a refresh token exists in memory.

#[derive(Debug)]
pub struct Tokens {
    pub access: Secret,
    pub refresh: Secret,
    // Parsed and kept for the refresh path below, which is written and not yet
    // wired. Deliberate rather than forgotten: the value is what decides when a
    // refresh is due, and dropping it now would mean re-deriving it later from a
    // response this code has already thrown away.
    #[allow(dead_code)]
    pub expires_in: u64,
}

// CCP have published the issuer both with and without a scheme over the years.
// Accepting either is not laxness: rejecting a token because the server changed
// how it spells its own name would lock every pilot out, and the claim being
// checked is "this came from EVE SSO", which both spellings assert.
const ISSUERS: [&str; 2] = ["login.eveonline.com", "https://login.eveonline.com"];

// The audience EVE SSO stamps on every token, alongside the client id.
const AUDIENCE: &str = "EVE Online";

#[derive(Debug, Clone)]
pub struct Character {
    pub id: i64,
    pub name: String,
    pub scopes: Vec<String>,
    // As above: the token's own expiry, kept for the refresh path.
    #[allow(dead_code)]
    pub expires_at: i64,
}

// The form body for an authorization-code exchange.
//
// Built separately from the request so it can be checked without a network: the
// verifier must be present and the secret must not, and those are the two things
// that decide whether this is a PKCE exchange at all.
pub fn exchange_body(config: &SsoConfig, pkce: &Pkce, code: &Secret) -> String {
    format!(
        "grant_type=authorization_code&code={}&client_id={}&code_verifier={}",
        encode(code.expose()),
        encode(&config.client_id),
        encode(pkce.verifier.expose()),
    )
}

pub fn refresh_body(config: &SsoConfig, refresh: &Secret) -> String {
    format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}",
        encode(refresh.expose()),
        encode(&config.client_id),
    )
}

fn post_form(url: &str, body: &str) -> Result<String, String> {
    // No redirects. ureq follows up to ten by default and re-sends the body on
    // a 307 or 308 - and this body carries the authorization code and the PKCE
    // verifier on one call, and the refresh token on the other. A token
    // endpoint has no business redirecting, so the safe number is zero rather
    // than a smaller number.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .build()
        .into();
    let response = agent
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Host", "login.eveonline.com")
        // The same rule the viewer follows: name the application and a contact
        // route, never a character.
        .header("User-Agent", USER_AGENT)
        .send(body);

    match response {
        Ok(mut ok) => ok
            .body_mut()
            .read_to_string()
            .map_err(|e| format!("the authorization server's reply could not be read: {e}")),
        Err(ureq::Error::StatusCode(code)) => Err(format!(
            "EVE SSO refused the exchange with status {code}. If this says the client is unknown, the id in sso.json does not match a registered application; if it says the grant is invalid, the code has already been spent or the redirect does not match the one registered."
        )),
        Err(error) => Err(format!("could not reach EVE SSO: {error}")),
    }
}

fn tokens_from(payload: &str) -> Result<Tokens, String> {
    let value: serde_json::Value =
        serde_json::from_str(payload).map_err(|e| format!("the reply was not JSON: {e}"))?;
    let take = |name: &str| {
        value
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(Secret::new)
            .ok_or_else(|| format!("the reply carried no {name}"))
    };
    Ok(Tokens {
        access: take("access_token")?,
        refresh: take("refresh_token")?,
        expires_in: value.get("expires_in").and_then(serde_json::Value::as_u64).unwrap_or(0),
    })
}

pub fn exchange_code(config: &SsoConfig, pkce: &Pkce, code: &Secret) -> Result<Tokens, String> {
    tokens_from(&post_form(TOKEN_URL, &exchange_body(config, pkce, code))?)
}

// THE RETURNED REFRESH TOKEN MUST BE STORED.
//
// CCP's documentation is explicit that "the refresh_token returned may not be
// the same as the refresh token submitted", and that rotation will eventually
// be enabled for native applications. A refresh that takes the new access token
// and discards the new refresh token works perfectly until the day rotation is
// switched on, and then locks the pilot out permanently: the stored credential
// is spent and the one that replaced it was thrown away.
//
// Whoever wires this: store `tokens.refresh` on every success, not only when it
// differs from what was sent.
//
// Unused on purpose, and kept rather than deleted: it is the half of sign-in that
// makes a stored token worth storing, and it is tested. `#[allow]` rather than a
// warning left standing, because a warning nobody can action is one everybody
// learns to scroll past - which is the same argument this project makes about a
// check that cannot fail.
#[allow(dead_code)]
pub fn refresh_tokens(config: &SsoConfig, refresh: &Secret) -> Result<Tokens, String> {
    tokens_from(&post_form(TOKEN_URL, &refresh_body(config, refresh))?)
}

// --- validating the access token ---------------------------------------------------
//
// Five things, because the rules document names five and skipping any one means
// trusting a token nobody checked: signature, issuer, audience, expiry, and the
// character it speaks for. The granted scopes come out of the same claim set.
//
// The signature is the one that cannot be skipped for convenience. Without it
// every other check is being run against a document anyone could have written,
// and the character id in an unverified token is a claim rather than a fact -
// which matters here more than in most applications, because that id is the
// key every sighting is filed under.

#[derive(serde::Deserialize)]
struct Claims {
    sub: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    scp: serde_json::Value,
    exp: i64,
    // Kept so the audience can be checked properly. See below: the library's
    // audience validation is an OR and CCP specify an AND.
    #[serde(default)]
    aud: serde_json::Value,
}

#[derive(serde::Deserialize)]
struct Jwk {
    kid: String,
    #[serde(default)]
    n: Option<String>,
    #[serde(default)]
    e: Option<String>,
    #[serde(default)]
    alg: Option<String>,
}

#[derive(serde::Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

// Fetched rather than pinned. CCP rotate signing keys, and a pinned key becomes
// an outage on a schedule nobody here controls.
pub fn fetch_jwks() -> Result<String, String> {
    let mut response = ureq::get(JWKS_URL)
        .header("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| format!("could not fetch EVE SSO's signing keys: {e}"))?;
    response
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("the signing keys could not be read: {e}"))
}

// Split out so it can be checked against a key set and a token built in the
// test, with no network involved.
pub fn character_from(token: &str, jwks: &str, client_id: &str) -> Result<Character, String> {
    let header = jsonwebtoken::decode_header(token)
        .map_err(|e| format!("the access token has no readable header: {e}"))?;
    let kid = header.kid.ok_or("the access token names no signing key")?;

    let keys: Jwks =
        serde_json::from_str(jwks).map_err(|e| format!("the signing key set is not JSON: {e}"))?;
    let key = keys
        .keys
        .iter()
        .find(|k| k.kid == kid)
        .ok_or_else(|| format!("EVE SSO signed with key {kid}, which is not in its published set"))?;

    let (n, e) = match (&key.n, &key.e) {
        (Some(n), Some(e)) => (n, e),
        // An EC or symmetric key here would mean CCP changed algorithm; refusing
        // is right, and saying so beats a signature error nobody can act on.
        _ => return Err(format!("signing key {kid} is not an RSA key")),
    };
    let decoding = jsonwebtoken::DecodingKey::from_rsa_components(n, e)
        .map_err(|e| format!("signing key {kid} could not be read: {e}"))?;

    let algorithm = match key.alg.as_deref() {
        Some("RS256") | None => jsonwebtoken::Algorithm::RS256,
        Some(other) => return Err(format!("EVE SSO signed with {other}, which this build does not accept")),
    };

    let mut validation = jsonwebtoken::Validation::new(algorithm);
    validation.set_issuer(&ISSUERS);
    // Required, not merely matched.
    //
    // jsonwebtoken defaults `required_spec_claims` to {"exp"} alone, and its
    // issuer comparison falls through when the claim is absent - so a token
    // with no `iss` at all passed the issuer check. The audience was already
    // caught, because an absent `aud` deserialises to Null and the hand-rolled
    // loop below finds neither required value in an empty list. The issuer had
    // no such second gate, which made the file's own claim to check five things
    // true of four. Not exploitable without CCP's signing key; stated
    // accurately now.
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    // Defaults to off in the library. A not-before in the future is a token
    // that is not valid yet, and accepting one is free to refuse.
    validation.validate_nbf = true;
    // Set here so a token with no recognised audience at all is refused by the
    // library, and checked again below for the part the library cannot express.
    validation.set_audience(&[AUDIENCE, client_id]);
    // Expiry is checked by the library. Leaving it to a hand-rolled comparison
    // is how a clock-skew allowance becomes an indefinite one.
    validation.validate_exp = true;

    let claims = jsonwebtoken::decode::<Claims>(token, &decoding, &validation)
        .map_err(|e| format!("the access token did not validate: {e}"))?
        .claims;

    // BOTH audiences, which the library cannot be asked for.
    //
    // CCP's documentation is explicit: the `aud` claim "must include both the
    // client_id and the string value EVE Online". `Validation::set_audience`
    // accepts a token carrying *any one* of the values given to it - an OR
    // where the specification says AND.
    //
    // The difference is the whole point of audience validation. A token minted
    // for a different application still carries "EVE Online", so the loose
    // check would accept another developer's token as though it were ours and
    // file whatever it said under one of this pilot's characters. That is the
    // confused-deputy case this claim exists to prevent, and it is not
    // hypothetical: every EVE SSO token in existence carries that audience.
    let audiences: Vec<&str> = match &claims.aud {
        serde_json::Value::String(one) => vec![one.as_str()],
        serde_json::Value::Array(many) => many.iter().filter_map(serde_json::Value::as_str).collect(),
        _ => Vec::new(),
    };
    for required in [AUDIENCE, client_id] {
        if !audiences.contains(&required) {
            return Err(format!(
                "the access token's audience does not include {required:?}. CCP require both the application's client id and \"EVE Online\", and a token carrying only one of them was issued for something else."
            ));
        }
    }

    character_from_claims(&claims.sub, &claims.name, &claims.scp, claims.exp)
}

// What the claims mean, separated from whether they can be trusted.
//
// Signature checking needs a real key, so testing this half through
// `character_from` would mean an RSA private key living in the repository. It
// would be a throwaway, and it would still be a private key sitting in a public
// tree looking exactly like a mistake. Splitting the interpretation out makes
// the interesting cases - a subject that is not a character, scopes arriving in
// two different shapes - checkable with no crypto at all.
pub fn character_from_claims(
    sub: &str,
    name: &str,
    scp: &serde_json::Value,
    exp: i64,
) -> Result<Character, String> {
    // `sub` is "CHARACTER:EVE:<id>". Anything else is not a character token -
    // a corporation or a service would parse as a number and be filed as a
    // character, which is the sort of thing that only shows up much later as a
    // sighting attributed to nobody.
    let id = sub
        .strip_prefix("CHARACTER:EVE:")
        .and_then(|rest| rest.parse::<i64>().ok())
        .filter(|id| *id > 0)
        .ok_or_else(|| format!("the token speaks for {sub}, which is not a character"))?;

    // Scopes arrive as a string when there is one and a list when there are
    // several. That shape difference has caught every client that assumed one
    // of them, and assuming the list means a single-scope token reads as having
    // none - which would silently disable whatever the scope was for.
    let scopes = match scp {
        serde_json::Value::String(one) if one.trim().is_empty() => Vec::new(),
        // A single claim can also carry several, space separated, which is how
        // the specification defines the field.
        serde_json::Value::String(one) => one.split_whitespace().map(str::to_string).collect(),
        serde_json::Value::Array(many) => many
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };

    Ok(Character { id, name: name.to_string(), scopes, expires_at: exp })
}

// --- where a refresh token lives ---------------------------------------------------
//
// The operating system's credential store, which is the entire reason this
// application has a Rust core at all. CCP's guidance is explicit that a refresh
// token is a long-lived character credential and does not belong in browser
// storage, and a page has nothing else to offer.
//
// One entry per character. The service name is shared so a pilot can find and
// revoke them by hand in Credential Manager, Keychain or Secret Service - a
// credential a person cannot see or delete without the application's cooperation
// is a worse credential.
const CREDENTIAL_SERVICE: &str = "New Eden Atlas";

fn entry(character_id: i64) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, &character_id.to_string())
        .map_err(|e| format!("the credential store is unavailable: {e}"))
}

// What a credential-store failure actually means, in a sentence a pilot can act
// on.
//
// The Linux box reported `the refresh token could not be stored: Couldn't access
// platform storage: SS error: result not returned from SS API`, which is the
// keyring crate relaying a D-Bus non-answer. It is accurate and unusable. The
// machine had gnome-keyring running and `org.freedesktop.secrets` on the bus;
// what it did not have was a *default collection*, because the desktop
// autologins, so PAM never sees a password and the login keyring is never
// created. That is a common setup rather than an exotic one.
//
// And the same condition is indistinguishable from a *locked* keyring, which is
// the ordinary state on a password-login machine before the pilot unlocks it.
// Those need different sentences: one is "make a keyring", the other is "unlock
// the one you have". Saying neither is how a fixable configuration reads as a
// broken application.
//
// The rest of this file already writes errors of this quality - the unregistered
// application names where to register and which callback to use - so this was
// below the standard set beside it.
fn credential_advice(error: &str) -> &'static str {
    let lower = error.to_lowercase();
    if lower.contains("locked") || lower.contains("dismissed") || lower.contains("cancel") {
        "This computer's keyring is locked. Unlock it and try again."
    } else if cfg!(target_os = "linux") {
        "This computer has no default keyring to write into, which happens when the desktop logs in automatically and no login password is ever entered. Create one with Passwords and Keys (seahorse), or log in with a password, and try again."
    } else if cfg!(target_os = "macos") {
        "The login keychain could not be written to. Unlock it in Keychain Access and try again."
    } else {
        "Windows Credential Manager refused the write. Check that the Credential Manager service is running."
    }
}

pub fn store_refresh(character_id: i64, refresh: &Secret) -> Result<(), String> {
    entry(character_id)?
        .set_password(refresh.expose())
        .map_err(|error| {
            let raw = error.to_string();
            format!(
                "the refresh token could not be stored. {} (the store said: {raw})",
                credential_advice(&raw)
            )
        })
}

pub fn load_refresh(character_id: i64) -> Result<Option<Secret>, String> {
    match entry(character_id)?.get_password() {
        Ok(value) => Ok(Some(Secret::new(value))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("the refresh token could not be read: {e}")),
    }
}

// Forgetting a character means forgetting the credential, not hiding it.
//
// A "removed" character whose refresh token is still in the operating system's
// store is a credential the pilot believes they revoked. Absent is treated as
// success: the caller asked for it to be gone and it is.
pub fn forget_refresh(character_id: i64) -> Result<(), String> {
    match entry(character_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("the refresh token could not be removed: {e}")),
    }
}

// --- the vault's non-secret half ---------------------------------------------------
//
// The credential store holds refresh tokens and cannot be enumerated - by
// design, since a store that lists its own contents to any caller would be a
// worse store. So the list of characters lives beside the application's data as
// an ordinary file, carrying only what a pilot would see on screen anyway: who
// is in the vault, what they were granted, and whether the last refresh worked.
//
// Nothing secret goes in it. The split is the point: the file says a character
// exists, and the only thing that can act as them is in the operating system's
// keeping.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct VaultEntry {
    pub character_id: i64,
    pub name: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub added_at: i64,
    #[serde(default)]
    pub last_refresh_at: i64,
    #[serde(default)]
    pub last_refresh_error: Option<String>,
}

pub const VAULT_FILE: &str = "characters.json";

// Absent and unreadable are different answers, and collapsing them is the store
// law in its most damaging form.
//
// Written as `.ok().and_then(...).ok().unwrap_or_default()`, a vault file that exists
// and cannot be read comes back as an empty list: the window says "No characters yet",
// and the next sign-in or forget writes that empty list straight over the file. The
// record of every character is destroyed by the recovery, and their refresh tokens stay
// in the operating system's credential store with nothing in the application pointing
// at them - not listed, so not forgettable, and invisible to the pilot who would have
// to find
// them by hand in Credential Manager.
//
// No file is a genuine empty vault and the honest answer is an empty list.
// Anything else is a failure to find out, and a failure to find out is reported.
pub fn load_vault_state(directory: &std::path::Path) -> Result<Vec<VaultEntry>, String> {
    let path = directory.join(VAULT_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "the character list at {} could not be read: {error}. It has been left alone rather than replaced - no character has been removed.",
                path.display()
            ))
        }
    };
    // An empty file is a crash between create and write, not an empty vault.
    if text.trim().is_empty() {
        return Err(format!(
            "the character list at {} is empty, which is what a crash mid-write leaves behind rather than what an empty vault looks like. It has been left alone.",
            path.display()
        ));
    }
    serde_json::from_str::<Vec<VaultEntry>>(&text).map_err(|error| {
        format!(
            "the character list at {} is not readable as a character list: {error}. It has been left alone rather than replaced - no character has been removed.",
            path.display()
        )
    })
}

// There is deliberately no lenient `load_vault` returning a bare Vec. It
// existed, every caller used it because it was the easy one, and that is how
// an unreadable file became an empty list in three places at once.

// One writer at a time, and a scratch name no other writer can pick.
//
// This was written "the same way the live store is" and was missing both of the
// things that make the live store safe. The temp name was `json.writing.<pid>`
// - one name per *process*, not per call - and there was no lock. Two writers
// in this process both `File::create` that path, the second truncates the
// first's file, and the rename puts the splice on disk.
//
// It is reachable: `token_forget` is a synchronous command and runs on the main
// thread, while `token_begin` is async and finishes its load-upsert-save on the
// runtime. A forget clicked while a sign-in completes is two writers.
//
// And the strict `load_vault_state` above makes the consequence worse rather than
// better: it correctly refuses a spliced file, so from then on nothing can list, forget
// or add a character, and every refresh token sits in the credential store with nothing
// in the application pointing at it. Closing the silent-loss door while leaving the
// thing that produces the corruption turns a data-loss bug into a lock-out bug.
static VAULT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// A scratch name no other writer in this process can pick.
//
// A counter rather than a timestamp. The obvious spelling is pid plus
// nanoseconds, and it is not actually unique: SystemTime's granularity is
// coarser than a tight loop, so two writers entering together can read the same
// instant and choose the same path - which is the whole bug, with more digits
// in it. An atomic counter cannot collide by construction, and "cannot" is
// worth more here than "almost never", because the failure is a vault nothing
// can read afterwards.
//
// Separated from `save_vault` so the property can be checked directly. Checking
// it by racing two saves and looking for a corrupt file tests a symptom, and a
// symptom that needs a large enough payload and an unlucky enough interleaving
// to appear at all - a version of this check with the lock removed and the
// counter reverted passed twenty-four rounds without noticing.
static SCRATCH_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn scratch_path(path: &std::path::Path) -> std::path::PathBuf {
    let n = SCRATCH_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    path.with_extension(format!("json.writing.{}.{n}", std::process::id()))
}

pub fn save_vault(directory: &std::path::Path, entries: &[VaultEntry]) -> Result<(), String> {
    // Poison is recovered rather than propagated: this guards a file, not an
    // invariant in memory, and a panic in an unrelated writer must not make the
    // vault permanently unwritable. The live store's lock does the same.
    let _guard = VAULT_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    std::fs::create_dir_all(directory).map_err(|e| format!("{}: {e}", directory.display()))?;
    let path = directory.join(VAULT_FILE);
    let temporary = scratch_path(&path);
    let text = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    // Every failure after the file exists removes it. Leaving it behind means a
    // multi-megabyte scratch file per failed attempt, each with a name nothing
    // will ever reuse, in a directory the pilot has no reason to look in.
    let write = (|| -> Result<(), String> {
        use std::io::Write;
        let mut file = std::fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(why) = write {
        let _ = std::fs::remove_file(&temporary);
        return Err(why);
    }
    std::fs::rename(&temporary, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        e.to_string()
    })
}

pub fn upsert(entries: &mut Vec<VaultEntry>, entry: VaultEntry) {
    match entries.iter_mut().find(|e| e.character_id == entry.character_id) {
        // Re-authorising an existing character updates what it can do and when
        // it last worked, and keeps when it was added.
        Some(existing) => {
            existing.name = entry.name;
            existing.scopes = entry.scopes;
            existing.last_refresh_at = entry.last_refresh_at;
            existing.last_refresh_error = None;
        }
        None => entries.push(entry),
    }
}

// --- character portraits ------------------------------------------------------------
//
// Cosmetic, and therefore held to the degradation law harder than anything that
// matters: a portrait that cannot be fetched must cost nothing. No error in the
// panel, no empty character list, no delay before the names appear.
//
// CCP would rather we did not cache these at all - their image server
// documentation says "You are welcome to point your clients and applications
// directly at the image service and use it as a CDN. You do not need to cache
// the images and serve them yourself." We cache anyway, for two reasons that
// are ours rather than theirs.
//
// The map works with the network off, and a hotlinked portrait offline is a
// broken-image glyph in every row, which reads as a fault in the application.
// And the webview's own policy forbids it: `img-src 'self' data:` and a
// `connect-src` allow-list that does not name the image server, so the page
// cannot load or fetch a remote image even if we wanted it to. Fetching in the
// core and handing back a `data:` URI is the only shape that works without
// widening a policy that was narrowed on purpose.
//
// Portraits are JPEG. Everything else the image server returns is PNG, and
// character portraits are the documented exception.
pub const PORTRAIT_SIZE: u32 = 128;

// Enough for a 128px JPEG many times over, and small enough that a wrong answer
// from somewhere cannot exhaust memory. Real ones are tens of kilobytes.
const MAX_PORTRAIT_BYTES: u64 = 2 * 1024 * 1024;

pub fn portrait_url(character_id: i64) -> String {
    format!("https://images.evetech.net/characters/{character_id}/portrait?size={PORTRAIT_SIZE}")
}

pub fn portrait_dir(directory: &std::path::Path) -> std::path::PathBuf {
    directory.join("portraits")
}

// The size is in the name so a later change of size does not serve the old one
// forever, and does not need a migration either.
pub fn portrait_path(directory: &std::path::Path, character_id: i64) -> std::path::PathBuf {
    portrait_dir(directory).join(format!("{character_id}-{PORTRAIT_SIZE}.jpg"))
}

pub fn cached_portrait(directory: &std::path::Path, character_id: i64) -> Option<Vec<u8>> {
    let bytes = std::fs::read(portrait_path(directory, character_id)).ok()?;
    // A zero-length file is a crash between create and write, not a portrait.
    if bytes.is_empty() { None } else { Some(bytes) }
}

pub fn fetch_portrait(character_id: i64) -> Result<Vec<u8>, String> {
    let mut response = ureq::get(portrait_url(character_id))
        .header("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| format!("the portrait could not be fetched: {e}"))?;
    response
        .body_mut()
        .with_config()
        .limit(MAX_PORTRAIT_BYTES)
        .read_to_vec()
        .map_err(|e| format!("the portrait could not be read: {e}"))
}

// Staged and renamed, like everything else this application writes. A portrait
// is disposable and a half-written one costs only a refetch, but a half-written
// one also renders as a broken image until something notices, and staging is
// three lines.
pub fn store_portrait(
    directory: &std::path::Path,
    character_id: i64,
    bytes: &[u8],
) -> Result<(), String> {
    let path = portrait_path(directory, character_id);
    std::fs::create_dir_all(portrait_dir(directory)).map_err(|e| e.to_string())?;
    let temporary = scratch_path(&path);
    let written = (|| -> Result<(), String> {
        use std::io::Write;
        let mut file = std::fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(why) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(why);
    }
    std::fs::rename(&temporary, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        e.to_string()
    })
}

// Base64 rather than a file the page can fetch.
//
// `img-src 'self' data:` is the whole reason: the staged bundle is what 'self'
// means, and the portrait cache lives with the application's data rather than
// inside a directory that staging rebuilds. A data URI needs neither a served
// path nor a widened policy.
pub fn portrait_data_uri(bytes: &[u8]) -> String {
    format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

// Absent is success, for the same reason `forget_refresh` says so: the caller
// asked for it gone and it is gone.
pub fn forget_portrait(directory: &std::path::Path, character_id: i64) -> Result<(), String> {
    match std::fs::remove_file(portrait_path(directory, character_id)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("the portrait could not be removed: {error}")),
    }
}

// Open the pilot's browser at CCP's login.
//
// Deliberately the system browser rather than a window this application
// controls: a sign-in page rendered inside the application asking for EVE
// credentials is indistinguishable from a phishing page, and teaching pilots
// that it is normal is worse than any convenience it buys.
// What to run, separated from running it, so the choice can be checked.
//
// NOT `cmd /c start`. An authorize URL is mostly ampersands, and `cmd` treats an
// unquoted `&` as a command separator - so the browser received
// `...authorize?response_type=code` and cmd tried to execute `redirect_uri=...`
// and `client_id=...` as programs. CCP then answered, accurately and
// uselessly, that the client_id parameter was required. Nothing was wrong with
// the URL; it never arrived.
//
// Rust's argument quoting does not save this. It quotes for the C runtime's
// rules, which cmd does not follow, and `&` is not a character it quotes for.
//
// `rundll32 url.dll,FileProtocolHandler` hands the URL to the registered
// protocol handler with no command interpreter in the path. `open` and
// `xdg-open` take it as a single argument and were never affected.
//
// AND AN ABSOLUTE PATH, NOT A BARE NAME.
//
// Windows resolves a bare program name against the *running executable's own
// directory* before System32. Measured on this machine rather than assumed: a
// planted binary in the current directory is not found, and the same binary in
// the executable's directory is spawned.
//
// So `rundll32.exe` as a bare name means anything that can write a file beside
// the application runs as the pilot, the moment they click "Add a character".
// That is not an exotic condition here: a portable build, a `cargo tauri build`
// output run out of Downloads, and this repository's own `scripts/launch.ps1`
// all put the binary in a user-writable directory. An installed copy under
// Program Files needs administrator to attack; everything else does not.
//
// %SystemRoot% is read from the environment with a fallback, because the drive
// is not always C:. This is the same care `locate_sidecar` takes over not
// executing a nearby file it did not place, and this line was the hole in it.
pub fn browser_command(url: &str) -> (String, Vec<String>) {
    if cfg!(windows) {
        let root = std::env::var("SystemRoot")
            .or_else(|_| std::env::var("windir"))
            .unwrap_or_else(|_| r"C:\Windows".to_string());
        (
            format!(r"{root}\System32\rundll32.exe"),
            vec!["url.dll,FileProtocolHandler".into(), url.to_string()],
        )
    } else {
        // Unix, where the hazard is a different one and a constant is the wrong
        // answer to it.
        //
        // The Windows problem above is that a bare name resolves against the
        // running executable's own directory before System32. Unix does not do
        // that: `PATH` is searched, and Rust does not add the current directory
        // or the executable's directory to it. So a bare `xdg-open` here is the
        // ordinary Unix model rather than the hole it is on Windows.
        //
        // But `/usr/bin/xdg-open` as a constant was worse than either. It is
        // right on Debian and Ubuntu and wrong on distributions that ship it in
        // /usr/local/bin, and wrong in a Nix or Flatpak environment - and it
        // was written on a Windows machine that could not test any of them, so
        // it would have failed first for somebody else.
        //
        // Known locations first, because an absolute path that exists is still
        // better than a PATH lookup, and PATH last so the thing works wherever
        // it actually lives.
        let name = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        let found = ["/usr/bin/", "/usr/local/bin/", "/bin/"]
            .iter()
            .map(|dir| format!("{dir}{name}"))
            .find(|path| std::path::Path::new(path).is_file());
        (found.unwrap_or_else(|| name.to_string()), vec![url.to_string()])
    }
}

// Whether the launcher this build would use is actually there.
//
// Separated so the check can ask without opening a browser. On Windows this is
// a fixed System32 path and the answer is always yes; on Unix it is the
// question a handoff note was asking a person to answer by hand, which is the
// sort of thing that goes stale in a document and does not go stale in a check.
pub fn browser_launcher_exists(program: &str) -> bool {
    let path = std::path::Path::new(program);
    if path.is_absolute() {
        return path.is_file();
    }
    // A bare name means the known locations were all empty and this falls back
    // to PATH, which is only honest if something on PATH answers to it.
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|dir| dir.join(program).is_file())
        })
        .unwrap_or(false)
}

pub fn open_in_browser(url: &str) -> Result<(), String> {
    let (program, args) = browser_command(url);
    std::process::Command::new(&program)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open a browser with {program}: {e}"))
}
