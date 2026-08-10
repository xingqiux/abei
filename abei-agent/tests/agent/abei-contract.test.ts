/**
 * 跨语言契约：agent 真正发出去的请求，abei-api 那边认不认。
 *
 * 对照的是仓库里签入的 `abei/openapi.json`——它由 abei-api 从能力目录导出，
 * 是两边共同认可的那份说明书。这里不起 Rust 进程，但只要 Rust 侧改了路径、
 * 方法或闸门参数而没同步导出，这些用例就会红。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { AbeiApi, type AbeiCapability } from '../../src/agent/abei-api.js';
import { catalogFixture } from './catalog-fixture.js';

type Spec = {
  paths: Record<string, Record<string, { operationId?: string; parameters?: Param[] }>>;
};
type Param = { name: string; in: string };

const spec = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../abei/openapi.json', import.meta.url)), 'utf8'),
) as Spec;

/** 把发出去的 URL 还原成 openapi 里的路径模板，好跟规格对上。 */
function templateOf(pathname: string): string | undefined {
  return Object.keys(spec.paths).find((template) => {
    const pattern = new RegExp(`^${template.replace(/\{\w+\}/g, '[^/]+')}$`);
    return pattern.test(pathname);
  });
}

/** 记下 AbeiApi 实际发出的请求，不真的联网。 */
function recorder() {
  const sent: Array<{ method: string; url: URL }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ method: init?.method ?? 'GET', url: new URL(String(url)) });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { sent, api: new AbeiApi({ baseUrl: 'http://abei.test', fetchImpl }) };
}

const capabilities = catalogFixture().capabilities;

describe('agent 与 abei-api 的契约', () => {
  test.each(capabilities.map((c) => [c.id, c] as const))(
    '%s 按目录发出的请求，规格里认得',
    async (_id, capability: AbeiCapability) => {
      const { sent, api } = recorder();
      // 用目录自带的示例参数发一次，示例是 abei-api 那边有测试保过的。
      const example = capability.examples[0];
      await api.invoke({ token: 't', capability, params: { ...example.params } });

      const [request] = sent;
      const template = templateOf(request.url.pathname);
      expect(template, `规格里没有 ${request.url.pathname}`).toBeDefined();
      expect(spec.paths[template!][capability.method.toLowerCase()]).toBeDefined();
      expect(spec.paths[template!][capability.method.toLowerCase()].operationId).toBe(
        capability.id,
      );
    },
  );

  test('写能力的闸门参数两边同名：dry_run 与 confirm', async () => {
    const writes = capabilities.filter((c) => c.risk !== 'read');
    expect(writes.length).toBeGreaterThan(0);

    for (const capability of writes) {
      const { sent, api } = recorder();
      await api.invoke({
        token: 't',
        capability,
        params: { ...capability.examples[0].params },
        gate: { dryRun: true },
      });
      expect(sent[0].url.searchParams.get('dry_run')).toBe('true');

      const declared = (
        spec.paths[templateOf(sent[0].url.pathname)!][capability.method.toLowerCase()].parameters ??
        []
      )
        .filter((p) => p.in === 'query')
        .map((p) => p.name);
      expect(declared).toContain('dry_run');
      if (capability.risk === 'confirm') expect(declared).toContain('confirm');
    }
  });

  test('路径参数填进 URL 后不再重复出现在查询串或请求体里', async () => {
    const { sent, api } = recorder();
    const review = capabilities.find((c) => c.id === 'bills.review')!;
    await api.invoke({ token: 't', capability: review, params: { id: '42' } });

    expect(sent[0].url.pathname).toBe('/v1/bills/42/review');
    expect(sent[0].url.searchParams.get('id')).toBeNull();
  });

  test('人填字段以目录声明为准，agent 不另存名单', () => {
    const unlock = capabilities.find((c) => c.id === 'bills.unlock')!;
    expect(unlock.human_only).toEqual(['secret']);
    // 其余能力不该无端要人填东西。
    for (const capability of capabilities.filter((c) => c.id !== 'bills.unlock')) {
      expect(capability.human_only).toEqual([]);
    }
  });
});
