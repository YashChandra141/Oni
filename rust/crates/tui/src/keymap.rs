//! Embedded keymap with validation (design §4, Req 32.2, 32.4).
//!
//! `shared/keymap.json` is compiled into the binary and loaded at startup. This module is the
//! Rust twin of `shared/keymap.ts` and follows the same rules:
//!
//! - Keys are normalized before comparison: single printable ASCII characters are
//!   case-insensitive, modifiers are ordered Ctrl, Alt, Shift, Meta, and named keys have one
//!   canonical spelling (`ArrowUp` and `up` both become `Up`).
//! - A context binds each normalized key at most once (Req 32.4). `serde_json` would silently
//!   keep the last of two identical raw keys, so the loader reads the JSON through a visitor
//!   that keeps every key/value pair in file order and sees raw duplicates too.
//! - Lookup order: the focused context first, then `global`. While `command` is focused only
//!   `command` bindings apply, so letters type text.

// The keymap is wired up in pieces: the quit key now, the other actions in later tasks
// (6.5, 6.6, 8.3, 9.3, 12.4, 21.2). Until then part of the API is unused.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::fmt;

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use serde::Deserialize;
use serde::de::{Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};

/// The shared keymap, embedded at build time (Req 32.2).
///
/// Path from `rust/crates/tui/src/`: `..` is `tui`, `../..` is `crates`, `../../..` is `rust`,
/// and `../../../..` is the repository root.
const KEYMAP_JSON: &str = include_str!("../../../../shared/keymap.json");

/// An input context. The client picks the focused one by priority dialog > command > panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Context {
    Global,
    Chart,
    Book,
    Orders,
    Command,
    Dialog,
}

impl Context {
    /// Every context, in the order of `CONTEXTS` in `shared/keymap.ts`.
    pub const ALL: [Context; 6] = [
        Context::Global,
        Context::Chart,
        Context::Book,
        Context::Orders,
        Context::Command,
        Context::Dialog,
    ];

    /// The name used in `keymap.json`.
    pub fn name(self) -> &'static str {
        match self {
            Context::Global => "global",
            Context::Chart => "chart",
            Context::Book => "book",
            Context::Orders => "orders",
            Context::Command => "command",
            Context::Dialog => "dialog",
        }
    }

    /// Exact, case-sensitive parse of a context name.
    pub fn parse(name: &str) -> Option<Context> {
        Context::ALL.into_iter().find(|c| c.name() == name)
    }

    fn index(self) -> usize {
        match self {
            Context::Global => 0,
            Context::Chart => 1,
            Context::Book => 2,
            Context::Orders => 3,
            Context::Command => 4,
            Context::Dialog => 5,
        }
    }
}

