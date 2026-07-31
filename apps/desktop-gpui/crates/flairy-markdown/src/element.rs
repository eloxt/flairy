//! Render a parsed event vector into GPUI elements.
//!
//! One styled text element per block with `TextRun`s for inline styling —
//! never one element per span. Rebuilt each frame from the cached parse;
//! GPUI's retained `TextLayout` memoizes the expensive shaping.

use crate::events::{MarkdownEvent, MarkdownTag, MarkdownTagEnd, ParsedMarkdown};
use crate::INCOMPLETE_LINK;
use gpui::prelude::*;
use gpui::{
    div, px, AnyElement, App, Div, ElementId, Font, FontStyle, FontWeight, Hsla, InteractiveText,
    SharedString, StrikethroughStyle, StyledText, TextRun, TextStyle, UnderlineStyle, Window,
};
use pulldown_cmark::{Alignment, BlockQuoteKind, HeadingLevel};

/// Colors and fonts the renderer needs from the host app's theme.
#[derive(Clone)]
pub struct MarkdownStyle {
    pub link: Hsla,
    pub muted_foreground: Hsla,
    pub border: Hsla,
    pub code_background: Hsla,
    pub table_head_background: Hsla,
    pub mono_font: SharedString,
    /// Picks the dark or light side of precomputed syntax-highlight spans.
    pub is_dark: bool,
}

pub fn render_markdown(
    seed: usize,
    parsed: &ParsedMarkdown,
    style: &MarkdownStyle,
    window: &Window,
) -> AnyElement {
    Builder::new(seed, parsed, style, window.text_style()).run()
}

/// Per-segment resolved inline style, applied when the text was pushed.
#[derive(Clone, PartialEq)]
struct SegStyle {
    mono: bool,
    bold: bool,
    italic: bool,
    strike: bool,
    link: bool,
    color: Hsla,
    background: Option<Hsla>,
}

struct Frame {
    tag: MarkdownTag,
    children: Vec<AnyElement>,
    /// Item ordinal for ordered lists, task marker for task items.
    item_marker: Option<Marker>,
}

enum Marker {
    Bullet(usize),
    Ordered(u64),
    Task(bool),
}

struct TableCtx {
    alignments: Vec<Alignment>,
    head: Vec<AnyElement>,
    rows: Vec<Vec<AnyElement>>,
    cells: Vec<AnyElement>,
    in_head: bool,
}

struct Builder<'a> {
    parsed: &'a ParsedMarkdown,
    style: &'a MarkdownStyle,
    base: TextStyle,
    seed: usize,
    counter: usize,

    stack: Vec<Frame>,
    root: Vec<AnyElement>,
    tables: Vec<TableCtx>,

    // Inline accumulation, flushed at block boundaries.
    text: String,
    segs: Vec<(usize, SegStyle)>,
    links: Vec<(std::ops::Range<usize>, SharedString)>,
    open_links: Vec<(usize, SharedString)>,
    /// Raw text of the code block being built, for the copy button.
    code_buf: String,

    // Inline state.
    bold: usize,
    italic: usize,
    strike: usize,
    code_block: usize,
    color_stack: Vec<Hsla>,
    list_stack: Vec<Option<u64>>,
}

impl<'a> Builder<'a> {
    fn new(
        seed: usize,
        parsed: &'a ParsedMarkdown,
        style: &'a MarkdownStyle,
        base: TextStyle,
    ) -> Self {
        let base_color = base.color;
        Self {
            parsed,
            style,
            base,
            seed,
            counter: 0,
            stack: Vec::new(),
            root: Vec::new(),
            tables: Vec::new(),
            text: String::new(),
            segs: Vec::new(),
            links: Vec::new(),
            open_links: Vec::new(),
            code_buf: String::new(),
            bold: 0,
            italic: 0,
            strike: 0,
            code_block: 0,
            color_stack: vec![base_color],
            list_stack: Vec::new(),
        }
    }

