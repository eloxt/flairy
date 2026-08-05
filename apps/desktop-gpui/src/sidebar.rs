use gpui::prelude::FluentBuilder;
use gpui::{
    Context, Focusable, InteractiveElement, IntoElement, ParentElement,
    StatefulInteractiveElement, Styled, WindowControlArea, div, px,
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
            .child(if self.search_active {
                // Live filter input; the X (or emptying the query) closes it.
                h_flex()
                    .id("search")
                    .h(px(36.))
                    .px(px(12.))
                    .gap(px(8.))
                    .items_center()
                    .rounded(px(5.))
                    .bg(p.sidebar_accent)
                    .child(icon("icons/search.svg").size(px(16.)))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(gpui_component::input::Input::new(&self.search_input).appearance(false)),
                    )
                    .child(
                        div()
                            .id("search-close")
                            .size(px(20.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(4.))
                            .cursor_pointer()
                            .text_color(p.muted_foreground)
                            .hover(|s| s.text_color(p.foreground))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.search_active = false;
                                this.search_input
                                    .update(cx, |state, cx| state.set_value("", window, cx));
                                cx.notify();
                            }))
                            .child(icon("icons/x.svg").size(px(14.))),
                    )
                    .into_any_element()
            } else {
                h_flex()
                    .id("search")
                    .h(px(36.))
                    .px(px(12.))
                    .gap(px(8.))
                    .items_center()
                    .rounded(px(5.))
                    .hover(|s| s.bg(p.sidebar_accent))
                    .cursor_pointer()
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.search_active = true;
                        this.tab = SidebarTab::Chats;
                        window.focus(&this.search_input.read(cx).focus_handle(cx));
                        cx.notify();
                    }))
                    .child(icon("icons/search.svg").size(px(16.)))
                    .child(div().child("Search"))
                    .into_any_element()
            })
    }

    fn sidebar_tabs(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);
        let active = self.tab;

        // Zed attached-tab style: the active tab shares the panel background
        // and has no bottom border (it merges into the list below); inactive
        // tabs sit on a darker wash with the baseline running under them.
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
                .text_size(px(13.))
                .when(is_active, |s| s.font_medium())
                .text_color(if is_active { p.foreground } else { p.muted_foreground })
                .when(!is_active, |s| {
                    s.bg(p.sidebar_accent.opacity(0.45))
                        .border_b_1()
                        .border_color(p.sidebar_border)
                        .hover(|s| s.text_color(p.foreground))
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.tab = tab;
                    cx.notify();
                }))
                .child(crate::app::tab_label(tab))
        };

        h_flex()
            .h(px(34.))
            .flex_shrink_0()
            .border_t_1()
            .border_color(p.sidebar_border)
            .child(
                cell("tab-chats", SidebarTab::Chats, cx)
                    .border_r_1()
                    .border_color(p.sidebar_border),
            )
            .child(cell("tab-projects", SidebarTab::Projects, cx))
    }

    fn chats_list(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let p = theme::palette(cx);
        let active_ix = self.active_session;
        let renaming = self.renaming;
        let query = if self.search_active {
            self.search_input.read(cx).value().trim().to_lowercase()
        } else {
            String::new()
        };
        let rows: Vec<(usize, gpui::SharedString, bool)> = self
            .sessions
            .iter()
            .enumerate()
            .filter(|(_, s)| s.workspace_path.is_none())
            .filter(|(_, s)| query.is_empty() || session_matches(s, &query))
            .map(|(ix, s)| (ix, crate::app::shared(&s.title), s.running))
            .collect();
        let empty_hint = !query.is_empty() && rows.is_empty();

        v_flex()
            .id("chats")
            .flex_1()
            .overflow_y_scroll()
            .px(px(8.))
            .py(px(6.))
            .gap(px(2.))
            .when(empty_hint, |s| {
                s.child(
                    div()
                        .px(px(8.))
                        .py(px(8.))
                        .text_size(px(12.))
                        .text_color(p.muted_foreground)
                        .child("没有匹配的会话"),
                )
            })
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
        let active_ix = self.active_session;

        // Group project sessions by workspace, newest group first.
        let mut groups: Vec<(String, Vec<(usize, gpui::SharedString, bool)>)> = Vec::new();
        for (ix, session) in self.sessions.iter().enumerate() {
            let Some(workspace) = &session.workspace_path else { continue };
            let row = (ix, crate::app::shared(&session.title), session.running);
            match groups.iter_mut().find(|(w, _)| w == workspace) {
                Some((_, rows)) => rows.push(row),
                None => groups.push((workspace.clone(), vec![row])),
            }
        }

        v_flex()
            .id("projects")
            .flex_1()
            .overflow_y_scroll()
            .px(px(8.))
            .py(px(6.))
            .gap(px(2.))
            .child(
                h_flex()
                    .id("new-project")
                    .h(px(32.))
                    .px(px(8.))
                    .gap(px(8.))
                    .items_center()
                    .rounded(px(5.))
                    .cursor_pointer()
                    .text_color(p.muted_foreground)
                    .hover(|s| s.bg(p.sidebar_accent).text_color(p.foreground))
                    .on_click(cx.listener(|this, _, _, cx| this.new_project(cx)))
                    .child(icon("icons/plus.svg").size(px(14.)))
                    .child(div().text_size(px(13.)).child("新建项目")),
            )
            .when(groups.is_empty(), |s| {
                s.child(
                    div()
                        .px(px(8.))
                        .py(px(8.))
                        .text_size(px(12.))
                        .text_color(p.muted_foreground)
                        .child("选择一个文件夹，开始在项目里对话"),
                )
            })
            .children(groups.into_iter().enumerate().map(|(gix, (workspace, rows))| {
                let name = std::path::Path::new(&workspace)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| workspace.clone());
                let add_workspace = workspace.clone();
                v_flex()
                    .gap(px(1.))
                    .child(
                        h_flex()
                            .id(("project-group", gix))
                            .h(px(28.))
                            .px(px(8.))
                            .mt(px(6.))
                            .gap(px(6.))
                            .items_center()
                            .child(icon("icons/folder.svg").size(px(13.)).text_color(p.muted_foreground))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(12.))
                                    .font_medium()
                                    .text_color(p.muted_foreground)
                                    .child(crate::app::shared(&name)),
                            )
                            .child(
                                div()
                                    .id(("project-add", gix))
                                    .size(px(20.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(4.))
                                    .cursor_pointer()
                                    .text_color(p.muted_foreground)
                                    .hover(|s| s.bg(p.sidebar_accent).text_color(p.foreground))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.add_project_session(add_workspace.clone(), cx);
                                    }))
                                    .child(icon("icons/plus.svg").size(px(12.))),
                            ),
                    )
                    .children(rows.into_iter().map(|(ix, title, running)| {
                        let is_active = ix == active_ix;
                        h_flex()
                            .id(ix)
                            .h(px(30.))
                            .flex_shrink_0()
                            .pl(px(27.))
                            .pr(px(8.))
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
                            .context_menu(move |menu, _, _| {
                                menu.menu("重命名", Box::new(RenameSession(ix)))
                                    .separator()
                                    .menu("删除", Box::new(DeleteSession(ix)))
                            })
                    }))
            }))
    }
}

/// Case-insensitive match over the session title and message text.
fn session_matches(session: &crate::app::Session, query: &str) -> bool {
    if session.title.to_lowercase().contains(query) {
        return true;
    }
    session.msgs.iter().any(|m| match m {
        crate::app::Msg::User(text) => text.to_lowercase().contains(query),
        crate::app::Msg::Assistant { md, .. } => md.to_lowercase().contains(query),
        crate::app::Msg::Tool { .. } => false,
    })
}

impl FlairyApp {
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
