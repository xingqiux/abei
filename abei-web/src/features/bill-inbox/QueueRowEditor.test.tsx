import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BillQueueRow } from '../../api/schemas'
import { QueueRowEditor } from './QueueRowEditor'

const mocks = vi.hoisted(() => ({
  updateRow: vi.fn(),
  categoryFeedback: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../../api/queries', () => ({
  useUpdateBillStatementRow: () => ({ mutateAsync: mocks.updateRow, isPending: false }),
  useCategoryFeedback: () => ({ mutateAsync: mocks.categoryFeedback, isPending: false }),
}))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))
vi.mock('../../components/abei/CategoryPicker', () => ({
  DOMAINS_BY_TX_TYPE: { withdrawal: ['expense'], deposit: ['income'], transfer: ['transfer'] },
  CategoryPicker: ({ value, onChange }: { value: string | null; onChange: (name: string | null) => void }) => (
    <input aria-label="分类" value={value ?? ''} onChange={(event) => onChange(event.target.value || null)} />
  ),
}))

function makeRow(overrides: Record<string, unknown> = {}): BillQueueRow {
  return {
    id: 'row-1',
    attributes: {
      firefly_type: 'withdrawal',
      firefly_date: '2026-08-11',
      firefly_description: '星巴克',
      occurred_at: '2026-08-11T09:00:00+08:00',
      amount: '38.00',
      firefly_amount: '38.00',
      source_name: '招行信用卡',
      destination_name: '星巴克',
      category_name: '餐饮',
      notes: '晨会',
      counterparty: '星巴克',
      ...overrides,
    },
  } as unknown as BillQueueRow
}

describe('QueueRowEditor', () => {
  beforeEach(() => {
    mocks.updateRow.mockReset().mockResolvedValue({})
    mocks.categoryFeedback.mockReset().mockResolvedValue({})
    mocks.toast.mockReset()
  })

  it('挂载时就带着这一行的值，不需要外面灌', () => {
    render(<QueueRowEditor row={makeRow()} ai={false} counterparty="星巴克" onEndEdit={vi.fn()} />)

    expect(screen.getByLabelText('描述')).toHaveValue('星巴克')
    expect(screen.getByLabelText('来源账户')).toHaveValue('招行信用卡')
    expect(screen.getByLabelText('目标账户')).toHaveValue('星巴克')
    expect(screen.getByLabelText('分类')).toHaveValue('餐饮')
    expect(screen.getByLabelText('备注')).toHaveValue('晨会')
    expect(screen.getByLabelText('交易类型')).toHaveValue('withdrawal')
    expect(screen.getByLabelText('交易日期')).toHaveValue('2026-08-11')
  })

  it('保存只写「要记成什么」，不回写银行原文', async () => {
    const onEndEdit = vi.fn()
    render(<QueueRowEditor row={makeRow()} ai={false} counterparty="星巴克" onEndEdit={onEndEdit} />)

    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '星巴克 晨会' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.updateRow).toHaveBeenCalledTimes(1))
    const { rowId, input } = mocks.updateRow.mock.calls[0][0]
    expect(rowId).toBe('row-1')
    expect(input.firefly_description).toBe('星巴克 晨会')
    // 原文字段是对账依据，rows.update 也不收，别让它们混进来
    expect(input).not.toHaveProperty('amount')
    expect(input).not.toHaveProperty('description')
    expect(input).not.toHaveProperty('occurred_at')
    expect(input).not.toHaveProperty('counterparty')
    expect(onEndEdit).toHaveBeenCalled()
  })

  it('金额非法时不发请求，只提示', async () => {
    render(<QueueRowEditor row={makeRow()} ai={false} counterparty="" onEndEdit={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('金额'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ message: '请输入大于 0 的金额', kind: 'error' }),
    ))
    expect(mocks.updateRow).not.toHaveBeenCalled()
  })

  it('改掉 AI 建议的分类才问要不要立规则', () => {
    const { rerender } = render(
      <QueueRowEditor row={makeRow()} ai counterparty="星巴克" onEndEdit={vi.fn()} />,
    )

    // 没动分类的时候不该问：那等于每次编辑都弹一次同样的问题
    expect(screen.queryByText(/以后「星巴克」都归/)).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '咖啡' } })
    expect(screen.getByText(/以后「星巴克」都归「咖啡」/)).toBeInTheDocument()

    // ai 为假时永远不问
    rerender(<QueueRowEditor row={makeRow()} ai={false} counterparty="星巴克" onEndEdit={vi.fn()} />)
    expect(screen.queryByText(/以后「星巴克」都归/)).not.toBeInTheDocument()
  })
})