    fn run(mut self) -> AnyElement {
        let events = self.parsed.events.clone();
        for (range, event) in events.iter() {
            match event {
                MarkdownEvent::Start(tag) => self.start(tag.clone()),
                MarkdownEvent::End(tag) => self.end(*tag),
                MarkdownEvent::Text => {
                    if self.code_block > 0 {
                        self.push_code_text(range.clone());
                    } else {
                        let text = self.parsed.source[range.clone()].to_string();
                        self.push_text(&text, false);
                    }
                }
                MarkdownEvent::SubstitutedText(text) => {
                    let text = text.clone();
                    self.push_text(&text, false)
                }
                MarkdownEvent::Code(text)
                | MarkdownEvent::InlineMath(text)
                | MarkdownEvent::DisplayMath(text) => {
                    let text = text.clone();
                    self.push_text(&text, true)
                }
                MarkdownEvent::Html | MarkdownEvent::InlineHtml => {
                    let raw = &self.parsed.source[range.clone()];
                    let trimmed = raw.trim();
                    let text = if trimmed.eq_ignore_ascii_case("<br>")
                        || trimmed.eq_ignore_ascii_case("<br/>")
                        || trimmed.eq_ignore_ascii_case("<br />")
                    {
                        "\n".to_string()
                    } else {
                        raw.to_string()
                    };
                    self.push_text(&text, false);
                }
                MarkdownEvent::FootnoteReference(label) => {
                    let text = format!("[{label}]");
                    self.push_text(&text, false);
                }
                MarkdownEvent::SoftBreak | MarkdownEvent::HardBreak => self.push_text("\n", false),
                MarkdownEvent::Rule => {
                    let rule = div()
                        .my(px(4.))
                        .h(px(1.))
                        .w_full()
                        .bg(self.style.border)
                        .into_any_element();
                    self.push_element(rule);
                }
                MarkdownEvent::TaskListMarker(checked) => {
                    if let Some(item) = self
                        .stack
                        .iter_mut()
                        .rev()
                        .find(|f| matches!(f.tag, MarkdownTag::Item))
                    {
                        item.item_marker = Some(Marker::Task(*checked));
                    }
                }
            }
        }
        self.flush_text();
        let root: Vec<AnyElement> = self.root.drain(..).collect();
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .children(root)
            .into_any_element()
    }

    // ---- inline text ----

    fn cur_style(&self, mono: bool, color_override: Option<Hsla>) -> SegStyle {
        let link = !self.open_links.is_empty();
        SegStyle {
            mono: mono || self.code_block > 0,
            bold: self.bold > 0,
            italic: self.italic > 0,
            strike: self.strike > 0,
            link,
            color: if let Some(color) = color_override {
                color
            } else if link {
                self.style.link
            } else {
                *self.color_stack.last().unwrap()
            },
            background: (mono && self.code_block == 0).then_some(self.style.code_background),
        }
    }

    fn push_text(&mut self, s: &str, mono: bool) {
        self.push_text_styled(s, mono, None);
    }

    fn push_text_styled(&mut self, s: &str, mono: bool, color_override: Option<Hsla>) {
        if s.is_empty() {
            return;
        }
        let style = self.cur_style(mono, color_override);
        self.text.push_str(s);
        match self.segs.last_mut() {
            Some((len, last)) if *last == style => *len += s.len(),
            _ => self.segs.push((s.len(), style)),
        }
    }

    /// Code-block text: split the source range along precomputed highlight
    /// spans and emit each slice with its theme-appropriate color.
    fn push_code_text(&mut self, range: std::ops::Range<usize>) {
        let source = self.parsed.source.clone();
        self.code_buf.push_str(&source[range.clone()]);
        let spans = self.parsed.code_spans.clone();
        let mut idx = spans.partition_point(|(r, _)| r.end <= range.start);
        let mut cursor = range.start;
        while cursor < range.end {
            match spans.get(idx) {
                Some((r, span)) if r.start <= cursor => {
                    let end = r.end.min(range.end);
                    let color = if self.style.is_dark { span.dark } else { span.light };
                    self.push_text_styled(&source[cursor..end], true, Some(color));
                    cursor = end;
                    if r.end <= cursor {
                        idx += 1;
                    }
                }
                Some((r, _)) if r.start < range.end => {
                    self.push_text_styled(&source[cursor..r.start], true, None);
                    cursor = r.start;
                }
                _ => {
                    self.push_text_styled(&source[cursor..range.end], true, None);
                    cursor = range.end;
                }
            }
        }
    }

