import type { FireflyHttpClient } from '../core/http-client.js';

const ENDPOINT = '/api/v1/bill-tasks';
const ROW_ENDPOINT = '/api/v1/bill-statement-rows';
const INBOX_ENDPOINT = '/api/v1/bill-inbox';
const ARTIFACT_ENDPOINT = '/api/v1/bill-artifacts';

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

export interface BillStatementImportOptions {
  all?: boolean;
  rowIds?: number[];
  confirm?: boolean;
  includePayload?: boolean;
}

export interface BillStatementRowSplit {
  payment_method?: string;
  source_name?: string;
  amount: string;
}

export interface BillInboxSettingsUpdate {
  enabled?: boolean;
  provider?: string;
  email?: string;
  host?: string;
  port?: number;
  encryption?: string;
  username?: string;
  password?: string;
  folder?: string;
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

  show(taskId: string): Promise<unknown> {
    return this.client.request('GET', taskPath(taskId));
  }

  artifacts(taskId: string): Promise<unknown> {
    return this.client.request('GET', `${taskPath(taskId)}/artifacts`);
  }

  events(taskId: string): Promise<unknown> {
    return this.client.request('GET', `${taskPath(taskId)}/events`);
  }

  submitSecret(taskId: string, value: string): Promise<unknown> {
    return this.client.request('POST', `${taskPath(taskId)}/secret`, { json: { value } });
  }

  ignore(taskId: string): Promise<unknown> {
    return this.client.request('POST', `${taskPath(taskId)}/ignore`, { json: {} });
  }

  retry(taskId: string): Promise<unknown> {
    return this.client.request('POST', `${taskPath(taskId)}/retry`, { json: {} });
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

  review(taskId: string): Promise<unknown> {
    return this.client.request('GET', `${taskPath(taskId)}/review`);
  }

  showRow(rowId: string): Promise<unknown> {
    return this.client.request('GET', rowPath(rowId));
  }

  updateRow(rowId: string, values: Record<string, unknown>): Promise<unknown> {
    return this.client.request('PATCH', rowPath(rowId), { json: values });
  }

  splitRow(rowId: string, splits: BillStatementRowSplit[]): Promise<unknown> {
    return this.client.request('POST', `${rowPath(rowId)}/split`, { json: { splits } });
  }

  importRows(taskId: string, options: BillStatementImportOptions): Promise<unknown> {
    const payload: Record<string, unknown> = {
      confirm: options.confirm ?? false,
    };
    if (options.all) {
      payload.all = true;
    } else {
      payload.row_ids = options.rowIds ?? [];
    }
    if (options.includePayload) {
      payload.include_payload = true;
    }

    return this.client.request('POST', `${taskPath(taskId)}/import`, { json: payload });
  }

  archive(taskId: string): Promise<unknown> {
    return this.client.request('POST', `${taskPath(taskId)}/archive`, { json: {} });
  }

  archiveMany(ids: number[]): Promise<unknown> {
    return this.client.request('POST', `${ENDPOINT}/archive`, { json: { ids } });
  }

  settings(): Promise<unknown> {
    return this.client.request('GET', `${INBOX_ENDPOINT}/settings`);
  }

  updateSettings(values: BillInboxSettingsUpdate): Promise<unknown> {
    return this.client.request('PUT', `${INBOX_ENDPOINT}/settings`, { json: values });
  }

  sync(limit?: number): Promise<unknown> {
    return this.client.request('POST', `${INBOX_ENDPOINT}/sync`, {
      json: undefined === limit ? {} : { limit },
    });
  }

  process(limit?: number): Promise<unknown> {
    return this.client.request('POST', `${INBOX_ENDPOINT}/process`, {
      json: undefined === limit ? {} : { limit },
    });
  }

  cleanupStale(): Promise<unknown> {
    return this.client.request('POST', `${INBOX_ENDPOINT}/cleanup-stale`, { json: {} });
  }

  downloadArtifact(artifactId: string): Promise<ArrayBuffer> {
    return this.client.download(`${ARTIFACT_ENDPOINT}/${encodeURIComponent(artifactId)}/download`);
  }
}

function taskPath(taskId: string): string {
  return `${ENDPOINT}/${encodeURIComponent(taskId)}`;
}

function rowPath(rowId: string): string {
  return `${ROW_ENDPOINT}/${encodeURIComponent(rowId)}`;
}
