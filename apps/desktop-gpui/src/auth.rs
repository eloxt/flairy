//! Sign-in screen (AuthScreen analog: brand tile, email/password, skip link).

use gpui::prelude::FluentBuilder;
use gpui::{
    Context, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled,
    WindowControlArea, div, px,
};
use gpui_component::input::Input;
use gpui_component::{h_flex, v_flex};

use crate::app::{FlairyApp, TextWeight};
use crate::theme;

impl FlairyApp {
    pub fn render_auth(&mut self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);
        let error = self.auth_error.clone();

        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(p.background)
            .window_control_area(WindowControlArea::Drag)
            .child(
                v_flex()
                    .w(px(384.))
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .size(px(44.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(8.))
                            .border_1()
                            .border_color(p.border)
                            .bg(p.card)
                            .text_size(px(20.))
                            .font_semibold()
                            .child("F"),
                    )
                    .child(div().mt(px(8.)).font_semibold().child("登录 Flairy"))
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(p.muted_foreground)
                            .child("使用管理员分配的账号登录"),
                    )
                    .child(
                        v_flex()
                            .mt(px(16.))
                            .w_full()
                            .gap(px(8.))
                            .child(auth_field(&p, Input::new(&self.email_input).appearance(false)))
                            .child(auth_field(&p, Input::new(&self.password_input).appearance(false))),
                    )
                    .when_some(error, |this, message| {
                        this.child(
                            div()
                                .w_full()
                                .rounded(px(6.))
                                .bg(p.danger.opacity(0.1))
                                .px(px(12.))
                                .py(px(8.))
                                .text_size(px(13.))
                                .text_color(p.danger)
                                .child(message),
                        )
                    })
                    .child(
                        div()
                            .id("sign-in")
                            .mt(px(8.))
                            .w_full()
                            .h(px(36.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .bg(p.primary)
                            .text_color(p.primary_foreground)
                            .text_size(px(14.))
                            .font_medium()
                            .cursor_pointer()
                            .hover(|s| s.opacity(0.9))
                            .on_click(cx.listener(|this, _, _, cx| this.sign_in(cx)))
                            .child("登录"),
                    )
                    .child(
                        div()
                            .id("skip")
                            .mt(px(12.))
                            .text_size(px(12.))
                            .text_color(p.muted_foreground)
                            .cursor_pointer()
                            .hover(|s| s.text_color(p.foreground))
                            .on_click(cx.listener(|this, _, _, cx| this.skip_login(cx)))
                            .child("跳过登录，本地使用"),
                    ),
            )
    }
}

fn auth_field(p: &theme::Palette, input: Input) -> impl IntoElement {
    h_flex()
        .w_full()
        .h(px(36.))
        .px(px(10.))
        .items_center()
        .rounded(px(6.))
        .border_1()
        .border_color(p.input)
        .bg(p.background)
        .child(div().flex_1().child(input))
}
