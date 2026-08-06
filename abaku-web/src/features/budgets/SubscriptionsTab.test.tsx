import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Recurrence } from '../../api/schemas'
import { toDateInputValue } from '../../lib/format'
import { SubscriptionsTab } from './SubscriptionsTab'

const mocks = vi.hoisted(() => ({
  fireflyFetch: vi.fn(),
  fireflyPost: vi.fn(),
  toast: vi.fn(),
}))

// 只换 HTTP 原语，api/firefly 与 api/queries 跑真的，断言的是真实路径
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  fireflyFetch: mocks.fireflyFetch,
  fireflyPost: mocks.fireflyPost,
}))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))
vi.mock('../../components/abaku/Skeleton', () => ({ Skeleton: () => null }))
vi.mock('../../components/abaku/EmptyState', () => ({ EmptyState: ({ message }: { message: string }) => <div>{message}</div> }))
vi.mock('../../components/abaku/ErrorState', () => ({
  ErrorState: ({ message, onRetry }: { message: string; onRetry: () => void }) => (
    <div>{message}<button type="button" onClick={onRetry}>重试</button></div>
  ),
}))

const TODAY = toDateInputValue(new Date())

function recurrence(over: {
  id: string
  title: string
  active?: boolean
  first_date?: string
  repetitions?: Array<{ type: string; moment: string; skip: number }>
  tx?: { amount?: string; currency_symbol?: string; source_name?: string; destination_name?: string; category_name?: string | null } | null
}): Recurrence {
  return {
    id: over.id,
    attributes: {
      title: over.title,
      active: over.active ?? true,
      first_date: over.first_date ?? '2020-01-01',
      repetitions: (over.repetitions ?? [{ type: 'daily', moment: '', skip: 0 }]).map((r) => ({ ...r, occurrences: [] })),
      transactions: over.tx === null ? [] : [{
        amount: '68.00',
        currency_symbol: '¥',
        source_name: '招行信用卡',
        destination_name: 'Netflix',
        category_name: '订阅',
        ...over.tx,
      }],
    },
  }
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SubscriptionsTab />
    </QueryClientProvider>,
  )
}

/** 订阅一行 = 标题所在的行容器 */
function rowOf(title: string): HTMLElement {
  return screen.getByText(title).closest('.flex.min-h-10') as HTMLElement
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/**
 * 一次成功的 trigger 响应：真的生成了一笔。
 * 默认必须是这个而不是 `{ data: [] }`——空数组代表「这个日期上没有待生成的期次」，
 * 是失败路径。曾经用空数组当默认，把「200 但没生成」当成了成功。
 */
function triggeredResponse(id = '321') {
  return {
    data: [{
      id,
      attributes: {
        transactions: [{
          transaction_journal_id: '1',
          description: 'Netflix',
          amount: '68.00',
          type: 'withdrawal',
          date: TODAY,
          currency_symbol: '¥',
          source_name: '招行信用卡',
          destination_name: 'Netflix',
          category_name: '订阅',
        }],
      },
    }],
  }
}

beforeEach(() => {
  mocks.fireflyFetch.mockReset().mockResolvedValue({ data: [recurrence({ id: '5', title: 'Netflix' })] })
  mocks.fireflyPost.mockReset().mockResolvedValue(triggeredResponse())
  mocks.toast.mockReset()
})

describe('SubscriptionsTab 列表', () => {
  it('列出标题、账户流向、金额和下次到期日', async () => {
    const today = new Date()
    mocks.fireflyFetch.mockResolvedValue({
      data: [
        recurrence({ id: '5', title: 'Netflix' }),
        recurrence({ id: '6', title: '房租', first_date: '2099-01-01', tx: { amount: '3200', currency_symbol: '¥', source_name: '工资卡', destination_name: '房东' } }),
        recurrence({ id: '7', title: '没排期的', repetitions: [] }),
      ],
    })
    renderTab()
    await screen.findByText('Netflix')

    const netflix = rowOf('Netflix')
    expect(netflix).toHaveTextContent('招行信用卡 → Netflix · 订阅')
    expect(netflix).toHaveTextContent('¥68.00')
    expect(netflix).toHaveTextContent(`${today.getMonth() + 1} 月 ${today.getDate()} 日（今天）`)

    expect(rowOf('房租')).toHaveTextContent('¥3,200.00')
    expect(rowOf('房租').textContent).toMatch(/1 月 1 日（还有 \d+ 天）/)

    expect(rowOf('没排期的')).toHaveTextContent('暂无计划')
  })

  it('没配账户模板时标出来而不是显示空白', async () => {
    mocks.fireflyFetch.mockResolvedValue({ data: [recurrence({ id: '8', title: '裸订阅', tx: null })] })
    renderTab()
    await screen.findByText('裸订阅')

    const row = rowOf('裸订阅')
    expect(row).toHaveTextContent('未配置账户模板')
    expect(row).toHaveTextContent('—')
  })

  it('一条都没有时给引导空态', async () => {
    mocks.fireflyFetch.mockResolvedValue({ data: [] })
    renderTab()

    expect(await screen.findByText('还没有定期交易——在 Firefly III 里建一个 recurrence 就能在这里点一下记一笔')).toBeInTheDocument()
  })

  it('加载失败时给错误态', async () => {
    mocks.fireflyFetch.mockReset().mockRejectedValue(new Error('boom'))
    renderTab()

    expect(await screen.findByText('订阅加载失败')).toBeInTheDocument()
  })
})

describe('SubscriptionsTab 记这一笔', () => {
  it('走 POST /api/v1/recurrences/{id}/trigger，带上今天的日期', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '记这一笔' }))

    await waitFor(() => expect(mocks.fireflyPost).toHaveBeenCalledWith(
      `/api/v1/recurrences/5/trigger?date=${TODAY}`,
      {},
    ))
  })

  it('成功后那行变「本期已记」，按钮直接消失', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '记这一笔' }))

    expect(await screen.findByText('本期已记')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '记这一笔' })).not.toBeInTheDocument()
    expect(mocks.toast).toHaveBeenCalledWith({
      kind: 'success',
      message: '已记一笔「Netflix」',
      action: { label: '查看', to: '/transactions?transaction=321' },
    })
  })

  it('200 但没生成交易时算失败：不显示已记，提示可能已记过', async () => {
    // 这是真出过的 bug：trigger 的 date 落不到任何期次上时，接口返回 200 + data:[]，
    // 旧代码照样弹「已记一笔」并把行变成「本期已记」，实际一笔都没有。
    mocks.fireflyPost.mockResolvedValue({ data: [] })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '记这一笔' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('没有生成交易') }),
    ))
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }))
    expect(screen.queryByText('本期已记')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '记这一笔' })).toBeEnabled()
  })

  it('返回了新交易就在提示里给「查看」入口', async () => {
    mocks.fireflyPost.mockResolvedValue({
      data: [{
        id: '321',
        attributes: {
          transactions: [{
            transaction_journal_id: '1',
            description: 'Netflix',
            amount: '68.00',
            type: 'withdrawal',
            date: TODAY,
            currency_symbol: '¥',
            source_name: '招行信用卡',
            destination_name: 'Netflix',
            category_name: '订阅',
          }],
        },
      }],
    })
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '记这一笔' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({
      kind: 'success',
      message: '已记一笔「Netflix」',
      action: { label: '查看', to: '/transactions?transaction=321' },
    }))
  })
})

