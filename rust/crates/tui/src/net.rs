//! WebSocket client task: connect, reconnect with backoff, resubscribe (Req 33.1–33.3).
//!
//! [`spawn_connection`] starts one tokio task that owns the connection. The app talks to it
//! through two channels: it sends [`ClientMessage`]s in and receives [`NetEvent`]s out.
//!
//! - **Backoff (Req 33.2):** the delay before a reconnect starts at 250 ms and doubles after
//!   each consecutive failure, capped at 10 s. It resets when the server's `hello` arrives,
//!   not when the TCP/WebSocket handshake succeeds: a proxy in front of a sleeping server can
//!   accept the upgrade and then drop it, and resetting on the handshake alone would turn that
//!   into a 250 ms retry loop. `hello` proves the server itself is up. The attempt counter
//!   resets at the same moment.
//! - **Subscriptions (Req 33.3):** every outgoing `subscribe` and `unsubscribe` updates a
//!   deduplicated set, and the whole set is sent again after every connect, before any other
//!   queued message.
//! - **Offline messages:** while the task waits to reconnect, outgoing messages only update the
//!   subscription set; everything else (confirms, cancels, pings) is dropped rather than
//!   replayed later against a server the user can no longer see.
//! - **Bad frames:** text frames that don't decode as a [`ServerMessage`], and binary frames,
//!   become [`NetEvent::BadFrame`] and are skipped. Nothing here panics.
//! - **Limits:** messages and frames are capped at 1 MiB through tungstenite's
//!   `WebSocketConfig`. A `ping` goes out every 15 s.
//!
//! - **Authentication (Req 33.4, 48.12):** after each `hello`, the task asks its token source
//!   and, if there is a token, sends `authenticate` with it. The token is never logged.
//!
//! The task ends when the app drops either channel end.

use std::sync::Once;
use std::time::Duration;

use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use protocol::client::{ClientMessage, ServerMessage};
use protocol::{Timeframe, decode_line, encode_line};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{self, Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};

/// Delay before the first reconnect after a failure (Req 33.2).
pub const INITIAL_BACKOFF: Duration = Duration::from_millis(250);
/// Longest delay between connection attempts (Req 33.2).
pub const MAX_BACKOFF: Duration = Duration::from_secs(10);
/// How often the client sends a `ping`.
pub const PING_INTERVAL: Duration = Duration::from_secs(15);
/// How long one connection attempt (TCP, TLS, and upgrade) may take before it counts as failed.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Largest incoming WebSocket message or frame, in bytes.
pub const MAX_MESSAGE_BYTES: usize = 1 << 20;

const CHANNEL_CAPACITY: usize = 256;
/// Longest error text a [`NetEvent`] carries, in characters.
const MAX_REASON_CHARS: usize = 200;

/// Supplies the stored Session_Token, if any, each time the task wants to authenticate.
pub type TokenSource = Box<dyn Fn() -> Option<String> + Send + 'static>;

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
type WsSink = SplitSink<WsStream, Message>;

/// What the connection task reports to the app.
#[derive(Debug, Clone, PartialEq)]
pub enum NetEvent {
    /// Connection attempt `attempt` starts after `next_delay` (zero for an immediate attempt).
    Connecting { attempt: u32, next_delay: Duration },
    /// The WebSocket is open; subscriptions have been queued for resend.
    Connected,
    /// A decoded message from the server.
    Message(Box<ServerMessage>),
    /// A frame that was not a valid [`ServerMessage`]; it was skipped.
    BadFrame { error: String },
    /// The connection attempt failed or the open connection was lost.
    Disconnected { reason: String },
}

#[cfg(test)]
impl NetEvent {
    /// Test constructor: a boxed [`NetEvent::Message`].
    pub fn msg(message: ServerMessage) -> Self {
        Self::Message(Box::new(message))
    }
}

/// Reconnect delays: 250 ms, doubling, capped at 10 s (Req 33.2). Pure; no clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backoff {
    next: Duration,
}

impl Backoff {
    pub fn new() -> Self {
        Self {
            next: INITIAL_BACKOFF,
        }
    }

    /// The delay to wait now; the following call returns twice as much, up to [`MAX_BACKOFF`].
    pub fn next_delay(&mut self) -> Duration {
        let delay = self.next;
        self.next = delay.saturating_mul(2).min(MAX_BACKOFF);
        delay
    }

    /// Starts the sequence over at [`INITIAL_BACKOFF`].
    pub fn reset(&mut self) {
        self.next = INITIAL_BACKOFF;
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
    }
}

