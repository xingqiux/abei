import type { FireflyHttpClient } from '../core/http-client.js';

/**
 * 后台预填循环用的账单读写口，直连 Firefly。
 *
 * 面向模型的能力一律走 abei-api（见 agent/abei-api.ts）；这里留的是 worker 的路：
 * 它按自己存的 PAT 定时跑，而且要按任务翻流水行——那是目录里没有的形状。
 * 目录补上「列某份账单的流水行」以后，这个文件就该整体退役。
 */

const ENDPOINT = '/api/v1/bill-tasks';
const ROW_ENDPOINT = '/api/v1/bill-statement-rows';

export interface BillTaskListFilters {
  source?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export interface BillStatementRowFilters {
  status?: string;
  from?: string;
  to?: string;
  summary?: boolean;
  limit?: number;
}

export class BillTaskService {
  constructor(private readonly client: FireflyHttpClient) {}

  list(filters: BillTaskListFilters = {}): Promise<unknown> {
    return this.client.request('GET', ENDPOINT, {
      query: {
        source: filters.source,
        status: filters.status,
        page: filters.page,
        limit: filters.limit,
      },
    });
  }

  rows(taskId: string, filters: BillStatementRowFilters = {}): Promise<unknown> {
    return this.client.request('GET', `${taskPath(taskId)}/rows`, {
      query: {
        status: filters.status,
        from: filters.from,
        to: filters.to,
        summary: filters.summary,
        limit: filters.limit,
      },
    });
  }

  /** 服务端已经分好桶、脱过敏的审阅视图，是改流水之前的主入口。 */
  review(taskId: string): Promise<unknown> {
    return this.client.request('GET', `${taskPath(taskId)}/review`);
  }

  /**
   * 机器写入的唯一通路：永远带 as_suggestion，服务端据此落 suggested_by='ai'，
   * 由人在收件箱确认。
   */
  suggestRow(rowId: string, values: Record<string, unknown>): Promise<unknown> {
    return this.client.request('PATCH', rowPath(rowId), {
      json: { ...values, as_suggestion: true },
    });
  }
}

function taskPath(taskId: string): string {
  return `${ENDPOINT}/${encodeURIComponent(taskId)}`;
}

function rowPath(rowId: string): string {
  return `${ROW_ENDPOINT}/${encodeURIComponent(rowId)}`;
}