macro_rules! actions {
    ($($variant:ident => $name:literal,)+) => {
        /// Every action in `ACTIONS` of `shared/keymap.ts`.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum Action {
            $($variant,)+
        }

        impl Action {
            /// Every action, in the order of `ACTIONS` in `shared/keymap.ts`.
            pub const ALL: &[Action] = &[$(Action::$variant,)+];

            /// The name used in `keymap.json`.
            pub fn name(self) -> &'static str {
                match self {
                    $(Action::$variant => $name,)+
                }
            }

            /// Strict parse: the exact, case-sensitive action name or nothing.
            pub fn parse(name: &str) -> Option<Action> {
                match name {
                    $($name => Some(Action::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

actions! {
    Timeframe1m => "timeframe.1m",
    Timeframe5m => "timeframe.5m",
    Timeframe15m => "timeframe.15m",
    Timeframe1h => "timeframe.1h",
    Timeframe1d => "timeframe.1d",
    SymbolNext => "symbol.next",
    SymbolPrev => "symbol.prev",
    OrderBuy => "order.buy",
    OrderSell => "order.sell",
    AccountFlatten => "account.flatten",
    OrdersCancelAll => "orders.cancel_all",
    IndicatorEma => "indicator.ema",
    IndicatorVwap => "indicator.vwap",
    IndicatorBollinger => "indicator.bollinger",
    IndicatorRsi => "indicator.rsi",
    IndicatorAtr => "indicator.atr",
    CommandFocus => "command.focus",
    AuthPair => "auth.pair",
    AppQuit => "app.quit",
    ChartZoomIn => "chart.zoom_in",
    ChartZoomOut => "chart.zoom_out",
    ChartPanBack => "chart.pan_back",
    ChartPanForward => "chart.pan_forward",
    BookUp => "book.up",
    BookDown => "book.down",
    BookPrefill => "book.prefill",
    OrdersUp => "orders.up",
    OrdersDown => "orders.down",
    OrderCancel => "order.cancel",
    HistoryPrev => "history.prev",
    HistoryNext => "history.next",
    CommandSubmit => "command.submit",
    CommandBlur => "command.blur",
    DialogConfirm => "dialog.confirm",
    DialogCancel => "dialog.cancel",
}

// ---------------------------------------------------------------------------------------------
// Key normalization
// ---------------------------------------------------------------------------------------------

const MODIFIER_ORDER: [&str; 4] = ["Ctrl", "Alt", "Shift", "Meta"];

/// Index into `MODIFIER_ORDER` for a lower-cased modifier spelling.
fn modifier_index(lower: &str) -> Option<usize> {
    match lower {
        "ctrl" | "control" => Some(0),
        "alt" | "option" => Some(1),
        "shift" => Some(2),
        "meta" | "cmd" => Some(3),
        _ => None,
    }
}

const NAMED_KEYS: [&str; 27] = [
    "Up",
    "Down",
    "Left",
    "Right",
    "Enter",
    "Escape",
    "Tab",
    "Backspace",
    "Delete",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Space",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
];

/// Lower-case alias to canonical named key, including browser `KeyboardEvent.key` names.
const NAMED_ALIASES: [(&str, &str); 7] = [
    ("arrowup", "Up"),
    ("arrowdown", "Down"),
    ("arrowleft", "Left"),
    ("arrowright", "Right"),
    ("esc", "Escape"),
    ("return", "Enter"),
    ("del", "Delete"),
];

fn normalize_base(base: &str) -> Option<String> {
    if base == " " {
        return Some("Space".to_owned());
    }
    let mut chars = base.chars();
    if let (Some(c), None) = (chars.next(), chars.clone().next()) {
        // Printable ASCII except space: letters, digits, punctuation such as + - :
        return ('\u{21}'..='\u{7e}')
            .contains(&c)
            .then(|| c.to_ascii_uppercase().to_string());
    }
    let lower = base.to_lowercase();
    NAMED_KEYS
        .iter()
        .find(|k| k.to_ascii_lowercase() == lower)
        .or_else(|| {
            NAMED_ALIASES
                .iter()
                .find(|(alias, _)| *alias == lower)
                .map(|(_, canonical)| canonical)
        })
        .map(|k| (*k).to_owned())
}

/// Normalize a key spelling such as `shift+tab`, `b`, or `ArrowUp` to its canonical form
/// (`Shift+Tab`, `B`, `Up`). Returns `None` for an invalid key. Same rules as `normalizeKey`
/// in `shared/keymap.ts`.
pub fn normalize_key(key: &str) -> Option<String> {
    if key.is_empty() {
        return None;
    }
    let (base, mods): (&str, Vec<&str>) = if key == "+" {
        ("+", Vec::new())
    } else if let Some(prefix) = key.strip_suffix("++") {
        ("+", prefix.split('+').collect())
    } else {
        let mut parts: Vec<&str> = key.split('+').collect();
        let base = parts.pop().unwrap_or("");
        (base, parts)
    };
    let mut seen = [false; 4];
    for m in mods {
        let idx = modifier_index(&m.to_lowercase())?;
        if std::mem::replace(&mut seen[idx], true) {
            return None;
        }
    }
    let base = normalize_base(base)?;
    let mut out = String::new();
    for (name, _) in MODIFIER_ORDER.iter().zip(seen).filter(|(_, on)| *on) {
        out.push_str(name);
        out.push('+');
    }
    out.push_str(&base);
    Some(out)
}

/// The canonical name of a non-character key code, if the keymap has one.
fn named_key(code: KeyCode) -> Option<&'static str> {
    const F_NAMES: [&str; 12] = [
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    ];
    Some(match code {
        KeyCode::Enter => "Enter",
        KeyCode::Esc => "Escape",
        KeyCode::Tab | KeyCode::BackTab => "Tab",
        KeyCode::Backspace => "Backspace",
        KeyCode::Delete => "Delete",
        KeyCode::Insert => "Insert",
        KeyCode::Home => "Home",
        KeyCode::End => "End",
        KeyCode::PageUp => "PageUp",
        KeyCode::PageDown => "PageDown",
        KeyCode::Up => "Up",
        KeyCode::Down => "Down",
        KeyCode::Left => "Left",
        KeyCode::Right => "Right",
        KeyCode::F(n) => *F_NAMES.get(usize::from(n).checked_sub(1)?)?,
        _ => return None,
    })
}

/// The normalized key for a crossterm key event, or `None` for a release, an unsupported key,
/// or a Hyper chord. Like `keyFromEvent` on the web, Shift is kept only for named keys
/// (`Shift+Tab`); for printable characters it is already reflected in the character itself.
/// `BackTab` is `Shift+Tab` whether or not the terminal also reports the Shift modifier.
pub fn chord_from_crossterm(key: &KeyEvent) -> Option<String> {
    if key.kind == KeyEventKind::Release || key.modifiers.contains(KeyModifiers::HYPER) {
        return None;
    }
    let (base, printable) = match key.code {
        KeyCode::Char(c) => (c.to_string(), c != ' '),
        code => (named_key(code)?.to_owned(), false),
    };
    let mut parts: Vec<&str> = Vec::new();
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        parts.push("Ctrl");
    }
    if key.modifiers.contains(KeyModifiers::ALT) {
        parts.push("Alt");
    }
    let shift = key.modifiers.contains(KeyModifiers::SHIFT) || key.code == KeyCode::BackTab;
    if shift && !printable {
        parts.push("Shift");
    }
    if key
        .modifiers
        .intersects(KeyModifiers::SUPER | KeyModifiers::META)
    {
        parts.push("Meta");
    }
    parts.push(&base);
    normalize_key(&parts.join("+"))
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

/// A validated keymap. Every context is present; keys are normalized.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keymap {
    contexts: [HashMap<String, Action>; 6],
}

impl Keymap {
    /// The keymap embedded from `shared/keymap.json`.
    pub fn embedded() -> Result<Keymap, Vec<String>> {
        load_keymap(KEYMAP_JSON)
    }

    /// The bindings of one context, keyed by normalized key.
    pub fn bindings(&self, context: Context) -> &HashMap<String, Action> {
        &self.contexts[context.index()]
    }
}

/// A JSON value that keeps every object key and value in file order, duplicates included.
#[derive(Debug)]
enum Raw {
    Object(Vec<(String, Raw)>),
    /// Null, bool, number, string, or array.
    Scalar(Value),
}

impl Raw {
    /// The value as plain JSON, for error messages. Later duplicate keys win.
    fn to_value(&self) -> Value {
        match self {
            Raw::Scalar(v) => v.clone(),
            Raw::Object(pairs) => Value::Object(
                pairs
                    .iter()
                    .map(|(k, v)| (k.clone(), v.to_value()))
                    .collect::<Map<String, Value>>(),
            ),
        }
    }
}

impl<'de> Deserialize<'de> for Raw {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(RawVisitor)
    }
}

struct RawVisitor;

impl<'de> Visitor<'de> for RawVisitor {
    type Value = Raw;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_bool<E>(self, v: bool) -> Result<Raw, E> {
        Ok(Raw::Scalar(Value::Bool(v)))
    }

    fn visit_i64<E>(self, v: i64) -> Result<Raw, E> {
        Ok(Raw::Scalar(Value::Number(v.into())))
    }

    fn visit_u64<E>(self, v: u64) -> Result<Raw, E> {
        Ok(Raw::Scalar(Value::Number(v.into())))
    }

    fn visit_f64<E>(self, v: f64) -> Result<Raw, E> {
        Ok(Raw::Scalar(
            Number::from_f64(v).map_or(Value::Null, Value::Number),
        ))
    }

    fn visit_str<E>(self, v: &str) -> Result<Raw, E> {
        Ok(Raw::Scalar(Value::String(v.to_owned())))
    }

    fn visit_unit<E>(self) -> Result<Raw, E> {
        Ok(Raw::Scalar(Value::Null))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Raw, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element::<Value>()? {
            items.push(item);
        }
        Ok(Raw::Scalar(Value::Array(items)))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Raw, A::Error> {
        let mut pairs = Vec::new();
        while let Some(pair) = map.next_entry::<String, Raw>()? {
            pairs.push(pair);
        }
        Ok(Raw::Object(pairs))
    }
}

/// Parse and validate keymap JSON text. Contexts may be omitted (treated as empty).
///
/// Rejects a context that binds the same normalized key twice (Req 32.4), including two
/// identical raw keys. Every error names the context and the key it concerns. Messages match
/// `loadKeymap` in `shared/keymap.ts`.
pub fn load_keymap(text: &str) -> Result<Keymap, Vec<String>> {
    let raw: Raw =
        serde_json::from_str(text).map_err(|e| vec![format!("keymap: invalid JSON: {e}")])?;
    let Raw::Object(fields) = raw else {
        return Err(vec!["keymap: expected a JSON object".to_owned()]);
    };

    let mut errors: Vec<String> = Vec::new();
    let mut version: Option<&Raw> = None;
    let mut contexts_raw: Option<&Raw> = None;
    let mut seen_fields: HashSet<&str> = HashSet::new();
    for (name, value) in &fields {
        match name.as_str() {
            "version" | "contexts" => {
                if !seen_fields.insert(name.as_str()) {
                    errors.push(format!("keymap: duplicate field \"{name}\""));
                }
                if name.as_str() == "version" {
                    version = Some(value);
                } else {
                    contexts_raw = Some(value);
                }
            }
            _ => errors.push(format!("keymap: unknown field \"{name}\"")),
        }
    }
    let version_ok = matches!(
        version,
        Some(Raw::Scalar(Value::Number(n))) if n.as_f64() == Some(1.0)
    );
    if !version_ok {
        errors.push("keymap: \"version\" must be 1".to_owned());
    }
    let Some(Raw::Object(context_pairs)) = contexts_raw else {
        errors.push("keymap: \"contexts\" must be an object".to_owned());
        return Err(errors);
    };

    let mut tables: [HashMap<String, Action>; 6] = Default::default();
    let mut seen_contexts = [false; 6];
    for (ctx_name, bindings) in context_pairs {
        let Some(ctx) = Context::parse(ctx_name) else {
            errors.push(format!("unknown context \"{ctx_name}\""));
            continue;
        };
        let Raw::Object(pairs) = bindings else {
            errors.push(format!(
                "context \"{ctx_name}\": bindings must be an object"
            ));
            continue;
        };
        if std::mem::replace(&mut seen_contexts[ctx.index()], true) {
            errors.push(format!("context \"{ctx_name}\": defined more than once"));
            continue;
        }
        let table = &mut tables[ctx.index()];
        let mut raw_by_normalized: HashMap<String, &str> = HashMap::new();
        for (key, action) in pairs {
            let Some(norm) = normalize_key(key) else {
                errors.push(format!("context \"{ctx_name}\": invalid key \"{key}\""));
                continue;
            };
            let parsed = match action {
                Raw::Scalar(Value::String(s)) => Action::parse(s),
                _ => None,
            };
            let Some(parsed) = parsed else {
                errors.push(format!(
                    "context \"{ctx_name}\": key \"{key}\" has unknown action {}",
                    action.to_value()
                ));
                continue;
            };
            if let Some(prev) = raw_by_normalized.get(&norm) {
                errors.push(format!(
                    "context \"{ctx_name}\": key \"{key}\" duplicates \"{prev}\" (both normalize to \"{norm}\")"
                ));
                continue;
            }
            raw_by_normalized.insert(norm.clone(), key);
            table.insert(norm, parsed);
        }
    }
    if errors.is_empty() {
        Ok(Keymap { contexts: tables })
    } else {
        Err(errors)
    }
}

/// Resolve a key press to an action. The focused context is checked first, then `global`.
/// While `command` is focused only `command` bindings apply.
pub fn resolve(keymap: &Keymap, focus: Context, key: &str) -> Option<Action> {
    let norm = normalize_key(key)?;
    if let Some(action) = keymap.bindings(focus).get(&norm) {
        return Some(*action);
    }
    if focus == Context::Command {
        return None;
    }
    keymap.bindings(Context::Global).get(&norm).copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEventState;
    use proptest::prelude::*;

    const KEYMAP_TS: &str = include_str!("../../../../shared/keymap.ts");

    fn errors_of(text: &str) -> Vec<String> {
        load_keymap(text).expect_err("expected load_keymap to fail")
    }

    fn embedded() -> Keymap {
        Keymap::embedded().expect("embedded keymap must load")
    }

    fn press(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    // --- embedded file -------------------------------------------------------------------

    #[test]
    fn embedded_keymap_loads() {
        let keymap = embedded();
        assert_eq!(
            resolve(&keymap, Context::Global, "B"),
            Some(Action::OrderBuy)
        );
        assert_eq!(
            resolve(&keymap, Context::Global, "P"),
            Some(Action::AuthPair)
        );
        assert_eq!(
            resolve(&keymap, Context::Global, "Q"),
            Some(Action::AppQuit)
        );
        assert_eq!(
            resolve(&keymap, Context::Global, "Shift+Tab"),
            Some(Action::SymbolPrev)
        );
        assert_eq!(
            resolve(&keymap, Context::Chart, "+"),
            Some(Action::ChartZoomIn)
        );
        assert_eq!(
            resolve(&keymap, Context::Orders, "Delete"),
            Some(Action::OrderCancel)
        );
        assert_eq!(
            resolve(&keymap, Context::Dialog, "y"),
            Some(Action::DialogConfirm)
        );
        assert_eq!(keymap.bindings(Context::Global).len(), 19);
    }

    #[test]
    fn actions_match_keymap_ts() {
        let start = KEYMAP_TS
            .find("export const ACTIONS = [")
            .expect("ACTIONS in keymap.ts");
        let body = &KEYMAP_TS[start..];
        let end = body.find("] as const;").expect("end of ACTIONS");
        let ts_actions: Vec<&str> = body[..end].split('"').skip(1).step_by(2).collect();
        let rust_actions: Vec<&str> = Action::ALL.iter().map(|a| a.name()).collect();
        assert_eq!(rust_actions, ts_actions);
        assert_eq!(Action::ALL.len(), 35);
    }

    #[test]
    fn action_parse_is_strict_and_round_trips() {
        for action in Action::ALL {
            assert_eq!(Action::parse(action.name()), Some(*action));
        }
        assert_eq!(Action::parse("Order.Buy"), None);
        assert_eq!(Action::parse(" order.buy"), None);
        assert_eq!(Action::parse("order.buyy"), None);
        assert_eq!(Action::parse(""), None);
    }

    #[test]
    fn context_names_round_trip() {
        for ctx in Context::ALL {
            assert_eq!(Context::parse(ctx.name()), Some(ctx));
        }
        assert_eq!(Context::parse("Global"), None);
        assert_eq!(Context::parse("popup"), None);
    }

    // --- normalize_key (cases copied from shared/keymap.test.ts) ---------------------------

    #[test]
    fn letters_are_case_insensitive() {
        assert_eq!(normalize_key("b").as_deref(), Some("B"));
        assert_eq!(normalize_key("B").as_deref(), Some("B"));
        assert_eq!(normalize_key("shift+b").as_deref(), Some("Shift+B"));
    }

    #[test]
    fn modifier_order_and_spelling_are_normalized() {
        assert_eq!(normalize_key("shift+tab").as_deref(), Some("Shift+Tab"));
        assert_eq!(
            normalize_key("Shift+Ctrl+x").as_deref(),
            Some("Ctrl+Shift+X")
        );
        assert_eq!(
            normalize_key("control+alt+Delete").as_deref(),
            Some("Ctrl+Alt+Delete")
        );
        // cmd and meta are the same modifier, so naming both is a duplicate.
        assert_eq!(normalize_key("cmd+option+meta+Shift+ctrl+a"), None);
        assert_eq!(
            normalize_key("Meta+Shift+Alt+Ctrl+a").as_deref(),
            Some("Ctrl+Alt+Shift+Meta+A")
        );
    }

    #[test]
    fn named_keys_and_symbols_keep_one_spelling() {
        assert_eq!(normalize_key("ArrowUp").as_deref(), Some("Up"));
        assert_eq!(normalize_key("up").as_deref(), Some("Up"));
        assert_eq!(normalize_key("Esc").as_deref(), Some("Escape"));
        assert_eq!(normalize_key("enter").as_deref(), Some("Enter"));
        assert_eq!(normalize_key("Return").as_deref(), Some("Enter"));
        assert_eq!(normalize_key("Del").as_deref(), Some("Delete"));
        assert_eq!(normalize_key("pagedown").as_deref(), Some("PageDown"));
        assert_eq!(normalize_key("f12").as_deref(), Some("F12"));
        assert_eq!(normalize_key("+").as_deref(), Some("+"));
        assert_eq!(normalize_key("Shift++").as_deref(), Some("Shift++"));
        assert_eq!(normalize_key("-").as_deref(), Some("-"));
        assert_eq!(normalize_key(":").as_deref(), Some(":"));
        assert_eq!(normalize_key("1").as_deref(), Some("1"));
        assert_eq!(normalize_key(" ").as_deref(), Some("Space"));
        assert_eq!(normalize_key("Ctrl+ ").as_deref(), Some("Ctrl+Space"));
    }

    #[test]
    fn invalid_keys_return_none() {
        for bad in [
            "",
            "Hyper+B",
            "Shift+Shift+B",
            "Shift+",
            "Banana",
            "é",
            "+B",
            "++",
            "A++",
            "F13",
            "F0",
            "f01",
            "Ctrl+Cmd+Meta+B",
            "\u{7f}",
            "\t",
        ] {
            assert_eq!(normalize_key(bad), None, "{bad:?}");
        }
    }

    // --- chord_from_crossterm ---------------------------------------------------------------

    #[test]
    fn crossterm_chars_and_shift() {
        let chord = |code, mods| chord_from_crossterm(&press(code, mods));
        assert_eq!(
            chord(KeyCode::Char('q'), KeyModifiers::NONE).as_deref(),
            Some("Q")
        );
        assert_eq!(
            chord(KeyCode::Char('Q'), KeyModifiers::SHIFT).as_deref(),
            Some("Q")
        );
        assert_eq!(
            chord(KeyCode::Char(':'), KeyModifiers::SHIFT).as_deref(),
            Some(":")
        );
        assert_eq!(
            chord(KeyCode::Char('+'), KeyModifiers::NONE).as_deref(),
            Some("+")
        );
        assert_eq!(
            chord(KeyCode::Char('1'), KeyModifiers::NONE).as_deref(),
            Some("1")
        );
        assert_eq!(
            chord(KeyCode::Char(' '), KeyModifiers::NONE).as_deref(),
            Some("Space")
        );
        assert_eq!(
            chord(KeyCode::Char(' '), KeyModifiers::SHIFT).as_deref(),
            Some("Shift+Space")
        );
        assert_eq!(
            chord(KeyCode::Char('c'), KeyModifiers::CONTROL).as_deref(),
            Some("Ctrl+C")
        );
        assert_eq!(
            chord(
                KeyCode::Char('x'),
                KeyModifiers::ALT | KeyModifiers::CONTROL
            )
            .as_deref(),
            Some("Ctrl+Alt+X")
        );
        assert_eq!(
            chord(KeyCode::Char('a'), KeyModifiers::SUPER).as_deref(),
            Some("Meta+A")
        );
        assert_eq!(chord(KeyCode::Char('é'), KeyModifiers::NONE), None);
    }

    #[test]
    fn crossterm_named_keys() {
        let chord = |code, mods| chord_from_crossterm(&press(code, mods));
        assert_eq!(
            chord(KeyCode::Up, KeyModifiers::NONE).as_deref(),
            Some("Up")
        );
        assert_eq!(
            chord(KeyCode::Left, KeyModifiers::NONE).as_deref(),
            Some("Left")
        );
        assert_eq!(
            chord(KeyCode::Esc, KeyModifiers::NONE).as_deref(),
            Some("Escape")
        );
        assert_eq!(
            chord(KeyCode::Enter, KeyModifiers::NONE).as_deref(),
            Some("Enter")
        );
        assert_eq!(
            chord(KeyCode::Delete, KeyModifiers::NONE).as_deref(),
            Some("Delete")
        );
        assert_eq!(
            chord(KeyCode::PageUp, KeyModifiers::NONE).as_deref(),
            Some("PageUp")
        );
        assert_eq!(
            chord(KeyCode::F(1), KeyModifiers::NONE).as_deref(),
            Some("F1")
        );
        assert_eq!(
            chord(KeyCode::F(12), KeyModifiers::NONE).as_deref(),
            Some("F12")
        );
        assert_eq!(chord(KeyCode::F(13), KeyModifiers::NONE), None);
        assert_eq!(chord(KeyCode::F(0), KeyModifiers::NONE), None);
        assert_eq!(chord(KeyCode::Null, KeyModifiers::NONE), None);
        assert_eq!(chord(KeyCode::CapsLock, KeyModifiers::NONE), None);
        // Shift is kept for named keys.
        assert_eq!(
            chord(KeyCode::Tab, KeyModifiers::SHIFT).as_deref(),
            Some("Shift+Tab")
        );
        assert_eq!(
            chord(KeyCode::BackTab, KeyModifiers::SHIFT).as_deref(),
            Some("Shift+Tab")
        );
        assert_eq!(
            chord(KeyCode::BackTab, KeyModifiers::NONE).as_deref(),
            Some("Shift+Tab")
        );
        assert_eq!(
            chord(KeyCode::Tab, KeyModifiers::NONE).as_deref(),
            Some("Tab")
        );
    }

    #[test]
    fn crossterm_release_and_hyper_are_ignored() {
        let release = KeyEvent {
            code: KeyCode::Char('q'),
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Release,
            state: KeyEventState::NONE,
        };
        assert_eq!(chord_from_crossterm(&release), None);
        let repeat = KeyEvent {
            kind: KeyEventKind::Repeat,
            ..release
        };
        assert_eq!(chord_from_crossterm(&repeat).as_deref(), Some("Q"));
        assert_eq!(
            chord_from_crossterm(&press(KeyCode::Char('b'), KeyModifiers::HYPER)),
            None
        );
    }

    #[test]
    fn crossterm_chords_resolve_through_the_embedded_keymap() {
        let keymap = embedded();
        let resolve_event = |focus, code, mods| {
            let chord = chord_from_crossterm(&press(code, mods))?;
            resolve(&keymap, focus, &chord)
        };
        assert_eq!(
            resolve_event(Context::Global, KeyCode::Char('q'), KeyModifiers::NONE),
            Some(Action::AppQuit)
        );
        assert_eq!(
            resolve_event(Context::Global, KeyCode::BackTab, KeyModifiers::SHIFT),
            Some(Action::SymbolPrev)
        );
        assert_eq!(
            resolve_event(Context::Global, KeyCode::Char(':'), KeyModifiers::SHIFT),
            Some(Action::CommandFocus)
        );
        assert_eq!(
            resolve_event(Context::Chart, KeyCode::Char('+'), KeyModifiers::SHIFT),
            Some(Action::ChartZoomIn)
        );
        assert_eq!(
            resolve_event(Context::Global, KeyCode::Esc, KeyModifiers::NONE),
            None
        );
    }

    // --- load_keymap validation -------------------------------------------------------------

    #[test]
    fn rejects_invalid_json_non_object_and_wrong_version() {
        assert!(
            errors_of("{")
                .first()
                .is_some_and(|e| e.starts_with("keymap: invalid JSON:"))
        );
        assert_eq!(errors_of("null"), ["keymap: expected a JSON object"]);
        assert_eq!(errors_of("[]"), ["keymap: expected a JSON object"]);
        assert_eq!(
            errors_of(r#"{"version":2,"contexts":{}}"#),
            [r#"keymap: "version" must be 1"#]
        );
        assert_eq!(
            errors_of(r#"{"version":"1","contexts":{}}"#),
            [r#"keymap: "version" must be 1"#]
        );
        assert_eq!(
            errors_of(r#"{"contexts":{}}"#),
            [r#"keymap: "version" must be 1"#]
        );
        assert!(load_keymap(r#"{"version":1.0,"contexts":{}}"#).is_ok());
    }

    #[test]
    fn rejects_missing_contexts_and_unknown_top_level_fields() {
        assert_eq!(
            errors_of(r#"{"version":1}"#),
            [r#"keymap: "contexts" must be an object"#]
        );
        assert_eq!(
            errors_of(r#"{"version":1,"contexts":[]}"#),
            [r#"keymap: "contexts" must be an object"#]
        );
        assert_eq!(
            errors_of(r#"{"version":1,"contexts":{},"extra":1}"#),
            [r#"keymap: unknown field "extra""#]
        );
        assert_eq!(
            errors_of(r#"{"version":1,"version":1,"contexts":{}}"#),
            [r#"keymap: duplicate field "version""#]
        );
    }

    #[test]
    fn rejects_unknown_context_and_non_object_bindings() {
        assert_eq!(
            errors_of(r#"{"version":1,"contexts":{"popup":{}}}"#),
            [r#"unknown context "popup""#]
        );
        assert_eq!(
            errors_of(r#"{"version":1,"contexts":{"chart":"x"}}"#),
            [r#"context "chart": bindings must be an object"#]
        );
        assert_eq!(
            errors_of(r#"{"version":1,"contexts":{"chart":{},"chart":{}}}"#),
            [r#"context "chart": defined more than once"#]
        );
    }

    #[test]
    fn rejects_non_string_and_unknown_actions_naming_context_and_key() {
        assert_eq!(
            errors_of(r#"{"version":1,"contexts":{"global":{"B":7}}}"#),
            [r#"context "global": key "B" has unknown action 7"#]
        );
        assert_eq!(
            errors_of(r#"{"version":1,"contexts":{"global":{"B":"order.buyy"}}}"#),
            [r#"context "global": key "B" has unknown action "order.buyy""#]
        );
        assert_eq!(
            errors_of(r#"{"version":1,"contexts":{"global":{"B":null}}}"#),
            [r#"context "global": key "B" has unknown action null"#]
        );
        assert_eq!(
            errors_of(r#"{"version":1,"contexts":{"global":{"B":"Order.Buy"}}}"#),
            [r#"context "global": key "B" has unknown action "Order.Buy""#]
        );
    }

    #[test]
    fn rejects_an_invalid_key() {
        assert_eq!(
            errors_of(r#"{"version":1,"contexts":{"book":{"Banana":"book.up"}}}"#),
            [r#"context "book": invalid key "Banana""#]
        );
    }

    // Req 32.4
    #[test]
    fn rejects_a_context_that_binds_the_same_normalized_key_twice() {
        assert_eq!(
            errors_of(r#"{"version":1,"contexts":{"global":{"B":"order.buy","b":"order.sell"}}}"#),
            [r#"context "global": key "b" duplicates "B" (both normalize to "B")"#]
        );
        assert_eq!(
            errors_of(
                r#"{"version":1,"contexts":{"orders":{"Up":"orders.up","ArrowUp":"orders.down"}}}"#
            ),
            [r#"context "orders": key "ArrowUp" duplicates "Up" (both normalize to "Up")"#]
        );
    }

    // Req 32.4: serde_json alone would keep only the last of two identical raw keys.
    #[test]
    fn rejects_identical_raw_keys_in_one_context() {
        assert_eq!(
            errors_of(
                r#"{"version":1,"contexts":{"dialog":{"Y":"dialog.confirm","Y":"dialog.cancel"}}}"#
            ),
            [r#"context "dialog": key "Y" duplicates "Y" (both normalize to "Y")"#]
        );
    }

    #[test]
    fn reports_every_error() {
        let errors = errors_of(
            r#"{"version":1,"contexts":{"popup":{},"chart":{"Banana":"chart.zoom_in","+":"nope"}}}"#,
        );
        assert_eq!(
            errors,
            [
                r#"unknown context "popup""#,
                r#"context "chart": invalid key "Banana""#,
                r#"context "chart": key "+" has unknown action "nope""#,
            ]
        );
    }

    #[test]
    fn the_same_key_in_different_contexts_is_allowed() {
        let keymap = load_keymap(
            r#"{"version":1,"contexts":{"book":{"Up":"book.up"},"orders":{"Up":"orders.up"}}}"#,
        )
        .expect("valid keymap");
        assert_eq!(resolve(&keymap, Context::Book, "Up"), Some(Action::BookUp));
        assert_eq!(
            resolve(&keymap, Context::Orders, "up"),
            Some(Action::OrdersUp)
        );
    }

    #[test]
    fn omitted_contexts_are_empty() {
        let keymap = load_keymap(r#"{"version":1,"contexts":{}}"#).expect("valid keymap");
        for ctx in Context::ALL {
            assert!(keymap.bindings(ctx).is_empty());
        }
    }

    // --- resolve ----------------------------------------------------------------------------

    #[test]
    fn focused_context_wins_over_global_then_falls_back_to_global() {
        let keymap = embedded();
        assert_eq!(
            resolve(&keymap, Context::Book, "Enter"),
            Some(Action::BookPrefill)
        );
        assert_eq!(
            resolve(&keymap, Context::Dialog, "Enter"),
            Some(Action::DialogConfirm)
        );
        assert_eq!(resolve(&keymap, Context::Book, "B"), Some(Action::OrderBuy));
        assert_eq!(
            resolve(&keymap, Context::Chart, "1"),
            Some(Action::Timeframe1m)
        );
        assert_eq!(resolve(&keymap, Context::Global, "Enter"), None);
        assert_eq!(resolve(&keymap, Context::Global, "Z"), None);
        assert_eq!(resolve(&keymap, Context::Global, ""), None);
    }

    #[test]
    fn own_binding_shadows_a_global_binding() {
        let keymap = load_keymap(
            r#"{"version":1,"contexts":{"global":{"B":"order.buy"},"dialog":{"B":"dialog.cancel"}}}"#,
        )
        .expect("valid keymap");
        assert_eq!(
            resolve(&keymap, Context::Dialog, "b"),
            Some(Action::DialogCancel)
        );
        assert_eq!(
            resolve(&keymap, Context::Chart, "b"),
            Some(Action::OrderBuy)
        );
    }

    #[test]
    fn command_focus_uses_only_command_bindings_so_letters_type_text() {
        let keymap = embedded();
        assert_eq!(
            resolve(&keymap, Context::Command, "Enter"),
            Some(Action::CommandSubmit)
        );
        assert_eq!(
            resolve(&keymap, Context::Command, "Escape"),
            Some(Action::CommandBlur)
        );
        assert_eq!(
            resolve(&keymap, Context::Command, "Up"),
            Some(Action::HistoryPrev)
        );
        assert_eq!(resolve(&keymap, Context::Command, "B"), None);
        assert_eq!(resolve(&keymap, Context::Command, "q"), None);
        assert_eq!(resolve(&keymap, Context::Command, "1"), None);
        assert_eq!(resolve(&keymap, Context::Command, ":"), None);
        assert_eq!(resolve(&keymap, Context::Command, "Tab"), None);
    }

    // --- Property P24 ------------------------------------------------------------------------

    /// Canonical keys, each with several spellings. Duplicates are decided by the pool index,
    /// independently of `normalize_key`.
    const POOL: &[&[&str]] = &[
        &["B", "b"],
        &["Q", "q"],
        &["Y", "y"],
        &["1"],
        &["+"],
        &["-"],
        &[":"],
        &["Up", "up", "ArrowUp", "UP"],
        &["Escape", "Esc", "escape"],
        &["Enter", "enter", "Return"],
        &["Tab", "tab"],
        &["Shift+Tab", "shift+tab", "SHIFT+Tab"],
        &[
            "Ctrl+Shift+X",
            "Shift+Ctrl+x",
            "ctrl+shift+X",
            "control+Shift+x",
        ],
        &["Shift+B", "shift+b"],
        // `P` opens the pairing dialog (`auth.pair`, Task 21.2); `Action::ALL` already
        // includes `AuthPair`, so this lets P24 bind and resolve it.
        &["P", "p"],
    ];

    #[derive(Debug, Clone)]
    struct Entry {
        canon: usize,
        spelling: &'static str,
        action: Action,
    }

    fn entry_strategy() -> impl Strategy<Value = Entry> {
        (0..POOL.len())
            .prop_flat_map(|canon| {
                (
                    Just(canon),
                    prop::sample::select(POOL[canon].to_vec()),
                    prop::sample::select(Action::ALL.to_vec()),
                )
            })
            .prop_map(|(canon, spelling, action)| Entry {
                canon,
                spelling,
                action,
            })
    }

    /// Raw spellings are unique per context (they are JSON object keys); normalized keys may
    /// still collide through case variants and aliases.
    fn context_strategy() -> impl Strategy<Value = Vec<Entry>> {
        prop::collection::vec(entry_strategy(), 0..=8).prop_map(|entries| {
            let mut seen = HashSet::new();
            entries
                .into_iter()
                .filter(|e| seen.insert(e.spelling))
                .collect::<Vec<Entry>>()
        })
    }

    proptest! {
        // Property P24 — validates Req 32.4
        // load_keymap accepts a map exactly when no context binds the same normalized key
        // twice; when it accepts, resolve returns the bound action for every spelling of
        // every bound key.
        #[test]
        fn p24_accepts_iff_no_duplicate_normalized_keys(
            spec in prop::collection::vec(context_strategy(), Context::ALL.len())
        ) {
            let mut contexts = Map::new();
            for (ctx, entries) in Context::ALL.iter().zip(&spec) {
                let bindings: Map<String, Value> = entries
                    .iter()
                    .map(|e| (e.spelling.to_owned(), Value::String(e.action.name().to_owned())))
                    .collect();
                contexts.insert(ctx.name().to_owned(), Value::Object(bindings));
            }
            let text = Value::Object(Map::from_iter([
                ("version".to_owned(), Value::from(1)),
                ("contexts".to_owned(), Value::Object(contexts)),
            ]))
            .to_string();

            let has_duplicate = spec.iter().any(|entries| {
                entries.iter().map(|e| e.canon).collect::<HashSet<_>>().len() != entries.len()
            });
            let result = load_keymap(&text);
            prop_assert_eq!(result.is_ok(), !has_duplicate, "{:?}", result.as_ref().err());
            if let Ok(keymap) = result {
                for (ctx, entries) in Context::ALL.iter().zip(&spec) {
                    for e in entries {
                        for spelling in POOL[e.canon] {
                            prop_assert_eq!(resolve(&keymap, *ctx, spelling), Some(e.action));
                        }
                    }
                }
            }
        }
    }
}
