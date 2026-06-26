import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useDeleteSkill, useListSkills, useSetSkillAssignment } from './queries'
import type { ResourceAssignment, SkillListItem } from '@flairy/shared'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  Users,
  BookOpenText
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useUsers } from '@/hooks/useUsers'
import { AssignDialog, audienceLabel } from '@/components/AssignDialog'
import { PAGE_SIZE, formatDateShort, useDebouncedValue } from './helpers'

// ---------- SortableHeader ----------

type SortColumn = 'name' | 'updated_at'
type SortOrder = 'asc' | 'desc'

function SortableHeader({
  column,
  label,
  sortBy,
  order,
  onToggle
}: {
  column: SortColumn
  label: string
  sortBy: SortColumn | null
  order: SortOrder
  onToggle: (column: SortColumn) => void
}): React.JSX.Element {
  const isActive = sortBy === column
  let Icon = ArrowUpDown
  if (isActive && order === 'desc') Icon = ArrowDown
  else if (isActive) Icon = ArrowUp
  return (
    <Button
      variant="ghost"
      onClick={() => onToggle(column)}
      className="!px-0"
      aria-label={`Sort by ${label}`}
    >
      {label}
      <Icon className={isActive ? 'h-4 w-4 text-foreground' : 'h-4 w-4'} />
    </Button>
  )
}

// ---------- SkillActionsMenu ----------

