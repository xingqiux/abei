import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearStoredToken, UNAUTHORIZED_EVENT } from '../api/client'
import { useCommandPaletteStore } from '../store/commandPaletteStore'
import { useDateRangeStore } from '../store/dateRangeStore'
import { useMoreSheetStore } from '../store/moreSheetStore'
import { useRecordTxStore } from '../store/recordTxStore'
import { useToastStore } from '../store/toastStore'
import { REQUEST_TOKEN_EVENT } from './tokenEvents'
import { TokenGate } from './TokenGate'

afterEach(() => {
  clearStoredToken()
  useRecordTxStore.getState().close()
  useCommandPaletteStore.getState().close()
  useMoreSheetStore.getState().close()
  useToastStore.getState().clear()
  useDateRangeStore.getState().reset()
})

describe('TokenGate', () => {
  it('does not reopen for an old unauthorized event after a new token is saved', async () => {
    let finishOldCleanup!: () => void
    const oldCleanup = new Promise<void>((resolve) => {
      finishOldCleanup = resolve
    })
    const queryClient = new QueryClient()
    vi.spyOn(queryClient, 'cancelQueries')
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => oldCleanup)
      .mockResolvedValue(undefined)

    render(
      <QueryClientProvider client={queryClient}>
        <TokenGate>
          <main>Authenticated application</main>
        </TokenGate>
      </QueryClientProvider>,
    )

    window.dispatchEvent(new CustomEvent(REQUEST_TOKEN_EVENT))
    await screen.findByRole('dialog', { name: '设置 API 令牌' })
    expect(screen.queryByText('Authenticated application')).not.toBeInTheDocument()

    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
    fireEvent.change(screen.getByPlaceholderText('粘贴个人访问令牌…'), {
      target: { value: 'replacement-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存并继续' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置 API 令牌' })).not.toBeInTheDocument())
    expect(screen.getByText('Authenticated application')).toBeInTheDocument()
    finishOldCleanup()

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置 API 令牌' })).not.toBeInTheDocument())
  })

  it('clears user-scoped stores before accepting a replacement token', async () => {
    sessionStorage.setItem('granary.token', 'old-token')
    useRecordTxStore.getState().openEdit({
      groupId: 'old-group',
      journalId: 'old-journal',
      splitCount: 1,
      type: 'withdrawal',
      amount: '88.00',
      description: 'old user transaction',
      date: '2026-07-20',
    })
    useDateRangeStore.setState({
      start: '2020-01-01',
      end: '2020-01-31',
      preset: 'custom',
      hydrated: true,
    })
    useCommandPaletteStore.getState().openPalette()
    useMoreSheetStore.getState().openSheet()
    useToastStore.getState().push({ message: 'old user message', duration: 0 })
    const queryClient = new QueryClient()
    queryClient.setQueryData(['old-user'], { private: true })

    render(
      <QueryClientProvider client={queryClient}>
        <TokenGate>
          <main>Authenticated application</main>
        </TokenGate>
      </QueryClientProvider>,
    )

    window.dispatchEvent(new CustomEvent(REQUEST_TOKEN_EVENT))
    await screen.findByRole('dialog', { name: '设置 API 令牌' })

    await waitFor(() => {
      expect(queryClient.getQueryData(['old-user'])).toBeUndefined()
      expect(useRecordTxStore.getState()).toMatchObject({ open: false, mode: 'create', edit: null })
      expect(useDateRangeStore.getState()).toMatchObject({ hydrated: false, preset: 'last30' })
      expect(useCommandPaletteStore.getState().open).toBe(false)
      expect(useMoreSheetStore.getState().open).toBe(false)
      expect(useToastStore.getState().toasts).toEqual([])
    })

    fireEvent.change(screen.getByPlaceholderText('粘贴个人访问令牌…'), {
      target: { value: 'replacement-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存并继续' }))

    await waitFor(() => expect(screen.getByText('Authenticated application')).toBeInTheDocument())
    expect(useRecordTxStore.getState().edit).toBeNull()
    expect(useDateRangeStore.getState().hydrated).toBe(false)
  })
})
