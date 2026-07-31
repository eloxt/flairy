//! Settings window — macOS System Settings style, per the Electron SettingsPage.

use gpui::prelude::FluentBuilder;
use gpui::{
    App, AppContext, Bounds, Context, InteractiveElement, IntoElement, ParentElement, Render,
    StatefulInteractiveElement, Styled, TitlebarOptions, Window, WindowBounds, WindowControlArea,
    WindowOptions, div, point, px, size,
};
use gpui_component::switch::Switch;
use gpui_component::{ActiveTheme, Icon, Root, h_flex, v_flex};

use crate::app::TextWeight;
use crate::theme;

fn prefs_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(home).join("Library/Application Support/Flairy/prefs.json")
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Prefs {
    #[serde(default = "default_true")]
    close_to_tray: bool,
    #[serde(default)]
    auto_launch: bool,
}

fn default_true() -> bool {
    true
}

fn load_prefs() -> Prefs {
    std::fs::read_to_string(prefs_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Prefs { close_to_tray: true, auto_launch: false })
}

fn save_prefs(prefs: &Prefs) {
    if let Ok(json) = serde_json::to_string_pretty(prefs) {
        let _ = std::fs::write(prefs_path(), json);
    }
}

pub fn open(cx: &mut App) {
    let bounds = Bounds::centered(None, size(px(780.), px(600.)), cx);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: Some(TitlebarOptions {
            title: Some("设置".into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(16.), px(15.))),
        }),
        window_min_size: Some(size(px(640.), px(480.))),
        ..Default::default()
    };
    cx.open_window(options, |window, cx| {
        let email = crate::server_client::stored_or_env_credentials().map(|c| c.email);
        let prefs = load_prefs();
        let view = cx.new(|_| SettingsWindow {
            close_to_tray: prefs.close_to_tray,
            auto_launch: prefs.auto_launch,
            email,
        });
        cx.new(|cx| Root::new(view, window, cx))
    })
    .ok();
}

pub struct SettingsWindow {
    close_to_tray: bool,
    auto_launch: bool,
    email: Option<String>,
}

impl Render for SettingsWindow {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = theme::palette(cx);

        div()
            .flex()
            .flex_row()
            .size_full()
            .bg(p.background)
            .text_color(cx.theme().foreground)
            .text_size(px(13.))
            .child(self.render_nav(cx))
            .child(self.render_content(cx))
    }
}

impl SettingsWindow {
    fn render_nav(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);

