import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 播种走 firefly-iii 的 `system:seed-e2e`：它建 e2e 专用用户、发 PAT，
 * 并把该用户的账本清空重建（账户 / 分类 / 三笔支出 / 一条日订阅）。
 * 主路径本身会写数据，所以每次跑之前都要重播，否则第二次断言到的笔数就不对了。
 *
 * 命令能用环境变量替换，方便在没有 docker 的环境里换成本机 artisan：
 *   E2E_SEED_COMMAND='php artisan system:seed-e2e --token-path=/tmp/e2e-token'
 *   E2E_TOKEN_COMMAND='cat /tmp/e2e-token'
 */
const SEED_COMMAND =
  process.env.E2E_SEED_COMMAND
  ?? 'docker compose exec -T -e APP_ENV=testing app php artisan system:seed-e2e'
const TOKEN_COMMAND = process.env.E2E_TOKEN_COMMAND ?? 'docker compose exec -T app cat /run/e2e/token'

/** compose.yml 所在目录就是仓库根，docker compose 必须在那里跑才认得项目名和 .env。 */
function repoRoot(): string {
  let dir = process.cwd()
  while (!existsSync(path.join(dir, 'compose.yml'))) {
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('找不到仓库根目录（往上都没有 compose.yml）')
    dir = parent
  }
  return dir
}

function run(command: string): string {
  try {
    return execFileSync('sh', ['-c', command], { cwd: repoRoot(), encoding: 'utf8' })
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string }
    throw new Error(
      [
        `播种命令失败：${command}`,
        'Firefly 起来了吗？`make up` 或 `docker compose up -d --wait db mail app`。',
        detail.stderr?.trim(),
        detail.stdout?.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
}

/** 重播 e2e 用户的账本，返回它的个人访问令牌。 */
export function seedFireflyE2EUser(): string {
  run(SEED_COMMAND)
  const token = run(TOKEN_COMMAND).trim()
  if (token === '') throw new Error(`没读到 e2e 令牌：${TOKEN_COMMAND}`)
  return token
}
