/**
 * Inline card protocol schema — the model embeds structured UI inside its
 * markdown body as ```ui:<type> code fences whose body is a JSON object.
 * 10 card types; the vocabulary is deliberately small: plain lists / tables /
 * headings / links are expressed by markdown itself, cards only carry the
 * semantics markdown can't (comparison + recommendation, status emphasis,
 * process state machines, leveled alerts, quick follow-ups, big-number
 * metrics, semantically colored tables, progress, charts).
 *
 * One schema, three consumers: the renderer's props validation, the parse
 * layer's cleaning/validation, and the system-prompt vocabulary docs
 * (prompt.ts — kept in sync by hand; changing this file requires updating
 * prompt.ts too).
 */

import { z } from "zod";

/** Uniform cap for string fields; overlong input is truncated at the parse
 * layer (deepTruncate) rather than rejected by validation. */
export const MAX_FIELD_LEN = 8000;

const str = z.string().max(MAX_FIELD_LEN);
const optionalText = str.optional().catch(undefined);
const sourceRefs = z
  .array(z.number().int().positive())
  .max(12)
  .optional()
  .catch(undefined);

// Optional enum fields are presentation hints: discard invalid values so the
// card's content still renders. Required enums remain strict.

// ---------------------------------------------------------------------------
// ui:compare — side-by-side comparison of options (2+ items, arbitrary
// dimensions + a recommendation marker)
// ---------------------------------------------------------------------------

export const CompareAttrSchema = z.object({
  /** Dimension name, e.g. "cost" / "lead time" (keep consistent across rows) */
  label: str,
  value: str,
  /** Semantic accent for the value: good=positive (green) bad=negative (red) */
  tone: z.enum(["good", "bad"]).optional().catch(undefined),
});
export type CompareAttr = z.infer<typeof CompareAttrSchema>;

export const CompareRowSchema = z.object({
  /** Option name (the only required field) */
  name: str,
  /** Recommended item (at most one; the renderer doesn't enforce it) */
  pick: z.boolean().optional().catch(undefined),
  pickReason: optionalText,
  /** Compared dimensions */
  attrs: z.array(CompareAttrSchema).max(8).optional(),
  /** One-line note */
  note: optionalText,
});
export type CompareRow = z.infer<typeof CompareRowSchema>;

export const CompareBlockSchema = z.object({
  sourceRefs,
  title: optionalText,
  rows: z.array(CompareRowSchema).max(20),
});
export type CompareBlock = z.infer<typeof CompareBlockSchema>;

// ---------------------------------------------------------------------------
// ui:kv_list — key/value status display (many fields, with accent colors)
// ---------------------------------------------------------------------------

export const KvItemSchema = z.object({
  label: str,
  value: str,
  /** Secondary hint text */
  hint: optionalText,
  /** Accent: good=positive (green) bad=negative (red) */
  emphasis: z.enum(["good", "bad"]).optional().catch(undefined),
});
export type KvItem = z.infer<typeof KvItemSchema>;

export const KvListBlockSchema = z.object({
  sourceRefs,
  title: optionalText,
  items: z.array(KvItemSchema).max(30),
});
export type KvListBlock = z.infer<typeof KvListBlockSchema>;

// ---------------------------------------------------------------------------
// ui:timeline — process/progress tracking (step state machine)
// ---------------------------------------------------------------------------

export const TimelineStepSchema = z.object({
  label: str,
  status: z.enum(["done", "active", "pending", "failed", "event"]),
  /** Time text, e.g. "07-10 14:00" */
  time: optionalText,
  note: optionalText,
});
export type TimelineStep = z.infer<typeof TimelineStepSchema>;

export const TimelineBlockSchema = z.object({
  title: optionalText,
  steps: z.array(TimelineStepSchema).max(30),
});
export type TimelineBlock = z.infer<typeof TimelineBlockSchema>;

// ---------------------------------------------------------------------------
// ui:note — leveled notice (alert/risk/success)
// ---------------------------------------------------------------------------

export const NoteBlockSchema = z.object({
  tone: z.enum(["info", "warning", "danger", "success"]),
  title: optionalText,
  text: str,
});
export type NoteBlock = z.infer<typeof NoteBlockSchema>;

// ---------------------------------------------------------------------------
// ui:suggestions — quick follow-ups (a button IS the user's next utterance,
// nothing more)
//
// Clicking only sends the text as the user's next message; it never triggers
// an action directly (real actions each carry their own user confirmation).
// ---------------------------------------------------------------------------

export const SuggestionItemSchema = z.object({
  /** Button text, the user's next utterance from their perspective, ≤30 chars */
  label: z.string().min(1).max(30),
  /** Full question actually sent on click; falls back to label */
  userText: z.string().max(MAX_FIELD_LEN).optional(),
});
export type SuggestionItem = z.infer<typeof SuggestionItemSchema>;

export const SuggestionsBlockSchema = z.object({
  items: z.array(SuggestionItemSchema).min(1).max(4),
});
export type SuggestionsBlock = z.infer<typeof SuggestionsBlockSchema>;

// ---------------------------------------------------------------------------
// ui:stat — big-number metric tiles (1-6 side-by-side values)
// ---------------------------------------------------------------------------

export const StatItemSchema = z.object({
  label: str,
  value: str,
  /** Unit text, rendered smaller after the value */
  unit: optionalText,
  /** Trend text, e.g. "+12% MoM" */
  description: optionalText,
  trendText: optionalText,
  trendTone: z.enum(["good", "bad", "neutral"]).optional().catch(undefined),
});
export type StatItem = z.infer<typeof StatItemSchema>;

