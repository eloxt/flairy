import { Link } from 'react-router-dom'
import { Bot, Server, Sparkles } from 'lucide-react'
import { useConfig } from '@/hooks/useConfig'
import { PageError, PageLoading } from '@/components/PageState'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function DashboardPage(): React.JSX.Element {
  const { config, loading, error } = useConfig()

  if (loading) return <PageLoading />
  if (error) return <PageError message={error} />
  if (!config) return <PageError message="No configuration available." />

  const enabledMcp = config.mcpServers.filter((s) => s.enabled).length
  const enabledSkills = config.skills.filter((s) => s.enabled).length
  const mainModelId = config.llmRoleAssignments.find((a) => a.role === 'main')?.modelId ?? null
  const mainModel = mainModelId
    ? (config.llmModels.find((m) => m.id === mainModelId) ?? null)
    : null
  const mainProvider = mainModel
    ? (config.llmProviders.find((p) => p.id === mainModel.providerId) ?? null)
    : null

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description={`Configuration version ${config.version}. This is what every connected client receives.`}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Link to="/llm">
          <Card className="transition-colors hover:bg-muted/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Bot className="size-4" />
                LLM
              </CardTitle>
              <CardDescription>Main model</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-sm font-medium">{mainModel?.model || '—'}</div>
              <div className="text-xs capitalize text-muted-foreground">
                {mainProvider ? mainProvider.provider : 'not set'}
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link to="/mcp">
          <Card className="transition-colors hover:bg-muted/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Server className="size-4" />
                MCP Servers
              </CardTitle>
              <CardDescription>Tool providers</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{config.mcpServers.length}</div>
              <div className="text-xs text-muted-foreground">{enabledMcp} enabled</div>
            </CardContent>
          </Card>
        </Link>

        <Link to="/skills">
          <Card className="transition-colors hover:bg-muted/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="size-4" />
                Skills
              </CardTitle>
              <CardDescription>System-prompt presets</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{config.skills.length}</div>
              <div className="text-xs text-muted-foreground">{enabledSkills} enabled</div>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  )
}
