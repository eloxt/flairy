import { Loader2 } from 'lucide-react'

export function PageLoading(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Loading…
    </div>
  )
}

export function PageError({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      <span className="eyebrow mt-0.5 shrink-0 text-destructive/70">Error</span>
      <span className="text-foreground">{message}</span>
    </div>
  )
}
