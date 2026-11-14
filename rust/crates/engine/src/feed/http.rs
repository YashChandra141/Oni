//! Minimal HTTPS GET for public REST backfill (Task 7.4, Req 5.2, 5.4).
//!
//! The engine has no HTTP client crate. This helper opens one TLS connection (rustls with the
//! `ring` provider and the webpki roots), sends a plain HTTP/1.1 GET with `Connection: close`, and
//! reads until the server closes. The only headers sent are `Host`, `User-Agent`, `Accept`, and
//! `Connection`: no credentials of any kind (trading-safety rule 1).
//!
//! Response handling is pure and tested: [`parse_response`] reads the status line and headers,
//! honours `Content-Length`, and decodes `Transfer-Encoding: chunked` with [`decode_chunked`].
//! The whole exchange has a size cap ([`MAX_RESPONSE_BYTES`]) and a timeout
//! ([`REQUEST_TIMEOUT`]). Redirects are not followed.

// The adapter exposes the callers; until the runtime uses them, some items are test-only.
#![allow(dead_code)]

use std::fmt;
use std::io;
use std::sync::{Arc, Once};
use std::time::Duration;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

/// Largest response (headers and body) the helper reads, in bytes.
pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// Time allowed for connect, TLS, request, and response together.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Sent as `User-Agent`.
pub const USER_AGENT: &str = "haunted-terminal-engine/0.1";

/// Why a request failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
    /// The host or path is not safe to put in a request line.
    BadTarget,
    /// The whole exchange took longer than [`REQUEST_TIMEOUT`].
    Timeout,
    /// The response grew past [`MAX_RESPONSE_BYTES`].
    TooLarge,
    /// Connect, TLS, read, or write failed.
    Io(String),
    /// The bytes are not a valid HTTP/1.1 response.
    BadResponse(&'static str),
    /// The status was not 200. 429 means rate limited.
    Status(u16),
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadTarget => f.write_str("invalid host or path"),
            Self::Timeout => f.write_str("request timed out"),
            Self::TooLarge => f.write_str("response too large"),
            Self::Io(e) => write!(f, "I/O error: {e}"),
            Self::BadResponse(why) => write!(f, "bad HTTP response: {why}"),
            Self::Status(code) => write!(f, "HTTP status {code}"),
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

/// True if `host` is a plain DNS name or IP: letters, digits, `.` and `-`.
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

/// Builds the request text. The headers are fixed; there is no way to add an auth header.
pub fn build_request(host: &str, path: &str) -> Result<String, HttpError> {
    if !valid_host(host) || !valid_path(path) {
        return Err(HttpError::BadTarget);
    }
    Ok(format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: {USER_AGENT}\r\n\
         Accept: application/json\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
    ))
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    let tail = haystack.get(from..)?;
    tail.windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}

/// Decodes a complete chunked body (everything after the headers). Trailers are ignored.
/// Returns an error if the body is cut short or malformed, or decodes past
/// [`MAX_RESPONSE_BYTES`].
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

/// GETs `https://{host}{path}` and returns the body of a 200 response. Any other status is
/// [`HttpError::Status`]. `path` includes the query string.
pub async fn https_get(host: &str, path: &str) -> Result<Vec<u8>, HttpError> {
    let request = build_request(host, path)?;
    match tokio::time::timeout(REQUEST_TIMEOUT, exchange(host, &request)).await {
        Ok(result) => {
            let response = parse_response(&result?)?;
            if response.status == 200 {
                Ok(response.body)
            } else {
                Err(HttpError::Status(response.status))
            }
        }
        Err(_) => Err(HttpError::Timeout),
    }
}

fn io_err(e: io::Error) -> HttpError {
    HttpError::Io(e.to_string())
}

