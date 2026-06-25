import { useState } from "react";
import { Lock, Pencil, Plus, Trash2 } from "lucide-react";
import type { ServiceConfig, ServiceInput, ServiceKind } from "@flairy/shared";
import { useConfig } from "@/hooks/useConfig";
import { createService, deleteService, updateService } from "@/api/client";
import { PageError, PageLoading } from "@/components/PageState";
import { PageHeader } from "@/components/PageHeader";
import { TablePanel, TableEmpty } from "@/components/TablePanel";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** The selectable service kinds, in display order. */
const KINDS: ServiceKind[] = ["exa"];

/** Local editor form. Empty `id` means a new (unsaved) service. */
interface ServiceForm {
  id: string;
  kind: ServiceKind;
  name: string;
  secret: string;
  enabled: boolean;
  /** Exa-specific: number of results to return. */
  numResults: string;
  /** Exa-specific: custom base URL. */
  baseUrl: string;
}

function toForm(s: ServiceConfig): ServiceForm {
  const settings = s.settings as { numResults?: number; baseUrl?: string };
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    secret: s.secret,
    enabled: s.enabled,
    numResults: settings.numResults != null ? String(settings.numResults) : "",
    baseUrl: settings.baseUrl ?? "",
  };
}

function emptyForm(): ServiceForm {
  return {
    id: "",
    kind: "exa",
    name: "",
    secret: "",
    enabled: true,
    numResults: "",
    baseUrl: "",
  };
}

function formToInput(form: ServiceForm): ServiceInput {
  const settings: Record<string, unknown> = {};
  if (form.kind === "exa") {
    const n = parseInt(form.numResults, 10);
    if (!isNaN(n) && form.numResults.trim() !== "") settings.numResults = n;
    if (form.baseUrl.trim() !== "") settings.baseUrl = form.baseUrl.trim();
  }
  return {
    kind: form.kind,
    name: form.name.trim(),
    secret: form.secret,
    enabled: form.enabled,
    settings,
  };
}

export function ServicesPage(): React.JSX.Element {
  const { config, loading, error, saving, mutate } = useConfig();
  const [editing, setEditing] = useState<ServiceForm | null>(null);

  if (loading) return <PageLoading />;
  if (error && !config) return <PageError message={error} />;
  if (!config) return <PageError message="No configuration available." />;

  const services = config.services;

  async function handleSubmit(): Promise<void> {
    if (!editing) return;
    const input = formToInput(editing);
    try {
      await mutate(() =>
        editing.id
          ? updateService(editing.id, input)
          : createService(input),
      );
      setEditing(null);
    } catch {
      // surfaced via hook error state
    }
  }

  async function handleToggle(
    s: ServiceConfig,
    enabled: boolean,
  ): Promise<void> {
    try {
      await mutate(() =>
        updateService(s.id, {
          kind: s.kind,
          name: s.name,
          secret: s.secret,
          enabled,
          settings: s.settings,
        }),
      );
    } catch {
      // surfaced via hook error state
    }
  }

  async function handleDelete(id: string): Promise<void> {
    try {
      await mutate(() => deleteService(id));
    } catch {
      // surfaced via hook error state
    }
  }

  return (
    <div>
      <PageHeader
        title="Services"
        description="External integrations with secret credentials (e.g. Exa web search)."
        action={
          <Button onClick={() => setEditing(emptyForm())}>
            <Plus className="size-4" />
            Add service
          </Button>
        }
      />
      {error && (
        <div className="mb-4">
          <PageError message={error} />
        </div>
      )}

      <TablePanel>
        {services.length === 0 ? (
          <TableEmpty>No services configured yet.</TableEmpty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-24">Kind</TableHead>
                <TableHead className="w-24">API Key</TableHead>
                <TableHead className="w-20">Enabled</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="capitalize">
                      {s.kind}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1 text-muted-foreground text-sm">
                      <Lock className="size-3" />
                      ••••
                    </span>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={s.enabled}
                      onCheckedChange={(v) => void handleToggle(s, v)}
                      disabled={saving}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditing(toForm(s))}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void handleDelete(s.id)}
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

      {editing && (
        <ServiceEditor
          form={editing}
          saving={saving}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  );
}

function ServiceEditor({
  form,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: ServiceForm;
  saving: boolean;
  onChange: (form: ServiceForm) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): React.JSX.Element {
  function patch(next: Partial<ServiceForm>): void {
    onChange({ ...form, ...next });
  }

  const valid = form.name.trim().length > 0 && form.secret.length > 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-auto sm:max-w-lg">
        <DialogHeader className="mb-4">
          <DialogTitle>
            {form.id ? `Edit ${form.name}` : "New service"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="svc-kind">Kind</Label>
            <Select
              value={form.kind}
              onValueChange={(v) => patch({ kind: v as ServiceKind })}
            >
              <SelectTrigger id="svc-kind" className="w-full capitalize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k} className="capitalize">
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="svc-name">Name</Label>
            <Input
              id="svc-name"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="svc-secret">API Key</Label>
            <Input
              id="svc-secret"
              type="password"
              autoComplete="off"
              value={form.secret}
              onChange={(e) => patch({ secret: e.target.value })}
            />
          </div>

          {form.kind === "exa" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="svc-num-results">
                  Number of results{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="svc-num-results"
                  type="number"
                  min={1}
                  value={form.numResults}
                  onChange={(e) => patch({ numResults: e.target.value })}
                  placeholder="e.g. 5"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="svc-base-url">
                  Base URL{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="svc-base-url"
                  value={form.baseUrl}
                  onChange={(e) => patch({ baseUrl: e.target.value })}
                  placeholder="https://api.exa.ai"
                />
              </div>
            </>
          )}

          <div className="flex items-center gap-2">
            <Switch
              id="svc-enabled"
              checked={form.enabled}
              onCheckedChange={(v) => patch({ enabled: v })}
            />
            <Label htmlFor="svc-enabled">Enabled</Label>
          </div>

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={onSubmit} disabled={!valid || saving}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
