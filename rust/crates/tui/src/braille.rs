//! Braille line drawing for the indicator overlays (Req 26.1, 34.2).
//!
//! A braille cell is 2 dot columns by 4 dot rows. The character is U+2800 plus a bit mask:
//!
//! ```text
//!  dot column:   left   right
//!  dot row 0     0x01   0x08
//!  dot row 1     0x02   0x10
//!  dot row 2     0x04   0x20
//!  dot row 3     0x40   0x80
//! ```
//!
//! (Unicode dots 1, 2, 3, 7 are the left column, top to bottom, and 4, 5, 6, 8 the right
//! column.) All eight bits set is `⣿` (U+28FF).
//!
//! Dots are given in the dot grid of a plot area: `x` in `0..2 * width`, `y` in
//! `0..4 * height`, with `(0, 0)` at the top-left dot.

// Some helpers are used only by tests.
#![allow(dead_code)]

use std::collections::HashMap;

use ratatui::buffer::Buffer;
use ratatui::style::Color;

use crate::chart_widget::PlotGeometry;
use crate::indicator_model::Dot;

/// The braille bit of the dot at (`dx` 0..=1, `dy` 0..=3) inside a cell.
pub fn braille_bit(dx: usize, dy: usize) -> u8 {
    const LEFT: [u8; 4] = [0x01, 0x02, 0x04, 0x40];
    const RIGHT: [u8; 4] = [0x08, 0x10, 0x20, 0x80];
    let column = if dx == 0 { &LEFT } else { &RIGHT };
    column.get(dy).copied().unwrap_or(0)
}

/// The braille character of a bit mask.
pub fn braille_char(bits: u8) -> char {
    char::from_u32(0x2800 + u32::from(bits)).unwrap_or(' ')
}

/// The bit mask of a braille character, or `None` for any other character.
pub fn braille_bits(ch: char) -> Option<u8> {
    let code = u32::from(ch);
    (0x2800..=0x28FF)
        .contains(&code)
        .then(|| u8::try_from(code - 0x2800).unwrap_or(0))
}

