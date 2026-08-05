//! GPUI entity owning a streaming markdown document.
//!
//! Throttling model (no fixed debounce anywhere):
//! - A ~60 Hz reveal buffer drains appended network chunks smoothly: each
//!   tick reveals `pending / 200ms` worth of bytes (UTF-8 boundary snapped),
//!   so lumpy deltas render as an even typewriter stream.
//! - Parsing is full-document on a background thread with single-in-flight
//!   coalescing: while one parse runs, any number of newer revisions collapse
//!   into exactly one follow-up parse. Self-tuning as documents grow.
//! - While streaming, the revealed prefix goes through [`remend`] tail repair
//!   before parsing; `finish()` switches to static mode and reparses raw.

use crate::events::{parse_markdown, ParsedMarkdown};
use crate::remend::remend;
use gpui::{AppContext as _, Context, FocusHandle, SharedString, Task, WeakEntity};
use std::ops::Range;
use std::sync::Mutex;
use std::time::Duration;

/// The one message that currently owns a text selection; starting a drag in
/// one message clears the previous owner's selection.
static SELECTION_OWNER: Mutex<Option<WeakEntity<MarkdownState>>> = Mutex::new(None);

const REVEAL_TICK: Duration = Duration::from_millis(16);
/// Time to fully drain the pending buffer, in ticks (200ms / 16ms).
const REVEAL_TICKS: usize = 12;

pub struct MarkdownState {
    /// Full text received so far; may be ahead of what is revealed.
    source: String,
    /// Byte length of the revealed prefix of `source`.
    revealed: usize,
    streaming: bool,
    parsed: ParsedMarkdown,
    pending_parse: Option<Task<()>>,
    should_reparse: bool,
    reveal_task: Option<Task<()>>,
    /// Byte range into `parsed.source` (kept across reparses, clamped on use).
    selection: Option<Range<usize>>,
    selection_anchor: Option<usize>,
    /// Focused on click so the cmd-c copy action dispatches to this view.
    focus_handle: FocusHandle,
}

