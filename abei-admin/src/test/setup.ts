import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(cleanup)

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key) {
      return values.get(key) ?? null
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null
    },
    removeItem(key) {
      values.delete(key)
    },
    setItem(key, value) {
      values.set(key, String(value))
    },
  }
}

Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage() })
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: memoryStorage() })

// headlessui 的 Menu/Listbox 打开时会观察触发器的尺寸变化；jsdom 没有 ResizeObserver，
// 缺了它测试不会红，但会往控制台扔一个 unhandled error。空实现就够——测试不校验布局。
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