    fn flush_text(&mut self) {
        if self.text.is_empty() {
            self.segs.clear();
            return;
        }
        // Code block bodies keep pulldown's trailing newline; drop it.
        if self.code_block > 0 {
            while self.text.ends_with('\n') {
                self.text.pop();
                if let Some((len, _)) = self.segs.last_mut() {
                    *len -= 1;
                    if *len == 0 {
                        self.segs.pop();
                    }
                }
            }
            if self.text.is_empty() {
                self.segs.clear();
                return;
            }
        }

        let text = std::mem::take(&mut self.text);
        let segs = std::mem::take(&mut self.segs);
        let links = std::mem::take(&mut self.links);
        // A link left open across a flush (shouldn't happen for well-formed
        // inline content) restarts in the next text element.
        for (start, _) in self.open_links.iter_mut() {
            *start = 0;
        }

        let runs: Vec<TextRun> = segs.iter().map(|(len, s)| self.make_run(*len, s)).collect();
        let styled = StyledText::new(text).with_runs(runs);

        self.counter += 1;
        let element = if links.is_empty() {
            styled.into_any_element()
        } else {
            let id = ElementId::NamedInteger(
                SharedString::new(format!("md-{}", self.seed)),
                self.counter as u64,
            );
            let (ranges, urls): (Vec<_>, Vec<SharedString>) = links.into_iter().unzip();
            InteractiveText::new(id, styled)
                .on_click(ranges, move |ix, _window, cx: &mut App| {
                    if let Some(url) = urls.get(ix) {
                        cx.open_url(url);
                    }
                })
                .into_any_element()
        };
        self.push_element(element);
    }

    fn make_run(&self, len: usize, seg: &SegStyle) -> TextRun {
        let mut font: Font = self.base.font();
        if seg.mono {
            font.family = self.style.mono_font.clone();
        }
        if seg.bold {
            font.weight = FontWeight::SEMIBOLD;
        }
        if seg.italic {
            font.style = FontStyle::Italic;
        }
        TextRun {
            len,
            font,
            color: seg.color,
            background_color: seg.background,
            underline: seg.link.then(|| UnderlineStyle {
                thickness: px(1.),
                color: Some(seg.color),
                wavy: false,
            }),
            strikethrough: seg.strike.then(|| StrikethroughStyle {
                thickness: px(1.),
                color: Some(seg.color),
            }),
        }
    }

    // ---- block structure ----

    fn start(&mut self, tag: MarkdownTag) {
        match &tag {
            MarkdownTag::Strong => {
                self.bold += 1;
                return;
            }
            MarkdownTag::Emphasis => {
                self.italic += 1;
                return;
            }
            MarkdownTag::Strikethrough => {
                self.strike += 1;
                return;
            }
            MarkdownTag::Link { dest_url, .. } => {
                self.open_links.push((self.text.len(), dest_url.clone()));
                return;
            }
            MarkdownTag::Image { dest_url, .. } => {
                // v1: images render as a clickable pictogram + alt text.
                self.open_links.push((self.text.len(), dest_url.clone()));
                self.push_text("🖼 ", false);
                return;
            }
            _ => {}
        }

        // Entering a block: whatever inline text is pending belongs to the
        // parent (e.g. tight list item text before a nested list).
        self.flush_text();
        match &tag {
            MarkdownTag::CodeBlock { .. } => {
                self.code_block += 1;
                self.code_buf.clear();
            }
            MarkdownTag::BlockQuote(_) => self.color_stack.push(self.style.muted_foreground),
            MarkdownTag::List(start) => self.list_stack.push(*start),
            MarkdownTag::Table(alignments) => {
                self.tables.push(TableCtx {
                    alignments: alignments.clone(),
                    head: Vec::new(),
                    rows: Vec::new(),
                    cells: Vec::new(),
                    in_head: false,
                });
            }
            MarkdownTag::TableHead => {
                if let Some(t) = self.tables.last_mut() {
                    t.in_head = true;
                }
            }
            _ => {}
        }
        let item_marker = if let MarkdownTag::Item = &tag {
            let depth = self.list_stack.len().saturating_sub(1);
            match self.list_stack.last_mut() {
                Some(Some(n)) => {
                    let marker = Marker::Ordered(*n);
                    *n += 1;
                    Some(marker)
                }
                _ => Some(Marker::Bullet(depth)),
            }
        } else {
            None
        };
        self.stack.push(Frame {
            tag,
            children: Vec::new(),
            item_marker,
        });
    }

