//! A tiny single-line text editor for the command bar and the ticket quantity (Task 12.4,
//! Req 31.1).
//!
//! Pure: no terminal types. The cursor counts characters, not bytes, so editing stays correct
//! for non-ASCII text. Every method returns whether the text or the cursor changed, so the
//! caller knows whether to redraw.

// Part of the API (such as `home`) is used only by tests and later panels.
#![allow(dead_code)]

/// Longest text the editor holds, in characters. Further input is ignored.
pub const MAX_CHARS: usize = 256;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LineEditor {
    text: String,
    /// Cursor position in characters, from 0 to the character count.
    cursor: usize,
}

impl LineEditor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    /// The cursor position in characters.
    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    /// The number of characters.
    pub fn len_chars(&self) -> usize {
        self.text.chars().count()
    }

    /// The byte offset of character index `chars` (the text length when past the end).
    fn byte_index(&self, chars: usize) -> usize {
        self.text
            .char_indices()
            .nth(chars)
            .map_or(self.text.len(), |(index, _)| index)
    }

    /// Replaces the text (cut to [`MAX_CHARS`]) and puts the cursor at the end.
    pub fn set(&mut self, text: &str) {
        self.text = text.chars().take(MAX_CHARS).collect();
        self.cursor = self.len_chars();
    }

    pub fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
    }

    /// Inserts `c` at the cursor. Control characters are ignored, and so is any character past
    /// [`MAX_CHARS`].
    pub fn insert(&mut self, c: char) -> bool {
        if c.is_control() || self.len_chars() >= MAX_CHARS {
            return false;
        }
        let at = self.byte_index(self.cursor);
        self.text.insert(at, c);
        self.cursor += 1;
        true
    }

    /// Removes the character before the cursor.
    pub fn backspace(&mut self) -> bool {
        if self.cursor == 0 {
            return false;
        }
        let at = self.byte_index(self.cursor - 1);
        self.text.remove(at);
        self.cursor -= 1;
        true
    }

    /// Removes the character under the cursor.
    pub fn delete(&mut self) -> bool {
        if self.cursor >= self.len_chars() {
            return false;
        }
        let at = self.byte_index(self.cursor);
        self.text.remove(at);
        true
    }

    pub fn left(&mut self) -> bool {
        if self.cursor == 0 {
            return false;
        }
        self.cursor -= 1;
        true
    }

    pub fn right(&mut self) -> bool {
        if self.cursor >= self.len_chars() {
            return false;
        }
        self.cursor += 1;
        true
    }

    pub fn home(&mut self) -> bool {
        let changed = self.cursor != 0;
        self.cursor = 0;
        changed
    }

    pub fn end(&mut self) -> bool {
        let end = self.len_chars();
        let changed = self.cursor != end;
        self.cursor = end;
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn typed(text: &str) -> LineEditor {
        let mut editor = LineEditor::new();
        for c in text.chars() {
            editor.insert(c);
        }
        editor
    }

    #[test]
    fn typing_appends_and_moves_the_cursor() {
        let editor = typed("BUY");
        assert_eq!(editor.text(), "BUY");
        assert_eq!(editor.cursor(), 3);
    }

    #[test]
    fn insert_in_the_middle_and_backspace_delete() {
        let mut editor = typed("BY");
        assert!(editor.left());
        assert!(editor.insert('U'));
        assert_eq!(editor.text(), "BUY");
        assert_eq!(editor.cursor(), 2);
        assert!(editor.backspace());
        assert_eq!(editor.text(), "BY");
        assert_eq!(editor.cursor(), 1);
        assert!(editor.delete());
        assert_eq!(editor.text(), "B");
        // Nothing left of the cursor to remove after home, and nothing under it at the end.
        assert!(editor.home());
        assert!(!editor.backspace());
        assert!(editor.end());
        assert!(!editor.delete());
        assert!(!editor.right());
    }

    #[test]
    fn home_and_end_report_whether_they_moved() {
        let mut editor = typed("ab");
        assert!(!editor.end());
        assert!(editor.home());
        assert_eq!(editor.cursor(), 0);
        assert!(!editor.home());
        assert!(!editor.left());
        assert!(editor.end());
        assert_eq!(editor.cursor(), 2);
    }

    #[test]
    fn editing_is_by_character_not_byte() {
        let mut editor = typed("a✕b");
        assert_eq!(editor.cursor(), 3);
        editor.left();
        assert!(editor.backspace());
        assert_eq!(editor.text(), "ab");
        assert_eq!(editor.cursor(), 1);
    }

    #[test]
    fn control_characters_and_overflow_are_ignored() {
        let mut editor = LineEditor::new();
        assert!(!editor.insert('\n'));
        assert!(!editor.insert('\t'));
        for _ in 0..(MAX_CHARS + 10) {
            editor.insert('x');
        }
        assert_eq!(editor.len_chars(), MAX_CHARS);
        assert!(!editor.insert('y'));
    }

    #[test]
    fn set_replaces_the_text_and_clear_empties_it() {
        let mut editor = typed("old");
        editor.set("BUY BTC 1");
        assert_eq!(editor.text(), "BUY BTC 1");
        assert_eq!(editor.cursor(), 9);
        editor.clear();
        assert!(editor.is_empty());
        assert_eq!(editor.cursor(), 0);
    }

    proptest! {
        // Whatever sequence of edits runs, the cursor stays inside the text.
        #[test]
        fn the_cursor_stays_in_range(ops in proptest::collection::vec(0u8..8, 0..64)) {
            let mut editor = LineEditor::new();
            for op in ops {
                match op {
                    0 | 1 => { editor.insert('a'); }
                    2 => { editor.insert('é'); }
                    3 => { editor.backspace(); }
                    4 => { editor.delete(); }
                    5 => { editor.left(); }
                    6 => { editor.right(); }
                    _ => { editor.home(); }
                }
                prop_assert!(editor.cursor() <= editor.len_chars());
            }
        }
    }
}
