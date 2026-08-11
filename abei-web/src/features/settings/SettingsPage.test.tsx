import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { SettingsPage } from './SettingsPage'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  pair: true as boolean | undefined,
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => ({ pair: mocks.pair }),
}))
vi.mock('../../api/queries', () => ({
  useAbout: () => ({ data: { data: { version: 'test' } } }),
}))
vi.mock('./ModelConnectionPanel', () => ({ ModelConnectionPanel: () => null }))
vi.mock('./TokensPanel', () => ({
  TokensPanel: ({ autoPair }: { autoPair?: boolean }) => (
    <div data-testid="tokens" data-auto-pair={String(Boolean(autoPair))} />
  ),
}))

beforeEach(() => {
  mocks.navigate.mockReset()
  mocks.pair = true
  localStorage.clear()
})

test('配对深链落在连接与授权并立即清掉 search', async () => {
  render(<SettingsPage />)

  expect(screen.getByRole('button', { name: /连接与授权/ })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByTestId('tokens')).toHaveAttribute('data-auto-pair', 'true')
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({
    to: '/settings',
    search: {},
    replace: true,
  }))
})
