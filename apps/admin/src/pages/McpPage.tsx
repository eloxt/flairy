import { useState } from "react";
import { Pencil, Plus, Trash2, Users } from "lucide-react";
import type {
  AdminMcpServerConfig,
  McpServerConfig,
  McpServerInput,
  McpTransport,
  ResourceAssignment,
} from "@flairy/shared";
import { useConfig } from "@/hooks/useConfig";
import { useUsers } from "@/hooks/useUsers";
import {
  createMcpServer,
  deleteMcpServer,
  setMcpAssignment,
  updateMcpServer,
} from "@/api/client";
import { PageError, PageLoading } from "@/components/PageState";
import { PageHeader } from "@/components/PageHeader";
import { AssignDialog, audienceLabel } from "@/components/AssignDialog";
import {
  KeyValueEditor,
  recordToRows,
  rowsToRecord,
  type KvRow,
} from "@/components/KeyValueEditor";
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

type TransportKind = McpTransport["kind"];

/** Local editor form: holds every transport field so switching kind keeps input. */
interface ServerForm {
  /** Empty for a new (unsaved) server. */
  id: string;
  name: string;
  enabled: boolean;
  allowedTools: string;
  kind: TransportKind;
  command: string;
  args: string;
  url: string;
  envRows: KvRow[];
  headerRows: KvRow[];
}

function toForm(server: McpServerConfig): ServerForm {
  const t = server.transport;
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    allowedTools: (server.allowedTools ?? []).join("\n"),
    kind: t.kind,
    command: t.kind === "stdio" ? t.command : "",
    args: t.kind === "stdio" ? (t.args ?? []).join(" ") : "",
    url: t.kind === "stdio" ? "" : t.url,
    envRows: t.kind === "stdio" ? recordToRows(t.env) : [],
    headerRows: t.kind === "stdio" ? [] : recordToRows(t.headers),
  };
}

function emptyForm(): ServerForm {
  return {
    id: "",
    name: "",
    enabled: true,
    allowedTools: "",
    kind: "stdio",
    command: "",
    args: "",
    url: "",
    envRows: [],
    headerRows: [],
  };
}

function buildTransport(form: ServerForm): McpTransport {
  if (form.kind === "stdio") {
    const args = form.args.trim() ? form.args.trim().split(/\s+/) : undefined;
    const env = rowsToRecord(form.envRows);
    return {
      kind: "stdio",
      command: form.command.trim(),
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
    };
  }
  const headers = rowsToRecord(form.headerRows);
  return {
    kind: form.kind,
    url: form.url.trim(),
    ...(headers ? { headers } : {}),
  };
}

function formToInput(form: ServerForm): McpServerInput {
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    allowedTools: parseAllowedTools(form.allowedTools),
    transport: buildTransport(form),
  };
}

/** Project a stored server back to an input payload (for enable/disable toggles). */
function serverToInput(
  server: McpServerConfig,
  enabled: boolean,
): McpServerInput {
  return {
    name: server.name,
    transport: server.transport,
    allowedTools: server.allowedTools ?? [],
    enabled,
  };
}

function transportSummary(t: McpTransport): string {
  return t.kind === "stdio" ? `stdio · ${t.command}` : `${t.kind} · ${t.url}`;
}

function parseAllowedTools(value: string): string[] {
  const tools = value
    .split(/[\s,]+/)
    .map((tool) => tool.trim())
    .filter(Boolean);
  return [...new Set(tools)].sort();
}

function toolFilterSummary(server: McpServerConfig): string {
  const count = server.allowedTools?.length ?? 0;
  return count > 0 ? `${count} selected` : "All tools";
}

