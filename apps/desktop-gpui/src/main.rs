mod agent_runtime;
mod app;
mod assets;
mod auth;
mod cards;
mod chat;
mod config_cache;
mod contract;
mod file_tools;
mod mcp;
mod right_panel;
mod schedule;
mod server_client;
mod settings;
mod sidebar;
mod skills;
mod store;
mod theme;
mod todo;
mod web_tools;

use gpui::{
    App, AppContext, Application, Bounds, Menu, MenuItem, TitlebarOptions, WindowBounds,
    WindowOptions, actions, point, px, size,
};

actions!(flairy, [Quit]);
use gpui_component::Root;

use app::FlairyApp;
use assets::Assets;

fn main() {
    let app = Application::new().with_assets(Assets);

    app.run(move |cx: &mut App| {
        // Embedded UI fonts (IBM Plex Sans/Mono — the Zed design language).
        let fonts: Vec<std::borrow::Cow<'static, [u8]>> =
            ["fonts/IBMPlexSans.ttf", "fonts/IBMPlexMono.ttf"]
                .iter()
                .filter_map(|path| Assets::get(path).map(|f| f.data))
                .collect();
        let _ = cx.text_system().add_fonts(fonts);

        gpui_component::init(cx);
        theme::init(cx);
        flairy_markdown::init(cx);

        // Own the macOS menu bar (otherwise the previous app's menus linger).
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.set_menus(vec![Menu {
            name: "Flairy".into(),
            items: vec![MenuItem::action("退出 Flairy", Quit)],
        }]);
        cx.activate(true);

        let bounds = Bounds::centered(None, size(px(1200.), px(800.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some("Flairy".into()),
                appears_transparent: true,
                traffic_light_position: Some(point(px(20.), px(20.))),
            }),
            window_min_size: Some(size(px(800.), px(600.))),
            ..Default::default()
        };

        cx.spawn(async move |cx| {
            cx.open_window(options, |window, cx| {
                // Live light/dark switching with the system.
                window
                    .observe_window_appearance(|window, cx| {
                        theme::sync_appearance(window.appearance(), cx);
                        window.refresh();
                    })
                    .detach();
                let view = cx.new(|cx| FlairyApp::new(window, cx));
                cx.new(|cx| Root::new(view, window, cx))
            })?;
            Ok::<_, anyhow::Error>(())
        })
        .detach();
    });
}