/// Draws `dots` (plot dot coordinates) as braille characters in `color`.
///
/// A cell is written only when it is empty (a space) or already holds a braille character, so
/// candles, the axis, and other text are never overwritten. In a cell that already holds a
/// braille character the bits are OR-ed, and the foreground becomes `color` (the latest line
/// wins the color). Dots outside the plot area or outside the buffer are skipped.
pub fn draw_braille_line(buf: &mut Buffer, geometry: &PlotGeometry, color: Color, dots: &[Dot]) {
    let area = geometry.area;
    let mut cells: HashMap<(u16, u16), u8> = HashMap::new();
    for dot in dots {
        let (cx, dx) = (dot.x / 2, dot.x % 2);
        let (cy, dy) = (dot.y / 4, dot.y % 4);
        let (Ok(cx), Ok(cy)) = (u16::try_from(cx), u16::try_from(cy)) else {
            continue;
        };
        if cx >= area.width || cy >= area.height {
            continue;
        }
        *cells.entry((area.x + cx, area.y + cy)).or_insert(0) |= braille_bit(dx, dy);
    }
    for ((x, y), bits) in cells {
        let Some(cell) = buf.cell_mut((x, y)) else {
            continue;
        };
        let existing = match cell.symbol().chars().next() {
            Some(' ') | None => 0,
            Some(ch) if cell.symbol().chars().count() == 1 => match braille_bits(ch) {
                Some(old) => old,
                None => continue,
            },
            Some(_) => continue,
        };
        cell.set_char(braille_char(existing | bits));
        cell.set_fg(color);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart_model::PriceScale;
    use ratatui::layout::Rect;

    fn geometry(area: Rect) -> PlotGeometry {
        PlotGeometry {
            area,
            count: 1,
            scale: PriceScale { min: 0, max: 1 },
        }
    }

    fn all_dots() -> Vec<Dot> {
        (0..2)
            .flat_map(|x| (0..4).map(move |y| Dot { x, y }))
            .collect()
    }

    #[test]
    fn bit_table_matches_the_unicode_dot_order() {
        let left: Vec<u8> = (0..4).map(|y| braille_bit(0, y)).collect();
        let right: Vec<u8> = (0..4).map(|y| braille_bit(1, y)).collect();
        assert_eq!(left, [0x01, 0x02, 0x04, 0x40]);
        assert_eq!(right, [0x08, 0x10, 0x20, 0x80]);
        let all = left.iter().chain(&right).fold(0u8, |a, b| a | b);
        assert_eq!(all, 0xFF);
        assert_eq!(braille_char(all), '⣿');
        assert_eq!(braille_char(0), '\u{2800}');
        assert_eq!(braille_char(0x01), '⠁');
        assert_eq!(braille_char(0x40), '⡀');
        assert_eq!(braille_bits('⣿'), Some(0xFF));
        assert_eq!(braille_bits('a'), None);
    }

    #[test]
    fn draws_all_dots_of_one_cell_as_a_full_block() {
        let area = Rect::new(2, 1, 4, 3);
        let mut buf = Buffer::empty(Rect::new(0, 0, 10, 6));
        draw_braille_line(&mut buf, &geometry(area), Color::Yellow, &all_dots());
        assert_eq!(buf[(2, 1)].symbol(), "⣿");
        assert_eq!(buf[(2, 1)].style().fg, Some(Color::Yellow));
        assert_eq!(buf[(3, 1)].symbol(), " ");
    }

    #[test]
    fn dots_in_other_cells_land_at_the_right_offsets() {
        let area = Rect::new(2, 1, 4, 3);
        let mut buf = Buffer::empty(Rect::new(0, 0, 10, 6));
        // Dot x 5 is cell column 2, right dot column; dot y 9 is cell row 2, dot row 1.
        draw_braille_line(
            &mut buf,
            &geometry(area),
            Color::Cyan,
            &[Dot { x: 5, y: 9 }],
        );
        assert_eq!(buf[(4, 3)].symbol(), "⠐");
    }

    #[test]
    fn lines_sharing_a_cell_or_bits_and_the_latest_color_wins() {
        let area = Rect::new(0, 0, 2, 2);
        let mut buf = Buffer::empty(area);
        let g = geometry(area);
        draw_braille_line(&mut buf, &g, Color::Yellow, &[Dot { x: 0, y: 0 }]);
        draw_braille_line(&mut buf, &g, Color::Cyan, &[Dot { x: 1, y: 3 }]);
        assert_eq!(buf[(0, 0)].symbol(), braille_char(0x01 | 0x80).to_string());
        assert_eq!(buf[(0, 0)].style().fg, Some(Color::Cyan));
    }

    #[test]
    fn non_empty_non_braille_cells_are_kept() {
        let area = Rect::new(0, 0, 2, 2);
        let mut buf = Buffer::empty(area);
        buf[(0, 0)].set_char('█');
        draw_braille_line(&mut buf, &geometry(area), Color::Green, &all_dots());
        assert_eq!(buf[(0, 0)].symbol(), "█");
    }

    #[test]
    fn dots_outside_the_plot_or_buffer_are_skipped() {
        let area = Rect::new(0, 0, 2, 2);
        let mut buf = Buffer::empty(Rect::new(0, 0, 5, 5));
        let dots = [
            Dot { x: 4, y: 0 },
            Dot { x: 0, y: 8 },
            Dot {
                x: usize::MAX,
                y: 0,
            },
        ];
        draw_braille_line(&mut buf, &geometry(area), Color::Green, &dots);
        assert!((0..5).all(|y| (0..5).all(|x| buf[(x, y)].symbol() == " ")));
        // A plot area larger than the buffer does not panic.
        let big = geometry(Rect::new(0, 0, 50, 50));
        draw_braille_line(&mut buf, &big, Color::Green, &[Dot { x: 90, y: 90 }]);
    }
}
