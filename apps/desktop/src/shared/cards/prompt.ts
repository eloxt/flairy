/**
 * System-prompt appendix documenting the card vocabulary. Injected by the main
 * process via the `{{cards}}` placeholder in the server-delivered prompt body
 * (agent-service `injectContext`, same mechanism as `{{memory}}`) — if the
 * admin's prompt has no placeholder, no cards prompt is injected.
 *
 * Field docs must stay in sync with schema.ts — changing the schema requires
 * updating the matching snippet here.
 *
 * Runtime-dependency-free on purpose (only a type import from schema.ts), so
 * the main process can import this module without pulling zod into its bundle.
 */

import type { CardLanguage } from "./schema";

/** Per-card vocabulary snippet: fence example + when-to-use guidance. */
const CARD_SNIPPETS: Record<CardLanguage, string> = {
  "ui:artifact": `\`\`\`ui:artifact
{"artifactId": "exact Artifact ID returned by write or present_file", "title": "optional title", "description": "what the file contains"}
\`\`\`
Present a generated file the user should open or save. Only use an exact artifactId supplied by a successful write or present_file tool result in this session. For outputs made by shell tools, call present_file first. Never invent IDs, paths, URLs, or action buttons. Files are local to the device that created them.`,
  "ui:compare": `\`\`\`ui:compare
{"title": "optional title", "rows": [{"name": "option name (required)", "pick": true, "pickReason": "why this option fits", "attrs": [{"label": "dimension name", "value": "value text", "tone": "good|bad"}], "note": "one-line note"}]}
\`\`\`
Side-by-side comparison of plans/options; use when contrasting 2 or more items. attrs are the compared dimensions (up to 8; keep the same dimensions in the same order across rows); tone applies a positive/negative accent to a dimension value; pick marks the recommended item (at most one); pickReason explains the recommendation. Use exactly the same dimension labels across options, not synonyms.`,

  "ui:kv_list": `\`\`\`ui:kv_list
{"title": "optional title", "items": [{"label": "field name (required)", "value": "value (required)", "hint": "secondary hint text", "emphasis": "good|bad"}]}
\`\`\`
Multi-field status display for a single entity (e.g. order/booking details); a few meaningful fields are enough; emphasis applies a positive/negative accent color to key values.`,

  "ui:timeline": `\`\`\`ui:timeline
{"title": "optional title", "steps": [{"label": "step name (required)", "status": "done|active|pending|failed|event", "time": "time text", "note": "note"}]}
\`\`\`
Process tracking / step progress. Use status="event" for dated events, itineraries, and historical timelines without task state. Never invent live execution status.`,

  "ui:note": `\`\`\`ui:note
{"tone": "info|warning|danger|success", "title": "optional title", "text": "notice body (required)"}
\`\`\`
Alerts/risks/compliance notices/success confirmations that need the user's attention; do not use for ordinary explanations.`,

  "ui:suggestions": `\`\`\`ui:suggestions
{"items": [{"label": "button text, within 30 characters (required)", "userText": "the full question actually sent on click; defaults to label"}]}
\`\`\`
Suggest what the user might ask next: 1-4 buttons placed at the end of the answer, at most one per response. Button semantics are "the user's next utterance" (a question/query) — clicking just sends that text as the user's next message; write them as questions the user would ask, not as commands to perform an action.`,

  "ui:stat": `\`\`\`ui:stat
{"title": "optional title", "items": [{"label": "metric name (required)", "value": "value text (required)", "unit": "unit", "description": "period or measurement scope", "trendText": "+12% MoM", "trendTone": "good|bad|neutral"}]}
\`\`\`
Large-number tiles for 1-6 key metrics (summary figures, KPIs); do not use for ordinary fields (that is kv_list).`,

  "ui:table": `\`\`\`ui:table
{"title": "optional title", "columns": ["column name"], "rows": [{"cells": ["cell text"], "tone": "good|bad|muted"}], "emphasizeRowIndex": 0}
\`\`\`
Tables with row-level semantic colors or a highlighted row (at most 50 rows); prefer markdown tables unless semantic row emphasis materially helps the user.`,

  "ui:progress": `\`\`\`ui:progress
{"label": "progress name (required)", "value": 62, "valueText": "62% (about 3 days remaining)", "tone": "info|warning|danger|success"}
\`\`\`
Single progress/percentage visualization; value is a number from 0 to 100. Use only a percentage supported by tool results or user-provided data. Never estimate agent execution progress or imply this static card tracks a running task.`,

  "ui:chart": `\`\`\`ui:chart
{"type": "bar|line", "title": "optional title", "caption": "measurement period and scope", "unit": "unit text", "points": [{"label": "x-axis label (required)", "value": 123}]}
\`\`\`
Single-series chart for a trend or distribution over 3-12 points (monthly totals, per-category counts); line for time trends, bar for category comparison. value is a plain number (no thousands separators or units inside — put the unit in unit). For metric snapshots use ui:stat; for precise multi-column data use a table.`,
};

/** Vocabulary for full agent sessions. */
export const MAIN_CARD_SET: readonly CardLanguage[] = [
  "ui:compare",
  "ui:artifact",
  "ui:kv_list",
  "ui:timeline",
  "ui:note",
  "ui:suggestions",
  "ui:stat",
  "ui:table",
  "ui:progress",
  "ui:chart",
];

/**
 * Trimmed vocabulary for lean `chat` sessions (ask + web tools only): drops
 * timeline/progress, whose process-state semantics come from task execution a
 * chat session doesn't do.
 */
export const CHAT_CARD_SET: readonly CardLanguage[] = [
  "ui:compare",
  "ui:kv_list",
  "ui:note",
  "ui:suggestions",
  "ui:stat",
  "ui:table",
  "ui:chart",
];

/** Assemble the cards prompt appendix for the given vocabulary. */
export function buildCardsPrompt(languages: readonly CardLanguage[]): string {
  const body = languages.map((l) => CARD_SNIPPETS[l]).join("\n\n");
  return `## Structured Cards

You may embed structured cards in the body of your answer: write a code block whose language tag is the card type (with the ui: prefix) and whose content is a JSON object. Cards render as UI components interleaved naturally with the text — you can write a paragraph, insert a card, then keep writing.

Only the following ${languages.length} card types exist; any other ui:* tag is invalid:

${body}

Usage rules:
- compare, kv_list, stat, table and chart optionally accept sourceRefs: [1, 2], referencing exact existing web tool citation IDs. Omit when no source is available; never invent IDs.
- Use only the documented enum values; omit optional enum fields when no value fits (unrecognized optional values are ignored by the renderer). Required enum fields must use a documented value.
- For responses that fit in a sentence or two, short lists of 2 items or fewer, clarifying follow-ups, or plain narrative explanation, do not use cards — just write text.
- Use markdown syntax for ordinary lists, ordinary tables, headings, and links; do not imitate them with cards.
- Write the JSON indented across multiple lines, each array element on its own lines (rendering is streamed, so writing element by element lets the user see them appear one by one).
- Aim for each string field to stay within 500 characters (the renderer tolerates up to 8000 for long content); no emoji or internal numbering inside cards.`;
}
