import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Pool } from 'pg';

import type { ModelConfig } from './model-config.js';

export interface AiSession {
  id: string;
  title: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  pendingApprovals: number;
}

export interface AiApproval {
  id: string;
  sessionId: string;
  capability: string;
  input: Record<string, unknown>;
  preview: unknown;
  status: 'pending' | 'executing' | 'approved' | 'rejected';
  result: unknown;
  createdAt: string;
  decidedAt?: string;
}

export interface AutofillConfig {
  ownerKey: string;
  enabled: boolean;
  intervalSeconds: number;
  /** 后台 worker 用的 Firefly PAT；只在服务端解密，永不回给前端。 */
  token?: string;
  updatedAt: string;
}

/**
 * 下面几个记录直接当 HTTP 响应体发出去，字段名是和 web 端对好的线上契约，
 * 所以用 snake_case，跟表的列名一一对应。改名字前先和前端对齐。
 */

export type AiRunKind = 'autofill' | 'backfill' | 'vocab_scan' | 'learn';
export type AiRunTrigger = 'auto' | 'manual';
export type AiRunStatus = 'running' | 'succeeded' | 'failed';

/**
 * 阿贝干过的一件活。摘要给时间线上那一行看，明细给展开后逐条看。
 * 空跑不落库，所以这张表里的每一条都确实产出过东西（或者确实炸了）。
 */
export interface AiRun {
  id: string;
  kind: string;
  trigger: AiRunTrigger;
  started_at: string;
  finished_at?: string;
  status: AiRunStatus;
  summary: Record<string, unknown>;
  /** 只有单条详情接口才带；列表接口不返回，免得把整页撑爆。 */
  detail?: unknown[];
  error?: string;
}

export type VocabSuggestionAction = 'enable' | 'create';
export type VocabSuggestionStatus = 'pending' | 'accepted' | 'ignored';

export interface VocabSuggestion {
  id: string;
  action: VocabSuggestionAction;
  domain: string;
  /** action='enable' 必带：要启用的那个已禁用分类。 */
  category_id?: string;
  name: string;
  parent_id?: string;
  parent_name?: string;
  icon?: string;
  color?: string;
  reason?: string;
  sample_count: number;
  samples: string[];
  status: VocabSuggestionStatus;
  created_at: string;
  resolved_at?: string;
}

export type BackfillSuggestionSource = 'rule' | 'model';
export type BackfillSuggestionStatus = 'pending' | 'applied' | 'rejected';

export interface BackfillSuggestion {
  journal_id: string;
  transaction_group_id?: string;
  date?: string;
  description?: string;
  amount?: string;
  currency_code?: string;
  category_id?: string;
  category_name: string;
  source: BackfillSuggestionSource;
  status: BackfillSuggestionStatus;
  created_at: string;
}

export const DEFAULT_AUTOFILL_INTERVAL_SECONDS = 300;

/** 工作记录只留这么久，过期的在进程启动时清掉。 */
export const AI_RUN_RETENTION_DAYS = 90;

/** 忽略过的词表建议在这个天数内不再重复生成。 */
export const VOCAB_IGNORE_COOLDOWN_DAYS = 30;

