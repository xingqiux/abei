import { FireflyHttpClient } from '../core/http-client.js';
import { BillTaskService } from '../services/bill-task-service.js';
import { withAiRun, type RunLog } from './ai-runs.js';
import { runBackfill, type BackfillRunStats } from './backfill.js';
import {
  allowedCategoryNames,
  CATEGORY_DOMAINS,
  INCOME_EXPENSE_DOMAINS,
  loadCategoryCatalog,
  ruleSubject,
  TRANSFER_DOMAINS,
} from './categorization.js';
import { runLearning, type LearnRunStats } from './learn.js';
import { askModelRows, pairAnswers } from './model-json.js';
import type { ModelRuntime } from './model-runtime.js';
import {
  loadRulesDoc,
  matchDocRule,
  rulesSystemSection,
  unknownCategoryRules,
  type DocRule,
  type RulesDoc,
} from './rule-doc.js';
import {
  chunk as chunked,
  errorMessage,
  hasNextPage,
  isBlank,
  prune,
  record,
  trimmed,
  unique,
} from './shared.js';
import type { AiRunTrigger, AiStore, AutofillConfig } from './store.js';
import { scanVocabulary } from './vocab-scan.js';

/** 跨源判重意见的固定前缀，人在收件箱里一眼认出这句话是机器写的。 */
export const AI_NOTE_PREFIX = 'AI判断：';

const MAX_TASKS_PER_RUN = 20;
const MAX_ROWS_PER_CALL = 25;
const MAX_LIST_NAMES = 300;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_NOTES_LENGTH = 500;
/** 词表扫描跟着 autofill 周期走，但一天只跑一次。 */
const VOCAB_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const SYSTEM_PROMPT = `你是阿贝的账单预填助手。你只填空，不入账，不改判定。

规则：
- 只输出一个 JSON 对象，形如 {"rows":[...]}；不要代码块，不要解释，不要多余文字。
- 拿不准就别填：把那一行整条从 rows 里去掉，宁可留空也不要编。
- 分类名和账户名只能从给定清单里原样照抄，一个字都不能改，禁止发明新名字。
- 不要碰金额、日期、收支方向，也不要改重复判定。
- 描述和备注用简体中文。`;

const VERDICT_TEXT: Record<string, string> = {
  duplicate: '像是同一笔',
  not_duplicate: '不像同一笔',
  unsure: '说不准是不是同一笔',
};

export interface AutofillRunStats {
  tasks: number;
  candidate_rows: number;
  updated_rows: number;
  /** 规则直接判定的行数，这部分不花模型钱。 */
  rule_rows: number;
  skipped_tasks: number;
  model_calls: number;
}

export interface AutofillWorkerOptions {
  fireflyUrl: string;
  abeiUrl: string;
  store: AiStore;
  /** 复用 server.ts 的 runtimeForOwner；用回调传进来避免和 server 循环依赖。 */
  resolveRuntime: (ownerKey: string) => Promise<ModelRuntime>;
}

/**
 * 后台预填：轮询 parsed 任务，给还没人碰过的 pending 行补分类、描述、
 * 转账对手和备注。写入一律走 as_suggestion=true，入账永远等人确认。
 */
export class AutofillWorker {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly lastVocabScan = new Map<string, number>();
  private stopped = false;

  constructor(private readonly options: AutofillWorkerOptions) {}

  /** 读不出配置不该拖垮整个服务，记一笔日志就算了。 */
  async start(): Promise<void> {
    try {
      const configs = await this.options.store.listAutofillConfigs();
      for (const config of configs) {
        // 首轮打散，避免多用户同一秒一起打模型。
        this.schedule(config, Math.floor(Math.random() * 30_000));
      }
    } catch (error) {
      console.error(`[autofill] 启动时读取配置失败：${errorMessage(error)}`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.running.values()]);
  }

