import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BillQueueRow } from '../../api/schemas'
import { BillInboxPage } from './BillInboxPage'

/**
 * 收件箱页的两层信息架构：一级 tab、唯一主操作、旧链接兼容。
 *
 * 页面挂着二十来个查询 hook，全部走 mock；这里验的是布局与交互的规矩，
 * 不是数据层——数据层的用例在 api/queries.test.tsx 和 billInboxHelpers.test.ts 里。
 */

function row(id: string, overrides: Record<string, unknown> = {}): BillQueueRow {
  return {
    id,
    type: 'bill-statement-rows',
    attributes: {
      status: 'pending',
      duplicate_state: 'unique',
      firefly_type: 'withdrawal',
      firefly_date: '2026-08-10',
      firefly_amount: '12.50',
      firefly_description: `咖啡 ${id}`,
      source_name: '招商银行信用卡',
      destination_name: '星巴克',
      occurred_at: '2026-08-10T09:00:00',
      currency_code: 'CNY',
      currency_symbol: '¥',
      direction: '支出',
      amount: '12.50',
      counterparty: '星巴克',
      issues: [],
      reasons: [],
      bill_task_id: 1,
      ...overrides,
    },
  } as unknown as BillQueueRow
}

const mocks = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  importable: [] as unknown[],
  attention: [] as unknown[],
  done: [] as unknown[],
  counts: { importable: 0, attention: 0, dismissed: 0, imported: 0 } as Record<string, number>,
  imported: vi.fn(),
  undoImport: vi.fn(),
  toasts: [] as { message: string; action?: { label: string; onClick?: () => void } }[],
}))

/** toast 是这一页汇报结果的唯一出口，撤销那颗按钮就挂在上面，所以要看得见 */
vi.mock('../../store/toastStore', () => ({
  showToast: (toast: { message: string; action?: { label: string; onClick?: () => void } }) => {
    mocks.toasts.push(toast)
  },
}))

const { toasts, undoImport } = mocks

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children?: unknown }) => children,
}))

const idleMutation = { mutateAsync: vi.fn(async () => ({})), isPending: false }
const idleQuery = { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() }

function pagesOf(rows: unknown[]) {
  return rows.length === 0 ? undefined : { pages: [{ data: rows, meta: { pagination: { total: rows.length } } }] }
}

vi.mock('../../api/queries', () => ({
  BILL_ROWS_PAGE_SIZE: 50,
  invalidateBillInbox: vi.fn(),
  flattenBillRows: (pages: { data: unknown[]; meta?: { pagination?: { total?: number } } }[] | undefined) => ({
    rows: pages?.flatMap((page) => page.data) ?? [],
    total: pages?.[0]?.meta?.pagination?.total ?? 0,
  }),
  useBillRows: (group: string) => ({
    data: pagesOf(
      group === 'importable' ? mocks.importable : group === 'attention' ? mocks.attention : mocks.done,
    ),
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useBillRowCounts: () => ({
    total: mocks.counts,
    countFor: (group: string) => mocks.counts[group] ?? 0,
  }),
  useBillInboxSummary: () => ({ ...idleQuery, data: { channels: [], unclassified_mail: 0 } }),
  useBillInboxSettings: () => ({
    ...idleQuery,
    data: { data: { attributes: { email: 'a@b.c', has_password: true, google_connected: false } } },
  }),
  useBillTasks: () => ({ ...idleQuery, data: { data: [] } }),
  useBillProcessingSummary: () => ({
    ...idleQuery,
    data: {
      window_days: 7,
      mail: { runs: 1, failed_runs: 0 },
      parse: { total: 3, succeeded: 3, running: 0, waiting_input: 0, failed: 0, stuck: [] },
      rows: { produced: 9 },
    },
  }),
  useRetryParseJob: () => idleMutation,
  useBillRowLinkDecision: () => idleMutation,
  useSyncBillInbox: () => idleMutation,
  useDismissBillRows: () => idleMutation,
  useRestoreBillRows: () => idleMutation,
  useImportBillRows: () => ({ ...idleMutation, mutateAsync: mocks.imported }),
  useReconcileBillImportAttempt: () => idleMutation,
  useRetryBillImportAttempt: () => idleMutation,
  useUndoBillImport: () => ({ ...idleMutation, mutateAsync: mocks.undoImport }),
  useBillChannelAccounts: () => ({ ...idleQuery, data: { data: [] } }),
  useConfirmBillChannelAccount: () => idleMutation,
}))

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }))

