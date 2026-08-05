//! Inline `ui:*` card protocol — port of the Electron client's shared/cards.
//! The model embeds structured UI as ```ui:<type> fences whose body is JSON;
//! the markdown renderer's fence hook dispatches here. 8 card types (chart is
//! not yet rendered and therefore not advertised in the prompt).

use gpui::prelude::*;
use gpui::{AnyElement, App, Hsla, SharedString, Window, div, px, rgb};
use serde_json::Value;

use crate::theme::Palette;

const MAX_FIELD_LEN: usize = 500;

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|x| x.chars().take(MAX_FIELD_LEN).collect::<String>())
        .filter(|x| !x.is_empty())
}

fn shared(text: &str) -> SharedString {
    SharedString::from(text.to_string())
}

/// Semantic accents beyond the base palette (One light/dark greens+oranges).
struct Accents {
    good: Hsla,
    bad: Hsla,
    warning: Hsla,
}

fn accents(is_dark: bool) -> Accents {
    if is_dark {
        Accents { good: rgb(0x98c379).into(), bad: rgb(0xd07277).into(), warning: rgb(0xd19a66).into() }
    } else {
        Accents { good: rgb(0x50a14f).into(), bad: rgb(0xe45649).into(), warning: rgb(0xc18401).into() }
    }
}

/// Suggestion click sink: sends the text as the user's next message.
pub type SuggestFn = std::rc::Rc<dyn Fn(String, &mut Window, &mut App)>;

/// Render one card, or None when the body isn't (yet) valid JSON — the
/// renderer then shows a streaming placeholder.
pub fn render_card(
    lang: &str,
    body: &str,
    p: &Palette,
    is_dark: bool,
    suggest: SuggestFn,
) -> Option<AnyElement> {
    let v: Value = serde_json::from_str(body.trim()).ok()?;
    let a = accents(is_dark);
    match lang {
        "ui:note" => note_card(&v, p, &a),
        "ui:kv_list" => kv_list_card(&v, p, &a),
        "ui:stat" => stat_card(&v, p, &a),
        "ui:suggestions" => suggestions_card(&v, p, suggest),
        "ui:compare" => compare_card(&v, p, &a),
        "ui:table" => table_card(&v, p, &a),
        "ui:timeline" => timeline_card(&v, p, &a),
        "ui:progress" => progress_card(&v, p, &a),
        _ => None,
    }
}

fn card_shell(p: &Palette) -> gpui::Div {
    div()
        .my(px(2.))
        .rounded(px(8.))
        .border_1()
        .border_color(p.border)
        .bg(p.card)
        .px(px(14.))
        .py(px(10.))
        .flex()
        .flex_col()
        .gap(px(6.))
}

fn card_title(title: Option<String>, p: &Palette) -> Option<AnyElement> {
    title.map(|t| {
        div()
            .text_size(px(12.))
            .font_weight(gpui::FontWeight::SEMIBOLD)
            .text_color(p.muted_foreground)
            .child(shared(&t))
            .into_any_element()
    })
}

fn note_card(v: &Value, p: &Palette, a: &Accents) -> Option<AnyElement> {
    let text = s(v, "text")?;
    let accent = match s(v, "tone").as_deref() {
        Some("warning") => a.warning,
        Some("danger") => a.bad,
        Some("success") => a.good,
        _ => p.primary,
    };
    Some(
        div()
            .my(px(2.))
            .rounded(px(6.))
            .border_l_2()
            .border_color(accent)
            .bg(accent.opacity(0.08))
            .px(px(12.))
            .py(px(8.))
            .flex()
            .flex_col()
            .gap(px(2.))
            .children(s(v, "title").map(|t| {
                div()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(accent)
                    .child(shared(&t))
            }))
            .child(div().child(shared(&text)))
            .into_any_element(),
    )
}