  /** 配置改动后立刻生效：重排或撤销这个用户的定时器。 */
  async reschedule(ownerKey: string): Promise<void> {
    const timer = this.timers.get(ownerKey);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(ownerKey);
    }
    if (this.stopped) return;
    const config = await this.options.store.getAutofillConfig(ownerKey);
    if (!config) return;
    this.schedule(config, config.intervalSeconds * 1000);
  }

  isRunning(ownerKey: string): boolean {
    return this.running.has(ownerKey);
  }

  /** 手动触发一轮。用调用方自己的 Firefly 客户端，存量清理不必先配 PAT。 */
  runNow(args: {
    ownerKey: string;
    client: FireflyHttpClient;
    taskIds?: number[];
  }): Promise<AutofillRunStats> {
    return this.guard(args.ownerKey, async () => {
      const stats = await this.run({ ...args, trigger: 'manual' });
      await this.learnQuietly(args.ownerKey, args.client);
      return stats;
    });
  }

  /** 手动触发一轮学习。和预填共用同一把并发闸。 */
  runLearnNow(args: { ownerKey: string; client: FireflyHttpClient }): Promise<LearnRunStats> {
    return this.guard(args.ownerKey, () => this.learn({ ...args, trigger: 'manual' }));
  }

  /**
   * 记一笔并跑一轮学习。学不到东西（没信号、没变化）就不留记录——
   * 时间线上不该出现一条「什么也没学到」。
   */
  private learn(args: {
    ownerKey: string;
    client: FireflyHttpClient;
    trigger: AiRunTrigger;
  }): Promise<LearnRunStats> {
    return withAiRun({
      store: this.options.store,
      ownerKey: args.ownerKey,
      kind: 'learn',
      trigger: args.trigger,
      run: (log) =>
        runLearning({
          ownerKey: args.ownerKey,
          client: args.client,
          abeiUrl: this.options.abeiUrl,
          store: this.options.store,
          log,
        }),
      isEmpty: (result) => result.learned === 0 && result.retired === 0,
      summarize: (result) => ({
        signals: result.signals,
        learned: result.learned,
        retired: result.retired,
      }),
    });
  }

  /** 预填跑完顺手学一次。学习炸了不该让预填看起来失败，记一行日志就够。 */
  private async learnQuietly(ownerKey: string, client: FireflyHttpClient): Promise<void> {
    try {
      const stats = await this.learn({ ownerKey, client, trigger: 'auto' });
      if (stats.learned > 0 || stats.retired > 0) {
        console.log(`[learn] 新学 ${stats.learned} 条规则，停用 ${stats.retired} 条。`);
      }
    } catch (error) {
      console.error(`[learn] 本轮失败：${errorMessage(error)}`);
    }
  }

  /** 回填走同一把并发闸：预填在跑就不让回填插队，反过来也一样。 */
  runBackfillNow(args: { ownerKey: string; client: FireflyHttpClient }): Promise<BackfillRunStats> {
    return this.guard(args.ownerKey, () => this.backfill({ ...args, trigger: 'manual' }));
  }

  private async backfill(args: {
    ownerKey: string;
    client: FireflyHttpClient;
    trigger: AiRunTrigger;
  }): Promise<BackfillRunStats> {
    const runtime = await this.options.resolveRuntime(args.ownerKey);
    const stats = await withAiRun({
      store: this.options.store,
      ownerKey: args.ownerKey,
      kind: 'backfill',
      trigger: args.trigger,
      run: (log) =>
        runBackfill({
          ownerKey: args.ownerKey,
          client: args.client,
          abeiUrl: this.options.abeiUrl,
          store: this.options.store,
          runtime,
          log,
        }),
      isEmpty: (result) => result.rule_suggestions + result.model_suggestions === 0,
      summarize: (result, log) => ({
        transactions: result.journals,
        rows: log.entries.length,
        ...basisCounts(log),
        skipped: result.skipped,
        model_calls: result.model_calls,
      }),
    });
    console.log(
      `[backfill] 未分类 ${stats.journals} 笔，规则 ${stats.rule_suggestions} 条，` +
        `模型 ${stats.model_suggestions} 条，跳过 ${stats.skipped} 笔，` +
        `模型调用 ${stats.model_calls} 次。`,
    );
    return stats;
  }

  /**
   * 单实例进程锁：同一个用户同一时刻只跑一件事。
   * task() 同步起跑，登记发生在同一个 tick 内，isRunning 才敢当闸门用。
   */
  private guard<T>(ownerKey: string, task: () => Promise<T>): Promise<T> {
    const run = task();
    const tracked = run.then(noop, noop);
    this.running.set(ownerKey, tracked);
    return run.finally(() => {
      if (this.running.get(ownerKey) === tracked) this.running.delete(ownerKey);
    });
  }

  private schedule(config: AutofillConfig, delayMs: number): void {
    if (this.stopped || !config.enabled || !config.token) return;
    const timer = setTimeout(
      () => {
        void this.tick(config.ownerKey);
      },
      Math.max(1_000, delayMs),
    );
    timer.unref?.();
    this.timers.set(config.ownerKey, timer);
  }

  private async tick(ownerKey: string): Promise<void> {
    this.timers.delete(ownerKey);
    if (this.stopped) return;

    const config = await this.options.store.getAutofillConfig(ownerKey).catch((error: unknown) => {
      console.error(`[autofill] 读取配置失败：${errorMessage(error)}`);
      return undefined;
    });
    if (!config?.enabled || !config.token) return;

    if (!this.running.has(ownerKey)) {
      const client = new FireflyHttpClient({
        baseUrl: this.options.fireflyUrl,
        token: config.token,
        timeout: 60_000,
      });
      await this.guard(ownerKey, async () => {
        try {
          const stats = await this.run({ ownerKey, client, trigger: 'auto' });
          if (stats.candidate_rows > 0 || stats.skipped_tasks > 0) {
            console.log(
              `[autofill] 任务 ${stats.tasks} 个，候选行 ${stats.candidate_rows} 条，` +
                `写入 ${stats.updated_rows} 条（规则 ${stats.rule_rows} 条），` +
                `跳过任务 ${stats.skipped_tasks} 个，模型调用 ${stats.model_calls} 次。`,
            );
          }
        } catch (error) {
          console.error(`[autofill] 本轮失败：${errorMessage(error)}`);
        }
        // 预填刚写完一批建议，人也刚改过上一批，这时候回头看信号最全。
        await this.learnQuietly(ownerKey, client);
        await this.scanVocabularyIfDue(ownerKey, client);
      });
    }

    this.schedule(config, config.intervalSeconds * 1000);
  }

  /** 每天一次的词表扫描，挂在 autofill 周期上，失败不影响预填。 */
  private async scanVocabularyIfDue(ownerKey: string, client: FireflyHttpClient): Promise<void> {
    const last = this.lastVocabScan.get(ownerKey) ?? 0;
    if (Date.now() - last < VOCAB_SCAN_INTERVAL_MS) return;
    this.lastVocabScan.set(ownerKey, Date.now());
    try {
      const stats = await withAiRun({
        store: this.options.store,
        ownerKey,
        kind: 'vocab_scan',
        trigger: 'auto',
        run: (log) => scanVocabulary({ ownerKey, client, store: this.options.store, log }),
        isEmpty: (result) => result.created === 0,
        summarize: (result) => ({
          splits: result.splits,
          patterns: result.patterns,
          rows: result.created,
        }),
      });
      if (stats.created > 0) {
        console.log(
          `[vocab] 扫描 ${stats.splits} 条流水、${stats.patterns} 个模式，新建议 ${stats.created} 条。`,
        );
      }
    } catch (error) {
      console.error(`[vocab] 扫描失败：${errorMessage(error)}`);
    }
  }

  /** 记一笔工作记录，再跑一轮。定时和手动共用这一个入口，所以只包这一处。 */
  private run(args: {
    ownerKey: string;
    client: FireflyHttpClient;
    taskIds?: number[];
    trigger: AiRunTrigger;
  }): Promise<AutofillRunStats> {
    return withAiRun({
      store: this.options.store,
      ownerKey: args.ownerKey,
      kind: 'autofill',
      trigger: args.trigger,
      run: (log) => this.execute(args, log),
      isEmpty: (result) => result.updated_rows === 0 && result.skipped_tasks === 0,
      summarize: (result, log) => ({
        tasks: result.tasks,
        rows: result.updated_rows,
        ...basisCounts(log),
        skipped_tasks: result.skipped_tasks,
        model_calls: result.model_calls,
      }),
    });
  }

  private async execute(
    args: { ownerKey: string; client: FireflyHttpClient; taskIds?: number[] },
    log: RunLog,
  ): Promise<AutofillRunStats> {
    const stats = emptyStats();
    const runtime = await this.options.resolveRuntime(args.ownerKey);
    const model = runtime.model;
    if (!model || runtime.error) throw new Error(runtime.error ?? '模型不可用。');

    const service = new BillTaskService(args.client.withBaseUrl(this.options.abeiUrl));
    const taskIds = args.taskIds?.length
      ? args.taskIds.slice(0, MAX_TASKS_PER_RUN)
      : (await parsedTaskIds(service)).slice(0, MAX_TASKS_PER_RUN);
    if (taskIds.length === 0) return stats;

    const [catalog, doc] = await Promise.all([
      loadCatalog(args.client),
      // 规则文档读不到不该拖垮预填：没有它只是回到「全靠模型」。
      loadRulesDoc(args.client, this.options.abeiUrl).catch((error: unknown) => {
        console.error(`[autofill] 规则文档读取失败：${errorMessage(error)}`);
        return undefined;
      }),
    ]);
    const rules = doc?.rules ?? [];
    for (const rule of unknownCategoryRules(rules, catalog.allNames)) {
      log.note(`规则指向不存在的分类：${rule.line}`);
    }
    const systemPrompt = doc
      ? `${SYSTEM_PROMPT}\n\n${rulesSystemSection(doc.contentMd)}`
      : SYSTEM_PROMPT;

    for (const taskId of taskIds) {
      try {
        await this.runTask({
          taskId,
          service,
          runtime,
          systemPrompt,
          catalog,
          rules,
          doc,
          stats,
          log,
        });
        stats.tasks += 1;
      } catch (error) {
        stats.skipped_tasks += 1;
        console.error(`[autofill] 任务 ${taskId} 跳过：${errorMessage(error)}`);
      }
    }
    return stats;
  }

  private async runTask(args: {
    taskId: number;
    service: BillTaskService;
    runtime: ModelRuntime;
    systemPrompt: string;
    catalog: UserCatalog;
    rules: DocRule[];
    doc?: RulesDoc;
    stats: AutofillRunStats;
    log: RunLog;
  }): Promise<void> {
    const { taskId, service, runtime, systemPrompt, catalog, rules, doc, stats, log } = args;
    const [review, rowList] = await Promise.all([
      service.review(String(taskId)),
      service.rows(String(taskId), { status: 'pending' }),
    ]);

    const rows = statementRows(rowList);
    const blocked = blockedRowIds(review);
    const plan = new Map<string, RowSuggestion>();

    const classify = eligibleRows(review, 'new_candidates', rows, blocked, (row) => {
      if (row.fireflyType === 'transfer') return undefined;
      const fill = [
        isBlank(row.categoryName) ? 'category_name' : undefined,
        isBlank(row.fireflyDescription) ? 'firefly_description' : undefined,
      ].filter(isText);
      return fill.length ? fill : undefined;
    });
    const transfers = eligibleRows(review, 'transfer_candidates', rows, blocked, (row) => {
      const fill = [
        isBlank(row.sourceName) ? 'source_name' : undefined,
        isBlank(row.destinationName) ? 'destination_name' : undefined,
        isBlank(row.categoryName) ? 'category_name' : undefined,
      ].filter(isText);
      return fill.length ? fill : undefined;
    });
    const notes = eligibleRows(review, 'needs_user_note', rows, blocked, (row) =>
      isBlank(row.notes) ? ['notes'] : undefined,
    );
    const crossSource = mediumCrossSourceRows(review, rows, blocked);

    stats.candidate_rows += classify.length + transfers.length + notes.length + crossSource.length;

    // 判定顺序：先规则后模型。规则命中的行不再送进模型批次。
    const askClassify = applyRules(plan, classify, rules, catalog.categories, stats);
    const askTransfers = applyRules(plan, transfers, rules, catalog.transferCategories, stats);

    for (const batch of chunked(askClassify, MAX_ROWS_PER_CALL)) {
      const answers = await this.ask(runtime, systemPrompt, classifyPrompt(batch, catalog), stats);
      mergeClassify(plan, answers, batch, catalog.categories);
    }
    for (const batch of chunked(askTransfers, MAX_ROWS_PER_CALL)) {
      const answers = await this.ask(runtime, systemPrompt, transferPrompt(batch, catalog), stats);
      mergeTransfer(plan, answers, batch, catalog);
    }
    for (const batch of chunked(notes, MAX_ROWS_PER_CALL)) {
      const answers = await this.ask(runtime, systemPrompt, notePrompt(batch), stats);
      mergeNote(plan, answers, batch);
    }
    for (const batch of chunked(crossSource, MAX_ROWS_PER_CALL)) {
      const answers = await this.ask(runtime, systemPrompt, crossSourcePrompt(batch), stats);
      mergeVerdict(plan, answers, batch);
    }

    for (const [rowId, suggestion] of plan) {
      const values = suggestionValues(suggestion);
      if (!values) continue;
      await service.suggestRow(rowId, values);
      stats.updated_rows += 1;
      log.add({
        kind: 'bill_row',
        task_id: taskId,
        row_id: rowId,
        values,
        basis: suggestion.basis ?? (doc ? 'doc' : 'model'),
      });
    }
  }

  private ask(
    runtime: ModelRuntime,
    systemPrompt: string,
    prompt: string,
    stats: AutofillRunStats,
  ): Promise<Array<Record<string, unknown>>> {
    return askModelRows({
      runtime,
      systemPrompt,
      prompt,
      onCall: () => {
        stats.model_calls += 1;
      },
    });
  }
}

