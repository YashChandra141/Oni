//! TUI pairing: the pure state machine, the wire helpers, and the async driver (Task 21.2,
//! Req 32.1, 32.4, 47.8, 48.1, 48.3, 48.11).
//!
//! Flow: the TUI makes a 32-byte Pairing_Secret from the operating system's CSPRNG and posts its
//! verifier (base64url of the SHA-256 of the secret) to `POST /auth/pair`. The server answers
//! with an 8-character code and a link. The user opens the link in the Web_UI, signs in with a
//! wallet, and confirms the code. Meanwhile the TUI polls `POST /auth/pair/poll` with the code
//! and the secret itself (only that route ever sees the secret). `pending` keeps polling,
//! `ok` yields the Session_Token, 404 means the pairing is gone, 429 asks us to slow down.
//!
//! [`PairingState`] is pure: time is an injected count of milliseconds, so every transition is
//! tested without a clock. [`spawn`] runs the driver task, which owns its own copy of the state
//! machine, publishes each change to the main loop as a [`PairingMsg`], and ends on a terminal
//! state. Dropping the [`PairingHandle`] aborts the task, which cancels an in-flight request.
//!
//! The secret, the verifier, and the token are never logged. They are not part of any
//! `Debug` output here; the stored session redacts its token.

use std::fmt;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind};
use protocol::client::ClientMessage;
use ring::digest;
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::auth::{StoredSession, TokenStore};
use crate::cli::http_base;
use crate::http::{self, HttpError, Method, Response, Target};
use crate::keymap::{Action, Context, Keymap, chord_from_crossterm, resolve};

/// Length of the Pairing_Secret in bytes (Req 48.1).
pub const SECRET_BYTES: usize = 32;
/// Shortest poll interval the TUI uses, whatever the server says.
pub const MIN_INTERVAL_MS: u64 = 1_000;
/// Longest poll interval, reached by repeated 429 back-off.
pub const MAX_INTERVAL_MS: u64 = 60_000;
/// The message of an expired pairing (Req 48.3).
pub const EXPIRED_TEXT: &str = "Pairing expired, press P to retry";

const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Base64url without padding (RFC 4648 section 5).
pub fn base64url(bytes: &[u8]) -> String {
    fn sextet(n: u32, shift: u32) -> char {
        let index = usize::try_from((n >> shift) & 63).unwrap_or(0);
        BASE64URL.get(index).map_or('A', |b| char::from(*b))
    }
    let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let b0 = chunk.first().copied().unwrap_or(0);
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let n = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        out.push(sextet(n, 18));
        out.push(sextet(n, 12));
        if chunk.len() > 1 {
            out.push(sextet(n, 6));
        }
        if chunk.len() > 2 {
            out.push(sextet(n, 0));
        }
    }
    out
}

/// The verifier the server stores: base64url of the SHA-256 of the secret (Req 48.1).
pub fn verifier_of(secret: &[u8]) -> String {
    base64url(digest::digest(&digest::SHA256, secret).as_ref())
}

/// A fresh Pairing_Secret from the operating system's CSPRNG. `None` if the generator fails.
pub fn generate_secret() -> Option<[u8; SECRET_BYTES]> {
    let mut secret = [0_u8; SECRET_BYTES];
    SystemRandom::new().fill(&mut secret).ok()?;
    Some(secret)
}

/// `ABCD2345` shown as `ABCD-2345`. Any other length is shown unchanged.
pub fn format_code(code: &str) -> String {
    if code.len() == 8 && code.is_ascii() {
        format!("{}-{}", code.get(..4).unwrap_or(""), code.get(4..).unwrap_or(""))
    } else {
        code.to_owned()
    }
}

/// The link to show: the server's `pair_url` base with the web route's trailing slash
/// (`<web base>/pair/?code=<code>`), since the static site uses `trailingSlash`.
pub fn display_url(pair_url: &str) -> String {
    pair_url.replacen("/pair?", "/pair/?", 1)
}

/// Seconds as `m:ss`.
pub fn format_countdown(secs: u64) -> String {
    format!("{}:{:02}", secs / 60, secs % 60)
}

/// Where the pairing dialog is. Times are milliseconds on the driver's clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingState {
    /// No dialog.
    Idle,
    /// Waiting for `POST /auth/pair`.
    Requesting,
    /// The code is shown and the driver polls.
    Showing {
        code: String,
        url: String,
        expires_at: u64,
        interval_ms: u64,
        next_poll: u64,
        /// Whole seconds left, rounded up, as of the last tick.
        remaining_secs: u64,
    },
    /// Signed in; the dialog closes.
    Done {
        #[allow(dead_code)] // Read by tests; the dialog closes on this state.
        address: String,
    },
    /// The code expired or the server forgot it (Req 48.3).
    Expired,
    /// The request failed; the text is shown with a retry hint.
    Failed(String),
}

