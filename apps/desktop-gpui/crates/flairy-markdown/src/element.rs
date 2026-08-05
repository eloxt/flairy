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
    /// Text-selection highlight color (translucent).
    pub selection: Hsla,
    /// Citation id → source URL. When non-empty, inline `[n]` / `[n,m]`
    /// references whose ids all resolve render as clickable chips.
    pub citations: std::collections::HashMap<u64, SharedString>,
    /// Host hook for custom fences (e.g. `ui:*` cards): (lang, body) →
    /// element. Returning None renders a subtle placeholder (streaming /
    /// unparseable body). Fences it claims never render as code blocks.
    pub fence_renderer: Option<std::rc::Rc<dyn Fn(&str, &str) -> Option<AnyElement>>>,
}

/// One flushed text element: its retained layout handle plus the mapping
/// from display offsets back to `parsed.source` offsets. Used by
/// [`crate::MarkdownView`] for hit-testing and selection painting.
pub struct RenderedText {
    pub layout: gpui::TextLayout,
    /// (display range, source range), sorted, non-overlapping. Display and
    /// source lengths may differ (substituted text, inline-code backticks).
    pub segs: Vec<(std::ops::Range<usize>, std::ops::Range<usize>)>,
}

/// Build the element tree and the flushed text layouts (for selection).
pub(crate) fn build_markdown(
    seed: usize,
    parsed: &ParsedMarkdown,
    style: &MarkdownStyle,
    window: &Window,
) -> (AnyElement, Vec<RenderedText>) {
    Builder::new(seed, parsed, style, window.text_style()).run()
}

