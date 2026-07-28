import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChat, selectProjectWorkspace } from '@/store/chat-store'
import { Tabs, TabsList, TabsTab, TabsPanel } from '@/components/ui/tabs'
import { ModelPanel } from './sidebar/ModelPanel'

// @pierre/trees + @pierre/diffs load only when a project session's Files tab
// actually mounts — chat sessions and closed panels never pay for them.
const FilesPanel = lazy(() =>
  import('./sidebar/FilesPanel').then((m) => ({ default: m.FilesPanel }))
)

/**
 * The resizable right-hand details panel. Tabs over the active (foreground)
 * session: a Model info panel (identity + context + spend), and — for project
 * sessions — the workspace Files tree. All read from the same `messages`
 * mirror the main thread renders, so they stay in lockstep with the
 * conversation (live and on replay). (In-thread navigation lives on the
 * ConversationNav rail, and plan progress on the composer's docked card —
 * not here.)
 */
export function RightSidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const messages = useChat((s) => s.messages)
  const workspacePath = useChat(selectProjectWorkspace)

  const [tab, setTab] = useState('model')

  // The Files tab unmounts for chat (non-project) sessions; don't strand the
  // panel on an empty selection when switching to one.
  useEffect(() => {
    if (!workspacePath) setTab((cur) => (cur === 'files' ? 'model' : cur))
  }, [workspacePath])

  return (
    <Tabs value={tab} onValueChange={setTab} className="h-full bg-transparent">
      {/* The tab bar doubles as the panel's top bar: same height as the chat
          header (h-12) so the two columns' dividers line up, and draggable so
          the window can still be moved from the top-right. */}
      <TabsList className="app-drag h-12 px-3">
        <TabsTab value="model" className="app-no-drag">
          {t('panel.model')}
        </TabsTab>
        {workspacePath && (
          <TabsTab value="files" className="app-no-drag">
            {t('panel.files')}
          </TabsTab>
        )}
      </TabsList>
      <TabsPanel value="model">
        <ModelPanel messages={messages} />
      </TabsPanel>
      {workspacePath && (
        <TabsPanel value="files" className="min-w-0">
          {/* Keyed so switching between two project sessions resets tree + preview. */}
          <Suspense fallback={null}>
            <FilesPanel key={workspacePath} workspacePath={workspacePath} />
          </Suspense>
        </TabsPanel>
      )}
    </Tabs>
  )
}
