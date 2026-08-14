import { useBillRowLinkDecision, useBillRowLinks } from '../../api/queries'
import type { BillRowLink } from '../../api/schemas'
import { AbeiApiError } from '../../api/client'
import { Button } from '../../components/ui/Button'
import { formatAmount } from '../../lib/format'
import { showToast } from '../../store/toastStore'
import { channelDisplayName } from './billInboxHelpers'

/**
 * 配对建议：同一笔钱被两个渠道各记了一遍（微信付款、银行卡扣款），或者一笔退款
 * 对着一笔原交易。
 *
 * 以前这只是一条挂在行上的黄色提醒，说「疑似和另一笔重复」，然后就没有然后了——
 * 看不到那一笔长什么样，也没法说「对，是同一笔」。这里把另一笔摆出来，给两个按钮。
 */

/** 一条建议凭什么成立。evidence 里是机器写的，翻成人话。 */
export function evidenceSentence(link: BillRowLink): string {
  const evidence = link.attributes.evidence ?? {}
  const matchedOn = Array.isArray(evidence.matched_on) ? evidence.matched_on : []
  const daysApart = typeof evidence.days_apart === 'number' ? evidence.days_apart : null
  const parts: string[] = ['金额一样']
  if (daysApart === 0) parts.push('同一天')
  else if (daysApart !== null) parts.push(`差 ${daysApart} 天`)
  if (matchedOn.includes('provider_transaction_id')) parts.push('交易号对得上')
  if (matchedOn.includes('merchant_order_id')) parts.push('商户订单号对得上')
  if (matchedOn.includes('counterparty')) parts.push('对手方一样')
  return parts.join('、')
}

function relationLabel(relation: string): string {
  return relation === 'refund_candidate' ? '可能是这笔的退款' : '可能和这笔是同一笔'
}

export function PairingSuggestions({ rowId }: { rowId: string }) {
  const links = useBillRowLinks(rowId)
  const decide = useBillRowLinkDecision()
  const data = links.data ?? []
  if (data.length === 0) return null

  async function run(link: BillRowLink, action: 'confirm' | 'reject' | 'undo') {
    try {
      await decide.mutateAsync({ linkId: link.id, action, keepRowId: action === 'confirm' ? rowId : undefined })
      showToast({
        kind: 'success',
        message: action === 'confirm' ? '已确认是同一笔' : action === 'reject' ? '已记下不是同一笔' : '已撤回',
      })
    } catch (error) {
      showToast({
        kind: 'error',
        message: error instanceof AbeiApiError ? error.message : '这一步没做成',
        duration: 6000,
      })
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-[11px] font-medium text-[var(--text-tertiary)]">另一笔</h4>
      {data.map((link) => {
        const other = link.attributes.related_row
        const confirmed = link.attributes.state === 'confirmed'
        return (
          <div
            key={link.id}
            className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-[var(--surface-1)] p-2"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[var(--text-primary)]">
                {relationLabel(link.attributes.relation)}：{channelDisplayName(other.channel_key ?? '')}
                {' · '}
                <span className="num">{formatAmount(other.signed_amount)}</span>
                {other.occurred_at ? ` · ${other.occurred_at.slice(0, 10)}` : ''}
              </span>
              <span className="text-[var(--text-secondary)]">
                {other.description || other.counterparty || '（没有摘要）'} · {evidenceSentence(link)}
              </span>
              {confirmed && (
                <span className="text-[var(--text-secondary)]">
                  已确认。{other.status === 'dismissed' ? '那一笔已经并进这一笔，不再单独入账。' : ''}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {confirmed ? (
                <Button size="xs" variant="ghost" disabled={decide.isPending} onClick={() => void run(link, 'undo')}>
                  撤回
                </Button>
              ) : (
                <>
                  <Button size="xs" variant="soft" disabled={decide.isPending} onClick={() => void run(link, 'confirm')}>
                    是同一笔
                  </Button>
                  <Button size="xs" variant="ghost" disabled={decide.isPending} onClick={() => void run(link, 'reject')}>
                    不是
                  </Button>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
