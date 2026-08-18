import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import type { ComponentType } from 'react'
import { ChatTeardropText, EnvelopeOpen, FileMagnifyingGlass, FlowArrow, SignOut } from '@phosphor-icons/react'
import { AbeiMark } from '../abei/AbeiMark'
import { ToastContainer } from '../abei/Toast'
import { clearStoredToken } from '../../api/client'
import { REQUEST_TOKEN_EVENT } from '../tokenEvents'
import { warnMissingWebUrl, webUrl } from '../../lib/webUrl'

/**
 * 后台的壳：左侧窄导航 + 顶栏 + 撑满视口的内容区。
 *
 * 后台只有四个页面，都是宽表格 + 详情面板，用桌面浏览器开着一整天。所以：
 *
 * 1）导航搬到左边一条窄栏。原来挤在顶栏里和「去前台 / 退出」抢同一行，
 *    页面标题只好自己再印一遍，等于同一件事说两遍；竖排之后每一项有自己的一行，
 *    active 态也看得出来，顶栏只留账号相关的两个出口。
 * 2）整个壳按 dvh 撑满，内容区是 `flex-1 min-h-0`，滚动发生在各页面自己的面板里。
 *    此前二十多处 `min-h-[620px]` / `max-h-[720px]` 就是在替这件事打补丁：
 *    写死的高度在 13 寸笔记本上超出一屏（整页出现第二根滚动条，左右两栏各滚各的），
 *    在 27 寸屏上又空出一大片。高度该由视口给，不由字面量给。
 */
const NAV: { label: string; to: string; icon: ComponentType<{ className?: string }> }[] = [
  { label: '邮件', to: '/mail', icon: EnvelopeOpen },
  { label: '账单文档', to: '/documents', icon: FileMagnifyingGlass },
  { label: '解析器', to: '/parser', icon: FlowArrow },
  { label: '反馈', to: '/feedback', icon: ChatTeardropText },
]

export function AdminShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const frontendUrl = webUrl()
  if (!frontendUrl) warnMissingWebUrl()

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-[var(--surface-0)]">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-[var(--border-subtle)] bg-[var(--surface-1)] px-4">
        <Link to="/mail" className="flex items-center gap-2" aria-label="阿贝后台首页">
          <AbeiMark size={20} />
          <span className="text-[13px] font-semibold text-[var(--text-primary)]">阿贝后台</span>
        </Link>

        <div className="ml-auto flex items-center gap-2">
          {frontendUrl && (
            <a
              href={frontendUrl}
              className="text-[12.5px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            >
              去前台
            </a>
          )}
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

      <div className="flex min-h-0 flex-1">
        {/*
          窄屏（外接屏拔掉、笔记本竖着用）把导航收成一条图标栏：文字标签藏起来，
          图标和 aria-label 留着，读屏和键盘都还认得出来。
        */}
        <nav
          aria-label="主导航"
          className="flex w-12 shrink-0 flex-col gap-1 border-r border-[var(--border-subtle)] bg-[var(--surface-1)] p-1.5 lg:w-40 lg:p-2"
        >
          {NAV.map(({ label, to, icon: Icon }) => {
            const active = pathname === to || pathname.startsWith(`${to}/`)
            return (
              <Link
                key={to}
                to={to}
                aria-current={active ? 'page' : undefined}
                title={label}
                className={[
                  'flex items-center justify-center gap-2 rounded-md px-2 py-2 text-[13px] transition-colors lg:justify-start lg:px-2.5',
                  active
                    ? 'bg-[var(--surface-2)] font-semibold text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
                ].join(' ')}
              >
                <Icon className="size-4 shrink-0" />
                <span className="hidden lg:inline">{label}</span>
              </Link>
            )
          })}
        </nav>

        {/*
          内容区自己滚。`min-h-0` 不能省：flex 子项的默认最小高度是内容高度，
          少了它 `flex-1` 撑不住，长表格会把整个壳顶开，顶栏和左栏跟着滚出视口。
        */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4">
          <Outlet />
        </main>
      </div>

      <ToastContainer />
    </div>
  )
}
