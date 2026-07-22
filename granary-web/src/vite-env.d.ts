/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 仅开发期兜底：生产由 TokenGate 写入 sessionStorage，不再构建期注入 token。 */
  readonly VITE_FIREFLY_TOKEN?: string
  /** 旧版 Firefly 界面地址（设置页兜底链接），生产构建可注入，缺省 http://127.0.0.1:8001 */
  readonly VITE_LEGACY_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
