//! Flairy palette — Zed One Light / One Dark language: solid 1px borders,
//! gray scale everywhere, a single blue accent (primary/send/links).

use gpui::{App, Hsla, WindowAppearance, px, rgb, rgba};
use gpui_component::highlighter::HighlightTheme;
use gpui_component::{Theme, ThemeMode};

pub struct Palette {
    pub background: Hsla,
    pub foreground: Hsla,
    pub card: Hsla,
    pub border: Hsla,
    pub input: Hsla,
    pub ring: Hsla,
    pub primary: Hsla,
    pub primary_hover: Hsla,
    pub primary_active: Hsla,
    pub primary_foreground: Hsla,
    pub secondary: Hsla,
    pub secondary_hover: Hsla,
    pub secondary_active: Hsla,
    pub secondary_foreground: Hsla,
    pub muted: Hsla,
    pub muted_foreground: Hsla,
    pub accent: Hsla,
    pub popover: Hsla,
    pub sidebar: Hsla,
    pub sidebar_foreground: Hsla,
    pub sidebar_accent: Hsla,
    pub sidebar_border: Hsla,
    pub danger: Hsla,
    pub selection: Hsla,
    pub scrollbar_thumb: Hsla,
}

pub fn light() -> Palette {
    Palette {
        background: rgb(0xfafafa).into(),
        foreground: rgb(0x383a42).into(),
        card: rgb(0xf2f2f3).into(),
        border: rgb(0xd6d6d8).into(),
        input: rgb(0xc9c9cb).into(),
        ring: rgb(0x3072e8).into(),
        primary: rgb(0x3072e8).into(),
        primary_hover: rgb(0x2861c9).into(),
        primary_active: rgb(0x2458b8).into(),
        primary_foreground: rgb(0xffffff).into(),
        secondary: rgb(0xf1f1f2).into(),
        secondary_hover: rgb(0xe9e9ea).into(),
        secondary_active: rgb(0xe2e2e4).into(),
        secondary_foreground: rgb(0x383a42).into(),
        muted: rgb(0xf0f0f1).into(),
        muted_foreground: rgb(0x8a8d94).into(),
        accent: rgba(0x0000000f).into(),
        popover: rgb(0xffffff).into(),
        sidebar: rgb(0xf0f0f1).into(),
        sidebar_foreground: rgb(0x494c55).into(),
        sidebar_accent: rgb(0xdfe0e2).into(),
        sidebar_border: rgb(0xd6d6d8).into(),
        danger: rgb(0xe45649).into(),
        selection: rgba(0x3072e833).into(),
        scrollbar_thumb: rgba(0x00000029).into(),
    }
}

pub fn dark() -> Palette {
    Palette {
        background: rgb(0x282c33).into(),
        foreground: rgb(0xc8ccd4).into(),
        card: rgb(0x2f343c).into(),
        border: rgb(0x40454f).into(),
        input: rgb(0x4a505b).into(),
        ring: rgb(0x74ade8).into(),
        primary: rgb(0x74ade8).into(),
        primary_hover: rgb(0x85b8ec).into(),
        primary_active: rgb(0x5e9bdc).into(),
        primary_foreground: rgb(0x22262c).into(),
        secondary: rgb(0x2f343c).into(),
        secondary_hover: rgb(0x353a43).into(),
        secondary_active: rgb(0x3a404a).into(),
        secondary_foreground: rgb(0xc8ccd4).into(),
        muted: rgb(0x22262c).into(),
        muted_foreground: rgb(0x838994).into(),
        accent: rgba(0xffffff12).into(),
        popover: rgb(0x2f343c).into(),
        sidebar: rgb(0x22262c).into(),
        sidebar_foreground: rgb(0xb4b9c2).into(),
        sidebar_accent: rgb(0x3a3f47).into(),
        sidebar_border: rgb(0x40454f).into(),
        danger: rgb(0xd07277).into(),
        selection: rgba(0x74ade84d).into(),
        scrollbar_thumb: rgba(0xffffff29).into(),
    }
}

pub fn is_dark(cx: &App) -> bool {
    Theme::global(cx).mode.is_dark()
}

pub fn palette(cx: &App) -> Palette {
    if is_dark(cx) { dark() } else { light() }
}

/// Apply the Obsidian palette for the current system appearance.
pub fn init(cx: &mut App) {
    let appearance = cx.window_appearance();
    sync_appearance(appearance, cx);
}

/// (Re)apply the palette for a given appearance — startup + live switches.
pub fn sync_appearance(appearance: WindowAppearance, cx: &mut App) {
    let dark_mode = matches!(
        appearance,
        WindowAppearance::Dark | WindowAppearance::VibrantDark
    );
    let p = if dark_mode { dark() } else { light() };

    let theme = Theme::global_mut(cx);
    theme.mode = if dark_mode { ThemeMode::Dark } else { ThemeMode::Light };
    theme.highlight_theme = if dark_mode {
        HighlightTheme::default_dark()
    } else {
        HighlightTheme::default_light()
    };
    theme.font_family = "IBM Plex Sans".into();
    theme.mono_font_family = "IBM Plex Mono".into();
    theme.font_size = px(14.);
    theme.radius = px(6.);
    theme.radius_lg = px(8.);

    let c = &mut theme.colors;
    c.background = p.background;
    c.foreground = p.foreground;
    c.border = p.border;
    c.input = p.input;
    c.ring = p.ring;
    c.caret = p.foreground;
    c.primary = p.primary;
    c.primary_hover = p.primary_hover;
    c.primary_active = p.primary_active;
    c.primary_foreground = p.primary_foreground;
    c.secondary = p.secondary;
    c.secondary_hover = p.secondary_hover;
    c.secondary_active = p.secondary_active;
    c.secondary_foreground = p.secondary_foreground;
    c.muted = p.muted;
    c.muted_foreground = p.muted_foreground;
    c.accent = p.accent;
    c.accent_foreground = p.foreground;
    c.popover = p.popover;
    c.popover_foreground = p.foreground;
    c.sidebar = p.sidebar;
    c.sidebar_foreground = p.sidebar_foreground;
    c.sidebar_accent = p.sidebar_accent;
    c.sidebar_accent_foreground = p.foreground;
    c.sidebar_border = p.sidebar_border;
    c.sidebar_primary = p.primary;
    c.sidebar_primary_foreground = p.primary_foreground;
    c.danger = p.danger;
    c.selection = p.selection;
    c.list = p.background;
    c.list_hover = p.accent;
    c.list_active = p.accent;
    c.scrollbar_thumb = p.scrollbar_thumb;
    c.title_bar = p.sidebar;
}
