import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type {
  AnnouncementConfig,
  AnnouncementInput,
  AnnouncementKind,
} from "@flairy/shared";
import { useConfig } from "@/hooks/useConfig";
import {
  createAnnouncement,
  deleteAnnouncement,
  updateAnnouncement,
} from "@/api/client";
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
import { Textarea } from "@/components/ui/textarea";

/** The selectable announcement tones, in display order. */
const KINDS: AnnouncementKind[] = ["info", "success", "warning", "error"];

/** Badge tone per announcement kind (shared design language with the client). */
const KIND_VARIANT: Record<
  AnnouncementKind,
  "default" | "secondary" | "destructive" | "outline"
> = {
  info: "secondary",
  success: "default",
  warning: "outline",
  error: "destructive",
};

/** Local editor form. Empty `id` means a new (unsaved) announcement. */
interface AnnouncementForm {
  id: string;
  kind: AnnouncementKind;
  title: string;
  content: string;
  enabled: boolean;
}

function toForm(a: AnnouncementConfig): AnnouncementForm {
  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    content: a.content,
    enabled: a.enabled,
  };
}

function emptyForm(): AnnouncementForm {
  return { id: "", kind: "info", title: "", content: "", enabled: true };
}

function formToInput(form: AnnouncementForm): AnnouncementInput {
  return {
    kind: form.kind,
    title: form.title.trim(),
    content: form.content,
    enabled: form.enabled,
  };
}

/** Project a stored announcement back to an input payload (for enable/disable toggles). */
function announcementToInput(
  a: AnnouncementConfig,
  enabled: boolean,
): AnnouncementInput {
  return { kind: a.kind, title: a.title, content: a.content, enabled };
}

export function AnnouncementsPage(): React.JSX.Element {
  const { config, loading, error, saving, mutate } = useConfig();
  const [editing, setEditing] = useState<AnnouncementForm | null>(null);

  if (loading) return <PageLoading />;
  if (error && !config) return <PageError message={error} />;
  if (!config) return <PageError message="No configuration available." />;

  const announcements = config.announcements;

  async function handleSubmit(): Promise<void> {
    if (!editing) return;
    const input = formToInput(editing);
    try {
      await mutate(() =>
        editing.id
          ? updateAnnouncement(editing.id, input)
          : createAnnouncement(input),
      );
      setEditing(null);
    } catch {
      // surfaced via hook error state
    }
  }

  async function handleToggle(
    a: AnnouncementConfig,
    enabled: boolean,
  ): Promise<void> {
    try {
      await mutate(() =>
        updateAnnouncement(a.id, announcementToInput(a, enabled)),
      );
    } catch {
      // surfaced via hook error state
    }
  }

  async function handleDelete(id: string): Promise<void> {
    try {
      await mutate(() => deleteAnnouncement(id));
    } catch {
      // surfaced via hook error state
    }
  }

  return (
    <div>
      <PageHeader
        title="Announcements"
        description="Banners shown atop the empty chat screen on every client."
        action={
          <Button onClick={() => setEditing(emptyForm())}>
            <Plus className="size-4" />
            Add announcement
          </Button>
        }
      />
      {error && (
        <div className="mb-4">
          <PageError message={error} />
        </div>
      )}

      <TablePanel>
        {announcements.length === 0 ? (
          <TableEmpty>No announcements configured yet.</TableEmpty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Type</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="w-20">Enabled</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {announcements.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Badge variant={KIND_VARIANT[a.kind]} className="capitalize">
                      {a.kind}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">{a.title}</TableCell>
                  <TableCell>
                    <Switch
                      checked={a.enabled}
                      onCheckedChange={(v) => void handleToggle(a, v)}
                      disabled={saving}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setEditing(toForm(a))}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void handleDelete(a.id)}
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
        <AnnouncementEditor
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

function AnnouncementEditor({
  form,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: AnnouncementForm;
  saving: boolean;
  onChange: (form: AnnouncementForm) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): React.JSX.Element {
  function patch(next: Partial<AnnouncementForm>): void {
    onChange({ ...form, ...next });
  }

  const valid = form.title.trim().length > 0 && form.content.trim().length > 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-auto sm:max-w-lg">
        <DialogHeader className="mb-4">
          <DialogTitle>
            {form.id ? `Edit ${form.title}` : "New announcement"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="an-kind">Type</Label>
            <Select
              value={form.kind}
              onValueChange={(v) => patch({ kind: v as AnnouncementKind })}
            >
              <SelectTrigger id="an-kind" className="w-full capitalize">
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
            <Label htmlFor="an-title">Title</Label>
            <Input
              id="an-title"
              value={form.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="an-content">Content</Label>
            <Textarea
              id="an-content"
              className="min-h-32 text-sm"
              placeholder="What do you want every user to know?"
              value={form.content}
              onChange={(e) => patch({ content: e.target.value })}
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="an-enabled"
              checked={form.enabled}
              onCheckedChange={(v) => patch({ enabled: v })}
            />
            <Label htmlFor="an-enabled">Enabled</Label>
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
