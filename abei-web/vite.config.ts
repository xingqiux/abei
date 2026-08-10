import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    include: ['src/**/*.test.{ts,tsx}'],
    maxWorkers: 2,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // AI 面还在 abei-agent 上，没走 abei-api。
      '/api/ai': {
        target: 'http://127.0.0.1:18003',
        changeOrigin: true,
      },
      // 账本数据全部走 abei-api：已建模的域是 /v1/<资源>，其余走 /v1/firefly 逃生舱。
      '/v1': {
        target: 'http://127.0.0.1:18002',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:18002',
        changeOrigin: true,
      },
    },
  },
})