/** 时间线那一行要的「规则 N / 模型 M」。依据前缀是 `rule:` 的算规则命中。 */
export function basisCounts(log: RunLog): { by_rule: number; by_model: number; by_doc: number } {
  let byRule = 0;
  let byDoc = 0;
  let byModel = 0;
  for (const entry of log.entries) {
    if (entry.basis.startsWith('rule:')) byRule += 1;
    else if (entry.basis === 'doc') byDoc += 1;
    else byModel += 1;
  }
  return { by_rule: byRule, by_model: byModel, by_doc: byDoc };
}

/**
 * 规则优先：命中就直接给建议，不花模型钱，并把 category_name 从待问清单里划掉。
 * 划完没别的要问了，这一行就不进模型批次。
 */
function applyRules(
  plan: Map<string, RowSuggestion>,
  candidates: Candidate[],
  rules: DocRule[],
  allowed: Set<string>,
  stats: AutofillRunStats,
): Candidate[] {
  if (rules.length === 0) return candidates;
  const remaining: Candidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.fill.includes('category_name')) {
      remaining.push(candidate);
      continue;
    }
    const rule = matchDocRule(rules, subjectOf(candidate.row), allowed);
    if (!rule) {
      remaining.push(candidate);
      continue;
    }
    const target = planFor(plan, candidate.row.rowId);
    target.categoryName = rule.categoryName;
    target.basis = `rule:${rule.line}`;
    stats.rule_rows += 1;
    const fill = candidate.fill.filter((field) => field !== 'category_name');
    if (fill.length) remaining.push({ ...candidate, fill });
  }
  return remaining;
}

