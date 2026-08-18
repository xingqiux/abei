/**
 * 学习闭环：信号怎么认、规则什么时候才写、失效怎么搬。
 *
 * 这些用例守的是「阿贝在什么条件下才敢动用户的规则文档」。阈值和冲突判断
 * 松一格，用户就会看见自己没写过的规则——所以这里的数字都是有意的。
 * 全程不连库不连服务：文档读写用假 fetch。
 */

import { describe, expect, test, vi } from 'vitest';

import {
  aggregate,
  classifyRow,
  decideRuleChanges,
  merchantKeyword,
  runLearning,
  type LearnSignal,
} from '../../src/agent/learn.js';
import { RunLog } from '../../src/agent/ai-runs.js';
import { parseMerchantRules } from '../../src/agent/rule-doc.js';
import { FireflyHttpClient } from '../../src/core/http-client.js';
import type { AiStore } from '../../src/agent/store.js';

const RULES_DOC = [
  '# 个人记账规则',
  '',
  '## 商户固定分类',
  '- 商户名含「滴滴」 → 交通出行',
  '',
  '## 已失效规则',
  '- （不再适用的规则搬到这里）',
  '',
].join('\n');

describe('信号识别', () => {
  test('人改成了别的分类，算一次纠正', () => {
    expect(
      classifyRow(
        {
          status: 'pending',
          userModifiedAt: '2026-08-14T10:00:00Z',
          categoryName: '交通出行',
          counterparty: '滴滴出行',
        },
        '餐饮',
      ),
    ).toEqual({ merchant: '滴滴出行', categoryName: '交通出行', kind: 'corrected' });
  });

  test('分类变了但没人碰过，不当信号', () => {
    expect(
      classifyRow({ status: 'pending', categoryName: '交通出行', counterparty: '滴滴出行' }, '餐饮'),
    ).toBeUndefined();
  });

  test('原样入账算一次确认', () => {
    expect(
      classifyRow({ status: 'imported', categoryName: '餐饮', counterparty: '星巴克' }, '餐饮'),
    ).toEqual({ merchant: '星巴克', categoryName: '餐饮', kind: 'confirmed' });
  });

  test('建议还挂在那儿没人处理，不当信号', () => {
    expect(
      classifyRow({ status: 'pending', categoryName: '餐饮', counterparty: '星巴克' }, '餐饮'),
    ).toBeUndefined();
  });

  test('商户名认不出来就不学', () => {
    expect(
      classifyRow({ status: 'imported', categoryName: '餐饮', counterparty: '2026081512345' }, '餐饮'),
    ).toBeUndefined();
  });
});

describe('商户名清洗', () => {
  test('剥掉支付渠道前缀', () => {
    expect(merchantKeyword({ counterparty: '财付通-星巴克' })).toBe('星巴克');
    expect(merchantKeyword({ counterparty: '支付宝-盒马鲜生' })).toBe('盒马鲜生');
  });

  test('括号里的门店和订单号砍掉', () => {
    expect(merchantKeyword({ counterparty: '星巴克（国贸店）' })).toBe('星巴克');
    expect(merchantKeyword({ counterparty: '美团外卖|20260815001' })).toBe('美团外卖');
  });

  test('公司后缀去掉', () => {
    expect(merchantKeyword({ counterparty: '北京滴滴出行科技有限公司' })).toBe('北京滴滴出行科技');
  });

  test('没有交易对方就退回描述', () => {
    expect(merchantKeyword({ description: '肯德基宅急送' })).toBe('肯德基宅急送');
  });

  test('太短、纯数字、洗不干净的都认不出', () => {
    expect(merchantKeyword({ counterparty: '甲' })).toBeUndefined();
    expect(merchantKeyword({ counterparty: '2026081500001' })).toBeUndefined();
    expect(
      merchantKeyword({ counterparty: '这是一段很长的说明文字看起来根本不像是个商户名字' }),
    ).toBeUndefined();
    expect(merchantKeyword({})).toBeUndefined();
  });
});

