import type { ReactNode } from 'react'
import {
  useAbout,
  useCurrencies,
} from '../../api/queries'
import { Skeleton } from '../../components/granary/Skeleton'
import pkg from '../../../package.json'
import { ReferenceDataPanel } from './ReferenceDataPanel'

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
              Firefly 版本：
              <span className="font-num" style={{ color: 'var(--g-ink-2)' }}>
                {aboutQuery.isLoading ? '…' : aboutQuery.isError ? '获取失败' : (aboutQuery.data?.data.version ?? '暂无')}
              </span>
            </span>
            <span>
              谷仓 Web 版本：
              <span className="font-num" style={{ color: 'var(--g-ink-2)' }}>{pkg.version}</span>
            </span>
          </div>
        </div>
      </Card>
    </div>
  )
}