export const StatBlockSchema = z.object({
  sourceRefs,
  title: optionalText,
  items: z.array(StatItemSchema).min(1).max(6),
});
export type StatBlock = z.infer<typeof StatBlockSchema>;

// ---------------------------------------------------------------------------
// ui:table — table with row-level semantic colors / a highlighted row
//
// Plain tables always use markdown syntax; this card exists only for
// row-level good/bad coloring or row emphasis.
// ---------------------------------------------------------------------------

export const TableRowSchema = z.object({
  cells: z.array(str).max(12),
  /** Row-level semantic color */
  tone: z.enum(["good", "bad", "muted"]).optional().catch(undefined),
});
export type TableRow = z.infer<typeof TableRowSchema>;

export const TableBlockSchema = z.object({
  sourceRefs,
  title: optionalText,
  columns: z.array(str).min(1).max(12),
  rows: z.array(TableRowSchema).max(50),
  /** Highlighted row index (0-based) */
  emphasizeRowIndex: z.number().int().min(0).optional().catch(undefined),
});
export type TableBlock = z.infer<typeof TableBlockSchema>;

// ---------------------------------------------------------------------------
// ui:progress — progress/percentage visualization
// ---------------------------------------------------------------------------

export const ProgressBlockSchema = z.object({
  label: str,
  /** Progress value 0-100 */
  value: z.number().min(0).max(100),
  /** Text shown to the right; defaults to the percentage */
  valueText: optionalText,
  tone: z
    .enum(["info", "warning", "danger", "success"])
    .optional()
    .catch(undefined),
});
export type ProgressBlock = z.infer<typeof ProgressBlockSchema>;

// ---------------------------------------------------------------------------
// ui:chart — single-series bar/line chart (trend or distribution, ≤12 points)
// ---------------------------------------------------------------------------

export const ChartPointSchema = z.object({
  /** X-axis tick text, e.g. "Mar" / "East region" */
  label: str,
  /** Plain number (the renderer handles display formatting) */
  value: z.number().finite(),
});
export type ChartPoint = z.infer<typeof ChartPointSchema>;

export const ChartBlockSchema = z.object({
  sourceRefs,
  /** bar=category comparison line=time trend */
  type: z.enum(["bar", "line"]),
  title: optionalText,
  caption: optionalText,
  /** Unit text annotated on the value axis, e.g. "USD" */
  unit: optionalText,
  points: z.array(ChartPointSchema).max(12),
});
export type ChartBlock = z.infer<typeof ChartBlockSchema>;

// Artifact IDs refer to successful write/present_file calls, never model-supplied paths.
export const ArtifactBlockSchema = z.object({
  artifactId: z.string().min(1).max(200),
  title: optionalText,
  description: optionalText,
});
export type ArtifactBlock = z.infer<typeof ArtifactBlockSchema>;

// ---------------------------------------------------------------------------
// Type registry
// ---------------------------------------------------------------------------

/**
 * When a `streaming` config is present the card supports progressive
 * streaming render: while the fence is still open, the array at `key` is
 * filtered to its "valid prefix" (each element run through the item schema,
 * stopping at the first invalid one — usually the half-streamed tail).
 * The remaining cards (note/suggestions) are atomic: not rendered until the
 * fence closes.
 */
export const CARD_DEFS = {
  "ui:compare": {
    schema: CompareBlockSchema,
    streaming: { key: "rows", item: CompareRowSchema },
  },
  "ui:kv_list": {
    schema: KvListBlockSchema,
    streaming: { key: "items", item: KvItemSchema },
  },
  "ui:timeline": {
    schema: TimelineBlockSchema,
    streaming: { key: "steps", item: TimelineStepSchema },
  },
  "ui:note": { schema: NoteBlockSchema },
  "ui:suggestions": { schema: SuggestionsBlockSchema },
  "ui:stat": {
    schema: StatBlockSchema,
    streaming: { key: "items", item: StatItemSchema },
  },
  "ui:table": {
    schema: TableBlockSchema,
    streaming: { key: "rows", item: TableRowSchema },
  },
  "ui:progress": { schema: ProgressBlockSchema },
  "ui:artifact": { schema: ArtifactBlockSchema },
  "ui:chart": {
    schema: ChartBlockSchema,
    streaming: { key: "points", item: ChartPointSchema },
  },
} as const;

export type CardLanguage = keyof typeof CARD_DEFS;

export const CARD_LANGUAGES = Object.keys(CARD_DEFS) as CardLanguage[];

/** Discriminated union of parse results; the renderer dispatches on `type`. */
export type CardBlock = (
  | { type: "ui:compare"; data: CompareBlock }
  | { type: "ui:kv_list"; data: KvListBlock }
  | { type: "ui:timeline"; data: TimelineBlock }
  | { type: "ui:note"; data: NoteBlock }
  | { type: "ui:suggestions"; data: SuggestionsBlock }
  | { type: "ui:stat"; data: StatBlock }
  | { type: "ui:table"; data: TableBlock }
  | { type: "ui:progress"; data: ProgressBlock }
  | { type: "ui:chart"; data: ChartBlock }
  | { type: "ui:artifact"; data: ArtifactBlock }
) & { notices?: ("partial" | "truncated" | "recovered")[] };
