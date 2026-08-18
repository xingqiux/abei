/**
 * 工作记录的记账规矩：空跑不记、有产出才记、报错也要记、记账失败不影响正事。
 */

import { describe, expect, test, vi } from 'vitest';

import { withAiRun, type AiRunSink } from '../../src/agent/ai-runs.js';
import type { AiRun } from '../../src/agent/store.js';

function sink() {
  const saved: Array<Record<string, unknown>> = [];
  const store: AiRunSink = {
    recordAiRun: async (ownerKey, args) => {
      saved.push({ ownerKey, ...args });
      return { id: 'run-1' } as AiRun;
    },
  };
  return { store, saved };
}

describe('withAiRun', () => {
  test('有产出就记一笔，摘要和明细都落下来', async () => {
    const { store, saved } = sink();
    const result = await withAiRun({
      store,
      ownerKey: 'owner-1',
      kind: 'autofill',
      trigger: 'manual',
      run: async (log) => {
        log.add({ row_id: '7', basis: 'rule:- 商户名含「滴滴」 → 交通出行' });
        return { rows: 1 };
      },
      isEmpty: (value) => value.rows === 0,
      summarize: (value) => ({ rows: value.rows }),
    });

    expect(result).toEqual({ rows: 1 });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      ownerKey: 'owner-1',
      kind: 'autofill',
      trigger: 'manual',
      status: 'succeeded',
      summary: { rows: 1 },
    });
    expect(saved[0].detail).toEqual([{ row_id: '7', basis: 'rule:- 商户名含「滴滴」 → 交通出行' }]);
  });

  test('空跑不留记录', async () => {
    const { store, saved } = sink();
    await withAiRun({
      store,
      ownerKey: 'owner-1',
      kind: 'backfill',
      trigger: 'auto',
      run: async () => ({ rows: 0 }),
      isEmpty: (value) => value.rows === 0,
      summarize: () => ({}),
    });
    expect(saved).toEqual([]);
  });

  test('炸了要记一条 failed，异常照样往外抛', async () => {
    const { store, saved } = sink();
    await expect(
      withAiRun({
        store,
        ownerKey: 'owner-1',
        kind: 'autofill',
        trigger: 'auto',
        run: async () => {
          throw new Error('模型不可用。');
        },
        isEmpty: () => true,
        summarize: () => ({}),
      }),
    ).rejects.toThrow('模型不可用。');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ status: 'failed', error: '模型不可用。' });
  });

  test('备注并进摘要，比如「规则指向不存在的分类」', async () => {
    const { store, saved } = sink();
    await withAiRun({
      store,
      ownerKey: 'owner-1',
      kind: 'autofill',
      trigger: 'auto',
      run: async (log) => {
        log.note('规则指向不存在的分类：- 商户名含「幽灵店」 → 不存在的分类');
        log.note('规则指向不存在的分类：- 商户名含「幽灵店」 → 不存在的分类');
        log.add({ row_id: '1', basis: 'model' });
        return { rows: 1 };
      },
      isEmpty: () => false,
      summarize: () => ({ rows: 1 }),
    });
    expect(saved[0].summary).toEqual({
      rows: 1,
      notes: ['规则指向不存在的分类：- 商户名含「幽灵店」 → 不存在的分类'],
    });
  });

  test('记账写不进去也不该影响正事', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store: AiRunSink = {
      recordAiRun: async () => {
        throw new Error('库挂了');
      },
    };
    await expect(
      withAiRun({
        store,
        ownerKey: 'owner-1',
        kind: 'vocab_scan',
        trigger: 'auto',
        run: async () => ({ created: 2 }),
        isEmpty: (value) => value.created === 0,
        summarize: (value) => ({ rows: value.created }),
      }),
    ).resolves.toEqual({ created: 2 });
    expect(error).toHaveBeenCalled();
  });
});