impl MarkdownState {
    /// An empty document in streaming mode; feed it with [`Self::append`].
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            source: String::new(),
            revealed: 0,
            streaming: true,
            parsed: ParsedMarkdown::default(),
            pending_parse: None,
            should_reparse: false,
            reveal_task: None,
            selection: None,
            selection_anchor: None,
            focus_handle: cx.focus_handle(),
        }
    }

    /// A complete document (history hydration); parsed synchronously so the
    /// first frame is never blank.
    pub fn new_static(text: impl Into<String>, cx: &mut Context<Self>) -> Self {
        let source: String = text.into();
        Self {
            revealed: source.len(),
            streaming: false,
            parsed: parse_markdown(SharedString::new(source.clone())),
            source,
            pending_parse: None,
            should_reparse: false,
            reveal_task: None,
            selection: None,
            selection_anchor: None,
            focus_handle: cx.focus_handle(),
        }
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus_handle
    }

    // ---- text selection (byte offsets into parsed.source) ----

    /// The active selection, clamped to the current parse and char
    /// boundaries; `None` when empty.
    pub fn selection(&self) -> Option<Range<usize>> {
        let range = self.selection.clone()?;
        let source = self.parsed.source.as_ref();
        let start = floor_char_boundary(source, range.start.min(source.len()));
        let end = floor_char_boundary(source, range.end.min(source.len()));
        (start < end).then_some(start..end)
    }

    /// Whether a drag is in progress.
    pub fn selecting(&self) -> bool {
        self.selection_anchor.is_some()
    }

    pub fn begin_selection(&mut self, index: usize, cx: &mut Context<Self>) {
        let previous = SELECTION_OWNER
            .lock()
            .unwrap()
            .replace(cx.weak_entity());
        if let Some(previous) = previous {
            if previous.entity_id() != cx.entity().entity_id() {
                previous
                    .update(cx, |state, cx| {
                        state.selection = None;
                        state.selection_anchor = None;
                        cx.notify();
                    })
                    .ok();
            }
        }
        self.selection_anchor = Some(index);
        self.selection = Some(index..index);
        cx.notify();
    }

    pub fn extend_selection(&mut self, index: usize, cx: &mut Context<Self>) {
        if let Some(anchor) = self.selection_anchor {
            self.selection = Some(anchor.min(index)..anchor.max(index));
            cx.notify();
        }
    }

    /// Ends the drag, keeping the selected range.
    pub fn end_selection(&mut self) {
        self.selection_anchor = None;
    }

    pub fn clear_selection(&mut self, cx: &mut Context<Self>) {
        self.selection_anchor = None;
        if self.selection.take().is_some() {
            cx.notify();
        }
    }

    /// The selected slice of the (markdown) source, for the clipboard.
    pub fn selected_source(&self) -> Option<String> {
        self.selection()
            .map(|range| self.parsed.source[range].to_string())
    }

    /// Latest completed parse. May lag `source` by design; stays on the
    /// previous content until the next parse lands (no blank flashes).
    pub fn parsed(&self) -> &ParsedMarkdown {
        &self.parsed
    }

    /// True while streaming and nothing has been revealed yet.
    pub fn is_pending(&self) -> bool {
        self.streaming && self.parsed.events.is_empty()
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn append(&mut self, text: &str, cx: &mut Context<Self>) {
        if text.is_empty() {
            return;
        }
        self.source.push_str(text);
        self.streaming = true;
        if self.reveal_task.is_none() {
            self.reveal_task = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(REVEAL_TICK).await;
                    let caught_up = this
                        .update(cx, |this, cx| this.tick_reveal(cx))
                        .unwrap_or(true);
                    if caught_up {
                        break;
                    }
                }
            }));
        }
    }

    /// Replace the whole document (e.g. session switch reusing the entity).
    pub fn reset(&mut self, text: impl Into<String>, streaming: bool, cx: &mut Context<Self>) {
        self.source = text.into();
        self.revealed = self.source.len();
        self.streaming = streaming;
        self.reveal_task = None;
        self.parse(cx);
    }

    /// The stream ended: flush the reveal buffer and reparse without repair.
    pub fn finish(&mut self, cx: &mut Context<Self>) {
        self.streaming = false;
        self.revealed = self.source.len();
        self.reveal_task = None;
        self.parse(cx);
    }

    /// Reveal one tick's worth of pending bytes. Returns true when caught up
    /// (the reveal task then parks itself; `append` restarts it).
    fn tick_reveal(&mut self, cx: &mut Context<Self>) -> bool {
        let pending = self.source.len() - self.revealed;
        if pending == 0 {
            self.reveal_task = None;
            return true;
        }
        let step = (pending / REVEAL_TICKS).max(1);
        self.revealed = ceil_char_boundary(&self.source, self.revealed + step);
        self.parse(cx);
        if self.revealed == self.source.len() {
            self.reveal_task = None;
            true
        } else {
            false
        }
    }

    fn parse(&mut self, cx: &mut Context<Self>) {
        if self.pending_parse.is_some() {
            self.should_reparse = true;
            return;
        }
        self.should_reparse = false;
        let text = self.source[..self.revealed].to_string();
        let streaming = self.streaming;
        self.pending_parse = Some(cx.spawn(async move |this, cx| {
            let parsed = cx
                .background_spawn(async move {
                    let text = if streaming { remend(&text) } else { text };
                    parse_markdown(SharedString::new(text))
                })
                .await;
            this.update(cx, |this, cx| {
                this.parsed = parsed;
                this.pending_parse = None;
                if this.should_reparse {
                    this.parse(cx);
                }
                cx.notify();
            })
            .ok();
        }));
    }
}

fn ceil_char_boundary(s: &str, mut index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    while !s.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn floor_char_boundary(s: &str, mut index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    while index > 0 && !s.is_char_boundary(index) {
        index -= 1;
    }
    index
}