    fn end(&mut self, tag: MarkdownTagEnd) {
        match tag {
            MarkdownTagEnd::Strong => {
                self.bold = self.bold.saturating_sub(1);
                return;
            }
            MarkdownTagEnd::Emphasis => {
                self.italic = self.italic.saturating_sub(1);
                return;
            }
            MarkdownTagEnd::Strikethrough => {
                self.strike = self.strike.saturating_sub(1);
                return;
            }
            MarkdownTagEnd::Link | MarkdownTagEnd::Image => {
                if let Some((start, url)) = self.open_links.pop() {
                    if url.as_ref() != INCOMPLETE_LINK && !url.is_empty() {
                        self.links.push((start..self.text.len(), url));
                    }
                }
                return;
            }
            _ => {}
        }

        self.flush_text();
        let Some(frame) = self.stack.pop() else { return };
        let children = frame.children;

        let element: Option<AnyElement> = match &frame.tag {
            MarkdownTag::Paragraph => Some(block(children).into_any_element()),
            MarkdownTag::Heading(level) => {
                let (size, weight) = match level {
                    HeadingLevel::H1 => (px(22.), FontWeight::BOLD),
                    HeadingLevel::H2 => (px(19.), FontWeight::BOLD),
                    HeadingLevel::H3 => (px(17.), FontWeight::SEMIBOLD),
                    HeadingLevel::H4 => (px(15.5), FontWeight::SEMIBOLD),
                    _ => (px(14.5), FontWeight::SEMIBOLD),
                };
                Some(
                    div()
                        .mt(px(6.))
                        .text_size(size)
                        .font_weight(weight)
                        .children(children)
                        .into_any_element(),
                )
            }
            MarkdownTag::BlockQuote(kind) => {
                self.color_stack.pop();
                let label = kind.map(|kind| {
                    let (text, color) = alert_label(kind, self.style);
                    div()
                        .text_size(px(12.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(color)
                        .child(text)
                        .into_any_element()
                });
                Some(
                    div()
                        .border_l_2()
                        .border_color(self.style.border)
                        .pl(px(12.))
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .children(label)
                        .children(children)
                        .into_any_element(),
                )
            }
            MarkdownTag::CodeBlock { lang, .. } => {
                self.code_block = self.code_block.saturating_sub(1);
                let code = SharedString::new(
                    std::mem::take(&mut self.code_buf)
                        .trim_end_matches('\n')
                        .to_string(),
                );
                self.counter += 1;
                let copy_id = ElementId::NamedInteger(
                    SharedString::new(format!("md-copy-{}", self.seed)),
                    self.counter as u64,
                );
                let header = div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .text_size(px(11.))
                    .text_color(self.style.muted_foreground)
                    .child(div().flex_1().min_w_0().child(lang.clone()))
                    .child(
                        div()
                            .id(copy_id)
                            .cursor_pointer()
                            .hover(|s| s.text_color(self.style.link))
                            .child("复制")
                            .on_click(move |_, _, cx: &mut App| {
                                cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                                    code.to_string(),
                                ));
                            }),
                    )
                    .into_any_element();
                let header = Some(header);
                Some(
                    div()
                        .my(px(2.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(self.style.border)
                        .bg(self.style.code_background)
                        .px(px(12.))
                        .py(px(8.))
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .text_size(px(12.5))
                        .children(header)
                        .children(children)
                        .into_any_element(),
                )
            }
            MarkdownTag::List(_) => {
                self.list_stack.pop();
                Some(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .children(children)
                        .into_any_element(),
                )
            }
            MarkdownTag::Item => {
                let marker: AnyElement = match frame.item_marker {
                    Some(Marker::Ordered(n)) => div()
                        .text_color(self.style.muted_foreground)
                        .child(format!("{n}."))
                        .into_any_element(),
                    Some(Marker::Task(checked)) => div()
                        .text_color(if checked {
                            self.style.link
                        } else {
                            self.style.muted_foreground
                        })
                        .child(if checked { "☑" } else { "☐" })
                        .into_any_element(),
                    Some(Marker::Bullet(depth)) => div()
                        .text_color(self.style.muted_foreground)
                        .child(match depth {
                            0 => "•",
                            1 => "◦",
                            _ => "▪",
                        })
                        .into_any_element(),
                    None => div().into_any_element(),
                };
                Some(
                    div()
                        .flex()
                        .flex_row()
                        .items_start()
                        .gap(px(8.))
                        .child(div().flex_shrink_0().child(marker))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .gap(px(3.))
                                .children(children),
                        )
                        .into_any_element(),
                )
            }
            MarkdownTag::Table(_) => self.tables.pop().map(|t| self.render_table(t)),
            MarkdownTag::TableHead => {
                if let Some(t) = self.tables.last_mut() {
                    t.in_head = false;
                    t.head = std::mem::take(&mut t.cells);
                }
                None
            }
            MarkdownTag::TableRow => {
                if let Some(t) = self.tables.last_mut() {
                    let row = std::mem::take(&mut t.cells);
                    t.rows.push(row);
                }
                None
            }
            MarkdownTag::TableCell => {
                if let Some(t) = self.tables.last_mut() {
                    t.cells.push(block(children).into_any_element());
                }
                None
            }
            MarkdownTag::FootnoteDefinition(label) => Some(
                div()
                    .text_size(px(12.5))
                    .text_color(self.style.muted_foreground)
                    .flex()
                    .flex_row()
                    .gap(px(6.))
                    .child(div().flex_shrink_0().child(format!("[{label}]")))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(3.))
                            .children(children),
                    )
                    .into_any_element(),
            ),
            MarkdownTag::HtmlBlock => Some(block(children).into_any_element()),
            MarkdownTag::MetadataBlock => None,
            // Inline tags handled above.
            _ => Some(block(children).into_any_element()),
        };

