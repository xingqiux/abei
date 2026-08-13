import type { FireflyHttpClient } from '../core/http-client.js';

/**
 * 后台预填循环用的账单读写口。客户端必须指向 abei-api；PAT 仍只作为
 * Authorization 请求头传给 API，由 API 验证身份后代理到 abei-server。
 */

const ENDPOINT = '/v1/bills';
const ROW_ENDPOINT = '/v1/bill-rows';

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
