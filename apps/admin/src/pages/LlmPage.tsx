import { useMemo, useState } from "react";
import { Loader2, Pencil, Plus, Search, Trash2, Users } from "lucide-react";
import type {
  LlmModelConfig,
  LlmModelInput,
  LlmProviderConfig,
  LlmProviderInput,
  LlmRole,
  LlmUserRoleAssignment,
  Modality,
  ProviderApi,
  ThinkingLevel,
  UserSummary,
} from "@flairy/shared";
import { useConfig } from "@/hooks/useConfig";
import { useUsers } from "@/hooks/useUsers";
import {
  assignLlmRole,
  assignLlmUserRole,
  clearLlmRole,
  clearLlmUserRole,
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
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

/** Provider API protocols offered when creating a provider connection. */
const PROVIDER_APIS: ProviderApi[] = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "google-generative-ai",
];

/** Reasoning-effort options offered per model, in ascending order. */
const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/** Input modalities offered per model. pi gates image attachments on this set. */
const MODALITIES: { value: Modality; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "image", label: "Image" },
];

/**
 * Sentinel Select value for "no explicit level" (the form models this as an empty
 * string). Radix Select forbids an empty-string item value, so we round-trip
 * through this token and map it back to `undefined` on save.
 */
const THINKING_DEFAULT = "__default__";

/** Sentinel Select value for "no override — the user gets the global model". */
const OVERRIDE_DEFAULT = "__global__";

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
  {
    role: "visual",
    label: "Visual model",
    description:
      "Auxiliary vision model. When the main model does not accept images, it extracts text from image attachments before the main model runs. Optional.",
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
  api: ProviderApi;
  credential: string;
  baseUrl: string;
}

function providerToForm(p: LlmProviderConfig): ProviderForm {
  return {
    id: p.id,
    name: p.name,
    api: p.api,
    credential: p.credential,
    baseUrl: p.baseUrl ?? "",
  };
}

function emptyProviderForm(): ProviderForm {
  return {
    id: "",
    name: "",
    api: "anthropic-messages",
    credential: "",
    baseUrl: "",
  };
}

