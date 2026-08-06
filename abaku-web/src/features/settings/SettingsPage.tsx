import { useEffect, useState } from 'react'
import { useAbout } from '../../api/queries'
import pkg from '../../../package.json'
import { Card, SectionHeading } from '../../components/ui/Card'
import { Field, Select } from '../../components/ui/Field'
import { ExportPanel } from './ExportPanel'
import { ReferenceDataPanel } from './ReferenceDataPanel'
import { TokensPanel } from './TokensPanel'

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

  const version = aboutQuery.isLoading
    ? '…'
    : aboutQuery.isError
      ? '获取失败'
      : (aboutQuery.data?.data.version ?? '暂无')

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">设置</h1>

      <Card>
        <SectionHeading
          title="基础资料"
          description="分类和标签在记账时用于归类，归档后不再出现在选择列表里。"
          className="mb-4"
        />
        <ReferenceDataPanel />
      </Card>

      <Card>
        <SectionHeading title="外观" className="mb-4" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="主题" hint="跟随系统时会随系统深浅色切换">
            <Select
              value={theme}
              onChange={(e) => setTheme(e.target.value as 'system' | 'light' | 'dark')}
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </Select>
          </Field>
          <Field label="交易行高" hint="影响交易列表每行的高度">
            <Select
              value={density}
              onChange={(e) => setDensity(e.target.value as 'compact' | 'comfortable')}
            >
              <option value="compact">紧凑 40px</option>
              <option value="comfortable">舒适 48px</option>
            </Select>
          </Field>
        </div>
      </Card>

      <Card>
        <SectionHeading
          title="访问令牌"
          description="abaku-web 用令牌访问 Firefly，令牌只在签发时显示一次。"
          className="mb-4"
        />
        <TokensPanel />
      </Card>

      {/* 导出面板一直存在也有测试，但没有任何页面引到它——从设置页进得去才算做完 */}
      <Card>
        <SectionHeading
          title="导出 CSV"
          description="从 Firefly 直接下载 CSV，交易类型可以再限定日期范围和账户。"
          className="mb-4"
        />
        <ExportPanel />
      </Card>

      <Card>
        <SectionHeading title="关于" className="mb-4" />
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-4 sm:block">
            <dt className="text-[var(--text-secondary)]">Firefly 版本</dt>
            <dd className="font-mono tabular-nums text-[var(--text-primary)] sm:mt-0.5">
              {version}
            </dd>
          </div>
          <div className="flex justify-between gap-4 sm:block">
            <dt className="text-[var(--text-secondary)]">Abaku Web 版本</dt>
            <dd className="font-mono tabular-nums text-[var(--text-primary)] sm:mt-0.5">
              {pkg.version}
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  )
}
