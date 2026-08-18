/**
 * 学习闭环：从「阿贝建议过什么、人最后改成了什么」里攒规则，攒够了写进
 * 《个人记账规则》的「商户固定分类」。
 *
 * 两条信号，都从已有数据里推，不新加任何字段：
 * - 纠正：预填记录里阿贝给某一行建议过分类 C，这一行现在 user_modified_at 非空
 *   （abei-server 只在人改的时候写这个字段，机器写建议时它保持不变），
 *   而且分类已经不是 C 了 —— 人把 C 改成了别的。
 * - 确认：分类还是 C，而且这一行已经入账 —— 人原样认了这条建议。
 *
 * 攒够阈值就静默并入文档（用户已经拍板「默默自进化」，不弹窗），
 * 每一条新增和失效都记进 ai_runs，人在 /profile 上看得见阿贝学了什么。
 */

import { FireflyHttpError } from '../core/errors.js';
import type { FireflyHttpClient } from '../core/http-client.js';
import { BillTaskService } from '../services/bill-task-service.js';
import type { RunLog } from './ai-runs.js';
import {
  applyRuleEdits,
  formatRuleLine,
  loadRulesDocRecord,
  normalizePattern,
  parseMerchantRules,
  saveRulesDoc,
  type DocRule,
  type RuleAddition,
  type RuleRetirement,
} from './rule-doc.js';
import { errorMessage, record, trimmed } from './shared.js';
import type { AiStore } from './store.js';

/** 同一个商户攒够这么多次一致的信号，才敢往文档里写一条规则。 */
export const LEARN_THRESHOLD = 3;

/** 往回翻这么多条预填记录找信号。90 天保留期内，这个窗口够宽了。 */
const MAX_RUNS_SCANNED = 100;

/** 一轮最多回访这么多个账单文档，免得一次学习把 API 打满。 */
const MAX_TASKS_PER_RUN = 30;

/** 商户名短于这个长度当噪声（单字规则会误伤一大片），长于上限说明没清洗干净。 */
const MIN_MERCHANT_LENGTH = 2;
const MAX_MERCHANT_LENGTH = 20;

export interface LearnRunStats {
  /** 认出来的纠正 + 确认次数。 */
  signals: number;
  /** 新写进文档的规则条数。 */
  learned: number;
  /** 搬进「已失效规则」的条数。 */
  retired: number;
}

export type SignalKind = 'corrected' | 'confirmed';

/** 一条学习信号：这个商户，人最后认的是这个分类。 */
export interface LearnSignal {
  merchant: string;
  categoryName: string;
  kind: SignalKind;
}

/** 某个商户下，各分类各攒了多少次。 */
export interface MerchantTally {
  /** 展示用的商户名，取第一次见到的原样写法。 */
  merchant: string;
  categories: Map<string, { corrected: number; confirmed: number }>;
}

export interface RuleChange {
  merchant: string;
  categoryName: string;
  corrected: number;
  confirmed: number;
  /** 因为它才停用的那条旧规则原文。 */
  replaces?: string;
}

export interface RuleChanges {
  learned: RuleChange[];
  retired: Array<{ rule: DocRule; change: RuleChange }>;
}

export interface LearnOptions {
  ownerKey: string;
  client: FireflyHttpClient;
  abeiUrl: string;
  store: AiStore;
  log: RunLog;
  /** 失效行里写的日期。测试传死值。 */
  today?: string;
}

/**
 * 跑一轮学习。没信号、没变化都返回全零，调用方据此不落运行记录。
 * 规则文档还没建的时候直接收工：规则得有地方写，替人凭空建一份不合适。
 */
