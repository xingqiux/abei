import { StrictMode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { GoogleOAuthCallbackPage } from './GoogleOAuthCallbackPage'

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => ({ code: 'one-time-code', state: 'one-time-state' }),
}))
vi.mock('../../api/firefly', () => ({ completeGoogleMailboxOAuth: mocks.complete }))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))

beforeEach(() => {
  mocks.complete.mockReset().mockResolvedValue({
    data: {
      type: 'bill-inbox-settings',
      attributes: { email: 'owner@gmail.com' },
    },
  })
  mocks.navigate.mockReset().mockResolvedValue(undefined)
  mocks.toast.mockReset()
})

it('submits a Google authorization code only once in StrictMode', async () => {
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <GoogleOAuthCallbackPage />
      </QueryClientProvider>
    </StrictMode>,
  )

  await waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce())
  expect(mocks.complete).toHaveBeenCalledWith({
    code: 'one-time-code',
    state: 'one-time-state',
  })
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({
    to: '/bill-inbox',
    search: {},
    replace: true,
  }))
})
