use gpui::prelude::FluentBuilder;
use gpui::{
    Context, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled,
    WindowControlArea, div, px,
};
use gpui_component::spinner::Spinner;
use gpui_component::{Icon, Sizable, h_flex, v_flex};

use crate::app::{DeleteSession, FlairyApp, RenameSession, SidebarTab, TextWeight};
use gpui_component::menu::ContextMenuExt;
use crate::theme;

fn icon(path: &'static str) -> Icon {
    Icon::empty().path(path)
}

impl FlairyApp {
    pub fn render_sidebar(&mut self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);

        v_flex()
            .w(px(256.))
            .h_full()
            .flex_shrink_0()
            .text_color(p.sidebar_foreground)
            .child(self.sidebar_header(cx))
            .child(self.sidebar_tabs(cx))
            .child(if self.tab == SidebarTab::Chats {
                self.chats_list(cx).into_any_element()
            } else {
                self.projects_list(cx).into_any_element()
            })
            .child(self.sidebar_footer(cx))
    }

    fn sidebar_header(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);

        v_flex()
            .window_control_area(WindowControlArea::Drag)
            .pt(px(44.)) // clears macOS traffic lights
            .px(px(8.))
            .pb(px(8.))
            .gap(px(8.))
            .child(
                // New chat
                h_flex()
                    .id("new-chat")
                    .h(px(36.))
                    .px(px(12.))
                    .gap(px(8.))
                    .items_center()
                    .rounded(px(5.))
                    .hover(|s| s.bg(p.sidebar_accent))
                    .cursor_pointer()
                    .on_click(cx.listener(|this, _, _, cx| this.new_chat(cx)))
                    .child(icon("icons/square-pen.svg").size(px(16.)))
                    .child(div().font_medium().child("New chat")),
            )
            .child(
                // Search
                h_flex()
                    .id("search")
                    .h(px(36.))
                    .px(px(12.))
                    .gap(px(8.))
                    .items_center()
                    .rounded(px(5.))
                    .hover(|s| s.bg(p.sidebar_accent))
                    .cursor_pointer()
                    .child(icon("icons/search.svg").size(px(16.)))
                    .child(div().child("Search")),
            )
    }

    fn sidebar_tabs(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);
        let active = self.tab;

        // Zed tab-bar language: full-width baseline, active tab carries a
        // 2px underline sitting on it.
        let cell = |id: &'static str, tab: SidebarTab, cx: &mut Context<Self>| {
            let p = theme::palette(cx);
            let is_active = tab == active;
            div()
                .id(id)
                .flex_1()
                .h_full()
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .border_b_2()
                .border_color(if is_active { p.foreground } else { gpui::transparent_black() })
                .text_size(px(13.))
                .when(is_active, |s| s.font_medium())
                .text_color(if is_active { p.foreground } else { p.muted_foreground })
                .hover(|s| s.text_color(p.foreground))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.tab = tab;
                    cx.notify();
                }))
                .child(crate::app::tab_label(tab))
        };

        h_flex()
            .h(px(34.))
            .flex_shrink_0()
            .border_b_1()
            .border_color(p.sidebar_border)
            .child(cell("tab-chats", SidebarTab::Chats, cx))
            .child(cell("tab-projects", SidebarTab::Projects, cx))
    }

    fn chats_list(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);
        let active_ix = self.active_session;
        let renaming = self.renaming;
        let rows: Vec<(usize, gpui::SharedString, bool)> = self
            .sessions
            .iter()
            .enumerate()
            .map(|(ix, s)| (ix, crate::app::shared(&s.title), s.running))
            .collect();

        v_flex()
            .id("chats")
            .flex_1()
            .overflow_y_scroll()
            .px(px(8.))
            .py(px(6.))
            .gap(px(2.))
            .children(rows.into_iter().map(|(ix, title, running)| {
                let is_active = ix == active_ix;
                if renaming == Some(ix) {
                    // Inline rename: input swaps in; Enter commits.
                    return h_flex()
                        .id(ix)
                        .h(px(32.))
                        .flex_shrink_0()
                        .px(px(8.))
                        .items_center()
                        .rounded(px(5.))
                        .bg(p.sidebar_accent)
                        .child(
                            div()
                                .flex_1()
                                .text_size(px(13.))
                                .child(gpui_component::input::Input::new(&self.rename_input).appearance(false)),
                        )
                        .into_any_element();
                }
                h_flex()
                    .id(ix)
                    .h(px(32.))
                    .flex_shrink_0()
                    .px(px(8.))
                    .gap(px(6.))
                    .items_center()
                    .rounded(px(5.))
                    .cursor_pointer()
                    .hover(|s| s.bg(p.sidebar_accent))
                    .when(is_active, |s| s.bg(p.sidebar_accent).font_medium())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.active_session = ix;
                        this.commit_rename(cx);
                        cx.notify();
                    }))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(13.))
                            .child(title),
                    )
                    .when(running, |s| s.child(Spinner::new().with_size(px(14.))))
                    // Right-click: native-style context menu (like Electron).
                    .context_menu(move |menu, _, _| {
                        menu.menu("重命名", Box::new(RenameSession(ix)))
                            .separator()
                            .menu("删除", Box::new(DeleteSession(ix)))
                    })
                    .into_any_element()
            }))
    }

    fn projects_list(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);
        v_flex()
            .id("projects")
            .flex_1()
            .overflow_y_scroll()
            .px(px(8.))
            .py(px(6.))
            .child(
                div()
                    .px(px(8.))
                    .py(px(8.))
                    .text_size(px(12.))
                    .text_color(p.muted_foreground)
                    .child("暂无项目"),
            )
    }

    fn sidebar_footer(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);

        div().p(px(8.)).child(
            h_flex()
                .id("settings")
                .h(px(36.))
                .px(px(12.))
                .gap(px(8.))
                .items_center()
                .rounded(px(5.))
                .text_color(p.muted_foreground)
                .cursor_pointer()
                .hover(|s| s.bg(p.sidebar_accent))
                .on_click(cx.listener(|_, _, _, cx| crate::settings::open(cx)))
                .child(icon("icons/settings.svg").size(px(16.)))
                .child(div().child("Settings")),
        )
    }
}
