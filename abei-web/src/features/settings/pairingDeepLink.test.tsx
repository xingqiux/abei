/**
 * 配对深链的整条链路，走真路由。
 *
 * 单独测组件抓不到这一段：路由默认拿 JSON.parse 解查询值，`?pair=1` 到手是数字 1，
 * 校验函数只认字符串时会把 pair 判成 undefined，深链静默失效——把路由 mock 掉的测试
 * 全都照样是绿的。所以这里连 URL 一起测。
 */
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiDelete: mocks.apiDelete,
}))
vi.mock('../../store/toastStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/toastStore')>()),
  showToast: mocks.toast,
}))
vi.mock('../../components/abei/Modal', () => ({
  Modal: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? <div role="dialog" aria-label={title}>{children}</div> : null,
}))

beforeEach(() => {
  mocks.apiGet.mockReset().mockResolvedValue({ data: [] })
  mocks.apiPost.mockReset().mockResolvedValue({ data: { access_token: 'pat-deeplink' } })
  mocks.apiDelete.mockReset()
  mocks.toast.mockReset()
})

async function renderAt(url: string) {
  window.history.replaceState(null, '', url)
  const { router } = await import('../../routes/router')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

test('?pair=1 自动签一次令牌，弹窗留在屏幕上，地址栏里的记号抹掉', async () => {
  await renderAt('/settings?pair=1')

  const dialog = await screen.findByRole('dialog', { name: '连接 abei CLI' }, { timeout: 4000 })
  expect(dialog).toHaveTextContent("--token 'pat-deeplink'")
  expect(mocks.apiPost).toHaveBeenCalledTimes(1)
  // 记号留着的话，刷新一次就多签一个令牌。
  await waitFor(() => expect(window.location.search).toBe(''))
})

test('不带记号进设置页不会签令牌', async () => {
  await renderAt('/settings')

  await screen.findByText('abei CLI 一键配对', {}, { timeout: 4000 })
  expect(mocks.apiPost).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog', { name: '连接 abei CLI' })).not.toBeInTheDocument()
})
