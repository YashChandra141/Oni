//! Minimal HTTP/1.1 client for the Oni server's REST routes (Task 21).
//!
//! The TUI talks only to the server it was pointed at with `--server`. Requests use one
//! connection with `Connection: close`: `https://` goes through rustls (the `ring` provider and
//! the webpki roots), `http://` is plain TCP for a local server. The optional bearer token is
//! put in one `Authorization` header and nowhere else; it is never logged and no type here
//! derives `Debug` over it.
//!
//! Request building and response parsing are pure and tested. The whole exchange has a size cap
//! ([`MAX_RESPONSE_BYTES`]) and a timeout ([`REQUEST_TIMEOUT`]). Redirects are not followed.

// Pairing (Task 21.2) uses the rest of this API.
#![allow(dead_code)]

use std::fmt;
use std::io;
use std::sync::{Arc, Once};
use std::time::Duration;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

/// Largest response (headers and body) the client reads, in bytes.
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;
/// Time allowed for connect, TLS, request, and response together.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Sent as `User-Agent`.
pub const USER_AGENT: &str = "oni-tui/0.1";

/// Why a request failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
    /// The base URL, host, path, or token is not safe to put in a request.
    BadTarget,
    /// The whole exchange took longer than [`REQUEST_TIMEOUT`].
    Timeout,
    /// The response grew past [`MAX_RESPONSE_BYTES`].
    TooLarge,
    /// Connect, TLS, read, or write failed.
    Io(String),
    /// The bytes are not a valid HTTP/1.1 response.
    BadResponse(&'static str),
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadTarget => f.write_str("invalid server address"),
            Self::Timeout => f.write_str("request timed out"),
            Self::TooLarge => f.write_str("response too large"),
            Self::Io(e) => write!(f, "I/O error: {e}"),
            Self::BadResponse(why) => write!(f, "bad HTTP response: {why}"),
        }
    }
}

impl std::error::Error for HttpError {}

/// A parsed response: status and decoded body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

impl Method {
    fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

/// Where the requests go: the server's HTTP base URL, parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub tls: bool,
    pub host: String,
    pub port: u16,
    /// Path prefix without a trailing slash; empty for a server at the root.
    pub prefix: String,
}

