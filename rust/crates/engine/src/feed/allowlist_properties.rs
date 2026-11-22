//! Property 24: the allowlist permits exactly its rules (Task 6.22; Req 14.3, 14.9, 14.10).
//!
//! The Rust twin of `guardedFetch`. `check` takes (method, host, port, path), so lookalike hosts,
//! embedded credentials (`user:pw@host`), port changes (the upgraded or downgraded scheme shows
//! up as a port or as a host that is not an exact name), and non-GET methods are all generated
//! at that level. The oracle below is written separately from the `ALLOWED` table in
//! `allowlist.rs`, so a rule that is added there without a decision here fails the test.
//!
//! **Validates: Requirements 14.3, 14.9, 14.10**

use super::allowlist::{self, Denied, Method};
use proptest::prelude::*;

/// (host, path, is_prefix). Independent copy of the rules in the design table.
const RULES: &[(&str, &str, bool)] = &[
    ("api.coinbase.com", "/api/v3/brokerage/market", true),
    ("api.backpack.exchange", "/api/v1/markets", false),
    ("api.backpack.exchange", "/api/v1/market", false),
    ("api.backpack.exchange", "/api/v1/depth", false),
    ("api.backpack.exchange", "/api/v1/klines", false),
    ("api.backpack.exchange", "/api/v1/trades", false),
    ("api.backpack.exchange", "/api/v1/ticker", false),
    ("api.backpack.exchange", "/api/v1/tickers", false),
    ("api.jup.ag", "/price/v3", false),
    ("api-v3.raydium.io", "/mint/price", false),
    ("api-v3.raydium.io", "/pools/info/mint", false),
];

const HOSTS: &[&str] = &[
    "api.coinbase.com",
    "api.backpack.exchange",
    "api.jup.ag",
    "api-v3.raydium.io",
];

/// Words that make any path refused, whichever rule it would otherwise match.
const FORBIDDEN_WORDS: &[&str] = &[
    "transaction",
    "swap",
    "order",
    "execute",
    "withdraw",
    "deposit",
    "..",
    "//",
    "%",
];

/// The rule set as a pure function.
fn model_allows(method: Method, host: &str, port: u16, path: &str) -> bool {
    if method != Method::Get || port != 443 {
        return false;
    }
    let host = host.to_ascii_lowercase();
    let bare = path.split(['?', '#']).next().unwrap_or("");
    let lower = bare.to_ascii_lowercase();
    if FORBIDDEN_WORDS.iter().any(|w| lower.contains(w)) {
        return false;
    }
    RULES.iter().any(|(h, p, prefix)| {
        *h == host
            && if *prefix {
                bare == *p || bare.strip_prefix(*p).is_some_and(|r| r.starts_with('/'))
            } else {
                bare == *p
            }
    })
}

fn allowed_host() -> impl Strategy<Value = String> {
    prop::sample::select(HOSTS.to_vec()).prop_map(str::to_owned)
}

/// Allowed hosts and many ways to fake one.
fn any_host() -> impl Strategy<Value = String> {
    let lookalike = (prop::sample::select(HOSTS.to_vec()), 0..14usize).prop_map(|(h, k)| match k {
        0 => format!("evil.{h}"),
        1 => format!("x{h}"),
        2 => format!("{h}.evil.com"),
        3 => format!("{h}x"),
        4 => format!("{h}."),
        5 => format!("{h}:8443"),
        6 => format!("{h}:443"),
        7 => format!("user:pw@{h}"),
        8 => format!("{h}@evil.com"),
        9 => h.replace('.', "-"),
        10 => h.replacen('a', "\u{430}", 1), // Cyrillic a
        11 => format!("https://{h}"),
        12 => "transaction-v1.raydium.io".to_owned(),
        _ => "api.jup.ag.evil.com".to_owned(),
    });
    prop_oneof![3 => allowed_host(), 4 => lookalike, 1 => "[a-z.-]{0,20}"]
}

const SEGMENTS: &[&str] = &[
    "api",
    "v1",
    "v3",
    "markets",
    "market",
    "depth",
    "klines",
    "trades",
    "ticker",
    "tickers",
    "price",
    "mint",
    "pools",
    "info",
    "brokerage",
    "products",
    "BTC-USD",
    "candles",
    "order",
    "swap",
    "transaction",
    "execute",
    "..",
    "",
    "%2e",
];
const SUFFIXES: &[&str] = &[
    "",
    "",
    "",
    "/",
    "/x",
    "/products/BTC-USD/candles",
    "s",
    "/v1",
    "/transaction",
    "/order",
    "/swap",
    "/../x",
    "//",
    "%2F",
];
const QUERIES: &[&str] = &["", "", "?a=1", "?ids=a,b", "?x=/transaction", "#frag"];

fn rule_paths() -> Vec<&'static str> {
    RULES.iter().map(|(_, p, _)| *p).collect()
}

/// Random paths, and paths close to a real rule.
fn any_path() -> impl Strategy<Value = String> {
    let random = prop::collection::vec(prop::sample::select(SEGMENTS.to_vec()), 0..5)
        .prop_map(|v| format!("/{}", v.join("/")));
    let near = (
        prop::sample::select(rule_paths()),
        prop::sample::select(SUFFIXES.to_vec()),
        prop::sample::select(QUERIES.to_vec()),
    )
        .prop_map(|(p, s, q)| format!("{p}{s}{q}"));
    prop_oneof![random, near]
}

