import { useEffect, useRef } from 'react'
import {
  defaultDateRange,
  parseDateRangePreference,
  type DateRangeValue,
} from '../lib/dateRange'
import { PAGE_DEFAULT, type PageKey, useDateRangeStore } from '../store/dateRangeStore'

const STORAGE_KEY = 'granary.date-range'
const PAGE_KEYS = Object.keys(PAGE_DEFAULT) as PageKey[]

function readStoredRanges(): {
  lastUsed: DateRangeValue
  byPage: Partial<Record<PageKey, DateRangeValue>>
} | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (!raw || typeof raw !== 'object') return null
    const value = raw as Record<string, unknown>
    const lastUsed = parseDateRangePreference(value.lastUsed)
    if (!lastUsed) return null
    const rawByPage = value.byPage && typeof value.byPage === 'object'
      ? value.byPage as Record<string, unknown>
      : {}
    const byPage: Partial<Record<PageKey, DateRangeValue>> = {}
    for (const page of PAGE_KEYS) {
      const range = parseDateRangePreference(rawByPage[page])
      if (range) byPage[page] = range
    }
    return { lastUsed, byPage }
  } catch {
    return null
  }
}

export function DateRangePreferenceSync() {
  const hydrated = useDateRangeStore((state) => state.hydrated)
  const hydrate = useDateRangeStore((state) => state.hydrate)
  const start = useDateRangeStore((state) => state.start)
  const end = useDateRangeStore((state) => state.end)
  const preset = useDateRangeStore((state) => state.preset)
  const byPage = useDateRangeStore((state) => state.byPage)
  const didHydrate = useRef(false)

  useEffect(() => {
    if (didHydrate.current) return
    didHydrate.current = true
    const saved = readStoredRanges()
    hydrate(saved?.lastUsed ?? defaultDateRange(), saved?.byPage)
  }, [hydrate])

  useEffect(() => {
    if (!hydrated) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      lastUsed: { preset, start, end },
      byPage,
    }))
  }, [byPage, end, hydrated, preset, start])

  return null
}
