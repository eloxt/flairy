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
    <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
      {message}
    </div>
  )
}