fn kv_list_card(v: &Value, p: &Palette, a: &Accents) -> Option<AnyElement> {
    let items = v.get("items")?.as_array()?;
    let rows: Vec<AnyElement> = items
        .iter()
        .take(30)
        .filter_map(|item| {
            let label = s(item, "label")?;
            let value = s(item, "value")?;
            let color = match s(item, "emphasis").as_deref() {
                Some("good") => a.good,
                Some("bad") => a.bad,
                _ => p.foreground,
            };
            Some(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(12.))
                    .items_start()
                    .child(
                        div()
                            .w(px(120.))
                            .flex_shrink_0()
                            .text_color(p.muted_foreground)
                            .child(shared(&label)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(div().text_color(color).child(shared(&value)))
                            .children(s(item, "hint").map(|h| {
                                div()
                                    .text_size(px(11.))
                                    .text_color(p.muted_foreground)
                                    .child(shared(&h))
                            })),
                    )
                    .into_any_element(),
            )
        })
        .collect();
    if rows.is_empty() {
        return None;
    }
    Some(
        card_shell(p)
            .children(card_title(s(v, "title"), p))
            .children(rows)
            .into_any_element(),
    )
}

fn stat_card(v: &Value, p: &Palette, a: &Accents) -> Option<AnyElement> {
    let items = v.get("items")?.as_array()?;
    let tiles: Vec<AnyElement> = items
        .iter()
        .take(6)
        .filter_map(|item| {
            let label = s(item, "label")?;
            let value = s(item, "value")?;
            let trend_color = match s(item, "trendTone").as_deref() {
                Some("good") => a.good,
                Some("bad") => a.bad,
                _ => p.muted_foreground,
            };
            Some(
                div()
                    .flex_1()
                    .min_w(px(90.))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(p.muted_foreground)
                            .child(shared(&label)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_end()
                            .gap(px(3.))
                            .child(
                                div()
                                    .text_size(px(20.))
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .child(shared(&value)),
                            )
                            .children(s(item, "unit").map(|u| {
                                div()
                                    .text_size(px(11.))
                                    .pb(px(3.))
                                    .text_color(p.muted_foreground)
                                    .child(shared(&u))
                            })),
                    )
                    .children(s(item, "trendText").map(|t| {
                        div().text_size(px(11.)).text_color(trend_color).child(shared(&t))
                    }))
                    .into_any_element(),
            )
        })
        .collect();
    if tiles.is_empty() {
        return None;
    }
    Some(
        card_shell(p)
            .children(card_title(s(v, "title"), p))
            .child(div().flex().flex_row().flex_wrap().gap(px(16.)).children(tiles))
            .into_any_element(),
    )
}

fn suggestions_card(v: &Value, p: &Palette, suggest: SuggestFn) -> Option<AnyElement> {
    let items = v.get("items")?.as_array()?;
    let buttons: Vec<AnyElement> = items
        .iter()
        .take(4)
        .enumerate()
        .filter_map(|(ix, item)| {
            let label = s(item, "label")?;
            let text = s(item, "userText").unwrap_or_else(|| label.clone());
            let suggest = suggest.clone();
            Some(
                div()
                    .id(("ui-suggestion", ix))
                    .px(px(12.))
                    .py(px(5.))
                    .rounded(px(14.))
                    .border_1()
                    .border_color(p.primary.opacity(0.5))
                    .text_size(px(12.5))
                    .text_color(p.primary)
                    .cursor_pointer()
                    .hover(|st| st.bg(p.primary.opacity(0.08)))
                    .on_click(move |_, window, cx| suggest(text.clone(), window, cx))
                    .child(shared(&label))
                    .into_any_element(),
            )
        })
        .collect();
    if buttons.is_empty() {
        return None;
    }
    Some(
        div()
            .my(px(4.))
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(8.))
            .children(buttons)
            .into_any_element(),
    )
}

