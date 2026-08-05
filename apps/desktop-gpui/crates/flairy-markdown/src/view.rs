//! Custom element wrapping the markdown tree with source-offset text
//! selection: I-beam cursor, drag-to-select painted as quads under the text,
//! and cmd-c copying the selected slice of the markdown source.
//!
//! Selection is stored on [`MarkdownState`] as byte offsets into
//! `parsed.source`, so it survives streaming reparses; geometry is resolved
//! per frame from the retained [`gpui::TextLayout`] handles captured at
//! build time.

use crate::element::{build_markdown, MarkdownStyle, RenderedText};
use crate::state::MarkdownState;
use crate::CopyMarkdown;
use gpui::{
    div, fill, point, px, AnyElement, App, Bounds, ClipboardItem, CursorStyle, DispatchPhase,
    Element, ElementId, Entity, GlobalElementId, Hitbox, HitboxBehavior, InspectorElementId,
    InteractiveElement, IntoElement, LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, ParentElement, Pixels, Point, Window,
};
use std::ops::Range;
use std::rc::Rc;

pub struct MarkdownView {
    state: Entity<MarkdownState>,
    style: MarkdownStyle,
    seed: usize,
}

impl MarkdownView {
    pub fn new(state: Entity<MarkdownState>, style: MarkdownStyle, seed: usize) -> Self {
        Self { state, style, seed }
    }
}

pub struct MarkdownLayout {
    child: AnyElement,
    texts: Rc<Vec<RenderedText>>,
}

impl Element for MarkdownView {
    type RequestLayoutState = MarkdownLayout;
    type PrepaintState = Hitbox;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, MarkdownLayout) {
        let parsed = self.state.read(cx).parsed().clone();
        let focus_handle = self.state.read(cx).focus_handle().clone();
        let (tree, texts) = build_markdown(self.seed, &parsed, &self.style, window);
        // The focusable wrapper routes the cmd-c CopyMarkdown action here
        // once a click has focused this view.
        let mut child = div()
            .key_context("MarkdownView")
            .track_focus(&focus_handle)
            .on_action({
                let state = self.state.clone();
                move |_: &CopyMarkdown, _window, cx: &mut App| {
                    if let Some(text) = state.read(cx).selected_source() {
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                    }
                }
            })
            .child(tree)
            .into_any_element();
        let layout_id = child.request_layout(window, cx);
        (
            layout_id,
            MarkdownLayout {
                child,
                texts: Rc::new(texts),
            },
        )
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        layout: &mut MarkdownLayout,
        window: &mut Window,
        cx: &mut App,
    ) -> Hitbox {
        layout.child.prepaint(window, cx);
        window.insert_hitbox(bounds, HitboxBehavior::Normal)
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        layout: &mut MarkdownLayout,
        hitbox: &mut Hitbox,
        window: &mut Window,
        cx: &mut App,
    ) {
        window.set_cursor_style(CursorStyle::IBeam, hitbox);

        // Selection underlay, then the text on top of it.
        if let Some(selection) = self.state.read(cx).selection() {
            for rect in selection_rects(&layout.texts, &selection) {
                window.paint_quad(fill(rect, self.style.selection));
            }
        }
        layout.child.paint(window, cx);

        let texts = layout.texts.clone();
        {
            let state = self.state.clone();
            let texts = texts.clone();
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble || event.button != MouseButton::Left {
                    return;
                }
                if hitbox.is_hovered(window) {
                    window.focus(state.read(cx).focus_handle());
                    match source_index_at(&texts, event.position, false) {
                        Some(index) => state.update(cx, |s, cx| s.begin_selection(index, cx)),
                        None => state.update(cx, |s, cx| s.clear_selection(cx)),
                    }
                } else if state.read(cx).selection().is_some() {
                    // Clicking elsewhere (e.g. the composer) drops the selection.
                    state.update(cx, |s, cx| s.clear_selection(cx));
                }
            });
        }
        {
            let state = self.state.clone();
            let texts = texts.clone();
            window.on_mouse_event(move |event: &MouseMoveEvent, phase, _window, cx| {
                if phase != DispatchPhase::Bubble
                    || event.pressed_button != Some(MouseButton::Left)
                    || !state.read(cx).selecting()
                {
                    return;
                }
                if let Some(index) = source_index_at(&texts, event.position, true) {
                    state.update(cx, |s, cx| s.extend_selection(index, cx));
                }
            });
        }
        {
            let state = self.state.clone();
            window.on_mouse_event(move |_: &MouseUpEvent, phase, _window, cx| {
                if phase == DispatchPhase::Bubble && state.read(cx).selecting() {
                    state.update(cx, |s, _| s.end_selection());
                }
            });
        }
    }
}

