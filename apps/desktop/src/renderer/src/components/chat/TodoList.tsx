import { IconCircle, IconCircleCheck, IconLoader2 } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import type { TodoItem } from '@shared/todo'

/**
 * A plain checklist for the agent's plan. Pure presentation — the same component
 * renders inline in the thread (per `todo_write` call) and in the right sidebar's
 * Plan tab (the current plan). One in-progress item spins; completed items check
 * off and strike through; pending items sit quiet.
 */
export function TodoList({
  todos,
  className
}: {
  todos: TodoItem[]
  className?: string
}): React.JSX.Element {
  return (
    <ul className={cn('flex flex-col gap-1.5', className)}>
      {todos.map((t, i) => {
        const label = t.status === 'in_progress' && t.activeForm?.trim() ? t.activeForm : t.content
        return (
          <li key={i} className="flex items-start gap-2 text-sm leading-relaxed">
            {t.status === 'completed' ? (
              <IconCircleCheck className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
            ) : t.status === 'in_progress' ? (
              <IconLoader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-foreground" strokeWidth={2} />
            ) : (
              <IconCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/40" strokeWidth={2} />
            )}
            <span
              className={cn(
                'min-w-0',
                t.status === 'completed' && 'text-muted-foreground line-through',
                t.status === 'in_progress' && 'font-medium text-foreground',
                t.status === 'pending' && 'text-muted-foreground'
              )}
            >
              {label}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
