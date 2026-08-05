use gpui::prelude::FluentBuilder;
use gpui::{
    Context, Entity, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
    Styled, Window, WindowControlArea, div, px,
};
use gpui::SharedString;
use gpui_component::input::Input;
use gpui_component::spinner::Spinner;
use gpui_component::{Icon, Sizable, h_flex, v_flex};

use crate::app::{FlairyApp, Msg, TextWeight};
use crate::theme;

fn icon(path: &'static str) -> Icon {
    Icon::empty().path(path)
}

impl FlairyApp {
    pub fn render_main(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);

        div()
            .flex_1()
            .min_w_0()
            .border_l_1()
            .border_color(p.sidebar_border)
            .bg(p.background)
            .overflow_hidden()
            .flex()
            .flex_col()
            .child(self.render_header(cx))
            .child(self.render_thread(window, cx))
            .child(self.render_composer(cx))
    }

    fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);
        let title = crate::app::shared(&self.active().title);

        h_flex()
            .h(px(48.))
            .flex_shrink_0()
            .border_b_1()
            .border_color(p.sidebar_border)
            .items_center()
            .gap(px(10.))
            .when(self.sidebar_open, |s| s.pl(px(12.)))
            .when(!self.sidebar_open, |s| s.pl(px(80.))) // clear traffic lights
            .pr(px(16.))
            .window_control_area(WindowControlArea::Drag)
            .child(
                div()
                    .id("toggle-sidebar")
                    .size(px(28.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(5.))
                    .text_color(p.muted_foreground)
                    .cursor_pointer()
                    .hover(|s| s.bg(p.accent).text_color(p.foreground))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.sidebar_open = !this.sidebar_open;
                        cx.notify();
                    }))
                    .child(icon("icons/panel-left.svg").size(px(16.))),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .font_semibold()
                    .child(title),
            )
            .child(
                div()
                    .id("toggle-right")
                    .size(px(28.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(5.))
                    .text_color(p.muted_foreground)
                    .cursor_pointer()
                    .hover(|s| s.bg(p.accent).text_color(p.foreground))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.right_open = !this.right_open;
                        cx.notify();
                    }))
                    .child(icon("icons/panel-right.svg").size(px(16.))),
            )
    }

    fn render_thread(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);
        let six = self.active_session;

        if self.active().msgs.is_empty() {
            return div()
                .flex_1()
                .min_h_0()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    v_flex()
                        .items_center()
                        .mt(px(-100.))
                        .gap(px(8.))
                        .child(
                            div()
                                .text_size(px(24.))
                                .font_medium()
                                .child("有什么可以帮你？"),
                        )
                        .child(
                            div()
                                .text_color(p.muted_foreground)
                                .child("我可以帮你查资料、写文档、整理文件"),
                        ),
                )
                .into_any_element();
        }

        // History loaded from the store/server has no markdown entity yet;
        // hydrate lazily on first render of the session.
        for msg in self.sessions[six].msgs.iter_mut() {
            if let Msg::Assistant { md, view: view @ None, .. } = msg {
                let text = md.clone();
                *view = Some(crate::app::markdown_view(Some(&text), cx));
            }
        }
        // Citation registry: every web tool result in this session maps its
        // ids to source URLs, so inline [n] references render as chips.
        let citations: std::collections::HashMap<u64, SharedString> = self.sessions[six]
            .msgs
            .iter()
            .filter_map(|m| match m {
                Msg::Tool { output: Some(output), .. } => crate::web_tools::parse_sources(output),
                _ => None,
            })
            .flatten()
            .map(|(id, _, url)| (id, SharedString::from(url)))
            .collect();
        // ui:* card fences render through the app's card renderer; suggestion
        // buttons send their text as the user's next message.
        let fence_renderer: std::rc::Rc<dyn Fn(&str, &str) -> Option<gpui::AnyElement>> = {
            let weak = cx.entity().downgrade();
            let palette = p.clone();
            let is_dark = crate::theme::is_dark(cx);
            let suggest: crate::cards::SuggestFn = std::rc::Rc::new(move |text, _window, cx| {
                if let Some(app) = weak.upgrade() {
                    app.update(cx, |this, cx| this.send_suggestion(text, cx));
                }
            });
            std::rc::Rc::new(move |lang, body| {
                crate::cards::render_card(lang, body, &palette, is_dark, suggest.clone())
            })
        };
        let md_style = flairy_markdown::MarkdownStyle {
            link: p.primary,
            muted_foreground: p.muted_foreground,
            border: p.border,
            code_background: p.secondary,
            table_head_background: p.secondary,
            mono_font: "IBM Plex Mono".into(),
            is_dark: crate::theme::is_dark(cx),
            selection: p.selection,
            citations,
            fence_renderer: Some(fence_renderer),
        };

        // Collect render data first to avoid borrowing self inside the loop.
        enum Row {
            User(SharedString),
            Assistant {
                view: Entity<flairy_markdown::MarkdownState>,
                thinking: bool,
                reasoning: Option<SharedString>,
                reasoning_open: bool,
            },
            Tool {
                label: SharedString,
                preview: SharedString,
                output: Option<SharedString>,
                expanded: bool,
                running: bool,
                is_error: bool,
            },
        }
        let queued: Vec<SharedString> =
            self.active().queued.iter().map(|q| crate::app::shared(q)).collect();
        let rows: Vec<Row> = self
            .active()
            .msgs
            .iter()
            .map(|msg| match msg {
                Msg::User(text) => Row::User(crate::app::shared(text)),
                Msg::Assistant { md, done, view, reasoning, reasoning_open } => Row::Assistant {
                    view: view.clone().expect("hydrated above"),
                    thinking: md.is_empty() && !done,
                    reasoning: (!reasoning.is_empty()).then(|| crate::app::shared(reasoning)),
                    reasoning_open: *reasoning_open,
                },
                Msg::Tool { label, preview, output, is_error, expanded, .. } => Row::Tool {
                    label: crate::app::shared(label),
                    preview: crate::app::shared(preview),
                    output: output
                        .as_ref()
                        .filter(|o| !o.is_empty())
                        .map(|o| crate::app::shared(o)),
                    expanded: *expanded,
                    running: output.is_none(),
                    is_error: *is_error,
                },
            })
            .collect();

        div()
            .id("thread")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .child(
                div().w_full().flex().justify_center().child(
                    v_flex()
                        .w_full()
                        .max_w(px(crate::settings::chat_width_px()))
                        .px(px(24.))
                        .pt(px(24.))
                        .pb(px(24.))
                        .line_height(px(23.))
                        .children(rows.into_iter().enumerate().map(|(mix, row)| {
                            match row {
                                Row::User(text) => user_bubble(text, &p).into_any_element(),
                                Row::Assistant { view, thinking, reasoning, reasoning_open } => {
                                    let disclosure = reasoning.map(|text| {
                                        reasoning_section(
                                            six,
                                            mix,
                                            text,
                                            reasoning_open,
                                            thinking,
                                            &p,
                                            cx,
                                        )
                                    });
                                    let body = if thinking {
                                        thinking_row(&p).into_any_element()
                                    } else {
                                        assistant_markdown(six, mix, view, &md_style, window, cx)
                                            .into_any_element()
                                    };
                                    v_flex()
                                        .children(disclosure)
                                        .child(body)
                                        .into_any_element()
                                }
                                Row::Tool { label, preview, output, expanded, running, is_error } => {
                                    tool_row(
                                        six, mix, label, preview, output, expanded, running,
                                        is_error, &p, cx,
                                    )
                                    .into_any_element()
                                }
                            }
                        }))
                        .children(queued.into_iter().map(|text| {
                            // Steered messages waiting for the current turn.
                            div().py(px(10.)).flex().justify_end().opacity(0.6).child(
                                v_flex()
                                    .items_end()
                                    .gap(px(2.))
                                    .child(
                                        div()
                                            .max_w(px(560.))
                                            .rounded(px(8.))
                                            .bg(p.secondary)
                                            .text_color(p.secondary_foreground)
                                            .px(px(16.))
                                            .py(px(10.))
                                            .child(text),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .text_color(p.muted_foreground)
                                            .child("已排队"),
                                    ),
                            )
                        })),
                ),
            )
            .into_any_element()
    }

    fn render_composer(&mut self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);

        v_flex()
            .flex_shrink_0()
            .border_t_1()
            .border_color(p.sidebar_border)
            .bg(p.background)
            .when(self.pending_approval.is_some(), |this| {
                                let (label, detail) = self
                                    .pending_approval
                                    .as_ref()
                                    .map(|r| (crate::app::shared(&r.label), crate::app::shared(&r.detail)))
                                    .unwrap_or_default();
                this.child(
                    v_flex()
                        .border_b_1()
                        .border_color(p.sidebar_border)
                        .bg(p.muted)
                                        .px(px(20.))
                                        .pt(px(12.))
                                        .pb(px(14.))
                                        .gap(px(6.))
                                        .child(
                                            h_flex()
                                                .gap(px(6.))
                                                .items_center()
                                                .text_size(px(12.))
                                                .child(icon("icons/shield-check.svg").size(px(14.)))
                                                .child(div().font_medium().child("允许这个操作吗？"))
                                                .child(div().text_color(p.muted_foreground).child(label)),
                                        )
                                        .child(
                                            div()
                                                .rounded(px(6.))
                                                .border_1()
                                                .border_color(p.border)
                                                .bg(p.card)
                                                .px(px(12.))
                                                .py(px(8.))
                                                .text_size(px(12.))
                                                .text_color(p.muted_foreground)
                                                .child(detail),
                                        )
                                        .child(
                                            h_flex()
                                                .gap(px(8.))
                                                .justify_end()
                                                .child(
                                                    div()
                                                        .id("deny")
                                                        .px(px(12.))
                                                        .py(px(4.))
                                                        .rounded(px(5.))
                                                        .border_1()
                                                        .border_color(p.border)
                                                        .text_size(px(12.))
                                                        .cursor_pointer()
                                                        .hover(|s| s.bg(p.accent))
                                                        .on_click(cx.listener(|this, _, _, cx| {
                                                            this.resolve_approval(crate::agent_runtime::ApprovalReply::Deny, cx)
                                                        }))
                                                        .child("拒绝"),
                                                )
                                                .child(
                                                    div()
                                                        .id("allow-once")
                                                        .px(px(12.))
                                                        .py(px(4.))
                                                        .rounded(px(5.))
                                                        .border_1()
                                                        .border_color(p.border)
                                                        .text_size(px(12.))
                                                        .cursor_pointer()
                                                        .hover(|s| s.bg(p.accent))
                                                        .on_click(cx.listener(|this, _, _, cx| {
                                                            this.resolve_approval(crate::agent_runtime::ApprovalReply::Once, cx)
                                                        }))
                                                        .child("允许一次"),
                                                )
                                                .child(
                                                    div()
                                                        .id("allow-always")
                                                        .px(px(16.))
                                                        .py(px(4.))
                                                        .rounded(px(5.))
                                                        .bg(p.primary)
                                                        .text_color(p.primary_foreground)
                                                        .text_size(px(12.))
                                                        .cursor_pointer()
                                                        .hover(|s| s.opacity(0.9))
                                                        .on_click(cx.listener(|this, _, _, cx| {
                                                            this.resolve_approval(crate::agent_runtime::ApprovalReply::Always, cx)
                                                        }))
                                                        .child("本次会话总是允许"),
                                                ),
                                        ),
                                )
                            })
            .when(self.pending_question.is_some(), |this| {
                this.child(self.question_card(cx))
            })
            .when_some(self.plan_card(cx), |this, card| this.child(card))
            .child(
                // input area: everything below the divider
                v_flex()
                    .relative()
                                    .when(!self.pending_attachments.is_empty(), |this| {
                                        let chips: Vec<(usize, SharedString)> = self
                                            .pending_attachments
                                            .iter()
                                            .enumerate()
                                            .map(|(ix, (_, _, name))| (ix, crate::app::shared(name)))
                                            .collect();
                                        this.child(
                                            h_flex()
                                                .px(px(20.))
                                                .pt(px(10.))
                                                .gap(px(6.))
                                                .flex_wrap()
                                                .children(chips.into_iter().map(|(aix, name)| {
                                                    h_flex()
                                                        .id(("attachment", aix))
                                                        .px(px(8.))
                                                        .py(px(3.))
                                                        .gap(px(6.))
                                                        .items_center()
                                                        .rounded(px(5.))
                                                        .border_1()
                                                        .border_color(p.border)
                                                        .bg(p.secondary)
                                                        .text_size(px(12.))
                                                        .child(icon("icons/paperclip.svg").size(px(12.)))
                                                        .child(
                                                            div()
                                                                .max_w(px(180.))
                                                                .truncate()
                                                                .child(name),
                                                        )
                                                        .child(
                                                            div()
                                                                .id(("attachment-x", aix))
                                                                .cursor_pointer()
                                                                .text_color(p.muted_foreground)
                                                                .hover(|s| s.text_color(p.foreground))
                                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                                    if aix < this.pending_attachments.len() {
                                                                        this.pending_attachments.remove(aix);
                                                                        cx.notify();
                                                                    }
                                                                }))
                                                                .child(icon("icons/x.svg").size(px(12.))),
                                                        )
                                                })),
                                        )
                                    })
                                    .child(
                                        div()
                                            .px(px(20.))
                                            .pt(px(14.))
                                            .pb(px(4.))
                                            .child(Input::new(&self.input).appearance(false)),
                                    )
                                    .child(
                                        h_flex()
                                            .gap(px(4.))
                                            .px(px(12.))
                                            .pb(px(10.))
                                            .items_center()
                                            .child(
                                                div()
                                                    .id("attach")
                                                    .size(px(32.))
                                                    .flex()
                                                    .items_center()
                                                    .justify_center()
                                                    .rounded(px(6.))
                                                    .text_color(p.muted_foreground)
                                                    .cursor_pointer()
                                                    .hover(|s| {
                                                        s.bg(p.accent).text_color(p.foreground)
                                                    })
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.attach_images(cx)
                                                    }))
                                                    .child(
                                                        icon("icons/paperclip.svg").size(px(16.)),
                                                    ),
                                            )
                                            .child(
                                                h_flex()
                                                    .id("model")
                                                    .h(px(32.))
                                                    .px(px(8.))
                                                    .gap(px(4.))
                                                    .items_center()
                                                    .rounded(px(6.))
                                                    .text_size(px(12.))
                                                    .text_color(p.muted_foreground)
                                                    .cursor_pointer()
                                                    .hover(|s| s.bg(p.accent))
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        // Swallow the click that just dismissed
                                                        // the menu via on_mouse_down_out.
                                                        if this
                                                            .model_menu_dismissed
                                                            .take()
                                                            .is_some_and(|t| t.elapsed().as_millis() < 400)
                                                        {
                                                            return;
                                                        }
                                                        this.model_menu_open = !this.model_menu_open;
                                                        cx.notify();
                                                    }))
                                                    .child(
                                                        self.effective_model()
                                                            .map(|o| crate::app::shared(&o.name))
                                                            .unwrap_or_else(|| "未配置模型".into()),
                                                    )
                                                    .child(
                                                        icon("icons/chevron-down.svg")
                                                            .size(px(12.)),
                                                    ),
                                            )
                                            .child(div().flex_1())
                                            .child(if self.active().running {
                                                div()
                                                    .id("stop")
                                                    .size(px(36.))
                                                    .flex()
                                                    .items_center()
                                                    .justify_center()
                                                    .rounded(px(6.))
                                                    .bg(p.secondary)
                                                    .text_color(p.foreground)
                                                    .cursor_pointer()
                                                    .hover(|s| s.bg(p.accent))
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.stop(cx)
                                                    }))
                                                    .child(icon("icons/square.svg").size(px(13.)))
                                                    .into_any_element()
                                            } else {
                                                div()
                                                    .id("send")
                                                    .size(px(36.))
                                                    .flex()
                                                    .items_center()
                                                    .justify_center()
                                                    .rounded(px(6.))
                                                    .bg(p.primary)
                                                    .text_color(p.primary_foreground)
                                                    .cursor_pointer()
                                                    .hover(|s| s.opacity(0.9))
                                                    .on_click(cx.listener(|this, _, window, cx| {
                                                        this.send(window, cx)
                                                    }))
                                                    .child(icon("icons/arrow-up.svg").size(px(16.)))
                                                    .into_any_element()
                                            }),
                                    )
                    // Deferred: paints after the whole frame, above panel borders.
                    .when(self.model_menu_open, |this| {
                        this.child(gpui::deferred(self.model_menu(cx)))
                    }),
            )
    }

    /// Live plan checklist docked above the composer (latest todo_write call).
    /// Shown while the plan is unfinished or the session is still running.
    fn plan_card(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        use crate::todo::TodoStatus;
        let todos = self.current_plan()?;
        let all_done = todos.iter().all(|t| t.status == TodoStatus::Completed);
        if all_done && !self.active().running {
            return None;
        }
        let p = theme::palette(cx);
        let done = todos.iter().filter(|t| t.status == TodoStatus::Completed).count();
        let total = todos.len();
        let expanded = self.plan_expanded;
        let summary: SharedString = todos
            .iter()
            .find(|t| t.status == TodoStatus::InProgress)
            .map(|t| {
                crate::app::shared(t.active_form.as_deref().unwrap_or(t.content.as_str()))
            })
            .unwrap_or_else(|| "计划".into());

        Some(
            v_flex()
                .border_b_1()
                .border_color(p.sidebar_border)
                .bg(p.muted)
                .px(px(20.))
                .py(px(8.))
                .gap(px(6.))
                .child(
                    h_flex()
                        .id("plan-head")
                        .gap(px(8.))
                        .items_center()
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.plan_expanded = !this.plan_expanded;
                            cx.notify();
                        }))
                        .child(icon("icons/list-todo.svg").size(px(14.)).text_color(p.muted_foreground))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(12.))
                                .font_medium()
                                .child(summary),
                        )
                        .child(
                            div()
                                .text_size(px(11.))
                                .text_color(p.muted_foreground)
                                .child(format!("{done}/{total}")),
                        )
                        .child(
                            icon(if expanded {
                                "icons/chevron-down.svg"
                            } else {
                                "icons/chevron-up.svg"
                            })
                            .size(px(12.))
                            .text_color(p.muted_foreground),
                        ),
                )
                .when(expanded, |s| {
                    s.child(v_flex().gap(px(3.)).children(todos.into_iter().map(|t| {
                        let (icon_path, color) = match t.status {
                            TodoStatus::Completed => ("icons/circle-check.svg", p.muted_foreground),
                            TodoStatus::InProgress => ("icons/loader-circle.svg", p.primary),
                            TodoStatus::Pending => ("icons/circle.svg", p.muted_foreground),
                        };
                        h_flex()
                            .gap(px(8.))
                            .items_center()
                            .child(icon(icon_path).size(px(13.)).text_color(color))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(12.))
                                    .when(t.status == TodoStatus::Completed, |s| {
                                        s.text_color(p.muted_foreground).line_through()
                                    })
                                    .child(crate::app::shared(&t.content)),
                            )
                    })))
                })
                .into_any_element(),
        )
    }

    /// The `ask` tool's question card, docked above the composer like the
    /// approval card. Options toggle; each question also takes free text.
    fn question_card(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let p = theme::palette(cx);
        let Some(pending) = &self.pending_question else {
            return div().into_any_element();
        };
        let questions: Vec<_> = pending
            .request
            .questions
            .iter()
            .enumerate()
            .map(|(qix, spec)| {
                let selected = pending.selected.get(qix).cloned().unwrap_or_default();
                let options: Vec<(usize, SharedString, Option<SharedString>, bool)> = spec
                    .options
                    .iter()
                    .enumerate()
                    .map(|(oix, o)| {
                        (
                            oix,
                            crate::app::shared(&o.label),
                            o.description.as_deref().map(crate::app::shared),
                            selected.contains(&oix),
                        )
                    })
                    .collect();
                (
                    qix,
                    spec.header.as_deref().map(crate::app::shared),
                    crate::app::shared(&spec.question),
                    options,
                    pending.custom_inputs.get(qix).cloned(),
                )
            })
            .collect();

        v_flex()
            .border_b_1()
            .border_color(p.sidebar_border)
            .bg(p.muted)
            .px(px(20.))
            .pt(px(12.))
            .pb(px(14.))
            .gap(px(10.))
            .child(
                h_flex()
                    .gap(px(6.))
                    .items_center()
                    .text_size(px(12.))
                    .child(icon("icons/message-square.svg").size(px(14.)))
                    .child(div().font_medium().child("需要你来选择")),
            )
            .children(questions.into_iter().map(|(qix, header, question, options, custom)| {
                v_flex()
                    .gap(px(6.))
                    .when_some(header, |s, header| {
                        s.child(
                            div()
                                .text_size(px(11.))
                                .text_color(p.muted_foreground)
                                .child(header),
                        )
                    })
                    .child(div().font_medium().text_size(px(13.)).child(question))
                    .child(v_flex().gap(px(4.)).children(options.into_iter().map(
                        |(oix, label, description, is_selected)| {
                            h_flex()
                                .id(("ask-option", qix * 100 + oix))
                                .px(px(10.))
                                .py(px(6.))
                                .gap(px(8.))
                                .items_center()
                                .rounded(px(6.))
                                .border_1()
                                .border_color(if is_selected { p.primary } else { p.border })
                                .bg(p.card)
                                .cursor_pointer()
                                .hover(|s| s.bg(p.accent))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.toggle_question_option(qix, oix, cx);
                                }))
                                .child(
                                    icon(if is_selected {
                                        "icons/circle-check.svg"
                                    } else {
                                        "icons/circle.svg"
                                    })
                                    .size(px(14.))
                                    .text_color(if is_selected {
                                        p.primary
                                    } else {
                                        p.muted_foreground
                                    }),
                                )
                                .child(
                                    v_flex()
                                        .flex_1()
                                        .min_w_0()
                                        .child(div().text_size(px(13.)).child(label))
                                        .when_some(description, |s, description| {
                                            s.child(
                                                div()
                                                    .text_size(px(11.))
                                                    .text_color(p.muted_foreground)
                                                    .child(description),
                                            )
                                        }),
                                )
                        },
                    )))
                    .when_some(custom, |s, input| {
                        s.child(
                            div()
                                .rounded(px(6.))
                                .border_1()
                                .border_color(p.border)
                                .bg(p.card)
                                .px(px(8.))
                                .py(px(2.))
                                .child(Input::new(&input).appearance(false)),
                        )
                    })
            }))
            .child(
                h_flex()
                    .gap(px(8.))
                    .justify_end()
                    .child(
                        div()
                            .id("ask-cancel")
                            .px(px(12.))
                            .py(px(4.))
                            .rounded(px(5.))
                            .border_1()
                            .border_color(p.border)
                            .text_size(px(12.))
                            .cursor_pointer()
                            .hover(|s| s.bg(p.accent))
                            .on_click(cx.listener(|this, _, _, cx| this.resolve_question(false, cx)))
                            .child("跳过"),
                    )
                    .child(
                        div()
                            .id("ask-submit")
                            .px(px(16.))
                            .py(px(4.))
                            .rounded(px(5.))
                            .bg(p.primary)
                            .text_color(p.primary_foreground)
                            .text_size(px(12.))
                            .cursor_pointer()
                            .hover(|s| s.opacity(0.9))
                            .on_click(cx.listener(|this, _, _, cx| this.resolve_question(true, cx)))
                            .child("提交"),
                    ),
            )
            .into_any_element()
    }

    /// Options dropdown anchored above the composer button row.
    fn model_menu(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        use gpui::prelude::FluentBuilder as _;
        let p = theme::palette(cx);
        let current = self.effective_model().map(|o| o.model.id);
        let options: Vec<(String, String)> = self
            .server_config
            .as_ref()
            .map(|c| c.options.iter().map(|o| (o.model.id.clone(), o.name.clone())).collect())
            .unwrap_or_default();

        v_flex()
            .id("model-menu")
            .absolute()
            .bottom(px(48.))
            .left(px(48.))
            .w(px(240.))
            .rounded(px(6.))
            .border_1()
            .border_color(p.border)
            .bg(p.popover)
            .shadow_md()
            .p(px(4.))
            .gap(px(1.))
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.model_menu_open = false;
                this.model_menu_dismissed = Some(std::time::Instant::now());
                cx.notify();
            }))
            .when(options.is_empty(), |this| {
                this.child(
                    div()
                        .px(px(10.))
                        .py(px(8.))
                        .text_size(px(12.))
                        .text_color(p.muted_foreground)
                        .child("没有可选模型（由管理员配置）"),
                )
            })
            .children(options.into_iter().enumerate().map(|(ix, (id, name))| {
                let is_current = current.as_deref() == Some(id.as_str());
                h_flex()
                    .id(("model-option", ix))
                    .px(px(8.))
                    .py(px(5.))
                    .gap(px(8.))
                    .items_center()
                    .rounded(px(4.))
                    .text_size(px(13.))
                    .cursor_pointer()
                    .hover(|s| s.bg(p.accent))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.model_choice = Some(id.clone());
                        if let Some(store) = &this.store {
                            store.set_setting("model_choice", &id);
                        }
                        this.model_menu_open = false;
                        cx.notify();
                    }))
                    .child(div().flex_1().min_w_0().truncate().child(crate::app::shared(&name)))
                    .when(is_current, |s| s.child(icon("icons/check.svg").size(px(14.))))
            }))
            .into_any_element()
    }
}

