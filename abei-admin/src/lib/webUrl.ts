/**
 * 前台地址。
 *
 * 后台原先写死 `<a href="/">`。后台独立部署时 `/` 就是后台自己，router 又把 `/` 重定向到
 * `/mail`，点「去前台」等于原地打转。所以地址必须由部署方给。
 *
 * 开发期两边分端口跑，回退到 abei-web 的 dev 端口是安全的猜测；
 * 生产环境没配就说明部署方没打算暴露前台入口，那就不显示这个链接——
 * 猜一个域名挂上去，点出去只会是 404。
 */
export function webUrl(): string | null {
  const configured = import.meta.env.VITE_ABEI_WEB_URL?.trim()
  if (configured) return configured
  if (import.meta.env.DEV) return 'http://localhost:5173'
  return null
}

let warned = false

/** 生产环境缺配置时在控制台留一句，部署的人才知道链接为什么不见了。 */
export function warnMissingWebUrl(): void {
  if (warned || import.meta.env.DEV) return
  warned = true
  console.warn('[abei-admin] 未配置 VITE_ABEI_WEB_URL，已隐藏「去前台」链接。')
}