export class AiStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionSecret?: string,
  ) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS abei_ai;

      CREATE TABLE IF NOT EXISTS abei_ai.sessions (
        id uuid PRIMARY KEY,
        owner_key text NOT NULL,
        title text NOT NULL,
        provider text NOT NULL,
        model text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS ai_sessions_owner_updated
        ON abei_ai.sessions (owner_key, updated_at DESC);

      CREATE TABLE IF NOT EXISTS abei_ai.messages (
        session_id uuid NOT NULL REFERENCES abei_ai.sessions(id) ON DELETE CASCADE,
        ordinal integer NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS abei_ai.approvals (
        id uuid PRIMARY KEY,
        session_id uuid NOT NULL REFERENCES abei_ai.sessions(id) ON DELETE CASCADE,
        capability text NOT NULL,
        input jsonb NOT NULL,
        preview jsonb,
        status text NOT NULL CHECK (status IN ('pending', 'executing', 'approved', 'rejected')),
        result jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        decided_at timestamptz
      );

      CREATE INDEX IF NOT EXISTS ai_approvals_session_status
        ON abei_ai.approvals (session_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS abei_ai.model_configs (
        owner_key text PRIMARY KEY,
        encrypted_config text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS abei_ai.autofill_config (
        owner_key text PRIMARY KEY,
        enabled boolean NOT NULL DEFAULT false,
        interval_seconds integer NOT NULL DEFAULT ${DEFAULT_AUTOFILL_INTERVAL_SECONDS},
        encrypted_token text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS abei_ai.ai_runs (
        id uuid PRIMARY KEY,
        owner_key text NOT NULL,
        kind text NOT NULL,
        trigger text NOT NULL CHECK (trigger IN ('auto', 'manual')),
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        summary jsonb NOT NULL DEFAULT '{}'::jsonb,
        detail jsonb NOT NULL DEFAULT '[]'::jsonb,
        error text
      );

      CREATE INDEX IF NOT EXISTS ai_runs_owner_started
        ON abei_ai.ai_runs (owner_key, started_at DESC);

      CREATE TABLE IF NOT EXISTS abei_ai.vocab_suggestions (
        id uuid PRIMARY KEY,
        owner_key text NOT NULL,
        action text NOT NULL CHECK (action IN ('enable', 'create')),
        domain text NOT NULL,
        category_id text,
        name text NOT NULL,
        parent_id text,
        parent_name text,
        icon text,
        color text,
        reason text,
        sample_count integer NOT NULL DEFAULT 0,
        samples jsonb NOT NULL DEFAULT '[]'::jsonb,
        status text NOT NULL CHECK (status IN ('pending', 'accepted', 'ignored')),
        created_at timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz
      );

      CREATE INDEX IF NOT EXISTS ai_vocab_suggestions_owner_status
        ON abei_ai.vocab_suggestions (owner_key, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS abei_ai.backfill_suggestions (
        owner_key text NOT NULL,
        journal_id text NOT NULL,
        transaction_group_id text,
        date text,
        description text,
        amount text,
        currency_code text,
        category_id text,
        category_name text NOT NULL,
        source text NOT NULL CHECK (source IN ('rule', 'model')),
        status text NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_key, journal_id)
      );

      CREATE INDEX IF NOT EXISTS ai_backfill_suggestions_owner_status
        ON abei_ai.backfill_suggestions (owner_key, status, created_at DESC);
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getModelConfig(ownerKey: string): Promise<ModelConfig | undefined> {
    const result = await this.pool.query(
      'SELECT encrypted_config FROM abei_ai.model_configs WHERE owner_key = $1',
      [ownerKey],
    );
    if (!result.rowCount) return undefined;
    return decryptModelConfig(
      String(result.rows[0].encrypted_config),
      this.requiredEncryptionSecret(),
    );
  }

  async saveModelConfig(ownerKey: string, config: ModelConfig): Promise<void> {
    const encrypted = encryptModelConfig(config, this.requiredEncryptionSecret());
    await this.pool.query(
      `INSERT INTO abei_ai.model_configs (owner_key, encrypted_config)
       VALUES ($1, $2)
       ON CONFLICT (owner_key) DO UPDATE
       SET encrypted_config = excluded.encrypted_config, updated_at = now()`,
      [ownerKey, encrypted],
    );
  }

  async deleteModelConfig(ownerKey: string): Promise<void> {
    await this.pool.query('DELETE FROM abei_ai.model_configs WHERE owner_key = $1', [ownerKey]);
  }

  async getAutofillConfig(ownerKey: string): Promise<AutofillConfig | undefined> {
    const result = await this.pool.query(
      `SELECT owner_key, enabled, interval_seconds, encrypted_token, updated_at
       FROM abei_ai.autofill_config WHERE owner_key = $1`,
      [ownerKey],
    );
    return result.rowCount ? this.autofillFromRow(result.rows[0]) : undefined;
  }

  /** 进程启动时用：把已开启的用户排进 worker 的定时器。 */
  async listAutofillConfigs(): Promise<AutofillConfig[]> {
    const result = await this.pool.query(
      `SELECT owner_key, enabled, interval_seconds, encrypted_token, updated_at
       FROM abei_ai.autofill_config WHERE enabled = true`,
    );
    return result.rows.map((row) => this.autofillFromRow(row));
  }

  /** token 传 undefined 表示「沿用已存的那份」，不是「清空」。 */
  async saveAutofillConfig(
    ownerKey: string,
    args: { enabled: boolean; intervalSeconds: number; token?: string },
  ): Promise<AutofillConfig> {
    const encrypted = this.encryptToken(args.token);
    const result = await this.pool.query(
      `INSERT INTO abei_ai.autofill_config (owner_key, enabled, interval_seconds, encrypted_token)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_key) DO UPDATE
       SET enabled = excluded.enabled,
           interval_seconds = excluded.interval_seconds,
           encrypted_token = coalesce(excluded.encrypted_token, abei_ai.autofill_config.encrypted_token),
           updated_at = now()
       RETURNING owner_key, enabled, interval_seconds, encrypted_token, updated_at`,
      [ownerKey, args.enabled, args.intervalSeconds, encrypted],
    );
    return this.autofillFromRow(result.rows[0]);
  }

  private encryptToken(token?: string): string | null {
    return token === undefined ? null : encryptPayload(token, this.requiredEncryptionSecret());
  }

  private autofillFromRow(row: Record<string, unknown>): AutofillConfig {
    const encrypted = row.encrypted_token;
    return {
      ownerKey: String(row.owner_key),
      enabled: row.enabled === true,
      intervalSeconds: Number(row.interval_seconds ?? DEFAULT_AUTOFILL_INTERVAL_SECONDS),
      token:
        typeof encrypted === 'string' && encrypted !== ''
          ? decryptPayload<string>(encrypted, this.requiredEncryptionSecret())
          : undefined,
      updatedAt: toIso(row.updated_at),
    };
  }

  /**
   * 记一件干完的活。空跑不该走到这里——调用方（ai-runs.ts）先判断有没有产出。
   * 明细整条存成 jsonb 数组，读的时候原样发给前端。
   */
  async recordAiRun(
    ownerKey: string,
    args: {
      kind: AiRunKind;
      trigger: AiRunTrigger;
      startedAt: Date;
      status: Exclude<AiRunStatus, 'running'>;
      summary: Record<string, unknown>;
      detail: unknown[];
      error?: string;
    },
  ): Promise<AiRun> {
    const result = await this.pool.query(
      `INSERT INTO abei_ai.ai_runs
         (id, owner_key, kind, trigger, started_at, finished_at, status, summary, detail, error)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7::jsonb, $8::jsonb, $9)
       RETURNING ${RUN_COLUMNS}, detail`,
      [
        randomUUID(),
        ownerKey,
        args.kind,
        args.trigger,
        args.startedAt,
        args.status,
        JSON.stringify(args.summary),
        JSON.stringify(args.detail.slice(0, MAX_RUN_DETAIL_ENTRIES)),
        args.error ?? null,
      ],
    );
    return aiRunFromRow(result.rows[0]);
  }

  /**
   * 时间线用：倒序分页，默认不带明细。
   *
   * `kind` 给页面按类别筛（/profile 只要 learn 那些）；`withDetail` 给学习闭环用：
   * 它要从预填记录的明细里翻出「当初建议的是什么分类」。
   */
  async listAiRuns(
    ownerKey: string,
    options: { limit?: number; offset?: number; kind?: string; withDetail?: boolean } = {},
  ): Promise<AiRun[]> {
    const limit = clampInt(options.limit, 50, 1, 200);
    const offset = clampInt(options.offset, 0, 0, 100_000);
    const result = await this.pool.query(
      `SELECT ${RUN_COLUMNS}${options.withDetail ? ', detail' : ''}
       FROM abei_ai.ai_runs
       WHERE owner_key = $1 AND ($4::text IS NULL OR kind = $4)
       ORDER BY started_at DESC
       LIMIT $2 OFFSET $3`,
      [ownerKey, limit, offset, options.kind ?? null],
    );
    return result.rows.map(aiRunFromRow);
  }

  async getAiRun(ownerKey: string, id: string): Promise<AiRun | undefined> {
    const result = await this.pool.query(
      `SELECT ${RUN_COLUMNS}, detail
       FROM abei_ai.ai_runs
       WHERE owner_key = $1 AND id = $2`,
      [ownerKey, id],
    );
    return result.rowCount ? aiRunFromRow(result.rows[0]) : undefined;
  }

  /** 进程启动时扫一次：太老的记录没人会翻，留着只是占地方。 */
  async pruneAiRuns(days = AI_RUN_RETENTION_DAYS): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM abei_ai.ai_runs WHERE started_at < now() - make_interval(days => $1::int)`,
      [days],
    );
    return result.rowCount ?? 0;
  }

  async listVocabSuggestions(
    ownerKey: string,
    status: VocabSuggestionStatus = 'pending',
  ): Promise<VocabSuggestion[]> {
    const result = await this.pool.query(
      `SELECT ${VOCAB_COLUMNS}
       FROM abei_ai.vocab_suggestions
       WHERE owner_key = $1 AND status = $2
       ORDER BY created_at DESC
       LIMIT 200`,
      [ownerKey, status],
    );
    return result.rows.map(vocabSuggestionFromRow);
  }

  async createVocabSuggestion(
    ownerKey: string,
    args: {
      action: VocabSuggestionAction;
      domain: string;
      categoryId?: string;
      name: string;
      parentId?: string;
      parentName?: string;
      icon?: string;
      color?: string;
      reason?: string;
      sampleCount: number;
      samples: string[];
    },
  ): Promise<VocabSuggestion> {
    const result = await this.pool.query(
      `INSERT INTO abei_ai.vocab_suggestions
         (id, owner_key, action, domain, category_id, name, parent_id, parent_name,
          icon, color, reason, sample_count, samples, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, 'pending')
       RETURNING ${VOCAB_COLUMNS}`,
      [
        randomUUID(),
        ownerKey,
        args.action,
        args.domain,
        args.categoryId ?? null,
        args.name,
        args.parentId ?? null,
        args.parentName ?? null,
        args.icon ?? null,
        args.color ?? null,
        args.reason ?? null,
        args.sampleCount,
        JSON.stringify(args.samples.slice(0, 20)),
      ],
    );
    return vocabSuggestionFromRow(result.rows[0]);
  }

  async resolveVocabSuggestion(
    ownerKey: string,
    id: string,
    status: Exclude<VocabSuggestionStatus, 'pending'>,
  ): Promise<VocabSuggestion | undefined> {
    const result = await this.pool.query(
      `UPDATE abei_ai.vocab_suggestions
       SET status = $3, resolved_at = now()
       WHERE id = $1 AND owner_key = $2 AND status = 'pending'
       RETURNING ${VOCAB_COLUMNS}`,
      [id, ownerKey, status],
    );
    return result.rowCount ? vocabSuggestionFromRow(result.rows[0]) : undefined;
  }

  /**
   * 扫描时用来闭嘴的名单：还挂着没处理的、已经同意过的，
   * 以及冷却期内被忽略过的分类名，都不再重复建议。
   */
  async mutedVocabCategoryNames(
    ownerKey: string,
    cooldownDays = VOCAB_IGNORE_COOLDOWN_DAYS,
  ): Promise<Set<string>> {
    const result = await this.pool.query(
      `SELECT DISTINCT name
       FROM abei_ai.vocab_suggestions
       WHERE owner_key = $1
         AND (
           status IN ('pending', 'accepted')
           OR (status = 'ignored' AND resolved_at > now() - make_interval(days => $2::int))
         )`,
      [ownerKey, cooldownDays],
    );
    return new Set(result.rows.map((row) => String(row.name)));
  }

  /** 同一笔重跑覆盖 pending；人已经处理过的（applied/rejected）不动。 */
  async upsertBackfillSuggestion(
    ownerKey: string,
    args: {
      journalId: string;
      transactionGroupId?: string;
      date?: string;
      description?: string;
      amount?: string;
      currencyCode?: string;
      categoryId?: string;
      categoryName: string;
      source: BackfillSuggestionSource;
    },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO abei_ai.backfill_suggestions
         (owner_key, journal_id, transaction_group_id, date, description, amount,
          currency_code, category_id, category_name, source, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
       ON CONFLICT (owner_key, journal_id) DO UPDATE
       SET transaction_group_id = excluded.transaction_group_id,
           date = excluded.date,
           description = excluded.description,
           amount = excluded.amount,
           currency_code = excluded.currency_code,
           category_id = excluded.category_id,
           category_name = excluded.category_name,
           source = excluded.source,
           created_at = now()
       WHERE abei_ai.backfill_suggestions.status = 'pending'`,
      [
        ownerKey,
        args.journalId,
        args.transactionGroupId ?? null,
        args.date ?? null,
        args.description ?? null,
        args.amount ?? null,
        args.currencyCode ?? null,
        args.categoryId ?? null,
        args.categoryName,
        args.source,
      ],
    );
  }

  async listBackfillSuggestions(
    ownerKey: string,
    status: BackfillSuggestionStatus = 'pending',
  ): Promise<BackfillSuggestion[]> {
    const result = await this.pool.query(
      `SELECT ${BACKFILL_COLUMNS}
       FROM abei_ai.backfill_suggestions
       WHERE owner_key = $1 AND status = $2
       ORDER BY created_at DESC
       LIMIT 2000`,
      [ownerKey, status],
    );
    return result.rows.map(backfillSuggestionFromRow);
  }

  async resolveBackfillSuggestion(
    ownerKey: string,
    journalId: string,
    status: Exclude<BackfillSuggestionStatus, 'pending'>,
  ): Promise<BackfillSuggestion | undefined> {
    const result = await this.pool.query(
      `UPDATE abei_ai.backfill_suggestions
       SET status = $3
       WHERE owner_key = $1 AND journal_id = $2 AND status = 'pending'
       RETURNING ${BACKFILL_COLUMNS}`,
      [ownerKey, journalId, status],
    );
    return result.rowCount ? backfillSuggestionFromRow(result.rows[0]) : undefined;
  }

  async createSession(args: {
    ownerKey: string;
    title: string;
    provider: string;
    model: string;
  }): Promise<AiSession> {
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO abei_ai.sessions (id, owner_key, title, provider, model)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, provider, model, created_at, updated_at`,
      [id, args.ownerKey, args.title, args.provider, args.model],
    );
    return sessionFromRow(result.rows[0], 0);
  }

  async getSession(id: string, ownerKey: string): Promise<AiSession | undefined> {
    const result = await this.pool.query(
      `SELECT s.id, s.title, s.provider, s.model, s.created_at, s.updated_at,
              count(a.id) FILTER (WHERE a.status = 'pending')::int AS pending_approvals
       FROM abei_ai.sessions s
       LEFT JOIN abei_ai.approvals a ON a.session_id = s.id
       WHERE s.id = $1 AND s.owner_key = $2
       GROUP BY s.id`,
      [id, ownerKey],
    );
    return result.rowCount ? sessionFromRow(result.rows[0]) : undefined;
  }

  async listSessions(ownerKey: string): Promise<AiSession[]> {
    const result = await this.pool.query(
      `SELECT s.id, s.title, s.provider, s.model, s.created_at, s.updated_at,
              count(a.id) FILTER (WHERE a.status = 'pending')::int AS pending_approvals
       FROM abei_ai.sessions s
       LEFT JOIN abei_ai.approvals a ON a.session_id = s.id
       WHERE s.owner_key = $1
       GROUP BY s.id
       ORDER BY s.updated_at DESC
       LIMIT 100`,
      [ownerKey],
    );
    return result.rows.map((row) => sessionFromRow(row));
  }

  async loadMessages(sessionId: string, ownerKey: string): Promise<AgentMessage[]> {
    const result = await this.pool.query(
      `SELECT m.payload
       FROM abei_ai.messages m
       JOIN abei_ai.sessions s ON s.id = m.session_id
       WHERE m.session_id = $1 AND s.owner_key = $2
       ORDER BY m.ordinal`,
      [sessionId, ownerKey],
    );
    return result.rows.map((row) => row.payload as AgentMessage);
  }

  async appendMessages(
    sessionId: string,
    ownerKey: string,
    startOrdinal: number,
    messages: AgentMessage[],
  ): Promise<void> {
    if (messages.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        'SELECT id FROM abei_ai.sessions WHERE id = $1 AND owner_key = $2 FOR UPDATE',
        [sessionId, ownerKey],
      );
      if (!locked.rowCount) throw new Error('AI session not found.');

      const count = await client.query(
        'SELECT count(*)::int AS count FROM abei_ai.messages WHERE session_id = $1',
        [sessionId],
      );
      if (count.rows[0].count !== startOrdinal) {
        throw new Error('AI session changed while this response was running.');
      }

      for (const [index, message] of messages.entries()) {
        await client.query(
          `INSERT INTO abei_ai.messages (session_id, ordinal, payload)
           VALUES ($1, $2, $3::jsonb)`,
          [sessionId, startOrdinal + index, JSON.stringify(message)],
        );
      }
      await client.query('UPDATE abei_ai.sessions SET updated_at = now() WHERE id = $1', [
        sessionId,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createApproval(args: {
    sessionId: string;
    ownerKey: string;
    capability: string;
    input: Record<string, unknown>;
    preview?: unknown;
  }): Promise<AiApproval> {
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO abei_ai.approvals (id, session_id, capability, input, preview, status)
       SELECT $1, s.id, $3, $4::jsonb, $5::jsonb, 'pending'
       FROM abei_ai.sessions s
       WHERE s.id = $2 AND s.owner_key = $6
       RETURNING *`,
      [
        id,
        args.sessionId,
        args.capability,
        JSON.stringify(args.input),
        JSON.stringify(args.preview ?? null),
        args.ownerKey,
      ],
    );
    if (!result.rowCount) throw new Error('AI session not found.');
    return approvalFromRow(result.rows[0]);
  }

  async listApprovals(sessionId: string, ownerKey: string): Promise<AiApproval[]> {
    const result = await this.pool.query(
      `SELECT a.*
       FROM abei_ai.approvals a
       JOIN abei_ai.sessions s ON s.id = a.session_id
       WHERE a.session_id = $1 AND s.owner_key = $2
       ORDER BY a.created_at`,
      [sessionId, ownerKey],
    );
    return result.rows.map(approvalFromRow);
  }

  async claimApproval(id: string, ownerKey: string): Promise<AiApproval | undefined> {
    const result = await this.pool.query(
      `UPDATE abei_ai.approvals a
       SET status = 'executing'
       FROM abei_ai.sessions s
       WHERE a.id = $1 AND a.status = 'pending'
         AND s.id = a.session_id AND s.owner_key = $2
       RETURNING a.*`,
      [id, ownerKey],
    );
    return result.rowCount ? approvalFromRow(result.rows[0]) : undefined;
  }

  async rejectApproval(id: string, ownerKey: string): Promise<AiApproval | undefined> {
    const result = await this.pool.query(
      `UPDATE abei_ai.approvals a
       SET status = 'rejected', decided_at = now()
       FROM abei_ai.sessions s
       WHERE a.id = $1 AND a.status = 'pending'
         AND s.id = a.session_id AND s.owner_key = $2
       RETURNING a.*`,
      [id, ownerKey],
    );
    return result.rowCount ? approvalFromRow(result.rows[0]) : undefined;
  }

  async finishApproval(id: string, result: unknown): Promise<AiApproval> {
    const updated = await this.pool.query(
      `UPDATE abei_ai.approvals
       SET status = 'approved', result = $2::jsonb, decided_at = now()
       WHERE id = $1 AND status = 'executing'
       RETURNING *`,
      [id, JSON.stringify(result ?? null)],
    );
    if (!updated.rowCount) throw new Error('Approval is no longer executing.');
    return approvalFromRow(updated.rows[0]);
  }

  async releaseApproval(id: string, error: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE abei_ai.approvals
       SET status = 'pending', result = $2::jsonb
       WHERE id = $1 AND status = 'executing'`,
      [id, JSON.stringify({ error: error instanceof Error ? error.message : String(error) })],
    );
  }

  private requiredEncryptionSecret(): string {
    if (!this.encryptionSecret) {
      throw new Error('APP_KEY is required to store AI model credentials.');
    }
    return this.encryptionSecret;
  }
}

export function encryptModelConfig(config: ModelConfig, secret: string): string {
  return encryptPayload(config, secret);
}

export function decryptModelConfig(payload: string, secret: string): ModelConfig {
  return decryptPayload<ModelConfig>(payload, secret);
}

/** 模型凭证和 autofill 的 Firefly PAT 共用这套 AES-256-GCM 封装。 */
function encryptPayload(value: unknown, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', modelConfigKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

function decryptPayload<T>(payload: string, secret: string): T {
  const [version, iv, tag, encrypted] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid AI model config.');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    modelConfigKey(secret),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const json = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(json) as T;
}

/**
 * 派生密钥的盐。改名时故意留着旧字面量：它参与密钥派生，换掉等于把已存的
 * 模型凭证全解不开，用户得重配一遍。和存储键 `granary.*` 同一类取舍。
 */
function modelConfigKey(secret: string): Buffer {
  return createHash('sha256').update('abaku-ai-model-config\0').update(secret).digest();
}

export function createAiPool(env: NodeJS.ProcessEnv = process.env): Pool {
  if (env.DATABASE_URL) {
    return new Pool({ connectionString: env.DATABASE_URL, max: poolSize(env) });
  }
  return new Pool({
    host: env.PGHOST ?? env.DB_HOST ?? '127.0.0.1',
    port: Number(env.PGPORT ?? env.DB_PORT ?? 5432),
    database: env.PGDATABASE ?? env.DB_DATABASE ?? 'firefly',
    user: env.PGUSER ?? env.DB_USERNAME ?? 'firefly',
    password: env.PGPASSWORD ?? env.DB_PASSWORD ?? 'firefly-local-only',
    max: poolSize(env),
  });
}

function poolSize(env: NodeJS.ProcessEnv): number {
  const value = Number(env.AI_DB_POOL_SIZE ?? 5);
  return Number.isInteger(value) && value > 0 ? value : 5;
}

function sessionFromRow(row: Record<string, unknown>, pendingApprovals?: number): AiSession {
  return {
    id: String(row.id),
    title: String(row.title),
    provider: String(row.provider),
    model: String(row.model),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    pendingApprovals: pendingApprovals ?? Number(row.pending_approvals ?? 0),
  };
}

function approvalFromRow(row: Record<string, unknown>): AiApproval {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    capability: String(row.capability),
    input: row.input as Record<string, unknown>,
    preview: row.preview,
    status: row.status as AiApproval['status'],
    result: row.result,
    createdAt: toIso(row.created_at),
    decidedAt: row.decided_at ? toIso(row.decided_at) : undefined,
  };
}

/** 一条运行记录最多存这么多条明细，防止一次大回填把整行撑到几兆。 */
const MAX_RUN_DETAIL_ENTRIES = 500;

const RUN_COLUMNS = `id, kind, trigger, started_at, finished_at, status, summary, error`;

const VOCAB_COLUMNS = `id, action, domain, category_id, name, parent_id, parent_name, icon,
                       color, reason, sample_count, samples, status, created_at, resolved_at`;

const BACKFILL_COLUMNS = `journal_id, transaction_group_id, date, description, amount,
                          currency_code, category_id, category_name, source, status, created_at`;

function aiRunFromRow(row: Record<string, unknown>): AiRun {
  const summary = row.summary;
  const run: AiRun = {
    id: String(row.id),
    kind: String(row.kind),
    trigger: row.trigger as AiRunTrigger,
    started_at: toIso(row.started_at),
    finished_at: row.finished_at ? toIso(row.finished_at) : undefined,
    status: row.status as AiRunStatus,
    summary:
      summary !== null && typeof summary === 'object' && !Array.isArray(summary)
        ? (summary as Record<string, unknown>)
        : {},
    error: optionalText(row.error),
  };
  // detail 只在单条查询里 SELECT 出来；列表返回不带这个键。
  if ('detail' in row) run.detail = Array.isArray(row.detail) ? row.detail : [];
  return run;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function vocabSuggestionFromRow(row: Record<string, unknown>): VocabSuggestion {
  const samples = row.samples;
  return {
    id: String(row.id),
    action: row.action as VocabSuggestionAction,
    domain: String(row.domain),
    category_id: optionalText(row.category_id),
    name: String(row.name),
    parent_id: optionalText(row.parent_id),
    parent_name: optionalText(row.parent_name),
    icon: optionalText(row.icon),
    color: optionalText(row.color),
    reason: optionalText(row.reason),
    sample_count: Number(row.sample_count ?? 0),
    samples: Array.isArray(samples) ? samples.map((item) => String(item)) : [],
    status: row.status as VocabSuggestionStatus,
    created_at: toIso(row.created_at),
    resolved_at: row.resolved_at ? toIso(row.resolved_at) : undefined,
  };
}

function backfillSuggestionFromRow(row: Record<string, unknown>): BackfillSuggestion {
  return {
    journal_id: String(row.journal_id),
    transaction_group_id: optionalText(row.transaction_group_id),
    date: optionalText(row.date),
    description: optionalText(row.description),
    amount: optionalText(row.amount),
    currency_code: optionalText(row.currency_code),
    category_id: optionalText(row.category_id),
    category_name: String(row.category_name),
    source: row.source as BackfillSuggestionSource,
    status: row.status as BackfillSuggestionStatus,
    created_at: toIso(row.created_at),
  };
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : String(value);
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
