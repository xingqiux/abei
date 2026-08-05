/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 仅开发期兜底：生产由 TokenGate 写入 sessionStorage，不再构建期注入 token。 */
  readonly VITE_FIREFLY_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
