/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 仅开发期兜底：生产由 TokenGate 写入 sessionStorage，不再构建期注入 token。 */
  readonly VITE_FIREFLY_TOKEN?: string
  /**
   * abei-api 的地址。留空即同源 `/`（生产由 nginx 反代）。
   * 开发期要直连时写 `http://127.0.0.1:18002`；不写则走 vite 的 /v1 代理。
   */
  readonly VITE_ABEI_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
