//! Parse markdown into a flat, owned event vector.
//!
//! Mirrors `pulldown_cmark::Event` with owned data so the parse result can be
//! cached across frames (pulldown's events borrow the source). Plain text is
//! represented as just a source byte range; text that differs from the source
//! (HTML entities, smart punctuation) carries the substituted string.

use gpui::SharedString;
use pulldown_cmark::{Alignment, BlockQuoteKind, HeadingLevel, Options, Parser};
use std::ops::Range;
use std::sync::Arc;

/// A parsed document: the exact source that was parsed plus the event list.
#[derive(Clone, Default)]
pub struct ParsedMarkdown {
    pub source: SharedString,
    pub events: Arc<[(Range<usize>, MarkdownEvent)]>,
    /// Byte ranges of top-level blocks, for stable per-block element ids.
    pub blocks: Arc<[Range<usize>]>,
    /// Syntax-highlight spans for fenced code blocks, sorted by range,
    /// with absolute source offsets.
    pub code_spans: Arc<[(Range<usize>, crate::highlight::CodeSpan)]>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum MarkdownEvent {
    Start(MarkdownTag),
    End(MarkdownTagEnd),
    /// Text identical to the source at the event's range.
    Text,
    /// Text that differs from the source (entities, smart punctuation).
    SubstitutedText(String),
    /// Inline code span content (backticks stripped).
    Code(String),
    InlineMath(String),
    DisplayMath(String),
    /// Raw block html chunk; rendered literally.
    Html,
    /// Raw inline html; rendered literally except `<br>`.
    InlineHtml,
    FootnoteReference(String),
    SoftBreak,
    HardBreak,
    Rule,
    TaskListMarker(bool),
}

#[derive(Clone, Debug, PartialEq)]
pub enum MarkdownTag {
    Paragraph,
    Heading(HeadingLevel),
    BlockQuote(Option<BlockQuoteKind>),
    CodeBlock {
        lang: SharedString,
        /// False while the closing fence hasn't streamed in yet (or for
        /// indented blocks, always true).
        closed: bool,
    },
    HtmlBlock,
    /// `Some(n)` for ordered lists starting at `n`.
    List(Option<u64>),
    Item,
    FootnoteDefinition(String),
    Table(Vec<Alignment>),
    TableHead,
    TableRow,
    TableCell,
    Emphasis,
    Strong,
    Strikethrough,
    Link {
        dest_url: SharedString,
        title: SharedString,
    },
    Image {
        dest_url: SharedString,
        title: SharedString,
    },
    MetadataBlock,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkdownTagEnd {
    Paragraph,
    Heading,
    BlockQuote,
    CodeBlock,
    HtmlBlock,
    List,
    Item,
    FootnoteDefinition,
    Table,
    TableHead,
    TableRow,
    TableCell,
    Emphasis,
    Strong,
    Strikethrough,
    Link,
    Image,
    MetadataBlock,
}

const PARSE_OPTIONS: Options = Options::ENABLE_TABLES
    .union(Options::ENABLE_FOOTNOTES)
    .union(Options::ENABLE_STRIKETHROUGH)
    .union(Options::ENABLE_TASKLISTS)
    .union(Options::ENABLE_SMART_PUNCTUATION)
    .union(Options::ENABLE_MATH)
    .union(Options::ENABLE_GFM);

pub fn parse_markdown(source: SharedString) -> ParsedMarkdown {
    use pulldown_cmark::{CodeBlockKind, Event, Tag, TagEnd};

    let mut events: Vec<(Range<usize>, MarkdownEvent)> = Vec::new();
    let mut blocks: Vec<Range<usize>> = Vec::new();
    let mut depth = 0usize;
    let mut block_start = 0usize;
    // Suppress linkification inside code blocks and existing links/images.
    let mut no_autolink = 0usize;

    for (event, range) in Parser::new_ext(&source, PARSE_OPTIONS).into_offset_iter() {
        let mapped = match event {
            Event::Start(tag) => {
                if depth == 0 {
                    block_start = range.start;
                }
                depth += 1;
                let tag = match tag {
                    Tag::Paragraph => MarkdownTag::Paragraph,
                    Tag::Heading { level, .. } => MarkdownTag::Heading(level),
                    Tag::BlockQuote(kind) => MarkdownTag::BlockQuote(kind),
                    Tag::CodeBlock(kind) => {
                        no_autolink += 1;
                        match kind {
                            CodeBlockKind::Indented => MarkdownTag::CodeBlock {
                                lang: SharedString::default(),
                                closed: true,
                            },
                            CodeBlockKind::Fenced(info) => MarkdownTag::CodeBlock {
                                lang: info
                                    .split_whitespace()
                                    .next()
                                    .unwrap_or_default()
                                    .to_string()
                                    .into(),
                                closed: fence_is_closed(&source[range.clone()]),
                            },
                        }
                    }
                    Tag::HtmlBlock => MarkdownTag::HtmlBlock,
                    Tag::List(start) => MarkdownTag::List(start),
                    Tag::Item => MarkdownTag::Item,
                    Tag::FootnoteDefinition(label) => {
                        MarkdownTag::FootnoteDefinition(label.into_string())
                    }
                    Tag::Table(alignments) => MarkdownTag::Table(alignments),
                    Tag::TableHead => MarkdownTag::TableHead,
                    Tag::TableRow => MarkdownTag::TableRow,
                    Tag::TableCell => MarkdownTag::TableCell,
                    Tag::Emphasis => MarkdownTag::Emphasis,
                    Tag::Strong => MarkdownTag::Strong,
                    Tag::Strikethrough => MarkdownTag::Strikethrough,
                    Tag::Link { dest_url, title, .. } => {
                        no_autolink += 1;
                        MarkdownTag::Link {
                            dest_url: dest_url.into_string().into(),
                            title: title.into_string().into(),
                        }
                    }
                    Tag::Image { dest_url, title, .. } => {
                        no_autolink += 1;
                        MarkdownTag::Image {
                            dest_url: dest_url.into_string().into(),
                            title: title.into_string().into(),
                        }
                    }
                    Tag::MetadataBlock(_) => MarkdownTag::MetadataBlock,
                    // Not enabled in PARSE_OPTIONS.
                    Tag::DefinitionList
                    | Tag::DefinitionListTitle
                    | Tag::DefinitionListDefinition
                    | Tag::Superscript
                    | Tag::Subscript => MarkdownTag::Paragraph,
                };
                MarkdownEvent::Start(tag)
            }
            Event::End(tag) => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    blocks.push(block_start..range.end);
                }
                let tag = match tag {
                    TagEnd::Paragraph => MarkdownTagEnd::Paragraph,
                    TagEnd::Heading(_) => MarkdownTagEnd::Heading,
                    TagEnd::BlockQuote(_) => MarkdownTagEnd::BlockQuote,
                    TagEnd::CodeBlock => {
                        no_autolink = no_autolink.saturating_sub(1);
                        MarkdownTagEnd::CodeBlock
                    }
                    TagEnd::HtmlBlock => MarkdownTagEnd::HtmlBlock,
                    TagEnd::List(_) => MarkdownTagEnd::List,
                    TagEnd::Item => MarkdownTagEnd::Item,
                    TagEnd::FootnoteDefinition => MarkdownTagEnd::FootnoteDefinition,
                    TagEnd::Table => MarkdownTagEnd::Table,
                    TagEnd::TableHead => MarkdownTagEnd::TableHead,
                    TagEnd::TableRow => MarkdownTagEnd::TableRow,
                    TagEnd::TableCell => MarkdownTagEnd::TableCell,
                    TagEnd::Emphasis => MarkdownTagEnd::Emphasis,
                    TagEnd::Strong => MarkdownTagEnd::Strong,
                    TagEnd::Strikethrough => MarkdownTagEnd::Strikethrough,
                    TagEnd::Link => {
                        no_autolink = no_autolink.saturating_sub(1);
                        MarkdownTagEnd::Link
                    }
                    TagEnd::Image => {
                        no_autolink = no_autolink.saturating_sub(1);
                        MarkdownTagEnd::Image
                    }
                    TagEnd::MetadataBlock(_) => MarkdownTagEnd::MetadataBlock,
                    TagEnd::DefinitionList
                    | TagEnd::DefinitionListTitle
                    | TagEnd::DefinitionListDefinition
                    | TagEnd::Superscript
                    | TagEnd::Subscript => MarkdownTagEnd::Paragraph,
                };
                MarkdownEvent::End(tag)
            }
            Event::Text(text) => {
                if source.get(range.clone()) == Some(text.as_ref()) {
                    if no_autolink == 0 {
                        autolink_text(&source, range.clone(), &mut events);
                        continue;
                    }
                    MarkdownEvent::Text
                } else {
                    MarkdownEvent::SubstitutedText(text.into_string())
                }
            }
            Event::Code(text) => MarkdownEvent::Code(text.into_string()),
            Event::InlineMath(text) => MarkdownEvent::InlineMath(text.into_string()),
            Event::DisplayMath(text) => MarkdownEvent::DisplayMath(text.into_string()),
            Event::Html(_) => MarkdownEvent::Html,
            Event::InlineHtml(_) => MarkdownEvent::InlineHtml,
            Event::FootnoteReference(label) => {
                MarkdownEvent::FootnoteReference(label.into_string())
            }
            Event::SoftBreak => MarkdownEvent::SoftBreak,
            Event::HardBreak => MarkdownEvent::HardBreak,
            Event::Rule => {
                if depth == 0 {
                    blocks.push(range.clone());
                }
                MarkdownEvent::Rule
            }
            Event::TaskListMarker(checked) => MarkdownEvent::TaskListMarker(checked),
        };
        events.push((range, mapped));
    }

