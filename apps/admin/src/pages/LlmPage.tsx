import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type {
  LlmModelConfig,
  LlmModelInput,
  LlmProvider,
  LlmProviderConfig,
  LlmProviderInput,
  LlmRole,
  ThinkingLevel,
} from "@flairy/shared";
import { useConfig } from "@/hooks/useConfig";
import {
  assignLlmRole,
  clearLlmRole,
  createLlmModel,
  createLlmProvider,
  deleteLlmModel,
  deleteLlmProvider,
  updateLlmModel,
  updateLlmProvider,
} from "@/api/client";
import { PageError, PageLoading } from "@/components/PageState";
import { PageHeader } from "@/components/PageHeader";
import { TablePanel, TableEmpty } from "@/components/TablePanel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PROVIDERS: LlmProvider[] = ["anthropic", "openai", "google"];

/** Reasoning-effort options offered per model, in ascending order. */
const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/**
 * Sentinel Select value for "no explicit level" (the form models this as an empty
 * string). Radix Select forbids an empty-string item value, so we round-trip
 * through this token and map it back to `undefined` on save.
 */
const THINKING_DEFAULT = "__default__";

const ROLES: {
  role: LlmRole;
  label: string;
  description: string;
  clearable: boolean;
}[] = [
  {
    role: "main",
    label: "Main model",
    description:
      "Drives the agent loop. Required — clients cannot run without it.",
    clearable: false,
  },
  {
    role: "tool",
    label: "Tool model",
    description: "Auxiliary / cheaper model for tool-related work. Optional.",
    clearable: true,
  },
];

// ---------------------------------------------------------------------------
// Provider form
// ---------------------------------------------------------------------------

interface ProviderForm {
  /** Empty for a new (unsaved) provider. */
  id: string;
  name: string;
  provider: LlmProvider;
  credential: string;
  baseUrl: string;
}

function providerToForm(p: LlmProviderConfig): ProviderForm {
  return {
    id: p.id,
    name: p.name,
    provider: p.provider,
    credential: p.credential,
    baseUrl: p.baseUrl ?? "",
  };
}

function emptyProviderForm(): ProviderForm {
  return {
    id: "",
    name: "",
    provider: "anthropic",
    credential: "",
    baseUrl: "",
  };
}

function providerFormToInput(form: ProviderForm): LlmProviderInput {
  return {
    name: form.name.trim(),
    provider: form.provider,
    credential: form.credential,
    ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
  };
}

// ---------------------------------------------------------------------------
// Model form
// ---------------------------------------------------------------------------

interface ModelForm {
  /** Empty for a new (unsaved) model. */
  id: string;
  providerId: string;
  name: string;
  model: string;
  /** Empty string = no explicit level (provider/client default). */
  thinkingLevel: ThinkingLevel | "";
}

function modelToForm(m: LlmModelConfig): ModelForm {
  return {
    id: m.id,
    providerId: m.providerId,
    name: m.name,
    model: m.model,
    thinkingLevel: m.thinkingLevel ?? "",
  };
}

function emptyModelForm(defaultProviderId: string): ModelForm {
  return {
    id: "",
    providerId: defaultProviderId,
    name: "",
    model: "",
    thinkingLevel: "",
  };
}

