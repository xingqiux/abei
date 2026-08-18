import { Link } from '@tanstack/react-router'
import { ArrowsLeftRight } from '@phosphor-icons/react'
import { useBillChannelAccounts, useConfirmBillChannelAccount } from '../../api/queries'
import { AbeiApiError } from '../../api/client'
import { Button, buttonClass } from '../../components/ui/Button'
import { showToast } from '../../store/toastStore'

/**
 * 「你已经有这个账户了，新账单记进它吗？」
 *
 * 收件箱不再要人先去配账户：渠道没有账户时系统自己建一个同名的。只有一种情况
 * 系统不敢替人做主——Firefly 里已经存在一个同名账户。那个账户可能已经记了半年账，
 * 猜错了就是把两条账混进一本。所以只有这一种情况会冒出这条横幅，点一次以后不再问。
 */
export function ChannelAccountBanner() {
  const query = useBillChannelAccounts()
  const confirm = useConfirmBillChannelAccount()
  const pending = query.data?.data ?? []

  // 加载中和加载失败都不占位置：这是一条例外情况的提示，
  // 为它在页头留一条骨架，等于让所有人替少数人腾地方。
  if (pending.length === 0) return null

  async function handleConfirm(id: string, accountName: string) {
    try {
      await confirm.mutateAsync(id)
      showToast({ kind: 'success', message: `新账单以后记进「${accountName}」` })
    } catch (error) {
      showToast({
        kind: 'error',
        message: error instanceof AbeiApiError ? error.message : '没能确认，请稍后重试',
      })
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {pending.map((entry) => {
        const accountName = entry.attributes.firefly_account_name || entry.attributes.channel_name
        return (
          <div
            key={entry.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-2)] px-3 py-2.5"
          >
            <ArrowsLeftRight aria-hidden className="size-4 text-[var(--attention-mark)]" />
            <span className="text-[12.5px] text-[var(--text-primary)]">
              发现你已有「{accountName}」账户，{entry.attributes.channel_name}的新账单要记进它吗？
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <Button
                variant="primary"
                size="xs"
                disabled={confirm.isPending}
                onClick={() => void handleConfirm(entry.id, accountName)}
              >
                记进它
              </Button>
              <Link to="/settings" className={buttonClass({ variant: 'ghost', size: 'xs' })}>
                换一个账户
              </Link>
            </span>
          </div>
        )
      })}
    </div>
  )
}
