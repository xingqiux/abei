import { useEffect, useRef, useState } from 'react'
import { hasActiveToken, TOKEN_READY_EVENT, UNAUTHORIZED_EVENT } from '../api/client'
import { usePreference, useSetPreference } from '../api/queries'
import {
  GRANARY_DATE_RANGE_PREF,
  defaultDateRange,
  parseDateRangePreference,
} from '../lib/dateRange'
import { useDateRangeStore } from '../store/dateRangeStore'

/**
 * 启动时从 Firefly preferences 灌入全局日期范围；
 * 用户改范围后 debounce 写回 granary.date_range（POST upsert）。
 * 挂在 AppShell 内，与 TokenGate 同生命周期。
 */
export function DateRangePreferenceSync() {
  const [tokenReady, setTokenReady] = useState(() => hasActiveToken())
  const hydrated = useDateRangeStore((s) => s.hydrated)
  const hydrate = useDateRangeStore((s) => s.hydrate)
  const markHydrated = useDateRangeStore((s) => s.markHydrated)
  const start = useDateRangeStore((s) => s.start)
  const end = useDateRangeStore((s) => s.end)
  const preset = useDateRangeStore((s) => s.preset)

  const prefQuery = usePreference(GRANARY_DATE_RANGE_PREF, { enabled: tokenReady })
  const setPref = useSetPreference()

  // 记录已成功写回（或已从服务端对齐）的快照，避免重复 POST / 避免 hydrate 回写
  const lastSavedRef = useRef<string | null>(null)
  const hydrateDoneRef = useRef(false)

  useEffect(() => {
    function onTokenReady() {
      setTokenReady(hasActiveToken())
      hydrateDoneRef.current = false
    }
    function onUnauthorized() {
      setTokenReady(false)
    }
    window.addEventListener(TOKEN_READY_EVENT, onTokenReady)
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => {
      window.removeEventListener(TOKEN_READY_EVENT, onTokenReady)
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    }
  }, [])

  // 1) 加载偏好 → store
  useEffect(() => {
    if (!tokenReady) {
      if (!hydrateDoneRef.current) {
        hydrate(defaultDateRange())
        hydrateDoneRef.current = true
        lastSavedRef.current = null
      }
      return
    }
    if (prefQuery.isLoading || prefQuery.isFetching) return
    if (hydrateDoneRef.current) return

    if (prefQuery.isError) {
      markHydrated()
      hydrateDoneRef.current = true
      return
    }

    const raw = prefQuery.data?.data.attributes.data
    const parsed = parseDateRangePreference(raw)
    if (parsed) {
      hydrate(parsed)
      lastSavedRef.current = JSON.stringify({
        preset: parsed.preset,
        start: parsed.start,
        end: parsed.end,
      })
    } else {
      const def = defaultDateRange()
      hydrate(def)
      // 尚无有效服务端偏好：记下当前默认快照，避免立刻把默认值 POST 上去
      lastSavedRef.current = JSON.stringify({
        preset: def.preset,
        start: def.start,
        end: def.end,
      })
    }
    hydrateDoneRef.current = true
  }, [
    tokenReady,
    prefQuery.isLoading,
    prefQuery.isFetching,
    prefQuery.isError,
    prefQuery.data,
    hydrate,
    markHydrated,
  ])

  // 2) store 变化 → debounce 写 preferences
  useEffect(() => {
    if (!hydrated || !tokenReady) return
    const payload = { preset, start, end }
    const key = JSON.stringify(payload)
    if (key === lastSavedRef.current) return

    const t = window.setTimeout(() => {
      setPref.mutate(
        { name: GRANARY_DATE_RANGE_PREF, data: payload },
        {
          onSuccess: () => {
            lastSavedRef.current = key
          },
        },
      )
    }, 400)
    return () => window.clearTimeout(t)
  }, [hydrated, tokenReady, start, end, preset, setPref])

  return null
}
