//! Command-line arguments (Req 36.1, 36.2).
//!
//! `--guest` and `--logout` are the sign-in flags of Task 21 (Req 48.12–48.14).

use clap::Parser;

use crate::auth::TokenStore;
use crate::http::{self, HttpError, Method, Target};

/// The hosted server the TUI connects to when `--server` is not given (Req 36.1).
pub const DEFAULT_SERVER_URL: &str = "wss://haunted-terminal-server.onrender.com/ws";

#[derive(Debug, Parser)]
#[command(
    name = "tui",
    version,
    about = "Haunted Terminal: paper-trading terminal client"
)]
pub struct Cli {
    /// WebSocket URL of the Haunted Terminal server (ws:// or wss://).
    #[arg(
        long,
        value_name = "URL",
        default_value = DEFAULT_SERVER_URL,
        value_parser = parse_server_url
    )]
    pub server: String,

    /// Use the shared guest account: do not load the saved sign-in (the file is left alone).
    #[arg(long, conflicts_with = "logout")]
    pub guest: bool,

    /// Sign out: revoke the saved token on the server, delete it, and exit.
    #[arg(long)]
    pub logout: bool,
}

/// The server's HTTP base URL for a `--server` WebSocket URL: `wss` becomes `https`, `ws`
/// becomes `http`, and a trailing `/ws` (and any query or fragment) is dropped.
pub fn http_base(server: &str) -> Option<String> {
    let (scheme, rest) = server.split_once("://")?;
    let http = if scheme.eq_ignore_ascii_case("wss") {
        "https"
    } else if scheme.eq_ignore_ascii_case("ws") {
        "http"
    } else {
        return None;
    };
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix("/ws").unwrap_or(rest);
    Some(format!("{http}://{}", rest.trim_end_matches('/')))
}

/// `--logout`: sends `POST /auth/logout` with the saved token to the server's own HTTP base,
/// deletes the saved file, and returns the line to print. A server that cannot be reached, or
/// that rejects the token, does not keep the file. The token is never part of the message.
pub async fn run_logout(store: &TokenStore, server: &str) -> String {
    let Some(saved) = store.read().filter(|s| s.server == server) else {
        return "tui: no saved sign-in for this server.".to_owned();
    };
    let outcome = match http_base(server).map(|base| Target::parse(&base)) {
        Some(Ok(target)) => {
            http::request(
                &target,
                Method::Post,
                "/auth/logout",
                Some(&saved.token),
                None,
            )
            .await
        }
        _ => Err(HttpError::BadTarget),
    };
    let deleted = store.delete();
    let local = if deleted.is_ok() {
        "removed the saved sign-in"
    } else {
        "could not remove the saved sign-in file"
    };
    match outcome {
        Ok(r) if r.status == 204 => format!("tui: signed out; {local}."),
        // 401: the server no longer accepts the token (expired or already signed out).
        Ok(r) if r.status == 401 => {
            format!("tui: the server no longer accepted the token; {local}.")
        }
        Ok(r) => format!(
            "tui: the server answered HTTP {}; {local}. The token expires on its own.",
            r.status
        ),
        Err(e) => format!(
            "tui: server unreachable ({e}); {local}. The token expires on its own."
        ),
    }
}