function SkillActionsMenu({
  skill,
  isDeleting,
  onAssign,
  onDelete
}: {
  skill: SkillListItem
  isDeleting: boolean
  onAssign: (skill: SkillListItem) => void
  onDelete: (id: string) => Promise<void>
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  return (
    <>
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={`Actions for ${skill.name}`}
            />
          }
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            className="cursor-pointer"
            closeOnClick={false}
            onClick={() => {
              onAssign(skill)
              setIsOpen(false)
            }}
          >
            <Users className="h-4 w-4" />
            Assign users
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            className="cursor-pointer"
            disabled={isDeleting}
            closeOnClick={false}
            onClick={() => {
              setDeleteOpen(true)
              setIsOpen(false)
            }}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {skill.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The skill and its files will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onDelete(skill.id)} disabled={isDeleting}>
              {isDeleting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Deleting...
                </>
              ) : (
                'Delete skill'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ---------- SkillsListView ----------

export function SkillsListView({
  onSelectSkill,
  onCreateNew
}: {
  onSelectSkill: (id: string, edit?: boolean) => void
  onCreateNew: () => void
}): React.JSX.Element {
  const deleteMutation = useDeleteSkill()
  const isDeleting = deleteMutation.isPending
  const assignMutation = useSetSkillAssignment()
  const { users, loading: usersLoading, error: usersError } = useUsers()
  const [assigning, setAssigning] = useState<SkillListItem | null>(null)

  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 300)
  const [offset, setOffset] = useState(0)
  const [sortBy, setSortBy] = useState<SortColumn | null>(null)
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')

  const { data, isLoading, isFetching, isError, refetch } = useListSkills({
    limit: PAGE_SIZE,
    offset,
    search: debouncedSearch || undefined,
    sortBy: sortBy || undefined,
    order: sortBy ? sortOrder : undefined
  })

  const skills = data?.skills || []
  const total = data?.total || 0

  const toggleSort = (column: SortColumn): void => {
    setOffset(0)
    if (sortBy === column) {
      if (sortOrder === 'asc') {
        setSortOrder('desc')
      } else {
        setSortBy(null)
        setSortOrder('asc')
      }
    } else {
      setSortBy(column)
      setSortOrder('asc')
    }
  }

  const handleAssign = async (body: ResourceAssignment): Promise<void> => {
    if (!assigning) return
    try {
      await assignMutation.mutateAsync({ id: assigning.id, body })
      toast.success('Assignment updated')
      setAssigning(null)
    } catch (err: unknown) {
      toast.error('Failed to update assignment', {
        description: err instanceof Error ? err.message : undefined
      })
    }
  }

  const handleDeleteSkill = async (id: string): Promise<void> => {
    try {
      await deleteMutation.mutateAsync(id)
      toast.success('Skill deleted')
    } catch (err: unknown) {
      toast.error('Failed to delete skill', {
        description: err instanceof Error ? err.message : undefined
      })
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20">
        <p className="text-muted-foreground text-sm">Failed to load skills</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    )
  }

  if (total === 0 && !search && !isFetching) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 py-16 text-center">
        <div className="text-muted-foreground">
          <BookOpenText className="h-24 w-24" strokeWidth={1} />
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="text-muted-foreground text-xl font-medium">
            Create and manage Agent Skills
          </h1>
          <div className="text-muted-foreground mx-auto mt-2 max-w-xl text-sm font-normal">
            Manage SKILL.md instructions and supporting files in one place. Enabled skills are
            delivered to every signed-in client.
          </div>
          <div className="mx-auto mt-6 flex flex-row flex-wrap items-center justify-center gap-2">
            <Button onClick={onCreateNew}>Create Skill</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full flex-1 flex flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">Skills</h2>
          <p className="text-muted-foreground text-sm">
            Manage Agent Skills delivered to signed-in clients
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onCreateNew} size="sm">
            <Plus className="h-4 w-4" />
            New Skill
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative max-w-sm flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            aria-label="Search skills by name"
            placeholder="Search skills..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setOffset(0)
            }}
            className="pl-9"
          />
        </div>
      </div>

      {/* Table */}
      <div className="grow overflow-hidden rounded-sm border">
        <Table className="w-full table-fixed">
          <TableHeader className="bg-muted sticky top-0 z-20">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-60">
                <SortableHeader
                  column="name"
                  label="Name"
                  sortBy={sortBy}
                  order={sortOrder}
                  onToggle={toggleSort}
                />
              </TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-28">Files</TableHead>
              <TableHead className="w-32">Audience</TableHead>
              <TableHead className="w-24">Enabled</TableHead>
              <TableHead className="w-44">
                <SortableHeader
                  column="updated_at"
                  label="Updated"
                  sortBy={sortBy}
                  order={sortOrder}
                  onToggle={toggleSort}
                />
              </TableHead>
              <TableHead className="w-14 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {skills.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <FileText className="h-8 w-8 text-muted-foreground" />
                    <p className="text-muted-foreground text-sm">
                      {search ? 'No skills match your search' : 'No skills created yet'}
                    </p>
                    {!search && (
                      <Button variant="outline" size="sm" onClick={onCreateNew} className="mt-2">
                        <Plus className="h-3.5 w-3.5" />
                        Create your first skill
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              skills.map((skill) => {
                const fileCount = skill.fileCount ?? 0

                return (
                  <TableRow
                    key={skill.id}
                    className="group hover:bg-muted/50 cursor-pointer transition-colors"
                    tabIndex={0}
                    onClick={() => onSelectSkill(skill.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSelectSkill(skill.id)
                      }
                    }}
                  >
                    <TableCell className="w-60 max-w-60 overflow-hidden font-medium font-mono text-sm">
                      <div className="max-w-full truncate" title={skill.name}>
                        {skill.name}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground overflow-hidden text-sm">
                      <div className="truncate" title={skill.description}>
                        {skill.description}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground text-xs">
                        <span className="font-mono text-foreground">{fileCount}</span> files
                      </span>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Badge
                        variant={skill.audience === 'all' ? 'secondary' : 'default'}
                        className="text-xs"
                      >
                        {audienceLabel(skill.audience, skill.assignedUserIds)}
                      </Badge>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {skill.enabled ? (
                        <Badge variant="secondary" className="text-xs">
                          On
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs">
                          Off
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDateShort(skill.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <SkillActionsMenu
                        skill={skill}
                        isDeleting={isDeleting}
                        onAssign={setAssigning}
                        onDelete={handleDeleteSkill}
                      />
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div className="flex shrink-0 items-center justify-between text-xs mt-3">
          <div className="text-muted-foreground flex items-center gap-2">
            {(offset + 1).toLocaleString()}-{Math.min(offset + PAGE_SIZE, total).toLocaleString()} of{' '}
            {total.toLocaleString()} entries
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0 || isFetching}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-3" />
            </Button>
            <div className="flex items-center gap-1">
              <span>Page</span>
              <span>{Math.floor(offset / PAGE_SIZE) + 1}</span>
              <span>of {Math.ceil(total / PAGE_SIZE)}</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total || isFetching}
              aria-label="Next page"
            >
              <ChevronRight className="size-3" />
            </Button>
          </div>
        </div>
      )}

      {assigning && (
        <AssignDialog
          resourceName={assigning.name}
          initial={{
            audience: assigning.audience,
            userIds: assigning.assignedUserIds
          }}
          users={users}
          usersLoading={usersLoading}
          usersError={usersError}
          saving={assignMutation.isPending}
          onCancel={() => setAssigning(null)}
          onSubmit={(body) => void handleAssign(body)}
        />
      )}
    </div>
  )
}