/// What can happen to a pairing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingEvent {
    /// The user pressed P.
    Started,
    /// `POST /auth/pair` succeeded at `now`.
    Created {
        code: String,
        url: String,
        expires_in_s: u64,
        interval_s: u64,
        now: u64,
    },
    /// Time passed: check expiry and refresh the countdown.
    Tick { now: u64 },
    /// A poll answered `pending`.
    PollPending { now: u64 },
    /// A poll failed for a passing reason (network error, 5xx); try again after the interval.
    PollRetry { now: u64 },
    /// A poll answered `ok`.
    PollOk { address: String },
    /// A poll answered 404: unknown or expired.
    PollNotFound,
    /// A poll answered 429: wait twice as long.
    PollRateLimited { now: u64 },
    /// An unrecoverable failure.
    Fail(String),
    /// Esc.
    Cancel,
}

impl PairingState {
    /// True while the dialog is on screen and takes over the keys.
    pub fn is_open(&self) -> bool {
        !matches!(self, Self::Idle | Self::Done { .. })
    }

    /// The next time the driver must wake: a poll, or the countdown changing. `None` unless the
    /// code is showing.
    pub fn next_wake(&self) -> Option<u64> {
        match self {
            Self::Showing {
                expires_at,
                next_poll,
                remaining_secs,
                ..
            } => {
                let change =
                    expires_at.saturating_sub(remaining_secs.saturating_sub(1).saturating_mul(1000));
                Some((*next_poll).min(change))
            }
            _ => None,
        }
    }

    /// Applies `event` and returns whether the state changed.
    pub fn apply(&mut self, event: PairingEvent) -> bool {
        let next = self.next(event);
        let changed = next != *self;
        *self = next;
        changed
    }

    /// The state after `event`. Events that do not fit the state change nothing.
    pub fn next(&self, event: PairingEvent) -> Self {
        use PairingEvent as E;
        match (self, event) {
            (_, E::Cancel) => Self::Idle,
            (Self::Idle | Self::Done { .. } | Self::Expired | Self::Failed(_), E::Started) => {
                Self::Requesting
            }
            (
                Self::Requesting,
                E::Created {
                    code,
                    url,
                    expires_in_s,
                    interval_s,
                    now,
                },
            ) => {
                let expires_ms = expires_in_s.saturating_mul(1000);
                let interval_ms = interval_s
                    .saturating_mul(1000)
                    .clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS);
                Self::Showing {
                    code,
                    url,
                    expires_at: now.saturating_add(expires_ms),
                    interval_ms,
                    next_poll: now.saturating_add(interval_ms),
                    remaining_secs: expires_ms.div_ceil(1000),
                }
            }
            (Self::Requesting | Self::Showing { .. }, E::Fail(message)) => Self::Failed(message),
            (Self::Showing { .. }, E::PollOk { address }) => Self::Done { address },
            (Self::Showing { .. }, E::PollNotFound) => Self::Expired,
            (Self::Showing { .. }, other) => self.next_showing(other),
            (state, _) => state.clone(),
        }
    }

    /// Time-driven events while the code is showing.
    fn next_showing(&self, event: PairingEvent) -> Self {
        use PairingEvent as E;
        let mut state = self.clone();
        let Self::Showing {
            expires_at,
            interval_ms,
            next_poll,
            remaining_secs,
            ..
        } = &mut state
        else {
            return self.clone();
        };
        let now = match event {
            E::Tick { now }
            | E::PollPending { now }
            | E::PollRetry { now }
            | E::PollRateLimited { now } => now,
            _ => return self.clone(),
        };
        if now >= *expires_at {
            return Self::Expired;
        }
        match event {
            E::Tick { .. } => {
                *remaining_secs = expires_at.saturating_sub(now).div_ceil(1000);
            }
            E::PollPending { .. } | E::PollRetry { .. } => {
                *next_poll = now.saturating_add(*interval_ms);
            }
            E::PollRateLimited { .. } => {
                *interval_ms = interval_ms.saturating_mul(2).min(MAX_INTERVAL_MS);
                *next_poll = now.saturating_add(*interval_ms);
            }
            _ => {}
        }
        state
    }
}

/// What the driver reports to the main loop.
pub enum PairingKind {
    /// The driver's state changed.
    State(PairingState),
    /// The server issued a token. The main loop saves it and authenticates.
    SignedIn(Box<StoredSession>),
}

impl fmt::Debug for PairingKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::State(state) => f.debug_tuple("State").field(state).finish(),
            Self::SignedIn(session) => f.debug_tuple("SignedIn").field(session).finish(),
        }
    }
}

/// A driver message tagged with the pairing attempt that produced it, so the main loop can
/// ignore late messages of a cancelled attempt.
#[derive(Debug)]
pub struct PairingMsg {
    pub id: u64,
    pub kind: PairingKind,
}

/// The result of one poll, decided from the HTTP response.
#[derive(Debug, PartialEq, Eq)]
pub enum PollResult {
    Pending,
    Ok(Box<StoredSession>),
    NotFound,
    RateLimited,
    /// A passing failure: poll again after the interval.
    Retry,
    /// The server refused the request for good.
    Rejected(String),
}