impl Target {
    /// Parses `http://host[:port][/prefix]` or `https://host[:port][/prefix]`.
    pub fn parse(base: &str) -> Result<Self, HttpError> {
        let (scheme, rest) = base.split_once("://").ok_or(HttpError::BadTarget)?;
        let tls = if scheme.eq_ignore_ascii_case("https") {
            true
        } else if scheme.eq_ignore_ascii_case("http") {
            false
        } else {
            return Err(HttpError::BadTarget);
        };
        let (authority, path) = match rest.find('/') {
            Some(i) => (rest.get(..i).unwrap_or(""), rest.get(i..).unwrap_or("")),
            None => (rest, ""),
        };
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) => (
                host,
                port.parse::<u16>().map_err(|_| HttpError::BadTarget)?,
            ),
            None => (authority, if tls { 443 } else { 80 }),
        };
        if !valid_host(host) || port == 0 {
            return Err(HttpError::BadTarget);
        }
        let prefix = path.trim_end_matches('/');
        if !prefix.is_empty() && !valid_path(prefix) {
            return Err(HttpError::BadTarget);
        }
        Ok(Self {
            tls,
            host: host.to_owned(),
            port,
            prefix: prefix.to_owned(),
        })
    }

    /// The `Host` header value: the port is included only when it is not the scheme's default.
    pub fn host_header(&self) -> String {
        let default = if self.tls { 443 } else { 80 };
        if self.port == default {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// True if `host` is a plain DNS name or IPv4: letters, digits, `.` and `-`.
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// True if `path` starts with `/` and holds only visible ASCII (no spaces or control bytes).
fn valid_path(path: &str) -> bool {
    path.starts_with('/') && path.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// True if `token` is non-empty visible ASCII, so it cannot break out of its header line.
fn valid_bearer(token: &str) -> bool {
    !token.is_empty() && token.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// Builds the request text. `json_body` is sent with `Content-Type: application/json`; a POST
/// without a body sends `Content-Length: 0`. `host_header` is [`Target::host_header`].
pub fn build_request(
    method: Method,
    host_header: &str,
    path: &str,
    bearer: Option<&str>,
    json_body: Option<&str>,
) -> Result<String, HttpError> {
    let host_ok = host_header
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'));
    if host_header.is_empty() || !host_ok || !valid_path(path) {
        return Err(HttpError::BadTarget);
    }
    let mut text = format!(
        "{} {path} HTTP/1.1\r\nHost: {host_header}\r\nUser-Agent: {USER_AGENT}\r\n\
         Accept: application/json\r\nCache-Control: no-cache\r\nConnection: close\r\n",
        method.as_str()
    );
    if let Some(token) = bearer {
        if !valid_bearer(token) {
            return Err(HttpError::BadTarget);
        }
        text.push_str("Authorization: Bearer ");
        text.push_str(token);
        text.push_str("\r\n");
    }
    match (method, json_body) {
        (_, Some(body)) => {
            text.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            ));
        }
        (Method::Post, None) => text.push_str("Content-Length: 0\r\n\r\n"),
        (Method::Get, None) => text.push_str("\r\n"),
    }
    Ok(text)
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    let tail = haystack.get(from..)?;
    tail.windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}

/// Decodes a complete chunked body (everything after the headers). Trailers are ignored.
pub fn decode_chunked(mut rest: &[u8]) -> Result<Vec<u8>, HttpError> {
    let mut out = Vec::new();
    loop {
        let line_end = find(rest, b"\r\n", 0).ok_or(HttpError::BadResponse("truncated chunk"))?;
        let line = rest
            .get(..line_end)
            .ok_or(HttpError::BadResponse("truncated chunk"))?;
        let line = std::str::from_utf8(line).map_err(|_| HttpError::BadResponse("chunk size"))?;
        let size_text = line.split(';').next().unwrap_or("").trim();
        if size_text.is_empty() || size_text.len() > 8 {
            return Err(HttpError::BadResponse("chunk size"));
        }
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| HttpError::BadResponse("chunk size"))?;
        rest = rest
            .get(line_end + 2..)
            .ok_or(HttpError::BadResponse("truncated chunk"))?;
        if size == 0 {
            return Ok(out);
        }
        if out.len().saturating_add(size) > MAX_RESPONSE_BYTES {
            return Err(HttpError::TooLarge);
        }
        let data = rest
            .get(..size)
            .ok_or(HttpError::BadResponse("truncated chunk"))?;
        out.extend_from_slice(data);
        if rest.get(size..size + 2) != Some(b"\r\n".as_slice()) {
            return Err(HttpError::BadResponse("truncated chunk"));
        }
        rest = rest
            .get(size + 2..)
            .ok_or(HttpError::BadResponse("truncated chunk"))?;
    }
}

/// Parses a complete response read until the connection closed.
pub fn parse_response(raw: &[u8]) -> Result<Response, HttpError> {
    let head_end =
        find(raw, b"\r\n\r\n", 0).ok_or(HttpError::BadResponse("no end of headers"))?;
    let head = raw
        .get(..head_end)
        .ok_or(HttpError::BadResponse("no end of headers"))?;
    let body = raw
        .get(head_end + 4..)
        .ok_or(HttpError::BadResponse("no end of headers"))?;
    let head =
        std::str::from_utf8(head).map_err(|_| HttpError::BadResponse("headers not UTF-8"))?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/1.") {
        return Err(HttpError::BadResponse("status line"));
    }
    let status: u16 = parts
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or(HttpError::BadResponse("status line"))?;

    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(HttpError::BadResponse("header line"));
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            content_length = Some(
                value
                    .parse()
                    .map_err(|_| HttpError::BadResponse("content-length"))?,
            );
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value
                .split(',')
                .any(|enc| enc.trim().eq_ignore_ascii_case("chunked"));
        }
    }

    let body = if chunked {
        decode_chunked(body)?
    } else if let Some(len) = content_length {
        if len > MAX_RESPONSE_BYTES {
            return Err(HttpError::TooLarge);
        }
        body.get(..len)
            .ok_or(HttpError::BadResponse("body shorter than content-length"))?
            .to_vec()
    } else {
        body.to_vec()
    };
    Ok(Response { status, body })
}

/// Installs rustls' `ring` provider as the process default, once. An `Err` from the install
/// means another provider was installed first, which is fine. Never enables aws-lc.
pub fn install_crypto_provider() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn tls_config() -> Result<Arc<ClientConfig>, HttpError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| HttpError::Io(format!("tls setup: {e}")))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

fn io_err(e: &io::Error) -> HttpError {
    HttpError::Io(e.to_string())
}

/// Sends one request to `target` and returns the parsed response (any status). `path` starts
/// with `/` and is appended to the target's prefix. `bearer` goes only to `target`.
pub async fn request(
    target: &Target,
    method: Method,
    path: &str,
    bearer: Option<&str>,
    json_body: Option<&str>,
) -> Result<Response, HttpError> {
    let full_path = format!("{}{path}", target.prefix);
    let text = build_request(method, &target.host_header(), &full_path, bearer, json_body)?;
    match tokio::time::timeout(REQUEST_TIMEOUT, exchange(target, &text)).await {
        Ok(raw) => parse_response(&raw?),
        Err(_) => Err(HttpError::Timeout),
    }
}

