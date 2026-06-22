import { toast } from 'sonner'
import { useCreateSkill } from './queries'
import { useSkillForm } from './helpers'
import { SkillEditView } from './skillEditForm'

// ---------- SkillCreateView ----------

export function SkillCreateView({
  onCreated,
  onBack
}: {
  onCreated: (id: string) => void
  onBack: () => void
}): React.JSX.Element {
  const createMutation = useCreateSkill()
  const form = useSkillForm()

  const handleCreate = async (): Promise<void> => {
    if (!form.runValidation()) return
    try {
      const result = await createMutation.mutateAsync(form.getPayload())
      toast.success('Skill created successfully')
      onCreated(result.id)
    } catch (err: unknown) {
      toast.error('Failed to create skill', {
        description: err instanceof Error ? err.message : undefined
      })
    }
  }

  return (
    <SkillEditView
      form={form}
      onSave={() => void handleCreate()}
      onCancel={onBack}
      onBack={onBack}
      isSaving={createMutation.isPending}
      mode="create"
    />
  )
}
