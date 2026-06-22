import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import monacoEditorPlugin from 'vite-plugin-monaco-editor'

// The plugin ships as CJS; under ESM the callable can land on `.default`.
const monaco = (
  (monacoEditorPlugin as unknown as { default?: typeof monacoEditorPlugin }).default ??
  monacoEditorPlugin
) as typeof monacoEditorPlugin

export default defineConfig({
  // Relative base so the SPA + Monaco worker assets resolve when statically served.
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    monaco({
      // SKILL.md (markdown) and extra-frontmatter (json) editors need these workers.
      languageWorkers: ['editorWorkerService', 'json']
    })
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  server: { port: 5174 }
})
