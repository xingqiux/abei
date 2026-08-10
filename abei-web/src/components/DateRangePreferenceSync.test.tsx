import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useDateRangeStore } from '../store/dateRangeStore'
import { DateRangePreferenceSync } from './DateRangePreferenceSync'

const STORAGE_KEY = 'granary.date-range'

describe('DateRangePreferenceSync', () => {
  beforeEach(() => {
    localStorage.clear()
    useDateRangeStore.getState().reset()
  })

  afterEach(() => {
    localStorage.clear()
    useDateRangeStore.getState().reset()
  })

  it('restores validated ranges for each supported page', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      lastUsed: { start: '2026-07-01', end: '2026-07-31', preset: 'custom' },
      byPage: {
        today: { start: '2026-08-01', end: '2026-08-05', preset: 'custom' },
        transactions: { start: 'invalid', end: '2026-08-05', preset: 'custom' },
        budgets: { start: '2026-08-01', end: '2026-08-31', preset: 'custom' },
        analysis: { start: '2020-01-01', end: '2020-01-31', preset: 'custom' },
      },
    }))

    render(<DateRangePreferenceSync />)

    await waitFor(() => expect(useDateRangeStore.getState().hydrated).toBe(true))
    expect(useDateRangeStore.getState()).toMatchObject({
      start: '2026-07-01',
      end: '2026-07-31',
      byPage: {
        today: { start: '2026-08-01', end: '2026-08-05', preset: 'custom' },
        budgets: { start: '2026-08-01', end: '2026-08-31', preset: 'custom' },
      },
    })
    expect(useDateRangeStore.getState().byPage.transactions).toBeUndefined()
    expect('analysis' in useDateRangeStore.getState().byPage).toBe(false)
  })

  it('persists a page range together with the last used range', async () => {
    render(<DateRangePreferenceSync />)
    await waitFor(() => expect(useDateRangeStore.getState().hydrated).toBe(true))

    act(() => {
      useDateRangeStore.getState().setRange('today', {
        start: '2026-08-02',
        end: '2026-08-05',
        preset: 'custom',
      })
    })

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
      expect(stored).toMatchObject({
        lastUsed: { start: '2026-08-02', end: '2026-08-05', preset: 'custom' },
        byPage: {
          today: { start: '2026-08-02', end: '2026-08-05', preset: 'custom' },
        },
      })
    })
  })
})
