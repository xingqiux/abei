import { defineConfig, devices } from '@playwright/test'

/**
 * 后台的 e2e 全程 mock `/v1`，不打真的 Firefly——这几个页面测的是布局和交互，
 * 不是数据链路，前台那套 seed 在这里只会拖慢一分钟。
 *
 * 端口 5176：5173/5174 归 abei-web 的 dev 和 e2e，5175 是后台自己的 dev。
 * 想打 nginx 产物（`make up` 起的 abei-admin 容器）就：
 *   E2E_BASE_URL=http://127.0.0.1:18006 npx playwright test
 */
const DEV_SERVER_PORT = 5176
const DEV_SERVER_URL = `http://127.0.0.1:${DEV_SERVER_PORT}`
const baseURL = process.env.E2E_BASE_URL ?? DEV_SERVER_URL

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results/playwright',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  ...(baseURL === DEV_SERVER_URL
    ? {
        webServer: {
          command: `npm run dev -- --port ${DEV_SERVER_PORT} --strictPort`,
          url: DEV_SERVER_URL,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }
    : {}),
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
})
