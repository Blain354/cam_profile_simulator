/// <reference types="vite/client" />

// Build data injected by vite.config.ts (see build-meta.ts).
declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string
declare const __APP_COMMIT_DATE__: string

interface ImportMetaEnv {
  readonly VITE_BLAIN_SHOWOFF?: string
}