        let nav_item = |p: &theme::Palette, icon_path: &'static str, label: &'static str, active: bool| {
            h_flex()
                .id(label)
                .px(px(10.))
                .py(px(5.))
                .gap(px(10.))
                .items_center()
                .rounded(px(5.))
                .cursor_pointer()
                .when(active, |s| s.bg(p.sidebar_accent).font_medium())
                .hover(|s| s.bg(p.sidebar_accent.opacity(0.6)))
                .child(
                    div()
                        .size(px(24.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(5.))
                        .bg(p.foreground.opacity(0.06))
                        .child(Icon::empty().path(icon_path).size(px(14.)).opacity(0.85)),
                )
                .child(div().child(label))
        };

        v_flex()
            .w(px(212.))
            .h_full()
            .flex_shrink_0()
            .border_r_1()
            .border_color(p.sidebar_border)
            .bg(p.sidebar)
            .text_color(p.sidebar_foreground)
            .px(px(10.))
            .pb(px(12.))
            .window_control_area(WindowControlArea::Drag)
            .child(div().h(px(52.))) // traffic-light spacer
            .child(
                // account card
                h_flex()
                    .px(px(10.))
                    .py(px(8.))
                    .gap(px(10.))
                    .items_center()
                    .rounded(px(6.))
                    .child(
                        div()
                            .size(px(36.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_full()
                            .bg(p.primary)
                            .text_color(p.primary_foreground)
                            .text_size(px(15.))
                            .font_semibold()
                            .child(
                                self.email
                                    .as_deref()
                                    .and_then(|e| e.chars().next())
                                    .map(|c| crate::app::shared(&c.to_uppercase().to_string()))
                                    .unwrap_or_else(|| "F".into()),
                            ),
                    )
                    .child(
                        v_flex()
                            .gap(px(1.))
                            .child(div().font_semibold().child(
                                self.email
                                    .as_deref()
                                    .and_then(|e| e.split('@').next())
                                    .map(|n| crate::app::shared(n))
                                    .unwrap_or_else(|| "未登录".into()),
                            ))
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(p.muted_foreground)
                                    .child(
                                        self.email
                                            .as_deref()
                                            .map(crate::app::shared)
                                            .unwrap_or_else(|| "本地模式".into()),
                                    ),
                            ),
                    ),
            )
            .child(
                v_flex()
                    .mt(px(8.))
                    .gap(px(1.))
                    .child(nav_item(&p, "icons/sparkles.svg", "通用", true))
                    .child(nav_item(&p, "icons/user.svg", "账户", false))
                    .child(nav_item(&p, "icons/brain.svg", "记忆", false))
                    .child(nav_item(&p, "icons/clock.svg", "计划任务", false))
                    .child(nav_item(&p, "icons/send.svg", "Telegram", false))
                    .child(nav_item(&p, "icons/github.svg", "GitHub", false))
                    .child(nav_item(&p, "icons/info.svg", "关于", false)),
            )
            .child(div().flex_1())
            .child(
                div()
                    .id("sign-out")
                    .mx(px(2.))
                    .px(px(10.))
                    .py(px(6.))
                    .rounded(px(5.))
                    .text_size(px(13.))
                    .text_color(p.danger)
                    .cursor_pointer()
                    .hover(|s| s.bg(p.sidebar_accent))
                    .on_click(cx.listener(|_, _, _, cx| {
                        crate::server_client::clear_credentials();
                        cx.quit(); // relaunch lands on the sign-in screen
                    }))
                    .child("退出登录"),
            )
    }

    fn render_content(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);

        v_flex()
            .flex_1()
            .h_full()
            .child(
                h_flex()
                    .h(px(52.))
                    .flex_shrink_0()
                    .items_center()
                    .px(px(24.))
                    .border_b_1()
                    .border_color(p.border.opacity(0.6))
                    .window_control_area(WindowControlArea::Drag)
                    .child(div().text_size(px(15.)).font_semibold().child("通用")),
            )
            .child(
                v_flex()
                    .id("settings-body")
                    .flex_1()
                    .overflow_y_scroll()
                    .px(px(24.))
                    .pt(px(20.))
                    .pb(px(28.))
                    .child(group_label(&p, "外观"))
                    .child(
                        group(&p)
                            .child(value_row(&p, "主题", "跟随系统", false))
                            .child(value_row(&p, "聊天宽度", "默认", false))
                            .child(value_row(&p, "语言", "简体中文", true)),
                    )
                    .child(group_label(&p, "行为"))
                    .child(
                        group(&p)
                            .child(switch_row(
                                &p,
                                "switch-tray",
                                "关闭时最小化到托盘",
                                "点击关闭按钮时保留在菜单栏，不退出应用",
                                self.close_to_tray,
                                cx.listener(|this, _, _, cx| {
                                    this.close_to_tray = !this.close_to_tray;
                                    save_prefs(&Prefs {
                                        close_to_tray: this.close_to_tray,
                                        auto_launch: this.auto_launch,
                                    });
                                    cx.notify();
                                }),
                                false,
                            ))
                            .child(switch_row(
                                &p,
                                "switch-launch",
                                "开机自启",
                                "登录系统后自动启动 Flairy",
                                self.auto_launch,
                                cx.listener(|this, _, _, cx| {
                                    this.auto_launch = !this.auto_launch;
                                    save_prefs(&Prefs {
                                        close_to_tray: this.close_to_tray,
                                        auto_launch: this.auto_launch,
                                    });
                                    cx.notify();
                                }),
                                true,
                            )),
                    ),
            )
    }
}

fn group_label(p: &theme::Palette, text: &'static str) -> impl IntoElement {
    div()
        .mx(px(2.))
        .mt(px(24.))
        .mb(px(8.))
        .text_size(px(10.))
        .font_semibold()
        .text_color(p.muted_foreground)
        .child(text)
}

fn group(p: &theme::Palette) -> gpui::Div {
    div()
        .rounded(px(6.))
        .bg(p.card)
        .border_1()
        .border_color(p.border)
        .overflow_hidden()
}

fn value_row(p: &theme::Palette, label: &'static str, value: &'static str, last: bool) -> impl IntoElement {
    h_flex()
        .min_h(px(46.))
        .px(px(14.))
        .py(px(8.))
        .gap(px(16.))
        .items_center()
        .when(!last, |s| s.border_b_1().border_color(p.border.opacity(0.6)))
        .child(div().flex_1().child(label))
        .child(
            div()
                .rounded(px(4.))
                .bg(p.background)
                .border_1()
                .border_color(p.input)
                .px(px(10.))
                .py(px(4.))
                .text_size(px(12.))
                .child(value),
        )
}

fn switch_row(
    p: &theme::Palette,
    id: &'static str,
    label: &'static str,
    description: &'static str,
    checked: bool,
    on_click: impl Fn(&bool, &mut Window, &mut App) + 'static,
    last: bool,
) -> impl IntoElement {
    h_flex()
        .min_h(px(46.))
        .px(px(14.))
        .py(px(8.))
        .gap(px(16.))
        .items_center()
        .when(!last, |s| s.border_b_1().border_color(p.border.opacity(0.6)))
        .child(
            v_flex()
                .flex_1()
                .gap(px(2.))
                .child(div().child(label))
                .child(
                    div()
                        .text_size(px(11.5))
                        .text_color(p.muted_foreground)
                        .child(description),
                ),
        )
        .child(Switch::new(id).checked(checked).on_click(on_click))
}
