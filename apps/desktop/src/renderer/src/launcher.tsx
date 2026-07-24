import './i18n'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { LauncherApp } from './components/launcher/LauncherApp'
import { followSystemTheme } from './lib/theme'
import './assets/globals.css'

followSystemTheme()

// Tag <html> so launcher-specific CSS applies (the message list's bottom
// spacer shrinks — the input sits below the thread, not floating over it).
document.documentElement.classList.add('launcher')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LauncherApp />
  </React.StrictMode>
)
