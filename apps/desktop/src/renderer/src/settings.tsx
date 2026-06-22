import './i18n'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { SettingsWindow } from './components/settings/SettingsWindow'
import { followSystemTheme } from './lib/theme'
import './assets/globals.css'

followSystemTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsWindow />
  </React.StrictMode>
)
