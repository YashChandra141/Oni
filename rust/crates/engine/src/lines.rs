//! Bounded line reader for engine stdin.
//!
//! A line longer than the limit is never buffered whole: once it passes the limit, the reader
//! drops what it holds and skips the rest of the line up to the next `\n`, counting its length.

use std::io;
use std::mem;

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

/// One input line, without its `\n` or `\r\n` terminator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    /// The line's bytes. Not checked for UTF-8.
    Complete(Vec<u8>),
    /// The line was longer than the limit and was discarded. `len` is its length in bytes,
    /// without the terminator.
    TooLong { len: usize },
}

/// Reads `\n`-terminated lines of at most `max` bytes (not counting the terminator).
///
/// [`LineReader::next_line`] is cancel safe: all progress lives in the reader, and its only
/// await point is `fill_buf`, so it can be used in `tokio::select!`.
pub struct LineReader<R> {
    inner: R,
    state: LineState,
}

/// The current line, kept apart from the inner reader so both can be borrowed at once.
struct LineState {
    max: usize,
    buf: Vec<u8>,
    /// Bytes seen so far of a line that is being discarded, or `None` while buffering.
    discarded: Option<usize>,
    /// Whether the last byte seen of the current line is `\r`.
    ends_cr: bool,
}

impl<R: AsyncBufRead + Unpin> LineReader<R> {
    pub fn new(inner: R, max: usize) -> Self {
        Self {
            inner,
            state: LineState {
                max,
                buf: Vec::new(),
                discarded: None,
                ends_cr: false,
            },
        }
    }

    /// Returns the next line, or `None` at end of input. A final line without a terminator is
    /// still returned.
    pub async fn next_line(&mut self) -> io::Result<Option<Line>> {
        loop {
            let chunk = self.inner.fill_buf().await?;
            if chunk.is_empty() {
                return Ok(self.state.finish_at_eof());
            }
            let newline = chunk.iter().position(|&b| b == b'\n');
            let part = match newline {
                Some(i) => chunk.get(..i).unwrap_or(chunk),
                None => chunk,
            };
            let used = part.len() + usize::from(newline.is_some());
            self.state.push(part);
            self.inner.consume(used);
            if newline.is_some() {
                return Ok(Some(self.state.take_line()));
            }
        }
    }
}

impl LineState {
    /// Adds bytes of the current line, switching to discard mode once the line is too long.
    /// One byte past the limit is kept so that a trailing `\r` does not count.
    fn push(&mut self, part: &[u8]) {
        if let Some(&last) = part.last() {
            self.ends_cr = last == b'\r';
        }
        match &mut self.discarded {
            Some(seen) => *seen += part.len(),
            None if self.buf.len() + part.len() > self.max + 1 => {
                self.discarded = Some(self.buf.len() + part.len());
                self.buf = Vec::new();
            }
            None => self.buf.extend_from_slice(part),
        }
    }

    fn take_line(&mut self) -> Line {
        let ends_cr = mem::take(&mut self.ends_cr);
        if let Some(seen) = self.discarded.take() {
            return Line::TooLong {
                len: seen.saturating_sub(usize::from(ends_cr)),
            };
        }
        let mut line = mem::take(&mut self.buf);
        if ends_cr {
            line.pop();
        }
        if line.len() > self.max {
            Line::TooLong { len: line.len() }
        } else {
            Line::Complete(line)
        }
    }

    fn finish_at_eof(&mut self) -> Option<Line> {
        if self.discarded.is_none() && self.buf.is_empty() {
            None
        } else {
            Some(self.take_line())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    /// Reads every line, feeding the reader `chunk` bytes at a time.
    async fn read_all(input: &[u8], max: usize, chunk: usize) -> Vec<Line> {
        let mut reader = LineReader::new(BufReader::with_capacity(chunk, input), max);
        let mut lines = Vec::new();
        while let Some(line) = reader.next_line().await.unwrap() {
            lines.push(line);
        }
        lines
    }

    fn complete(s: &str) -> Line {
        Line::Complete(s.as_bytes().to_vec())
    }

    #[tokio::test]
    async fn splits_lf_and_crlf_lines() {
        for chunk in [1, 2, 3, 64] {
            let lines = read_all(b"ab\r\ncd\n\nlast", 8, chunk).await;
            let expected = vec![
                complete("ab"),
                complete("cd"),
                complete(""),
                complete("last"),
            ];
            assert_eq!(lines, expected, "chunk {chunk}");
        }
        assert_eq!(read_all(b"", 8, 4).await, Vec::new());
        assert_eq!(read_all(b"x\n", 8, 4).await, vec![complete("x")]);
    }

    #[tokio::test]
    async fn over_long_line_is_skipped_and_next_line_still_reads() {
        for chunk in [1, 3, 5, 64] {
            let input = b"12345678\n123456789\r\n0123456789abcdef\nok\r\n12345678\r\n";
            let lines = read_all(input, 8, chunk).await;
            let expected = vec![
                complete("12345678"),
                Line::TooLong { len: 9 },
                Line::TooLong { len: 16 },
                complete("ok"),
                complete("12345678"),
            ];
            assert_eq!(lines, expected, "chunk {chunk}");
        }
    }

    #[tokio::test]
    async fn over_long_final_line_without_terminator() {
        let lines = read_all(b"ok\n0123456789", 8, 4).await;
        assert_eq!(lines, vec![complete("ok"), Line::TooLong { len: 10 }]);
    }

    #[tokio::test]
    async fn does_not_buffer_a_discarded_line() {
        let input = vec![b'x'; 100_000];
        let mut reader = LineReader::new(BufReader::with_capacity(1024, &input[..]), 8);
        let line = reader.next_line().await.unwrap();
        assert_eq!(line, Some(Line::TooLong { len: 100_000 }));
        assert!(reader.state.buf.capacity() <= 1024);
        assert_eq!(reader.next_line().await.unwrap(), None);
    }
}
