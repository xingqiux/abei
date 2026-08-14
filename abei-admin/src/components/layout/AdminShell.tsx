import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import type { ComponentType } from 'react'
import { ChatTeardropText, EnvelopeOpen, FlowArrow, SignOut } from '@phosphor-icons/react'
import { AbeiMark } from '../abei/AbeiMark'
import { ToastContainer } from '../abei/Toast'
import { clearStoredToken } from '../../api/client'
import { REQUEST_TOKEN_EVENT } from '../tokenEvents'

/**
 * 后台的壳。前台那套（侧栏 + 顶栏 + 移动端底部 tab + Cmd+K）在这里是负担：
 * 后台只有三个页面，都是宽表格 + 详情面板，用桌面浏览器开着一整天。
 * 所以只留一条顶部导航，把纵向空间全留给内容。
 */
const NAV: { label: string; to: string; icon: ComponentType<{ className?: string }> }[] = [
  { label: '邮件', to: '/mail', icon: EnvelopeOpen },
  { label: '解析器', to: '/parser', icon: FlowArrow },
  { label: '反馈', to: '/feedback', icon: ChatTeardropText },
]

export function AdminShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  return (
    <div className="flex min-h-dvh flex-col bg-[var(--surface-0)]">
      <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-4 border-b border-[var(--border-subtle)] bg-[var(--surface-1)] px-4">
        <Link to="/mail" className="flex items-center gap-2" aria-label="阿贝后台首页">
          <AbeiMark className="size-5" />
          <span className="text-[13px] font-semibold text-[var(--text-primary)]">阿贝后台</span>
        </Link>

        <nav className="flex items-center gap-1" aria-label="主导航">
          {NAV.map(({ label, to, icon: Icon }) => {
            const active = pathname === to || pathname.startsWith(`${to}/`)
            return (
              <Link
                key={to}
                to={to}
                aria-current={active ? 'page' : undefined}
                className={[
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
                  active
                    ? 'bg-[var(--surface-2)] font-semibold text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
                ].join(' ')}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <a
            href="/"
            className="text-[12.5px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            去前台
          </a>
          <button
            type="button"
            aria-label="退出登录"
            title="退出登录"
            onClick={() => {
              clearStoredToken()
              window.dispatchEvent(new CustomEvent(REQUEST_TOKEN_EVENT))
            }}
            className="rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
          >
            <SignOut className="size-4" />
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 p-4">
        <Outlet />
      </main>

      <ToastContainer />
    </div>
  )
}
