/**
 * 后台 abei-admin 在另一个源上（本机 5175，部署默认 18006），所以只能给绝对地址。
 *
 * 端口不猜：没配 `VITE_ABEI_ADMIN_URL` 就返回 undefined，调用方把入口藏掉。
 * 猜错的代价是一个点了打不开的按钮，比没有按钮更糟——用户会以为是后台挂了。
 * 开发模式例外，`npm run dev` 的两个端口是约定死的。
 */
export function adminUrl(path: string): string | undefined {
  const configured = import.meta.env.VITE_ABEI_ADMIN_URL as string | undefined
  const base = configured || (import.meta.env.DEV ? 'http://127.0.0.1:5175' : undefined)
  if (!base) return undefined
  return new URL(path.replace(/^\/+/, ''), base.endsWith('/') ? base : `${base}/`).toString()
}
