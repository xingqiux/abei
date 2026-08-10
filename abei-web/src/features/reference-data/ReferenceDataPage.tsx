import { useState } from 'react'
import { Card, SectionHeading } from '../../components/ui/Card'
import { Tabs } from '../../components/ui/Tabs'
import { ReferenceDataPanel } from '../settings/ReferenceDataPanel'
import { CategoryManager } from './CategoryManager'

type Half = 'category' | 'tag'

/**
 * 分类与标签。两半各管各的：
 * 分类是按域分三段的两级树（词表产品自带，用户改名换图标禁用为主）；
 * 标签是一张平表。塞进同一个页面是因为它们都属于「记账前先备好的资料」。
 */
export function ReferenceDataPage() {
  const [half, setHalf] = useState<Half>('category')

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">分类与标签</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          内置一套分类，可改名、换图标或停用；AI 负责将交易归入分类。
        </p>
      </div>

      <Tabs
        aria-label="记账资料类型"
        value={half}
        onChange={setHalf}
        tabs={[
          { value: 'category', label: '分类' },
          { value: 'tag', label: '标签' },
        ]}
      />

      {half === 'category' ? (
        <CategoryManager />
      ) : (
        <Card>
          <SectionHeading title="标签" className="mb-4" />
          <ReferenceDataPanel />
        </Card>
      )}
    </div>
  )
}
