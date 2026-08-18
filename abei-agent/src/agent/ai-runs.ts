/**
 * 「阿贝干过的活」记一笔。
 *
 * 包在预填/回填/词表扫描的内部执行函数上，定时触发和手动触发共用同一个函数，
 * 所以包一处就全覆盖，不必在每个入口各写一遍。
 *
 * 两条硬规矩：
 * - 空跑不记。没有待处理的行、没有产出，就不该在时间线上留一条「什么也没干」。
 * - 记账失败不影响正事。活已经干完了，写不进记录只该留一行日志。
 */

import { errorMessage } from './shared.js';
import type { AiRun, AiRunKind, AiRunTrigger } from './store.js';

/** 一条明细：这次给了哪一行什么建议、依据是什么。 */
export interface RunDetailEntry extends Record<string, unknown> {
  /** `rule:<规则原文行>`（代码层命中规则）、`doc`（模型看过规则文档）或 `model`（纯模型判断）。 */
  basis: string;
}

/** 执行过程中往里塞明细。跑批代码只跟这个接口打交道。 */
export class RunLog {
  readonly entries: RunDetailEntry[] = [];
  /** 跑批中间攒下来的备注，最后并进 summary（例如「规则指向不存在的分类」）。 */
  readonly notes: string[] = [];

  add(entry: RunDetailEntry): void {
    this.entries.push(entry);
  }

  note(text: string): void {
    if (text && !this.notes.includes(text)) this.notes.push(text);
  }
}

/** 只用到 store 的这一个方法，测试塞个对象就行，不必起数据库。 */
export interface AiRunSink {
  recordAiRun(
    ownerKey: string,
    args: {
      kind: AiRunKind;
      trigger: AiRunTrigger;
      startedAt: Date;
      status: 'succeeded' | 'failed';
      summary: Record<string, unknown>;
      detail: unknown[];
      error?: string;
    },
  ): Promise<AiRun>;
}

export interface AiRunOptions<T> {
  store: AiRunSink;
  ownerKey: string;
  kind: AiRunKind;
  trigger: AiRunTrigger;
  /** 跑批本体。往 log 里塞明细，返回值原样透给调用方。 */
  run: (log: RunLog) => Promise<T>;
  /** 这一轮到底干没干活。返回 true 就不留记录。 */
  isEmpty: (result: T, log: RunLog) => boolean;
  /** 时间线那一行要显示的数。 */
  summarize: (result: T, log: RunLog) => Record<string, unknown>;
}

/**
 * 跑一轮并记一笔。返回值和异常都原样透传，调用方感觉不到这层包装。
 * 失败一律记录——报错不算「空跑」，人得看得见它炸过。
 */
export async function withAiRun<T>(options: AiRunOptions<T>): Promise<T> {
  const startedAt = new Date();
  const log = new RunLog();
  let result: T;
  try {
    result = await options.run(log);
  } catch (error) {
    await save(options, {
      startedAt,
      status: 'failed',
      summary: withNotes({}, log),
      detail: log.entries,
      error: errorMessage(error),
    });
    throw error;
  }
  if (!options.isEmpty(result, log)) {
    await save(options, {
      startedAt,
      status: 'succeeded',
      summary: withNotes(options.summarize(result, log), log),
      detail: log.entries,
    });
  }
  return result;
}

function withNotes(summary: Record<string, unknown>, log: RunLog): Record<string, unknown> {
  return log.notes.length ? { ...summary, notes: [...log.notes] } : summary;
}

async function save<T>(
  options: AiRunOptions<T>,
  args: {
    startedAt: Date;
    status: 'succeeded' | 'failed';
    summary: Record<string, unknown>;
    detail: unknown[];
    error?: string;
  },
): Promise<void> {
  try {
    await options.store.recordAiRun(options.ownerKey, {
      kind: options.kind,
      trigger: options.trigger,
      ...args,
    });
  } catch (error) {
    console.error(`[ai-runs] ${options.kind} 记录写入失败：${errorMessage(error)}`);
  }
}