/// One market-data subscription.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
    pub venue: protocol::Venue,
    pub symbol: String,
    pub timeframe: Timeframe,
}

impl Subscription {
    /// A subscription on the `replay` venue; the app moves it with a venue switch (Task 16.3).
    pub fn new(symbol: impl Into<String>, timeframe: Timeframe) -> Self {
        Self::on(protocol::Venue::Replay, symbol, timeframe)
    }

    pub fn on(venue: protocol::Venue, symbol: impl Into<String>, timeframe: Timeframe) -> Self {
        Self {
            venue,
            symbol: symbol.into(),
            timeframe,
        }
    }

    fn to_message(&self) -> ClientMessage {
        ClientMessage::Subscribe {
            venue: self.venue,
            symbol: self.symbol.clone(),
            timeframe: self.timeframe,
        }
    }
}

/// The active subscriptions, deduplicated, in the order they were first added (Req 33.3).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SubscriptionSet {
    subs: Vec<Subscription>,
}

impl SubscriptionSet {
    pub fn new(initial: impl IntoIterator<Item = Subscription>) -> Self {
        let mut set = Self::default();
        for sub in initial {
            set.insert(sub);
        }
        set
    }

    /// Updates the set from an outgoing message. Only `subscribe` and `unsubscribe` matter.
    pub fn observe(&mut self, message: &ClientMessage) {
        match message {
            ClientMessage::Subscribe {
                venue,
                symbol,
                timeframe,
            } => {
                self.insert(Subscription::on(*venue, symbol.clone(), *timeframe));
            }
            ClientMessage::Unsubscribe {
                venue,
                symbol,
                timeframe,
            } => {
                self.subs.retain(|s| {
                    !(s.venue == *venue && s.symbol == *symbol && s.timeframe == *timeframe)
                });
            }
            _ => {}
        }
    }

    /// The `subscribe` messages to send after a (re)connect.
    pub fn messages(&self) -> Vec<ClientMessage> {
        self.subs.iter().map(Subscription::to_message).collect()
    }

    fn insert(&mut self, sub: Subscription) {
        if !self.subs.contains(&sub) {
            self.subs.push(sub);
        }
    }
}

/// Starts the connection task on the current tokio runtime. `initial_subs` are sent after
/// every connect, together with any subscriptions sent through the returned sender.
///
/// `token_source` is asked for a Session_Token after every `hello` (Req 33.4, 48.12). It returns
/// `None` for guest mode or when no unexpired token is stored. Asking each time means a token
/// deleted after `auth_failed` or `session_expired` is not sent again on the next reconnect.
pub fn spawn_connection(
    url: String,
    initial_subs: Vec<Subscription>,
    token_source: TokenSource,
) -> (mpsc::Sender<ClientMessage>, mpsc::Receiver<NetEvent>) {
    install_crypto_provider();
    let (out_tx, out_rx) = mpsc::channel(CHANNEL_CAPACITY);
    let (event_tx, event_rx) = mpsc::channel(CHANNEL_CAPACITY);
    let client = Client {
        url,
        subs: SubscriptionSet::new(initial_subs),
        outgoing: out_rx,
        events: event_tx,
        backoff: Backoff::new(),
        attempt: 1,
        ping_id: 0,
        token_source,
    };
    tokio::spawn(client.run());
    (out_tx, event_rx)
}

/// Installs rustls' `ring` provider as the process default, once. An `Err` means another
/// provider was installed first, which is fine.
fn install_crypto_provider() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// How one open connection ended.
enum SessionEnd {
    /// The app dropped a channel end; the task stops.
    AppGone,
    /// The connection was lost; the task reconnects.
    Lost(String),
}

struct Client {
    url: String,
    subs: SubscriptionSet,
    outgoing: mpsc::Receiver<ClientMessage>,
    events: mpsc::Sender<NetEvent>,
    backoff: Backoff,
    attempt: u32,
    ping_id: u64,
    token_source: TokenSource,
}

impl Client {
    async fn run(mut self) {
        let mut delay = Duration::ZERO;
        loop {
            let connecting = NetEvent::Connecting {
                attempt: self.attempt,
                next_delay: delay,
            };
            if self.events.send(connecting).await.is_err() {
                return;
            }
            if !delay.is_zero() && !self.wait(delay).await {
                return;
            }
            let reason = match connect(&self.url).await {
                Ok(ws) => match self.session(ws).await {
                    SessionEnd::AppGone => return,
                    SessionEnd::Lost(reason) => reason,
                },
                Err(reason) => reason,
            };
            if self
                .events
                .send(NetEvent::Disconnected { reason })
                .await
                .is_err()
            {
                return;
            }
            self.attempt = self.attempt.saturating_add(1);
            delay = self.backoff.next_delay();
        }
    }

