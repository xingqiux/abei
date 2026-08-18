import * as copy from './copy'

/**
 * 两笔并排比。「疑似同一笔」的成对卡和「疑似重复」的行内对比共用它。
 *
 * 之前这两处都只有一句话——「疑似和另一笔重复」「和已有交易很像」——像在哪儿
 * 一个字都没说。用户要判断的正是「像不像」，而判断依据一条都没给。
 *
 * 排法上有一条规矩：两边一样的字段只写一遍，不一样的才分两栏并高亮。
 * 十项里九项相同的两笔，逐项列两遍等于让人自己做一次 diff。
 */

export interface CompareField {
  label: string
  left: string
  right: string
}

export function CompareTable({
  leftLabel,
  rightLabel,
  fields,
  mergeSame = true,
}: {
  leftLabel: string
  rightLabel: string
  fields: CompareField[]
  /** false = 一律两栏并排（判重那边两笔本来就不是一件事，合并反而误导） */
  mergeSame?: boolean
}) {
  const same = mergeSame ? fields.filter((field) => field.left === field.right) : []
  const diff = mergeSame ? fields.filter((field) => field.left !== field.right) : fields

  return (
    <div className="flex flex-col gap-2">
      {same.length > 0 && (
        <dl className="flex flex-wrap items-baseline justify-center gap-x-4 gap-y-1 rounded-md bg-[var(--surface-2)] px-3 py-2">
          {same.map((field) => (
            <div key={field.label} className="flex items-baseline gap-1.5">
              <dt className="text-[11px] text-[var(--text-tertiary)]">{field.label}</dt>
              <dd className="num text-[13px] font-semibold text-[var(--text-primary)]">
                {field.left || copy.FIELD_EMPTY}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {diff.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <SideColumn label={leftLabel} fields={diff} pick={(field) => field.left} />
          <SideColumn label={rightLabel} fields={diff} pick={(field) => field.right} />
        </div>
      )}
    </div>
  )
}

function SideColumn({
  label,
  fields,
  pick,
}: {
  label: string
  fields: CompareField[]
  pick: (field: CompareField) => string
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] p-2">
      <p className="text-[11px] font-semibold text-[var(--text-secondary)]">{label}</p>
      <dl className="flex flex-col gap-0.5">
        {fields.map((field) => (
          <div key={field.label} className="flex gap-2">
            <dt className="w-[44px] shrink-0 text-[11px] text-[var(--text-tertiary)]">{field.label}</dt>
            {/* 不一样的那几项才进这一栏，所以整栏都上浅底：眼睛落下去就是差异 */}
            <dd className="min-w-0 flex-1 truncate">
              <span className="num rounded-[3px] bg-[var(--attention-soft)] px-1 text-[12px] text-[var(--text-primary)]">
                {pick(field) || copy.FIELD_EMPTY}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