async fn exchange(target: &Target, text: &str) -> Result<Vec<u8>, HttpError> {
    let tcp = TcpStream::connect((target.host.as_str(), target.port))
        .await
        .map_err(|e| io_err(&e))?;
    if target.tls {
        install_crypto_provider();
        let connector = TlsConnector::from(tls_config()?);
        let name =
            ServerName::try_from(target.host.clone()).map_err(|_| HttpError::BadTarget)?;
        let mut tls = connector.connect(name, tcp).await.map_err(|e| io_err(&e))?;
        roundtrip(&mut tls, text).await
    } else {
        let mut tcp = tcp;
        roundtrip(&mut tcp, text).await
    }
}

/// Writes `text` and reads the raw response until the server closes.
async fn roundtrip<S>(stream: &mut S, text: &str) -> Result<Vec<u8>, HttpError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    stream
        .write_all(text.as_bytes())
        .await
        .map_err(|e| io_err(&e))?;
    stream.flush().await.map_err(|e| io_err(&e))?;
    let mut raw = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let n = match stream.read(&mut chunk).await {
            Ok(n) => n,
            // A server that closes without a TLS close_notify; parsing detects truncation.
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => 0,
            Err(e) => return Err(io_err(&e)),
        };
        if n == 0 {
            break;
        }
        raw.extend_from_slice(chunk.get(..n).unwrap_or(&[]));
        if raw.len() > MAX_RESPONSE_BYTES {
            return Err(HttpError::TooLarge);
        }
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_parses_schemes_ports_and_prefix() {
        let t = Target::parse("https://example.com").unwrap();
        assert_eq!((t.tls, t.host.as_str(), t.port, t.prefix.as_str()), (true, "example.com", 443, ""));
        assert_eq!(t.host_header(), "example.com");
        let t = Target::parse("http://127.0.0.1:8080/api/").unwrap();
        assert_eq!((t.tls, t.port, t.prefix.as_str()), (false, 8080, "/api"));
        assert_eq!(t.host_header(), "127.0.0.1:8080");
        assert_eq!(Target::parse("HTTP://localhost").unwrap().port, 80);
    }

    #[test]
    fn target_rejects_bad_urls() {
        for bad in [
            "ws://x",
            "example.com",
            "https://",
            "https://:443",
            "https://a b",
            "https://a.com:0",
            "https://a.com:99999",
            "https://a.com:x",
            "https://a.com/a b",
            "https://a.com\r\nX: y",
        ] {
            assert_eq!(Target::parse(bad), Err(HttpError::BadTarget), "{bad:?}");
        }
    }

    #[test]
    fn post_request_with_bearer_and_no_body() {
        let text = build_request(Method::Post, "h.com", "/auth/logout", Some("v1.a.b"), None).unwrap();
        assert!(text.starts_with("POST /auth/logout HTTP/1.1\r\nHost: h.com\r\n"));
        assert!(text.contains("Authorization: Bearer v1.a.b\r\n"));
        assert!(text.contains("Content-Length: 0\r\n"));
        assert!(text.contains("Connection: close\r\n"));
        assert!(text.ends_with("\r\n\r\n"));
    }

    #[test]
    fn json_body_gets_type_and_length() {
        let text = build_request(Method::Post, "h.com", "/p", None, Some("{\"a\":1}")).unwrap();
        assert!(text.contains("Content-Type: application/json\r\nContent-Length: 7\r\n\r\n{\"a\":1}"));
        assert!(!text.to_ascii_lowercase().contains("authorization"));
        let get = build_request(Method::Get, "h.com", "/p", None, None).unwrap();
        assert!(get.starts_with("GET /p HTTP/1.1\r\n"));
        assert!(!get.contains("Content-Length"));
    }

    #[test]
    fn request_rejects_unsafe_input() {
        for (host, path, token) in [
            ("", "/", None),
            ("a b", "/", None),
            ("a.com", "x", None),
            ("a.com", "/a\r\nX: y", None),
            ("a.com", "/", Some("")),
            ("a.com", "/", Some("t\r\nX: y")),
            ("a.com", "/", Some("a b")),
        ] {
            assert_eq!(
                build_request(Method::Post, host, path, token, None),
                Err(HttpError::BadTarget),
                "{host:?} {path:?} {token:?}"
            );
        }
    }

    #[test]
    fn parses_204_and_content_length_and_chunked() {
        let r = parse_response(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n").unwrap();
        assert_eq!((r.status, r.body.len()), (204, 0));
        let r = parse_response(b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello-extra").unwrap();
        assert_eq!(r.body, b"hello");
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n\
                    5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\n\r\n";
        assert_eq!(parse_response(raw).unwrap().body, b"hello world");
    }

    #[test]
    fn malformed_responses_are_errors() {
        for bad in [
            &b"garbage"[..],
            b"HTTP/2 200 OK\r\n\r\n",
            b"HTTP/1.1 abc OK\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nno colon\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nhello",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel",
        ] {
            assert!(parse_response(bad).is_err(), "{bad:?}");
        }
        let raw = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_RESPONSE_BYTES + 1
        );
        assert_eq!(parse_response(raw.as_bytes()), Err(HttpError::TooLarge));
    }
}