fn any_method() -> impl Strategy<Value = Method> {
    prop::sample::select(vec![
        Method::Get,
        Method::Get,
        Method::Get,
        Method::Post,
        Method::Put,
        Method::Delete,
        Method::Patch,
        Method::Other,
    ])
}

fn any_port() -> impl Strategy<Value = u16> {
    prop_oneof![4 => Just(443u16), 1 => Just(80u16), 1 => any::<u16>()]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// The wrapper permits a request if and only if a rule matches it.
    #[test]
    fn permits_exactly_its_rules(
        method in any_method(),
        host in any_host(),
        port in any_port(),
        path in any_path(),
    ) {
        let got = allowlist::check(method, &host, port, &path).is_ok();
        prop_assert_eq!(got, model_allows(method, &host, port, &path), "{:?} {}:{}{}", method, host, port, path);
    }

    /// Every method other than GET is refused on every rule.
    #[test]
    fn non_get_methods_are_refused(
        method in prop::sample::select(vec![Method::Post, Method::Put, Method::Delete, Method::Patch, Method::Other]),
        (host, path) in prop::sample::select(RULES.to_vec()).prop_map(|(h, p, _)| (h, p)),
    ) {
        prop_assert_eq!(allowlist::check(method, host, 443, path), Err(Denied::Method));
    }

    /// Any port but 443 is refused.
    #[test]
    fn other_ports_are_refused(
        port in any::<u16>().prop_filter("443 is the allowed port", |p| *p != 443),
        (host, path) in prop::sample::select(RULES.to_vec()).prop_map(|(h, p, _)| (h, p)),
    ) {
        prop_assert_eq!(allowlist::check(Method::Get, host, port, path), Err(Denied::Port));
    }

    /// A transaction, swap, order, or execute path is refused on every allowed host, however
    /// close the rest of the path is to a rule (Jupiter swap, order, and execute included).
    #[test]
    fn transaction_swap_order_execute_paths_are_refused(
        host in allowed_host(),
        base in prop::sample::select(rule_paths()),
        word in prop::sample::select(vec!["transaction", "Transaction", "swap", "order", "execute", "withdraw", "deposit"]),
        tail in prop::sample::select(vec!["", "/x", "s", "/v1/quote"]),
        query in prop::sample::select(QUERIES.to_vec()),
    ) {
        for path in [
            format!("{base}/{word}{tail}{query}"),
            format!("/{word}{base}{query}"),
            format!("/{word}{tail}{query}"),
        ] {
            prop_assert!(allowlist::check_get(&host, &path).is_err(), "{host}{path}");
        }
        prop_assert_eq!(
            allowlist::check_get(&host, &format!("{base}/{word}{tail}")),
            Err(Denied::Path)
        );
    }

    /// The Raydium transaction host is refused for every method, port, and path.
    #[test]
    fn raydium_transaction_host_is_always_refused(
        method in any_method(),
        port in any_port(),
        path in any_path(),
        upper in any::<bool>(),
    ) {
        let host = if upper { "TRANSACTION-V1.RAYDIUM.IO" } else { "transaction-v1.raydium.io" };
        prop_assert!(allowlist::check(method, host, port, &path).is_err());
    }

    /// WebSocket endpoints: exactly the two listed URLs.
    #[test]
    fn websocket_urls_are_exact(
        url in prop_oneof![
            Just("wss://advanced-trade-ws.coinbase.com".to_owned()),
            Just("wss://ws.backpack.exchange".to_owned()),
            Just("ws://ws.backpack.exchange".to_owned()),
            Just("wss://ws.backpack.exchange/".to_owned()),
            Just("wss://user:pw@ws.backpack.exchange".to_owned()),
            Just("wss://ws.backpack.exchange.evil.com".to_owned()),
            "[a-z:/.@-]{0,40}",
        ],
    ) {
        let expected = url == "wss://advanced-trade-ws.coinbase.com" || url == "wss://ws.backpack.exchange";
        prop_assert_eq!(allowlist::ws_allowed(&url), expected);
    }
}

#[test]
fn every_rule_is_permitted() {
    for (host, path, prefix) in RULES {
        for query in QUERIES {
            let p = format!("{path}{query}");
            assert_eq!(allowlist::check_get(host, &p), Ok(()), "{host}{p}");
            if *prefix {
                let deep = format!("{path}/products/BTC-USD/candles{query}");
                assert_eq!(allowlist::check_get(host, &deep), Ok(()), "{host}{deep}");
            }
        }
        // Host names are case-insensitive.
        assert_eq!(
            allowlist::check_get(&host.to_ascii_uppercase(), path),
            Ok(())
        );
    }
}

#[test]
fn the_oracle_covers_every_allowlist_host() {
    for host in HOSTS {
        assert!(RULES.iter().any(|(h, _, _)| h == host));
    }
    assert_eq!(
        allowlist::check_get("transaction-v1.raydium.io", "/mint/price"),
        Err(Denied::Host)
    );
}