describe('规则候选判定', () => {
  function signals(merchant: string, category: string, kind: LearnSignal['kind'], times: number) {
    return Array.from({ length: times }, () => ({ merchant, categoryName: category, kind }));
  }

  test('攒够三次一致才写一条新规则', () => {
    const twoTimes = decideRuleChanges(aggregate(signals('星巴克', '餐饮', 'confirmed', 2)), []);
    expect(twoTimes.learned).toEqual([]);

    const threeTimes = decideRuleChanges(aggregate(signals('星巴克', '餐饮', 'confirmed', 3)), []);
    expect(threeTimes.learned).toEqual([
      { merchant: '星巴克', categoryName: '餐饮', corrected: 0, confirmed: 3 },
    ]);
  });

  test('纠正和确认合起来算次数', () => {
    const mixed = [
      ...signals('星巴克', '餐饮', 'confirmed', 2),
      ...signals('星巴克', '餐饮', 'corrected', 1),
    ];
    expect(decideRuleChanges(aggregate(mixed), []).learned).toHaveLength(1);
  });

  test('同一个商户出现两种分类就当有冲突，一条也不动', () => {
    const conflicting = [
      ...signals('星巴克', '餐饮', 'confirmed', 3),
      ...signals('星巴克', '零食', 'corrected', 1),
    ];
    expect(decideRuleChanges(aggregate(conflicting), [])).toEqual({ learned: [], retired: [] });
  });

  test('已有规则管着而且方向一致，什么都不做', () => {
    const rules = parseMerchantRules(RULES_DOC);
    const changes = decideRuleChanges(
      aggregate(signals('滴滴出行', '交通出行', 'confirmed', 5)),
      rules,
    );
    expect(changes).toEqual({ learned: [], retired: [] });
  });

  test('已有规则被反复推翻，搬进失效并写上新的', () => {
    const rules = parseMerchantRules(RULES_DOC);
    const changes = decideRuleChanges(
      aggregate(signals('滴滴出行', '差旅', 'corrected', 3)),
      rules,
    );
    expect(changes.retired.map((item) => item.rule.line)).toEqual([
      '- 商户名含「滴滴」 → 交通出行',
    ]);
    expect(changes.learned).toEqual([
      {
        merchant: '滴滴出行',
        categoryName: '差旅',
        corrected: 3,
        confirmed: 0,
        replaces: '- 商户名含「滴滴」 → 交通出行',
      },
    ]);
  });

  test('推翻旧规则只认纠正，确认次数不顶用', () => {
    const rules = parseMerchantRules(RULES_DOC);
    const mixed = [
      ...signals('滴滴出行', '差旅', 'corrected', 2),
      ...signals('滴滴出行', '差旅', 'confirmed', 5),
    ];
    expect(decideRuleChanges(aggregate(mixed), rules)).toEqual({ learned: [], retired: [] });
  });

  test('两个商户推翻同一条规则，那一行只搬一次', () => {
    const rules = parseMerchantRules(RULES_DOC);
    const both = [
      ...signals('滴滴出行', '差旅', 'corrected', 3),
      ...signals('滴滴专车', '差旅', 'corrected', 3),
    ];
    const changes = decideRuleChanges(aggregate(both), rules);
    expect(changes.retired).toHaveLength(1);
    expect(changes.learned).toHaveLength(2);
  });
});

