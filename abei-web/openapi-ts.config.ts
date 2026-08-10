import { defineConfig } from '@hey-api/openapi-ts'

/**
 * 从 abei-api 导出的 OpenAPI 文档生成 TS 类型与 Zod 校验。
 *
 * 输入是签进仓库的 `abei/openapi.json`，不是运行中的服务——生成代码不该要求先把服务跑起来。
 * 那份文档由 abei-core 的能力目录算出，abei 侧有防漂移测试看住它与代码一致。
 * 重新生成：`npm run gen:api`。
 *
 * 只生成类型和 Zod，不生成 SDK 与 fetch 客户端：请求要走 src/api/client.ts，
 * 那里有令牌轮换、身份校验和 problem+json 解析，生成的客户端这些都没有。
 */
export default defineConfig({
  input: '../abei/openapi.json',
  output: {
    path: 'src/api/generated',
    // 生成物不进 oxlint/格式化流水线：它是机器产物，签进仓库靠 diff 看住即可。
    postProcess: [],
  },
  plugins: [
    { name: '@hey-api/typescript', enums: 'javascript' },
    { name: 'zod', exportFromIndex: true },
  ],
})
