/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TIANDITU_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
