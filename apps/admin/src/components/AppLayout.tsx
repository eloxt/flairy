import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Bot, LayoutDashboard, LogOut, MessageSquare, Server, Sparkles } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
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

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/llm', label: 'LLM', icon: Bot, end: false },
  { to: '/mcp', label: 'MCP Servers', icon: Server, end: false },
  { to: '/skills', label: 'Skills', icon: Sparkles, end: false },
  { to: '/system-prompts', label: 'System Prompts', icon: MessageSquare, end: false }
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
          <div className="flex h-10 items-center px-2">
            <span className="truncate text-base font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
              Flairy Admin
            </span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
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
        </header>
        <main className="flex-1 overflow-auto">
          <div className="mx-auto max-w-4xl px-8 py-8">
            <Outlet />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
