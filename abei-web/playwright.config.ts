import { defineConfig, devices } from '@playwright/test'

/**
 * e2e 打真的 Firefly，不 mock：
 * - 数据来自 firefly-iii 的 `php artisan system:seed-e2e`（见 e2e/seed.ts，spec 跑前重播一次）
 * - 前端默认由这里自己拉起 vite（端口 5174，跟 `make dev-web` 的 5173 岔开，两边能同时开）；
 *   vite 的 /v1 代理转到 127.0.0.1:18002 的 abei-api，账本请求经它再落到 Firefly
 *
 * 想打 nginx 产物（`make up` 起的 abei-web 容器）就：
 *   E2E_BASE_URL=http://127.0.0.1:18004 npx playwright test
 * 这时不再自起 web 服务，/v1 由容器里的 nginx 反代给 abei-api，不经宿主的 18002。
 */
const DEV_SERVER_PORT = 5174
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
          // 不复用别人起的 dev server：那个多半带着 .env.local 里的兜底令牌，登录这一步就测不到了。
          reuseExistingServer: false,
          timeout: 120_000,
          env: { VITE_FIREFLY_TOKEN: '' },
        },
      }
    : {}),
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      testIgnore: /.*\.desktop\.spec\.ts/,
      use: { ...devices['iPhone 13'], reducedMotion: 'reduce' },
    },
  ],
})
