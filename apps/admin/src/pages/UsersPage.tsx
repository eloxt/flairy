import { useState } from "react";
import { Pencil, Plus, Trash2, UserCheck, UserX } from "lucide-react";
import type {
  CreateUserRequest,
  UpdateUserRequest,
  UserRole,
  UserSummary,
} from "@flairy/shared";
import { useUsers } from "@/hooks/useUsers";
import { useAuth } from "@/auth/useAuth";
import { createUser, deleteUser, updateUser } from "@/api/client";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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

const ROLES: UserRole[] = ["user", "admin"];

/** Local editor state. Empty `id` means "creating a new user". */
interface UserForm {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  /** Create: required. Edit: blank means "leave the password unchanged". */
  password: string;
  activated: boolean;
}

function emptyForm(): UserForm {
  return {
    id: "",
    email: "",
    displayName: "",
    role: "user",
    password: "",
    activated: true,
  };
}

function userToForm(u: UserSummary): UserForm {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    password: "",
    activated: u.activated,
  };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export function UsersPage(): React.JSX.Element {
  const { users, loading, error, saving, mutate } = useUsers();
  const { user: currentUser } = useAuth();
  const [editing, setEditing] = useState<UserForm | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserSummary | null>(null);

  if (loading && !users) return <PageLoading />;
  if (error && !users) return <PageError message={error} />;
  if (!users) return <PageError message="No users." />;

  // Run a mutation; on success invoke `done` (usually to close an editor).
  async function run(
    fn: () => Promise<unknown>,
    done: () => void,
  ): Promise<void> {
    try {
      await mutate(fn);
      done();
    } catch {
      // Error surfaced via the hook; keep the editor open.
    }
  }

  const adminCount = users.filter((u) => u.role === "admin").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="People who can sign in. Administrators can also manage server configuration; everyone else is a regular app user."
        action={
          <Button size="sm" onClick={() => setEditing(emptyForm())}>
            <Plus className="size-4" /> Add user
          </Button>
        }
      />

      {error && <PageError message={error} />}

      <TablePanel>
        {users.length === 0 ? (
          <TableEmpty>No users yet.</TableEmpty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className="w-24">Role</TableHead>
                <TableHead className="w-28">Status</TableHead>
                <TableHead className="w-28">Created</TableHead>
                <TableHead className="w-28 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => {
                const isSelf = currentUser?.id === u.id;
                const isLastAdmin = u.role === "admin" && adminCount <= 1;
                const deleteDisabled = saving || isSelf || isLastAdmin;
                const deleteTitle = isSelf
                  ? "You cannot delete your own account"
                  : isLastAdmin
                    ? "Cannot delete the last administrator"
                    : "Delete user";
                // An admin can't deactivate their own account (would lock them out).
                const toggleDisabled = saving || (u.activated && isSelf);
                const toggleTitle = u.activated
                  ? isSelf
                    ? "You cannot deactivate your own account"
                    : "Deactivate user"
                  : "Activate user";
                return (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">
                      {u.displayName}
                      {isSelf && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          (you)
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {u.email}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={u.role === "admin" ? "default" : "secondary"}
                      >
                        {u.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={u.activated ? "secondary" : "destructive"}
                      >
                        {u.activated ? "Active" : "Pending"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(u.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={toggleTitle}
                          disabled={toggleDisabled}
                          onClick={() =>
                            void run(
                              () => updateUser(u.id, { activated: !u.activated }),
                              () => {},
                            )
                          }
                        >
                          {u.activated ? (
                            <UserX className="size-4" />
                          ) : (
                            <UserCheck className="size-4 text-primary" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Edit user"
                          onClick={() => setEditing(userToForm(u))}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={deleteTitle}
                          disabled={deleteDisabled}
                          onClick={() => setDeleteTarget(u)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </TablePanel>

      {editing && (
        <UserEditor
          form={editing}
          saving={saving}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSubmit={() =>
            void run(
              () =>
                editing.id
                  ? updateUser(editing.id, formToUpdate(editing))
                  : createUser(formToCreate(editing)),
              () => setEditing(null),
            )
          }
        />
      )}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget &&
                `This permanently removes ${deleteTarget.displayName} (${deleteTarget.email}). This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={() => {
                const target = deleteTarget;
                if (!target) return;
                void run(
                  () => deleteUser(target.id),
                  () => setDeleteTarget(null),
                );
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formToCreate(form: UserForm): CreateUserRequest {
  return {
    email: form.email.trim(),
    displayName: form.displayName.trim(),
    role: form.role,
    password: form.password,
    activated: form.activated,
  };
}

function formToUpdate(form: UserForm): UpdateUserRequest {
  const body: UpdateUserRequest = {
    displayName: form.displayName.trim(),
    role: form.role,
    activated: form.activated,
  };
  if (form.password.length > 0) body.password = form.password;
  return body;
}

function UserEditor({
  form,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: UserForm;
  saving: boolean;
  onChange: (form: UserForm) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): React.JSX.Element {
  const isNew = form.id === "";

  function patch(next: Partial<UserForm>): void {
    onChange({ ...form, ...next });
  }

  const valid =
    form.displayName.trim().length > 0 &&
    (isNew
      ? form.email.trim().length > 0 && form.password.length > 0
      : true);

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-auto sm:max-w-lg">
        <DialogHeader className="mb-4">
          <DialogTitle>{isNew ? "New user" : `Edit ${form.displayName}`}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="user-email">Email</Label>
            <Input
              id="user-email"
              type="email"
              value={form.email}
              disabled={!isNew}
              onChange={(e) => patch({ email: e.target.value })}
            />
            {!isNew && (
              <p className="text-xs text-muted-foreground">
                Email is the account identity and can't be changed here.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="user-name">Display name</Label>
            <Input
              id="user-name"
              value={form.displayName}
              onChange={(e) => patch({ displayName: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="user-role">Role</Label>
            <Select
              value={form.role}
              onValueChange={(v) => patch({ role: v as UserRole })}
            >
              <SelectTrigger id="user-role" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r === "admin" ? "Admin" : "User"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="user-password">
              {isNew ? "Password" : "Reset password"}
            </Label>
            <Input
              id="user-password"
              type="password"
              autoComplete="new-password"
              value={form.password}
              placeholder={isNew ? "" : "Leave blank to keep current password"}
              onChange={(e) => patch({ password: e.target.value })}
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="user-activated">Activated</Label>
              <p className="text-xs text-muted-foreground">
                Deactivated accounts can't sign in to the client until an
                administrator activates them.
              </p>
            </div>
            <Switch
              id="user-activated"
              checked={form.activated}
              onCheckedChange={(checked) => patch({ activated: checked })}
            />
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
