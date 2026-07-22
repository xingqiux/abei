import type { ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import {
  useAbout,
  useCategories,
  useCurrencies,
  useTags,
} from '../../api/queries'
import { CategoryChip } from '../../components/granary/CategoryChip'
import { Skeleton } from '../../components/granary/Skeleton'
import { requestTokenReset } from '../../components/tokenEvents'
import pkg from '../../../package.json'
import { AutomationPanel } from './AutomationPanel'
import { ExportPanel } from './ExportPanel'

const CHIP_LIMIT = 12

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

function SubGroup({ label, count, isLoading, isError, children }: { label: string; count?: number; isLoading: boolean; isError: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-1.5 text-[12.5px]" style={{ color: 'var(--g-ink)' }}>
        <span style={{ fontWeight: 'var(--g-weight-demibold)' }}>{label}</span>
        {typeof count === 'number' && (
          <span className="font-num" style={{ color: 'var(--g-ink-2)' }}>
            共 {count} 个
          </span>
        )}
      </div>
      {isLoading ? (
        <Skeleton className="h-6" />
      ) : isError ? (
        <div className="text-[12.5px]" style={{ color: 'var(--g-ink-2)' }}>
          加载失败
        </div>
      ) : (
        children
      )}
    </div>
  )
}

/** 名字 chip 列表：只展示前 CHIP_LIMIT 个，多的合并成一个 "+N" chip（设置页「分类与标签」「币种」共用）。 */
function NameChips({ names, total }: { names: string[]; total: number }) {
  if (total === 0) return <Empty />
  const shown = names.slice(0, CHIP_LIMIT)
  const rest = total - shown.length
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((name, i) => (
        <CategoryChip key={`${name}-${i}`} label={name} />
      ))}
      {rest > 0 && <CategoryChip label={`+${rest}`} />}
    </div>
  )
}

export function SettingsPage() {
  const categoriesQuery = useCategories()
  const tagsQuery = useTags()
  const currenciesQuery = useCurrencies()
  const aboutQuery = useAbout()

  const categories = categoriesQuery.data?.data ?? []
  const categoriesTotal = categoriesQuery.data?.meta?.pagination?.total ?? categories.length

  const tags = tagsQuery.data?.data ?? []
  const tagsTotal = tagsQuery.data?.meta?.pagination?.total ?? tags.length

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

      <Card title="分类与标签">
        <div className="flex flex-col gap-4">
          <SubGroup label="分类" count={categoriesTotal} isLoading={categoriesQuery.isLoading} isError={categoriesQuery.isError}>
            <NameChips names={categories.map((c) => c.attributes.name)} total={categoriesTotal} />
          </SubGroup>
          <SubGroup label="标签" count={tagsTotal} isLoading={tagsQuery.isLoading} isError={tagsQuery.isError}>
            <NameChips names={tags.map((t) => t.attributes.tag)} total={tagsTotal} />
          </SubGroup>
        </div>
      </Card>

      <Card title="自动化">
        <AutomationPanel />
      </Card>

      <Card title="CSV 导出"><ExportPanel /></Card>

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
              Firefly III 版本：
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

          <button
            type="button"
            onClick={requestTokenReset}
            className="w-fit rounded-[6px] px-2.5 py-1.5 text-[11.5px]"
            style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)', fontWeight: 'var(--g-weight-demibold)' }}
          >
            更换 API 令牌
          </button>
        </div>
      </Card>
    </div>
  )
}