function modelFormToInput(form: ModelForm): LlmModelInput {
  return {
    providerId: form.providerId,
    name: form.name.trim(),
    model: form.model.trim(),
    ...(form.thinkingLevel ? { thinkingLevel: form.thinkingLevel } : {}),
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function LlmPage(): React.JSX.Element {
  const { config, loading, error, saving, mutate } = useConfig();
  const [editingProvider, setEditingProvider] = useState<ProviderForm | null>(
    null,
  );
  const [editingModel, setEditingModel] = useState<ModelForm | null>(null);

  if (loading) return <PageLoading />;
  if (error && !config) return <PageError message={error} />;
  if (!config) return <PageError message="No configuration available." />;

  const providers = config.llmProviders;
  const models = config.llmModels;
  const providerName = (id: string): string =>
    providers.find((p) => p.id === id)?.name ?? "—";
  const assignedModelId = (role: LlmRole): string | null =>
    config.llmRoleAssignments.find((a) => a.role === role)?.modelId ?? null;

  async function run(
    fn: () => Promise<unknown>,
    done: () => void,
  ): Promise<void> {
    try {
      await mutate(fn);
      done();
    } catch {
      // surfaced via hook error state
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="LLM"
        description="Provider connections hold the credential; models reference a provider. Each role (main / tool) is assigned a model, and those assignments are delivered to every client."
      />
      {error && <PageError message={error} />}

      {/* Providers ---------------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Providers</h2>
          <Button
            size="sm"
            onClick={() => setEditingProvider(emptyProviderForm())}
          >
            <Plus className="size-4" />
            Add provider
          </Button>
        </div>
        <TablePanel>
          {providers.length === 0 ? (
            <TableEmpty>
              No providers configured yet. Add one before creating models.
            </TableEmpty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Base URL</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">
                      {p.name || "—"}
                    </TableCell>
                    <TableCell className="capitalize text-muted-foreground">
                      {p.provider}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.baseUrl || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditingProvider(providerToForm(p))}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            void run(
                              () => deleteLlmProvider(p.id),
                              () => {},
                            )
                          }
                          disabled={saving}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TablePanel>
      </section>

      {/* Models ------------------------------------------------------------- */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Models</h2>
          <Button
            size="sm"
            disabled={providers.length === 0}
            onClick={() =>
              setEditingModel(emptyModelForm(providers[0]?.id ?? ""))
            }
          >
            <Plus className="size-4" />
            Add model
          </Button>
        </div>
        <TablePanel>
          {models.length === 0 ? (
            <TableEmpty>No models configured yet.</TableEmpty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Reasoning</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">
                      {m.name || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {providerName(m.providerId)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {m.model}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {m.thinkingLevel ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditingModel(modelToForm(m))}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            void run(
                              () => deleteLlmModel(m.id),
                              () => {},
                            )
                          }
                          disabled={saving}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TablePanel>
      </section>

      {/* Roles -------------------------------------------------------------- */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Roles</h2>
          <p className="text-xs text-muted-foreground">
            Which model each scenario uses. These assignments are delivered to
            every client.
          </p>
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {models.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              Add a model before assigning roles.
            </p>
          ) : (
            ROLES.map(({ role, label, description, clearable }) => {
              const assigned = assignedModelId(role);
              return (
                <div
                  key={role}
                  className="flex items-start justify-between gap-4 px-4 py-4"
                >
                  <div className="space-y-0.5">
                    <div className="text-sm font-medium">{label}</div>
                    <p className="text-xs text-muted-foreground">
                      {description}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {clearable && assigned && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void run(
                            () => clearLlmRole(role),
                            () => {},
                          )
                        }
                        disabled={saving}
                      >
                        Clear
                      </Button>
                    )}
                    <Select
                      value={assigned ?? undefined}
                      onValueChange={(v) => {
                        if (v)
                          void run(
                            () => assignLlmRole(role, v),
                            () => {},
                          );
                      }}
                      disabled={saving}
                    >
                      <SelectTrigger className="w-64">
                        <SelectValue placeholder="Not set">
                          {(value) => {
                            const m = models.find((m) => m.id === value);
                            return m ? `${m.name} (${m.model})` : "Not set";
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {models.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.name} ({m.model})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {editingProvider && (
        <ProviderEditor
          form={editingProvider}
          saving={saving}
          onChange={setEditingProvider}
          onCancel={() => setEditingProvider(null)}
          onSubmit={() =>
            void run(
              () =>
                editingProvider.id
                  ? updateLlmProvider(
                      editingProvider.id,
                      providerFormToInput(editingProvider),
                    )
                  : createLlmProvider(providerFormToInput(editingProvider)),
              () => setEditingProvider(null),
            )
          }
        />
      )}

      {editingModel && (
        <ModelEditor
          form={editingModel}
          providers={providers}
          saving={saving}
          onChange={setEditingModel}
          onCancel={() => setEditingModel(null)}
          onSubmit={() =>
            void run(
              () =>
                editingModel.id
                  ? updateLlmModel(
                      editingModel.id,
                      modelFormToInput(editingModel),
                    )
                  : createLlmModel(modelFormToInput(editingModel)),
              () => setEditingModel(null),
            )
          }
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

function ProviderEditor({
  form,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: ProviderForm;
  saving: boolean;
  onChange: (form: ProviderForm) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): React.JSX.Element {
  function patch(next: Partial<ProviderForm>): void {
    onChange({ ...form, ...next });
  }

  const valid = form.name.trim().length > 0;

  return (
    <Modal
      title={form.id ? `Edit ${form.name}` : "New provider"}
      onClose={onCancel}
    >
      <div className="space-y-2">
        <Label htmlFor="provider-name">Name</Label>
        <Input
          id="provider-name"
          placeholder="Production Anthropic"
          value={form.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="provider-vendor">Vendor</Label>
        <Select
          value={form.provider}
          onValueChange={(v) => patch({ provider: v as LlmProvider })}
        >
          <SelectTrigger id="provider-vendor">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="credential">Credential</Label>
        <Input
          id="credential"
          type="password"
          autoComplete="off"
          placeholder="sk-…"
          value={form.credential}
          onChange={(e) => patch({ credential: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          Shared by every model under this provider and delivered to every
          client. Prefer a scoped / short-lived token over a long-lived master
          key.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="baseUrl">Base URL (optional)</Label>
        <Input
          id="baseUrl"
          placeholder="https://gateway.example.com/v1"
          value={form.baseUrl}
          onChange={(e) => patch({ baseUrl: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          Gateway / proxy override.
        </p>
      </div>

      <EditorActions
        saving={saving}
        valid={valid}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    </Modal>
  );
}

function ModelEditor({
  form,
  providers,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: ModelForm;
  providers: LlmProviderConfig[];
  saving: boolean;
  onChange: (form: ModelForm) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): React.JSX.Element {
  function patch(next: Partial<ModelForm>): void {
    onChange({ ...form, ...next });
  }

  const valid =
    form.name.trim().length > 0 &&
    form.model.trim().length > 0 &&
    form.providerId.length > 0;

  return (
    <Modal
      title={form.id ? `Edit ${form.name}` : "New model"}
      onClose={onCancel}
    >
      <div className="space-y-2">
        <Label htmlFor="model-provider">Provider</Label>
        <Select
          value={form.providerId}
          onValueChange={(v) => patch({ providerId: v ?? "" })}
        >
          <SelectTrigger id="model-provider">
            <SelectValue placeholder="Select a provider">
              {(value) => {
                const p = providers.find((p) => p.id === value);
                return p ? `${p.name} (${p.provider})` : "Select a provider";
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} ({p.provider})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="model-name">Name</Label>
        <Input
          id="model-name"
          placeholder="Sonnet (fast)"
          value={form.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="model-id">Model</Label>
        <Input
          id="model-id"
          placeholder="claude-sonnet-4-20250514"
          value={form.model}
          onChange={(e) => patch({ model: e.target.value })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="model-thinking">Reasoning effort</Label>
        <Select
          value={form.thinkingLevel || THINKING_DEFAULT}
          onValueChange={(v) =>
            patch({
              thinkingLevel: v === THINKING_DEFAULT ? "" : (v as ThinkingLevel),
            })
          }
        >
          <SelectTrigger id="model-thinking">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={THINKING_DEFAULT}>Provider default</SelectItem>
            {THINKING_LEVELS.map((l) => (
              <SelectItem key={l} value={l}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          How hard the model thinks before answering. Delivered to every client
          and applied to the agent loop. “Provider default” forces no level.
          “xhigh” is honored only by select models.
        </p>
      </div>

      <EditorActions
        saving={saving}
        valid={valid}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-auto sm:max-w-lg">
        <DialogHeader className="mb-4">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

function EditorActions({
  saving,
  valid,
  onCancel,
  onSubmit,
}: {
  saving: boolean;
  valid: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}): React.JSX.Element {
  return (
    <div className="flex justify-end gap-2 border-t border-border pt-4">
      <Button variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <Button onClick={onSubmit} disabled={!valid || saving}>
        Save
      </Button>
    </div>
  );
}
