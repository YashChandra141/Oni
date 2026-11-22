//! News list and TWAP progress state and keys (Task 16.4, Req 7, 31).
//!
//! Everything here is pure. The TUI holds no key. It has no AI Copilot panel; the provider and
//! model keys stay for the `?` plain-English orders in the command bar.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use protocol::client::ServerMessage;
use protocol::{NewsItem, Side, TwapStatus};

use crate::app::{App, Page};
use crate::order_input::Focus;

/// How many news items the TUI keeps.
pub const MAX_NEWS: usize = 50;
/// How many TWAP plans the TUI keeps.
pub const MAX_TWAPS: usize = 6;

#[derive(Debug, Clone, PartialEq)]
pub struct NewsState {
    /// False when the server has no news provider configured.
    pub enabled: bool,
    pub available: bool,
    pub items: Vec<NewsItem>,
    pub selected: usize,
    /// The URL of the selected item after Enter, shown as text. No browser is opened.
    pub shown_url: Option<String>,
}

impl Default for NewsState {
    fn default() -> Self {
        Self {
            enabled: true,
            available: true,
            items: Vec::new(),
            selected: 0,
            shown_url: None,
        }
    }
}

/// One TWAP plan's progress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TwapRow {
    pub id: String,
    pub symbol: String,
    pub side: Side,
    pub sent: u32,
    pub slices: u32,
    pub status: TwapStatus,
    pub reason: Option<String>,
}

/// Text from outside with control characters removed.
pub fn clean(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).collect()
}

/// Applies the news and TWAP server messages. `None` means the message is not one of them;
/// `Some(changed)` says whether the screen changed.
pub fn apply_message(app: &mut App, message: &ServerMessage) -> Option<bool> {
    match message {
        ServerMessage::News {
            available, items, ..
        } => {
            app.news.available = *available;
            app.news.items = items
                .iter()
                .take(MAX_NEWS)
                .map(|item| NewsItem {
                    id: clean(&item.id),
                    title: clean(&item.title),
                    source: clean(&item.source),
                    url: clean(&item.url),
                    published_at: item.published_at,
                    symbols: item.symbols.iter().map(|s| clean(s)).collect(),
                })
                .collect();
            app.news.selected = app
                .news
                .selected
                .min(app.news.items.len().saturating_sub(1));
            app.news.shown_url = None;
            Some(true)
        }
        ServerMessage::Twap {
            twap_id,
            symbol,
            side,
            sent,
            slices,
            status,
            reason,
            ..
        } => {
            let row = TwapRow {
                id: twap_id.clone(),
                symbol: clean(symbol),
                side: *side,
                sent: *sent,
                slices: *slices,
                status: *status,
                reason: reason.as_deref().map(clean),
            };
            match app.twaps.iter_mut().find(|t| t.id == row.id) {
                Some(existing) => *existing = row,
                None => {
                    app.twaps.push(row);
                    if app.twaps.len() > MAX_TWAPS {
                        app.twaps.remove(0);
                    }
                }
            }
            Some(true)
        }
        _ => None,
    }
}

/// What a key did.
#[derive(Debug, Default)]
pub struct KeyOutcome {
    pub changed: bool,
    /// An OSC 52 sequence for the terminal to copy a URL.
    pub osc52: Option<String>,
}

fn consumed(changed: bool) -> Option<KeyOutcome> {
    Some(KeyOutcome {
        changed,
        ..KeyOutcome::default()
    })
}

/// Handles a key on the News page. `None` means the key is not for the news list.
pub fn handle_key(app: &mut App, key: &KeyEvent) -> Option<KeyOutcome> {
    if key.kind != KeyEventKind::Press
        || app.account.dialog_open()
        || app.pairing.is_open()
        || app.picker.is_some()
        || app.focus != Focus::Chart
        || app.page != Page::News
    {
        return None;
    }
    if key
        .modifiers
        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
    {
        return None;
    }
    let last = app.news.items.len().saturating_sub(1);
    match key.code {
        KeyCode::Up | KeyCode::Char('k') => {
            let before = app.news.selected;
            app.news.selected = before.saturating_sub(1);
            app.news.shown_url = None;
            consumed(before != app.news.selected)
        }
        KeyCode::Down | KeyCode::Char('j') => {
            let before = app.news.selected;
            app.news.selected = (before + 1).min(last);
            app.news.shown_url = None;
            consumed(before != app.news.selected)
        }
        KeyCode::Enter => {
            let url = app.news.items.get(app.news.selected)?.url.clone();
            app.news.shown_url = Some(url);
            consumed(true)
        }
        KeyCode::Char('y' | 'Y') => {
            let url = app.news.items.get(app.news.selected)?.url.clone();
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return None;
            }
            app.news.shown_url = Some(url.clone());
            Some(KeyOutcome {
                changed: true,
                osc52: Some(osc52_copy(&url)),
            })
        }
        _ => None,
    }
}

/// `3s`, `5m`, `2h`, or `4d` between `published_ms` and `now_ms`.
pub fn time_ago(now_ms: i64, published_ms: i64) -> String {
    let secs = (now_ms.saturating_sub(published_ms) / 1000).max(0);
    match secs {
        0..=59 => format!("{secs}s"),
        60..=3599 => format!("{}m", secs / 60),
        3600..=86_399 => format!("{}h", secs / 3600),
        _ => format!("{}d", secs / 86_400),
    }
}

/// The OSC 52 sequence that asks the terminal to copy `text`.
pub fn osc52_copy(text: &str) -> String {
    format!("\x1b]52;c;{}\x07", base64(text.as_bytes()))
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk.first().copied().unwrap_or(0));
        let b1 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b2 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let n = (b0 << 16) | (b1 << 8) | b2;
        let pick = |shift: u32| {
            let index = usize::try_from((n >> shift) & 63).unwrap_or(0);
            char::from(TABLE.get(index).copied().unwrap_or(b'A'))
        };
        out.push(pick(18));
        out.push(pick(12));
        out.push(if chunk.len() > 1 { pick(6) } else { '=' });
        out.push(if chunk.len() > 2 { pick(0) } else { '=' });
    }
    out
}