        if let Some(element) = element {
            self.push_element(element);
        }
    }

    fn render_table(&self, t: TableCtx) -> AnyElement {
        let cols = t.alignments.len().max(1);
        let head_bg = self.style.table_head_background;
        // A still-streaming tail row may have fewer cells than columns; pad
        // so earlier cells keep their widths.
        let row = move |cells: Vec<AnyElement>, head: bool| {
            let missing = cols.saturating_sub(cells.len());
            let mut r = div().flex().flex_row().w_full();
            if head {
                r = r.bg(head_bg).font_weight(FontWeight::SEMIBOLD);
            }
            r.children(
                cells
                    .into_iter()
                    .map(|c| div().flex_1().min_w_0().px(px(10.)).py(px(5.)).child(c)),
            )
            .children((0..missing).map(|_| div().flex_1().min_w_0()))
        };

        let mut table = div()
            .my(px(2.))
            .w_full()
            .rounded(px(6.))
            .border_1()
            .border_color(self.style.border)
            .overflow_hidden()
            .flex()
            .flex_col();
        if !t.head.is_empty() {
            table = table.child(row(t.head, true));
        }
        for r in t.rows {
            table = table.child(
                div()
                    .border_t_1()
                    .border_color(self.style.border)
                    .child(row(r, false)),
            );
        }
        table.into_any_element()
    }

    fn push_element(&mut self, element: AnyElement) {
        match self.stack.last_mut() {
            Some(frame) => frame.children.push(element),
            None => self.root.push(element),
        }
    }
}

fn block(children: Vec<AnyElement>) -> Div {
    div().flex().flex_col().gap(px(3.)).children(children)
}

fn alert_label(kind: BlockQuoteKind, style: &MarkdownStyle) -> (&'static str, Hsla) {
    match kind {
        BlockQuoteKind::Note => ("ℹ 说明", style.link),
        BlockQuoteKind::Tip => ("💡 提示", style.link),
        BlockQuoteKind::Important => ("❗ 重要", style.link),
        BlockQuoteKind::Warning => ("⚠ 注意", style.link),
        BlockQuoteKind::Caution => ("🛑 当心", style.link),
    }
}
