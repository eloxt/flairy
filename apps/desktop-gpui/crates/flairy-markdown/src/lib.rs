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

pub use element::{render_markdown, MarkdownStyle};
pub use events::{parse_markdown, MarkdownEvent, MarkdownTag, MarkdownTagEnd, ParsedMarkdown};
pub use highlight::CodeSpan;
pub use remend::remend;
pub use state::MarkdownState;

/// Sentinel href given to links whose destination has not fully streamed in
/// yet. The renderer shows them styled but inert.
pub const INCOMPLETE_LINK: &str = "flairy:incomplete-link";
