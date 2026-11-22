//! News and AI Copilot state and keys (Task 16.4, Req 7, 31).
//!
//! Everything here is pure. The Copilot never places an order: an analysis trade idea becomes a
//! preview only when the user presses `t`, which sends the idea's command text as `CommandText`;
//! the server answers with a preview and the confirm dialog still decides. The TUI holds no key
//! and sends only `SetProvider`, `SubscribeNews`, `AiRequest`, `AiCancel`, and `CommandText`.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use protocol::client::{AnalysisResult, ClientMessage, ScanItem, ServerMessage};
use protocol::{AnalysisBias, CopilotAction, NewsItem, Side, TwapStatus};

use crate::app::{App, Page};
use crate::line_editor::LineEditor;
use crate::order_input::{EditOp, Focus, apply_edit};

/// How many news items the TUI keeps.
pub const MAX_NEWS: usize = 50;
/// How many TWAP plans the TUI keeps.
pub const MAX_TWAPS: usize = 6;

/// What the Copilot panel shows below the input line.
#[derive(Debug, Clone, PartialEq)]
pub enum CopilotOutput {
    Analysis {
        analysis: AnalysisResult,
        /// Canonical command text of the suggested order, when the server built a preview.
        command: Option<String>,
        preview_error: Option<String>,
    },
    Scan(Vec<ScanItem>),
    Strategy(String),
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct CopilotState {
    pub input: LineEditor,
    /// The input line takes every key while true.
    pub focused: bool,
    /// The request id in flight.
    pub pending: Option<String>,
    pub output: Option<CopilotOutput>,
}

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

/// Like [`clean`] but keeps line breaks.
pub fn clean_multiline(text: &str) -> String {
    text.chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect()
}

/// True when the AI is unusable: no provider is available.
pub fn ai_disabled(app: &App) -> bool {
    app.providers.iter().all(|p| p.reason.is_some())
}

/// True while the Copilot input line takes text keys, so `q` and the page digits must not act.
pub fn captures_text(app: &App) -> bool {
    app.page == Page::Copilot
        && app.copilot.focused
        && app.focus == Focus::Chart
        && !app.account.dialog_open()
}

/// Applies the news, Copilot, and TWAP server messages. `None` means the message is not one of
/// them; `Some(changed)` says whether the screen changed.
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
        ServerMessage::Analysis {
            request_id,
            analysis,
            preview,
            preview_error,
            ..
        } => Some(finish(app, request_id, || CopilotOutput::Analysis {
            analysis: AnalysisResult {
                symbol: clean(&analysis.symbol),
                summary: clean_multiline(&analysis.summary),
                bias: analysis.bias,
                confidence_bps: analysis.confidence_bps,
                rationale: analysis.rationale.iter().map(|r| clean(r)).collect(),
                suggested_order: analysis.suggested_order,
            },
            command: preview.as_ref().map(|p| clean(&p.text)),
            preview_error: preview_error.as_ref().map(|e| clean(&e.message)),
        })),
        ServerMessage::ScanResult { request_id, items } => Some(finish(app, request_id, || {
            CopilotOutput::Scan(
                items
                    .iter()
                    .map(|i| ScanItem {
                        symbol: clean(&i.symbol),
                        bias: i.bias,
                        confidence_bps: i.confidence_bps,
                        summary: clean(&i.summary),
                    })
                    .collect(),
            )
        })),
        ServerMessage::StrategyDraft { request_id, text } => Some(finish(app, request_id, || {
            CopilotOutput::Strategy(clean_multiline(text))
        })),
        ServerMessage::AiError {
            request_id,
            message,
            ..
        } => Some(finish(app, request_id, || {
            CopilotOutput::Error(clean(message))
        })),
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

/// Ends the pending request when `request_id` is it. A reply to another request (a canceled
/// one) is dropped.
fn finish(app: &mut App, request_id: &str, output: impl FnOnce() -> CopilotOutput) -> bool {
    if app.copilot.pending.as_deref() != Some(request_id) {
        return false;
    }
    app.copilot.pending = None;
    app.copilot.output = Some(output());
    true
}

/// What a key did.
#[derive(Debug, Default)]
pub struct KeyOutcome {
    pub changed: bool,
    pub messages: Vec<ClientMessage>,
    /// An OSC 52 sequence for the terminal to copy a URL.
    pub osc52: Option<String>,
}

fn consumed(changed: bool) -> Option<KeyOutcome> {
    Some(KeyOutcome {
        changed,
        ..KeyOutcome::default()
    })
}

/// Handles a key on the News or Copilot page. `None` means the key is not for these panels.
pub fn handle_key(app: &mut App, key: &KeyEvent) -> Option<KeyOutcome> {
    if key.kind != KeyEventKind::Press
        || app.account.dialog_open()
        || app.pairing.is_open()
        || app.picker.is_some()
        || app.focus != Focus::Chart
    {
        return None;
    }
    match app.page {
        Page::Copilot => copilot_key(app, key),
        Page::News => news_key(app, key),
        _ => None,
    }
}

fn copilot_key(app: &mut App, key: &KeyEvent) -> Option<KeyOutcome> {
    if app.copilot.focused {
        let plain = !key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
        return match key.code {
            KeyCode::Esc => {
                if let Some(message) = cancel(app) {
                    Some(KeyOutcome {
                        changed: true,
                        messages: vec![message],
                        osc52: None,
                    })
                } else {
                    app.copilot.focused = false;
                    consumed(true)
                }
            }
            KeyCode::Enter => {
                let messages: Vec<_> = submit(app).into_iter().collect();
                Some(KeyOutcome {
                    changed: true,
                    messages,
                    osc52: None,
                })
            }
            KeyCode::Char(c) if plain => {
                consumed(apply_edit(&mut app.copilot.input, EditOp::Insert(c)))
            }
            KeyCode::Backspace => consumed(apply_edit(&mut app.copilot.input, EditOp::Backspace)),
            KeyCode::Delete => consumed(apply_edit(&mut app.copilot.input, EditOp::Delete)),
            KeyCode::Left => consumed(apply_edit(&mut app.copilot.input, EditOp::Left)),
            KeyCode::Right => consumed(apply_edit(&mut app.copilot.input, EditOp::Right)),
            KeyCode::Home => consumed(apply_edit(&mut app.copilot.input, EditOp::Home)),
            KeyCode::End => consumed(apply_edit(&mut app.copilot.input, EditOp::End)),
            _ => consumed(false),
        };
    }
    if key
        .modifiers
        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
    {
        return None;
    }
    match key.code {
        // Focusing the input is the `copilot.focus` keymap action, handled in `main.rs`.
        KeyCode::Char('t' | 'T') => {
            let messages: Vec<_> = trade_preview(app).into_iter().collect();
            if messages.is_empty() {
                return None;
            }
            Some(KeyOutcome {
                changed: true,
                messages,
                osc52: None,
            })
        }
        KeyCode::Esc => cancel(app).map(|message| KeyOutcome {
            changed: true,
            messages: vec![message],
            osc52: None,
        }),
        _ => None,
    }
}

fn news_key(app: &mut App, key: &KeyEvent) -> Option<KeyOutcome> {
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
                messages: Vec::new(),
                osc52: Some(osc52_copy(&url)),
            })
        }
        _ => None,
    }
}

