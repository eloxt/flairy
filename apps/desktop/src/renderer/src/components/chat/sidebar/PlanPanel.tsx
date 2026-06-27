import { useTranslation } from 'react-i18next'
import type { UiMessage } from '@/store/chat-store'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TodoList } from '../TodoList'

/**
 * The agent's current plan. `todo_write` rewrites the whole list each call, so
 * the current plan is simply the most recent todo-bearing message — found by
 * scanning from the end. Derived purely from the chat store's `messages` (the
 * same in-memory objects the thread renders), so it stays in lockstep live and
 * on replay, identically to the Timeline/Cost tabs.
 */
export function PlanPanel({ messages }: { messages: UiMessage[] }): React.JSX.Element {
  const { t } = useTranslation()

  let todos: UiMessage['todos']
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].todos?.length) {
      todos = messages[i].todos
      break
    }
  }

  if (!todos?.length) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        {t('panel.planEmpty')}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="px-3 py-3">
        <TodoList todos={todos} />
      </div>
    </ScrollArea>
  )
}
