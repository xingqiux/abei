import type { AssistantMessage } from '@earendil-works/pi-ai';

import type { ModelRuntime } from './model-runtime.js';
import { record, trimmed } from './shared.js';

/** 首次加两次重试。解析不出 JSON 就让调用方跳过这一批。 */
const MODEL_ATTEMPTS = 3;

/**
 * 问模型要一个 {"rows":[...]} 的 JSON 对象。预填和回填共用这一条通路，
 * 重试策略、JSON 抠取、错误语义都只写一遍。
 */
export async function askModelRows(args: {
  runtime: ModelRuntime;
  systemPrompt: string;
  prompt: string;
  /** 每次真正发出请求时回调一次，调用方拿去记 model_calls。 */
  onCall?: () => void;
}): Promise<Array<Record<string, unknown>>> {
  const { runtime, systemPrompt, prompt } = args;
  const model = runtime.model;
  if (!model) throw new Error('模型不可用。');
  let lastError: unknown = new Error('模型没有返回可解析的 JSON。');

  for (let attempt = 1; attempt <= MODEL_ATTEMPTS; attempt += 1) {
    const message =
      attempt === 1
        ? prompt
        : `${prompt}\n\n上一次的回答不是合法 JSON。只输出 {"rows":[...]} 这一个 JSON 对象。`;
    args.onCall?.();
    try {
      const reply = await runtime.models.completeSimple(
        model,
        {
          systemPrompt,
          messages: [{ role: 'user', content: message, timestamp: Date.now() }],
        },
        { reasoning: 'low', maxTokens: 4_096 },
      );
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
        throw new Error(reply.errorMessage ?? '模型请求失败。');
      }
      return parseRows(assistantText(reply));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** 按 row_id 对齐模型答案和送进去的条目；模型编出来的 row_id 直接丢掉。 */
export function pairAnswers<T>(
  answers: Array<Record<string, unknown>>,
  items: T[],
  keyOf: (item: T) => string,
): Array<[Record<string, unknown>, T]> {
  const byKey = new Map(items.map((item) => [keyOf(item), item]));
  const pairs: Array<[Record<string, unknown>, T]> = [];
  for (const answer of answers) {
    const rowId = trimmed(answer.row_id, 32) ?? numericText(answer.row_id);
    const item = rowId ? byKey.get(rowId) : undefined;
    if (item) pairs.push([answer, item]);
  }
  return pairs;
}

export function parseRows(text: string): Array<Record<string, unknown>> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型回答里没有 JSON 对象。');
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  const rows = record(parsed)?.rows;
  if (!Array.isArray(rows)) throw new Error('模型回答缺少 rows 数组。');
  return rows.flatMap((row) => {
    const item = record(row);
    return item ? [item] : [];
  });
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
}

function numericText(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? String(value) : undefined;
}