/// Find the next `[n]` / `[n, m]` reference at/after `from` whose ids ALL
/// resolve in `citations`; returns its byte range and the first id's URL.
/// Unresolvable or malformed brackets are left as plain text.
fn next_citation(
    s: &str,
    from: usize,
    citations: &std::collections::HashMap<u64, SharedString>,
) -> Option<(std::ops::Range<usize>, SharedString)> {
    let bytes = s.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] != b'[' {
            i += 1;
            continue;
        }
        // Parse [digits(,digits)*] with optional spaces after commas.
        let mut j = i + 1;
        let mut ids: Vec<u64> = Vec::new();
        let mut current: Option<u64> = None;
        let mut ok = false;
        while j < bytes.len() {
            match bytes[j] {
                b'0'..=b'9' => {
                    let digit = (bytes[j] - b'0') as u64;
                    current = Some(current.unwrap_or(0).saturating_mul(10) + digit);
                }
                b',' => {
                    match current.take() {
                        Some(id) => ids.push(id),
                        None => break, // "[," — not a citation
                    }
                }
                b' ' if current.is_none() => {} // space after comma
                b']' => {
                    if let Some(id) = current.take() {
                        ids.push(id);
                        ok = true;
                    }
                    break;
                }
                _ => break,
            }
            j += 1;
        }
        if ok && !ids.is_empty() && ids.iter().all(|id| citations.contains_key(id)) {
            let url = citations.get(&ids[0]).cloned()?;
            return Some((i..j + 1, url));
        }
        i += 1;
    }
    None
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
    /// Display↔source mapping for the text being accumulated.
    cur_maps: Vec<(std::ops::Range<usize>, std::ops::Range<usize>)>,
    /// All flushed text elements, in document order.
    rendered: Vec<RenderedText>,

    // Inline state.
    bold: usize,
    italic: usize,
    strike: usize,
    code_block: usize,
    /// Current code block is a custom fence (ui:* card): body accumulates in
    /// code_buf only, never as display text.
    card_fence: bool,
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
            cur_maps: Vec::new(),
            rendered: Vec::new(),
            bold: 0,
            italic: 0,
            strike: 0,
            code_block: 0,
            card_fence: false,
            color_stack: vec![base_color],
            list_stack: Vec::new(),
        }
    }

    fn run(mut self) -> (AnyElement, Vec<RenderedText>) {
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
                        self.push_text_with_citations(&text, range.clone());
                    }
                }
                MarkdownEvent::SubstitutedText(text) => {
                    let text = text.clone();
                    self.push_mapped(&text, false, None, Some(range.clone()))
                }
                MarkdownEvent::Code(text)
                | MarkdownEvent::InlineMath(text)
                | MarkdownEvent::DisplayMath(text) => {
                    let text = text.clone();
                    self.push_mapped(&text, true, None, Some(range.clone()))
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
                    self.push_mapped(&text, false, None, Some(range.clone()));
                }
                MarkdownEvent::FootnoteReference(label) => {
                    let text = format!("[{label}]");
                    self.push_mapped(&text, false, None, Some(range.clone()));
                }
                MarkdownEvent::SoftBreak | MarkdownEvent::HardBreak => {
                    self.push_mapped("\n", false, None, Some(range.clone()))
                }
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
        let element = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .children(root)
            .into_any_element();
        (element, self.rendered)
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
        self.push_mapped(s, mono, None, None);
    }

    /// Plain text push that turns resolvable `[n]` / `[n,m]` citation
    /// references into clickable chips (link to the first id's source).
    /// `s` must be the exact source slice at `src` so offsets map 1:1.
    fn push_text_with_citations(&mut self, s: &str, src: std::ops::Range<usize>) {
        if self.style.citations.is_empty() || !self.open_links.is_empty() {
            self.push_mapped(s, false, None, Some(src));
            return;
        }
        let mut cursor = 0usize;
        while let Some((range, url)) = next_citation(s, cursor, &self.style.citations) {
            if range.start > cursor {
                self.push_mapped(
                    &s[cursor..range.start],
                    false,
                    None,
                    Some(src.start + cursor..src.start + range.start),
                );
            }
            self.push_chip(
                &s[range.clone()],
                url,
                src.start + range.start..src.start + range.end,
            );
            cursor = range.end;
        }
        if cursor < s.len() {
            self.push_mapped(&s[cursor..], false, None, Some(src.start + cursor..src.end));
        }
    }

    /// One citation chip: link-colored, subtle background, clickable.
    fn push_chip(&mut self, s: &str, url: SharedString, src: std::ops::Range<usize>) {
        let display_start = self.text.len();
        self.text.push_str(s);
        let style = SegStyle {
            mono: false,
            bold: false,
            italic: false,
            strike: false,
            link: false, // colored but not underlined
            color: self.style.link,
            background: Some(self.style.code_background),
        };
        match self.segs.last_mut() {
            Some((len, last)) if *last == style => *len += s.len(),
            _ => self.segs.push((s.len(), style)),
        }
        self.links.push((display_start..display_start + s.len(), url));
        match self.cur_maps.last_mut() {
            Some((disp, source)) if disp.end == display_start && source.end == src.start => {
                disp.end = display_start + s.len();
                source.end = src.end;
            }
            _ => self.cur_maps.push((display_start..display_start + s.len(), src)),
        }
    }

    fn push_mapped(
        &mut self,
        s: &str,
        mono: bool,
        color_override: Option<Hsla>,
        src: Option<std::ops::Range<usize>>,
    ) {
        if s.is_empty() {
            return;
        }
        let style = self.cur_style(mono, color_override);
        let display_start = self.text.len();
        self.text.push_str(s);
        match self.segs.last_mut() {
            Some((len, last)) if *last == style => *len += s.len(),
            _ => self.segs.push((s.len(), style)),
        }
        if let Some(src) = src {
            match self.cur_maps.last_mut() {
                // Extend when both display and source are contiguous.
                Some((disp, source)) if disp.end == display_start && source.end == src.start => {
                    disp.end = display_start + s.len();
                    source.end = src.end;
                }
                _ => self.cur_maps.push((display_start..display_start + s.len(), src)),
            }
        }
    }

    /// Code-block text: split the source range along precomputed highlight
    /// spans and emit each slice with its theme-appropriate color.
    fn push_code_text(&mut self, range: std::ops::Range<usize>) {
        let source = self.parsed.source.clone();
        self.code_buf.push_str(&source[range.clone()]);
        if self.card_fence {
            return; // card body: data for the fence renderer, not display text
        }
        let spans = self.parsed.code_spans.clone();
        let mut idx = spans.partition_point(|(r, _)| r.end <= range.start);
        let mut cursor = range.start;
        while cursor < range.end {
            match spans.get(idx) {
                Some((r, span)) if r.start <= cursor => {
                    let end = r.end.min(range.end);
                    let color = if self.style.is_dark { span.dark } else { span.light };
                    self.push_mapped(&source[cursor..end], true, Some(color), Some(cursor..end));
                    cursor = end;
                    if r.end <= cursor {
                        idx += 1;
                    }
                }
                Some((r, _)) if r.start < range.end => {
                    self.push_mapped(&source[cursor..r.start], true, None, Some(cursor..r.start));
                    cursor = r.start;
                }
                _ => {
                    self.push_mapped(
                        &source[cursor..range.end],
                        true,
                        None,
                        Some(cursor..range.end),
                    );
                    cursor = range.end;
                }
            }
        }
    }

    fn flush_text(&mut self) {
        if self.text.is_empty() {
            self.segs.clear();
            self.cur_maps.clear();
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
            // Keep the source mapping consistent with the trimmed text.
            let len = self.text.len();
            while let Some((disp, src)) = self.cur_maps.last_mut() {
                if disp.start >= len {
                    self.cur_maps.pop();
                } else {
                    if disp.end > len {
                        src.end = src.end.saturating_sub(disp.end - len).max(src.start);
                        disp.end = len;
                    }
                    break;
                }
            }
            if self.text.is_empty() {
                self.segs.clear();
                self.cur_maps.clear();
                return;
            }
        }

        let text = std::mem::take(&mut self.text);
        let segs = std::mem::take(&mut self.segs);
        let links = std::mem::take(&mut self.links);
        let maps = std::mem::take(&mut self.cur_maps);
        // A link left open across a flush (shouldn't happen for well-formed
        // inline content) restarts in the next text element.
        for (start, _) in self.open_links.iter_mut() {
            *start = 0;
        }

        let runs: Vec<TextRun> = segs.iter().map(|(len, s)| self.make_run(*len, s)).collect();
        let styled = StyledText::new(text).with_runs(runs);
        self.rendered.push(RenderedText {
            layout: styled.layout().clone(),
            segs: maps,
        });

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
            MarkdownTag::CodeBlock { lang, .. } => {
                self.code_block += 1;
                self.code_buf.clear();
                self.card_fence =
                    self.style.fence_renderer.is_some() && lang.starts_with("ui:");
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
                if self.card_fence {
                    self.card_fence = false;
                    let body = std::mem::take(&mut self.code_buf);
                    let rendered = self
                        .style
                        .fence_renderer
                        .as_ref()
                        .and_then(|render| render(lang.as_ref(), &body));
                    let element = rendered.unwrap_or_else(|| {
                        // Streaming / unparseable: subtle placeholder.
                        div()
                            .my(px(2.))
                            .h(px(36.))
                            .rounded(px(6.))
                            .border_1()
                            .border_color(self.style.border)
                            .bg(self.style.code_background)
                            .into_any_element()
                    });
                    self.push_element(element);
                    return;
                }
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

#[cfg(test)]
mod tests {
    use super::next_citation;
    use gpui::SharedString;
    use std::collections::HashMap;

    fn citations(ids: &[u64]) -> HashMap<u64, SharedString> {
        ids.iter().map(|id| (*id, SharedString::from(format!("https://e.com/{id}")))).collect()
    }

    #[test]
    fn finds_resolvable_citations_only() {
        let map = citations(&[1, 2, 12]);
        // Single id.
        let (range, url) = next_citation("见 [1] 处", 0, &map).unwrap();
        assert_eq!(&"见 [1] 处"[range], "[1]");
        assert_eq!(url.as_ref(), "https://e.com/1");
        // Multi-id links to the first.
        let (range, url) = next_citation("both [1,2] here", 0, &map).unwrap();
        assert_eq!(&"both [1,2] here"[range], "[1,2]");
        assert_eq!(url.as_ref(), "https://e.com/1");
        // Space after comma.
        let (range, _) = next_citation("x [1, 12]", 0, &map).unwrap();
        assert_eq!(&"x [1, 12]"[range], "[1, 12]");
        // Unresolvable id → skipped; later resolvable one still found.
        let (range, _) = next_citation("[9] then [2]", 0, &map).unwrap();
        assert_eq!(&"[9] then [2]"[range], "[2]");
        // Not citations at all.
        assert!(next_citation("[abc] [1a] [] [,1]", 0, &map).is_none());
        // Markdown links are untouched (the [text](url) bracket has letters).
        assert!(next_citation("[link](https://x)", 0, &map).is_none());
        // Respects the from offset.
        assert!(next_citation("[1] only", 4, &map).is_none());
    }
}