    let code_spans = highlight_code_blocks(&source, &events);
    ParsedMarkdown {
        source,
        events: events.into(),
        blocks: blocks.into(),
        code_spans: code_spans.into(),
    }
}

/// Highlight every fenced code block with a known language. Cached per
/// (lang, content) inside [`crate::highlight`], so across streaming reparses
/// only the growing tail block pays for re-highlighting.
fn highlight_code_blocks(
    source: &str,
    events: &[(Range<usize>, MarkdownEvent)],
) -> Vec<(Range<usize>, crate::highlight::CodeSpan)> {
    let mut spans = Vec::new();
    let mut iter = events.iter().enumerate();
    while let Some((i, (_, event))) = iter.next() {
        let MarkdownEvent::Start(MarkdownTag::CodeBlock { lang, .. }) = event else {
            continue;
        };
        if lang.is_empty() {
            continue;
        }
        // Code text is contiguous source-backed Text events until the End.
        let (mut start, mut end) = (None, 0);
        for (r, event) in events[i + 1..].iter() {
            match event {
                MarkdownEvent::End(MarkdownTagEnd::CodeBlock) => break,
                MarkdownEvent::Text => {
                    start.get_or_insert(r.start);
                    end = r.end;
                }
                _ => {}
            }
        }
        if let Some(start) = start {
            for (r, span) in crate::highlight::highlight(lang, &source[start..end]).iter() {
                spans.push((start + r.start..start + r.end, *span));
            }
        }
    }
    spans
}

