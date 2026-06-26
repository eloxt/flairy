import './i18n'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { followSystemTheme } from './lib/theme'
import './assets/globals.css'

followSystemTheme()

// The main window uses a native macOS vibrancy material behind the side rails
// (set in createMainWindow). Tag <html> so the rails go translucent and the body
// turns transparent to reveal it. macOS only — other platforms keep opaque rails.
if (window.api.platform === 'darwin') {
  document.documentElement.classList.add('vibrancy')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
