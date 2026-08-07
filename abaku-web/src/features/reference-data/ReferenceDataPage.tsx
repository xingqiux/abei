import { Card, SectionHeading } from '../../components/ui/Card'
import { ReferenceDataPanel } from '../settings/ReferenceDataPanel'

export function ReferenceDataPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">分类与标签</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          整理记账时使用的分类和标签；归档不会影响已有交易。
        </p>
      </div>
      <Card>
        <SectionHeading title="记账资料" className="mb-4" />
        <ReferenceDataPanel />
      </Card>
    </div>
  )
}
