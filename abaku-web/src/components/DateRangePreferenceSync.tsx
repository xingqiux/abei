import { useEffect, useRef } from 'react'
import {
  defaultDateRange,
  parseDateRangePreference,
} from '../lib/dateRange'
import { useDateRangeStore } from '../store/dateRangeStore'

const STORAGE_KEY = 'granary.date-range'

export function DateRangePreferenceSync() {
  const hydrated = useDateRangeStore((state) => state.hydrated)
  const hydrate = useDateRangeStore((state) => state.hydrate)
  const start = useDateRangeStore((state) => state.start)
  const end = useDateRangeStore((state) => state.end)
  const preset = useDateRangeStore((state) => state.preset)
  const didHydrate = useRef(false)

  useEffect(() => {
    if (didHydrate.current) return
    didHydrate.current = true
    let saved = null
    try {
      saved = parseDateRangePreference(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'))
    } catch {
      saved = null
    }
    hydrate(saved ?? defaultDateRange())
  }, [hydrate])

  useEffect(() => {
    if (!hydrated) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset, start, end }))
  }, [end, hydrated, preset, start])

  return null
}
