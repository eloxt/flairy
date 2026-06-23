import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function SaveBar({
  saving,
  savedAt,
  onSave,
  disabled
}: {
  saving: boolean
  savedAt: number | null
  onSave: () => void
  disabled?: boolean
}): React.JSX.Element {
  const recentlySaved = savedAt !== null && Date.now() - savedAt < 4000
  return (
    <div className="mt-6 flex items-center gap-3 border-t border-border pt-4">
      <Button onClick={onSave} disabled={saving || disabled}>
        {saving && <Loader2 className="size-4 animate-spin" />}
        Save changes
      </Button>
      {recentlySaved && !saving && (
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground animate-rise-in">
          <Check className="size-4 text-foreground" />
          Published to all clients
        </span>
      )}
    </div>
  )
}
