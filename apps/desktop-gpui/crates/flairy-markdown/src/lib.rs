//! Streaming-first markdown rendering for GPUI.
//!
//! Pipeline: token deltas → [`MarkdownState`] (reveal buffer + coalesced
//! background parse, with [`remend`] tail repair while streaming) → owned
//! event vector ([`events`]) → GPUI elements ([`element`]).

mod element;
mod events;
mod highlight;
mod remend;
mod state;
mod view;

pub use element::MarkdownStyle;
pub use events::{parse_markdown, MarkdownEvent, MarkdownTag, MarkdownTagEnd, ParsedMarkdown};
pub use highlight::CodeSpan;
pub use remend::remend;
pub use state::MarkdownState;
pub use view::MarkdownView;

/// Sentinel href given to links whose destination has not fully streamed in
/// yet. The renderer shows them styled but inert.
pub const INCOMPLETE_LINK: &str = "flairy:incomplete-link";

gpui::actions!(flairy_markdown, [CopyMarkdown]);

/// Register key bindings (cmd-c copies the selected markdown source when a
/// markdown view has focus). Call once at app startup.
pub fn init(cx: &mut gpui::App) {
    cx.bind_keys([gpui::KeyBinding::new(
        if cfg!(target_os = "macos") { "cmd-c" } else { "ctrl-c" },
        CopyMarkdown,
        Some("MarkdownView"),
    )]);
}
