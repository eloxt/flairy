/**
 * Renderer i18n runtime (react-i18next singleton).
 *
 * Imported for side effects as the FIRST import of each entry point
 * (`main.tsx`, `settings.tsx`) so the instance is ready before first paint.
 * Resources are inlined (not lazily loaded) and init is synchronous
 * (`initImmediate: false`), so the first `useTranslation()` already sees a ready
 * instance — no English→Chinese flash and no Suspense boundary required.
 *
 * The initial language is resolved synchronously by the main process
 * (saved setting, else system locale) via `window.api.getInitialLanguage()`.
 * Language changes broadcast from main reach every window through
 * `onLanguageChanged`.
 */
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en'
import zhCN from './locales/zh-CN'

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-CN': { translation: zhCN }
  },
  lng: window.api.getInitialLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  initImmediate: false, // synchronous init — resources are inlined
  react: { useSuspense: false }, // no Suspense boundary exists
  returnNull: false
})

// Live language switches from any window (main or settings) re-translate in place.
window.api.onLanguageChanged((lng) => {
  void i18n.changeLanguage(lng)
})

export default i18n
