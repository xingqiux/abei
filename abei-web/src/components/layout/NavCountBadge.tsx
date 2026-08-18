/**
 * 导航里的数字徽标（侧栏、底部 tab、「我的」sheet 共用一个）。
 *
 * 中性底、中性字。收件箱里躺着 319 条不是坏事，把它印成红的只会让人
 * 每天开机先看见一片红，看几天就免疫了，真出事时反而没人注意。
 * 只有存在待解锁或解析失败的邮件时右上角多一颗 6px 红点——数字本身仍然不变色。
 */
export function NavCountBadge({
  count,
  hasDanger,
  compact = false,
}: {
  count: string
  hasDanger: boolean
  /** 底部 tab 用：压在图标角上，字更小 */
  compact?: boolean
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <span
        className={`num inline-flex items-center justify-center rounded-full bg-[var(--surface-selected)] font-medium text-[var(--text-secondary)] ${
          compact ? 'min-w-4 px-1 py-px text-[10px] leading-none' : 'min-w-5 px-1.5 py-0.5 text-xs'
        }`}
      >
        {count}
        {/* 光念一个「319」听不出是什么，补个单位 */}
        <span className="sr-only"> 条待处理</span>
      </span>
      {hasDanger && (
        <>
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-[var(--danger)] ring-1 ring-[var(--surface-1)]"
          />
          {/* 红点是纯视觉的，读屏什么也听不到。补一句话，否则这个提醒只对看得见的人存在 */}
          <span className="sr-only">其中有待解锁或解析失败的邮件</span>
        </>
      )}
    </span>
  )
}