impl IntoElement for MarkdownView {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

/// Map a window position to a source offset. With `clamp`, positions outside
/// any text snap to the nearest text's nearest index (used while dragging).
fn source_index_at(
    texts: &[RenderedText],
    position: Point<Pixels>,
    clamp: bool,
) -> Option<usize> {
    let mut nearest: Option<(Pixels, usize)> = None;
    for rt in texts {
        if rt.segs.is_empty() {
            continue;
        }
        match rt.layout.index_for_position(position) {
            Ok(index) => return Some(display_to_source(rt, index)),
            Err(near) => {
                if clamp {
                    let bounds = rt.layout.bounds();
                    let dy = if position.y < bounds.top() {
                        bounds.top() - position.y
                    } else if position.y > bounds.bottom() {
                        position.y - bounds.bottom()
                    } else {
                        px(0.)
                    };
                    if nearest.is_none_or(|(best, _)| dy < best) {
                        nearest = Some((dy, display_to_source(rt, near)));
                    }
                }
            }
        }
    }
    nearest.map(|(_, index)| index)
}

fn display_to_source(rt: &RenderedText, display_index: usize) -> usize {
    for (disp, src) in &rt.segs {
        if display_index < disp.start {
            return src.start;
        }
        if display_index < disp.end {
            return (src.start + (display_index - disp.start)).min(src.end);
        }
    }
    rt.segs.last().map_or(0, |(_, src)| src.end)
}

/// Display sub-range of one text element covered by a source selection.
fn display_range_for_source(rt: &RenderedText, sel: &Range<usize>) -> Option<Range<usize>> {
    let mut start = None;
    let mut end = None;
    for (disp, src) in &rt.segs {
        if src.end <= sel.start || src.start >= sel.end {
            continue;
        }
        let disp_len = disp.end - disp.start;
        let s = disp.start + sel.start.saturating_sub(src.start).min(disp_len);
        let e = disp.start + (sel.end - src.start).min(disp_len);
        start.get_or_insert(s);
        end = Some(e);
    }
    match (start, end) {
        (Some(s), Some(e)) if e > s => Some(s..e),
        _ => None,
    }
}

/// Standard three-rect model per text element: head line to the right edge,
/// full-width middle lines, tail line from the left edge.
fn selection_rects(texts: &[RenderedText], sel: &Range<usize>) -> Vec<Bounds<Pixels>> {
    let mut rects = Vec::new();
    for rt in texts {
        let Some(range) = display_range_for_source(rt, sel) else {
            continue;
        };
        let layout = &rt.layout;
        let (Some(start), Some(end)) = (
            layout.position_for_index(range.start),
            layout.position_for_index(range.end),
        ) else {
            continue;
        };
        let line_height = layout.line_height();
        let bounds = layout.bounds();
        if start.y == end.y {
            rects.push(Bounds::from_corners(start, point(end.x, end.y + line_height)));
        } else {
            rects.push(Bounds::from_corners(
                start,
                point(bounds.right(), start.y + line_height),
            ));
            if end.y > start.y + line_height {
                rects.push(Bounds::from_corners(
                    point(bounds.left(), start.y + line_height),
                    point(bounds.right(), end.y),
                ));
            }
            rects.push(Bounds::from_corners(
                point(bounds.left(), end.y),
                point(end.x, end.y + line_height),
            ));
        }
    }
    rects
}
