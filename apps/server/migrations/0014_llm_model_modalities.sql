-- Per-model input modalities delivered to clients: what the model can be SENT
-- (text, images). The agent loop forwards it to pi as `Model.input`, which gates
-- whether attachments reach the provider or are replaced with an "(image omitted…)"
-- placeholder. Mirrors pi's text-generation `Model`, which carries only `input`
-- (output modality exists solely on pi's image-generation models, out of scope
-- here). Mirrors `LlmModelConfig` in `apps/server/src/models/llm.rs` and
-- `packages/shared/src/config.ts`.
--
-- A non-empty TEXT[] over {text, image}, defaulting to {text} so existing rows
-- stay valid (text-only) until an admin marks a model image-capable.
ALTER TABLE llm_models
    ADD COLUMN input_modalities TEXT[] NOT NULL DEFAULT '{text}';

ALTER TABLE llm_models
    ADD CONSTRAINT llm_model_input_modalities_check
    CHECK (cardinality(input_modalities) >= 1
           AND input_modalities <@ ARRAY['text', 'image']::text[]);
