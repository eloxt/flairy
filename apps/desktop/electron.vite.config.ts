import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      // One HTML entry per window. Each loads only its own tree, so the Settings
      // window doesn't ship the chat app's code and vice versa.
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          settings: resolve('src/renderer/settings.html'),
          'image-viewer': resolve('src/renderer/image-viewer.html')
        }
      }
    }
  }
})