/// Split a plain text span around bare URLs, emitting synthetic Link events.
/// pulldown-cmark has no autolink-literal support, so `https://…` in prose
/// would otherwise render as dead text.
fn autolink_text(
    source: &str,
    range: Range<usize>,
    events: &mut Vec<(Range<usize>, MarkdownEvent)>,
) {
    let text = &source[range.clone()];
    let mut cursor = range.start;
    let finder = linkify::LinkFinder::new();
    for link in finder.links(text) {
        if !matches!(link.kind(), linkify::LinkKind::Url) {
            continue;
        }
        let (start, end) = (range.start + link.start(), range.start + link.end());
        if cursor < start {
            events.push((cursor..start, MarkdownEvent::Text));
        }
        let url: SharedString = link.as_str().to_string().into();
        events.push((
            start..end,
            MarkdownEvent::Start(MarkdownTag::Link {
                dest_url: url,
                title: SharedString::default(),
            }),
        ));
        events.push((start..end, MarkdownEvent::Text));
        events.push((start..end, MarkdownEvent::End(MarkdownTagEnd::Link)));
        cursor = end;
    }
    if cursor < range.end {
        events.push((cursor..range.end, MarkdownEvent::Text));
    }
}

/// Whether a fenced code block's source ends with a closing fence line.
fn fence_is_closed(block: &str) -> bool {
    let block = block.trim_end_matches(['\n', '\r']);
    let Some(open) = block.trim_start().chars().next() else {
        return false;
    };
    if open != '`' && open != '~' {
        return false;
    }
    let mut lines = block.lines();
    let first = lines.next().unwrap_or_default();
    let last = match lines.next_back() {
        Some(last) => last,
        // Single line: `\`\`\`` alone is an unclosed opener.
        None => return false,
    };
    let open_len = first.trim_start().chars().take_while(|&c| c == open).count();
    let last = last.trim_start();
    let close_len = last.chars().take_while(|&c| c == open).count();
    close_len >= open_len.max(3) && last.chars().all(|c| c == open || c == ' ' || c == '\t')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> ParsedMarkdown {
        parse_markdown(SharedString::new(s.to_string()))
    }

    #[test]
    fn blocks_are_top_level() {
        let doc = parse("# Title\n\npara one\n\n- a\n- b\n");
        assert_eq!(doc.blocks.len(), 3);
    }

    #[test]
    fn text_is_range_backed() {
        let doc = parse("hello **world**");
        let text_events: Vec<_> = doc
            .events
            .iter()
            .filter(|(r, e)| matches!(e, MarkdownEvent::Text) && &doc.source[r.clone()] == "world")
            .collect();
        assert_eq!(text_events.len(), 1);
    }

    #[test]
    fn bare_urls_autolink() {
        let doc = parse("see https://example.com for more");
        assert!(doc.events.iter().any(|(_, e)| matches!(
            e,
            MarkdownEvent::Start(MarkdownTag::Link { dest_url, .. }) if dest_url.as_ref() == "https://example.com"
        )));
    }

    #[test]
    fn no_autolink_inside_code() {
        let doc = parse("```\nhttps://example.com\n```");
        assert!(!doc
            .events
            .iter()
            .any(|(_, e)| matches!(e, MarkdownEvent::Start(MarkdownTag::Link { .. }))));
    }

    #[test]
    fn explicit_links_not_doubled() {
        let doc = parse("[x](https://example.com)");
        let links = doc
            .events
            .iter()
            .filter(|(_, e)| matches!(e, MarkdownEvent::Start(MarkdownTag::Link { .. })))
            .count();
        assert_eq!(links, 1);
    }

    #[test]
    fn open_fence_detected() {
        let doc = parse("```rust\nfn main() {}\n");
        assert!(doc.events.iter().any(|(_, e)| matches!(
            e,
            MarkdownEvent::Start(MarkdownTag::CodeBlock { closed: false, .. })
        )));
    }

    #[test]
    fn closed_fence_detected() {
        let doc = parse("```rust\nfn main() {}\n```\n");
        assert!(doc.events.iter().any(|(_, e)| matches!(
            e,
            MarkdownEvent::Start(MarkdownTag::CodeBlock { closed: true, .. })
        )));
    }

    #[test]
    fn task_list_markers() {
        let doc = parse("- [x] done\n- [ ] todo\n");
        let marks: Vec<bool> = doc
            .events
            .iter()
            .filter_map(|(_, e)| match e {
                MarkdownEvent::TaskListMarker(c) => Some(*c),
                _ => None,
            })
            .collect();
        assert_eq!(marks, vec![true, false]);
    }
}
