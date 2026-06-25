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
        eyebrow="Control plane"
        title="Dashboard"
        description="Everything below is delivered to every connected client the moment you change it. No client-side setup required."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Link to="/llm" className="group">
          <Card className="hairline h-full transition-colors group-hover:bg-accent/50">
            <CardHeader>
              <CardDescription className="eyebrow flex items-center gap-1.5">
                <Bot className="size-3.5" />
                LLM
              </CardDescription>
              <CardTitle className="text-base">Main model</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="truncate font-mono text-sm font-medium">
                {mainModel?.model || '—'}
              </div>
              <div className="mt-0.5 font-mono text-xs lowercase text-muted-foreground">
                {mainProvider ? mainProvider.api : 'not set'}
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link to="/mcp" className="group">
          <Card className="hairline h-full transition-colors group-hover:bg-accent/50">
            <CardHeader>
              <CardDescription className="eyebrow flex items-center gap-1.5">
                <Server className="size-3.5" />
                MCP Servers
              </CardDescription>
              <CardTitle className="text-base">Tool providers</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="font-mono text-2xl font-semibold tracking-tight">
                {config.mcpServers.length}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                <span className="font-mono">{enabledMcp}</span> enabled
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link to="/skills" className="group">
          <Card className="hairline h-full transition-colors group-hover:bg-accent/50">
            <CardHeader>
              <CardDescription className="eyebrow flex items-center gap-1.5">
                <Sparkles className="size-3.5" />
                Skills
              </CardDescription>
              <CardTitle className="text-base">System-prompt presets</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="font-mono text-2xl font-semibold tracking-tight">
                {config.skills.length}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                <span className="font-mono">{enabledSkills}</span> enabled
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  )
}
