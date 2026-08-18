import type { FireflyHttpClient } from '../core/http-client.js';
import type { RunLog } from './ai-runs.js';
import {
  allowedCategoryNames,
  categoryIdsByName,
  CATEGORY_DOMAINS,
  domainsForTransactionType,
  loadCategoryCatalog,
  ruleSubject,
  type CategoryCatalog,
} from './categorization.js';
import { askModelRows, pairAnswers } from './model-json.js';
import type { ModelRuntime } from './model-runtime.js';
import {
  loadRulesDoc,
  matchDocRule,
  rulesSystemSection,
  unknownCategoryRules,
  type DocRule,
} from './rule-doc.js';
import { chunk, errorMessage, hasNextPage, isBlank, prune, record, trimmed } from './shared.js';
import type { AiStore } from './store.js';

/** 一轮回填最多处理这么多笔，防止账本超大时把模型额度烧光。 */
const MAX_JOURNALS = 1_000;
const MAX_PAGES = 40;
const MAX_ROWS_PER_CALL = 25;

const SYSTEM_PROMPT = `你是阿贝的历史交易分类助手。你只给建议，不改账本。

规则：
- 只输出一个 JSON 对象，形如 {"rows":[...]}；不要代码块，不要解释，不要多余文字。
- 拿不准就别填：把那一行整条从 rows 里去掉，宁可留空也不要编。
- 分类名只能从给定清单里原样照抄，一个字都不能改，禁止发明新名字。
- 不要碰金额、日期、收支方向。`;

export interface BackfillRunStats {
  journals: number;
  rule_suggestions: number;
  model_suggestions: number;
  skipped: number;
  model_calls: number;
}

interface BackfillJournal {
  groupId: string;
  journalId: string;
  type: string;
  date?: string;
  description?: string;
  amount?: string;
  currencyCode?: string;
  /** 只喂给模型的精简视图；不含 external_id、internal_reference 等外部单号。 */
  payload: Record<string, unknown>;
  texts: Array<string | undefined>;
}

/**
 * 未分类回填：把账本里没挂分类的交易逐笔出建议，规则优先、模型兜底，
 * 写进 backfill_suggestions 等人确认。这里从不直接改交易。
 */
export async function runBackfill(args: {
  ownerKey: string;
  client: FireflyHttpClient;
  /** abei-api 地址。规则文档从这里读，和账单接口同一条路。 */
  abeiUrl: string;
  store: AiStore;
  runtime: ModelRuntime;
  log: RunLog;
}): Promise<BackfillRunStats> {
  const { ownerKey, client, store, runtime, log } = args;
  const stats: BackfillRunStats = {
    journals: 0,
    rule_suggestions: 0,
    model_suggestions: 0,
    skipped: 0,
    model_calls: 0,
  };
  if (!runtime.model || runtime.error) throw new Error(runtime.error ?? '模型不可用。');

  const [journals, catalog, doc] = await Promise.all([
    uncategorizedJournals(client),
    loadCategoryCatalog(client, { includeDisabled: true }),
    // 没有规则文档只是回到「全靠模型」，不该让整轮回填失败。
    loadRulesDoc(client, args.abeiUrl).catch((error: unknown) => {
      console.error(`[backfill] 规则文档读取失败：${errorMessage(error)}`);
      return undefined;
    }),
  ]);
  const rules = doc?.rules ?? [];
  for (const rule of unknownCategoryRules(
    rules,
    allowedCategoryNames(catalog, [...CATEGORY_DOMAINS]),
  )) {
    log.note(`规则指向不存在的分类：${rule.line}`);
  }
  const systemPrompt = doc
    ? `${SYSTEM_PROMPT}\n\n${rulesSystemSection(doc.contentMd)}`
    : SYSTEM_PROMPT;
  const categoryIds = categoryIdsByName(catalog);
  stats.journals = journals.length;
  if (journals.length === 0) return stats;

  const pending: BackfillJournal[] = [];

  for (const journal of journals) {
    const allowed = allowedFor(catalog, journal);
    const rule = matchRuleFor(rules, journal, allowed);
    if (rule) {
      await write(store, ownerKey, journal, rule.categoryName, 'rule', categoryIds);
      log.add(entryFor(journal, rule.categoryName, `rule:${rule.line}`));
      stats.rule_suggestions += 1;
    } else if (allowed.size > 0) {
      pending.push(journal);
    } else {
      stats.skipped += 1;
    }
  }

  // 按域分批问模型：一批里的候选清单必须一致，否则白名单校验没意义。
  for (const [domainKey, group] of groupByDomain(pending).entries()) {
    const allowed = allowedFor(catalog, group[0]);
    const names = [...allowed];
    for (const batch of chunk(group, MAX_ROWS_PER_CALL)) {
      let answers: Array<Record<string, unknown>>;
      try {
        answers = await askModelRows({
          runtime,
          systemPrompt,
          prompt: classifyPrompt(batch, names),
          onCall: () => {
            stats.model_calls += 1;
          },
        });
      } catch (error) {
        stats.skipped += batch.length;
        console.error(`[backfill] ${domainKey} 一批跳过：${errorMessage(error)}`);
        continue;
      }
      const answered = new Set<string>();
      for (const [answer, journal] of pairAnswers(answers, batch, (item) => item.journalId)) {
        const category = trimmed(answer.category_name, 255);
        if (!category || !allowed.has(category)) continue;
        await write(store, ownerKey, journal, category, 'model', categoryIds);
        log.add(entryFor(journal, category, doc ? 'doc' : 'model'));
        answered.add(journal.journalId);
        stats.model_suggestions += 1;
      }
      stats.skipped += batch.length - answered.size;
    }
  }

  return stats;
}

