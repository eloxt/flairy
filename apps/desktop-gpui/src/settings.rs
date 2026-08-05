//! Settings window — macOS System Settings style, per the Electron SettingsPage.
//! Panes: 通用 (appearance/behavior prefs), 记忆 (agent memory list), 关于.

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

#[derive(serde::Serialize, serde::Deserialize)]
struct Prefs {
    #[serde(default = "default_true")]
    close_to_tray: bool,
    #[serde(default)]
    auto_launch: bool,
    /// "system" | "light" | "dark"
    #[serde(default = "default_theme")]
    theme: String,
    /// "default" | "wide"
    #[serde(default = "default_width")]
    chat_width: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            auto_launch: false,
            theme: default_theme(),
            chat_width: default_width(),
        }
    }
}

fn default_true() -> bool {
    true
}
fn default_theme() -> String {
    "system".into()
}
fn default_width() -> String {
    "default".into()
}

fn load_prefs() -> Prefs {
    std::fs::read_to_string(prefs_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_prefs(prefs: &Prefs) {
    if let Ok(json) = serde_json::to_string_pretty(prefs) {
        let _ = std::fs::write(prefs_path(), json);
    }
}

/// Startup theme preference from prefs.json (also primes the chat width).
pub fn initial_theme_pref() -> theme::ThemePref {
    let prefs = load_prefs();
    CHAT_WIDE.store(prefs.chat_width == "wide", std::sync::atomic::Ordering::Relaxed);
    match prefs.theme.as_str() {
        "light" => theme::ThemePref::Light,
        "dark" => theme::ThemePref::Dark,
        _ => theme::ThemePref::System,
    }
}

static CHAT_WIDE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Max thread width for the chat pane, per user preference.
pub fn chat_width_px() -> f32 {
    if CHAT_WIDE.load(std::sync::atomic::Ordering::Relaxed) { 960. } else { 768. }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pane {
    General,
    Memory,
    Schedule,
    About,
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
            pane: Pane::General,
            close_to_tray: prefs.close_to_tray,
            auto_launch: prefs.auto_launch,
            theme: prefs.theme,
            chat_width: prefs.chat_width,
            email,
            store: crate::store::Store::open(),
            memories: Vec::new(),
            tasks: Vec::new(),
        });
        cx.new(|cx| Root::new(view, window, cx))
    })
    .ok();
}

pub struct SettingsWindow {
    pane: Pane,
    close_to_tray: bool,
    auto_launch: bool,
    theme: String,
    chat_width: String,
    email: Option<String>,
    store: Option<crate::store::Store>,
    memories: Vec<flairy_contract::Memory>,
    tasks: Vec<crate::schedule::ScheduledTask>,
}

impl SettingsWindow {
    fn prefs(&self) -> Prefs {
        Prefs {
            close_to_tray: self.close_to_tray,
            auto_launch: self.auto_launch,
            theme: self.theme.clone(),
            chat_width: self.chat_width.clone(),
        }
    }

    fn reload_memories(&mut self) {
        self.memories =
            self.store.as_ref().map(|s| s.active_memories()).unwrap_or_default();
    }

    fn reload_tasks(&mut self) {
        self.tasks = self.store.as_ref().map(|s| s.list_tasks()).unwrap_or_default();
    }
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
        let active = self.pane;