    /// Sleeps for `delay` while tracking subscriptions. Returns false if the app is gone.
    async fn wait(&mut self, delay: Duration) -> bool {
        let sleep = time::sleep(delay);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                () = &mut sleep => return true,
                message = self.outgoing.recv() => match message {
                    Some(message) => self.subs.observe(&message),
                    None => return false,
                },
            }
        }
    }

    async fn session(&mut self, ws: WsStream) -> SessionEnd {
        let (mut sink, mut stream) = ws.split();
        if self.events.send(NetEvent::Connected).await.is_err() {
            return SessionEnd::AppGone;
        }
        // Req 33.3: resubscribe before anything else goes out.
        for message in self.subs.messages() {
            if let Err(reason) = send(&mut sink, &message).await {
                return SessionEnd::Lost(reason);
            }
        }
        let mut ping = time::interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                message = self.outgoing.recv() => {
                    let Some(message) = message else {
                        let _ = sink.close().await;
                        return SessionEnd::AppGone;
                    };
                    self.subs.observe(&message);
                    if let Err(reason) = send(&mut sink, &message).await {
                        return SessionEnd::Lost(reason);
                    }
                }
                frame = stream.next() => {
                    let mut authenticate = false;
                    let event = match frame {
                        None => return SessionEnd::Lost("connection closed".to_owned()),
                        Some(Err(err)) => return SessionEnd::Lost(shorten(&err.to_string())),
                        Some(Ok(Message::Close(frame))) => {
                            return SessionEnd::Lost(close_reason(frame.as_ref()));
                        }
                        Some(Ok(Message::Text(text))) => {
                            match decode_line::<ServerMessage>(text.as_str()) {
                                Ok(message) => {
                                    if matches!(message, ServerMessage::Hello { .. }) {
                                        // The server is really up: start the next outage's
                                        // backoff and attempt count from the beginning.
                                        self.backoff.reset();
                                        self.attempt = 0;
                                        authenticate = true;
                                    }
                                    NetEvent::Message(Box::new(message))
                                }
                                Err(err) => NetEvent::BadFrame {
                                    error: shorten(&err.to_string()),
                                },
                            }
                        }
                        Some(Ok(Message::Binary(_))) => NetEvent::BadFrame {
                            error: "unexpected binary frame".to_owned(),
                        },
                        // Pings are answered by tungstenite; pongs and raw frames carry nothing.
                        Some(Ok(_)) => continue,
                    };
                    if self.events.send(event).await.is_err() {
                        return SessionEnd::AppGone;
                    }
                    // Req 33.4: sign the connection in after every hello, when a token is stored.
                    if authenticate && let Some(token) = (self.token_source)() {
                        let message = ClientMessage::Authenticate { token };
                        if let Err(reason) = send(&mut sink, &message).await {
                            return SessionEnd::Lost(reason);
                        }
                    }
                }
                _ = ping.tick() => {
                    self.ping_id = self.ping_id.wrapping_add(1);
                    let message = ClientMessage::Ping { id: self.ping_id };
                    if let Err(reason) = send(&mut sink, &message).await {
                        return SessionEnd::Lost(reason);
                    }
                }
            }
        }
    }
}

async fn connect(url: &str) -> Result<WsStream, String> {
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES));
    match time::timeout(
        CONNECT_TIMEOUT,
        connect_async_with_config(url, Some(config), true),
    )
    .await
    {
        Ok(Ok((ws, _response))) => Ok(ws),
        Ok(Err(err)) => Err(shorten(&err.to_string())),
        Err(_) => Err(format!(
            "connect timed out after {} s",
            CONNECT_TIMEOUT.as_secs()
        )),
    }
}

async fn send(sink: &mut WsSink, message: &ClientMessage) -> Result<(), String> {
    let line = encode_line(message).map_err(|err| shorten(&err.to_string()))?;
    let text = line.trim_end_matches('\n').to_owned();
    sink.send(Message::text(text))
        .await
        .map_err(|err| shorten(&err.to_string()))
}

fn close_reason(frame: Option<&CloseFrame>) -> String {
    match frame {
        Some(frame) if !frame.reason.is_empty() => shorten(&format!(
            "server closed the connection ({}: {})",
            frame.code,
            frame.reason.as_str()
        )),
        Some(frame) => format!("server closed the connection ({})", frame.code),
        None => "server closed the connection".to_owned(),
    }
}

