//! Task 2.4 preservation: venue safety (Req 3.6, 3.7, 3.8, 3.9, 3.14).
//!
//! Property 10: public, unauthenticated market-data requests only, and no file writes from the
//! pure core, replay, or backfill. These read source text; there is no network.

use std::path::PathBuf;

use protocol::Timeframe;

use super::backpack::{BACKPACK_REST_HOST, klines_path};
use super::coinbase::{COINBASE_REST_HOST, candles_path};
use super::http::build_request;

const ALLOWED_HOSTS: [&str; 2] = ["api.backpack.exchange", "api.coinbase.com"];
const FORBIDDEN_HEADER_WORDS: [&str; 10] = [
    "authorization",
    "cookie",
    "x-api",
    "api-key",
    "apikey",
    "jwt",
    "signature",
    "cb-access",
    "x-signature",
    "x-window",
];

fn header_lines(request: &str) -> Vec<String> {
    request
        .split("\r\n")
        .skip(1)
        .filter(|l| !l.is_empty())
        .map(|l| l.to_ascii_lowercase())
        .collect()
}

fn assert_public_request(host: &str, path: &str, expected_prefix: &str) {
    assert!(path.starts_with(expected_prefix), "{path}");
    assert!(!path.contains("://"), "{path}");
    let lower_path = path.to_ascii_lowercase();
    for word in FORBIDDEN_HEADER_WORDS {
        assert!(!lower_path.contains(word), "{word} in {path}");
    }
    let request = build_request(host, path).unwrap();
    assert!(request.starts_with(&format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n")));
    let headers = header_lines(&request);
    assert_eq!(headers[0], format!("host: {}", host.to_ascii_lowercase()));
    for line in &headers {
        for word in FORBIDDEN_HEADER_WORDS {
            assert!(!line.contains(word), "{word} in header {line}");
        }
    }
}

#[test]
fn safety_backpack_klines_request_is_public() {
    assert_eq!(BACKPACK_REST_HOST, "api.backpack.exchange");
    for tf in [
        Timeframe::M1,
        Timeframe::M5,
        Timeframe::M15,
        Timeframe::H1,
        Timeframe::D1,
    ] {
        let path = klines_path("BTC_USDC", tf, 10, 20);
        assert_public_request(BACKPACK_REST_HOST, &path, "/api/v1/klines?");
    }
}

#[test]
fn safety_coinbase_candles_request_is_public() {
    assert_eq!(COINBASE_REST_HOST, "api.coinbase.com");
    for tf in [
        Timeframe::M1,
        Timeframe::M5,
        Timeframe::M15,
        Timeframe::H1,
        Timeframe::D1,
    ] {
        let path = candles_path("BTC-USD", 10, 20, tf);
        assert_public_request(
            COINBASE_REST_HOST,
            &path,
            "/api/v3/brokerage/market/products/",
        );
        // The public market route, never the authenticated one.
        assert!(path.contains("/brokerage/market/"), "{path}");
    }
}

fn read_source(rel: &str) -> Option<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join(rel);
    std::fs::read_to_string(path).ok()
}

/// Removes `//` comments and `/* */` comments, keeping string literals intact, and cuts the file
/// at the first `#[cfg(test)]` so test-only code is not scanned.
fn strip_comments(src: &str) -> String {
    let src = src.split("#[cfg(test)]").next().unwrap_or("");
    let b: Vec<char> = src.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let mut in_str = false;
    while i < b.len() {
        let c = b[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < b.len() {
                out.push(b[i + 1]);
                i += 1;
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
        } else if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
        } else if c == '/' && b.get(i + 1) == Some(&'/') {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && b.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i += 2;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

#[test]
fn safety_stripper_ignores_comments_and_keeps_strings() {
    let s = strip_comments("a(); // fs::write\n/* File::create */ let u = \"https://x.com//y\";");
    assert!(!s.contains("fs::write") && !s.contains("File::create"));
    assert!(s.contains("https://x.com//y"));
}

#[test]
fn safety_backfill_names_only_the_two_public_hosts() {
    let Some(src) = read_source("feed/backfill.rs") else {
        return; // Not written yet; this check applies once the file exists.
    };
    let code = strip_comments(&src);
    for (n, literal) in code.split('"').enumerate() {
        if n % 2 == 0 {
            continue;
        }
        let rest = literal
            .strip_prefix("https://")
            .or_else(|| literal.strip_prefix("wss://"))
            .or_else(|| literal.strip_prefix("http://"))
            .or_else(|| literal.strip_prefix("ws://"));
        let looks_like_host = rest.is_some()
            || (!literal.contains(' ')
                && !literal.contains('/')
                && literal.contains('.')
                && [".com", ".exchange", ".io", ".net", ".org", ".dev"]
                    .iter()
                    .any(|t| literal.ends_with(t)));
        if looks_like_host {
            let host_part = rest.unwrap_or(literal);
            let host = host_part.split(['/', '?', ':']).next().unwrap_or("");
            assert!(
                ALLOWED_HOSTS.contains(&host),
                "backfill.rs names host {host:?}"
            );
        }
    }
    for forbidden in ["authorization", "x-api", "signature", "api-key"] {
        assert!(
            !code.to_ascii_lowercase().contains(forbidden),
            "backfill.rs mentions {forbidden}"
        );
    }
}

#[test]
fn safety_no_file_writes_in_backfill_core_or_replay() {
    let apis = [
        "fs::write",
        "File::create",
        "OpenOptions",
        "write_all",
        "BufWriter",
        "fs::copy",
        "fs::rename",
        "create_dir",
        "remove_file",
        "set_len",
        "create_new",
    ];
    let mut scanned = 0;
    for rel in ["feed/backfill.rs", "core.rs", "feed/replay.rs"] {
        let Some(src) = read_source(rel) else {
            assert_eq!(rel, "feed/backfill.rs", "{rel} must exist");
            continue;
        };
        scanned += 1;
        let code = strip_comments(&src);
        for api in apis {
            assert!(!code.contains(api), "{rel} uses {api}");
        }
    }
    assert!(scanned >= 2);
}
