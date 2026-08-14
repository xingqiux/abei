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
    // 5173 是 abei-web 的 dev、5174 是它 e2e 自起的那个，后台只能往后排。
    port: 5175,
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
