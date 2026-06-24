import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Bot,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Server,
  Sparkles,
  Users
} from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger
} from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/auth/useAuth'
import { useConfig } from '@/hooks/useConfig'

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/llm', label: 'LLM', icon: Bot, end: false },
  { to: '/mcp', label: 'MCP Servers', icon: Server, end: false },
  { to: '/skills', label: 'Skills', icon: Sparkles, end: false },
  { to: '/system-prompts', label: 'System Prompts', icon: MessageSquare, end: false },
  { to: '/users', label: 'Users', icon: Users, end: false }
] as const

export function AppLayout(): React.JSX.Element {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  function isActive(to: string, end: boolean): boolean {
    return end ? pathname === to : pathname === to || pathname.startsWith(`${to}/`)
  }

  function handleLogout(): void {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="flex h-12 items-center gap-2.5 px-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary font-serif text-lg leading-none text-primary-foreground">
              F
            </span>
            <span className="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden">
              <span className="truncate text-sm font-semibold leading-tight tracking-tight">
                Flairy
              </span>
              <span className="eyebrow">Admin</span>
            </span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel className="eyebrow px-2 group-data-[collapsible=icon]:hidden">
              Configuration
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map(({ to, label, icon: Icon, end }) => (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton
                      render={<NavLink to={to} end={end} />}
                      isActive={isActive(to, end)}
                      tooltip={label}
                    >
                      <Icon className="size-4" />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          {user && (
            <div className="mb-1 px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
              <div className="truncate font-medium text-foreground">{user.displayName}</div>
              <div className="truncate">{user.email}</div>
            </div>
          )}
          <Button
            variant="ghost"
            className="w-full justify-start group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
            onClick={handleLogout}
          >
            <LogOut className="size-4" />
            <span className="group-data-[collapsible=icon]:hidden">Sign out</span>
          </Button>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger />
          <div className="ml-auto">
            <ConfigVersionStamp />
          </div>
        </header>
        {/* Most pages are a comfortable centered column; the skills workspace is a
            full-bleed two-pane editor that needs the whole width and height. */}
        {pathname.startsWith('/skills') ? (
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Outlet />
          </main>
        ) : (
          <main className="flex-1 overflow-auto">
            <div className="mx-auto max-w-4xl px-8 py-8">
              <Outlet />
            </div>
          </main>
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}

/**
 * The admin's signature element. Every change here publishes a new config
 * version to every connected client; this stamp is the single number that says
 * "this is what they're all running right now." Monospaced, with a live dot.
 */
function ConfigVersionStamp(): React.JSX.Element | null {
  const { config, loading } = useConfig()

  if (loading || !config) return null

  return (
    <div
      className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1 hairline"
      title="Configuration version delivered to every connected client"
    >
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-foreground opacity-40" />
        <span className="relative inline-flex size-1.5 rounded-full bg-foreground/70" />
      </span>
      <span className="eyebrow">Live</span>
      <span className="version-stamp text-foreground">v{config.version}</span>
    </div>
  )
}