/** 行本身有自己的用例；这里只要它把「能不能勾」如实渲染出来 */
vi.mock('./QueueRow', () => ({
  QueueRow: ({ row: r, selectable, onSelect }: {
    row: { id: string }
    selectable?: boolean
    onSelect?: (shift: boolean) => void
  }) => (
    <div data-testid={`row-${r.id}`}>
      {selectable && (
        <input type="checkbox" aria-label={`选择 ${r.id}`} onChange={() => onSelect?.(false)} />
      )}
    </div>
  ),
}))
vi.mock('./BillInboxSettingsDialog', () => ({ BillInboxSettingsDialog: () => null }))
vi.mock('./ImportConfirmDialog', () => ({ ImportConfirmDialog: () => null }))
vi.mock('./InboxOnboardingCard', () => ({ InboxOnboardingCard: () => <p>空箱引导</p> }))

beforeEach(() => {
  mocks.search = {}
  mocks.navigate.mockReset()
  mocks.imported.mockReset()
  mocks.imported.mockResolvedValue({ summary: { imported: 0, uncertain: 0, retryable: 0, failed: 0, skipped: 0 }, rows: [] })
  mocks.undoImport.mockReset()
  mocks.undoImport.mockResolvedValue({ data: { summary: { undone: 2, failed: 0 }, rows: [] } })
  mocks.toasts.length = 0
  mocks.importable = [row('1'), row('2'), row('3')]
  mocks.attention = [row('9', { issues: [{ code: 'duplicate_suspect' }], duplicate_state: 'duplicate' })]
  mocks.done = []
  mocks.counts = { importable: 3, attention: 1, dismissed: 2, imported: 5 }
})