fn user_bubble(text: SharedString, p: &theme::Palette) -> impl IntoElement {
    div().py(px(10.)).flex().justify_end().child(
        div()
            .max_w(px(560.))
            .rounded(px(8.))
            .bg(p.secondary)
            .text_color(p.secondary_foreground)
            .px(px(16.))
            .py(px(10.))
            .child(text),
    )
}

fn assistant_markdown(
    six: usize,
    mix: usize,
    view: Entity<flairy_markdown::MarkdownState>,
    style: &flairy_markdown::MarkdownStyle,
    _window: &mut Window,
    _cx: &mut gpui::App,
) -> impl IntoElement {
    div().py(px(2.)).pt(px(4.)).child(flairy_markdown::MarkdownView::new(
        view,
        style.clone(),
        six * 1_000_000 + mix,
    ))
}

/// Output shown in an expanded tool card is clamped, not scrolled.
const TOOL_OUTPUT_MAX_LINES: usize = 40;
const TOOL_OUTPUT_MAX_CHARS: usize = 4_000;

fn tool_row(
    six: usize,
    mix: usize,
    label: SharedString,
    preview: SharedString,
    output: Option<SharedString>,
    expanded: bool,
    running: bool,
    is_error: bool,
    p: &theme::Palette,
    cx: &mut Context<FlairyApp>,
) -> impl IntoElement {
    let has_output = output.is_some();
    v_flex()
        .py(px(4.))
        .gap(px(6.))
        .child(
            h_flex()
                .id(("tool-head", six * 1_000_000 + mix))
                .gap(px(8.))
                .items_center()
                .when(has_output, |s| {
                    s.cursor_pointer()
                        .rounded(px(4.))
                        .hover(|s| s.bg(p.accent.opacity(0.5)))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(crate::app::Msg::Tool { expanded, .. }) =
                                this.sessions.get_mut(six).and_then(|s| s.msgs.get_mut(mix))
                            {
                                *expanded = !*expanded;
                                cx.notify();
                            }
                        }))
                })
                .when(has_output, |s| {
                    s.child(
                        icon(if expanded {
                            "icons/chevron-down.svg"
                        } else {
                            "icons/chevron-right.svg"
                        })
                        .size(px(12.))
                        .text_color(p.muted_foreground),
                    )
                })
                .child(
                    div()
                        .font_medium()
                        .text_color(if is_error { p.danger } else { p.muted_foreground })
                        .child(label),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(p.muted_foreground.opacity(0.6))
                        .child(preview),
                )
                .when(running, |s| s.child(Spinner::new().with_size(px(14.)))),
        )
        .when(expanded && has_output, |s| {
            let text = output.unwrap_or_default();
            // Plan results render as a checklist, not raw sentinel JSON.
            if let Some(todos) = crate::todo::parse_todos(&text) {
                return s.child(
                    v_flex()
                        .ml(px(20.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(p.border)
                        .bg(p.secondary.opacity(0.5))
                        .px(px(12.))
                        .py(px(8.))
                        .gap(px(3.))
                        .text_size(px(12.))
                        .children(todos.into_iter().map(|t| {
                            use crate::todo::TodoStatus;
                            let mark = match t.status {
                                TodoStatus::Completed => "✓",
                                TodoStatus::InProgress => "→",
                                TodoStatus::Pending => "○",
                            };
                            h_flex()
                                .gap(px(8.))
                                .child(div().text_color(p.muted_foreground).child(mark))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .when(t.status == TodoStatus::Completed, |s| {
                                            s.text_color(p.muted_foreground)
                                        })
                                        .child(crate::app::shared(&t.content)),
                                )
                        })),
                );
            }
            // Web tool results render as a sources list, not raw sentinel JSON.
            if let Some(sources) = crate::web_tools::parse_sources(&text) {
                return s.child(
                    v_flex()
                        .ml(px(20.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(p.border)
                        .bg(p.secondary.opacity(0.5))
                        .px(px(12.))
                        .py(px(8.))
                        .gap(px(4.))
                        .text_size(px(12.))
                        .children(sources.into_iter().enumerate().map(
                            |(ix, (id, title, url))| {
                                let href = url.clone();
                                v_flex()
                                    .id(("source", ix))
                                    .gap(px(1.))
                                    .cursor_pointer()
                                    .on_click(move |_, _, cx| cx.open_url(&href))
                                    .child(
                                        div()
                                            .font_medium()
                                            .text_color(p.foreground)
                                            .truncate()
                                            .child(SharedString::from(format!("[{id}] {title}"))),
                                    )
                                    .child(
                                        div()
                                            .text_color(p.muted_foreground)
                                            .truncate()
                                            .child(SharedString::from(url)),
                                    )
                            },
                        )),
                );
            }
            let clipped: String = text.chars().take(TOOL_OUTPUT_MAX_CHARS).collect();
            let mut lines: Vec<SharedString> = clipped
                .lines()
                .take(TOOL_OUTPUT_MAX_LINES)
                .map(|l| SharedString::from(l.to_string()))
                .collect();
            let truncated = clipped.len() < text.len()
                || clipped.lines().count() > TOOL_OUTPUT_MAX_LINES;
            if truncated {
                lines.push("…（输出已截断）".into());
            }
            s.child(
                v_flex()
                    .ml(px(20.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(if is_error { p.danger.opacity(0.4) } else { p.border })
                    .bg(p.secondary.opacity(0.5))
                    .px(px(12.))
                    .py(px(8.))
                    .gap(px(1.))
                    .font_family("IBM Plex Mono")
                    .text_size(px(12.))
                    .text_color(if is_error { p.danger } else { p.muted_foreground })
                    .children(lines.into_iter().map(|line| {
                        if line.is_empty() {
                            div().h(px(8.)).into_any_element()
                        } else {
                            div().child(line).into_any_element()
                        }
                    })),
            )
        })
}

/// Collapsed "思考过程" disclosure above an assistant reply. While the model
/// is still thinking (no visible text yet) the tail streams live; afterwards
/// it collapses to a toggle row.
fn reasoning_section(
    six: usize,
    mix: usize,
    text: SharedString,
    open: bool,
    live: bool,
    p: &theme::Palette,
    cx: &mut Context<FlairyApp>,
) -> gpui::AnyElement {
    let show_body = open || live;
    v_flex()
        .pt(px(6.))
        .gap(px(4.))
        .child(
            h_flex()
                .id(("reasoning-head", six * 1_000_000 + mix))
                .gap(px(6.))
                .items_center()
                .text_size(px(12.))
                .text_color(p.muted_foreground)
                .cursor_pointer()
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(crate::app::Msg::Assistant { reasoning_open, .. }) =
                        this.sessions.get_mut(six).and_then(|s| s.msgs.get_mut(mix))
                    {
                        *reasoning_open = !*reasoning_open;
                        cx.notify();
                    }
                }))
                .child(icon("icons/brain.svg").size(px(13.)))
                .child(div().font_medium().child(if live { "正在思考…" } else { "思考过程" }))
                .child(
                    icon(if show_body {
                        "icons/chevron-down.svg"
                    } else {
                        "icons/chevron-right.svg"
                    })
                    .size(px(12.)),
                ),
        )
        .when(show_body, |s| {
            // Live: show just the streaming tail; expanded after: full text.
            let display: String = if live {
                let chars: Vec<char> = text.chars().collect();
                let tail = chars.len().saturating_sub(300);
                chars[tail..].iter().collect()
            } else {
                text.to_string()
            };
            s.child(
                div()
                    .pl(px(19.))
                    .text_size(px(12.))
                    .text_color(p.muted_foreground)
                    .line_height(px(19.))
                    .children(display.lines().filter(|l| !l.trim().is_empty()).map(|line| {
                        div().child(SharedString::from(line.to_string()))
                    })),
            )
        })
        .into_any_element()
}

fn thinking_row(p: &theme::Palette) -> impl IntoElement {
    h_flex()
        .py(px(10.))
        .gap(px(8.))
        .items_center()
        .text_color(p.muted_foreground)
        .child(Spinner::new().with_size(px(14.)))
        .child(div().font_medium().child("正在思考…"))
}

