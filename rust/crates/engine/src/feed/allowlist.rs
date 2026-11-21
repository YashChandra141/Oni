//! Compile-time endpoint allowlist for the engine's outbound HTTP (Task 6.4, trading-safety
//! rule 1). Only read-only, public, unauthenticated market-data routes are listed. Every request
//! must match an entry on scheme (always `https`), host, port (443), method (`GET`), and path.
//! Query strings are not part of the match. Any path with a `transaction` segment, any
//! `transaction-v1.raydium.io` host, and any swap, order, or execute route is refused.
//!
//! The only credential the engine may send is the optional `JUPITER_API_KEY` as `x-api-key` to
//! [`JUPITER_HOST`] (see `http.rs`); it authorizes no trading.

#![allow(dead_code)]

use std::fmt;

/// HTTP method of a request. The engine only ever sends GET.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Delete,
    Patch,
    Other,
}

/// How a path is matched.
#[derive(Debug, Clone, Copy)]
enum PathRule {
    /// The path equals this string.
    Exact(&'static str),
    /// The path equals this string, or continues with `/` after it.
    Prefix(&'static str),
}

struct Entry {
    host: &'static str,
    port: u16,
    rule: PathRule,
}

pub const COINBASE_HOST: &str = "api.coinbase.com";
pub const BACKPACK_HOST: &str = "api.backpack.exchange";
pub const JUPITER_HOST: &str = "api.jup.ag";
pub const RAYDIUM_HOST: &str = "api-v3.raydium.io";

const ALLOWED: &[Entry] = &[
    // Coinbase public market-data routes (unauthenticated "market" subtree).
    Entry {
        host: COINBASE_HOST,
        port: 443,
        rule: PathRule::Prefix("/api/v3/brokerage/market"),
    },
    // Backpack public market routes.
    Entry {
        host: BACKPACK_HOST,
        port: 443,
        rule: PathRule::Exact("/api/v1/markets"),
    },
    Entry {
        host: BACKPACK_HOST,
        port: 443,
        rule: PathRule::Exact("/api/v1/market"),
    },
    Entry {
        host: BACKPACK_HOST,
        port: 443,
        rule: PathRule::Exact("/api/v1/depth"),
    },
    Entry {
        host: BACKPACK_HOST,
        port: 443,
        rule: PathRule::Exact("/api/v1/klines"),
    },
    Entry {
        host: BACKPACK_HOST,
        port: 443,
        rule: PathRule::Exact("/api/v1/trades"),
    },
    Entry {
        host: BACKPACK_HOST,
        port: 443,
        rule: PathRule::Exact("/api/v1/ticker"),
    },
    Entry {
        host: BACKPACK_HOST,
        port: 443,
        rule: PathRule::Exact("/api/v1/tickers"),
    },
    // Jupiter Price API v3.
    Entry {
        host: JUPITER_HOST,
        port: 443,
        rule: PathRule::Exact("/price/v3"),
    },
    // Raydium prices and pool TVL.
    Entry {
        host: RAYDIUM_HOST,
        port: 443,
        rule: PathRule::Exact("/mint/price"),
    },
    Entry {
        host: RAYDIUM_HOST,
        port: 443,
        rule: PathRule::Exact("/pools/info/mint"),
    },
];

/// Allowed WebSocket hosts (subscribe-only). Checked by the WebSocket adapters.
pub const ALLOWED_WS_URLS: &[&str] = &[
    "wss://advanced-trade-ws.coinbase.com",
    "wss://ws.backpack.exchange",
];

/// Why a request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Denied {
    Method,
    Port,
    Host,
    Path,
}

impl fmt::Display for Denied {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Method => "method not allowed (GET only)",
            Self::Port => "port not allowed",
            Self::Host => "host not on the endpoint allowlist",
            Self::Path => "path not on the endpoint allowlist",
        })
    }
}

impl std::error::Error for Denied {}

fn path_without_query(path: &str) -> &str {
    path.split(['?', '#']).next().unwrap_or("")
}

fn path_is_forbidden(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.contains("transaction")
        || lower.contains("..")
        || lower.contains("//")
        || lower.contains('%')
        || lower.contains("swap")
        || lower.contains("order")
        || lower.contains("execute")
        || lower.contains("withdraw")
        || lower.contains("deposit")
}

/// Checks a request. `https` is implied: the engine's HTTP helper speaks TLS only.
pub fn check(method: Method, host: &str, port: u16, path: &str) -> Result<(), Denied> {
    if method != Method::Get {
        return Err(Denied::Method);
    }
    if port != 443 {
        return Err(Denied::Port);
    }
    let host = host.to_ascii_lowercase();
    if !ALLOWED.iter().any(|e| e.host == host) {
        return Err(Denied::Host);
    }
    let bare = path_without_query(path);
    if path_is_forbidden(bare) {
        return Err(Denied::Path);
    }
    let ok = ALLOWED.iter().any(|e| {
        e.host == host
            && e.port == port
            && match e.rule {
                PathRule::Exact(p) => bare == p,
                PathRule::Prefix(p) => {
                    bare == p || bare.strip_prefix(p).is_some_and(|r| r.starts_with('/'))
                }
            }
    });
    if ok { Ok(()) } else { Err(Denied::Path) }
}

/// Convenience for the common case: an HTTPS GET on port 443.
pub fn check_get(host: &str, path: &str) -> Result<(), Denied> {
    check(Method::Get, host, 443, path)
}

/// True if `url` is an allowed WebSocket endpoint.
pub fn ws_allowed(url: &str) -> bool {
    ALLOWED_WS_URLS.contains(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_routes_pass() {
        for (h, p) in [
            (COINBASE_HOST, "/api/v3/brokerage/market/products/BTC-USD/candles?start=1&end=2"),
            (BACKPACK_HOST, "/api/v1/depth?symbol=SOL_USDC"),
            (BACKPACK_HOST, "/api/v1/klines?symbol=BTC_USDC"),
            (JUPITER_HOST, "/price/v3?ids=abc"),
            (RAYDIUM_HOST, "/mint/price?mints=abc"),
            (RAYDIUM_HOST, "/pools/info/mint?mint1=a"),
        ] {
            assert_eq!(check_get(h, p), Ok(()), "{h}{p}");
        }
    }

    #[test]
    fn forbidden_routes_fail() {
        assert_eq!(check_get("transaction-v1.raydium.io", "/mint/price"), Err(Denied::Host));
        assert_eq!(check_get(RAYDIUM_HOST, "/transaction/swap"), Err(Denied::Path));
        assert_eq!(check_get(JUPITER_HOST, "/swap/v1/swap"), Err(Denied::Path));
        assert_eq!(check_get(JUPITER_HOST, "/price/v3/../order"), Err(Denied::Path));
        assert_eq!(check_get(BACKPACK_HOST, "/api/v1/order"), Err(Denied::Path));
        assert_eq!(check_get("example.com", "/"), Err(Denied::Host));
        assert_eq!(check(Method::Post, JUPITER_HOST, 443, "/price/v3"), Err(Denied::Method));
        assert_eq!(check(Method::Get, JUPITER_HOST, 80, "/price/v3"), Err(Denied::Port));
    }
}
