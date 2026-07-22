import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatDateTime } from '../../lib/format'
import { AutomationPanel } from './AutomationPanel'

const mocks = vi.hoisted(() => ({
  range: { start: '2026-07-01', end: '2026-07-31' },
  testRule: vi.fn(),
  triggerRule: vi.fn(),
  triggerRecurrence: vi.fn(),
  refetchRules: vi.fn(),
  refetchRecurrences: vi.fn(),
  rulesError: false,
}))

vi.mock('../../store/dateRangeStore', () => ({ useDateRangeStore: () => mocks.range }))
vi.mock('../../store/toastStore', () => ({ showToast: vi.fn() }))
vi.mock('../../api/queries', () => ({
  useRules: () => ({
    data: { data: [{ id: '1', attributes: { title: 'Categorize lunch', active: true } }] },
    isLoading: false,
    isError: mocks.rulesError,
    refetch: mocks.refetchRules,
  }),
  useRuleGroups: () => ({ data: { data: [] }, isLoading: false, isError: false, refetch: vi.fn() }),
  useRecurrences: () => ({ data: { data: [{ id: '9', attributes: { title: 'Rent', active: true, first_date: '2026-01-01T00:00:00-07:00', latest_date: '2026-07-01T00:00:00-07:00', repeat_until: null, nr_of_repetitions: null, repetitions: [{ occurrences: ['2026-08-01T00:00:00-07:00'] }] } }] }, isLoading: false, isError: false, refetch: mocks.refetchRecurrences }),
  useTestRule: () => ({ mutateAsync: mocks.testRule, isPending: false }),
  useTestRuleGroup: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTriggerRule: () => ({ mutateAsync: mocks.triggerRule, isPending: false }),
  useTriggerRuleGroup: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTriggerRecurrence: () => ({ mutateAsync: mocks.triggerRecurrence, isPending: false }),
}))

describe('AutomationPanel', () => {
  beforeEach(() => {
    mocks.range = { start: '2026-07-01', end: '2026-07-31' }
    mocks.rulesError = false
    mocks.testRule.mockReset()
    mocks.testRule.mockResolvedValue({ data: [], meta: { pagination: { total: 3 } } })
    mocks.triggerRule.mockReset()
    mocks.triggerRule.mockResolvedValue(undefined)
    mocks.triggerRecurrence.mockReset()
    mocks.triggerRecurrence.mockResolvedValue({ data: [{ id: '100' }] })
    mocks.refetchRules.mockReset()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  it('requires a fresh test result for the current date range before triggering', async () => {
    const view = render(<AutomationPanel />)

    fireEvent.click(screen.getByRole('button', { name: '测试 Categorize lunch' }))
    await screen.findByText('匹配 3')

    mocks.range = { start: '2026-08-01', end: '2026-08-31' }
    view.rerender(<AutomationPanel />)
    await waitFor(() => expect(screen.queryByText('匹配 3')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '执行 Categorize lunch' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '测试 Categorize lunch' }))
    await screen.findByText('匹配 3')
    fireEvent.click(screen.getByRole('button', { name: '执行 Categorize lunch' }))

    await waitFor(() => expect(mocks.triggerRule).toHaveBeenCalledWith({ id: '1', range: mocks.range }))
  })

  it('retries a failed automation list', () => {
    mocks.rulesError = true
    render(<AutomationPanel />)

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(mocks.refetchRules).toHaveBeenCalledOnce()
  })

  it('shows recurrence schedule and links the generated transaction', async () => {
    render(<AutomationPanel />)

    expect(screen.getByText(`最近 ${formatDateTime('2026-07-01T00:00:00-07:00')}`)).toBeInTheDocument()
    expect(screen.getByText(`下次 ${formatDateTime('2026-08-01T00:00:00-07:00')}`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '触发 Rent' }))

    await screen.findByText(/本次生成 1 个/)
    expect(screen.getByRole('link', { name: '查看生成交易' })).toHaveAttribute('href', '/transactions?transaction=100')
  })
})
