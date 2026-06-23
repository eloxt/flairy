import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { SystemPromptConfig, SystemPromptInput } from "@flairy/shared";
import { useConfig } from "@/hooks/useConfig";
import {
  createSystemPrompt,
  deleteSystemPrompt,
  updateSystemPrompt,
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

/** Local editor form. Empty `id` means a new (unsaved) prompt. */
interface PromptForm {
  id: string;
  name: string;
  body: string;
  enabled: boolean;
}

function toForm(prompt: SystemPromptConfig): PromptForm {
  return {
    id: prompt.id,
    name: prompt.name,
    body: prompt.body,
    enabled: prompt.enabled,
  };
}

function emptyForm(): PromptForm {
  return { id: "", name: "", body: "", enabled: true };
}

function formToInput(form: PromptForm): SystemPromptInput {
  return {
    name: form.name.trim(),
    body: form.body,
    enabled: form.enabled,
  };
}

/** Project a stored prompt back to an input payload (for enable/disable toggles). */
function promptToInput(
  prompt: SystemPromptConfig,
  enabled: boolean,
): SystemPromptInput {
  return { name: prompt.name, body: prompt.body, enabled };
}

export function SystemPromptsPage(): React.JSX.Element {
  const { config, loading, error, saving, mutate } = useConfig();
  const [editing, setEditing] = useState<PromptForm | null>(null);

  if (loading) return <PageLoading />;
  if (error && !config) return <PageError message={error} />;
  if (!config) return <PageError message="No configuration available." />;

  const prompts = config.systemPrompts;

  async function handleSubmit(): Promise<void> {
    if (!editing) return;
    const input = formToInput(editing);
    try {
      await mutate(() =>
        editing.id
          ? updateSystemPrompt(editing.id, input)
          : createSystemPrompt(input),
      );
      setEditing(null);
    } catch {
      // surfaced via hook error state
    }
  }

  async function handleToggle(
    prompt: SystemPromptConfig,
    enabled: boolean,
  ): Promise<void> {
    try {
      await mutate(() =>
        updateSystemPrompt(prompt.id, promptToInput(prompt, enabled)),
      );
    } catch {
      // surfaced via hook error state
    }
  }

  async function handleDelete(id: string): Promise<void> {
    try {
      await mutate(() => deleteSystemPrompt(id));
    } catch {
      // surfaced via hook error state
    }
  }

  return (
    <div>
      <PageHeader
        title="System Prompts"
        description="Base prompts pushed to every client."
        action={
          <Button onClick={() => setEditing(emptyForm())}>
            <Plus className="size-4" />
            Add prompt
          </Button>
        }
      />
      {error && (
        <div className="mb-4">
          <PageError message={error} />
        </div>
      )}

      <TablePanel>
        {prompts.length === 0 ? (
          <TableEmpty>No system prompts configured yet.</TableEmpty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-20">Enabled</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prompts.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell>
                    <Switch
                      checked={p.enabled}
                      onCheckedChange={(v) => void handleToggle(p, v)}
                      disabled={saving}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditing(toForm(p))}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void handleDelete(p.id)}
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
        <PromptEditor
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

function PromptEditor({
  form,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: PromptForm;
  saving: boolean;
  onChange: (form: PromptForm) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): React.JSX.Element {
  function patch(next: Partial<PromptForm>): void {
    onChange({ ...form, ...next });
  }

  const valid = form.name.trim().length > 0 && form.body.trim().length > 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-auto sm:max-w-lg">
        <DialogHeader className="mb-4">
          <DialogTitle>
            {form.id ? `Edit ${form.name}` : "New system prompt"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="sp-name">Name</Label>
            <Input
              id="sp-name"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sp-body">Prompt</Label>
            <Textarea
              id="sp-body"
              className="min-h-48 font-mono text-sm"
              placeholder="You are a helpful assistant…"
              value={form.body}
              onChange={(e) => patch({ body: e.target.value })}
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="sp-enabled"
              checked={form.enabled}
              onCheckedChange={(v) => patch({ enabled: v })}
            />
            <Label htmlFor="sp-enabled">Enabled</Label>
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
