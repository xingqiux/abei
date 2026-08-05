/** Bill.repeat_freq 枚举中文标签（校验规则见 firefly-iii StoreRequest：weekly/monthly/quarterly/half-year/yearly） */
export const REPEAT_FREQ_LABELS: Record<string, string> = {
  weekly: '每周',
  monthly: '每月',
  quarterly: '每季度',
  'half-year': '每半年',
  yearly: '每年',
}

export type BudgetsTab = 'budgets' | 'subscriptions'

export const BUDGETS_TAB_CONFIG: { key: BudgetsTab; label: string }[] = [
  { key: 'budgets', label: '预算' },
  { key: 'subscriptions', label: '订阅' },
]

/** "YYYY-MM-DDTHH:mm:ss+08:00" -> "YYYY-MM-DD"，只取日期部分展示 */
export function dateOnly(isoDateTime: string | null | undefined): string {
  return isoDateTime ? isoDateTime.slice(0, 10) : '—'
}