function providerFormToInput(form: ProviderForm): LlmProviderInput {
  return {
    name: form.name.trim(),
    api: form.api,
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
  /** Input modalities the model accepts; always non-empty (at least "text"). */
  input: Modality[];
  /** Empty string = no explicit level (provider/client default). */
  thinkingLevel: ThinkingLevel | "";
  // Runtime params are kept as raw strings so the inputs can be cleared; empty
  // means "omit" and the client falls back to pi-ai's registry / its defaults.
  contextWindow: string;
  maxTokens: string;
  costInput: string;
  costOutput: string;
  costCacheRead: string;
  costCacheWrite: string;
}

/** Number → input string, with `undefined` becoming "". */
function numStr(n: number | undefined): string {
  return n == null ? "" : String(n);
}

/** Per-1M-token price → input string (`undefined` → ""). */
function costToForm(perMillion: number | undefined): string {
  if (perMillion == null) return "";
  return String(perMillion);
}

function modelToForm(m: LlmModelConfig): ModelForm {
  return {
    id: m.id,
    providerId: m.providerId,
    name: m.name,
    model: m.model,
    input: m.input?.length ? m.input : ["text"],
    thinkingLevel: m.thinkingLevel ?? "",
    contextWindow: numStr(m.contextWindow),
    maxTokens: numStr(m.maxTokens),
    costInput: costToForm(m.cost?.input),
    costOutput: costToForm(m.cost?.output),
    costCacheRead: costToForm(m.cost?.cacheRead),
    costCacheWrite: costToForm(m.cost?.cacheWrite),
  };
}

function emptyModelForm(defaultProviderId: string): ModelForm {
  return {
    id: "",
    providerId: defaultProviderId,
    name: "",
    model: "",
    // New models default to text+image: most current models are vision-capable,
    // and an admin can untick Image for a text-only model.
    input: ["text", "image"],
    thinkingLevel: "",
    contextWindow: "",
    maxTokens: "",
    costInput: "",
    costOutput: "",
    costCacheRead: "",
    costCacheWrite: "",
  };
}

/** Parse a numeric form field; blank or non-finite → `undefined` (omit). */
function parseNum(raw: string): number | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function modelFormToInput(form: ModelForm): LlmModelInput {
  // A cost is sent only when at least one component is given; missing
  // components default to 0 so the object stays well-formed.
  const costParts = [
    form.costInput,
    form.costOutput,
    form.costCacheRead,
    form.costCacheWrite,
  ].map(parseNum);
  // Prices are stored as USD per 1M tokens, the same unit admins type and the
  // unit pi-ai's cost calc expects — no conversion in or out.
  const cost = costParts.some((n) => n !== undefined)
    ? {
        input: costParts[0] ?? 0,
        output: costParts[1] ?? 0,
        cacheRead: costParts[2] ?? 0,
        cacheWrite: costParts[3] ?? 0,
      }
    : undefined;

  const contextWindow = parseNum(form.contextWindow);
  const maxTokens = parseNum(form.maxTokens);

  return {
    providerId: form.providerId,
    name: form.name.trim(),
    model: form.model.trim(),
    // Guard the contract's non-empty invariant even if the UI somehow cleared it.
    input: form.input.length ? form.input : ["text"],
    ...(form.thinkingLevel ? { thinkingLevel: form.thinkingLevel } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(cost ? { cost } : {}),
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function LlmPage(): React.JSX.Element {
  const { config, loading, error, saving, mutate } = useConfig();
  const {
    users,
    loading: usersLoading,
    error: usersError,
  } = useUsers();
  const [editingProvider, setEditingProvider] = useState<ProviderForm | null>(
    null,
  );
  const [editingModel, setEditingModel] = useState<ModelForm | null>(null);
  const [overridesRole, setOverridesRole] = useState<LlmRole | null>(null);

  if (loading) return <PageLoading />;
  if (error && !config) return <PageError message={error} />;
  if (!config) return <PageError message="No configuration available." />;

  const providers = config.llmProviders;
  const models = config.llmModels;
  const providerName = (id: string): string =>
    providers.find((p) => p.id === id)?.name ?? "—";
  const assignedModelId = (role: LlmRole): string | null =>
    config.llmRoleAssignments.find((a) => a.role === role)?.modelId ?? null;
  const overridesFor = (role: LlmRole): LlmUserRoleAssignment[] =>
    config.llmUserRoleAssignments.filter((a) => a.role === role);

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
                  <TableHead>API</TableHead>
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
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {p.api}
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
                  <TableHead>Input</TableHead>
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
                      {(m.input?.length ? m.input : ["text"]).join(", ")}
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
            Which model each scenario uses. The selected model is the default
            for every user; per-user overrides replace it for specific users.
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
              const overrideCount = overridesFor(role).length;
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
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOverridesRole(role)}
                      disabled={saving}
                    >
                      <Users className="size-4" />
                      {overrideCount > 0
                        ? `${overrideCount} override${overrideCount === 1 ? "" : "s"}`
                        : "Overrides"}
                    </Button>
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

      {overridesRole && (
        <RoleOverridesDialog
          roleLabel={
            ROLES.find((r) => r.role === overridesRole)?.label ?? overridesRole
          }
          models={models}
          users={users}
          usersLoading={usersLoading}
          usersError={usersError}
          overrides={overridesFor(overridesRole)}
          defaultModelId={assignedModelId(overridesRole)}
          saving={saving}
          onAssign={(userId, modelId) =>
            void run(
              () => assignLlmUserRole(overridesRole, userId, modelId),
              () => {},
            )
          }
          onClear={(userId) =>
            void run(
              () => clearLlmUserRole(overridesRole, userId),
              () => {},
            )
          }
          onClose={() => setOverridesRole(null)}
        />
      )}

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
// Per-user role overrides
// ---------------------------------------------------------------------------

/**
 * Override one role's model for specific users. Every user is listed with a
 * model select; "Default" means no override (the user gets the global model).
 * Changes apply immediately, matching the role selects on the page.
 */
function RoleOverridesDialog({
  roleLabel,
  models,
  users,
  usersLoading,
  usersError,
  overrides,
  defaultModelId,
  saving,
  onAssign,
  onClear,
  onClose,
}: {
  roleLabel: string;
  models: LlmModelConfig[];
  users: UserSummary[] | null;
  usersLoading: boolean;
  usersError: string | null;
  overrides: LlmUserRoleAssignment[];
  defaultModelId: string | null;
  saving: boolean;
  onAssign: (userId: string, modelId: string) => void;
  onClear: (userId: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [search, setSearch] = useState("");

  const overrideByUser = useMemo(
    () => new Map(overrides.map((o) => [o.userId, o.modelId])),
    [overrides],
  );

  const filtered = useMemo(() => {
    const list = users ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q),
    );
  }, [users, search]);

  const defaultModel = models.find((m) => m.id === defaultModelId);
  const defaultLabel = defaultModel
    ? `Default — ${defaultModel.name}`
    : "Default — not set";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 sm:max-w-lg">
        <DialogHeader className="mb-4 shrink-0">
          <DialogTitle>{roleLabel} — per-user overrides</DialogTitle>
          <DialogDescription>
            Pick a different model for specific users. Users on “Default” get
            the model selected for this role.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="relative shrink-0">
            <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              aria-label="Search users"
              placeholder="Search users..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
            {usersLoading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : usersError ? (
              <div className="text-destructive py-8 text-center text-sm">
                {usersError}
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-muted-foreground py-8 text-center text-sm">
                {search ? "No users match your search." : "No users yet."}
              </div>
            ) : (
              <ScrollArea className="h-full">
                <ul className="divide-y divide-border">
                  {filtered.map((u) => {
                    const overrideModelId = overrideByUser.get(u.id);
                    return (
                      <li
                        key={u.id}
                        className="flex items-center gap-3 px-3 py-2"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {u.displayName}
                          </span>
                          <span className="text-muted-foreground block truncate text-xs">
                            {u.email}
                          </span>
                        </span>
                        <Select
                          value={overrideModelId ?? OVERRIDE_DEFAULT}
                          onValueChange={(v) => {
                            if (!v || v === (overrideModelId ?? OVERRIDE_DEFAULT))
                              return;
                            if (v === OVERRIDE_DEFAULT) onClear(u.id);
                            else onAssign(u.id, v);
                          }}
                          disabled={saving}
                        >
                          <SelectTrigger className="w-52 shrink-0">
                            <SelectValue>
                              {(value) => {
                                if (value === OVERRIDE_DEFAULT)
                                  return defaultLabel;
                                const m = models.find((m) => m.id === value);
                                return m ? m.name : "Unknown model";
                              }}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={OVERRIDE_DEFAULT}>
                              {defaultLabel}
                            </SelectItem>
                            {models.map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.name} ({m.model})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </li>
                    );
                  })}
                </ul>
              </ScrollArea>
            )}
          </div>

          <p className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
            <Users className="size-3" />
            {overrides.length} override{overrides.length === 1 ? "" : "s"}
          </p>
        </div>

        <div className="mt-4 flex shrink-0 justify-end gap-2 border-t border-border pt-4">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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

  const valid = form.name.trim().length > 0 && form.baseUrl.trim().length > 0;

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
        <Label htmlFor="provider-api">API</Label>
        <Select
          value={form.api}
          onValueChange={(v) => patch({ api: v as ProviderApi })}
        >
          <SelectTrigger id="provider-api">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_APIS.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          The HTTP API protocol the client uses to reach this provider. Pick{" "}
          <code>openai-completions</code> for custom or third-party
          OpenAI-compatible endpoints.
        </p>
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
        <Label htmlFor="baseUrl">Base URL</Label>
        <Input
          id="baseUrl"
          placeholder="https://api.anthropic.com"
          value={form.baseUrl}
          onChange={(e) => patch({ baseUrl: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          The endpoint the client calls — the official vendor URL or a gateway /
          proxy. Required: the client has no built-in default.
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
                return p ? `${p.name} (${p.api})` : "Select a provider";
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} ({p.api})
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
        <Label>Input modalities</Label>
        <div className="flex gap-2">
          {MODALITIES.map((mod) => {
            const active = form.input.includes(mod.value);
            return (
              <Button
                key={mod.value}
                type="button"
                variant={active ? "default" : "outline"}
                size="sm"
                // Never let the user clear the last modality — pi requires a
                // non-empty input set.
                disabled={active && form.input.length === 1}
                onClick={() =>
                  patch({
                    input: active
                      ? form.input.filter((x) => x !== mod.value)
                      : [...form.input, mod.value],
                  })
                }
              >
                {mod.label}
              </Button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          What the model can be sent. “Image” must be on for it to receive
          attached pictures; otherwise the client strips them before the request.
        </p>
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

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="model-context">Context window</Label>
          <Input
            id="model-context"
            inputMode="numeric"
            placeholder="200000"
            value={form.contextWindow}
            onChange={(e) => patch({ contextWindow: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="model-max-tokens">Max output tokens</Label>
          <Input
            id="model-max-tokens"
            inputMode="numeric"
            placeholder="8192"
            value={form.maxTokens}
            onChange={(e) => patch({ maxTokens: e.target.value })}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Price (USD per 1M tokens, optional)</Label>
        <div className="grid grid-cols-2 gap-3">
          <Input
            aria-label="Input price"
            inputMode="decimal"
            placeholder="input"
            value={form.costInput}
            onChange={(e) => patch({ costInput: e.target.value })}
          />
          <Input
            aria-label="Output price"
            inputMode="decimal"
            placeholder="output"
            value={form.costOutput}
            onChange={(e) => patch({ costOutput: e.target.value })}
          />
          <Input
            aria-label="Cache read price"
            inputMode="decimal"
            placeholder="cache read"
            value={form.costCacheRead}
            onChange={(e) => patch({ costCacheRead: e.target.value })}
          />
          <Input
            aria-label="Cache write price"
            inputMode="decimal"
            placeholder="cache write"
            value={form.costCacheWrite}
            onChange={(e) => patch({ costCacheWrite: e.target.value })}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Used only to estimate usage cost on the client. Left blank for models
          pi-ai already knows; set it for custom models. Defaults to zero.
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
