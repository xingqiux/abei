import { useQuery } from '@tanstack/react-query'
import { CheckCircle, Circle } from '@phosphor-icons/react'
import { getSession } from '../../api/feedback'
import { Button, buttonClass } from '../../components/ui/Button'
import { adminUrl } from '../../lib/adminUrl'

/**
 * 空收件箱的引导。
 *
 * 第一次进来这一页原来只有一句「没有待入账的流水」和一个「检查新邮件」按钮——
 * 邮箱还没连的人点它什么都不会发生，也没人告诉他下一步该干嘛。
 * 这里把三步摆出来，卡在哪一步就highlight哪一步。
 */

export type OnboardingStep = 'connect' | 'sync' | 'import'

/** 卡在第几步：邮箱没连就是第一步，连了还没解析出东西就是第二步，其余是第三步。 */
export function blockingStep(state: {
  mailboxReady: boolean
  hasRows: boolean
  hasImported: boolean
}): OnboardingStep {
  if (!state.mailboxReady) return 'connect'
  if (!state.hasRows) return 'sync'
  if (!state.hasImported) return 'import'
  return 'import'
}

const STEPS: { key: OnboardingStep; title: string; hint: string }[] = [
  { key: 'connect', title: '连邮箱', hint: '在右上角「邮箱设置」里填收件箱，账单邮件从那里取。' },
  { key: 'sync', title: '等同步', hint: '同步会把账单邮件收下来解析成一条条流水，第一次可能要几分钟。' },
  { key: 'import', title: '确认入账', hint: '核对金额和账户，确认没问题就入账，交易进 Firefly。' },
]

export function InboxOnboardingCard({
  mailboxReady,
  hasRows,
  hasImported,
  syncing,
  onConnect,
  onSync,
}: {
  mailboxReady: boolean
  hasRows: boolean
  hasImported: boolean
  syncing: boolean
  onConnect: () => void
  onSync: () => void
}) {
  const sessionQuery = useQuery({ queryKey: ['session'], queryFn: getSession, staleTime: 5 * 60_000 })
  const current = blockingStep({ mailboxReady, hasRows, hasImported })
  const done: Record<OnboardingStep, boolean> = {
    connect: mailboxReady,
    sync: hasRows,
    import: hasImported,
  }
  const parserHref = adminUrl('/parser')

  return (
    <div className="flex flex-col gap-3 px-4 py-6">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">三步就能开始记账</h3>

      <ol className="flex flex-col gap-2">
        {STEPS.map((step, index) => {
          const active = step.key === current
          return (
            <li key={step.key} className="flex items-start gap-2">
              {done[step.key] ? (
                <CheckCircle aria-hidden weight="fill" className="mt-0.5 size-4 shrink-0 text-[var(--done)]" />
              ) : (
                <Circle aria-hidden className={`mt-0.5 size-4 shrink-0 ${active ? 'text-[var(--brand-text)]' : 'text-[var(--text-tertiary)]'}`} />
              )}
              <div className="min-w-0">
                <span className={`text-[13px] ${active ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                  {index + 1}. {step.title}
                </span>
                {active && <p className="text-xs text-[var(--text-secondary)]">{step.hint}</p>}
              </div>
            </li>
          )
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        {current === 'connect' ? (
          <Button variant="primary" size="sm" onClick={onConnect}>
            去连邮箱
          </Button>
        ) : (
          <Button variant="primary" size="sm" disabled={syncing} onClick={onSync}>
            {syncing ? '正在检查新邮件…' : '立即同步'}
          </Button>
        )}
      </div>

      <p className="text-xs text-[var(--text-secondary)]">
        自带招商银行、支付宝、微信、中国银行四家的解析规则。别家的账单邮件收得到，但要先写解析规则才认得出来。
        {sessionQuery.data?.data.is_owner && parserHref && (
          <>
            {' '}
            <a href={parserHref} className={buttonClass({ variant: 'ghost', size: 'xs' })}>
              去后台配规则
            </a>
          </>
        )}
      </p>
    </div>
  )
}
