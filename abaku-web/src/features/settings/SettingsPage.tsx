import { useEffect, useState, type ReactNode } from 'react'
import { useAbout } from '../../api/queries'
import pkg from '../../../package.json'
import { ReferenceDataPanel } from './ReferenceDataPanel'
import { TokensPanel } from './TokensPanel'

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[10px] p-3.5 bg-[var(--surface-1)]  shadow-sm">
      <div
        className="mb-3 text-[12px] text-[var(--text-secondary)]  font-semibold"
        style={{ letterSpacing: '.02em' }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

export function SettingsPage() {
  const aboutQuery = useAbout()
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => {
    const saved = localStorage.getItem('granary.theme')
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  })
  const [density, setDensity] = useState<'compact' | 'comfortable'>(() => {
    return localStorage.getItem('granary.density') === 'comfortable' ? 'comfortable' : 'compact'
  })

  // 存储键沿用 granary.* 前缀（同 date-range）：主题/密度与日期范围一起迁，不是漏改。
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
    localStorage.setItem('granary.theme', theme)
  }, [theme])

  useEffect(() => {
    const root = document.documentElement
    if (density === 'comfortable') root.dataset.density = 'comfortable'
    else delete root.dataset.density
    localStorage.setItem('granary.density', density)
  }, [density])

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[18px] font-semibold text-[var(--text-primary)] ">
        设置
      </h1>

      <Card title="基础资料"><ReferenceDataPanel /></Card>

      <Card title="外观">
        <div className="flex flex-col gap-3 text-[12.5px] text-[var(--text-primary)] ">
          <label className="flex items-center justify-between gap-3">
            <span>主题</span>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value as 'system' | 'light' | 'dark')}
              className="rounded-md bg-[var(--surface-hover)] px-2 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none"
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>交易行高</span>
            <select
              value={density}
              onChange={(e) => setDensity(e.target.value as 'compact' | 'comfortable')}
              className="rounded-md bg-[var(--surface-hover)] px-2 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none"
            >
              <option value="compact">紧凑 40px</option>
              <option value="comfortable">舒适 48px</option>
            </select>
          </label>
        </div>
      </Card>

      <Card title="访问令牌">
        <TokensPanel />
      </Card>

      <Card title="关于">
        <div className="flex flex-col gap-2.5 text-[12.5px] text-[var(--text-primary)] ">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              Firefly 版本：
              <span className="font-mono tabular-nums text-[var(--text-secondary)] ">
                {aboutQuery.isLoading ? '…' : aboutQuery.isError ? '获取失败' : (aboutQuery.data?.data.version ?? '暂无')}
              </span>
            </span>
            <span>
              Abaku Web 版本：
              <span className="font-mono tabular-nums text-[var(--text-secondary)] ">{pkg.version}</span>
            </span>
          </div>
        </div>
      </Card>

    </div>
  )
}
