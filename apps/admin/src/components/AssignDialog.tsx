import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Search, Users } from "lucide-react";
import type {
  Audience,
  ResourceAssignment,
  UserSummary,
} from "@flairy/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/**
 * Assign a resource (MCP server / skill / service) to an audience: everyone, or
 * a specific set of users. Prefilled from the admin snapshot (there is no GET
 * assignment endpoint); submitting PUTs a {@link ResourceAssignment}.
 */
export function AssignDialog({
  resourceName,
  initial,
  users,
  usersLoading = false,
  usersError,
  saving,
  onCancel,
  onSubmit,
}: {
  /** Label of the resource being assigned, shown in the title. */
  resourceName: string;
  /** Current assignment used to prefill the form. */
  initial: ResourceAssignment;
  /** Full user list to pick from (null while loading). */
  users: UserSummary[] | null;
  usersLoading?: boolean;
  usersError?: string | null;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (body: ResourceAssignment) => void;
}): React.JSX.Element {
  const [audience, setAudience] = useState<Audience>(initial.audience);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initial.userIds),
  );
  const [search, setSearch] = useState("");

  // Reset local state whenever the dialog is opened for a different resource.
  useEffect(() => {
    setAudience(initial.audience);
    setSelected(new Set(initial.userIds));
    setSearch("");
  }, [initial]);

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

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSubmit(): void {
    onSubmit({
      audience,
      userIds: audience === "specific" ? [...selected] : [],
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-hidden sm:max-w-lg">
        <DialogHeader className="mb-4">
          <DialogTitle>Assign {resourceName}</DialogTitle>
          <DialogDescription>
            Choose who receives this. Everyone gets it by default, or limit it to
            specific users.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Audience toggle (segmented). */}
          <div className="grid grid-cols-2 gap-2">
            <AudienceOption
              active={audience === "all"}
              label="Everyone"
              description="All signed-in users"
              onClick={() => setAudience("all")}
            />
            <AudienceOption
              active={audience === "specific"}
              label="Specific users"
              description="Only the users you pick"
              onClick={() => setAudience("specific")}
            />
          </div>

          {audience === "specific" && (
            <div className="space-y-2">
              <div className="relative">
                <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                <Input
                  aria-label="Search users"
                  placeholder="Search users..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>

              <div className="rounded-md border">
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
                  <ScrollArea className="max-h-64">
                    <ul className="divide-y divide-border">
                      {filtered.map((u) => {
                        const checked = selected.has(u.id);
                        return (
                          <li key={u.id}>
                            <button
                              type="button"
                              onClick={() => toggle(u.id)}
                              className="hover:bg-muted/50 flex w-full items-center gap-3 px-3 py-2 text-left transition-colors"
                            >
                              <span
                                className={cn(
                                  "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                                  checked
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-input",
                                )}
                              >
                                {checked && <Check className="size-3" />}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">
                                  {u.displayName}
                                </span>
                                <span className="text-muted-foreground block truncate text-xs">
                                  {u.email}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </ScrollArea>
                )}
              </div>

              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <Users className="size-3" />
                {selected.size} user{selected.size === 1 ? "" : "s"} selected
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button variant="outline" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AudienceOption({
  active,
  label,
  description,
  onClick,
}: {
  active: boolean;
  label: string;
  description: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border p-3 text-left transition-colors",
        active
          ? "border-primary bg-primary/5"
          : "border-border hover:bg-muted/50",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-full border",
            active ? "border-primary" : "border-input",
          )}
        >
          {active && <span className="bg-primary size-2 rounded-full" />}
        </span>
        {label}
      </span>
      <span className="text-muted-foreground mt-1 block pl-6 text-xs">
        {description}
      </span>
    </button>
  );
}

/** Small badge-ready summary string for an audience assignment. */
export function audienceLabel(
  audience: Audience,
  assignedUserIds: string[],
): string {
  if (audience === "all") return "Everyone";
  const n = assignedUserIds.length;
  return `${n} user${n === 1 ? "" : "s"}`;
}
