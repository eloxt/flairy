//! Self-healing markdown tail repair for streaming text.
//!
//! Port of vercel/streamdown `packages/remend` (Apache-2.0) from TypeScript to
//! Rust. Upstream: <https://github.com/vercel/streamdown>. The handler set,
//! priority order and per-handler heuristics follow the original closely enough
//! that its test suite is ported alongside; see the `tests` module below.
//!
//! Differences from upstream, all deliberate:
//! - Only the default handler set is implemented (no options struct, no custom
//!   handlers). `linkMode` is fixed to `"protocol"` and the placeholder URL is
//!   [`crate::INCOMPLETE_LINK`] rather than `streamdown:incomplete-link`.
//! - Inline KaTeX (`$…$`, priority 75) is off by default upstream and is not
//!   ported at all.
//! - The end-anchored regexes are hand-rolled as byte scans: the `regex` crate
//!   has no lookbehind, and these patterns are cheaper scanned directly.
//! - Character classes are decoded as UTF-8 `char`s rather than UTF-16 code
//!   units, so astral-plane letters count as word characters here but not
//!   upstream.

// ---------------------------------------------------------------------------
// character helpers
// ---------------------------------------------------------------------------

/// The char ending at byte offset `i`, or `None` at the start of the string.
#[inline]
fn prev_char(text: &str, i: usize) -> Option<char> {
    if i == 0 {
        None
    } else {
        text[..i].chars().next_back()
    }
}

/// The char starting at byte offset `i`, or `None` at/after the end.
#[inline]
fn char_at(text: &str, i: usize) -> Option<char> {
    if i >= text.len() {
        None
    } else {
        text[i..].chars().next()
    }
}

#[inline]
fn is_word_char(c: Option<char>) -> bool {
    matches!(c, Some(ch) if ch.is_alphanumeric() || ch == '_')
}

/// Mirrors JS `\s`, which unlike Rust also covers U+FEFF.
#[inline]
fn is_js_whitespace(c: char) -> bool {
    c.is_whitespace() || c == '\u{FEFF}'
}

#[inline]
fn is_inline_whitespace(c: Option<char>) -> bool {
    match c {
        None => true,
        Some(ch) => ch == ' ' || ch == '\t' || ch == '\n',
    }
}

/// `^[\s_~*`]*$` — content that carries no meaning worth closing a marker for.
fn is_whitespace_or_markers(s: &str) -> bool {
    s.chars()
        .all(|c| is_js_whitespace(c) || matches!(c, '_' | '~' | '*' | '`'))
}

/// `^[\s]*[-*+][\s]+$`
fn is_list_item_prefix(s: &str) -> bool {
    let cs: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < cs.len() && is_js_whitespace(cs[i]) {
        i += 1;
    }
    if i >= cs.len() || !matches!(cs[i], '-' | '*' | '+') {
        return false;
    }
    i += 1;
    let ws_start = i;
    while i < cs.len() && is_js_whitespace(cs[i]) {
        i += 1;
    }
    i > ws_start && i == cs.len()
}

/// `^\*{4,}$`
fn is_four_or_more_asterisks(s: &str) -> bool {
    s.len() >= 4 && s.bytes().all(|c| c == b'*')
}

// ---------------------------------------------------------------------------
// code-block context
// ---------------------------------------------------------------------------

/// Is `position` inside a fenced block or an open inline span? Backslash-escaped
/// backticks are skipped so `\`` never opens a span.
fn is_inside_code_block(text: &str, position: usize) -> bool {
    let b = text.as_bytes();
    let n = b.len();
    let stop = position.min(n);
    let mut in_inline = false;
    let mut in_fence = false;
    let mut i = 0;
    while i < stop {
        if b[i] == b'\\' && i + 1 < n && b[i + 1] == b'`' {
            i += 2;
            continue;
        }
        if i + 3 <= n && &b[i..i + 3] == b"```" {
            in_fence = !in_fence;
            i += 3;
            continue;
        }
        if !in_fence && b[i] == b'`' {
            in_inline = !in_inline;
        }
        i += 1;
    }
    in_inline || in_fence
}

fn is_part_of_triple_backtick(text: &str, i: usize) -> bool {
    let b = text.as_bytes();
    let n = b.len();
    let starts = i + 3 <= n && &b[i..i + 3] == b"```";
    let middle = i >= 1 && i + 2 <= n && &b[i - 1..i + 2] == b"```";
    let ends = i >= 2 && i + 1 <= n && &b[i - 2..i + 1] == b"```";
    starts || middle || ends
}

fn count_single_backticks(text: &str) -> usize {
    let b = text.as_bytes();
    let n = b.len();
    let mut count = 0;
    let mut i = 0;
    while i < n {
        if b[i] == b'\\' && i + 1 < n && b[i + 1] == b'`' {
            i += 2;
            continue;
        }
        if b[i] == b'`' && !is_part_of_triple_backtick(text, i) {
            count += 1;
        }
        i += 1;
    }
    count
}

/// Only true for spans that have *both* delimiters — an unterminated span is
/// still streaming, so emphasis inside it may legitimately be completed.
fn is_within_complete_inline_code(text: &str, position: usize) -> bool {
    let b = text.as_bytes();
    let n = b.len();
    let mut in_inline = false;
    let mut in_fence = false;
    let mut span_start = 0usize;
    let mut i = 0;
    while i < n {
        if b[i] == b'\\' && i + 1 < n && b[i + 1] == b'`' {
            i += 2;
            continue;
        }
        if i + 3 <= n && &b[i..i + 3] == b"```" {
            in_fence = !in_fence;
            i += 3;
            continue;
        }
        if !in_fence && b[i] == b'`' {
            if in_inline {
                if span_start < position && position < i {
                    return true;
                }
                in_inline = false;
            } else {
                in_inline = true;
                span_start = i;
            }
        }
        i += 1;
    }
    false
}

/// Non-overlapping count of "```" (mirrors `text.match(/```/g)`).
fn count_triple_backticks(text: &str) -> usize {
    let b = text.as_bytes();
    let mut i = 0;
    let mut count = 0;
    while i + 3 <= b.len() {
        if &b[i..i + 3] == b"```" {
            count += 1;
            i += 3;
        } else {
            i += 1;
        }
    }
    count
}

/// Non-overlapping count of a doubled marker (`/__/g`, `/~~/g`).
fn count_double_marker(text: &str, marker: u8) -> usize {
    let b = text.as_bytes();
    let mut i = 0;
    let mut count = 0;
    while i + 2 <= b.len() {
        if b[i] == marker && b[i + 1] == marker {
            count += 1;
            i += 2;
        } else {
            i += 1;
        }
    }
    count
}

// ---------------------------------------------------------------------------
// other context predicates
// ---------------------------------------------------------------------------

fn is_within_math_block(text: &str, position: usize) -> bool {
    let b = text.as_bytes();
    let n = b.len();
    let stop = position.min(n);
    let mut in_inline = false;
    let mut in_block = false;
    let mut i = 0;
    while i < stop {
        if b[i] == b'\\' && i + 1 < n && b[i + 1] == b'$' {
            i += 2;
            continue;
        }
        if b[i] == b'$' {
            if i + 1 < n && b[i + 1] == b'$' {
                in_block = !in_block;
                in_inline = false;
                i += 2;
                continue;
            }
            if !in_block {
                in_inline = !in_inline;
            }
        }
        i += 1;
    }
    in_inline || in_block
}

fn is_before_closing_paren(text: &str, position: usize) -> bool {
    for &c in &text.as_bytes()[position.min(text.len())..] {
        if c == b')' {
            return true;
        }
        if c == b'\n' {
            return false;
        }
    }
    false
}

/// Inside the `(url)` half of a `[text](url)` / `![alt](url)`.
fn is_within_link_or_image_url(text: &str, position: usize) -> bool {
    let b = text.as_bytes();
    let mut i = position.min(b.len());
    while i > 0 {
        i -= 1;
        match b[i] {
            b')' | b'\n' => return false,
            b'(' => {
                if i > 0 && b[i - 1] == b']' {
                    return is_before_closing_paren(text, position);
                }
                return false;
            }
            _ => {}
        }
    }
    false
}

/// Inside `<…>` — e.g. the underscore in `<a target="_blank">`.
fn is_within_html_tag(text: &str, position: usize) -> bool {
    let b = text.as_bytes();
    let n = b.len();
    let mut i = position.min(n);
    while i > 0 {
        i -= 1;
        match b[i] {
            b'>' | b'\n' => return false,
            b'<' => {
                let next = if i + 1 < n { b[i + 1] } else { 0 };
                return next.is_ascii_alphabetic() || next == b'/';
            }
            _ => {}
        }
    }
    false
}

