import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChat, selectProjectWorkspace } from '@/store/chat-store'
import { useUi } from '@/store/ui-store'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { ModelPanel } from './sidebar/ModelPanel'

// @pierre/trees + @pierre/diffs load only when a project session's Files tab
// actually mounts — chat sessions and closed panels never pay for them.
const FilesPanel = lazy(() =>
  import('./sidebar/FilesPanel').then((m) => ({ default: m.FilesPanel }))
)
const RunsPanel = lazy(() =>
  import('./sidebar/RunsPanel').then((m) => ({ default: m.RunsPanel }))
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
  const sessionId = useChat((s) => s.sessionId)

  const [tab, setTab] = useState('model')

  // The Files/Runs tabs unmount for chat (non-project) sessions; don't strand
  // the panel on an empty selection when switching to one.
  useEffect(() => {
    if (!workspacePath) setTab((cur) => (cur === 'files' || cur === 'runs' ? 'model' : cur))
  }, [workspacePath])

  // One-shot tab requests from elsewhere in the app (a dispatch card in the
  // chat asking for 'runs'); consume and clear.
  const requestedTab = useUi((s) => s.rightPanelTab)
  const clearRequestedTab = useUi((s) => s.clearRightPanelTab)
  useEffect(() => {
    if (!requestedTab) return
    if (requestedTab === 'model' || (workspacePath && (requestedTab === 'files' || requestedTab === 'runs'))) {
      setTab(requestedTab)
    }
    clearRequestedTab()
  }, [requestedTab, workspacePath, clearRequestedTab])

  return (
    <Tabs value={tab} onValueChange={setTab} className="h-full gap-0 bg-transparent">
      {/* The bar keeps the chat header's height (h-12) so the two columns'
          top rows line up, and stays draggable so the window can still be
          moved from the top-right; the segmented control itself must not be. */}
      <div className="app-drag flex h-12 shrink-0 items-center px-3">
        <TabsList className="app-no-drag">
          <TabsTrigger value="model" className="px-2.5">
            {t('panel.model')}
          </TabsTrigger>
          {workspacePath && (
            <TabsTrigger value="files" className="px-2.5">
              {t('panel.files')}
            </TabsTrigger>
          )}
          {workspacePath && sessionId && (
            <TabsTrigger value="runs" className="px-2.5">
              {t('panel.runs')}
            </TabsTrigger>
          )}
        </TabsList>
      </div>
      <TabsContent value="model" className="min-h-0">
        <ModelPanel messages={messages} />
      </TabsContent>
      {workspacePath && (
        <TabsContent value="files" className="min-h-0 min-w-0">
          {/* Keyed so switching between two project sessions resets tree + preview. */}
          <Suspense fallback={null}>
            <FilesPanel key={workspacePath} workspacePath={workspacePath} />
          </Suspense>
        </TabsContent>
      )}
      {workspacePath && sessionId && (
        <TabsContent value="runs" className="min-h-0 min-w-0">
          <Suspense fallback={null}>
            <RunsPanel key={sessionId} sessionId={sessionId} />
          </Suspense>
        </TabsContent>
      )}
    </Tabs>
  )
}
