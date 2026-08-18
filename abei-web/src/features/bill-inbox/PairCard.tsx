import type { BillQueueRow, BillRowSide } from '../../api/schemas'
import { AbeiApiError } from '../../api/client'
import { useBillRowLinkDecision } from '../../api/queries'
import { Button } from '../../components/ui/Button'
import { formatAmount } from '../../lib/format'
import { showToast } from '../../store/toastStore'
import { CompareTable, type CompareField } from './CompareTable'
import {
  channelDisplayName,
  currencyPrefix,
  currencyPrefixOf,
  fundingAccount,
  rowAmount,
  rowChannelKey,
  rowDate,
  rowMerchant,
} from './billInboxHelpers'
import * as copy from './copy'
import { PlatformMark } from './PlatformMark'
import { BRAND_MARKS, type PlatformKey } from './brandMarks'

/**
 * 「疑似同一笔」的成对卡。
 *
 * 一对就是一张卡：相同的字段（对手方、金额）写在顶上一遍，不同的（渠道、日期、
 * 账户）分两栏并排。原来是两条独立行各挂一个「看这两笔」，同一个判断在屏幕上
 * 出现两遍，人还得先认出它俩是一对，然后在展开层里的子面板上做决定。
 *
 * 两个按钮说的是后果，不是操作名：合并之后只剩一条进账本，分开记则两条各自入账。
 */
export function PairCard({ left, right }: { left: BillQueueRow; right: BillQueueRow }) {
  const decide = useBillRowLinkDecision()
  const linkId = left.attributes.pair?.link_id ?? right.attributes.pair?.link_id ?? ''

  /**
   * 合并留哪一条：留资金账户已经认出来的那一条。
   * 两条都认得出（或都认不出）就留列表里靠前的那条，至少是确定的。
   */
  const keepRow = fundingAccount(right.attributes) && !fundingAccount(left.attributes) ? right : left

  const leftChannel = channelDisplayName(rowChannelKey(left))
  const rightChannel = channelDisplayName(rowChannelKey(right))
  const sameChannel = rowChannelKey(left) === rowChannelKey(right)

  const fields: CompareField[] = [
    { label: copy.FIELD_COUNTERPARTY, left: rowMerchant(left.attributes), right: rowMerchant(right.attributes) },
    { label: copy.FIELD_AMOUNT, left: money(left), right: money(right) },
    { label: copy.FIELD_CHANNEL, left: leftChannel, right: rightChannel },
    { label: copy.FIELD_DATE, left: rowDate(left.attributes) ?? '', right: rowDate(right.attributes) ?? '' },
    { label: copy.FIELD_ACCOUNT, left: fundingAccount(left.attributes), right: fundingAccount(right.attributes) },
  ]

  async function run(action: 'confirm' | 'reject') {
    if (!linkId) return
    try {
      await decide.mutateAsync({
        linkId,
        action,
        keepRowId: action === 'confirm' ? keepRow.id : undefined,
      })
      showToast({
        kind: 'success',
        message: action === 'confirm' ? copy.PAIR_CONFIRM_DONE : copy.PAIR_REJECT_DONE,
      })
    } catch (error) {
      showToast({
        kind: 'error',
        message: error instanceof AbeiApiError ? error.message : copy.PAIR_SAVE_FAILED,
        duration: 6000,
      })
    }
  }

  return (
    <article className="mx-2 my-1 flex flex-col gap-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <PairMark channelKey={rowChannelKey(left)} />
        {/* 同渠道的一对只画一个标：同一个图标并排两遍看着像渲染重了 */}
        {!sameChannel && <PairMark channelKey={rowChannelKey(right)} />}
        <span className="text-[12.5px] font-semibold text-[var(--text-primary)]">
          {copy.pairHead(leftChannel, rightChannel)}
        </span>
        <span className="text-[11px] text-[var(--text-tertiary)]">{whyPaired(left, right)}</span>
      </header>

      <CompareTable
        leftLabel={sameChannel ? copy.PAIR_COLUMN_FIRST : leftChannel}
        rightLabel={sameChannel ? copy.PAIR_COLUMN_SECOND : rightChannel}
        fields={fields}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="xs" variant="primary" disabled={decide.isPending} onClick={() => void run('confirm')}>
          {copy.PAIR_CONFIRM}
        </Button>
        <Button size="xs" variant="ghost" disabled={decide.isPending} onClick={() => void run('reject')}>
          {copy.PAIR_REJECT}
        </Button>
      </div>
    </article>
  )
}

