import React from 'react'
import ReactDOM from 'react-dom/client'
import { ImageViewer } from './components/ImageViewer'
import { followSystemTheme } from './lib/theme'
import './assets/globals.css'

followSystemTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ImageViewer />
  </React.StrictMode>
)