function subjectOf(row: StatementRow) {
  const payload = row.payload;
  return ruleSubject([
    trimmed(payload.counterparty, 255),
    row.fireflyDescription,
    trimmed(payload.description, 500),
    trimmed(payload.platform_category, 255),
    row.destinationName,
  ]);
}

interface UserCatalog {
  /** 收支流水的分类白名单：收入域 + 支出域。 */
  categories: Set<string>;
  /** 转账桶专用：只有 v0.1 判出来的转账候选才允许资金往来域。 */
  transferCategories: Set<string>;
  /** 三个域合起来的可用分类名，用来挑出「规则指向了不存在的分类」。 */
  allNames: Set<string>;
  accounts: string[];
}

interface StatementRow {
  rowId: string;
  status?: string;
  suggestedBy?: string;
  userModifiedAt?: string;
  duplicateState?: string;
  fireflyType?: string;
  categoryName?: string;
  fireflyDescription?: string;
  sourceName?: string;
  destinationName?: string;
  notes?: string;
  /** 只喂给模型的精简视图；不含卡号、订单号、指纹。 */
  payload: Record<string, unknown>;
}

interface Candidate {
  row: StatementRow;
  fill: string[];
  /** 跨源判重才有：服务端找出的疑似已有交易。 */
  match?: Record<string, unknown>;
}

