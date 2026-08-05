import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearStoredToken, setStoredToken } from '../api/client'
import { useDateRangeStore } from '../store/dateRangeStore'
import { DateRangePreferenceSync } from './DateRangePreferenceSync'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  preference: {
    isLoading: true,
    isFetching: true,
    isError: false,
    data: undefined as unknown,
  },
}))

vi.mock('../api/queries', () => ({
  usePreference: () => mocks.preference,
  useSetPreference: () => ({ mutate: mocks.mutate }),
}))

describe('DateRangePreferenceSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.mutate.mockReset()
    mocks.preference.isLoading = true
    mocks.preference.isFetching = true
    mocks.preference.isError = false
    mocks.preference.data = undefined
    setStoredToken('new-user-token')
    useDateRangeStore.setState({
      start: '2020-01-01',
      end: '2020-01-31',
      preset: 'custom',
      hydrated: true,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    clearStoredToken()
    useDateRangeStore.getState().reset()
  })

  it('does not write stale state while the new user preference is loading', () => {
    render(<DateRangePreferenceSync />)

    act(() => {
      vi.advanceTimersByTime(1_000)
    })

    expect(mocks.mutate).not.toHaveBeenCalled()
  })
})
