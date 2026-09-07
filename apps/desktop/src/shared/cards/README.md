# Inline cards

Client-only UI protocol: the agent emits `ui:*` JSON fences. `schema.ts` defines
accepted data, `parse.ts` handles recovery, and `prompt.ts` documents generation.
Keep schema and prompt changes together; preserve existing card types for history.

## Recovery

- Unknown optional enum values and malformed optional text fall back to defaults.
- Independent list rows may be omitted with a visible partial-content notice.
- Chart points and timeline steps remain strict on completed valid JSON; removing
  them silently would change the meaning. Interrupted generation is explicitly marked.
- Arrays are capped at their schema limits. Strings are preserved up to 8000
  characters (the generation guideline remains 500); long prose can be expanded.
- Empty data and invalid blocks display plain-language feedback. Development
  diagnostics log only card types and validation paths/codes, never input content.
- Card animation is scoped to its own streaming message. History does not spin.

## Fields

- Compare: `pickReason`; use identical dimension labels across options.
- Stat: `description` for period/scope. Chart: `caption` for scope and context.
- Timeline: `status: "event"` for events without execution state.
- Compare/kv_list/stat/table/chart: optional `sourceRefs: number[]`, resolved only
  against the message's existing web-tool citation registry.
- Artifact: `{ artifactId, title?, description? }`. Successful `write` and
  `present_file` tools issue IDs; the latter handles files made by shell tools.
  Main resolves IDs against successful tool records in the owning session and
  rechecks real file paths against its cwd. Fences cannot supply paths/actions.
  Text files up to 1 MiB can be previewed. Other formats can be revealed in their
  folder or saved through a native dialog. Files are device-local; cards show an
  unavailable notice when the file or its record cannot be resolved.

## Verify

From the repository root:

```sh
pnpm --filter @flairy/desktop test:cards
pnpm typecheck
pnpm build
pnpm --filter @flairy/desktop dev:cards
```

The development-only gallery is at `http://127.0.0.1:5179/cards-preview.html`.
It exercises the actual Streamdown renderer with wide/narrow layouts, light/dark
colors, long Chinese prose, bad fields, empty/truncated data, charts and streaming
interruption. Suggestions and file operations are simulated there; no prompts
are sent and no real files are opened. The gallery is excluded from production
HTML build entries.