interface RowSuggestion {
  categoryName?: string;
  fireflyDescription?: string;
  sourceName?: string;
  destinationName?: string;
  notes: string[];
  /** 代码层规则命中时写成 `rule:<原文行>`；模型给的留空，落记录时再定。 */
  basis?: string;
}

function suggestionValues(suggestion: RowSuggestion): Record<string, unknown> | undefined {
  const values: Record<string, unknown> = {};
  if (suggestion.categoryName) values.category_name = suggestion.categoryName;
  if (suggestion.fireflyDescription) values.firefly_description = suggestion.fireflyDescription;
  if (suggestion.sourceName) values.source_name = suggestion.sourceName;
  if (suggestion.destinationName) values.destination_name = suggestion.destinationName;
  if (suggestion.notes.length)
    values.notes = suggestion.notes.join('\n').slice(0, MAX_NOTES_LENGTH);
  return Object.keys(values).length ? values : undefined;
}

function planFor(plan: Map<string, RowSuggestion>, rowId: string): RowSuggestion {
  const existing = plan.get(rowId);
  if (existing) return existing;
  const created: RowSuggestion = { notes: [] };
  plan.set(rowId, created);
  return created;
}

function mergeClassify(
  plan: Map<string, RowSuggestion>,
  answers: Array<Record<string, unknown>>,
  chunk: Candidate[],
  allowed: Set<string>,
): void {
  for (const [answer, candidate] of pairCandidates(answers, chunk)) {
    const target = planFor(plan, candidate.row.rowId);
    const category = trimmed(answer.category_name, 255);
    if (candidate.fill.includes('category_name') && category && allowed.has(category)) {
      target.categoryName = category;
    }
    const description = trimmed(answer.firefly_description, MAX_DESCRIPTION_LENGTH);
    if (candidate.fill.includes('firefly_description') && description) {
      target.fireflyDescription = description;
    }
  }
}