/// Cuts `text` to [`MAX_REASON_CHARS`] characters, appending `…` if it cut.
fn shorten(text: &str) -> String {
    match text.char_indices().nth(MAX_REASON_CHARS) {
        Some((cut, _)) => format!("{}…", text.get(..cut).unwrap_or(text)),
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::client::{DataMode, InstrumentInfo};
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    fn sub(symbol: &str, timeframe: Timeframe) -> ClientMessage {
        ClientMessage::Subscribe {
            venue: protocol::Venue::Replay,
            symbol: symbol.to_owned(),
            timeframe,
        }
    }

    fn unsub(symbol: &str, timeframe: Timeframe) -> ClientMessage {
        ClientMessage::Unsubscribe {
            venue: protocol::Venue::Replay,
            symbol: symbol.to_owned(),
            timeframe,
        }
    }

    // Req 33.2
    #[test]
    fn backoff_doubles_from_250_ms_and_caps_at_10_s() {
        let mut backoff = Backoff::new();
        let delays: Vec<u128> = (0..9).map(|_| backoff.next_delay().as_millis()).collect();
        assert_eq!(
            delays,
            [250, 500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]
        );
        for _ in 0..100 {
            assert!(backoff.next_delay() <= MAX_BACKOFF);
        }
    }

    #[test]
    fn backoff_reset_starts_over() {
        let mut backoff = Backoff::default();
        for _ in 0..5 {
            backoff.next_delay();
        }
        backoff.reset();
        assert_eq!(backoff.next_delay(), INITIAL_BACKOFF);
        assert_eq!(backoff.next_delay(), Duration::from_millis(500));
    }

    // Req 33.3
    #[test]
    fn subscription_set_tracks_and_deduplicates() {
        let mut set = SubscriptionSet::new([
            Subscription::new("BTC-USD", Timeframe::M1),
            Subscription::new("BTC-USD", Timeframe::M1),
        ]);
        assert_eq!(set.messages(), [sub("BTC-USD", Timeframe::M1)]);

        set.observe(&sub("ETH-USD", Timeframe::M5));
        set.observe(&sub("BTC-USD", Timeframe::M1));
        set.observe(&sub("BTC-USD", Timeframe::H1));
        set.observe(&ClientMessage::Ping { id: 1 });
        set.observe(&ClientMessage::CancelAll {
            request_id: "r1".into(),
        });
        assert_eq!(
            set.messages(),
            [
                sub("BTC-USD", Timeframe::M1),
                sub("ETH-USD", Timeframe::M5),
                sub("BTC-USD", Timeframe::H1),
            ]
        );

        set.observe(&unsub("BTC-USD", Timeframe::M1));
        set.observe(&unsub("SOL-USD", Timeframe::D1));
        assert_eq!(
            set.messages(),
            [sub("ETH-USD", Timeframe::M5), sub("BTC-USD", Timeframe::H1)]
        );
    }

    #[test]
    fn shorten_cuts_long_text_on_a_char_boundary() {
        assert_eq!(shorten("short"), "short");
        let long = "é".repeat(MAX_REASON_CHARS + 10);
        let cut = shorten(&long);
        assert_eq!(cut.chars().count(), MAX_REASON_CHARS + 1);
        assert!(cut.ends_with('…'));
    }

    fn hello_text() -> String {
        let hello = ServerMessage::Hello {
            protocol_version: protocol::PROTOCOL_VERSION,
            data_mode: DataMode::Replay,
            live_venues: Vec::new(),
            venue_status: Vec::new(),
            default_venue: protocol::Venue::Replay,
            starting_balance: protocol::Money(0),
            engine_running: true,
            instruments: InstrumentInfo::all(),
            providers: Vec::new(),
            news_enabled: false,
        };
        encode_line(&hello).unwrap().trim_end().to_owned()
    }

    fn is_hello(message: &ServerMessage) -> bool {
        matches!(message, ServerMessage::Hello { .. })
    }

    /// The next non-ping client message the test server receives.
    async fn next_client_message(ws: &mut WebSocketStream<TcpStream>) -> ClientMessage {
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(text))) => {
                    let message: ClientMessage = decode_line(text.as_str()).unwrap();
                    if !matches!(message, ClientMessage::Ping { .. }) {
                        return message;
                    }
                }
                Some(Ok(_)) => {}
                other => panic!("client connection ended: {other:?}"),
            }
        }
    }

    async fn wait_for(
        events: &mut mpsc::Receiver<NetEvent>,
        wanted: impl Fn(&NetEvent) -> bool,
    ) -> NetEvent {
        loop {
            let event = events.recv().await.unwrap();
            if wanted(&event) {
                return event;
            }
        }
    }

    // Req 33.2, 33.3: after the server drops the connection, the client reconnects after the
    // reset 250 ms backoff and resends every subscription, deduplicated.
    #[tokio::test]
    async fn reconnects_and_resubscribes_after_the_server_drops() {
        let outcome = time::timeout(Duration::from_secs(10), async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}/ws", listener.local_addr().unwrap());
            let initial = vec![Subscription::new("BTC-USD", Timeframe::M1)];
            let (tx, mut events) = spawn_connection(url, initial, Box::new(|| None));

            assert_eq!(
                events.recv().await.unwrap(),
                NetEvent::Connecting {
                    attempt: 1,
                    next_delay: Duration::ZERO
                }
            );
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(socket).await.unwrap();
            assert_eq!(events.recv().await.unwrap(), NetEvent::Connected);
            assert_eq!(
                next_client_message(&mut ws).await,
                sub("BTC-USD", Timeframe::M1)
            );

            // A bad frame is reported and skipped; the connection stays up.
            ws.send(Message::text("not json")).await.unwrap();
            ws.send(Message::text(hello_text())).await.unwrap();
            let bad = events.recv().await.unwrap();
            assert!(matches!(bad, NetEvent::BadFrame { .. }), "{bad:?}");
            let hello = events.recv().await.unwrap();
            assert!(
                matches!(&hello, NetEvent::Message(m) if is_hello(m)),
                "{hello:?}"
            );

            tx.send(sub("ETH-USD", Timeframe::M5)).await.unwrap();
            tx.send(sub("BTC-USD", Timeframe::M1)).await.unwrap();
            assert_eq!(
                next_client_message(&mut ws).await,
                sub("ETH-USD", Timeframe::M5)
            );
            assert_eq!(
                next_client_message(&mut ws).await,
                sub("BTC-USD", Timeframe::M1)
            );
            drop(ws);

            let disconnected = events.recv().await.unwrap();
            assert!(
                matches!(disconnected, NetEvent::Disconnected { .. }),
                "{disconnected:?}"
            );
            // Hello reset both the attempt count and the backoff.
            assert_eq!(
                events.recv().await.unwrap(),
                NetEvent::Connecting {
                    attempt: 1,
                    next_delay: INITIAL_BACKOFF
                }
            );

            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(socket).await.unwrap();
            wait_for(&mut events, |e| *e == NetEvent::Connected).await;
            let resent = [
                next_client_message(&mut ws).await,
                next_client_message(&mut ws).await,
            ];
            assert_eq!(
                resent,
                [sub("BTC-USD", Timeframe::M1), sub("ETH-USD", Timeframe::M5)]
            );
        })
        .await;
        assert!(outcome.is_ok(), "test timed out after 10 s");
    }

    // Req 33.4, 48.12: `authenticate` follows `hello` when a token is stored, and is never
    // sent in guest mode.
    #[tokio::test]
    async fn authenticates_after_hello_only_with_a_token() {
        let outcome = time::timeout(Duration::from_secs(10), async {
            for token in [Some("v1.a.b".to_owned()), None] {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let url = format!("ws://{}/ws", listener.local_addr().unwrap());
                let source_token = token.clone();
                let (tx, mut events) = spawn_connection(
                    url,
                    vec![Subscription::new("BTC-USD", Timeframe::M1)],
                    Box::new(move || source_token.clone()),
                );
                let (socket, _) = listener.accept().await.unwrap();
                let mut ws = accept_async(socket).await.unwrap();
                assert_eq!(
                    next_client_message(&mut ws).await,
                    sub("BTC-USD", Timeframe::M1)
                );
                ws.send(Message::text(hello_text())).await.unwrap();
                wait_for(
                    &mut events,
                    |e| matches!(e, NetEvent::Message(m) if is_hello(m)),
                )
                .await;
                match token {
                    Some(token) => {
                        assert_eq!(
                            next_client_message(&mut ws).await,
                            ClientMessage::Authenticate { token }
                        );
                    }
                    None => {
                        time::sleep(Duration::from_millis(200)).await;
                        tx.send(sub("ETH-USD", Timeframe::M5)).await.unwrap();
                        assert_eq!(
                            next_client_message(&mut ws).await,
                            sub("ETH-USD", Timeframe::M5)
                        );
                    }
                }
            }
        })
        .await;
        assert!(outcome.is_ok(), "test timed out after 10 s");
    }
}
