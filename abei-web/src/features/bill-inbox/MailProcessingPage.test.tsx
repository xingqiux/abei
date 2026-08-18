import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MailProcessingPage } from './MailProcessingPage'

/**
 * 二级页只验一件事：从首屏搬过来的那三块（漏斗、要人动手的邮件、邮件清单）
 * 确实落在这里，而且有一条回收件箱的路。
 */

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children?: unknown }) => children,
}))

const idleQuery = { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() }
const idleMutation = { mutateAsync: vi.fn(async () => ({})), isPending: false }

vi.mock('../../api/queries', () => ({
  useBillInboxSummary: () => ({ ...idleQuery, data: { channels: [{ key: 'cmb', name: '招商银行' }] } }),
  useBillTasks: () => ({ ...idleQuery, data: { data: [] } }),
  useSyncBillInbox: () => idleMutation,
  useBillProcessingSummary: () => ({
    ...idleQuery,
    data: {
      window_days: 7,
      mail: { runs: 1, failed_runs: 0 },
      parse: { total: 3, succeeded: 2, running: 0, waiting_input: 0, failed: 1, stuck: [] },
      rows: { produced: 9 },
    },
  }),
  useRetryParseJob: () => idleMutation,
  useSubmitBillTaskSecret: () => idleMutation,
  useRetryBillTask: () => idleMutation,
  useArchiveBillTask: () => idleMutation,
}))

describe('邮件处理二级页', () => {
  it('漏斗的三段数字在这里，不在收件箱首屏', () => {
    render(<MailProcessingPage />)
    expect(screen.getByText('账单邮件')).toBeInTheDocument()
    expect(screen.getByText('解析成功')).toBeInTheDocument()
    expect(screen.getByText('产出流水')).toBeInTheDocument()
    expect(screen.getByText('9 笔')).toBeInTheDocument()
  })

  it('三块都在，并且留着回收件箱的路', () => {
    render(<MailProcessingPage />)
    expect(screen.getByRole('heading', { name: '这一批邮件的去向' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '要人动手的邮件' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '邮件清单' })).toBeInTheDocument()
    expect(screen.getByText('返回收件箱')).toBeInTheDocument()
  })
})
