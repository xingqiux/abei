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

export class AiStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryptionSecret?: string,
  ) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS abaku_ai;

      CREATE TABLE IF NOT EXISTS abaku_ai.sessions (
        id uuid PRIMARY KEY,
        owner_key text NOT NULL,
        title text NOT NULL,
        provider text NOT NULL,
        model text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS ai_sessions_owner_updated
        ON abaku_ai.sessions (owner_key, updated_at DESC);

      CREATE TABLE IF NOT EXISTS abaku_ai.messages (
        session_id uuid NOT NULL REFERENCES abaku_ai.sessions(id) ON DELETE CASCADE,
        ordinal integer NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (session_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS abaku_ai.approvals (
        id uuid PRIMARY KEY,
        session_id uuid NOT NULL REFERENCES abaku_ai.sessions(id) ON DELETE CASCADE,
        capability text NOT NULL,
        input jsonb NOT NULL,
        preview jsonb,
        status text NOT NULL CHECK (status IN ('pending', 'executing', 'approved', 'rejected')),
        result jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        decided_at timestamptz
      );

      CREATE INDEX IF NOT EXISTS ai_approvals_session_status
        ON abaku_ai.approvals (session_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS abaku_ai.model_configs (
        owner_key text PRIMARY KEY,
        encrypted_config text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getModelConfig(ownerKey: string): Promise<ModelConfig | undefined> {
    const result = await this.pool.query(
      'SELECT encrypted_config FROM abaku_ai.model_configs WHERE owner_key = $1',
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
      `INSERT INTO abaku_ai.model_configs (owner_key, encrypted_config)
       VALUES ($1, $2)
       ON CONFLICT (owner_key) DO UPDATE
       SET encrypted_config = excluded.encrypted_config, updated_at = now()`,
      [ownerKey, encrypted],
    );
  }

  async deleteModelConfig(ownerKey: string): Promise<void> {
    await this.pool.query('DELETE FROM abaku_ai.model_configs WHERE owner_key = $1', [ownerKey]);
  }

  async createSession(args: {
    ownerKey: string;
    title: string;
    provider: string;
    model: string;
  }): Promise<AiSession> {
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO abaku_ai.sessions (id, owner_key, title, provider, model)
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
       FROM abaku_ai.sessions s
       LEFT JOIN abaku_ai.approvals a ON a.session_id = s.id
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
       FROM abaku_ai.sessions s
       LEFT JOIN abaku_ai.approvals a ON a.session_id = s.id
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
       FROM abaku_ai.messages m
       JOIN abaku_ai.sessions s ON s.id = m.session_id
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
        'SELECT id FROM abaku_ai.sessions WHERE id = $1 AND owner_key = $2 FOR UPDATE',
        [sessionId, ownerKey],
      );
      if (!locked.rowCount) throw new Error('AI session not found.');

      const count = await client.query(
        'SELECT count(*)::int AS count FROM abaku_ai.messages WHERE session_id = $1',
        [sessionId],
      );
      if (count.rows[0].count !== startOrdinal) {
        throw new Error('AI session changed while this response was running.');
      }

      for (const [index, message] of messages.entries()) {
        await client.query(
          `INSERT INTO abaku_ai.messages (session_id, ordinal, payload)
           VALUES ($1, $2, $3::jsonb)`,
          [sessionId, startOrdinal + index, JSON.stringify(message)],
        );
      }
      await client.query('UPDATE abaku_ai.sessions SET updated_at = now() WHERE id = $1', [
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
      `INSERT INTO abaku_ai.approvals (id, session_id, capability, input, preview, status)
       SELECT $1, s.id, $3, $4::jsonb, $5::jsonb, 'pending'
       FROM abaku_ai.sessions s
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
       FROM abaku_ai.approvals a
       JOIN abaku_ai.sessions s ON s.id = a.session_id
       WHERE a.session_id = $1 AND s.owner_key = $2
       ORDER BY a.created_at`,
      [sessionId, ownerKey],
    );
    return result.rows.map(approvalFromRow);
  }

  async claimApproval(id: string, ownerKey: string): Promise<AiApproval | undefined> {
    const result = await this.pool.query(
      `UPDATE abaku_ai.approvals a
       SET status = 'executing'
       FROM abaku_ai.sessions s
       WHERE a.id = $1 AND a.status = 'pending'
         AND s.id = a.session_id AND s.owner_key = $2
       RETURNING a.*`,
      [id, ownerKey],
    );
    return result.rowCount ? approvalFromRow(result.rows[0]) : undefined;
  }

  async rejectApproval(id: string, ownerKey: string): Promise<AiApproval | undefined> {
    const result = await this.pool.query(
      `UPDATE abaku_ai.approvals a
       SET status = 'rejected', decided_at = now()
       FROM abaku_ai.sessions s
       WHERE a.id = $1 AND a.status = 'pending'
         AND s.id = a.session_id AND s.owner_key = $2
       RETURNING a.*`,
      [id, ownerKey],
    );
    return result.rowCount ? approvalFromRow(result.rows[0]) : undefined;
  }

  async finishApproval(id: string, result: unknown): Promise<AiApproval> {
    const updated = await this.pool.query(
      `UPDATE abaku_ai.approvals
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
      `UPDATE abaku_ai.approvals
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
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', modelConfigKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptModelConfig(payload: string, secret: string): ModelConfig {
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
  return JSON.parse(json) as ModelConfig;
}

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

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
