import { useMemo } from 'react'
import { useBillTasksByStatuses } from '../api/queries'
import { SOURCE_FALLBACK_LABELS } from '../features/bill-inbox/billInboxHelpers'

/**
 * 待解锁（needs_secret）的渠道名去重列表。
 * 原先写在今天页里，收件箱摘要卡也要用，抽出来共享。
 * 合并成渠道名而不是逐任务列出：一个渠道占一条横幅时，三个渠道就把首屏吃光了。
 */
export function useLockedChannels(): string[] {
  const secretResults = useBillTasksByStatuses(['needs_secret'], {})
  const secretTasks = useMemo(
    () => secretResults.flatMap((result) => result.data?.data ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [secretResults.map((result) => result.dataUpdatedAt).join(',')],
  )

  return useMemo(() => {
    const labels = new Set<string>()
    for (const task of secretTasks) {
      const source = task.attributes.source
      labels.add(SOURCE_FALLBACK_LABELS[source] ?? source)
    }
    return Array.from(labels)
  }, [secretTasks])
}
