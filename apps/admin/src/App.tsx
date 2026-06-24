import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '@/auth/AuthProvider'
import { RequireAuth } from '@/auth/RequireAuth'
import { AppLayout } from '@/components/AppLayout'
import { LoginPage } from '@/pages/LoginPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { LlmPage } from '@/pages/LlmPage'
import { McpPage } from '@/pages/McpPage'
import { SkillsPage } from '@/pages/SkillsPage'
import { SystemPromptsPage } from '@/pages/SystemPromptsPage'
import { UsersPage } from '@/pages/UsersPage'

export default function App(): React.JSX.Element {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<DashboardPage />} />
            <Route path="/llm" element={<LlmPage />} />
            <Route path="/mcp" element={<McpPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/system-prompts" element={<SystemPromptsPage />} />
            <Route path="/users" element={<UsersPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