function mergeTransfer(
  plan: Map<string, RowSuggestion>,
  answers: Array<Record<string, unknown>>,
  chunk: Candidate[],
  catalog: UserCatalog,
): void {
  const allowed = new Set(catalog.accounts);
  for (const [answer, candidate] of pairCandidates(answers, chunk)) {
    const target = planFor(plan, candidate.row.rowId);
    const source = trimmed(answer.source_name, 255);
    if (candidate.fill.includes('source_name') && source && allowed.has(source)) {
      target.sourceName = source;
    }
    const destination = trimmed(answer.destination_name, 255);
    if (candidate.fill.includes('destination_name') && destination && allowed.has(destination)) {
      target.destinationName = destination;
    }
    const category = trimmed(answer.category_name, 255);
    if (
      candidate.fill.includes('category_name') &&
      category &&
      catalog.transferCategories.has(category)
    ) {
      target.categoryName = category;
    }
  }
}

function mergeNote(
  plan: Map<string, RowSuggestion>,
  answers: Array<Record<string, unknown>>,
  chunk: Candidate[],
): void {
  for (const [answer, candidate] of pairCandidates(answers, chunk)) {
    const note = trimmed(answer.notes, MAX_NOTES_LENGTH);
    if (note) planFor(plan, candidate.row.rowId).notes.push(note);
  }
}

function mergeVerdict(
  plan: Map<string, RowSuggestion>,
  answers: Array<Record<string, unknown>>,
  chunk: Candidate[],
): void {
  for (const [answer, candidate] of pairCandidates(answers, chunk)) {
    const verdict = trimmed(answer.verdict, 32);
    const text = verdict ? VERDICT_TEXT[verdict] : undefined;
    if (!text) continue;
    const reason = trimmed(answer.reason, 100);
    const existing = record(candidate.match?.existing);
    const description = trimmed(existing?.description, 60);
    const note = [
      `${AI_NOTE_PREFIX}和已有交易${description ? `「${description}」` : ''}${text}`,
      reason ? `，依据：${reason}` : '',
      '。仅供参考，请自行确认。',
    ].join('');
    planFor(plan, candidate.row.rowId).notes.push(note);
  }
}

function pairCandidates(
  answers: Array<Record<string, unknown>>,
  chunk: Candidate[],
): Array<[Record<string, unknown>, Candidate]> {
  return pairAnswers(answers, chunk, (candidate) => candidate.row.rowId);
}

function classifyPrompt(chunk: Candidate[], catalog: UserCatalog): string {
  const categories = [...catalog.categories];
  return [
    '下面是待入账的账单流水，请给每一行补上分类和一句话描述。',
    '',
    `分类清单（只能从中挑一个，原样照抄；共 ${categories.length} 个）：`,
    categories.join('、') || '（暂无分类，别填 category_name）',
    '',
    '要求：',
    '- category_name：挑最贴切的一个；清单里没有合适的就不要填这个字段。',
    '- firefly_description：一句话说清这笔钱花在哪，20 字以内，别重复金额和日期。',
    '- 每行的 fill 列出了需要补的字段，其余字段一律不要输出。',
    '',
    '流水：',
    JSON.stringify(chunk.map(promptRow)),
    '',
    '输出示例：{"rows":[{"row_id":"12","category_name":"餐饮","firefly_description":"楼下便利店买水"}]}',
  ].join('\n');
}

function transferPrompt(chunk: Candidate[], catalog: UserCatalog): string {
  const categories = [...catalog.transferCategories];
  return [
    '下面这些流水疑似是我自己账户之间的转账，请认出转出和转入账户。',
    '',
    `我的账户清单（只能从中挑，原样照抄；共 ${catalog.accounts.length} 个）：`,
    catalog.accounts.join('、') || '（暂无账户，这一批全部去掉）',
    '',
    `资金往来分类清单（只能从中挑一个，原样照抄；共 ${categories.length} 个）：`,
    categories.join('、') || '（暂无资金往来分类，别填 category_name）',
    '',
    '要求：',
    '- source_name：钱从哪个账户出去；destination_name：钱进了哪个账户。',
    '- category_name：这笔资金往来属于哪一类；认不准就不要填这个字段。',
    '- 只填每行 fill 里列出的字段；清单里认不出对应账户就把这行去掉。',
    '- 不要把商户、平台当成我的账户。',
    '',
    '流水：',
    JSON.stringify(chunk.map(promptRow)),
    '',
    '输出示例：{"rows":[{"row_id":"12","source_name":"招商银行储蓄卡","destination_name":"支付宝余额","category_name":"账户互转"}]}',
  ].join('\n');
}