/**
 * 行展开层里的配对面板。两种情形共用一个形状：
 *
 * 1）已合并（含系统自动合的）——把合并前的两条摆出来，给一个「拆开」。
 *    自动合并如果只在行上留一个「已合并」小签、点开什么都没有，用户既看不到
 *    被并掉的是哪一笔，也没有反悔的余地，只能默认系统没搞错。
 * 2）还是建议——对侧行不在这一屏里（已入账 / 已忽略 / 翻页翻掉了）的落单情形，
 *    成对卡摆不出来，就退回这里逐行做决定。
 */
export function RowPairPanel({ row }: { row: BillQueueRow }) {
  const decide = useBillRowLinkDecision()
  const pair = row.attributes.pair
  if (!pair?.link_id) return null

  const other = pair.other
  const hereChannel = channelDisplayName(rowChannelKey(row))
  const thereChannel = channelDisplayName(other.channel_key ?? '')
  const confirmed = pair.state === 'confirmed'

  const fields: CompareField[] = [
    { label: copy.FIELD_CHANNEL, left: hereChannel, right: thereChannel },
    { label: copy.FIELD_DATE, left: rowDate(row.attributes) ?? '', right: (other.occurred_at ?? '').slice(0, 10) },
    { label: copy.FIELD_AMOUNT, left: money(row), right: sideMoney(other) },
    {
      label: copy.FIELD_COUNTERPARTY,
      left: rowMerchant(row.attributes),
      right: other.counterparty || other.description || '',
    },
  ]

  async function run(action: 'confirm' | 'reject' | 'undo') {
    try {
      await decide.mutateAsync({
        linkId: pair!.link_id,
        action,
        keepRowId: action === 'confirm' ? row.id : undefined,
      })
      showToast({
        kind: 'success',
        message: action === 'confirm'
          ? copy.PAIR_CONFIRM_DONE
          : action === 'reject'
            ? copy.PAIR_REJECT_DONE
            : copy.PAIR_UNDO_DONE,
      })
    } catch (error) {
      showToast({
        kind: 'error',
        message: error instanceof AbeiApiError ? error.message : copy.PAIR_SAVE_FAILED,
        duration: 6000,
      })
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-md bg-[var(--surface-1)] p-2.5">
      <div className="flex flex-col gap-0.5">
        <h4 className="text-[12px] font-semibold text-[var(--text-primary)]">
          {confirmed ? copy.MERGED_PANEL_TITLE : copy.PAIR_DIFF_HEAD}
        </h4>
        {confirmed && (
          <p className="text-[11px] text-[var(--text-tertiary)]">
            {pair.decided_by === 'auto'
              ? copy.mergedAutoNote(hereChannel, thereChannel)
              : copy.mergedUserNote(hereChannel, thereChannel)}
          </p>
        )}
      </div>

      <CompareTable
        leftLabel={hereChannel}
        rightLabel={thereChannel}
        fields={fields}
        mergeSame={!confirmed}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {confirmed ? (
          <Button size="xs" variant="soft" disabled={decide.isPending} onClick={() => void run('undo')}>
            {copy.MERGED_SPLIT}
          </Button>
        ) : (
          <>
            <Button size="xs" variant="soft" disabled={decide.isPending} onClick={() => void run('confirm')}>
              {copy.PAIR_CONFIRM}
            </Button>
            <Button size="xs" variant="ghost" disabled={decide.isPending} onClick={() => void run('reject')}>
              {copy.PAIR_REJECT}
            </Button>
          </>
        )}
      </div>
    </section>
  )
}

function sideMoney(side: BillRowSide): string {
  const raw = side.signed_amount ?? '0'
  const value = Math.abs(Number(raw) || 0)
  return `${currencyPrefixOf(side.currency_code)}${formatAmount(String(value))}`
}

function PairMark({ channelKey }: { channelKey: string }) {
  const platform = (channelKey in BRAND_MARKS ? channelKey : 'other') as PlatformKey
  return <PlatformMark platform={platform} size={20} title="" />
}

function money(row: BillQueueRow): string {
  return `${currencyPrefix(row.attributes)}${formatAmount(rowAmount(row.attributes))}`
}

/**
 * 这一对凭什么被提出来。服务端的 evidence 挂在 link 上、要单独一趟请求才拿得到，
 * 而两条行本身就摆在眼前——同不同天、金额一不一样，当场就能算出来。
 */
export function whyPaired(left: BillQueueRow, right: BillQueueRow): string {
  const parts: string[] = []
  if (money(left) === money(right)) parts.push('金额一样')
  const a = rowDate(left.attributes)
  const b = rowDate(right.attributes)
  if (a && b) {
    const days = Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000)
    parts.push(days === 0 ? '同一天' : `差 ${days} 天`)
  }
  return parts.join('、')
}
