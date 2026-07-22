import type { ReactNode } from 'react'
import { ExternalLink, LogOut } from 'lucide-react'
import {
  useAbout,
  useCurrencies,
} from '../../api/queries'
import { Skeleton } from '../../components/granary/Skeleton'
import pkg from '../../../package.json'
import { ReferenceDataPanel } from './ReferenceDataPanel'
import { useGranarySession } from '../../components/GranarySession'

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[10px] p-3.5" style={{ background: 'var(--g-surface)', boxShadow: 'var(--g-shadow)' }}>
      <div
        className="mb-3 text-[12px]"
        style={{ color: 'var(--g-ink-2)', fontWeight: 'var(--g-weight-demibold)', letterSpacing: '.02em' }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

function Empty() {
  return (
    <div className="text-[12.5px]" style={{ color: 'var(--g-ink-2)' }}>
      暂无
    </div>
  )
}

export function SettingsPage() {
  const currenciesQuery = useCurrencies()
  const aboutQuery = useAbout()
  const { user, books, activeBook, selectBook, signOut } = useGranarySession()

  const currencies = [...(currenciesQuery.data?.data ?? [])].sort((a, b) => {
    const enabledDiff = Number(b.attributes.enabled ?? false) - Number(a.attributes.enabled ?? false)
    if (enabledDiff !== 0) return enabledDiff
    return a.attributes.code.localeCompare(b.attributes.code)
  })

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[18px]" style={{ fontWeight: 'var(--g-weight-demibold)', color: 'var(--g-ink)' }}>
        设置
      </h1>

      <div className="md:hidden">
        <Card title="当前会话">
          <div className="flex flex-col gap-3">
            <div className="text-[12px]" style={{ color: 'var(--g-ink-2)' }}>{user.display_name} · {user.email}</div>
            <label className="flex flex-col gap-1 text-[12px]" style={{ color: 'var(--g-ink-2)' }}>
              <span>当前账本</span>
              <select aria-label="当前账本" value={activeBook.id} onChange={(event) => void selectBook(Number(event.target.value))} className="rounded-[6px] px-2.5 py-2" style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)', border: '1px solid var(--g-border)' }}>
                {books.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => void signOut()} className="flex items-center justify-center gap-1.5 rounded-[6px] px-3 py-2 text-[12.5px]" style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}><LogOut size={14} aria-hidden />退出登录</button>
          </div>
        </Card>
      </div>

      <Card title="基础资料"><ReferenceDataPanel /></Card>

      <Card title="币种">
        {currenciesQuery.isLoading ? (
          <Skeleton className="h-6" />
        ) : currenciesQuery.isError ? (
          <div className="text-[12.5px]" style={{ color: 'var(--g-ink-2)' }}>
            加载失败
          </div>
        ) : currencies.length === 0 ? (
          <Empty />
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {currencies.map((c) => (
              <span
                key={c.id}
                className="inline-flex h-[18px] items-center gap-1 rounded-[4px] px-1.5 text-[11px]"
                style={{
                  background: c.attributes.default ? 'var(--g-accent)' : 'var(--g-surface-2)',
                  color: c.attributes.default ? 'var(--g-accent-ink)' : c.attributes.enabled ? 'var(--g-ink)' : 'var(--g-ink-2)',
                  fontWeight: c.attributes.default ? 'var(--g-weight-demibold)' : 'var(--g-weight-regular)',
                }}
              >
                {c.attributes.code}
                {c.attributes.default && ' · 默认'}
              </span>
            ))}
          </div>
        )}
      </Card>

      <Card title="关于">
        <div className="flex flex-col gap-2.5 text-[12.5px]" style={{ color: 'var(--g-ink)' }}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              Granary Server 版本：
              <span className="font-num" style={{ color: 'var(--g-ink-2)' }}>
                {aboutQuery.isLoading ? '…' : aboutQuery.isError ? '获取失败' : (aboutQuery.data?.data.version ?? '暂无')}
              </span>
            </span>
            <span>
              谷仓 Web 版本：
              <span className="font-num" style={{ color: 'var(--g-ink-2)' }}>{pkg.version}</span>
            </span>
          </div>

          <a
            href={import.meta.env.VITE_LEGACY_URL ?? 'http://127.0.0.1:8001'}
            target="_blank"
            rel="noreferrer"
            className="flex w-fit items-center gap-1.5"
            style={{ color: 'var(--g-accent)' }}
          >
            <ExternalLink aria-hidden size={13} color="currentColor" />
            旧版界面（过渡期兜底）
          </a>
        </div>
      </Card>
    </div>
  )
}
