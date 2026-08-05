import './i18n'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { followSystemTheme } from './lib/theme'
import './assets/globals.css'

followSystemTheme()

// The main window sits on a translucent native backing behind the side rails
// (macOS transparent window / Windows 11 acrylic — see main's
// windowMaterialOptions). Tag <html> so the rails go translucent and the body
// turns transparent to reveal it; unsupported platforms keep opaque rails.
if (window.api.translucent) {
  document.documentElement.classList.add('vibrancy')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