/// Accepts only `ws://` or `wss://` URLs with a non-empty host (Req 36.2).
pub fn parse_server_url(input: &str) -> Result<String, String> {
    if input.chars().any(char::is_whitespace) {
        return Err("the server URL must not contain whitespace".to_owned());
    }
    let Some((scheme, rest)) = input.split_once("://") else {
        return Err("expected a ws:// or wss:// URL".to_owned());
    };
    if !(scheme.eq_ignore_ascii_case("ws") || scheme.eq_ignore_ascii_case("wss")) {
        return Err(format!(
            "unsupported scheme `{scheme}`, expected ws:// or wss://"
        ));
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        return Err("the server URL has no host".to_owned());
    }
    Ok(input.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::StoredSession;
    use crate::auth::test_support::TempDir;
    use clap::CommandFactory;
    use clap::error::ErrorKind;

    #[test]
    fn command_definition_is_valid() {
        Cli::command().debug_assert();
    }

    // Req 36.1
    #[test]
    fn server_defaults_to_hosted_url() {
        let cli = Cli::try_parse_from(["tui"]).unwrap();
        assert_eq!(cli.server, DEFAULT_SERVER_URL);
        assert_eq!(cli.server, "wss://haunted-terminal-server.onrender.com/ws");
    }

    // Req 36.2
    #[test]
    fn server_flag_overrides_default() {
        let cli = Cli::try_parse_from(["tui", "--server", "ws://localhost:8080/ws"]).unwrap();
        assert_eq!(cli.server, "ws://localhost:8080/ws");
        let cli = Cli::try_parse_from(["tui", "--server=WSS://example.com/ws"]).unwrap();
        assert_eq!(cli.server, "WSS://example.com/ws");
    }

    #[test]
    fn invalid_server_urls_are_rejected() {
        for bad in [
            "http://localhost:8080/ws",
            "https://example.com/ws",
            "localhost:8080",
            "ws://",
            "wss:///ws",
            "ws://exa mple.com/ws",
            "",
        ] {
            let err = Cli::try_parse_from(["tui", "--server", bad]).unwrap_err();
            assert_eq!(err.kind(), ErrorKind::ValueValidation, "accepted {bad:?}");
        }
    }

    // Req 48.12, 48.13
    #[test]
    fn guest_and_logout_flags_parse_and_conflict() {
        let cli = Cli::try_parse_from(["tui"]).unwrap();
        assert!(!cli.guest && !cli.logout);
        assert!(Cli::try_parse_from(["tui", "--guest"]).unwrap().guest);
        assert!(Cli::try_parse_from(["tui", "--logout"]).unwrap().logout);
        let err = Cli::try_parse_from(["tui", "--guest", "--logout"]).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::ArgumentConflict);
    }

    #[test]
    fn http_base_maps_the_websocket_url() {
        for (ws, http) in [
            ("wss://example.com/ws", "https://example.com"),
            ("ws://localhost:8080/ws", "http://localhost:8080"),
            ("WSS://Example.com/ws/", "https://Example.com"),
            ("ws://127.0.0.1:9/ws?x=1", "http://127.0.0.1:9"),
            ("wss://example.com", "https://example.com"),
            ("wss://example.com/api/ws", "https://example.com/api"),
        ] {
            assert_eq!(http_base(ws).as_deref(), Some(http), "{ws}");
        }
        assert_eq!(http_base("https://example.com/ws"), None);
        assert_eq!(http_base("nonsense"), None);
    }

    const TOKEN: &str = "v1.payload.mac";

    fn saved(server: &str) -> StoredSession {
        StoredSession {
            server: server.to_owned(),
            token: TOKEN.to_owned(),
            address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM".to_owned(),
            account_id: "w_9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM".to_owned(),
            exp: u64::MAX,
        }
    }

    /// Accepts one connection, records the request text, and answers with `reply`.
    async fn mock_server(
        reply: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/ws", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = socket.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..n]);
            }
            socket.write_all(reply.as_bytes()).await.unwrap();
            socket.shutdown().await.ok();
            String::from_utf8(request).unwrap()
        });
        (ws_url, task)
    }

    // Req 48.13
    #[tokio::test]
    async fn logout_posts_the_bearer_token_and_deletes_the_file() {
        let tmp = TempDir::new();
        let store = TokenStore::in_dir(&tmp.0);
        let (server, request) =
            mock_server("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n").await;
        store.save(&saved(&server)).unwrap();
        let message = run_logout(&store, &server).await;
        let request = request.await.unwrap();
        assert!(request.starts_with("POST /auth/logout HTTP/1.1\r\n"), "{request}");
        assert!(
            request.contains(&format!("Authorization: Bearer {TOKEN}\r\n")),
            "{request}"
        );
        assert!(!store.path().exists());
        assert!(message.contains("signed out"), "{message}");
        assert!(!message.contains(TOKEN));
    }

    #[tokio::test]
    async fn logout_deletes_the_file_even_when_the_server_is_unreachable() {
        let tmp = TempDir::new();
        let store = TokenStore::in_dir(&tmp.0);
        // Bind, note the port, and close the listener so nothing answers there.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = format!("ws://{}/ws", listener.local_addr().unwrap());
        drop(listener);
        store.save(&saved(&server)).unwrap();
        let message = run_logout(&store, &server).await;
        assert!(!store.path().exists());
        assert!(message.contains("unreachable"), "{message}");
        assert!(!message.contains(TOKEN));
    }

    #[tokio::test]
    async fn logout_for_another_server_sends_nothing_and_keeps_the_file() {
        let tmp = TempDir::new();
        let store = TokenStore::in_dir(&tmp.0);
        store.save(&saved("wss://example.com/ws")).unwrap();
        let message = run_logout(&store, "ws://127.0.0.1:9/ws").await;
        assert!(store.path().exists());
        assert!(message.contains("no saved sign-in"), "{message}");
        let empty = TokenStore::in_dir(tmp.0.join("none"));
        assert!(run_logout(&empty, "ws://127.0.0.1:9/ws").await.contains("no saved"));
    }

    #[test]
    fn version_flag_is_supported() {
        let err = Cli::try_parse_from(["tui", "--version"]).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::DisplayVersion);
        assert!(err.to_string().contains(env!("CARGO_PKG_VERSION")));
    }
}