/// A run of 3+ markers alone on its line (spaces/tabs between them are allowed).
fn is_horizontal_rule(text: &str, marker_index: usize, marker: u8) -> bool {
    let b = text.as_bytes();
    let start = marker_index.min(b.len());
    let mut line_start = 0;
    let mut i = start;
    while i > 0 {
        i -= 1;
        if b[i] == b'\n' {
            line_start = i + 1;
            break;
        }
    }
    let mut line_end = b.len();
    for (j, &c) in b.iter().enumerate().skip(start) {
        if c == b'\n' {
            line_end = j;
            break;
        }
    }
    let marker = marker as char;
    let mut marker_count = 0;
    for ch in text[line_start..line_end].chars() {
        if ch == marker {
            marker_count += 1;
        } else if ch != ' ' && ch != '\t' {
            return false;
        }
    }
    marker_count >= 3
}

fn find_matching_opening_bracket(text: &str, close_index: usize) -> Option<usize> {
    let b = text.as_bytes();
    let mut depth = 1i32;
    let mut i = close_index.min(b.len());
    while i > 0 {
        i -= 1;
        if b[i] == b']' {
            depth += 1;
        } else if b[i] == b'[' {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

fn find_matching_closing_bracket(text: &str, open_index: usize) -> Option<usize> {
    let b = text.as_bytes();
    let mut depth = 1i32;
    for (i, &c) in b.iter().enumerate().skip(open_index + 1) {
        if c == b'[' {
            depth += 1;
        } else if c == b']' {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// end-anchored "pattern" matchers
// ---------------------------------------------------------------------------

/// Leftmost start of `/(MARKER)([^FORBIDDEN]*?)$/`.
fn match_marker_no_forbidden(text: &str, marker: &str, forbidden: u8) -> Option<usize> {
    let b = text.as_bytes();
    let m = marker.as_bytes();
    let n = b.len();
    if n < m.len() {
        return None;
    }
    let last_forbidden = b.iter().rposition(|&c| c == forbidden);
    for start in 0..=(n - m.len()) {
        if &b[start..start + m.len()] != m {
            continue;
        }
        let rest = start + m.len();
        if last_forbidden.map_or(true, |lf| lf < rest) {
            return Some(start);
        }
    }
    None
}

/// Leftmost start of `/(\*\*)([^*]*\*?)$/` — the optional trailing `*` lets a
/// half-streamed closing marker (`**bold*`) still match.
fn match_bold_pattern(text: &str) -> Option<usize> {
    let b = text.as_bytes();
    let n = b.len();
    if n < 2 {
        return None;
    }
    let last_star = b.iter().rposition(|&c| c == b'*');
    let second_last_star = last_star.and_then(|ls| b[..ls].iter().rposition(|&c| c == b'*'));
    let rest_ok = |rest: usize| match last_star {
        None => true,
        Some(ls) if ls < rest => true,
        Some(ls) if ls == n - 1 => second_last_star.map_or(true, |sl| sl < rest),
        _ => false,
    };
    for start in 0..=(n - 2) {
        if b[start] == b'*' && b[start + 1] == b'*' && rest_ok(start + 2) {
            return Some(start);
        }
    }
    None
}

/// Leftmost start of `/(MM)([^M]+)M$/` — a doubled marker whose closing pair has
/// only streamed its first character (`__text_`, `~~text~`).
fn match_half_complete(text: &str, marker: u8) -> Option<usize> {
    let b = text.as_bytes();
    let n = b.len();
    if n < 4 || b[n - 1] != marker {
        return None;
    }
    let last_inner = b[..n - 1].iter().rposition(|&c| c == marker);
    for start in 0..=(n - 4) {
        if b[start] == marker
            && b[start + 1] == marker
            && start + 2 < n - 1
            && last_inner.map_or(true, |li| li < start + 2)
        {
            return Some(start);
        }
    }
    None
}

/// ``^```[^`\n]*```?$`` — a whole-string inline triple-backtick span.
fn matches_inline_triple_backtick(text: &str) -> bool {
    let b = text.as_bytes();
    let n = b.len();
    if n < 5 || &b[..3] != b"```" {
        return false;
    }
    let Some(offset) = b[3..].iter().position(|&c| c == b'`' || c == b'\n') else {
        return false;
    };
    let k = 3 + offset;
    b[k] == b'`' && (&b[k..] == b"``" || &b[k..] == b"```")
}

// ---------------------------------------------------------------------------
// handler: singleTilde (priority 0)
// ---------------------------------------------------------------------------

/// `20~25` → `20\~25`, so remark-gfm doesn't read the tilde as strikethrough.
fn handle_single_tilde_escape(text: &str) -> String {
    if !text.contains('~') {
        return text.to_string();
    }
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for i in 0..b.len() {
        if b[i] != b'~' || b.get(i + 1) == Some(&b'~') {
            continue;
        }
        if !is_word_char(prev_char(text, i)) || !is_word_char(char_at(text, i + 1)) {
            continue;
        }
        if is_inside_code_block(text, i) {
            continue;
        }
        out.push_str(&text[last..i]);
        out.push_str("\\~");
        last = i + 1;
    }
    out.push_str(&text[last..]);
    out
}

// ---------------------------------------------------------------------------
// handler: comparisonOperators (priority 5)
// ---------------------------------------------------------------------------

/// Byte offset of a `>` that reads as "greater than" rather than a blockquote,
/// for the list item starting at `line_start`.
fn match_list_comparison(b: &[u8], line_start: usize) -> Option<usize> {
    let n = b.len();
    let mut i = line_start;
    while i < n && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    if i < n && matches!(b[i], b'-' | b'*' | b'+') {
        i += 1;
    } else {
        let digits_start = i;
        while i < n && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == digits_start || i >= n || !matches!(b[i], b'.' | b')') {
            return None;
        }
        i += 1;
    }
    let spaces_start = i;
    while i < n && b[i] == b' ' {
        i += 1;
    }
    if i == spaces_start || i >= n || b[i] != b'>' {
        return None;
    }
    let gt = i;
    i += 1;
    if i < n && b[i] == b'=' {
        i += 1;
    }
    while i < n && b[i].is_ascii_whitespace() {
        i += 1;
    }
    if i < n && b[i] == b'$' {
        i += 1;
    }
    if i < n && b[i].is_ascii_digit() {
        Some(gt)
    } else {
        None
    }
}

fn handle_comparison_operators(text: &str) -> String {
    if !text.contains('>') {
        return text.to_string();
    }
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len() + 8);
    let mut last = 0;
    let mut line_start = 0;
    loop {
        if let Some(gt) = match_list_comparison(b, line_start) {
            if !is_inside_code_block(text, line_start) {
                out.push_str(&text[last..gt]);
                out.push('\\');
                last = gt;
            }
        }
        match b[line_start..].iter().position(|&c| c == b'\n') {
            Some(offset) => line_start += offset + 1,
            None => break,
        }
        if line_start >= b.len() {
            break;
        }
    }
    out.push_str(&text[last..]);
    out
}

// ---------------------------------------------------------------------------
// handler: htmlTags (priority 10)
// ---------------------------------------------------------------------------

/// Drops a tag whose `>` has not arrived yet: `text <custom` → `text`.
fn handle_incomplete_html_tag(text: &str) -> String {
    let b = text.as_bytes();
    let n = b.len();
    // `[^>]*$` means the match can only start after the last `>`.
    let start = b.iter().rposition(|&c| c == b'>').map_or(0, |g| g + 1);
    for i in start..n {
        if b[i] != b'<' {
            continue;
        }
        let next = if i + 1 < n { b[i + 1] } else { 0 };
        if !(next.is_ascii_alphabetic() || next == b'/') {
            continue;
        }
        if is_inside_code_block(text, i) {
            return text.to_string();
        }
        return text[..i].trim_end().to_string();
    }
    text.to_string()
}

// ---------------------------------------------------------------------------
// handler: setextHeadings (priority 15)
// ---------------------------------------------------------------------------

/// `^[\s]*M{1,2}[\s]+$`
fn matches_marker_with_trailing_space(s: &str, marker: char) -> bool {
    let cs: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < cs.len() && is_js_whitespace(cs[i]) {
        i += 1;
    }
    let markers_start = i;
    while i < cs.len() && cs[i] == marker {
        i += 1;
    }
    let count = i - markers_start;
    if count == 0 || count > 2 {
        return false;
    }
    let ws_start = i;
    while i < cs.len() && is_js_whitespace(cs[i]) {
        i += 1;
    }
    i > ws_start && i == cs.len()
}

fn is_one_or_two_markers(s: &str, marker: u8) -> bool {
    (s.len() == 1 || s.len() == 2) && s.bytes().all(|c| c == marker)
}

/// A lone `-` or `=` under a line of text is a setext underline, which would
/// turn the paragraph above into a heading mid-stream. A zero-width space breaks
/// the pattern without being visible.
fn handle_incomplete_setext_heading(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let Some(last_newline) = text.rfind('\n') else {
        return text.to_string();
    };
    let last_line = &text[last_newline + 1..];
    let previous_content = &text[..last_newline];
    let trimmed = last_line.trim();

    for marker in [b'-', b'='] {
        if !is_one_or_two_markers(trimmed, marker) {
            continue;
        }
        if matches_marker_with_trailing_space(last_line, marker as char) {
            continue;
        }
        let previous_line = previous_content.rsplit('\n').next().unwrap_or("");
        if !previous_line.trim().is_empty() {
            return format!("{text}\u{200B}");
        }
    }
    text.to_string()
}

// ---------------------------------------------------------------------------
// handler: links / images (priority 20)
// ---------------------------------------------------------------------------

fn incomplete_link_tail() -> String {
    format!("]({})", crate::INCOMPLETE_LINK)
}

/// `[text](partial-url` — the destination is still streaming.
fn handle_incomplete_url(text: &str, last_paren_index: usize) -> Option<String> {
    if text[last_paren_index + 2..].contains(')') {
        return None;
    }
    let open = find_matching_opening_bracket(text, last_paren_index)?;
    if is_inside_code_block(text, open) {
        return None;
    }
    let b = text.as_bytes();
    let is_image = open > 0 && b[open - 1] == b'!';
    let start = if is_image { open - 1 } else { open };
    let before = &text[..start];
    if is_image {
        // Images can't render a skeleton, so drop them until the URL lands.
        return Some(before.to_string());
    }
    let link_text = &text[open + 1..last_paren_index];
    Some(format!("{before}[{link_text}{}", incomplete_link_tail()))
}

/// `[partial-text` — the link label has no closing bracket yet.
fn handle_incomplete_text(text: &str, i: usize) -> Option<String> {
    let b = text.as_bytes();
    let is_image = i > 0 && b[i - 1] == b'!';
    let open_index = if is_image { i - 1 } else { i };

    let unmatched = !text[i + 1..].contains(']') || find_matching_closing_bracket(text, i).is_none();
    if !unmatched {
        return None;
    }
    if is_image {
        return Some(text[..open_index].to_string());
    }
    Some(format!("{text}{}", incomplete_link_tail()))
}

fn handle_incomplete_links_and_images(text: &str) -> String {
    if let Some(last_paren_index) = text.rfind("](") {
        if !is_inside_code_block(text, last_paren_index) {
            if let Some(result) = handle_incomplete_url(text, last_paren_index) {
                return result;
            }
        }
    }
    let b = text.as_bytes();
    let mut i = b.len();
    while i > 0 {
        i -= 1;
        if b[i] == b'[' && !is_inside_code_block(text, i) {
            if let Some(result) = handle_incomplete_text(text, i) {
                return result;
            }
        }
    }
    text.to_string()
}

// ---------------------------------------------------------------------------
// emphasis counting
// ---------------------------------------------------------------------------

/// Runs `f` over every byte outside fenced code blocks; `f` returns how far to
/// advance.
fn scan_outside_fences(text: &str, mut f: impl FnMut(usize) -> usize) {
    let b = text.as_bytes();
    let n = b.len();
    let mut in_fence = false;
    let mut i = 0;
    while i < n {
        if b[i] == b'`' && i + 2 < n && b[i + 1] == b'`' && b[i + 2] == b'`' {
            in_fence = !in_fence;
            i += 3;
            continue;
        }
        if in_fence {
            i += 1;
            continue;
        }
        i += f(i).max(1);
    }
}

fn count_double_marker_outside_fences(text: &str, marker: u8) -> usize {
    let b = text.as_bytes();
    let n = b.len();
    let mut count = 0;
    scan_outside_fences(text, |i| {
        if b[i] == marker && i + 1 < n && b[i + 1] == marker {
            count += 1;
            2
        } else {
            1
        }
    });
    count
}

fn should_skip_asterisk(text: &str, index: usize, prev: Option<char>, next: Option<char>) -> bool {
    if prev == Some('\\') {
        return true;
    }
    if text.contains('$') && is_within_math_block(text, index) {
        return true;
    }
    // The first `*` of a `***` run can close a single-asterisk italic
    // (`**bold and *italic***`), so it still counts; the first `*` of a plain
    // `**` does not.
    if prev != Some('*') && next == Some('*') {
        let next_next = if index + 2 < text.len() {
            char_at(text, index + 2)
        } else {
            None
        };
        return next_next != Some('*');
    }
    if prev == Some('*') {
        return true;
    }
    if is_word_char(prev) && is_word_char(next) {
        return true;
    }
    is_inline_whitespace(prev) && is_inline_whitespace(next)
}

fn count_single_asterisks(text: &str) -> usize {
    let b = text.as_bytes();
    let n = b.len();
    let mut count = 0;
    scan_outside_fences(text, |i| {
        if b[i] == b'*' {
            let prev = prev_char(text, i);
            let next = if i + 1 < n { char_at(text, i + 1) } else { None };
            if !should_skip_asterisk(text, i, prev, next) {
                count += 1;
            }
        }
        1
    });
    count
}

fn should_skip_underscore(text: &str, index: usize, prev: Option<char>, next: Option<char>) -> bool {
    if prev == Some('\\') {
        return true;
    }
    if text.contains('$') && is_within_math_block(text, index) {
        return true;
    }
    if is_within_link_or_image_url(text, index) || is_within_html_tag(text, index) {
        return true;
    }
    if prev == Some('_') || next == Some('_') {
        return true;
    }
    is_word_char(prev) && is_word_char(next)
}

fn count_single_underscores(text: &str) -> usize {
    let b = text.as_bytes();
    let n = b.len();
    let mut count = 0;
    scan_outside_fences(text, |i| {
        if b[i] == b'_' {
            let prev = prev_char(text, i);
            let next = if i + 1 < n { char_at(text, i + 1) } else { None };
            if !should_skip_underscore(text, i, prev, next) {
                count += 1;
            }
        }
        1
    });
    count
}

fn count_triple_asterisks(text: &str) -> usize {
    let b = text.as_bytes();
    let n = b.len();
    let mut count = 0;
    let mut consecutive = 0;
    let mut in_fence = false;
    let mut i = 0;
    while i < n {
        if b[i] == b'`' && i + 2 < n && b[i + 1] == b'`' && b[i + 2] == b'`' {
            count += consecutive / 3;
            consecutive = 0;
            in_fence = !in_fence;
            i += 3;
            continue;
        }
        if in_fence {
            i += 1;
            continue;
        }
        if b[i] == b'*' {
            consecutive += 1;
        } else {
            count += consecutive / 3;
            consecutive = 0;
        }
        i += 1;
    }
    count + consecutive / 3
}

fn find_first_single_asterisk_index(text: &str) -> Option<usize> {
    let b = text.as_bytes();
    let n = b.len();
    let mut found = None;
    scan_outside_fences(text, |i| {
        if found.is_none()
            && b[i] == b'*'
            && (i == 0 || (b[i - 1] != b'*' && b[i - 1] != b'\\'))
            && (i + 1 >= n || b[i + 1] != b'*')
            && !is_within_math_block(text, i)
        {
            let prev = prev_char(text, i);
            let next = if i + 1 < n { char_at(text, i + 1) } else { None };
            let flanked_by_space = is_inline_whitespace(prev) && is_inline_whitespace(next);
            if !flanked_by_space && !(is_word_char(prev) && is_word_char(next)) {
                found = Some(i);
            }
        }
        1
    });
    found
}

fn find_first_single_underscore_index(text: &str) -> Option<usize> {
    let b = text.as_bytes();
    let n = b.len();
    let mut found = None;
    scan_outside_fences(text, |i| {
        if found.is_none()
            && b[i] == b'_'
            && (i == 0 || (b[i - 1] != b'_' && b[i - 1] != b'\\'))
            && (i + 1 >= n || b[i + 1] != b'_')
            && !is_within_math_block(text, i)
            && !is_within_link_or_image_url(text, i)
        {
            let prev = prev_char(text, i);
            let next = if i + 1 < n { char_at(text, i + 1) } else { None };
            if !(is_word_char(prev) && is_word_char(next)) {
                found = Some(i);
            }
        }
        1
    });
    found
}

// ---------------------------------------------------------------------------
// handlers: emphasis (priorities 30, 35, 40, 41, 42)
// ---------------------------------------------------------------------------

fn in_any_code_span(text: &str, index: usize) -> bool {
    is_inside_code_block(text, index) || is_within_complete_inline_code(text, index)
}

fn should_skip_emphasis_completion(
    text: &str,
    content: &str,
    marker_index: usize,
    rule_marker: u8,
) -> bool {
    if content.is_empty() || is_whitespace_or_markers(content) {
        return true;
    }
    let line_start = text[..marker_index].rfind('\n').map_or(0, |i| i + 1);
    if is_list_item_prefix(&text[line_start..marker_index]) && content.contains('\n') {
        return true;
    }
    is_horizontal_rule(text, marker_index, rule_marker)
}

fn handle_incomplete_bold_italic(text: &str) -> String {
    if is_four_or_more_asterisks(text) {
        return text.to_string();
    }
    let Some(start) = match_marker_no_forbidden(text, "***", b'*') else {
        return text.to_string();
    };
    let content = &text[start + 3..];
    let marker_index = text.rfind("***").unwrap_or(start);

    if content.is_empty()
        || is_whitespace_or_markers(content)
        || in_any_code_span(text, marker_index)
        || is_horizontal_rule(text, marker_index, b'*')
    {
        return text.to_string();
    }
    if count_triple_asterisks(text) % 2 == 1 {
        // Balanced `**` and `*` means the `***` is two overlapping closers
        // (`**bold and *italic***`), not an unclosed bold-italic.
        let balanced = count_double_marker_outside_fences(text, b'*') % 2 == 0
            && count_single_asterisks(text) % 2 == 0;
        if balanced {
            return text.to_string();
        }
        return format!("{text}***");
    }
    text.to_string()
}

fn handle_incomplete_bold(text: &str) -> String {
    let Some(start) = match_bold_pattern(text) else {
        return text.to_string();
    };
    let content = &text[start + 2..];
    let marker_index = text.rfind("**").unwrap_or(start);

    if in_any_code_span(text, marker_index)
        || should_skip_emphasis_completion(text, content, marker_index, b'*')
    {
        return text.to_string();
    }
    if count_double_marker_outside_fences(text, b'*') % 2 == 1 {
        // A trailing `*` is the first half of the closing `**` arriving.
        if content.ends_with('*') {
            return format!("{text}*");
        }
        return format!("{text}**");
    }
    text.to_string()
}

fn handle_incomplete_double_underscore_italic(text: &str) -> String {
    let Some(start) = match_marker_no_forbidden(text, "__", b'_') else {
        // `__content_` — the closing pair has only streamed its first char.
        if match_half_complete(text, b'_').is_some() {
            let marker_index = text.rfind("__").unwrap_or(0);
            if !in_any_code_span(text, marker_index)
                && count_double_marker_outside_fences(text, b'_') % 2 == 1
            {
                return format!("{text}_");
            }
        }
        return text.to_string();
    };
    let content = &text[start + 2..];
    let marker_index = text.rfind("__").unwrap_or(start);

    if in_any_code_span(text, marker_index)
        || should_skip_emphasis_completion(text, content, marker_index, b'_')
    {
        return text.to_string();
    }
    if count_double_marker_outside_fences(text, b'_') % 2 == 1 {
        return format!("{text}__");
    }
    text.to_string()
}

fn handle_incomplete_single_asterisk_italic(text: &str) -> String {
    if match_marker_no_forbidden(text, "*", b'*').is_none() {
        return text.to_string();
    }
    let Some(first) = find_first_single_asterisk_index(text) else {
        return text.to_string();
    };
    if in_any_code_span(text, first) {
        return text.to_string();
    }
    let content = &text[first + 1..];
    if content.is_empty() || is_whitespace_or_markers(content) {
        return text.to_string();
    }
    if count_single_asterisks(text) % 2 == 1 {
        return format!("{text}*");
    }
    text.to_string()
}

/// Trailing newlines belong after the closer, not before it.
fn insert_closing_underscore(text: &str) -> String {
    let end = text.trim_end_matches('\n').len();
    if end < text.len() {
        format!("{}_{}", &text[..end], &text[end..])
    } else {
        format!("{text}_")
    }
}

/// `**_text` closes as `**_text_**`: when `**` opened before `_`, the `_` has to
/// close inside the `**` that the bold handler just appended.
fn handle_trailing_asterisks_for_underscore(text: &str) -> Option<String> {
    let without = text.strip_suffix("**")?;
    if count_double_marker_outside_fences(without, b'*') % 2 != 1 {
        return None;
    }
    let first_double = without.find("**")?;
    let underscore = find_first_single_underscore_index(without)?;
    if first_double < underscore {
        Some(format!("{without}_**"))
    } else {
        None
    }
}

fn handle_incomplete_single_underscore_italic(text: &str) -> String {
    if match_marker_no_forbidden(text, "_", b'_').is_none() {
        return text.to_string();
    }
    let Some(first) = find_first_single_underscore_index(text) else {
        return text.to_string();
    };
    let content = &text[first + 1..];
    if content.is_empty() || is_whitespace_or_markers(content) {
        return text.to_string();
    }
    if in_any_code_span(text, first) {
        return text.to_string();
    }
    if count_single_underscores(text) % 2 == 1 {
        return handle_trailing_asterisks_for_underscore(text)
            .unwrap_or_else(|| insert_closing_underscore(text));
    }
    text.to_string()
}

// ---------------------------------------------------------------------------
// handler: inlineCode (priority 50)
// ---------------------------------------------------------------------------

fn handle_incomplete_inline_code(text: &str) -> String {
    if matches_inline_triple_backtick(text) && !text.contains('\n') {
        if text.ends_with("``") && !text.ends_with("```") {
            return format!("{text}`");
        }
        return text.to_string();
    }
    let Some(start) = match_marker_no_forbidden(text, "`", b'`') else {
        return text.to_string();
    };
    // An odd number of fences means we're inside an open block; leave it alone.
    if count_triple_backticks(text) % 2 == 1 {
        return text.to_string();
    }
    let content = &text[start + 1..];
    if content.is_empty() || is_whitespace_or_markers(content) {
        return text.to_string();
    }
    if count_single_backticks(text) % 2 == 1 {
        return format!("{text}`");
    }
    text.to_string()
}

// ---------------------------------------------------------------------------
// handler: strikethrough (priority 60)
// ---------------------------------------------------------------------------

fn handle_incomplete_strikethrough(text: &str) -> String {
    if let Some(start) = match_marker_no_forbidden(text, "~~", b'~') {
        let content = &text[start + 2..];
        if content.is_empty() || is_whitespace_or_markers(content) {
            return text.to_string();
        }
        let marker_index = text.rfind("~~").unwrap_or(start);
        if in_any_code_span(text, marker_index) {
            return text.to_string();
        }
        if count_double_marker(text, b'~') % 2 == 1 {
            return format!("{text}~~");
        }
    } else if match_half_complete(text, b'~').is_some() {
        let marker_index = text.rfind("~~").unwrap_or(0);
        if in_any_code_span(text, marker_index) {
            return text.to_string();
        }
        if count_double_marker(text, b'~') % 2 == 1 {
            return format!("{text}~");
        }
    }
    text.to_string()
}

// ---------------------------------------------------------------------------
// handler: block katex (priority 70)
// ---------------------------------------------------------------------------

fn count_dollar_pairs(text: &str) -> usize {
    let b = text.as_bytes();
    let n = b.len();
    let mut pairs = 0;
    let mut in_inline_code = false;
    let mut i = 0;
    while i + 1 < n {
        if b[i] == b'`' && !is_part_of_triple_backtick(text, i) {
            in_inline_code = !in_inline_code;
        }
        if !in_inline_code && b[i] == b'$' && b[i + 1] == b'$' {
            pairs += 1;
            i += 2;
            continue;
        }
        i += 1;
    }
    pairs
}

fn handle_incomplete_block_katex(text: &str) -> String {
    if count_dollar_pairs(text) % 2 == 0 {
        return text.to_string();
    }
    // A lone trailing `$` is the closing `$$` half-streamed.
    if text.ends_with('$') && !text.ends_with("$$") {
        return format!("{text}$");
    }
    let multiline = text
        .find("$$")
        .map_or(false, |first| text[first..].contains('\n'));
    if multiline && !text.ends_with('\n') {
        return format!("{text}\n$$");
    }
    format!("{text}$$")
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/// Repairs markdown that was cut mid-token by a streaming boundary, so the
/// partial tail renders as the author intended instead of as literal markers.
///
/// Handlers run in a fixed priority order and each one only appends to, or
/// truncates, the tail. The links handler short-circuits the rest of the
/// pipeline when it emits an [`crate::INCOMPLETE_LINK`] placeholder, since the
/// markers inside a link label are the label's problem, not ours.
pub fn remend(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }

    // A single trailing space is mid-word streaming noise; two are a hard break.
    let mut result = if text.ends_with(' ') && !text.ends_with("  ") {
        text[..text.len() - 1].to_string()
    } else {
        text.to_string()
    };

    result = handle_single_tilde_escape(&result);
    result = handle_comparison_operators(&result);
    result = handle_incomplete_html_tag(&result);
    result = handle_incomplete_setext_heading(&result);

    result = handle_incomplete_links_and_images(&result);
    if result.ends_with(&incomplete_link_tail()) {
        return result;
    }

    result = handle_incomplete_bold_italic(&result);
    result = handle_incomplete_bold(&result);
    result = handle_incomplete_double_underscore_italic(&result);
    result = handle_incomplete_single_asterisk_italic(&result);
    result = handle_incomplete_single_underscore_italic(&result);
    result = handle_incomplete_inline_code(&result);
    result = handle_incomplete_strikethrough(&result);
    handle_incomplete_block_katex(&result)
}

// ---------------------------------------------------------------------------
// tests (ported from vercel/streamdown packages/remend/__tests__)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// The upstream fixtures say `streamdown:incomplete-link`; ours says
    /// `flairy:incomplete-link`.
    fn link(text: &str) -> String {
        format!("{text}]({})", crate::INCOMPLETE_LINK)
    }

    #[track_caller]
    fn check(input: &str, expected: &str) {
        assert_eq!(remend(input), expected, "input: {input:?}");
    }

    #[track_caller]
    fn unchanged(input: &str) {
        assert_eq!(remend(input), input, "input: {input:?}");
    }

    // --- basic input ------------------------------------------------------

    #[test]
    fn empty_and_plain_text() {
        check("", "");
        unchanged("This is plain text without any markdown");
    }

    #[test]
    fn trailing_space_handling() {
        check("text ", "text");
        unchanged("text  ");
        check(" ", "");
        check("**bold ", "**bold**");
    }

    // --- bold -------------------------------------------------------------

    #[test]
    fn completes_bold() {
        check("Text with **bold", "Text with **bold**");
        check("**incomplete", "**incomplete**");
        check("**first** and **second", "**first** and **second**");
        check("Here is some **bold tex", "Here is some **bold tex**");
        unchanged("Text with **bold text**");
        unchanged("**bold1** and **bold2**");
    }

    #[test]
    fn completes_half_streamed_bold_closer() {
        check("**xxx*", "**xxx**");
        check("**bold text*", "**bold text**");
        check("Text with **bold*", "Text with **bold**");
        check("This is **bold text*", "This is **bold text**");
    }

    // --- bold-italic ------------------------------------------------------

    #[test]
    fn completes_bold_italic() {
        check("Text with ***bold-italic", "Text with ***bold-italic***");
        check("***incomplete", "***incomplete***");
        check("***first*** and ***second", "***first*** and ***second***");
        check("*italic* **bold** ***both", "*italic* **bold** ***both***");
        unchanged("Text with ***bold and italic text***");
        unchanged("***first*** and ***second***");
    }

    #[test]
    fn bold_italic_with_trailing_asterisk_runs() {
        for input in [
            "text ***",
            "text ****",
            "text *****",
            "text ******",
            "text***",
            "word****",
            "end******",
            "***start***end***",
            "***text***",
            "***word text***",
        ] {
            unchanged(input);
        }
    }

    #[test]
    fn does_not_close_overlapping_bold_and_italic() {
        unchanged("Combined **bold and *italic*** text");
        unchanged("**bold and *italic*** more text");
        unchanged("test **bold and *italic*** end");
        unchanged("- Combined **bold and *italic*** text");
        unchanged("**bold and *bold-italic***");
    }

    #[test]
    fn bold_italic_streaming_chunks() {
        check("This is", "This is");
        check("This is ***very", "This is ***very***");
        check("This is ***very important", "This is ***very important***");
        unchanged("This is ***very important***");
        unchanged("This is ***very important*** to know");
    }

    // --- italic -----------------------------------------------------------

    #[test]
    fn completes_double_underscore_italic() {
        check("Text with __italic", "Text with __italic__");
        check("__incomplete", "__incomplete__");
        check("__first__ and __second", "__first__ and __second__");
        unchanged("Text with __italic text__");
    }

    #[test]
    fn completes_half_streamed_double_underscore_closer() {
        check("__xxx_", "__xxx__");
        check("__content_", "__content__");
        check("Text with __bold_", "Text with __bold__");
        unchanged("__a__ __b__content_");
    }

    #[test]
    fn completes_single_asterisk_italic() {
        check("Text with *italic", "Text with *italic*");
        check("*incomplete", "*incomplete*");
        check("**bold** and *italic", "**bold** and *italic*");
        unchanged("Text with *italic text*");
        unchanged("*word* and more text");
    }

    #[test]
    fn word_internal_asterisks_are_not_emphasis() {
        unchanged("234234*123");
        unchanged("hello*world");
        unchanged("test*123*test");
        unchanged("abc*123");
        check(
            "*italic with some*var*name inside",
            "*italic with some*var*name inside*",
        );
        check(
            "test*var and *incomplete italic",
            "test*var and *incomplete italic*",
        );
    }

    #[test]
    fn escaped_asterisks_are_skipped() {
        check(
            "\\*escaped asterisk and *italic",
            "\\*escaped asterisk and *italic*",
        );
        check("*start \\* middle \\* end", "*start \\* middle \\* end*");
        unchanged("\\*not italic");
        unchanged("\\\\*actually italic");
        check("\\**not bold", "\\**not bold**");
        check(
            "\\*escaped\\* but *real italic",
            "\\*escaped\\* but *real italic*",
        );
    }

    #[test]
    fn space_flanked_asterisks_are_not_emphasis() {
        unchanged("3 + 2 - 5 * 0 = ?");
        unchanged("5 * 0");
        unchanged("2 * 3 * 4");
        check("5 * 0 and *italic", "5 * 0 and *italic*");
    }

    #[test]
    fn completes_single_underscore_italic() {
        check("Text with _italic", "Text with _italic_");
        check("__bold__ and _italic", "__bold__ and _italic_");
        unchanged("Text with _italic text_");
        unchanged("some_variable_name");
        unchanged("café_price");
        unchanged("naïve_approach");
        check("_start with underscore", "_start with underscore_");
    }

    #[test]
    fn escaped_underscores_are_skipped() {
        unchanged("Text with \\_escaped underscore");
        unchanged("some\\_text_with_underscores");
        check(
            "\\_escaped\\_ and _unescaped",
            "\\_escaped\\_ and _unescaped_",
        );
        unchanged("\\_fully\\_escaped\\_");
        unchanged("\\_escaped\\_ _complete_ pair");
    }

    #[test]
    fn underscore_closes_before_trailing_newlines() {
        check("Text with _italic\n", "Text with _italic_\n");
        check("_incomplete\n\n", "_incomplete_\n\n");
    }

    // --- inline code ------------------------------------------------------

    #[test]
    fn completes_inline_code() {
        check("Text with `code", "Text with `code`");
        check("`incomplete", "`incomplete`");
        unchanged("Text with `inline code`");
        unchanged("`code1` and `code2`");
        check("```\nblock\n```\n`inline", "```\nblock\n```\n`inline`");
    }

    #[test]
    fn inline_triple_backticks() {
        unchanged("```python print(\"Hello, Sunnyvale!\")```");
        check(
            "```python print(\"Hello, Sunnyvale!\")``",
            "```python print(\"Hello, Sunnyvale!\")```",
        );
        unchanged("``````");
        unchanged("text``````");
        unchanged("```code```");
        unchanged("```code```\n");
    }

    #[test]
    fn escaped_backticks_are_not_delimiters() {
        check("\\`not code\\` **bold", "\\`not code\\` **bold**");
        check("\\` *italic", "\\` *italic*");
    }

    #[test]
    fn emphasis_inside_inline_code_is_left_alone() {
        unchanged("`**bold`");
        unchanged("`*italic`");
        unchanged("`~~strikethrough`");
        check("`code` **bold", "`code` **bold**");
    }

    // --- strikethrough ----------------------------------------------------

    #[test]
    fn completes_strikethrough() {
        check("Text with ~~strike", "Text with ~~strike~~");
        check("~~incomplete", "~~incomplete~~");
        check("~~first~~ and ~~second", "~~first~~ and ~~second~~");
        unchanged("Text with ~~strikethrough text~~");
        unchanged("~~strike1~~ and ~~strike2~~");
    }

    #[test]
    fn completes_half_streamed_strikethrough_closer() {
        check("~~xxx~", "~~xxx~~");
        check("~~strike text~", "~~strike text~~");
        check("This is ~~strikethrough~", "This is ~~strikethrough~~");
        unchanged("a~~b~~text");
        unchanged("a~~b~~c~");
    }

    // --- single tilde -----------------------------------------------------

    #[test]
    fn escapes_single_tilde_between_word_chars() {
        check("20~25°C", "20\\~25°C");
        check("20~25°C。20~25°C", "20\\~25°C。20\\~25°C");
        check("foo~bar", "foo\\~bar");
        check("20~25 and ~~strike", "20\\~25 and ~~strike~~");
    }

    #[test]
    fn does_not_escape_tilde_elsewhere() {
        unchanged("~~strikethrough~~");
        unchanged("~hello");
        unchanged("hello~");
        unchanged("hello ~ world");
        unchanged("```\n20~25\n```");
        unchanged("`20~25`");
    }

    // --- comparison operators --------------------------------------------

    #[test]
    fn escapes_comparison_operators_in_list_items() {
        check("- > 25: rich", "- \\> 25: rich");
        check("* > 25: rich", "* \\> 25: rich");
        check("+ > 25: rich", "+ \\> 25: rich");
        check("1. > 25: rich", "1. \\> 25: rich");
        check("2) > 10: high", "2) \\> 10: high");
        check("  - > 25: rich", "  - \\> 25: rich");
        check("- >= 10: high", "- \\>= 10: high");
        check("- > $100: expensive", "- \\> $100: expensive");
        check("- >25: rich", "- \\>25: rich");
        check("- > 25: **bold", "- \\> 25: **bold**");
    }

    #[test]
    fn leaves_real_blockquotes_alone() {
        unchanged("> Some blockquote");
        unchanged("> 25 is a number");
        unchanged("- > Some quoted text");
        unchanged(">25");
        unchanged("```\n- > 25: in code\n```");
    }

    #[test]
    fn escapes_comparison_operators_across_lines() {
        check(
            "- < 10: potentially cheap.\n- 10–20: reasonable/normal zone.\n- > 25–30: rich.",
            "- < 10: potentially cheap.\n- 10–20: reasonable/normal zone.\n- \\> 25–30: rich.",
        );
        check(
            "- > 5: expensive\n- > 25: very expensive",
            "- \\> 5: expensive\n- \\> 25: very expensive",
        );
    }

    // --- html tags --------------------------------------------------------

    #[test]
    fn strips_incomplete_html_tags() {
        check("Hello <div", "Hello");
        check("Hello <custom", "Hello");
        check("Text <MyComponent", "Text");
        check("Hello </div", "Hello");
        check("<div>content</di", "<div>content");
        check("Hello <div class=\"foo", "Hello");
        check("<custom data-id", "");
        check("<div", "");
        check("Some text here\n\n<casecard", "Some text here");
        check("# Heading\n\nParagraph <custom", "# Heading\n\nParagraph");
        check("<div>Hello</div> <span", "<div>Hello</div>");
    }

    #[test]
    fn keeps_complete_or_non_tag_angle_brackets() {
        unchanged("Hello <div>");
        unchanged("<div>content</div>");
        unchanged("<br/>");
        unchanged("3 < 5");
        unchanged("if a <");
        unchanged("value <1");
        unchanged("```\n<div\n```");
        unchanged("```html\n<custom");
        unchanged("`<div`");
        unchanged("text <!-- incomplete comment");
        unchanged("text <script>alert('");
        unchanged("text <!-- comment -->");
    }

    #[test]
    fn html_attribute_underscores_are_not_italic() {
        unchanged("<a target=\"_blank\" href=\"https://link.com\">word</a>");
        unchanged("<a target=\"_blank\">link</a>");
        unchanged("<iframe src=\"x\" sandbox=\"allow_scripts\">");
        check("div> _text", "div> _text_");
        check("3<5 _text", "3<5 _text_");
        check("<div>\n_text", "<div>\n_text_");
    }

    // --- setext headings --------------------------------------------------

    #[test]
    fn breaks_incomplete_setext_underlines() {
        check("here is a list\n-", "here is a list\n-\u{200B}");
        check("here is a list\n- ", "here is a list\n-\u{200B}");
        check("Some text\n--", "Some text\n--\u{200B}");
        check("Some text\n=", "Some text\n=\u{200B}");
        check("Some text\n==", "Some text\n==\u{200B}");
        check(
            "Line 1\nLine 2\nLine 3\n-",
            "Line 1\nLine 2\nLine 3\n-\u{200B}",
        );
        check("Some text\n  -", "Some text\n  -\u{200B}");
        check("Text 1\n-\nText 2\n-", "Text 1\n-\nText 2\n-\u{200B}");
        check("**bold text**\n-", "**bold text**\n-\u{200B}");
        check("*italic text*\n-", "*italic text*\n-\u{200B}");
        check("`code`\n-", "`code`\n-\u{200B}");
    }

    #[test]
    fn leaves_valid_rules_and_headings_alone() {
        unchanged("Some text\n---");
        unchanged("Heading\n===");
        unchanged("-");
        unchanged("\n-");
        unchanged("\n=");
        unchanged("\n==");
        unchanged("Some text\n- Item 1\n- Item 2");
        unchanged("Some text\n-x");
        unchanged("Some text\n----");
        unchanged("here is a list\n- list item 1");
    }

    // --- links ------------------------------------------------------------

    #[test]
    fn preserves_incomplete_links_with_sentinel() {
        check(
            "Text with [incomplete link",
            &link("Text with [incomplete link"),
        );
        check("Text [partial", &link("Text [partial"));
        check("Check out [this lin", &link("Check out [this lin"));
        check("Visit [our site](https://exa", &link("Visit [our site"));
        check("[link1 and [link2", &link("[link1 and [link2"));
        check(
            "[first](url1) and [second",
            &link("[first](url1) and [second"),
        );
        check("[text][", &link("[text][")); // reference-style, still open
    }

    #[test]
    fn keeps_complete_links_unchanged() {
        unchanged("Text with [complete link](url)");
        unchanged("[link1](url1) and [link2](url2)");
        unchanged("[link with [brackets] inside](https://example.com)");
        unchanged("[text][ref]");
        unchanged("[^1]");
        unchanged("[^1]: footnote text");
        unchanged("](partial");
        unchanged("- [ ] unchecked task");
    }

    #[test]
    fn handles_nested_brackets_in_incomplete_links() {
        check(
            "[outer [nested] text](incomplete",
            &link("[outer [nested] text"),
        );
        check("Text [foo [bar] baz](", &link("Text [foo [bar] baz"));
        check("Text [outer [inner", &link("Text [outer [inner"));
        check("[foo [bar [baz", &link("[foo [bar [baz"));
        check("Text [outer [inner]", &link("Text [outer [inner]"));
        check("[link [nested] text", &link("[link [nested] text"));
    }

    #[test]
    fn link_handler_short_circuits_later_handlers() {
        check(
            "Text with [link and **bold",
            &link("Text with [link and **bold"),
        );
        check("[**bold link**](incomplete-url", &link("[**bold link**"));
        check("[`code link`](incomplete", &link("[`code link`"));
        check("[**bold link", &link("[**bold link"));
    }

    // --- images -----------------------------------------------------------

    #[test]
    fn deletes_incomplete_images() {
        check("Text with ![incomplete image", "Text with ");
        check("![partial", "");
        check("See ![the diag", "See ");
        check("![logo](./assets/log", "");
        check("Text ![outer [inner]", "Text ");
        check("![nested [brackets] text", "");
        check(
            "Here's the diagram:\n\n![architecture",
            "Here's the diagram:\n\n",
        );
        check("See ![diagram](http://example.com/img", "See ");
    }

    #[test]
    fn keeps_complete_images_unchanged() {
        unchanged("Text with ![alt text](image.png)");
        unchanged(
            "textContent ![image](https://img.alicdn.com/imgextra/i4/O1CN01ApW8bQ1cUE8LduPra_!!6000000003603-2-skyky.png)",
        );
        unchanged("textContent [link](https://example.com/path_name!!test)");
    }

    // --- code blocks ------------------------------------------------------

    #[test]
    fn no_repair_inside_fenced_blocks() {
        unchanged("```javascript\nconst x = 5;");
        unchanged("```\ncode here");
        unchanged("```python\ndef hello():");
        unchanged("Some text\n```js\nconsole.log");
        unchanged("```javascript\nconst x = `template");
        unchanged("```\ncode block with `backtick\n```");
        unchanged("```\n***bold");
        unchanged("```\n__content_");
        unchanged("Here's how to use it:\n\n```typescript\nconst x = 1");
        unchanged("```\ncode\n```\n```\nmore");
    }

    #[test]
    fn complete_code_blocks_pass_through() {
        unchanged("```javascript\nconst x = 5;\n```");
        unchanged("```\nconst str = `template`;\n```");
        unchanged("```\ncode\n```\nMore text");
        unchanged("```python\ndef greet(name):\n    return f\"Hello, {name}!\"\n```");
        unchanged("```python\ndef greet(name):\n    return f\"Hello, {name}!\"\n```\n");
        unchanged("```js\ncode1\n```\n\n```python\ncode2\n```");
        unchanged("```python def greet(name): return f\"Hello, {name}!\"\n```");
        unchanged(
            "```\nSimple code block\nwith multiple lines\nand some special characters: !@#$%^&*()\n```",
        );
        unchanged("```python\ndef __init__(self):\n    pass\n```\n\n* List item");
        unchanged(
            "```css\n/* Commentary */\n\n[class*=\"WidgetTitle__Header\"] {\n  font-size: 18px !important;\n}\n```\n\nNotes and tips:\n* Use !important only where necessary in CSS.",
        );
    }

    #[test]
    fn repairs_resume_after_a_closed_fence() {
        check("```\ncode\n```\n**bold", "```\ncode\n```\n**bold**");
        check("```\ncode\n```\n*italic", "```\ncode\n```\n*italic*");
        check("```\n_code\n```\n_text", "```\n_code\n```\n_text_");
        check("```\n__code\n```\n__text", "```\n__code\n```\n__text__");
        check("```\n***\n```\n***text", "```\n***\n```\n***text***");
        check(
            "```css\ncode here\n```\n\n**incomplete bold",
            "```css\ncode here\n```\n\n**incomplete bold**",
        );
    }

    #[test]
    fn bracketed_wildcards_in_fences_are_not_links_or_emphasis() {
        unchanged("Here's a state diagram:\n\n```mermaid\nstateDiagram-v2\n    [*] --> Idle\n```");
        unchanged(
            "Here's a state diagram:\n\n```mermaid\nstateDiagram-v2\n    [*] --> Idle\n    Idle --> Loading: fetch()",
        );
        unchanged(
            "*Note:* Here's a state diagram:\n\n```mermaid\nstateDiagram-v2\n    [*] --> Idle\n```",
        );
        check(
            "```mermaid\nstateDiagram-v2\n    [*] --> Idle\n```\n\nHere is *incomplete italic",
            "```mermaid\nstateDiagram-v2\n    [*] --> Idle\n```\n\nHere is *incomplete italic*",
        );
        check(
            "Here's a code block:\n```bash\necho \"test\"\n```\nAnd here's an [incomplete link",
            &link("Here's a code block:\n```bash\necho \"test\"\n```\nAnd here's an [incomplete link"),
        );
    }

    // --- lists ------------------------------------------------------------

    #[test]
    fn list_markers_are_not_emphasis() {
        unchanged("* Item 1\n* Item 2\n* Item 3");
        unchanged("* Single item");
        unchanged("* Parent item\n  * Nested item 1\n  * Nested item 2");
        unchanged("* Item with *italic* text\n* Another item");
        unchanged("*\tItem with tab\n*\tAnother item");
        unchanged("- Item 1\n- Item 2 with *italic*\n- Item 3");
        unchanged("* user123\n* user456\n* user789");
        check(
            "- Item 1\n- Item 2 with **bol",
            "- Item 1\n- Item 2 with **bol**",
        );
    }

    #[test]
    fn standalone_emphasis_markers_in_lists() {
        for input in [
            "- __",
            "- **",
            "- ***",
            "- *",
            "- _",
            "- ~~",
            "- `",
            "- __\n- **",
            "\n- __\n- **",
            "* __\n* **",
            "+ __\n+ **",
            "- __\n- Normal item\n- **",
        ] {
            unchanged(input);
        }
        check("- __ text after", "- __ text after__");
        check("- ** text after", "- ** text after**");
    }

    #[test]
    fn multiline_list_content_is_not_completed() {
        unchanged("- **text\nmore text");
        unchanged("* **content\n* Another item");
    }

    // --- horizontal rules -------------------------------------------------

    #[test]
    fn horizontal_rules_are_never_emphasis() {
        for input in [
            "---",
            "----",
            "-----",
            "***",
            "****",
            "*****",
            "___",
            "____",
            "_____",
            "- - -",
            "* * *",
            "_ _ _",
            "-  -  -",
            "*   *   *",
            "_    _    _",
            "Text before\n***\nText after",
            "Text before\n___\nText after",
            "Some text\n\n---",
            "Some text\n\n***",
            "Some text\n\n___",
            "---\n\nSome text",
            "***\n\nSome text",
            "___\n\nSome text",
            "   ---",
            "  ***",
            " ___",
            "Text\n***",
        ] {
            unchanged(input);
        }
    }

    #[test]
    fn partial_rules_and_standalone_markers() {
        for input in [
            "--",
            "**",
            "__",
            "*",
            "_",
            "~~",
            "`",
            "``",
            "***",
            "****",
            "Text\n\n--",
            "Text with --",
            "** __",
            "\n** __\n",
            "* _ ~~ `",
            " **",
            "  **  ",
            "text**",
            "text*",
            "text`",
            "text$",
            "text~~",
            "text~",
            "Text ending with *",
            "Text ending with **",
            "This is not a --- horizontal rule",
        ] {
            unchanged(input);
        }
        check("** ", "**");
    }

    // --- katex ------------------------------------------------------------

    #[test]
    fn completes_block_katex() {
        check("Text with $$formula", "Text with $$formula$$");
        check("$$incomplete", "$$incomplete$$");
        check("$$first$$ and $$second", "$$first$$ and $$second$$");
        check("$$x + y = z", "$$x + y = z$$");
        check("$$formula$", "$$formula$$");
        check("$$x = y$", "$$x = y$$");
        check("$$\nx = 1\ny = 2", "$$\nx = 1\ny = 2\n$$");
        check("$$\\frac{x}{y", "$$\\frac{x}{y$$");
        check("$$\n\\sum_{i=0}^{n} x_i", "$$\n\\sum_{i=0}^{n} x_i\n$$");
        check("$$$", "$$$$$");
        unchanged("Text with $$E = mc^2$$");
        unchanged("$$formula1$$ and $$formula2$$");
        unchanged("$$$$");
    }

    #[test]
    fn inline_dollar_signs_are_left_alone() {
        unchanged("Text with $formula");
        unchanged("$incomplete");
        unchanged("Text with $x^2 + y^2 = z^2$");
        unchanged("$a = 1$ and $b = 2$");
        unchanged("$first$ and $second");
        unchanged("$$block$$ and $inline");
        unchanged("Price is \\$100");
        unchanged("The price is $50 and $100");
    }

    #[test]
    fn math_content_is_not_emphasis() {
        unchanged("The variable $x_1$ represents the first element");
        unchanged("Formula: $a_b + c_d = e_f$");
        unchanged("$$x_1 + y_2 = z_3$$");
        unchanged("$$\na_1 + b_2\nc_3 + d_4\n$$");
        unchanged("Math expression $x_");
        unchanged("Text with _italic_ and math $x_1$");
        unchanged("$x_1 + x_2 + x_3 = y_1$");
        unchanged("$$\\sum_{i=1}^{n} x_i = \\prod_{j=1}^{m} y_j$$");
        unchanged("_italic start $x_1$ italic end_");
        unchanged("$$\\mathbf{w}^{*}$$");
        unchanged("Text with *italic* and math $$x^{*}$$");
        check("$$formula_", "$$formula_$$");
        check("Start _italic with $x_1$", "Start _italic with $x_1$_");
        check("Cost \\$100 with _incomplete", "Cost \\$100 with _incomplete_");
        check("Start *italic with $$x^{*}$$", "Start *italic with $$x^{*}$$*");
    }

    #[test]
    fn dollar_signs_inside_inline_code_do_not_count() {
        unchanged(
            "Streamdown uses double dollar signs (`$$`) to delimit mathematical expressions.",
        );
        unchanged("Use `$$` for math blocks and `$$formula$$` for inline.");
        check("Math: $$x+y and code: `$$`", "Math: $$x+y and code: `$$`$$");
        check(
            "$$formula$$ and code `$$` and $$incomplete",
            "$$formula$$ and code `$$` and $$incomplete$$",
        );
    }

    // --- mixed / priority order -------------------------------------------

    #[test]
    fn handlers_run_in_priority_order() {
        check("**bold and *italic", "**bold and *italic*");
        check("*italic with **bold", "*italic with **bold***");
        check("**bold with `code", "**bold with `code**`");
        check("~~strike with **bold", "~~strike with **bold**~~");
        check("**bold with $x^2", "**bold with $x^2**");
        // The `~~` lands inside the inline-code span the code handler closes,
        // so strikethrough correctly leaves it alone.
        check(
            "**bold *italic `code ~~strike",
            "**bold *italic `code ~~strike*`",
        );
        check(
            "**bold *italic ~~strike `code",
            "**bold *italic ~~strike `code*`~~",
        );
        check(
            "**bold then *italic then ~~strike",
            "**bold then *italic then ~~strike*~~",
        );
        check("~~strike **bold *italic", "~~strike **bold *italic*~~");
        check(
            "*italic **bold ~~strike `code",
            "*italic **bold ~~strike `code***`~~",
        );
        check(
            "***bold-italic ~~strike `code",
            "***bold-italic ~~strike `code***`~~",
        );
        check("**bold ~~strike", "**bold ~~strike**~~");
        check("*italic **bold", "*italic **bold***");
        check("***bold-italic with `code", "***bold-italic with `code***`");
    }

    #[test]
    fn nested_underscore_closes_inside_bold() {
        check("combined **_bold and italic", "combined **_bold and italic_**");
        check("**_text", "**_text_**");
        check("_italic and **bold", "_italic and **bold**_");
        check("**bold _und", "**bold _und_**");
        check("_text**", "_text**_");
    }

    #[test]
    fn complete_documents_pass_through_unchanged() {
        for doc in [
            "**bold** and *italic* and `code` and ~~strike~~",
            "**bold with *italic* inside**",
            "**bold *italic* text** and `code`",
            "# Heading\n\n**Bold text** with *italic* and `code`.\n\n- List item\n- Another item with ~~strike~~",
            "# Title\n\nSome content with **bold** text.\n\n---\n\n## Section 2\n\nMore content.",
            "- Item 1\n- Item 2\n\n---\n\nNew section",
            "---\n\n# Heading",
            "Section 1\n\n---\n\nSection 2\n\n---\n\nSection 3",
            "| Col1 | Col2 |\n|------|------|\n| **a** | b |",
            "[click here](https://example.com) for more",
            "- [x] completed ~~struck~~",
        ] {
            unchanged(doc);
        }
    }

    #[test]
    fn confusing_asterisk_sequences() {
        check("****text", "****text***");
        check("*****text", "*****text***");
        check("*a**b", "*a**b***");
    }

    // --- streaming scenarios ----------------------------------------------

    #[test]
    fn streaming_chunks() {
        check("This is **bold with *ital", "This is **bold with *ital*");
        check(
            "# Main Title\n## Subtitle with **emph",
            "# Main Title\n## Subtitle with **emph**",
        );
        check("> Quote with **bold", "> Quote with **bold**");
        check(
            "| Col1 | Col2 |\n|------|------|\n| **dat",
            "| Col1 | Col2 |\n|------|------|\n| **dat**",
        );
        check(
            "1. First item\n   - Nested with `code\n2. Second",
            "1. First item\n   - Nested with `code\n2. Second`",
        );
        check("Text **bold `code", "Text **bold `code**`");
        check("Here is a **bold", "Here is a **bold**");
        check(
            "Here is a **bold statement** about `code",
            "Here is a **bold statement** about `code`",
        );
        check(
            "To use this function, call `getData(",
            "To use this function, call `getData(`",
        );
        check("| **bold | next |", "| **bold | next |**");
        check("| `code | next |", "| `code | next |`");
        unchanged("| **bold** | next |");
    }

    #[test]
    fn structural_context_does_not_block_repair() {
        check("> > **deeply nested bold", "> > **deeply nested bold**");
        check("> * list with **bold", "> * list with **bold**");
        check("> > > triple nested *italic", "> > > triple nested *italic*");
        check("> ~~struck text", "> ~~struck text~~");
        check("- [ ] **bold task", "- [ ] **bold task**");
        check("- [ ] *italic task", "- [ ] *italic task*");
        check("- [ ] `code task", "- [ ] `code task`");
        check("---\n**bold after rule", "---\n**bold after rule**");
        check("# Heading\n**bold", "# Heading\n**bold**");
        check("paragraph1\n\n**bold", "paragraph1\n\n**bold**");
        check("text\n\n\n**bold", "text\n\n\n**bold**");
        check("    **bold in indented", "    **bold in indented**");
        check("    *asterisks in indented", "    *asterisks in indented*");
        check("**bold\twith\ttabs", "**bold\twith\ttabs**");
        check("**bold\r\nwith CRLF", "**bold\r\nwith CRLF**");
        check("\n\n\n**bold", "\n\n\n**bold**");
        check(
            "1. First\n2. **Second item with bold",
            "1. First\n2. **Second item with bold**",
        );
        check(
            "The function `getData` returns a **Promise",
            "The function `getData` returns a **Promise**",
        );
        check(
            "- Use `map` to transform\n- Use `filter",
            "- Use `map` to transform\n- Use `filter`",
        );
        check("## Important *note", "## Important *note*");
    }

    // --- unicode ----------------------------------------------------------

    #[test]
    fn cjk_and_unicode_flow_through() {
        check("**中文粗体", "**中文粗体**");
        check("*日本語", "*日本語*");
        check("`한국어 코드", "`한국어 코드`");
        check("~~🎉 celebration", "~~🎉 celebration~~");
        check("**Hello 世界", "**Hello 世界**");
        check("**émoji 🎉", "**émoji 🎉**");
        check("`código", "`código`");
        unchanged("这是一段没有任何标记的中文文本。");
        unchanged("**中文粗体** 和 *中文斜体* 以及 `代码`");
        check("**&lt;tag&gt;", "**&lt;tag&gt;**");
    }

    #[test]
    fn cjk_around_markers_is_byte_safe() {
        // The scans index bytes; a CJK char adjacent to a marker must still be
        // decoded as one char for the word-character checks.
        check("中文~中文", "中文\\~中文");
        unchanged("中文_中文");
        unchanged("中文*中文");
    }

    #[test]
    fn long_input() {
        let long = format!("{} **bold", "a".repeat(10_000));
        check(&long, &format!("{long}**"));
    }

    // --- idempotence ------------------------------------------------------

    #[test]
    fn repaired_output_is_stable() {
        for input in [
            "Text with **bold",
            "Text with [incomplete link",
            "here is a list\n-",
            "20~25°C",
            "- > 25: rich",
            "$$formula",
            "**bold *italic `code ~~strike",
        ] {
            let once = remend(input);
            let twice = remend(&once);
            assert_eq!(once, twice, "not idempotent for {input:?}");
        }
    }

    // --- unit tests for the ported predicates -----------------------------

    #[test]
    fn word_char_classification() {
        assert!(!is_word_char(None));
        assert!(is_word_char(Some('a')));
        assert!(is_word_char(Some('Z')));
        assert!(is_word_char(Some('5')));
        assert!(is_word_char(Some('_')));
        assert!(is_word_char(Some('é')));
        assert!(is_word_char(Some('中')));
        assert!(!is_word_char(Some(' ')));
        assert!(!is_word_char(Some('*')));
        assert!(!is_word_char(Some('-')));
    }

    #[test]
    fn bracket_matching_is_depth_counted() {
        assert_eq!(find_matching_opening_bracket("some text]", 9), None);
        assert_eq!(find_matching_opening_bracket("[text]", 5), Some(0));
        assert_eq!(
            find_matching_opening_bracket("[outer [inner] text]", 19),
            Some(0)
        );
        assert_eq!(
            find_matching_opening_bracket("[outer [inner] text]", 13),
            Some(7)
        );
        assert_eq!(find_matching_closing_bracket("[some text", 0), None);
        assert_eq!(find_matching_closing_bracket("[text]", 0), Some(5));
        assert_eq!(
            find_matching_closing_bracket("[outer [inner] text]", 0),
            Some(19)
        );
        assert_eq!(
            find_matching_closing_bracket("[outer [inner] text]", 7),
            Some(13)
        );
    }

    #[test]
    fn math_block_detection() {
        assert!(is_within_math_block("$$x$y$$z", 5));
        assert!(!is_within_math_block("$$x$$ y", 6));
        assert!(is_within_math_block("$x_1$", 2));
    }

    #[test]
    fn link_url_detection() {
        assert!(!is_within_link_or_image_url("[t](_\nmore)", 4));
        assert!(!is_within_link_or_image_url("[t](_noclose", 4));
        assert!(!is_within_link_or_image_url("[text](url) _after", 12));
        assert!(!is_within_link_or_image_url("func(arg)", 5));
        assert!(is_within_link_or_image_url("[link](a_b) _word", 8));
        check("func(_arg", "func(_arg_");
        check("[link](url) _word", "[link](url) _word_");
        check("[link](a_b) _word", "[link](a_b) _word_");
    }

    #[test]
    fn html_tag_detection() {
        assert!(!is_within_html_tag("div>text", 5));
        assert!(!is_within_html_tag("3<5 text", 4));
        assert!(!is_within_html_tag("<div\ntext", 6));
        assert!(!is_within_html_tag("text<", 5));
        assert!(is_within_html_tag("<DIV class='_test'>", 13));
        assert!(is_within_html_tag("</div _attr>", 6));
    }

    #[test]
    fn horizontal_rule_detection() {
        assert!(is_horizontal_rule("* * *", 0, b'*'));
        assert!(is_horizontal_rule("*\t*\t*", 0, b'*'));
        assert!(!is_horizontal_rule("**bold**", 0, b'*'));
    }

    #[test]
    fn triple_asterisk_counting() {
        assert_eq!(count_triple_asterisks("text***"), 1);
        assert_eq!(count_triple_asterisks("```\n***\n```"), 0);
        assert_eq!(count_triple_asterisks("```\n***\n```\n***"), 1);
        assert_eq!(count_triple_asterisks("***```code```"), 1);
    }
}