/** 假的 abei-api：给一份账单流水和一份规则文档，记下写回去的是什么。 */
function stubApi(rows: Array<Record<string, unknown>>) {
  const saved: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('/v1/bills/')) {
      return new Response(
        JSON.stringify({
          data: rows.map((attributes, index) => ({
            id: String(index + 1),
            attributes,
          })),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (href.includes('/v1/profile-doc/')) {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({ data: { content_md: RULES_DOC, version: 4 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      saved.push({ url: href, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  });
  return { fetchImpl, saved };
}

function stubStore(rowIds: string[]): AiStore {
  return {
    listAiRuns: async () => [
      {
        id: 'run-1',
        kind: 'autofill',
        trigger: 'auto' as const,
        started_at: '2026-08-14T00:00:00Z',
        status: 'succeeded' as const,
        summary: {},
        detail: rowIds.map((rowId) => ({
          kind: 'bill_row',
          task_id: 7,
          row_id: rowId,
          values: { category_name: '餐饮' },
          basis: 'model',
        })),
      },
    ],
  } as unknown as AiStore;
}

describe('一整轮学习', () => {
  test('攒够信号就静默写回新版本，并逐条记进工作记录', async () => {
    const rows = Array.from({ length: 3 }, () => ({
      status: 'pending',
      user_modified_at: '2026-08-14T10:00:00Z',
      category_name: '差旅',
      counterparty: '滴滴出行',
    }));
    const { fetchImpl, saved } = stubApi(rows);
    const log = new RunLog();
    const stats = await runLearning({
      ownerKey: 'owner',
      client: new FireflyHttpClient({
        baseUrl: 'http://abei.test',
        token: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      abeiUrl: 'http://abei.test',
      store: stubStore(['1', '2', '3']),
      log,
      today: '2026-08-15',
    });

    expect(stats).toEqual({ signals: 3, learned: 1, retired: 1 });
    expect(saved).toHaveLength(1);
    expect(saved[0].url).toContain('confirm=true');
    expect(saved[0].body.expected_version).toBe(4);
    expect(saved[0].body.source).toBe('cli');
    const contentMd = String(saved[0].body.content_md);
    expect(contentMd).toContain('- 商户名含「滴滴出行」 → 差旅');
    expect(contentMd).toContain(
      '- 商户名含「滴滴」 → 交通出行（2026-08-15 起不再适用：最近 3 次都改成了「差旅」）',
    );
    // 搬走的那一行不能还留在生效那一块里。
    expect(parseMerchantRules(contentMd).map((rule) => rule.pattern)).toEqual(['滴滴出行']);
    expect(log.entries.map((entry) => entry.kind)).toEqual(['rule_retired', 'rule_learned']);
  });

  test('信号不够就一个字节都不写', async () => {
    const rows = [
      {
        status: 'imported',
        category_name: '餐饮',
        counterparty: '星巴克',
      },
    ];
    const { fetchImpl, saved } = stubApi(rows);
    const stats = await runLearning({
      ownerKey: 'owner',
      client: new FireflyHttpClient({
        baseUrl: 'http://abei.test',
        token: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      abeiUrl: 'http://abei.test',
      store: stubStore(['1']),
      log: new RunLog(),
    });
    expect(stats).toEqual({ signals: 1, learned: 0, retired: 0 });
    expect(saved).toEqual([]);
  });

  test('规则文档刚被人改过（409）就等下一轮，不覆盖', async () => {
    const rows = Array.from({ length: 3 }, () => ({
      status: 'imported',
      category_name: '餐饮',
      counterparty: '星巴克',
    }));
    const { fetchImpl } = stubApi(rows);
    fetchImpl.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/v1/bills/')) {
        return new Response(
          JSON.stringify({
            data: rows.map((attributes, index) => ({ id: String(index + 1), attributes })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ data: { content_md: RULES_DOC, version: 4 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ detail: '版本对不上' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const log = new RunLog();
    const stats = await runLearning({
      ownerKey: 'owner',
      client: new FireflyHttpClient({
        baseUrl: 'http://abei.test',
        token: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      abeiUrl: 'http://abei.test',
      store: stubStore(['1', '2', '3']),
      log,
    });
    expect(stats).toEqual({ signals: 3, learned: 0, retired: 0 });
    expect(log.entries).toEqual([]);
  });

  test('还没建规则文档就收工，不替人凭空建一份', async () => {
    const rows = Array.from({ length: 3 }, () => ({
      status: 'imported',
      category_name: '餐饮',
      counterparty: '星巴克',
    }));
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/v1/bills/')) {
        return new Response(
          JSON.stringify({
            data: rows.map((attributes, index) => ({ id: String(index + 1), attributes })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ detail: '没有这份文档' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const stats = await runLearning({
      ownerKey: 'owner',
      client: new FireflyHttpClient({
        baseUrl: 'http://abei.test',
        token: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      abeiUrl: 'http://abei.test',
      store: stubStore(['1', '2', '3']),
      log: new RunLog(),
    });
    expect(stats).toEqual({ signals: 3, learned: 0, retired: 0 });
  });
});