fn compare_card(v: &Value, p: &Palette, a: &Accents) -> Option<AnyElement> {
    let rows = v.get("rows")?.as_array()?;
    let cards: Vec<AnyElement> = rows
        .iter()
        .take(20)
        .filter_map(|row| {
            let name = s(row, "name")?;
            let pick = row.get("pick").and_then(|x| x.as_bool()).unwrap_or(false);
            let attrs: Vec<AnyElement> = row
                .get("attrs")
                .and_then(|x| x.as_array())
                .map(|attrs| {
                    attrs
                        .iter()
                        .take(8)
                        .filter_map(|attr| {
                            let label = s(attr, "label")?;
                            let value = s(attr, "value")?;
                            let color = match s(attr, "tone").as_deref() {
                                Some("good") => a.good,
                                Some("bad") => a.bad,
                                _ => p.foreground,
                            };
                            Some(
                                div()
                                    .flex()
                                    .flex_row()
                                    .gap(px(8.))
                                    .text_size(px(12.5))
                                    .child(
                                        div()
                                            .w(px(96.))
                                            .flex_shrink_0()
                                            .text_color(p.muted_foreground)
                                            .child(shared(&label)),
                                    )
                                    .child(div().text_color(color).child(shared(&value)))
                                    .into_any_element(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(
                div()
                    .flex_1()
                    .min_w(px(180.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(if pick { p.primary } else { p.border })
                    .bg(p.background)
                    .px(px(12.))
                    .py(px(8.))
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                div()
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .child(shared(&name)),
                            )
                            .children(pick.then(|| {
                                div()
                                    .px(px(6.))
                                    .py(px(1.))
                                    .rounded(px(4.))
                                    .bg(p.primary)
                                    .text_color(p.primary_foreground)
                                    .text_size(px(10.))
                                    .child("推荐")
                            })),
                    )
                    .children(attrs)
                    .children(s(row, "note").map(|n| {
                        div()
                            .text_size(px(11.5))
                            .text_color(p.muted_foreground)
                            .child(shared(&n))
                    }))
                    .into_any_element(),
            )
        })
        .collect();
    if cards.is_empty() {
        return None;
    }
    Some(
        card_shell(p)
            .children(card_title(s(v, "title"), p))
            .child(div().flex().flex_row().flex_wrap().gap(px(8.)).children(cards))
            .into_any_element(),
    )
}

fn table_card(v: &Value, p: &Palette, a: &Accents) -> Option<AnyElement> {
    let columns = v.get("columns")?.as_array()?;
    let headers: Vec<String> = columns
        .iter()
        .take(12)
        .filter_map(|c| c.as_str().map(str::to_string))
        .collect();
    if headers.is_empty() {
        return None;
    }
    let emphasize = v.get("emphasizeRowIndex").and_then(|x| x.as_u64()).map(|x| x as usize);
    let rows = v.get("rows")?.as_array()?;
    let body: Vec<AnyElement> = rows
        .iter()
        .take(50)
        .enumerate()
        .map(|(rix, row)| {
            let tone = s(row, "tone");
            let text_color = match tone.as_deref() {
                Some("good") => a.good,
                Some("bad") => a.bad,
                Some("muted") => p.muted_foreground,
                _ => p.foreground,
            };
            let cells: Vec<AnyElement> = row
                .get("cells")
                .and_then(|c| c.as_array())
                .map(|cells| {
                    cells
                        .iter()
                        .take(headers.len())
                        .map(|cell| {
                            div()
                                .flex_1()
                                .min_w_0()
                                .px(px(8.))
                                .py(px(4.))
                                .text_color(text_color)
                                .child(shared(cell.as_str().unwrap_or_default()))
                                .into_any_element()
                        })
                        .collect()
                })
                .unwrap_or_default();
            div()
                .flex()
                .flex_row()
                .border_t_1()
                .border_color(p.border.opacity(0.6))
                .when(emphasize == Some(rix), |st| st.bg(p.primary.opacity(0.08)))
                .children(cells)
                .into_any_element()
        })
        .collect();
    Some(
        card_shell(p)
            .children(card_title(s(v, "title"), p))
            .child(
                div()
                    .rounded(px(6.))
                    .border_1()
                    .border_color(p.border)
                    .overflow_hidden()
                    .text_size(px(12.5))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .bg(p.secondary)
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .children(headers.iter().map(|h| {
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .px(px(8.))
                                    .py(px(4.))
                                    .child(shared(h))
                                    .into_any_element()
                            })),
                    )
                    .children(body),
            )
            .into_any_element(),
    )
}

fn timeline_card(v: &Value, p: &Palette, a: &Accents) -> Option<AnyElement> {
    let steps = v.get("steps")?.as_array()?;
    let rows: Vec<AnyElement> = steps
        .iter()
        .take(30)
        .filter_map(|step| {
            let label = s(step, "label")?;
            let (mark, color) = match s(step, "status").as_deref() {
                Some("done") => ("●", a.good),
                Some("active") => ("●", p.primary),
                Some("failed") => ("●", a.bad),
                _ => ("○", p.muted_foreground),
            };
            Some(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(8.))
                    .items_start()
                    .child(div().text_color(color).child(mark))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .gap(px(8.))
                                    .items_baseline()
                                    .child(div().child(shared(&label)))
                                    .children(s(step, "time").map(|t| {
                                        div()
                                            .text_size(px(11.))
                                            .text_color(p.muted_foreground)
                                            .child(shared(&t))
                                    })),
                            )
                            .children(s(step, "note").map(|n| {
                                div()
                                    .text_size(px(11.5))
                                    .text_color(p.muted_foreground)
                                    .child(shared(&n))
                            })),
                    )
                    .into_any_element(),
            )
        })
        .collect();
    if rows.is_empty() {
        return None;
    }
    Some(
        card_shell(p)
            .children(card_title(s(v, "title"), p))
            .children(rows)
            .into_any_element(),
    )
}

fn progress_card(v: &Value, p: &Palette, a: &Accents) -> Option<AnyElement> {
    let label = s(v, "label")?;
    let value = v.get("value")?.as_f64()?.clamp(0., 100.);
    let accent = match s(v, "tone").as_deref() {
        Some("warning") => a.warning,
        Some("danger") => a.bad,
        Some("success") => a.good,
        _ => p.primary,
    };
    let value_text = s(v, "valueText").unwrap_or_else(|| format!("{}%", value.round() as i64));
    Some(
        card_shell(p)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .text_size(px(12.5))
                    .child(shared(&label))
                    .child(div().text_color(p.muted_foreground).child(shared(&value_text))),
            )
            .child(
                div().h(px(6.)).rounded(px(3.)).bg(p.secondary).child(
                    div()
                        .h_full()
                        .rounded(px(3.))
                        .bg(accent)
                        .w(gpui::relative((value / 100.) as f32)),
                ),
            )
            .into_any_element(),
    )
}

// ---------------------------------------------------------------------------
// Prompt vocabulary ({{cards}} placeholder) — port of buildCardsPrompt.
// ui:chart is excluded until this client renders it.
// ---------------------------------------------------------------------------

const SNIPPET_COMPARE: &str = "```ui:compare\n{\"title\": \"optional title\", \"rows\": [{\"name\": \"option name (required)\", \"pick\": true, \"attrs\": [{\"label\": \"dimension name\", \"value\": \"value text\", \"tone\": \"good|bad\"}], \"note\": \"one-line note\"}]}\n```\nSide-by-side comparison of plans/options; use when contrasting 3 or more items. attrs are the compared dimensions (up to 8; keep the same dimensions in the same order across rows); tone applies a positive/negative accent to a dimension value; pick marks the recommended item (at most one).";
const SNIPPET_KV: &str = "```ui:kv_list\n{\"title\": \"optional title\", \"items\": [{\"label\": \"field name (required)\", \"value\": \"value (required)\", \"hint\": \"secondary hint text\", \"emphasis\": \"good|bad\"}]}\n```\nMulti-field status display for a single entity (5+ fields, e.g. order/booking details); emphasis applies a positive/negative accent color to key values.";
const SNIPPET_TIMELINE: &str = "```ui:timeline\n{\"title\": \"optional title\", \"steps\": [{\"label\": \"step name (required)\", \"status\": \"done|active|pending|failed\", \"time\": \"time text\", \"note\": \"note\"}]}\n```\nProcess tracking / step progress (logistics checkpoints, processing progress, approval status).";
const SNIPPET_NOTE: &str = "```ui:note\n{\"tone\": \"info|warning|danger|success\", \"title\": \"optional title\", \"text\": \"notice body (required)\"}\n```\nAlerts/risks/compliance notices/success confirmations that need the user's attention; do not use for ordinary explanations.";
const SNIPPET_SUGGESTIONS: &str = "```ui:suggestions\n{\"items\": [{\"label\": \"button text, within 30 characters (required)\", \"userText\": \"the full question actually sent on click; defaults to label\"}]}\n```\nSuggest what the user might ask next: 1-4 buttons placed at the end of the answer, at most one per response. Button semantics are \"the user's next utterance\" (a question/query) — clicking just sends that text as the user's next message; write them as questions the user would ask, not as commands to perform an action.";
const SNIPPET_STAT: &str = "```ui:stat\n{\"title\": \"optional title\", \"items\": [{\"label\": \"metric name (required)\", \"value\": \"value text (required)\", \"unit\": \"unit\", \"trendText\": \"+12% MoM\", \"trendTone\": \"good|bad|neutral\"}]}\n```\nLarge-number tiles for 1-6 key metrics (summary figures, KPIs); do not use for ordinary fields (that is kv_list).";
const SNIPPET_TABLE: &str = "```ui:table\n{\"title\": \"optional title\", \"columns\": [\"column name\"], \"rows\": [{\"cells\": [\"cell text\"], \"tone\": \"good|bad|muted\"}], \"emphasizeRowIndex\": 0}\n```\nTables with row-level semantic colors or a highlighted row (at most 50 rows); ordinary tables must use markdown table syntax, not this card.";
const SNIPPET_PROGRESS: &str = "```ui:progress\n{\"label\": \"progress name (required)\", \"value\": 62, \"valueText\": \"62% (about 3 days remaining)\", \"tone\": \"info|warning|danger|success\"}\n```\nSingle progress/percentage visualization; value is a number from 0 to 100.";

/// The `{{cards}}` prompt appendix. Chat sessions get the trimmed set
/// (no timeline/progress — process-state cards belong to task execution).
pub fn cards_prompt(chat: bool) -> String {
    let snippets: Vec<&str> = if chat {
        vec![SNIPPET_COMPARE, SNIPPET_KV, SNIPPET_NOTE, SNIPPET_SUGGESTIONS, SNIPPET_STAT, SNIPPET_TABLE]
    } else {
        vec![
            SNIPPET_COMPARE,
            SNIPPET_KV,
            SNIPPET_TIMELINE,
            SNIPPET_NOTE,
            SNIPPET_SUGGESTIONS,
            SNIPPET_STAT,
            SNIPPET_TABLE,
            SNIPPET_PROGRESS,
        ]
    };
    format!(
        "## Structured Cards\n\nYou may embed structured cards in the body of your answer: write a code block whose language tag is the card type (with the ui: prefix) and whose content is a JSON object. Cards render as UI components interleaved naturally with the text — you can write a paragraph, insert a card, then keep writing.\n\nOnly the following {} card types exist; any other ui:* tag is invalid:\n\n{}\n\nUsage rules:\n- For responses that fit in a sentence or two, short lists of 2 items or fewer, clarifying follow-ups, or plain narrative explanation, do not use cards — just write text.\n- Use markdown syntax for ordinary lists, ordinary tables, headings, and links; do not imitate them with cards.\n- Write the JSON indented across multiple lines, each array element on its own lines (rendering is streamed, so writing element by element lets the user see them appear one by one).\n- Keep any single string field within 500 characters; no emoji or internal numbering inside cards.",
        snippets.len(),
        snippets.join("\n\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_sets_differ() {
        let chat = cards_prompt(true);
        let main = cards_prompt(false);
        assert!(chat.contains("ui:compare") && chat.contains("ui:suggestions"));
        assert!(!chat.contains("ui:timeline") && !chat.contains("ui:progress"));
        assert!(main.contains("ui:timeline") && main.contains("ui:progress"));
        assert!(!chat.contains("ui:chart"), "chart is not rendered yet");
    }
}
