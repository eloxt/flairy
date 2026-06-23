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
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useDeleteSkill, useGetSkill, useUpdateSkill } from './queries'
import type { SkillConfig } from '@flairy/shared'
import type { SkillFileEntry } from '@/lib/types/skills'
import { ArrowLeft, Loader2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { type SkillFormState, composeFrontmatter, useSkillForm } from './helpers'
import { SkillHeader } from './shared'
import { SkillFormFields } from './skillEditFormFields'
import { SkillEditView } from './skillEditForm'

// ---------- SkillDetailView ----------

export function SkillDetailView({
  skillId,
  isEditing,
  setIsEditing,
  onBack
}: {
  skillId: string
  isEditing: boolean
  setIsEditing: (editing: boolean) => void
  onBack: () => void
}): React.JSX.Element {
  const { data: skill, isLoading } = useGetSkill(skillId)
  const updateMutation = useUpdateSkill()
  const deleteMutation = useDeleteSkill()
  const isUpdating = updateMutation.isPending
  const isDeleting = deleteMutation.isPending

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  const form = useSkillForm()

  function buildFormState(skillData: SkillConfig): SkillFormState {
    return {
      name: skillData.name,
      description: skillData.description,
      license: skillData.license || '',
      compatibility: skillData.compatibility || '',
      allowedTools: skillData.allowedTools || '',
      extraFrontmatterJson:
        skillData.extraFrontmatter && Object.keys(skillData.extraFrontmatter).length > 0
          ? JSON.stringify(skillData.extraFrontmatter, null, 2)
          : '',
      metadataJson:
        skillData.metadata && Object.keys(skillData.metadata).length > 0
          ? JSON.stringify(skillData.metadata, null, 2)
          : '',
      skillMdBody: skillData.skillMdBody,
      enabled: skillData.enabled,
      files: (skillData.files ?? []).map((f) => ({
        path: f.path,
        sourceType: f.sourceType,
        content: f.content,
        sourceUrl: f.sourceUrl,
        dataurl: f.dataurl,
        mimeType: f.mimeType,
        fileSizeBytes: f.fileSizeBytes
      })) as SkillFileEntry[]
    }
  }

  const lastResetSkillIdRef = useRef<string | null>(null)

  // Populate the form when skill data loads or the selected skill changes. Skip
  // resets during an active edit of the same skill so a background refetch can't
  // wipe unsaved changes.
  useEffect(() => {
    if (!skill) return
    const isNewSkill = lastResetSkillIdRef.current !== skillId
    if (!isEditing || isNewSkill) {
      form.reset(buildFormState(skill))
      lastResetSkillIdRef.current = skillId
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill, isEditing, skillId])

  const handleSave = async (): Promise<void> => {
    if (!form.runValidation()) return
    try {
      const payload = form.getPayload()
      // Name is immutable server-side; keep the original name on update.
      await updateMutation.mutateAsync({
        id: skillId,
        data: { ...payload, name: skill?.name ?? payload.name }
      })
      toast.success('Skill saved')
      setIsEditing(false)
    } catch (err: unknown) {
      toast.error('Failed to update skill', {
        description: err instanceof Error ? err.message : undefined
      })
    }
  }

  const handleToggleEnabled = async (enabled: boolean): Promise<void> => {
    if (!skill) return
    try {
      const state = buildFormState(skill)
      await updateMutation.mutateAsync({
        id: skillId,
        data: {
          name: skill.name,
          description: state.description,
          license: state.license || undefined,
          compatibility: state.compatibility || undefined,
          metadata: skill.metadata,
          extraFrontmatter: skill.extraFrontmatter,
          allowedTools: state.allowedTools || undefined,
          skillMdBody: state.skillMdBody,
          enabled,
          files: state.files.map(({ __local, ...rest }) => {
            void __local
            return rest
          })
        }
      })
      toast.success(enabled ? 'Skill enabled' : 'Skill disabled')
    } catch (err: unknown) {
      toast.error('Failed to update skill', {
        description: err instanceof Error ? err.message : undefined
      })
    }
  }

  const handleDelete = async (): Promise<void> => {
    try {
      await deleteMutation.mutateAsync(skillId)
      toast.success('Skill deleted')
      onBack()
    } catch (err: unknown) {
      toast.error('Failed to delete skill', {
        description: err instanceof Error ? err.message : undefined
      })
    }
  }

  const handleCancelEdit = (): void => {
    if (skill) form.reset(buildFormState(skill))
    setIsEditing(false)
  }

  if (isLoading) {
    return (
      <div className="flex w-full flex-1 items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!skill) {
    return (
      <div className="flex w-full flex-1 flex-col items-center justify-center p-4">
        <p className="text-muted-foreground text-sm">Skill not found</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to list
        </Button>
      </div>
    )
  }

  return (
    <div className="relative flex w-full min-h-0 flex-1 flex-col">
      {isEditing ? (
        <SkillEditView
          form={form}
          skillId={skillId}
          onSave={() => void handleSave()}
          onCancel={handleCancelEdit}
          isSaving={isUpdating}
        />
      ) : (
        <>
          <SkillHeader
            name={skill.name}
            description={skill.description}
            license={skill.license}
            compatibility={skill.compatibility}
            allowedTools={skill.allowedTools}
            composedSkillMd={
              composeFrontmatter({
                name: skill.name,
                description: skill.description,
                license: skill.license || '',
                compatibility: skill.compatibility || '',
                allowed_tools: skill.allowedTools || '',
                extra_frontmatter_json:
                  skill.extraFrontmatter && Object.keys(skill.extraFrontmatter).length > 0
                    ? JSON.stringify(skill.extraFrontmatter, null, 2)
                    : '',
                metadata_json:
                  skill.metadata && Object.keys(skill.metadata).length > 0
                    ? JSON.stringify(skill.metadata, null, 2)
                    : ''
              }) +
              '\n\n' +
              skill.skillMdBody
            }
            onBack={onBack}
            actions={
              <>
                <div className="mr-2 flex items-center gap-2">
                  <Switch
                    id="skill-enabled"
                    checked={skill.enabled}
                    onCheckedChange={(v) => void handleToggleEnabled(v)}
                    disabled={isUpdating}
                  />
                  <Label htmlFor="skill-enabled" className="text-xs text-muted-foreground">
                    Enabled
                  </Label>
                </div>
                <Button size="sm" onClick={() => setIsEditing(true)}>
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </Button>
                <DropdownMenu>
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
                      variant="destructive"
                      className="cursor-pointer"
                      disabled={isDeleting}
                      closeOnClick={false}
                      onClick={() => setDeleteDialogOpen(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {skill.name}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This action cannot be undone. The skill and its files will be permanently
                        deleted.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void handleDelete()} disabled={isDeleting}>
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
            }
          />

          <div className="mt-3 min-h-0 flex-1 flex flex-col">
            <SkillFormFields skill={skill} />
          </div>
        </>
      )}
    </div>
  )
}