function entryFor(journal: BackfillJournal, categoryName: string, basis: string) {
  return {
    kind: 'transaction',
    journal_id: journal.journalId,
    transaction_group_id: journal.groupId,
    description: journal.description,
    values: { category_name: categoryName },
    basis,
  };
}

function write(
  store: AiStore,
  ownerKey: string,
  journal: BackfillJournal,
  categoryName: string,
  source: 'rule' | 'model',
  categoryIds: Map<string, string>,
): Promise<void> {
  return store.upsertBackfillSuggestion(ownerKey, {
    journalId: journal.journalId,
    transactionGroupId: journal.groupId,
    date: journal.date,
    description: journal.description,
    amount: journal.amount,
    currencyCode: journal.currencyCode,
    categoryId: categoryIds.get(categoryName),
    categoryName,
    source,
  });
}

function allowedFor(catalog: CategoryCatalog, journal: BackfillJournal): Set<string> {
  return allowedCategoryNames(catalog, domainsForTransactionType(journal.type));
}

function matchRuleFor(
  rules: DocRule[],
  journal: BackfillJournal,
  allowed: Set<string>,
): DocRule | undefined {
  return matchDocRule(rules, ruleSubject(journal.texts), allowed);
}

function groupByDomain(journals: BackfillJournal[]): Map<string, BackfillJournal[]> {
  const groups = new Map<string, BackfillJournal[]>();
  for (const journal of journals) {
    const key = domainsForTransactionType(journal.type).join('+');
    const existing = groups.get(key);
    if (existing) existing.push(journal);
    else groups.set(key, [journal]);
  }
  return groups;
}

/**
 * 先试搜索端点，搜不动（旧版本或语法不支持）就分页拉全部交易客户端过滤。
 * 两条路最后都过同一个「分类为空」的筛子，宁可多拉一遍也不能漏。
 */
async function uncategorizedJournals(client: FireflyHttpClient): Promise<BackfillJournal[]> {
  const searched = await collectJournals(client, '/api/v1/search/transactions', {
    query: 'has_no_category:true',
  }).catch((error: unknown) => {
    console.error(`[backfill] 搜索端点不可用，改为全量分页：${errorMessage(error)}`);
    return [] as BackfillJournal[];
  });
  if (searched.length > 0) return searched;
  return collectJournals(client, '/api/v1/transactions', {});
}

async function collectJournals(
  client: FireflyHttpClient,
  path: string,
  query: Record<string, string>,
): Promise<BackfillJournal[]> {
  const journals: BackfillJournal[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await client.request('GET', path, { query: { ...query, page, limit: 100 } });
    const data = record(body)?.data;
    if (!Array.isArray(data)) break;
    for (const item of data) {
      const resource = record(item);
      const groupId = trimmed(resource?.id, 32);
      const splits = record(resource?.attributes)?.transactions;
      if (!groupId || !Array.isArray(splits)) continue;
      for (const split of splits) {
        const journal = toJournal(groupId, record(split));
        if (!journal || seen.has(journal.journalId)) continue;
        seen.add(journal.journalId);
        journals.push(journal);
      }
    }
    if (!hasNextPage(body, page) || journals.length >= MAX_JOURNALS) break;
  }
  return journals.slice(0, MAX_JOURNALS);
}

function toJournal(
  groupId: string,
  split: Record<string, unknown> | undefined,
): BackfillJournal | undefined {
  if (!split) return undefined;
  const journalId = trimmed(split.transaction_journal_id, 32);
  if (!journalId) return undefined;
  if (!isBlank(trimmed(split.category_name, 255)) || !isBlank(trimmed(split.category_id, 32))) {
    return undefined;
  }
  const description = trimmed(split.description, 500);
  const sourceName = trimmed(split.source_name, 255);
  const destinationName = trimmed(split.destination_name, 255);
  const notes = trimmed(split.notes, 300);
  const type = trimmed(split.type, 32);
  const date = trimmed(split.date, 32)?.slice(0, 10);
  const amount = trimmed(split.amount, 64);
  const currencyCode = trimmed(split.currency_code, 16);
  return {
    groupId,
    journalId,
    type: type ?? '',
    date,
    description,
    amount,
    currencyCode,
    texts: [destinationName, description, notes, sourceName],
    payload: prune({
      row_id: journalId,
      date,
      type,
      amount,
      currency: currencyCode,
      description,
      source_name: sourceName,
      destination_name: destinationName,
      notes,
    }),
  };
}

function classifyPrompt(batch: BackfillJournal[], categories: string[]): string {
  return [
    '下面是我账本里还没有分类的交易，请给每一笔挑一个分类。',
    '',
    `分类清单（只能从中挑一个，原样照抄；共 ${categories.length} 个）：`,
    categories.join('、') || '（暂无可用分类，这一批全部去掉）',
    '',
    '要求：',
    '- category_name：挑最贴切的一个；清单里没有合适的就把这一行去掉。',
    '- 除了 row_id 和 category_name，不要输出别的字段。',
    '',
    '交易：',
    JSON.stringify(batch.map((journal) => journal.payload)),
    '',
    '输出示例：{"rows":[{"row_id":"12","category_name":"餐饮/外卖"}]}',
  ].join('\n');
}