/// Builds the `AiRequest` for the input line: analyze by default, `/scan`, `/strategy`, `/ask`.
pub fn submit(app: &mut App) -> Option<ClientMessage> {
    if app.copilot.pending.is_some() {
        return None;
    }
    let line = app.copilot.input.text().trim().to_owned();
    let (action, text) = match line.split_once(char::is_whitespace) {
        Some(("/scan", rest)) => (CopilotAction::Scan, rest.trim().to_owned()),
        Some(("/strategy", rest)) => (CopilotAction::CreateStrategy, rest.trim().to_owned()),
        Some(("/ask", rest)) => (CopilotAction::Ask, rest.trim().to_owned()),
        Some(_) => (CopilotAction::Analyze, line.clone()),
        None => match line.as_str() {
            "/scan" => (CopilotAction::Scan, String::new()),
            "/strategy" => (CopilotAction::CreateStrategy, String::new()),
            "/ask" => (CopilotAction::Ask, String::new()),
            _ => (CopilotAction::Analyze, line.clone()),
        },
    };
    let request_id = app.request_ids.next(app.now_ms);
    app.copilot.pending = Some(request_id.clone());
    app.copilot.output = None;
    app.copilot.input.clear();
    Some(ClientMessage::AiRequest {
        request_id,
        action,
        text,
        symbol: app.symbol.clone(),
        timeframe: app.timeframe,
        venue: app.active_venue,
    })
}

/// Cancels the request in flight, if any.
pub fn cancel(app: &mut App) -> Option<ClientMessage> {
    let request_id = app.copilot.pending.take()?;
    app.copilot.output = Some(CopilotOutput::Error("canceled".to_owned()));
    Some(ClientMessage::AiCancel { request_id })
}

/// Sends the analysis's trade idea as command text. The server answers with a preview and the
/// confirm dialog still decides; nothing is placed here.
pub fn trade_preview(app: &mut App) -> Option<ClientMessage> {
    let Some(CopilotOutput::Analysis {
        command: Some(text),
        ..
    }) = &app.copilot.output
    else {
        return None;
    };
    let text = text.clone();
    let request_id = app.request_ids.next(app.now_ms);
    app.account.command_sent(&request_id);
    Some(ClientMessage::CommandText {
        request_id,
        text,
        venue: Some(app.active_venue),
    })
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

pub fn bias_label(bias: AnalysisBias) -> &'static str {
    match bias {
        AnalysisBias::Long => "LONG",
        AnalysisBias::Short => "SHORT",
        AnalysisBias::Neutral => "NEUTRAL",
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