#[derive(Deserialize)]
struct CreateBody {
    code: String,
    pair_url: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct PollBody {
    status: String,
    token: Option<String>,
    account_id: Option<String>,
    address: Option<String>,
    exp: Option<u64>,
}

/// Reads the `POST /auth/pair` answer into the `Created` event fields. The error text is safe
/// to show.
pub fn interpret_create(
    response: &Result<Response, HttpError>,
) -> Result<(String, String, u64, u64), String> {
    let response = response.as_ref().map_err(HttpError::to_string)?;
    match response.status {
        200 => {}
        429 => return Err("too many attempts, try again in a minute".to_owned()),
        status => return Err(format!("the server answered HTTP {status}")),
    }
    let body: CreateBody = serde_json::from_slice(&response.body)
        .map_err(|_| "the server sent an unreadable pairing answer".to_owned())?;
    if body.code.is_empty() || body.code.len() > 32 {
        return Err("the server sent an unusable pairing code".to_owned());
    }
    Ok((
        body.code,
        display_url(&body.pair_url),
        body.expires_in,
        body.interval,
    ))
}

/// Decides what a poll answer means. `server` is the `--server` URL the token is stored for.
pub fn interpret_poll(response: &Result<Response, HttpError>, server: &str) -> PollResult {
    let Ok(response) = response else {
        return PollResult::Retry;
    };
    match response.status {
        404 => PollResult::NotFound,
        429 => PollResult::RateLimited,
        400 => PollResult::Rejected("the server rejected the pairing request".to_owned()),
        200 => {
            let Ok(body) = serde_json::from_slice::<PollBody>(&response.body) else {
                return PollResult::Retry;
            };
            match body.status.as_str() {
                "pending" => PollResult::Pending,
                "ok" => match (body.token, body.address, body.exp) {
                    (Some(token), Some(address), Some(exp)) if !token.is_empty() => {
                        let account_id = body
                            .account_id
                            .unwrap_or_else(|| format!("w_{address}"));
                        PollResult::Ok(Box::new(StoredSession {
                            server: server.to_owned(),
                            token,
                            address,
                            account_id,
                            exp,
                        }))
                    }
                    _ => PollResult::Rejected("the server sent an incomplete sign-in".to_owned()),
                },
                _ => PollResult::Retry,
            }
        }
        _ => PollResult::Retry,
    }
}

/// After a successful pairing: the `Authenticate` message to send, and the result of saving the
/// token for this server (Req 48.1, 48.11). The message is returned even if saving failed, so
/// this run is signed in either way.
pub fn complete_sign_in(
    session: &StoredSession,
    store: Option<&TokenStore>,
) -> (ClientMessage, Result<(), String>) {
    let message = ClientMessage::Authenticate {
        token: session.token.clone(),
    };
    let saved = match store {
        Some(store) => store
            .save(session)
            .map_err(|e| format!("signed in, but the token was not saved: {e}")),
        None => Err("signed in, but there is no config directory to save the token".to_owned()),
    };
    (message, saved)
}

/// True for the key that opens the dialog, or retries from the expired or failed screen.
pub fn is_pair_key(keymap: &Keymap, key: &KeyEvent) -> bool {
    key.kind == KeyEventKind::Press
        && chord_from_crossterm(key).is_some_and(|chord| {
            resolve(keymap, Context::Global, &chord) == Some(Action::AuthPair)
        })
}

/// True for Esc, which cancels the dialog.
pub fn is_cancel_key(key: &KeyEvent) -> bool {
    key.kind == KeyEventKind::Press && key.code == KeyCode::Esc
}

/// Owns the driver task. Dropping it cancels the pairing.
#[derive(Debug)]
pub struct PairingHandle {
    task: JoinHandle<()>,
}

impl Drop for PairingHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Starts a pairing attempt `id` against `server` (the `--server` WebSocket URL) on the current
/// tokio runtime.
pub fn spawn(server: &str, id: u64, tx: mpsc::Sender<PairingMsg>) -> PairingHandle {
    let server = server.to_owned();
    let task = tokio::spawn(async move {
        let target = http_base(&server).and_then(|base| Target::parse(&base).ok());
        drive(target, server, id, tx).await;
    });
    PairingHandle { task }
}

fn elapsed_ms(origin: Instant) -> u64 {
    u64::try_from(origin.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Sends the state to the main loop. False when the main loop is gone.
async fn publish(tx: &mpsc::Sender<PairingMsg>, id: u64, state: &PairingState) -> bool {
    let kind = PairingKind::State(state.clone());
    tx.send(PairingMsg { id, kind }).await.is_ok()
}

async fn drive(
    target: Option<Target>,
    server: String,
    id: u64,
    tx: mpsc::Sender<PairingMsg>,
) {
    let origin = Instant::now();
    let mut state = PairingState::Idle;
    state.apply(PairingEvent::Started);
    if !publish(&tx, id, &state).await {
        return;
    }
    let (Some(target), Some(secret)) = (target, generate_secret()) else {
        state.apply(PairingEvent::Fail(
            "invalid server address or no secure random source".to_owned(),
        ));
        publish(&tx, id, &state).await;
        return;
    };
    let secret_text = base64url(&secret);
    let create_body = serde_json::json!({ "verifier": verifier_of(&secret) }).to_string();

    let created = http::request(
        &target,
        Method::Post,
        "/auth/pair",
        None,
        Some(&create_body),
    )
    .await;
    match interpret_create(&created) {
        Ok((code, url, expires_in_s, interval_s)) => {
            state.apply(PairingEvent::Created {
                code,
                url,
                expires_in_s,
                interval_s,
                now: elapsed_ms(origin),
            });
        }
        Err(message) => {
            state.apply(PairingEvent::Fail(message));
            publish(&tx, id, &state).await;
            return;
        }
    }
    if !publish(&tx, id, &state).await {
        return;
    }

    loop {
        let Some(wake) = state.next_wake() else {
            break;
        };
        let now = elapsed_ms(origin);
        if wake > now {
            tokio::time::sleep(Duration::from_millis(wake - now)).await;
        }
        let now = elapsed_ms(origin);
        let mut changed = state.apply(PairingEvent::Tick { now });
        let due = match &state {
            PairingState::Showing {
                code, next_poll, ..
            } if now >= *next_poll => Some(code.clone()),
            _ => None,
        };
        if let Some(code) = due {
            // The secret goes only to the poll route.
            let body = serde_json::json!({ "code": code, "secret": secret_text }).to_string();
            let response = http::request(
                &target,
                Method::Post,
                "/auth/pair/poll",
                None,
                Some(&body),
            )
            .await;
            let now = elapsed_ms(origin);
            let event = match interpret_poll(&response, &server) {
                PollResult::Ok(session) => {
                    let address = session.address.clone();
                    state.apply(PairingEvent::PollOk { address });
                    let kind = PairingKind::SignedIn(session);
                    let _ = tx.send(PairingMsg { id, kind }).await;
                    return;
                }
                PollResult::Pending => PairingEvent::PollPending { now },
                PollResult::Retry => PairingEvent::PollRetry { now },
                PollResult::NotFound => PairingEvent::PollNotFound,
                PollResult::RateLimited => PairingEvent::PollRateLimited { now },
                PollResult::Rejected(message) => PairingEvent::Fail(message),
            };
            changed |= state.apply(event);
        }
        if changed && !publish(&tx, id, &state).await {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::test_support::TempDir;
    use crossterm::event::{KeyEventState, KeyModifiers};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    // ---- encoding ----

    fn decode_base64url(text: &str) -> Vec<u8> {
        let mut bits = 0_u32;
        let mut count = 0_u32;
        let mut out = Vec::new();
        for c in text.bytes() {
            let value = BASE64URL.iter().position(|b| *b == c).unwrap() as u32;
            bits = (bits << 6) | value;
            count += 6;
            if count >= 8 {
                count -= 8;
                out.push(((bits >> count) & 0xff) as u8);
            }
        }
        out
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn base64url_matches_the_rfc_4648_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg"),
            ("fo", "Zm8"),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg"),
            ("fooba", "Zm9vYmE"),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64url(input.as_bytes()), expected, "{input:?}");
        }
    }

    #[test]
    fn base64url_uses_the_url_alphabet_without_padding() {
        assert_eq!(base64url(&[0xfb]), "-w");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(base64url(&[0xff, 0xff, 0xff]), "____");
        assert_eq!(base64url(&[0_u8; 32]).len(), 43);
        assert!(!base64url(&[1, 2, 3, 4, 5]).contains(['=', '+', '/']));
    }

    #[test]
    fn base64url_round_trips_through_the_test_decoder() {
        for len in 0..40_u8 {
            let bytes: Vec<u8> = (0..len).map(|i| i.wrapping_mul(37).wrapping_add(11)).collect();
            assert_eq!(decode_base64url(&base64url(&bytes)), bytes, "len {len}");
        }
    }

    // Req 48.1
    #[test]
    fn the_verifier_is_base64url_of_the_sha256_of_the_secret() {
        let secret = [0_u8; 32];
        let digest = digest::digest(&digest::SHA256, &secret);
        assert_eq!(
            hex(digest.as_ref()),
            "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925"
        );
        let verifier = verifier_of(&secret);
        assert_eq!(verifier.len(), 43);
        assert_eq!(decode_base64url(&verifier), digest.as_ref());
    }

    #[test]
    fn generated_secrets_are_32_distinct_bytes() {
        let a = generate_secret().unwrap();
        let b = generate_secret().unwrap();
        assert_eq!(a.len(), SECRET_BYTES);
        assert_ne!(a, b);
        assert_ne!(a, [0_u8; SECRET_BYTES]);
    }

    #[test]
    fn code_url_and_countdown_formatting() {
        assert_eq!(format_code("ABCD2345"), "ABCD-2345");
        assert_eq!(format_code("SHORT"), "SHORT");
        assert_eq!(
            display_url("https://app.example.com/pair?code=ABCD2345"),
            "https://app.example.com/pair/?code=ABCD2345"
        );
        assert_eq!(display_url("https://x/pair/?code=A"), "https://x/pair/?code=A");
        assert_eq!(format_countdown(0), "0:00");
        assert_eq!(format_countdown(272), "4:32");
        assert_eq!(format_countdown(300), "5:00");
    }

    // ---- state machine ----

    fn created(now: u64) -> PairingEvent {
        PairingEvent::Created {
            code: "ABCD2345".into(),
            url: "https://w/pair/?code=ABCD2345".into(),
            expires_in_s: 300,
            interval_s: 2,
            now,
        }
    }

    fn showing() -> PairingState {
        let mut state = PairingState::Idle;
        state.apply(PairingEvent::Started);
        state.apply(created(1_000));
        state
    }

    #[test]
    fn started_then_created_shows_the_code() {
        let mut state = PairingState::Idle;
        assert!(!state.is_open());
        assert!(state.apply(PairingEvent::Started));
        assert_eq!(state, PairingState::Requesting);
        assert!(state.is_open());
        state.apply(created(1_000));
        assert_eq!(
            state,
            PairingState::Showing {
                code: "ABCD2345".into(),
                url: "https://w/pair/?code=ABCD2345".into(),
                expires_at: 301_000,
                interval_ms: 2_000,
                next_poll: 3_000,
                remaining_secs: 300,
            }
        );
        // The countdown drops to 299 at 2_000, before the first poll at 3_000.
        assert_eq!(state.next_wake(), Some(2_000));
    }

    #[test]
    fn started_twice_does_not_restart_a_live_pairing() {
        let mut state = showing();
        let before = state.clone();
        assert!(!state.apply(PairingEvent::Started));
        assert_eq!(state, before);
    }

    #[test]
    fn the_server_interval_is_clamped() {
        for (given, want) in [(0, MIN_INTERVAL_MS), (5, 5_000), (10_000, MAX_INTERVAL_MS)] {
            let mut state = PairingState::Requesting;
            state.apply(PairingEvent::Created {
                code: "C".into(),
                url: "u".into(),
                expires_in_s: 300,
                interval_s: given,
                now: 0,
            });
            let PairingState::Showing { interval_ms, .. } = state else {
                panic!("not showing");
            };
            assert_eq!(interval_ms, want);
        }
    }

    // pending -> ok
    #[test]
    fn pending_schedules_the_next_poll_and_ok_finishes() {
        let mut state = showing();
        assert!(state.apply(PairingEvent::PollPending { now: 3_000 }));
        let PairingState::Showing { next_poll, .. } = &state else {
            panic!("not showing");
        };
        assert_eq!(*next_poll, 5_000);
        assert!(state.apply(PairingEvent::PollRetry { now: 5_100 }));
        let PairingState::Showing { next_poll, .. } = &state else {
            panic!("not showing");
        };
        assert_eq!(*next_poll, 7_100);
        assert!(state.apply(PairingEvent::PollOk { address: "ADDR".into() }));
        assert_eq!(state, PairingState::Done { address: "ADDR".into() });
        assert!(!state.is_open());
        assert_eq!(state.next_wake(), None);
    }

    // 404
    #[test]
    fn a_404_expires_the_pairing() {
        let mut state = showing();
        assert!(state.apply(PairingEvent::PollNotFound));
        assert_eq!(state, PairingState::Expired);
        assert!(state.is_open());
        assert_eq!(EXPIRED_TEXT, "Pairing expired, press P to retry");
    }

    // expiry
    #[test]
    fn ticks_count_down_and_expire() {
        let mut state = showing();
        // Same displayed second: nothing changed.
        assert!(!state.apply(PairingEvent::Tick { now: 1_000 }));
        assert!(!state.apply(PairingEvent::Tick { now: 1_500 }));
        // 299.5 s left rounds up to 300; 299.0 s left is 299.
        assert!(state.apply(PairingEvent::Tick { now: 2_000 }));
        let PairingState::Showing { remaining_secs, .. } = &state else {
            panic!("not showing");
        };
        assert_eq!(*remaining_secs, 299);
        assert!(state.apply(PairingEvent::Tick { now: 300_999 }));
        let PairingState::Showing { remaining_secs, .. } = &state else {
            panic!("not showing");
        };
        assert_eq!(*remaining_secs, 1);
        assert!(state.apply(PairingEvent::Tick { now: 301_000 }));
        assert_eq!(state, PairingState::Expired);
        // A late pending answer cannot revive it.
        assert!(!state.apply(PairingEvent::PollPending { now: 302_000 }));
        assert_eq!(state, PairingState::Expired);
    }

    #[test]
    fn a_poll_answer_at_the_expiry_time_expires_instead() {
        let mut state = showing();
        assert!(state.apply(PairingEvent::PollPending { now: 301_000 }));
        assert_eq!(state, PairingState::Expired);
    }

    #[test]
    fn next_wake_follows_the_countdown_when_it_comes_first() {
        let mut state = showing();
        state.apply(PairingEvent::PollPending { now: 3_000 });
        // 300 s remain at 1_000; the display drops to 299 at 2_000, before the poll at 5_000.
        assert_eq!(state.next_wake(), Some(2_000));
        state.apply(PairingEvent::Tick { now: 2_000 });
        assert_eq!(state.next_wake(), Some(3_000));
    }

    // 429
    #[test]
    fn a_429_doubles_the_interval_up_to_the_cap() {
        let mut state = showing();
        let mut now = 3_000;
        let mut expected = 2_000;
        for _ in 0..8 {
            state.apply(PairingEvent::PollRateLimited { now });
            expected = (expected * 2).min(MAX_INTERVAL_MS);
            let PairingState::Showing {
                interval_ms,
                next_poll,
                ..
            } = &state
            else {
                panic!("not showing");
            };
            assert_eq!(*interval_ms, expected);
            assert_eq!(*next_poll, now + expected);
            now = *next_poll;
        }
        assert_eq!(expected, MAX_INTERVAL_MS);
    }

    // cancel
    #[test]
    fn cancel_closes_from_every_state() {
        for mut state in [
            PairingState::Requesting,
            showing(),
            PairingState::Expired,
            PairingState::Failed("x".into()),
        ] {
            assert!(state.apply(PairingEvent::Cancel));
            assert_eq!(state, PairingState::Idle);
        }
        let mut idle = PairingState::Idle;
        assert!(!idle.apply(PairingEvent::Cancel));
    }

    #[test]
    fn failures_and_retry_after_expiry() {
        let mut state = PairingState::Requesting;
        assert!(state.apply(PairingEvent::Fail("boom".into())));
        assert_eq!(state, PairingState::Failed("boom".into()));
        assert!(state.apply(PairingEvent::Started));
        assert_eq!(state, PairingState::Requesting);
        let mut expired = PairingState::Expired;
        assert!(expired.apply(PairingEvent::Started));
        assert_eq!(expired, PairingState::Requesting);
        // Events that do not fit change nothing.
        let mut idle = PairingState::Idle;
        assert!(!idle.apply(PairingEvent::PollNotFound));
        assert!(!idle.apply(created(0)));
    }

    // ---- interpreting responses ----

    fn reply(status: u16, body: &str) -> Result<Response, HttpError> {
        Ok(Response {
            status,
            body: body.as_bytes().to_vec(),
        })
    }

    const SERVER: &str = "wss://example.com/ws";

    #[test]
    fn create_answers_are_interpreted() {
        let ok = reply(
            200,
            r#"{"code":"ABCD2345","pair_url":"https://w.example/pair?code=ABCD2345","expires_in":300,"interval":2}"#,
        );
        assert_eq!(
            interpret_create(&ok),
            Ok((
                "ABCD2345".to_owned(),
                "https://w.example/pair/?code=ABCD2345".to_owned(),
                300,
                2
            ))
        );
        assert!(interpret_create(&reply(429, "{}")).unwrap_err().contains("too many"));
        assert!(interpret_create(&reply(500, "")).unwrap_err().contains("500"));
        assert!(interpret_create(&reply(200, "nope")).is_err());
        assert!(interpret_create(&Err(HttpError::Timeout)).is_err());
    }

    #[test]
    fn poll_answers_are_interpreted() {
        assert_eq!(interpret_poll(&reply(200, r#"{"status":"pending"}"#), SERVER), PollResult::Pending);
        assert_eq!(interpret_poll(&reply(404, r#"{"error":"not_found"}"#), SERVER), PollResult::NotFound);
        assert_eq!(interpret_poll(&reply(429, "{}"), SERVER), PollResult::RateLimited);
        assert!(matches!(interpret_poll(&reply(400, "{}"), SERVER), PollResult::Rejected(_)));
        assert_eq!(interpret_poll(&reply(503, ""), SERVER), PollResult::Retry);
        assert_eq!(interpret_poll(&reply(200, "garbage"), SERVER), PollResult::Retry);
        assert_eq!(interpret_poll(&Err(HttpError::Timeout), SERVER), PollResult::Retry);
        let ok = reply(
            200,
            r#"{"status":"ok","token":"v1.p.m","account_id":"w_ADDR","address":"ADDR","exp":1900000000}"#,
        );
        assert_eq!(
            interpret_poll(&ok, SERVER),
            PollResult::Ok(Box::new(StoredSession {
                server: SERVER.to_owned(),
                token: "v1.p.m".to_owned(),
                address: "ADDR".to_owned(),
                account_id: "w_ADDR".to_owned(),
                exp: 1_900_000_000,
            }))
        );
        let incomplete = reply(200, r#"{"status":"ok","address":"ADDR"}"#);
        assert!(matches!(interpret_poll(&incomplete, SERVER), PollResult::Rejected(_)));
    }

    // Req 48.1, 48.11
    #[test]
    fn complete_sign_in_saves_for_this_server_and_authenticates() {
        let tmp = TempDir::new();
        let store = TokenStore::in_dir(&tmp.0);
        let session = StoredSession {
            server: SERVER.to_owned(),
            token: "v1.p.m".to_owned(),
            address: "ADDR".to_owned(),
            account_id: "w_ADDR".to_owned(),
            exp: u64::MAX,
        };
        let (message, saved) = complete_sign_in(&session, Some(&store));
        assert_eq!(message, ClientMessage::Authenticate { token: "v1.p.m".to_owned() });
        assert_eq!(saved, Ok(()));
        assert_eq!(store.load(SERVER, 0), Some(session.clone()));
        assert_eq!(store.load("wss://other/ws", 0), None);
        // Without a store the run is still signed in, and the failure is reported.
        let (message, saved) = complete_sign_in(&session, None);
        assert!(matches!(message, ClientMessage::Authenticate { .. }));
        assert!(saved.unwrap_err().contains("no config directory"));
    }

    // ---- keys ----

    fn key(code: KeyCode, modifiers: KeyModifiers, kind: KeyEventKind) -> KeyEvent {
        KeyEvent {
            code,
            modifiers,
            kind,
            state: KeyEventState::NONE,
        }
    }

    #[test]
    fn p_opens_and_esc_cancels() {
        let keymap = Keymap::embedded().unwrap();
        let press = |c, m| key(c, m, KeyEventKind::Press);
        assert!(is_pair_key(&keymap, &press(KeyCode::Char('p'), KeyModifiers::NONE)));
        assert!(is_pair_key(&keymap, &press(KeyCode::Char('P'), KeyModifiers::SHIFT)));
        assert!(!is_pair_key(&keymap, &press(KeyCode::Char('q'), KeyModifiers::NONE)));
        assert!(!is_pair_key(
            &keymap,
            &key(KeyCode::Char('p'), KeyModifiers::NONE, KeyEventKind::Release)
        ));
        assert!(is_cancel_key(&press(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(!is_cancel_key(&press(KeyCode::Enter, KeyModifiers::NONE)));
        assert!(!is_cancel_key(&key(KeyCode::Esc, KeyModifiers::NONE, KeyEventKind::Release)));
    }

    // ---- driver against a mock HTTP server ----

    type Log = Arc<Mutex<Vec<(String, String)>>>;

    /// Serves canned answers on 127.0.0.1: `create` for `/auth/pair`, then `polls` in order for
    /// `/auth/pair/poll` (the last one repeats). Returns the `ws://` URL and the request log of
    /// `(path, body)`.
    async fn mock(create: (u16, String), polls: Vec<(u16, String)>) -> (String, Log) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = format!("ws://{}/ws", listener.local_addr().unwrap());
        let log: Log = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&log);
        tokio::spawn(async move {
            let mut polled = 0_usize;
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut raw = Vec::new();
                let mut chunk = [0_u8; 2048];
                let (head_end, length) = loop {
                    let n = socket.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        break (raw.len(), 0);
                    }
                    raw.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&raw[..pos]).to_ascii_lowercase();
                        let length = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        break (pos + 4, length);
                    }
                };
                while raw.len() < head_end + length {
                    let n = socket.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&raw[..head_end]).into_owned();
                let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
                let body = String::from_utf8_lossy(&raw[head_end..]).into_owned();
                let (status, answer) = if path == "/auth/pair" {
                    create.clone()
                } else {
                    let i = polled.min(polls.len() - 1);
                    polled += 1;
                    polls[i].clone()
                };
                seen.lock().unwrap().push((path, body));
                let text = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                    answer.len()
                );
                socket.write_all(text.as_bytes()).await.unwrap();
                socket.shutdown().await.ok();
            }
        });
        (server, log)
    }

    fn create_reply() -> (u16, String) {
        (
            200,
            r#"{"code":"ABCD2345","pair_url":"https://w.example/pair?code=ABCD2345","expires_in":30,"interval":1}"#
                .to_owned(),
        )
    }

    const OK_REPLY: &str =
        r#"{"status":"ok","token":"v1.p.m","account_id":"w_ADDR","address":"ADDR","exp":1900000000}"#;

    async fn next(rx: &mut mpsc::Receiver<PairingMsg>) -> PairingMsg {
        tokio::time::timeout(Duration::from_secs(15), rx.recv())
            .await
            .expect("driver message in time")
            .expect("driver still running")
    }

    #[tokio::test]
    async fn the_driver_goes_from_pending_to_ok_and_sends_the_secret_only_to_poll() {
        let (server, log) = mock(
            create_reply(),
            vec![
                (200, r#"{"status":"pending"}"#.to_owned()),
                (200, OK_REPLY.to_owned()),
            ],
        )
        .await;
        let (tx, mut rx) = mpsc::channel(32);
        let _handle = spawn(&server, 9, tx);

        let mut saw_requesting = false;
        let mut saw_showing = false;
        let session = loop {
            let msg = next(&mut rx).await;
            assert_eq!(msg.id, 9);
            match msg.kind {
                PairingKind::State(PairingState::Requesting) => saw_requesting = true,
                PairingKind::State(PairingState::Showing { code, url, .. }) => {
                    assert_eq!(code, "ABCD2345");
                    assert_eq!(url, "https://w.example/pair/?code=ABCD2345");
                    saw_showing = true;
                }
                PairingKind::State(other) => panic!("unexpected state {other:?}"),
                PairingKind::SignedIn(session) => break session,
            }
        };
        assert!(saw_requesting && saw_showing);
        assert_eq!(session.token, "v1.p.m");
        assert_eq!(session.address, "ADDR");
        assert_eq!(session.server, server);

        let log = log.lock().unwrap().clone();
        assert_eq!(log[0].0, "/auth/pair");
        let verifier = serde_json::from_str::<serde_json::Value>(&log[0].1).unwrap()["verifier"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(verifier.len(), 43);
        let polls: Vec<&(String, String)> =
            log.iter().filter(|(p, _)| p == "/auth/pair/poll").collect();
        assert_eq!(polls.len(), 2, "{log:?}");
        let poll: serde_json::Value = serde_json::from_str(&polls[0].1).unwrap();
        assert_eq!(poll["code"], "ABCD2345");
        let secret = poll["secret"].as_str().unwrap().to_owned();
        assert_eq!(secret.len(), 43);
        // The verifier is the hash of the secret, and the secret never went to /auth/pair.
        assert_eq!(verifier_of(&decode_base64url(&secret)), verifier);
        assert!(!log[0].1.contains(&secret));
        assert!(!log[0].1.contains("secret"));
    }

    #[tokio::test]
    async fn the_driver_reports_expired_on_a_404() {
        let (server, log) = mock(create_reply(), vec![(404, r#"{"error":"not_found"}"#.into())]).await;
        let (tx, mut rx) = mpsc::channel(32);
        let _handle = spawn(&server, 1, tx);
        loop {
            match next(&mut rx).await.kind {
                PairingKind::State(PairingState::Expired) => break,
                PairingKind::State(_) => {}
                PairingKind::SignedIn(_) => panic!("signed in on a 404"),
            }
        }
        assert!(log.lock().unwrap().iter().any(|(p, _)| p == "/auth/pair/poll"));
    }

    #[tokio::test]
    async fn the_driver_expires_when_the_code_times_out() {
        let short = (
            200,
            r#"{"code":"ABCD2345","pair_url":"https://w.example/pair?code=ABCD2345","expires_in":1,"interval":5}"#
                .to_owned(),
        );
        let (server, log) = mock(short, vec![(200, r#"{"status":"pending"}"#.into())]).await;
        let (tx, mut rx) = mpsc::channel(32);
        let _handle = spawn(&server, 1, tx);
        loop {
            match next(&mut rx).await.kind {
                PairingKind::State(PairingState::Expired) => break,
                PairingKind::State(_) => {}
                PairingKind::SignedIn(_) => panic!("signed in without a poll"),
            }
        }
        // It expired before the first poll was due.
        assert!(log.lock().unwrap().iter().all(|(p, _)| p != "/auth/pair/poll"));
    }

    #[tokio::test]
    async fn the_driver_fails_when_the_server_refuses_the_pairing() {
        let (server, _log) = mock((429, "{}".to_owned()), vec![(200, "{}".to_owned())]).await;
        let (tx, mut rx) = mpsc::channel(32);
        let _handle = spawn(&server, 1, tx);
        loop {
            match next(&mut rx).await.kind {
                PairingKind::State(PairingState::Failed(message)) => {
                    assert!(message.contains("too many"), "{message}");
                    break;
                }
                PairingKind::State(_) => {}
                PairingKind::SignedIn(_) => panic!("signed in"),
            }
        }
    }

    #[tokio::test]
    async fn dropping_the_handle_cancels_the_pairing() {
        let (server, log) = mock(create_reply(), vec![(200, r#"{"status":"pending"}"#.into())]).await;
        let (tx, mut rx) = mpsc::channel(32);
        let handle = spawn(&server, 1, tx);
        // Wait for the code to show, then cancel before the first poll is due.
        loop {
            if matches!(next(&mut rx).await.kind, PairingKind::State(PairingState::Showing { .. })) {
                break;
            }
        }
        drop(handle);
        tokio::time::sleep(Duration::from_millis(1_600)).await;
        assert!(log.lock().unwrap().iter().all(|(p, _)| p != "/auth/pair/poll"));
        // The task is gone, so the channel closes.
        assert!(rx.recv().await.is_none());
    }
}