/// Sends `request` over TLS and reads the raw response until the server closes.
async fn exchange(host: &str, request: &str) -> Result<Vec<u8>, HttpError> {
    install_crypto_provider();
    let connector = TlsConnector::from(tls_config()?);
    let name = ServerName::try_from(host.to_owned()).map_err(|_| HttpError::BadTarget)?;
    let tcp = TcpStream::connect((host, 443)).await.map_err(io_err)?;
    let mut tls = connector.connect(name, tcp).await.map_err(io_err)?;
    tls.write_all(request.as_bytes()).await.map_err(io_err)?;
    tls.flush().await.map_err(io_err)?;

    let mut raw = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let n = match tls.read(&mut chunk).await {
            Ok(n) => n,
            // A server that closes without a TLS close_notify; parsing detects truncation.
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => 0,
            Err(e) => return Err(io_err(e)),
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
    fn request_has_only_the_fixed_headers() {
        let text = build_request("api.coinbase.com", "/a/b?x=1&y=2").unwrap();
        assert!(text.starts_with("GET /a/b?x=1&y=2 HTTP/1.1\r\nHost: api.coinbase.com\r\n"));
        assert!(text.ends_with("\r\n\r\n"));
        let lower = text.to_ascii_lowercase();
        for forbidden in ["authorization", "cookie", "x-api", "jwt", "signature", "cb-access"] {
            assert!(!lower.contains(forbidden), "{forbidden}");
        }
        let names: Vec<&str> = text
            .split("\r\n")
            .skip(1)
            .filter_map(|l| l.split_once(':').map(|(n, _)| n))
            .collect();
        assert_eq!(
            names,
            ["Host", "User-Agent", "Accept", "Cache-Control", "Connection"]
        );
        assert!(text.contains("Connection: close\r\n"));
    }

    #[test]
    fn request_rejects_unsafe_targets() {
        for (host, path) in [
            ("", "/"),
            ("a b", "/"),
            ("a.com\r\nX: y", "/"),
            ("a.com", "no-slash"),
            ("a.com", "/a b"),
            ("a.com", "/a\r\nX: y"),
            ("a.com", "/é"),
            ("a.com:443", "/"),
        ] {
            assert_eq!(build_request(host, path), Err(HttpError::BadTarget), "{host:?} {path:?}");
        }
    }

    #[test]
    fn content_length_body_is_cut_at_the_length() {
        let raw = b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\nContent-Type: x\r\n\r\nhello-extra";
        let r = parse_response(raw).unwrap();
        assert_eq!((r.status, r.body.as_slice()), (200, b"hello".as_slice()));
    }

    #[test]
    fn short_body_is_an_error() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nhello";
        assert!(matches!(
            parse_response(raw),
            Err(HttpError::BadResponse(_))
        ));
    }

    #[test]
    fn body_without_length_runs_to_the_end() {
        let raw = b"HTTP/1.1 200 OK\r\nServer: x\r\n\r\nrest of it";
        assert_eq!(parse_response(raw).unwrap().body, b"rest of it");
    }

    #[test]
    fn chunked_body_is_decoded() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n\
                    5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\nTrailer: x\r\n\r\n";
        let r = parse_response(raw).unwrap();
        assert_eq!(r.body, b"hello world");
        // Transfer-Encoding wins over a Content-Length.
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nTransfer-Encoding: Chunked\r\n\r\n\
                    2\r\nok\r\n0\r\n\r\n";
        assert_eq!(parse_response(raw).unwrap().body, b"ok");
    }

    #[test]
    fn chunked_errors() {
        assert_eq!(decode_chunked(b"0\r\n\r\n"), Ok(Vec::new()));
        assert_eq!(decode_chunked(b"A\r\n0123456789\r\n0\r\n").unwrap().len(), 10);
        for bad in [
            &b""[..],
            b"5\r\nhel",
            b"5\r\nhello",
            b"5\r\nhelloXX0\r\n\r\n",
            b"zz\r\nhello\r\n",
            b"\r\n",
            b"123456789\r\n",
            b"5\r\nhello\r\n",
        ] {
            assert!(matches!(decode_chunked(bad), Err(HttpError::BadResponse(_))), "{bad:?}");
        }
        assert_eq!(decode_chunked(b"FFFFFFF\r\n"), Err(HttpError::TooLarge));
    }

    #[test]
    fn status_line_errors_and_non_200_statuses_parse() {
        assert_eq!(
            parse_response(b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n")
                .unwrap()
                .status,
            429
        );
        for bad in [
            &b"garbage"[..],
            b"HTTP/2 200 OK\r\n\r\n",
            b"HTTP/1.1 abc OK\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nno colon here\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: x\r\n\r\n",
        ] {
            assert!(parse_response(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn declared_length_over_the_cap_is_too_large() {
        let raw = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_RESPONSE_BYTES + 1
        );
        assert_eq!(parse_response(raw.as_bytes()), Err(HttpError::TooLarge));
    }
}
