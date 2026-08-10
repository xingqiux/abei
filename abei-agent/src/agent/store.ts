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

export type CategoryRulePatternType = 'merchant' | 'keyword';
export type CategoryRuleOrigin = 'correction' | 'manual';

/**
 * 下面三个记录直接当 HTTP 响应体发出去，字段名是和 web 端对好的线上契约，
 * 所以用 snake_case，跟表的列名一一对应。改名字前先和前端对齐。
 */

/** 纠正衍生的确定性分类规则；命中就不必再花模型钱。 */
export interface CategoryRule {
  id: string;
  pattern_type: CategoryRulePatternType;
  pattern: string;
  category_name: string;
  origin: CategoryRuleOrigin;
  enabled: boolean;
  hit_count: number;
  last_hit_at?: string;
  /** 自动停用的原因（目标分类被删）；人手停用的留空。 */
  disabled_reason?: string;
  created_at: string;
}

/** 还没立成规则的纠正样本，同模式攒够 3 次才提示立规则。 */
export interface FeedbackSample {
  pattern: string;
  categoryName: string;
  count: number;
  updatedAt: string;
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

/** 同模式纠正到这个次数就提示立规则（先落停用状态，等人点开）。 */
export const FEEDBACK_RULE_THRESHOLD = 3;

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

      CREATE TABLE IF NOT EXISTS abei_ai.category_rules (
        id uuid PRIMARY KEY,
        owner_key text NOT NULL,
        pattern_type text NOT NULL CHECK (pattern_type IN ('merchant', 'keyword')),
        pattern text NOT NULL,
        category_name text NOT NULL,
        origin text NOT NULL CHECK (origin IN ('correction', 'manual')),
        enabled boolean NOT NULL DEFAULT true,
        hit_count integer NOT NULL DEFAULT 0,
        last_hit_at timestamptz,
        disabled_reason text,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ai_category_rules_owner_pattern
        ON abei_ai.category_rules (owner_key, pattern_type, pattern);

      CREATE TABLE IF NOT EXISTS abei_ai.feedback_samples (
        owner_key text NOT NULL,
        pattern text NOT NULL,
        category_name text NOT NULL,
        count integer NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_key, pattern, category_name)
      );

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

  /** enabledOnly 是引擎判定用的读法；设置页要连停用的一起看。 */
  async listCategoryRules(
    ownerKey: string,
    options: { enabledOnly?: boolean } = {},
  ): Promise<CategoryRule[]> {
    const result = await this.pool.query(
      `SELECT ${RULE_COLUMNS}
       FROM abei_ai.category_rules
       WHERE owner_key = $1 AND ($2::boolean IS NOT TRUE OR enabled = true)
       ORDER BY enabled DESC, hit_count DESC, created_at DESC
       LIMIT 1000`,
      [ownerKey, options.enabledOnly ?? false],
    );
    return result.rows.map(categoryRuleFromRow);
  }

  /**
   * 级联收尾：目标分类被删掉的规则自动停用并写明原因，不删数据。
   * knownNames 为空时什么都不做——那多半是分类接口没拉到，不能拿它当依据。
   */
  async disableRulesForMissingCategories(
    ownerKey: string,
    knownNames: string[],
    reason: string,
  ): Promise<number> {
    if (knownNames.length === 0) return 0;
    const result = await this.pool.query(
      `UPDATE abei_ai.category_rules
       SET enabled = false, disabled_reason = $3
       WHERE owner_key = $1 AND enabled = true AND category_name <> ALL($2::text[])`,
      [ownerKey, knownNames, reason],
    );
    return result.rowCount ?? 0;
  }

  /**
   * 同一个 (pattern_type, pattern) 只留一条规则，重复纠正就改分类。
   * keepExistingEnabled 给「攒够 3 次自动提示」用：已启用的规则不该被降级成停用。
   */
  async upsertCategoryRule(
    ownerKey: string,
    args: {
      patternType: CategoryRulePatternType;
      pattern: string;
      categoryName: string;
      origin: CategoryRuleOrigin;
      enabled: boolean;
      keepExistingEnabled?: boolean;
    },
  ): Promise<CategoryRule> {
    const result = await this.pool.query(
      `INSERT INTO abei_ai.category_rules
         (id, owner_key, pattern_type, pattern, category_name, origin, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (owner_key, pattern_type, pattern) DO UPDATE
       SET category_name = excluded.category_name,
           origin = excluded.origin,
           enabled = CASE
             WHEN $8::boolean THEN abei_ai.category_rules.enabled
             ELSE excluded.enabled
           END,
           disabled_reason = NULL
       RETURNING ${RULE_COLUMNS}`,
      [
        randomUUID(),
        ownerKey,
        args.patternType,
        args.pattern,
        args.categoryName,
        args.origin,
        args.enabled,
        args.keepExistingEnabled ?? false,
      ],
    );
    return categoryRuleFromRow(result.rows[0]);
  }