        let nav_item = |icon_path: &'static str,
                        label: &'static str,
                        pane: Pane,
                        p: &theme::Palette,
                        cx: &mut Context<Self>| {
            let is_active = pane == active;
            h_flex()
                .id(label)
                .px(px(10.))
                .py(px(5.))
                .gap(px(10.))
                .items_center()
                .rounded(px(5.))
                .cursor_pointer()
                .when(is_active, |s| s.bg(p.sidebar_accent).font_medium())
                .hover(|s| s.bg(p.sidebar_accent.opacity(0.6)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.pane = pane;
                    if pane == Pane::Memory {
                        this.reload_memories();
                    }
                    if pane == Pane::Schedule {
                        this.reload_tasks();
                    }
                    cx.notify();
                }))
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
                    .child(nav_item("icons/sparkles.svg", "通用", Pane::General, &p, cx))
                    .child(nav_item("icons/brain.svg", "记忆", Pane::Memory, &p, cx))
                    .child(nav_item("icons/clock.svg", "计划任务", Pane::Schedule, &p, cx))
                    .child(nav_item("icons/info.svg", "关于", Pane::About, &p, cx)),
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
                        crate::config_cache::clear();
                        cx.quit(); // relaunch lands on the sign-in screen
                    }))
                    .child("退出登录"),
            )
    }

    fn render_content(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);
        let title = match self.pane {
            Pane::General => "通用",
            Pane::Memory => "记忆",
            Pane::Schedule => "计划任务",
            Pane::About => "关于",
        };

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
                    .child(div().text_size(px(15.)).font_semibold().child(title)),
            )
            .child(match self.pane {
                Pane::General => self.general_pane(cx).into_any_element(),
                Pane::Memory => self.memory_pane(cx).into_any_element(),
                Pane::Schedule => self.schedule_pane(cx).into_any_element(),
                Pane::About => self.about_pane(cx).into_any_element(),
            })
    }

    fn general_pane(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);

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
                    .child(choice_row(
                        &p,
                        "主题",
                        &[("system", "跟随系统"), ("light", "浅色"), ("dark", "深色")],
                        &self.theme,
                        cx.listener(|this, choice: &&'static str, _, cx| {
                            this.theme = (*choice).to_string();
                            save_prefs(&this.prefs());
                            let pref = match *choice {
                                "light" => theme::ThemePref::Light,
                                "dark" => theme::ThemePref::Dark,
                                _ => theme::ThemePref::System,
                            };
                            theme::set_theme_pref(pref, cx);
                            cx.notify();
                        }),
                        false,
                    ))
                    .child(choice_row(
                        &p,
                        "聊天宽度",
                        &[("default", "默认"), ("wide", "宽")],
                        &self.chat_width,
                        cx.listener(|this, choice: &&'static str, _, cx| {
                            this.chat_width = (*choice).to_string();
                            save_prefs(&this.prefs());
                            CHAT_WIDE.store(
                                *choice == "wide",
                                std::sync::atomic::Ordering::Relaxed,
                            );
                            cx.refresh_windows();
                            cx.notify();
                        }),
                        false,
                    ))
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
                            save_prefs(&this.prefs());
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
                            save_prefs(&this.prefs());
                            cx.notify();
                        }),
                        true,
                    )),
            )
    }

    /// Agent memory list: what `remember` has learned; per-item forget.
    /// Forget is a soft delete so it wins merges (deletion syncs on next pull
    /// exchange once the server learns of it via a future upsert).
    fn memory_pane(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);
        let rows: Vec<(String, gpui::SharedString, gpui::SharedString)> = self
            .memories
            .iter()
            .map(|m| {
                let kind = match m.kind.as_str() {
                    "preference" => "偏好",
                    "profile" => "身份",
                    _ => "事实",
                };
                (m.id.clone(), crate::app::shared(&m.text), kind.into())
            })
            .collect();

        v_flex()
            .id("memory-body")
            .flex_1()
            .overflow_y_scroll()
            .px(px(24.))
            .pt(px(20.))
            .pb(px(28.))
            .child(
                div()
                    .mb(px(12.))
                    .text_size(px(12.))
                    .text_color(p.muted_foreground)
                    .child("助手在对话中记住的内容，会在之后的对话里用于更好地帮助你。"),
            )
            .when(rows.is_empty(), |s| {
                s.child(
                    div()
                        .py(px(24.))
                        .text_color(p.muted_foreground)
                        .child("还没有记忆。当你在对话里告诉助手你的偏好时，它会记在这里。"),
                )
            })
            .child(v_flex().gap(px(6.)).children(rows.into_iter().enumerate().map(
                |(ix, (id, text, kind))| {
                    h_flex()
                        .px(px(14.))
                        .py(px(10.))
                        .gap(px(12.))
                        .items_center()
                        .rounded(px(6.))
                        .border_1()
                        .border_color(p.border)
                        .bg(p.card)
                        .child(
                            div()
                                .flex_shrink_0()
                                .px(px(6.))
                                .py(px(1.))
                                .rounded(px(4.))
                                .bg(p.secondary)
                                .text_size(px(11.))
                                .text_color(p.muted_foreground)
                                .child(kind),
                        )
                        .child(div().flex_1().min_w_0().child(text))
                        .child(
                            div()
                                .id(("forget", ix))
                                .px(px(8.))
                                .py(px(3.))
                                .rounded(px(4.))
                                .text_size(px(12.))
                                .text_color(p.muted_foreground)
                                .cursor_pointer()
                                .hover(|s| s.text_color(p.danger))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if let Some(store) = &this.store {
                                        store.forget_memory(&id);
                                    }
                                    this.reload_memories();
                                    cx.notify();
                                }))
                                .child("忘记"),
                        )
                },
            )))
    }

    /// Scheduled-task list with pause/resume/delete. Tasks are created in
    /// conversation (the schedule tool); this pane manages them.
    fn schedule_pane(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);
        let rows: Vec<(String, gpui::SharedString, gpui::SharedString, bool)> = self
            .tasks
            .iter()
            .map(|t| {
                let when = t
                    .cron
                    .as_deref()
                    .map(|c| format!("周期 {c}"))
                    .unwrap_or_else(|| "单次".to_string());
                (
                    t.id.clone(),
                    crate::app::shared(&t.prompt),
                    crate::app::shared(&when),
                    t.active,
                )
            })
            .collect();

        v_flex()
            .id("schedule-body")
            .flex_1()
            .overflow_y_scroll()
            .px(px(24.))
            .pt(px(20.))
            .pb(px(28.))
            .child(
                div()
                    .mb(px(12.))
                    .text_size(px(12.))
                    .text_color(p.muted_foreground)
                    .child("在对话里让助手安排的定时任务。任务只在这台设备、应用打开时运行。"),
            )
            .when(rows.is_empty(), |s| {
                s.child(
                    div()
                        .py(px(24.))
                        .text_color(p.muted_foreground)
                        .child("还没有计划任务。试试在对话里说\u{201c}每天早上九点提醒我看日程\u{201d}。"),
                )
            })
            .child(v_flex().gap(px(6.)).children(rows.into_iter().enumerate().map(
                |(ix, (id, prompt, when, active))| {
                    let toggle_id = id.clone();
                    let delete_id = id;
                    h_flex()
                        .px(px(14.))
                        .py(px(10.))
                        .gap(px(12.))
                        .items_center()
                        .rounded(px(6.))
                        .border_1()
                        .border_color(p.border)
                        .bg(p.card)
                        .child(
                            v_flex()
                                .flex_1()
                                .min_w_0()
                                .gap(px(2.))
                                .child(
                                    div()
                                        .truncate()
                                        .when(!active, |s| s.text_color(p.muted_foreground))
                                        .child(prompt),
                                )
                                .child(
                                    div()
                                        .text_size(px(11.))
                                        .text_color(p.muted_foreground)
                                        .child(when),
                                ),
                        )
                        .child(
                            div()
                                .id(("task-toggle", ix))
                                .px(px(8.))
                                .py(px(3.))
                                .rounded(px(4.))
                                .text_size(px(12.))
                                .text_color(p.muted_foreground)
                                .cursor_pointer()
                                .hover(|s| s.text_color(p.foreground))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if let Some(store) = &this.store {
                                        store.set_task_active(&toggle_id, !active);
                                    }
                                    this.reload_tasks();
                                    cx.notify();
                                }))
                                .child(if active { "暂停" } else { "恢复" }),
                        )
                        .child(
                            div()
                                .id(("task-delete", ix))
                                .px(px(8.))
                                .py(px(3.))
                                .rounded(px(4.))
                                .text_size(px(12.))
                                .text_color(p.muted_foreground)
                                .cursor_pointer()
                                .hover(|s| s.text_color(p.danger))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if let Some(store) = &this.store {
                                        store.delete_task(&delete_id);
                                    }
                                    this.reload_tasks();
                                    cx.notify();
                                }))
                                .child("删除"),
                        )
                },
            )))
    }

    fn about_pane(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);
        v_flex()
            .flex_1()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .child(div().text_size(px(20.)).font_semibold().child("Flairy"))
            .child(
                div()
                    .text_color(p.muted_foreground)
                    .child(concat!("版本 ", env!("CARGO_PKG_VERSION"))),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(p.muted_foreground)
                    .child("你的桌面 AI 助手"),
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

/// A row with a segmented set of choices; the current one is highlighted.
fn choice_row(
    p: &theme::Palette,
    label: &'static str,
    options: &[(&'static str, &'static str)],
    current: &str,
    on_pick: impl Fn(&&'static str, &mut Window, &mut App) + 'static,
    last: bool,
) -> impl IntoElement {
    let on_pick = std::rc::Rc::new(on_pick);
    h_flex()
        .min_h(px(46.))
        .px(px(14.))
        .py(px(8.))
        .gap(px(16.))
        .items_center()
        .when(!last, |s| s.border_b_1().border_color(p.border.opacity(0.6)))
        .child(div().flex_1().child(label))
        .child(
            h_flex()
                .rounded(px(5.))
                .border_1()
                .border_color(p.input)
                .overflow_hidden()
                .children(options.iter().map(|(value, text)| {
                    let is_current = *value == current;
                    let on_pick = on_pick.clone();
                    let value = *value;
                    div()
                        .id(*text)
                        .px(px(10.))
                        .py(px(4.))
                        .text_size(px(12.))
                        .cursor_pointer()
                        .when(is_current, |s| {
                            s.bg(p.primary).text_color(p.primary_foreground)
                        })
                        .when(!is_current, |s| s.hover(|s| s.bg(p.accent)))
                        .on_click(move |_, window, cx| on_pick(&value, window, cx))
                        .child(*text)
                })),
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
