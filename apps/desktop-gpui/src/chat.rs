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
        let md_style = flairy_markdown::MarkdownStyle {
            link: p.primary,
            muted_foreground: p.muted_foreground,
            border: p.border,
            code_background: p.secondary,
            table_head_background: p.secondary,
            mono_font: "IBM Plex Mono".into(),
            is_dark: crate::theme::is_dark(cx),
        };

        // Collect render data first to avoid borrowing self inside the loop.
        enum Row {
            User(SharedString),
            Assistant { view: Entity<flairy_markdown::MarkdownState>, thinking: bool },
            Tool { label: SharedString, preview: SharedString, running: bool, is_error: bool },
        }
        let queued: Vec<SharedString> =
            self.active().queued.iter().map(|q| crate::app::shared(q)).collect();
        let rows: Vec<Row> = self
            .active()
            .msgs
            .iter()
            .map(|msg| match msg {
                Msg::User(text) => Row::User(crate::app::shared(text)),
                Msg::Assistant { md, done, view } => Row::Assistant {
                    view: view.clone().expect("hydrated above"),
                    thinking: md.is_empty() && !done,
                },
                Msg::Tool { label, preview, output, is_error } => Row::Tool {
                    label: crate::app::shared(label),
                    preview: crate::app::shared(preview),
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
                        .max_w(px(768.))
                        .px(px(24.))
                        .pt(px(24.))
                        .pb(px(24.))
                        .line_height(px(23.))
                        .children(rows.into_iter().enumerate().map(|(mix, row)| {
                            match row {
                                Row::User(text) => user_bubble(text, &p).into_any_element(),
                                Row::Assistant { view, thinking } => {
                                    if thinking {
                                        thinking_row(&p).into_any_element()
                                    } else {
                                        assistant_markdown(six, mix, view, &md_style, window, cx)
                                            .into_any_element()
                                    }
                                }
                                Row::Tool { label, preview, running, is_error } => {
                                    tool_row(label, preview, running, is_error, &p)
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
            .child(
                // input area: everything below the divider
                v_flex()
                    .relative()
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
    window: &mut Window,
    cx: &mut gpui::App,
) -> impl IntoElement {
    let parsed = view.read(cx).parsed().clone();
    div().py(px(2.)).pt(px(4.)).child(flairy_markdown::render_markdown(
        six * 1_000_000 + mix,
        &parsed,
        style,
        window,
    ))
}

fn tool_row(
    label: SharedString,
    preview: SharedString,
    running: bool,
    is_error: bool,
    p: &theme::Palette,
) -> impl IntoElement {
    h_flex()
        .py(px(4.))
        .gap(px(8.))
        .items_center()
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
        .when(running, |s| s.child(Spinner::new().with_size(px(14.))))
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