describe('BillInboxPage 两层信息架构', () => {
  it('一级只有待处理 / 已完成两个 tab，计数是两组之和', () => {
    render(<BillInboxPage />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveTextContent('待处理')
    expect(tabs[0]).toHaveTextContent('4') // importable 3 + attention 1
    expect(tabs[1]).toHaveTextContent('已完成')
    expect(tabs[1]).toHaveTextContent('7') // imported 5 + dismissed 2
  })

  it('页头压成一行：同步 + 邮件处理入口，漏斗不在首屏', () => {
    render(<BillInboxPage />)
    expect(screen.queryByRole('button', { name: '对上账户' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '同步邮件' })).toBeInTheDocument()
    // 漏斗（账单邮件 N → 解析成功 N → 产出流水 N）整块搬去了二级页
    expect(screen.queryByText('产出流水')).not.toBeInTheDocument()
    expect(screen.queryByText('账单邮件')).not.toBeInTheDocument()
  })

  it('「疑似同一笔」按对渲染：两条同一 link 的行折成一张卡', () => {
    const pair = (id: string, other: string) => row(id, {
      attention_kind: 'pairing_suggested',
      task: { id: '1', source: 'cmb' },
      pair: {
        link_id: 'L1',
        state: 'suggested',
        other: { id: other, channel_key: 'alipay', signed_amount: '-12.50' },
      },
    })
    mocks.attention = [pair('20', '21'), pair('21', '20')]
    render(<BillInboxPage />)
    // 两条行没有各自渲染，取而代之的是一张卡上的一组按钮
    expect(screen.queryByTestId('row-20')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '是同一笔，合并保留一条' })).toHaveLength(1)
  })

  it('待处理层同屏渲染「待入账」和「待确认」两节', () => {
    render(<BillInboxPage />)
    expect(screen.getByRole('heading', { name: /待入账/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /待确认/ })).toBeInTheDocument()
  })

  it('主操作只有一个位置：无勾选时作用于整节，文案写明笔数', () => {
    render(<BillInboxPage />)
    const buttons = screen.getAllByRole('button', { name: /^入账 \d+ 笔$/ })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveTextContent('入账 3 笔')
  })

  it('勾选之后主按钮改为作用于勾选，文案实时跟着变，且仍然只有一个', async () => {
    const user = userEvent.setup()
    render(<BillInboxPage />)
    await user.click(screen.getByLabelText('选择 1'))

    const buttons = screen.getAllByRole('button', { name: /^入账 \d+ 笔$/ })
    // 宽屏节头一颗 + 窄屏浮条一颗，两者用断点互斥，同一时刻只有一颗可见
    expect(buttons.every((button) => button.textContent?.includes('入账 1 笔'))).toBe(true)
  })

  it('已完成层用子筛选切「已入账 / 已忽略」，不再是两个一级 tab', async () => {
    const user = userEvent.setup()
    mocks.search = { tab: 'done' }
    render(<BillInboxPage />)

    expect(screen.queryByRole('heading', { name: /待入账/ })).not.toBeInTheDocument()
    const group = screen.getByRole('radiogroup', { name: '已完成的两类' })
    expect(group).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: '已忽略' }))
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ tab: 'done', done: 'dismissed' }) }),
    )
  })

  it('点一级 tab 写进 search：待处理是默认值，不写进 URL', async () => {
    const user = userEvent.setup()
    mocks.search = { tab: 'done' }
    render(<BillInboxPage />)
    await user.click(screen.getByRole('tab', { name: /待处理/ }))
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ tab: undefined }) }),
    )
  })

  it('待处理两节都空时换成一块完成态，不再摆两个空节', () => {
    mocks.importable = []
    mocks.attention = []
    render(<BillInboxPage />)

    expect(screen.getByText('待处理清完了')).toBeInTheDocument()
    // 成果从已完成层的计数取：imported 5、dismissed 2
    expect(screen.getByText(/已经入账 5 笔、忽略 2 笔/)).toBeInTheDocument()
    // 两个空节整个不见了，取而代之的是两个出口
    expect(screen.queryByRole('heading', { name: /待入账/ })).not.toBeInTheDocument()
    expect(screen.queryByText('没有待确认的流水。')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '看已完成' })).toBeInTheDocument()
  })

  it('已入账按批次分组，组头给整批撤回；确认框写明这几笔会从账本删除', async () => {
    const user = userEvent.setup()
    const imported = (id: string, batch: string | null) => row(id, {
      status: 'imported',
      import_attempt: {
        id: `A${id}`,
        status: 'succeeded',
        updated_at: '2026-08-16T09:03:00',
        batch_id: batch,
      },
    })
    mocks.search = { tab: 'done' }
    mocks.done = [imported('30', 'B1'), imported('31', 'B1'), imported('32', null)]
    render(<BillInboxPage />)

    // 一批一个组头：两笔那一批 + 没有批次编号的那一组
    expect(screen.getByText('入账 2 笔')).toBeInTheDocument()
    expect(screen.getByText('更早的入账')).toBeInTheDocument()
    // 没有批次编号的那一组不给整批撤回——撤的范围说不清
    const undo = screen.getAllByRole('button', { name: '撤回这批' })
    expect(undo).toHaveLength(1)

    await user.click(undo[0])
    expect(screen.getByText('这 2 笔会从账本删除并回到待处理。')).toBeInTheDocument()
  })

  it('入账成功的 toast 带一颗可点的撤销，撤的是刚入的那一批', async () => {
    const user = userEvent.setup()
    mocks.imported.mockResolvedValue({
      summary: { imported: 2, uncertain: 0, retryable: 0, failed: 0, skipped: 0 },
      rows: [
        { row_id: '1', action: 'imported' },
        { row_id: '2', action: 'imported' },
      ],
    })
    render(<BillInboxPage />)
    await user.click(screen.getByRole('button', { name: /^入账 3 笔$/ }))

    const toast = toasts.at(-1)
    expect(toast?.message).toContain('已入账 2 笔')
    expect(toast?.action?.label).toBe('撤销')
    toast?.action?.onClick?.()
    expect(undoImport).toHaveBeenCalledWith(['1', '2'])
  })

  it('旧链接 ?view=attention 折算成待处理层 + 定位锚，落地后把锚摘掉', () => {
    // 路由的 validateSearch 已经折算过，页面收到的是 section
    mocks.search = { section: 'attention' }
    render(<BillInboxPage />)
    // 两节都在（锚只滚动、不筛选）
    expect(screen.getByRole('heading', { name: /待入账/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /待确认/ })).toBeInTheDocument()
    // 滚过之后把锚从 URL 上摘掉，否则每次重渲染都会把人拽回去
    expect(mocks.navigate).toHaveBeenCalled()
  })
})
