use gpui::{
    Context, InteractiveElement, IntoElement, ParentElement, Styled, WindowControlArea, div, px,
};
use gpui_component::progress::Progress;
use gpui_component::{h_flex, v_flex};

use crate::app::{FlairyApp, TextWeight};
use crate::theme;

impl FlairyApp {
    pub fn render_right_panel(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);

        let card = |p: &theme::Palette| {
            v_flex()
                .rounded(px(6.))
                .border_1()
                .border_color(p.border.opacity(0.7))
                .bg(p.muted.opacity(0.3))
                .p(px(12.))
                .gap(px(8.))
        };
        let micro_label = |p: &theme::Palette, text: &'static str| {
            div()
                .text_size(px(11.))
                .font_medium()
                .text_color(p.muted_foreground)
                .child(text)
        };

        v_flex()
            .w(px(380.))
            .h_full()
            .flex_shrink_0()
            .border_l_1()
            .border_color(p.sidebar_border)
            .text_color(p.sidebar_foreground)
            .child(
                // tab rail, aligned with the 48px chat header
                h_flex()
                    .h(px(48.))
                    .flex_shrink_0()
                    .items_center()
                    .px(px(12.))
                    .window_control_area(WindowControlArea::Drag)
                    .child(
                        div()
                            .px(px(10.))
                            .py(px(4.))
                            .rounded(px(5.))
                            .bg(p.sidebar_accent)
                            .text_size(px(13.))
                            .font_medium()
                            .child("模型"),
                    ),
            )
            .child({
                let session = self.active();
                let option = self.effective_model();
                let model_name = option
                    .as_ref()
                    .map(|o| o.name.clone())
                    .unwrap_or_else(|| "未配置".into());
                let model_id = option.as_ref().map(|o| o.model.id.clone()).unwrap_or_default();
                let context_window = option.as_ref().and_then(|o| o.context_window);
                let percent = context_window
                    .filter(|w| *w > 0)
                    .map(|w| (session.last_input as f32 / w as f32 * 100.).min(100.));
                let spend = option.as_ref().and_then(|o| {
                    Some(
                        session.usage_input as f64 / 1e6 * o.cost_input?
                            + session.usage_output as f64 / 1e6 * o.cost_output?,
                    )
                });

                v_flex()
                    .flex_1()
                    .px(px(12.))
                    .py(px(12.))
                    .gap(px(16.))
                    .child(
                        card(&p)
                            .child(micro_label(&p, "当前模型"))
                            .child(div().font_medium().child(crate::app::shared(&model_name)))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(p.muted_foreground)
                                    .child(crate::app::shared(&model_id)),
                            ),
                    )
                    .child(
                        card(&p)
                            .child(micro_label(&p, "上下文用量"))
                            .child(Progress::new().value(percent.unwrap_or(0.)))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(p.muted_foreground)
                                    .child(match context_window {
                                        Some(w) => crate::app::shared(&format!(
                                            "{} / {}",
                                            fmt_tokens(session.last_input as u64),
                                            fmt_tokens(w as u64)
                                        )),
                                        None => "上下文窗口未知".into(),
                                    }),
                            ),
                    )
                    .child(
                        card(&p)
                            .child(micro_label(&p, "本次会话花费"))
                            .child(div().text_size(px(24.)).font_semibold().child(match spend {
                                Some(s) => crate::app::shared(&format!("${s:.4}")),
                                None => "—".into(),
                            }))
                            .child(
                                h_flex().gap(px(8.)).children(
                                    [
                                        ("输入", fmt_tokens(session.usage_input)),
                                        ("输出", fmt_tokens(session.usage_output)),
                                        ("请求", session.requests.to_string()),
                                    ]
                                    .into_iter()
                                    .map(|(label, value)| {
                                        v_flex()
                                            .flex_1()
                                            .rounded(px(5.))
                                            .border_1()
                                            .border_color(p.border.opacity(0.7))
                                            .p(px(8.))
                                            .gap(px(2.))
                                            .child(
                                                div()
                                                    .text_size(px(11.))
                                                    .text_color(p.muted_foreground)
                                                    .child(label),
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(13.))
                                                    .font_medium()
                                                    .child(crate::app::shared(&value)),
                                            )
                                    }),
                                ),
                            ),
                    )
            })
    }
}

fn fmt_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1e6)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1e3)
    } else {
        n.to_string()
    }
}