function notePrompt(chunk: Candidate[]): string {
  return [
    '下面这些流水看不出用途，请各写一句备注说清这笔钱是干什么的。',
    '',
    '要求：',
    '- notes：一句话，30 字以内，只用流水里已有的信息（商品说明、交易对方、支付方式）。',
    '- 信息不够、写出来只能是废话的，把这行去掉。',
    '',
    '流水：',
    JSON.stringify(chunk.map(promptRow)),
    '',
    '输出示例：{"rows":[{"row_id":"12","notes":"给同事代付的团建餐费"}]}',
  ].join('\n');
}

function crossSourcePrompt(chunk: Candidate[]): string {
  const items = chunk.map((candidate) => ({
    ...candidate.row.payload,
    existing_transaction: candidate.match?.existing,
    matched_on: candidate.match?.matched_on,
  }));
  return [
    '下面每一行是一条待入账流水，加上系统在账本里找到的疑似重复交易。请判断像不像同一笔。',
    '',
    '要求：',
    '- verdict 三选一：duplicate（像是同一笔）、not_duplicate（不是同一笔）、unsure（说不准）。',
    '- reason：一句话说清依据，20 字以内。',
    '- 你只是给意见，不改任何判定，最终由人决定。',
    '',
    '数据：',
    JSON.stringify(items),
    '',
    '输出示例：{"rows":[{"row_id":"12","verdict":"duplicate","reason":"同商户同金额同一天"}]}',
  ].join('\n');
}

function promptRow(candidate: Candidate): Record<string, unknown> {
  return { ...candidate.row.payload, fill: candidate.fill };
}

async function parsedTaskIds(service: BillTaskService): Promise<number[]> {
  const ids: number[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await service.list({ status: 'parsed', page, limit: 100 });
    const data = record(body)?.data;
    if (!Array.isArray(data)) break;
    for (const item of data) {
      const id = Number(record(item)?.id);
      if (Number.isInteger(id) && id > 0) ids.push(id);
    }
    if (!hasNextPage(body, page)) break;
  }
  return ids;
}

/**
 * 分类白名单只取未禁用的分类，并按域切成两份：收支流水一份、转账桶一份。
 * 词表还没上 domain 字段时 allowedCategoryNames 会退回「全部未禁用分类」。
 */
async function loadCatalog(client: FireflyHttpClient): Promise<UserCatalog> {
  const [categories, assets, liabilities] = await Promise.all([
    loadCategoryCatalog(client, { includeDisabled: true }),
    loadNames(client, '/api/v1/accounts', { type: 'asset' }),
    loadNames(client, '/api/v1/accounts', { type: 'liabilities' }),
  ]);
  return {
    categories: allowedCategoryNames(categories, INCOME_EXPENSE_DOMAINS),
    transferCategories: allowedCategoryNames(categories, TRANSFER_DOMAINS),
    allNames: allowedCategoryNames(categories, [...CATEGORY_DOMAINS]),
    accounts: unique([...assets, ...liabilities]).slice(0, MAX_LIST_NAMES),
  };
}

async function loadNames(
  client: FireflyHttpClient,
  path: string,
  query: Record<string, string>,
): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await client.request('GET', path, { query: { ...query, page, limit: 100 } });
    const data = record(body)?.data;
    if (!Array.isArray(data)) break;
    for (const item of data) {
      const attributes = record(record(item)?.attributes);
      if (attributes?.active === false) continue;
      const name = trimmed(attributes?.name, 255);
      if (name) names.push(name);
    }
    if (!hasNextPage(body, page)) break;
  }
  return unique(names).slice(0, MAX_LIST_NAMES);
}

function statementRows(body: unknown): Map<string, StatementRow> {
  const data = record(body)?.data;
  const rows = new Map<string, StatementRow>();
  if (!Array.isArray(data)) return rows;
  for (const item of data) {
    const resource = record(item);
    const attributes = record(resource?.attributes);
    const rowId = trimmed(resource?.id, 32);
    if (!rowId || !attributes) continue;
    rows.set(rowId, {
      rowId,
      status: trimmed(attributes.status, 32),
      suggestedBy: trimmed(attributes.suggested_by, 32),
      userModifiedAt: trimmed(attributes.user_modified_at, 64),
      duplicateState: trimmed(attributes.duplicate_state, 32),
      fireflyType: trimmed(attributes.firefly_type, 32),
      categoryName: trimmed(attributes.category_name, 255),
      fireflyDescription: trimmed(attributes.firefly_description, 1_000),
      sourceName: trimmed(attributes.source_name, 255),
      destinationName: trimmed(attributes.destination_name, 255),
      notes: trimmed(attributes.notes, 32_768),
      payload: modelPayload(rowId, attributes),
    });
  }
  return rows;
}

/**
 * 喂给模型的行视图。刻意不含 counterparty_account、platform_order_no、
 * merchant_order_no、fingerprint、metadata：卡号订单号对填空没用，别外发。
 */