export function McpPage(): React.JSX.Element {
  const { config, loading, error, saving, mutate } = useConfig();
  const { users, loading: usersLoading, error: usersError } = useUsers();
  const [editing, setEditing] = useState<ServerForm | null>(null);
  const [assigning, setAssigning] = useState<AdminMcpServerConfig | null>(null);

  if (loading) return <PageLoading />;
  if (error && !config) return <PageError message={error} />;
  if (!config) return <PageError message="No configuration available." />;

  const servers = config.mcpServers;

  async function handleAssign(body: ResourceAssignment): Promise<void> {
    if (!assigning) return;
    try {
      await mutate(() => setMcpAssignment(assigning.id, body));
      setAssigning(null);
    } catch {
      // surfaced via hook error state
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!editing) return;
    const input = formToInput(editing);
    try {
      await mutate(() =>
        editing.id
          ? updateMcpServer(editing.id, input)
          : createMcpServer(input),
      );
      setEditing(null);
    } catch {
      // surfaced via hook error state
    }
  }

  async function handleToggle(
    server: McpServerConfig,
    enabled: boolean,
  ): Promise<void> {
    try {
      await mutate(() =>
        updateMcpServer(server.id, serverToInput(server, enabled)),
      );
    } catch {
      // surfaced via hook error state
    }
  }

  async function handleDelete(id: string): Promise<void> {
    try {
      await mutate(() => deleteMcpServer(id));
    } catch {
      // surfaced via hook error state
    }
  }

  return (
    <div>
      <PageHeader
        title="MCP Servers"
        description="Tool providers connected on each client."
        action={
          <Button onClick={() => setEditing(emptyForm())}>
            <Plus className="size-4" />
            Add server
          </Button>
        }
      />
      {error && (
        <div className="mb-4">
          <PageError message={error} />
        </div>
      )}

      <TablePanel>
        {servers.length === 0 ? (
          <TableEmpty>No MCP servers configured yet.</TableEmpty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Transport</TableHead>
                <TableHead className="w-28">Tools</TableHead>
                <TableHead className="w-32">Audience</TableHead>
                <TableHead className="w-20">Enabled</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {servers.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {transportSummary(s.transport)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        (s.allowedTools?.length ?? 0) > 0
                          ? "default"
                          : "secondary"
                      }
                    >
                      {toolFilterSummary(s)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={s.audience === "all" ? "secondary" : "default"}
                    >
                      {audienceLabel(s.audience, s.assignedUserIds)}
                    </Badge>
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
                        aria-label={`Assign ${s.name}`}
                        onClick={() => setAssigning(s)}
                      >
                        <Users className="size-4" />
                      </Button>
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
        <ServerEditor
          form={editing}
          saving={saving}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSubmit={handleSubmit}
        />
      )}

      {assigning && (
        <AssignDialog
          resourceName={assigning.name}
          initial={{
            audience: assigning.audience,
            userIds: assigning.assignedUserIds,
          }}
          users={users}
          usersLoading={usersLoading}
          usersError={usersError}
          saving={saving}
          onCancel={() => setAssigning(null)}
          onSubmit={(body) => void handleAssign(body)}
        />
      )}
    </div>
  );
}

function ServerEditor({
  form,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: ServerForm;
  saving: boolean;
  onChange: (form: ServerForm) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): React.JSX.Element {
  function patch(next: Partial<ServerForm>): void {
    onChange({ ...form, ...next });
  }

  const valid =
    form.name.trim().length > 0 &&
    (form.kind === "stdio"
      ? form.command.trim().length > 0
      : form.url.trim().length > 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-auto sm:max-w-lg">
        <DialogHeader className="mb-4">
          <DialogTitle>
            {form.id ? `Edit ${form.name}` : "New MCP server"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="mcp-kind">Transport</Label>
            <Select
              value={form.kind}
              onValueChange={(v) => patch({ kind: v as TransportKind })}
            >
              <SelectTrigger id="mcp-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">stdio</SelectItem>
                <SelectItem value="sse">sse</SelectItem>
                <SelectItem value="http">http</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {form.kind === "stdio" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="mcp-command">Command</Label>
                <Input
                  id="mcp-command"
                  placeholder="npx"
                  value={form.command}
                  onChange={(e) => patch({ command: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-args">Args (space-separated)</Label>
                <Input
                  id="mcp-args"
                  placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                  value={form.args}
                  onChange={(e) => patch({ args: e.target.value })}
                />
              </div>
              <KeyValueEditor
                label="Environment"
                rows={form.envRows}
                onChange={(rows) => patch({ envRows: rows })}
              />
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="mcp-url">URL</Label>
                <Input
                  id="mcp-url"
                  placeholder="https://example.com/mcp"
                  value={form.url}
                  onChange={(e) => patch({ url: e.target.value })}
                />
              </div>
              <KeyValueEditor
                label="Headers"
                rows={form.headerRows}
                onChange={(rows) => patch({ headerRows: rows })}
              />
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="mcp-allowed-tools">Allowed tools</Label>
            <Textarea
              id="mcp-allowed-tools"
              className="min-h-24"
              placeholder="Leave empty to allow every tool"
              value={form.allowedTools}
              onChange={(e) => patch({ allowedTools: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Enter MCP tool names separated by spaces, commas, or new lines.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="mcp-enabled"
              checked={form.enabled}
              onCheckedChange={(v) => patch({ enabled: v })}
            />
            <Label htmlFor="mcp-enabled">Enabled</Label>
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
