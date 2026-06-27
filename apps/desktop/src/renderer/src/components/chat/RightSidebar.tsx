import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChat } from '@/store/chat-store'
import { useUi } from '@/store/ui-store'
import { Tabs, TabsList, TabsTab, TabsPanel } from '@/components/ui/tabs'
import { TimelinePanel } from './sidebar/TimelinePanel'
import { CostPanel } from './sidebar/CostPanel'
import { PlanPanel } from './sidebar/PlanPanel'

/**
 * The resizable right-hand details panel. Tabs over the active (foreground)
 * session: a chronological Timeline, a Cost/spend summary, and — once the agent
 * has produced a plan — a Plan checklist. All read from the same `messages`
 * mirror the main thread renders, so they stay in lockstep with the conversation
 * (live and on replay).
 */
export function RightSidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const messages = useChat((s) => s.messages)
  const setRightPanelOpen = useUi((s) => s.setRightPanelOpen)

  // Identity of the current plan: the most recent todo-bearing message. Each
  // todo_write is a new message, so this id changes every time the plan is
  // created or updated — our "plan changed" signal.
  const latestTodoId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].todos?.length) return messages[i].id
    }
    return null
  }, [messages])
  const hasTodos = latestTodoId !== null

  // Controlled so we can surface the Plan tab when a plan is created/updated.
  const [tab, setTab] = useState('timeline')
  const lastPlanId = useRef<string | null>(null)
  useEffect(() => {
    if (!hasTodos) {
      lastPlanId.current = null
      // The Plan tab unmounts when a session has no plan; don't strand the panel
      // on an empty selection (e.g. after switching sessions).
      setTab((cur) => (cur === 'plan' ? 'timeline' : cur))
      return
    }
    if (latestTodoId === lastPlanId.current) return
    lastPlanId.current = latestTodoId
    // A plan was just created or updated: if the details panel is collapsed, open
    // it straight to the Plan tab. If it's already open on another tab, leave the
    // user where they are. Read the open flag imperatively so this fires on the
    // plan change, not when the user toggles the panel.
    if (!useUi.getState().rightPanelOpen) {
      setTab('plan')
      setRightPanelOpen(true)
    }
  }, [hasTodos, latestTodoId, setRightPanelOpen])

  return (
    <Tabs value={tab} onValueChange={setTab} className="h-full bg-transparent">
      {/* The tab bar doubles as the panel's top bar: same height as the chat
          header (h-12) so the two columns' dividers line up, and draggable so
          the window can still be moved from the top-right. */}
      <TabsList className="app-drag h-12 px-3">
        <TabsTab value="timeline" className="app-no-drag">
          {t('panel.timeline')}
        </TabsTab>
        <TabsTab value="cost" className="app-no-drag">
          {t('panel.cost')}
        </TabsTab>
        {hasTodos && (
          <TabsTab value="plan" className="app-no-drag">
            {t('panel.plan')}
          </TabsTab>
        )}
      </TabsList>
      <TabsPanel value="timeline">
        <TimelinePanel messages={messages} />
      </TabsPanel>
      <TabsPanel value="cost">
        <CostPanel messages={messages} />
      </TabsPanel>
      {hasTodos && (
        <TabsPanel value="plan">
          <PlanPanel messages={messages} />
        </TabsPanel>
      )}
    </Tabs>
  )
}