export async function runLearning(options: LearnOptions): Promise<LearnRunStats> {
  const stats: LearnRunStats = { signals: 0, learned: 0, retired: 0 };
  const suggestions = await collectSuggestions(options.store, options.ownerKey);
  if (suggestions.size === 0) return stats;

  const service = new BillTaskService(options.client.withBaseUrl(options.abeiUrl));
  const signals = await collectSignals(service, suggestions);
  stats.signals = signals.length;
  if (signals.length === 0) return stats;

  const doc = await loadRulesDocRecord(options.client, options.abeiUrl);
  if (!doc) {
    console.log('[learn] 还没有《个人记账规则》，学到的东西先攒着。');
    return stats;
  }

  const existing = parseMerchantRules(doc.contentMd);
  const changes = decideRuleChanges(aggregate(signals), existing);
  if (changes.learned.length === 0 && changes.retired.length === 0) return stats;

  const added: RuleAddition[] = changes.learned.map((change) => ({
    pattern: change.merchant,
    categoryName: change.categoryName,
  }));
  const retired: RuleRetirement[] = changes.retired.map((item) => ({
    line: item.rule.line,
    reason: `最近 ${item.change.corrected} 次都改成了「${item.change.categoryName}」`,
  }));
  const contentMd = applyRuleEdits(doc.contentMd, { added, retired, today: options.today });
  if (contentMd === doc.contentMd) return stats;

  try {
    await saveRulesDoc(options.client, options.abeiUrl, {
      contentMd,
      expectedVersion: doc.version,
    });
  } catch (error) {
    // 409 是「文档刚被人改过」。学习可以等下一轮，覆盖用户刚写的东西不行。
    if (error instanceof FireflyHttpError && error.status === 409) {
      console.log('[learn] 规则文档刚被改过，这一轮先不写。');
      return stats;
    }
    throw error;
  }

  for (const item of changes.retired) {
    options.log.add({
      kind: 'rule_retired',
      basis: 'learn',
      merchant: item.change.merchant,
      line: item.rule.line,
      category_name: item.change.categoryName,
      corrected: item.change.corrected,
    });
  }
  for (const change of changes.learned) {
    options.log.add({
      kind: 'rule_learned',
      basis: 'learn',
      merchant: change.merchant,
      line: formatRuleLine(change.merchant, change.categoryName),
      category_name: change.categoryName,
      corrected: change.corrected,
      confirmed: change.confirmed,
      ...(change.replaces ? { replaces: change.replaces } : {}),
    });
  }
  stats.learned = changes.learned.length;
  stats.retired = changes.retired.length;
  return stats;
}

/** 阿贝当初给某一行建议过的分类。 */
interface PastSuggestion {
  taskId: number;
  categoryName: string;
}

/**
 * 从预填记录的明细里翻出「哪一行被建议成了什么分类」。
 * 记录是倒序的，同一行只认最近那一次建议。
 */
async function collectSuggestions(
  store: AiStore,
  ownerKey: string,
): Promise<Map<string, PastSuggestion>> {
  const runs = await store.listAiRuns(ownerKey, {
    kind: 'autofill',
    limit: MAX_RUNS_SCANNED,
    withDetail: true,
  });
  const suggestions = new Map<string, PastSuggestion>();
  for (const run of runs) {
    for (const raw of run.detail ?? []) {
      const entry = record(raw);
      if (!entry || entry.kind !== 'bill_row') continue;
      const rowId = trimmed(entry.row_id, 32);
      const taskId = Number(entry.task_id);
      const categoryName = trimmed(record(entry.values)?.category_name, 255);
      if (!rowId || !categoryName || !Number.isInteger(taskId) || suggestions.has(rowId)) continue;
      suggestions.set(rowId, { taskId, categoryName });
    }
  }
  return suggestions;
}

/** 回访这些行现在长什么样，比出信号。某个文档读不到就跳过，不拖垮整轮。 */
async function collectSignals(
  service: BillTaskService,
  suggestions: Map<string, PastSuggestion>,
): Promise<LearnSignal[]> {
  const byTask = new Map<number, string[]>();
  for (const [rowId, suggestion] of suggestions) {
    const rowIds = byTask.get(suggestion.taskId) ?? [];
    rowIds.push(rowId);
    byTask.set(suggestion.taskId, rowIds);
  }

  const signals: LearnSignal[] = [];
  for (const taskId of [...byTask.keys()].slice(0, MAX_TASKS_PER_RUN)) {
    let rows: Map<string, CurrentRow>;
    try {
      rows = currentRows(await service.rows(String(taskId)));
    } catch (error) {
      console.error(`[learn] 账单 ${taskId} 读取失败：${errorMessage(error)}`);
      continue;
    }
    for (const rowId of byTask.get(taskId) ?? []) {
      const row = rows.get(rowId);
      const suggested = suggestions.get(rowId);
      if (!row || !suggested) continue;
      const signal = classifyRow(row, suggested.categoryName);
      if (signal) signals.push(signal);
    }
  }
  return signals;
}

/** 回访时用得上的那几个字段。 */
interface CurrentRow {
  status?: string;
  userModifiedAt?: string;
  categoryName?: string;
  counterparty?: string;
  description?: string;
}

/**
 * 一行现在的样子对上当初的建议，看得出什么。
 * 看不出来的（还没人碰、商户名认不出）一律返回 undefined，宁可不学。
 */
export function classifyRow(row: CurrentRow, suggested: string): LearnSignal | undefined {
  const merchant = merchantKeyword(row);
  if (!merchant || !row.categoryName) return undefined;
  if (row.categoryName !== suggested) {
    return row.userModifiedAt
      ? { merchant, categoryName: row.categoryName, kind: 'corrected' }
      : undefined;
  }
  return row.status === 'imported'
    ? { merchant, categoryName: row.categoryName, kind: 'confirmed' }
    : undefined;
}

/**
 * 从流水里取商户名：交易对方最准，没有就退回描述。
 *
 * 清洗只做有把握的几步：剥支付渠道前缀、砍括号和分隔符后面的门店/订单号、
 * 去掉公司后缀。洗完还是太长或太短就当认不出——学不出规则总比学错强。
 */