function modelPayload(rowId: string, attributes: Record<string, unknown>): Record<string, unknown> {
  return prune({
    row_id: rowId,
    date: trimmed(attributes.occurred_at, 32)?.slice(0, 10),
    direction: trimmed(attributes.direction, 32),
    amount: trimmed(attributes.amount, 64),
    currency: trimmed(attributes.currency_code, 16),
    type: trimmed(attributes.firefly_type, 32),
    platform_category: trimmed(attributes.platform_category, 255),
    counterparty: trimmed(attributes.counterparty, 255),
    description: trimmed(attributes.description, 500),
    payment_method: trimmed(attributes.payment_method, 255),
    source_name: trimmed(attributes.source_name, 255),
    destination_name: trimmed(attributes.destination_name, 255),
    category_name: trimmed(attributes.category_name, 255),
    remark: trimmed(attributes.remark, 255),
  });
}

/**
 * 机器已经确定的重复/冲突行、高置信已有交易，以及高置信跨源命中，一律不碰：
 * 三层指纹比模型可靠，这是既定立场。
 */
function blockedRowIds(review: unknown): Set<string> {
  const blocked = new Set<string>();
  for (const bucket of ['duplicate_candidates', 'conflict_candidates']) {
    for (const entry of bucketEntries(review, bucket)) {
      const rowId = trimmed(entry.row_id, 32);
      if (rowId) blocked.add(rowId);
    }
  }
  for (const entry of bucketEntries(review, 'existing_transaction_candidates')) {
    const rowId = trimmed(entry.row_id, 32);
    const candidates = Array.isArray(entry.candidates) ? entry.candidates : [];
    const highConfidence = candidates.some(
      (candidate) => trimmed(record(candidate)?.confidence, 32) === 'high',
    );
    if (rowId && highConfidence) blocked.add(rowId);
  }
  for (const entry of bucketEntries(review, 'cross_source_candidates')) {
    const rowId = trimmed(entry.row_id, 32);
    if (rowId && topMatchConfidence(entry) === 'high') blocked.add(rowId);
  }
  return blocked;
}

function eligibleRows(
  review: unknown,
  bucket: string,
  rows: Map<string, StatementRow>,
  blocked: Set<string>,
  fillFor: (row: StatementRow) => string[] | undefined,
): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const entry of bucketEntries(review, bucket)) {
    const rowId = trimmed(entry.row_id, 32);
    if (!rowId || seen.has(rowId)) continue;
    const row = rows.get(rowId);
    if (!row || !isUntouched(row, blocked)) continue;
    const fill = fillFor(row);
    if (!fill?.length) continue;
    seen.add(rowId);
    candidates.push({ row, fill });
  }
  return candidates;
}

function mediumCrossSourceRows(
  review: unknown,
  rows: Map<string, StatementRow>,
  blocked: Set<string>,
): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const entry of bucketEntries(review, 'cross_source_candidates')) {
    const rowId = trimmed(entry.row_id, 32);
    if (!rowId || seen.has(rowId) || topMatchConfidence(entry) !== 'medium') continue;
    const row = rows.get(rowId);
    if (!row || !isUntouched(row, blocked) || !isBlank(row.notes)) continue;
    seen.add(rowId);
    candidates.push({ row, fill: ['verdict'], match: topMatch(entry) });
  }
  return candidates;
}

/**
 * 幂等闸门：只处理没人碰过、也没机器填过的 pending 行。
 * 注意 as_suggestion 写入同样会落 user_modified_at，所以两个条件都要看。
 */
function isUntouched(row: StatementRow, blocked: Set<string>): boolean {
  if (row.status !== 'pending') return false;
  if (row.suggestedBy || row.userModifiedAt) return false;
  if (row.duplicateState === 'duplicate' || row.duplicateState === 'conflict') return false;
  return !blocked.has(row.rowId);
}

function bucketEntries(review: unknown, bucket: string): Array<Record<string, unknown>> {
  const value = record(review)?.[bucket];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = record(entry);
    return item ? [item] : [];
  });
}

function topMatch(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const matches = entry.cross_source_matches;
  return Array.isArray(matches) ? record(matches[0]) : undefined;
}

function topMatchConfidence(entry: Record<string, unknown>): string | undefined {
  return trimmed(topMatch(entry)?.confidence, 32);
}

function emptyStats(): AutofillRunStats {
  return {
    tasks: 0,
    candidate_rows: 0,
    updated_rows: 0,
    rule_rows: 0,
    skipped_tasks: 0,
    model_calls: 0,
  };
}

function isText(value: string | undefined): value is string {
  return typeof value === 'string';
}

function noop(): void {}