describe('SubscriptionsTab 防重复触发', () => {
  it('触发进行中按钮禁用，连点也只发一次请求', async () => {
    const pending = deferred<ReturnType<typeof triggeredResponse>>()
    mocks.fireflyPost.mockReturnValue(pending.promise)
    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: '记这一笔' }))

    const button = await screen.findByRole('button', { name: '记录中…' })
    expect(button).toBeDisabled()

    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocks.fireflyPost).toHaveBeenCalledTimes(1)

    pending.resolve(triggeredResponse())
    expect(await screen.findByText('本期已记')).toBeInTheDocument()
    expect(mocks.fireflyPost).toHaveBeenCalledTimes(1)
  })

  it('多条订阅时只禁用正在触发的那一条', async () => {
    mocks.fireflyFetch.mockResolvedValue({
      data: [recurrence({ id: '5', title: 'Netflix' }), recurrence({ id: '6', title: 'Spotify' })],
    })
    const pending = deferred<ReturnType<typeof triggeredResponse>>()
    mocks.fireflyPost.mockReturnValue(pending.promise)
    renderTab()
    await screen.findByText('Netflix')

    fireEvent.click(within(rowOf('Netflix')).getByRole('button', { name: '记这一笔' }))

    expect(await within(rowOf('Netflix')).findByRole('button', { name: '记录中…' })).toBeDisabled()
    expect(within(rowOf('Spotify')).getByRole('button', { name: '记这一笔' })).toBeEnabled()

    pending.resolve(triggeredResponse())
    await screen.findByText('本期已记')
  })

  it('停用的定期交易不给手动触发', async () => {
    mocks.fireflyFetch.mockResolvedValue({ data: [recurrence({ id: '5', title: 'Netflix', active: false })] })
    renderTab()

    const button = await screen.findByRole('button', { name: '记这一笔' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', '停用的定期交易不能手动触发')

    fireEvent.click(button)
    expect(mocks.fireflyPost).not.toHaveBeenCalled()
  })
})

describe('SubscriptionsTab 触发失败', () => {
  it('提示结果未知让人去刷新确认，绝不给「重试」按钮', async () => {
    mocks.fireflyPost.mockRejectedValue(new Error('timeout'))
    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: '记这一笔' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({
      kind: 'error',
      message: '触发结果未知，请刷新确认',
      duration: 6000,
    }))
    // 可能已经生成了，给「重试」等于教人点出第二笔
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /重试/ })).not.toBeInTheDocument()
  })

  it('失败后按钮恢复可点，但不会自动重发', async () => {
    mocks.fireflyPost.mockRejectedValue(new Error('timeout'))
    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: '记这一笔' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: '记这一笔' })).toBeEnabled()
    expect(screen.queryByText('本期已记')).not.toBeInTheDocument()
    expect(mocks.fireflyPost).toHaveBeenCalledTimes(1)
  })
})