export function merchantKeyword(row: {
  counterparty?: string;
  description?: string;
}): string | undefined {
  for (const source of [row.counterparty, row.description]) {
    const keyword = cleanMerchant(source);
    if (keyword) return keyword;
  }
  return undefined;
}

function cleanMerchant(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let text = value.normalize('NFKC').trim();
  for (const prefix of CHANNEL_PREFIXES) {
    if (text.startsWith(prefix)) text = text.slice(prefix.length).replace(/^[-—_:：\s]+/u, '');
  }
  text = text.split(SPLITTERS)[0].trim();
  text = text.replace(COMPANY_SUFFIX, '').trim();
  if (text.length < MIN_MERCHANT_LENGTH || text.length > MAX_MERCHANT_LENGTH) return undefined;
  // 纯数字、纯符号不是商户名，别拿去当规则。
  if (!/[\p{L}]/u.test(text)) return undefined;
  return text;
}

const CHANNEL_PREFIXES = [
  '财付通',
  '支付宝',
  '微信支付',
  '微信红包',
  '银联',
  '快捷支付',
  '网上银行',
  '手机银行',
];
/** 门店后缀、订单号一般跟在这些符号后面，砍掉只留商户主名。 */
const SPLITTERS = /[(（【[|,，、;；/\\]|-{1,2}|—/u;
const COMPANY_SUFFIX =
  /(?:股份)?(?:有限)?(?:责任)?公司$|分公司$|门店$|旗舰店$|专营店$|官方店$|连锁店$/u;

/** 按商户归堆，同一个商户下再按分类计数。 */
export function aggregate(signals: LearnSignal[]): Map<string, MerchantTally> {
  const tallies = new Map<string, MerchantTally>();
  for (const signal of signals) {
    const key = normalizePattern(signal.merchant);
    if (!key) continue;
    const tally = tallies.get(key) ?? { merchant: signal.merchant, categories: new Map() };
    const counts = tally.categories.get(signal.categoryName) ?? { corrected: 0, confirmed: 0 };
    counts[signal.kind] += 1;
    tally.categories.set(signal.categoryName, counts);
    tallies.set(key, tally);
  }
  return tallies;
}

/**
 * 攒的数变成要改的规则。三条判断：
 * - 同一个商户下出现两个分类就是有冲突，一条也不动——人自己都没拿定主意。
 * - 已经有规则管着这个商户、方向也一致：什么都不用做。
 * - 已有规则指向别的分类：纠正次数够了才停用它，并写上新的。
 * 谁都没管的商户：纠正加确认够了就写一条新的。
 */
export function decideRuleChanges(
  tallies: Map<string, MerchantTally>,
  existing: DocRule[],
): RuleChanges {
  const changes: RuleChanges = { learned: [], retired: [] };
  // 一条旧规则可能同时被好几个商户推翻，但它只能被搬走一次。
  const alreadyRetired = new Set<string>();
  for (const tally of tallies.values()) {
    const categories = [...tally.categories.entries()];
    if (categories.length !== 1) continue;
    const [categoryName, counts] = categories[0];
    const change: RuleChange = { merchant: tally.merchant, categoryName, ...counts };

    // 规则的词是商户名的一部分，就说明这条规则管得着这个商户（和跑批时同一套判断）。
    const needle = normalizePattern(tally.merchant);
    const covering = existing.filter((rule) => {
      const pattern = normalizePattern(rule.pattern);
      return pattern !== '' && needle.includes(pattern);
    });
    const conflicting = covering.filter((rule) => rule.categoryName !== categoryName);

    if (conflicting.length === 0) {
      if (covering.length > 0) continue;
      if (counts.corrected + counts.confirmed < LEARN_THRESHOLD) continue;
      changes.learned.push(change);
      continue;
    }
    if (counts.corrected < LEARN_THRESHOLD) continue;
    for (const rule of conflicting) {
      if (alreadyRetired.has(rule.line)) continue;
      alreadyRetired.add(rule.line);
      changes.retired.push({ rule, change });
    }
    changes.learned.push({ ...change, replaces: conflicting[0].line });
  }
  return changes;
}

function currentRows(body: unknown): Map<string, CurrentRow> {
  const data = record(body)?.data;
  const rows = new Map<string, CurrentRow>();
  if (!Array.isArray(data)) return rows;
  for (const item of data) {
    const resource = record(item);
    const attributes = record(resource?.attributes);
    const rowId = trimmed(resource?.id, 32);
    if (!rowId || !attributes) continue;
    rows.set(rowId, {
      status: trimmed(attributes.status, 32),
      userModifiedAt: trimmed(attributes.user_modified_at, 64),
      categoryName: trimmed(attributes.category_name, 255),
      counterparty: trimmed(attributes.counterparty, 255),
      description: trimmed(attributes.description, 500),
    });
  }
  return rows;
}
