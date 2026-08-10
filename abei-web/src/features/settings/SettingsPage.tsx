import { useEffect, useState, type ComponentType } from 'react'
import {
  DownloadSimple,
  Info,
  Swatches,
  Terminal,
} from '@phosphor-icons/react'
import { useAbout } from '../../api/queries'
import pkg from '../../../package.json'
import { Card, SectionHeading } from '../../components/ui/Card'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { ExportPanel } from './ExportPanel'
import { ModelConnectionPanel } from './ModelConnectionPanel'
import { TokensPanel } from './TokensPanel'

type SettingsSection = 'connections' | 'appearance' | 'export' | 'about'

const SECTIONS: Array<{
  key: SettingsSection
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
}> = [
  {
    key: 'connections',
    label: '连接与授权',
    description: 'AI 服务与 abei CLI',
    icon: Terminal,
  },
  {
    key: 'appearance',
    label: '显示',
    description: '主题与列表密度',
    icon: Swatches,
  },
  {
    key: 'export',
    label: '数据导出',
    description: '下载账本副本',
    icon: DownloadSimple,
  },
  {
    key: 'about',
    label: '关于',
    description: '版本信息',
    icon: Info,
  },
]

export function SettingsPage() {
  const aboutQuery = useAbout()
  const [section, setSection] = useState<SettingsSection>('connections')
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => {
    const saved = localStorage.getItem('granary.theme')
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  })
  const [density, setDensity] = useState<'compact' | 'comfortable'>(() => {
    return localStorage.getItem('granary.density') === 'comfortable'
      ? 'comfortable'
      : 'compact'
  })

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

  const version = aboutQuery.isLoading
    ? '…'
    : aboutQuery.isError
      ? '获取失败'
      : (aboutQuery.data?.data.version ?? '暂无')

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">
          设置
        </h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          管理连接、显示偏好和数据导出。
        </p>
      </div>

      <div className="grid items-start gap-5 md:grid-cols-[190px_minmax(0,1fr)]">
        <nav
          aria-label="设置分类"
          className="flex gap-1 overflow-x-auto md:flex-col"
        >
          {SECTIONS.map((item) => {
            const Icon = item.icon
            const active = item.key === section
            return (
              <button
                key={item.key}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => setSection(item.key)}
                className={`flex min-w-[150px] items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors md:min-w-0 ${
                  active
                    ? 'bg-[var(--surface-selected)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Icon aria-hidden className="size-4.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">
                    {item.label}
                  </span>
                  <span className="hidden truncate text-[11px] text-[var(--text-tertiary)] md:block">
                    {item.description}
                  </span>
                </span>
              </button>
            )
          })}
        </nav>

        {section === 'connections' && (
          <Card>
            <SectionHeading
              title="连接与授权"
              description="查看财务助手状态，并管理命令行访问。"
              className="mb-5"
            />
            <ModelConnectionPanel />
            <TokensPanel />
          </Card>
        )}

        {section === 'appearance' && (
          <Card>
            <SectionHeading
              title="显示"
              description="偏好只保存在当前浏览器。"
              className="mb-6"
            />
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  主题
                </h3>
                <p className="mb-2 mt-0.5 text-xs text-[var(--text-secondary)]">
                  跟随系统会自动切换深浅色。
                </p>
                <SegmentedControl
                  aria-label="主题"
                  value={theme}
                  onChange={setTheme}
                  segments={[
                    { value: 'system', label: '系统' },
                    { value: 'light', label: '浅色' },
                    { value: 'dark', label: '深色' },
                  ]}
                />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  交易列表
                </h3>
                <p className="mb-2 mt-0.5 text-xs text-[var(--text-secondary)]">
                  调整每行信息的垂直空间。
                </p>
                <SegmentedControl
                  aria-label="交易列表密度"
                  value={density}
                  onChange={setDensity}
                  segments={[
                    { value: 'compact', label: '紧凑' },
                    { value: 'comfortable', label: '舒适' },
                  ]}
                />
              </div>
            </div>
          </Card>
        )}

        {section === 'export' && (
          <Card>
            <SectionHeading
              title="数据导出"
              description="从 Firefly 下载 CSV 账本副本。"
              className="mb-5"
            />
            <ExportPanel />
          </Card>
        )}

        {section === 'about' && (
          <Card>
            <SectionHeading title="关于阿贝" className="mb-5" />
            <dl className="divide-y divide-[var(--border-subtle)] text-sm">
              <div className="flex items-center justify-between gap-4 py-3 first:pt-0">
                <dt className="text-[var(--text-secondary)]">Firefly III</dt>
                <dd className="font-mono tabular-nums text-[var(--text-primary)]">
                  {version}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-3 last:pb-0">
                <dt className="text-[var(--text-secondary)]">阿贝 Web</dt>
                <dd className="font-mono tabular-nums text-[var(--text-primary)]">
                  {pkg.version}
                </dd>
              </div>
            </dl>
          </Card>
        )}
      </div>
    </div>
  )
}
