import './i18n'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { SettingsWindow } from './components/settings/SettingsWindow'
import { followSystemTheme } from './lib/theme'
import './assets/globals.css'

followSystemTheme()

// Same as the main window: tag <html> so the sidebar rail goes translucent over
// the native vibrancy material. macOS only — other platforms keep opaque rails.
if (window.api.platform === 'darwin') {
  document.documentElement.classList.add('vibrancy')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsWindow />
  </React.StrictMode>
)
