import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
    // 5173 是 abei-web 的号，两边同时开着是常态，所以后台固定 5174。
    port: 5174,
    strictPort: true,
    proxy: {
      // 后台只吃 abei-api 这一面：邮件、解析器、反馈都在 /v1 下。
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
