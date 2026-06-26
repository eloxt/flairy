import { useTranslation } from 'react-i18next'
import { useChat } from '@/store/chat-store'
import { Tabs, TabsList, TabsTab, TabsPanel } from '@/components/ui/tabs'
import { TimelinePanel } from './sidebar/TimelinePanel'
import { CostPanel } from './sidebar/CostPanel'

/**
 * The resizable right-hand details panel. Two tabs over the active (foreground)
 * session: a chronological Timeline and a Cost/spend summary. Both read from the
 * same `messages` mirror the main thread renders, so they stay in lockstep with
 * the conversation (live and on replay).
 */
export function RightSidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const messages = useChat((s) => s.messages)

  return (
    <Tabs defaultValue="timeline" className="h-full bg-transparent">
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
      </TabsList>
      <TabsPanel value="timeline">
        <TimelinePanel messages={messages} />
      </TabsPanel>
      <TabsPanel value="cost">
        <CostPanel messages={messages} />
      </TabsPanel>
    </Tabs>
  )
}