  async setCategoryRuleEnabled(
    ownerKey: string,
    id: string,
    enabled: boolean,
  ): Promise<CategoryRule | undefined> {
    const result = await this.pool.query(
      `UPDATE abei_ai.category_rules
       SET enabled = $3, disabled_reason = NULL
       WHERE id = $1 AND owner_key = $2
       RETURNING ${RULE_COLUMNS}`,
      [id, ownerKey, enabled],
    );
    return result.rowCount ? categoryRuleFromRow(result.rows[0]) : undefined;
  }

  async deleteCategoryRule(ownerKey: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM abei_ai.category_rules WHERE id = $1 AND owner_key = $2',
      [id, ownerKey],
    );
    return Boolean(result.rowCount);
  }

  /** 一轮预填/回填结束后批量记账，同一条规则命中多次就加多次。 */
  async recordRuleHits(ownerKey: string, ruleIds: string[]): Promise<void> {
    if (ruleIds.length === 0) return;
    await this.pool.query(
      `UPDATE abei_ai.category_rules r
       SET hit_count = r.hit_count + hits.total, last_hit_at = now()
       FROM (
         SELECT rule_id, count(*)::int AS total
         FROM unnest($2::uuid[]) AS rule_id
         GROUP BY rule_id
       ) hits
       WHERE r.id = hits.rule_id AND r.owner_key = $1`,
      [ownerKey, ruleIds],
    );
  }

  /** 返回累计次数，调用方据此决定要不要提示立规则。 */
  async recordFeedbackSample(
    ownerKey: string,
    pattern: string,
    categoryName: string,
  ): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO abei_ai.feedback_samples (owner_key, pattern, category_name, count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (owner_key, pattern, category_name) DO UPDATE
       SET count = abei_ai.feedback_samples.count + 1, updated_at = now()
       RETURNING count`,
      [ownerKey, pattern, categoryName],
    );
    return Number(result.rows[0].count);
  }

  async listFeedbackSamples(ownerKey: string, minCount = 1): Promise<FeedbackSample[]> {
    const result = await this.pool.query(
      `SELECT pattern, category_name, count, updated_at
       FROM abei_ai.feedback_samples
       WHERE owner_key = $1 AND count >= $2
       ORDER BY count DESC, updated_at DESC
       LIMIT 500`,
      [ownerKey, minCount],
    );
    return result.rows.map((row) => ({
      pattern: String(row.pattern),
      categoryName: String(row.category_name),
      count: Number(row.count),
      updatedAt: toIso(row.updated_at),
    }));
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

const RULE_COLUMNS = `id, pattern_type, pattern, category_name, origin, enabled, hit_count,
                      last_hit_at, disabled_reason, created_at`;

const VOCAB_COLUMNS = `id, action, domain, category_id, name, parent_id, parent_name, icon,
                       color, reason, sample_count, samples, status, created_at, resolved_at`;

const BACKFILL_COLUMNS = `journal_id, transaction_group_id, date, description, amount,
                          currency_code, category_id, category_name, source, status, created_at`;

function categoryRuleFromRow(row: Record<string, unknown>): CategoryRule {
  return {
    id: String(row.id),
    pattern_type: row.pattern_type as CategoryRulePatternType,
    pattern: String(row.pattern),
    category_name: String(row.category_name),
    origin: row.origin as CategoryRuleOrigin,
    enabled: row.enabled === true,
    hit_count: Number(row.hit_count ?? 0),
    last_hit_at: row.last_hit_at ? toIso(row.last_hit_at) : undefined,
    disabled_reason: optionalText(row.disabled_reason),
    created_at: toIso(row.created_at),
  };
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
