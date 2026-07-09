/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREFLY_TOKEN: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
