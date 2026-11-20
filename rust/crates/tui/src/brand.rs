//! The Oni palette and art. The values match web/styles/oni-theme.css.
//!
//! Buy, long, and positive stay green and sell, short, and negative stay red, because traders
//! rely on those meanings. The blood-red accent is for borders and titles only.

use ratatui::style::{Color, Style};
use ratatui::widgets::Block;

/// Blood red accent (`#c1121f`).
pub const ACCENT: Color = Color::Rgb(0xc1, 0x12, 0x1f);
/// Bright red (`#ff2a2a`): the kanji and focused borders.
pub const ACCENT_BRIGHT: Color = Color::Rgb(0xff, 0x2a, 0x2a);
/// Panel border (`#8b0000`).
pub const BORDER: Color = Color::Rgb(0x8b, 0x00, 0x00);
/// Muted grey for labels and axes (`#8a8a8f`).
pub const MUTED: Color = Color::Rgb(0x8a, 0x8a, 0x8f);
/// Faint grey for placeholders and inactive items.
pub const FAINT: Color = Color::Rgb(0x5d, 0x5d, 0x63);
/// Main text (`#e5e5e5`).
pub const TEXT: Color = Color::Rgb(0xe5, 0xe5, 0xe5);
/// Warnings and prompts (`#f59e0b`).
pub const AMBER: Color = Color::Rgb(0xf5, 0x9e, 0x0b);
/// Buy, long, up, positive (`#22c55e`).
pub const BUY: Color = Color::Rgb(0x22, 0xc5, 0x5e);
/// Sell, short, down, negative (`#ef4444`).
pub const SELL: Color = Color::Rgb(0xef, 0x44, 0x44);
/// Dim volume bars under up candles.
pub const VOLUME_UP: Color = Color::Rgb(0x0f, 0x5a, 0x2b);
/// Dim volume bars under down candles.
pub const VOLUME_DOWN: Color = Color::Rgb(0x6e, 0x1f, 0x1f);
/// Bollinger lines: muted red.
pub const BOLLINGER: Color = Color::Rgb(0xa1, 0x40, 0x48);

/// A bordered panel with a crimson border and a red title accent. The geometry is the same as
/// `Block::bordered()`, so `inner` and the hit rectangles do not change.
pub fn block() -> Block<'static> {
    Block::bordered()
        .border_style(Style::new().fg(BORDER))
        .title_style(Style::new().fg(ACCENT))
}

/// The header text: `ONI` and the kanji for oni. The kanji is two cells wide, so measure it
/// with ratatui's width handling (`Line::width`), never with `chars().count()`.
pub const LOGO: &str = include_str!("../assets/oni_logo.txt");

/// ASCII demon art, about 14 rows by 28 columns, ASCII characters only.
// Not drawn by any screen yet; kept for a later splash screen.
#[allow(dead_code)]
pub const DEMON: &str = include_str!("../assets/oni_demon.txt");
