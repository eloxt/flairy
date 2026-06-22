import { useState } from 'react'
import { SkillsListView } from './skills-repo/skillListView'
import { SkillCreateView } from './skills-repo/skillCreatorView'
import { SkillDetailView } from './skills-repo/skillDetailsView'

type View =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'detail'; skillId: string; editing: boolean }

/**
 * Skills repository page: hosts the list / create / detail-edit views with local
 * view switching (replaces Bifrost's URL-state routing). The route stays
 * `/skills` in App.tsx.
 */
export function SkillsPage(): React.JSX.Element {
  const [view, setView] = useState<View>({ kind: 'list' })

  const handleSelectSkill = (id: string, edit = false): void => {
    setView({ kind: 'detail', skillId: id, editing: edit })
  }
  const handleBack = (): void => setView({ kind: 'list' })
  const handleCreated = (id: string): void => {
    setView({ kind: 'detail', skillId: id, editing: false })
  }
  const setIsEditing = (editing: boolean): void => {
    setView((prev) => (prev.kind === 'detail' ? { ...prev, editing } : prev))
  }

  if (view.kind === 'create') {
    return (
      <div className="flex h-[calc(100vh-3.5rem)] w-full flex-col p-0">
        <SkillCreateView onCreated={handleCreated} onBack={handleBack} />
      </div>
    )
  }

  if (view.kind === 'detail') {
    return (
      <div
        className={
          view.editing
            ? 'flex h-[calc(100vh-3.5rem)] w-full flex-col p-0'
            : 'flex h-[calc(100vh-3.5rem)] w-full flex-col p-4 pt-0'
        }
      >
        <SkillDetailView
          skillId={view.skillId}
          isEditing={view.editing}
          setIsEditing={setIsEditing}
          onBack={handleBack}
        />
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] w-full flex-col p-4">
      <SkillsListView onSelectSkill={handleSelectSkill} onCreateNew={() => setView({ kind: 'create' })} />
    </div>
  )
}
