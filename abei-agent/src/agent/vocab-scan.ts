import type { FireflyHttpClient } from '../core/http-client.js';
import type { RunLog } from './ai-runs.js';
import {
  domainsForTransactionType,
  loadCategoryCatalog,
  normalizeMerchant,
  ruleSubject,
  type CategoryCatalog,
  type CategoryDomain,
  type CategoryEntry,
} from './categorization.js';
import { hasNextPage, record, trimmed } from './shared.js';
import type { AiStore } from './store.js';

/** 信号一：同一模式攒够这么多笔「杂项/未分类」就提一次新建。 */
const CREATE_MIN_ROWS = 5;
/** 信号二：模式出现这么多次，才够资格把某个没启用的默认分类捞起来。 */
const ENABLE_MIN_ROWS = 3;
/** 一次扫描最多提这么多条，别一天糊用户一屏卡片。 */
const MAX_SUGGESTIONS_PER_SCAN = 5;
const LOOKBACK_DAYS = 180;
const MAX_PAGES = 20;
const MAX_SPLITS = 2_000;

/** 挂着这些分类等于没分类，跟未分类一起进扫描池。 */
const MISC_CATEGORY_NAMES = new Set([
  '杂项',
  '其他',
  '其它',
  '未分类',
  '其他支出',
  '其他收入',
  '其他购物',
]);

export interface VocabScanStats {
  splits: number;
  patterns: number;
  created: number;
}

interface LooseSplit {
  pattern: string;
  label: string;
  domain: CategoryDomain;
}

interface PatternGroup {
  pattern: string;
  label: string;
  domain: CategoryDomain;
  count: number;
  samples: string[];
}

/**
 * 每天扫一次词表：AI 唯一被允许对词表说话的方式。
 * 只写 vocab_suggestions，绝不自己动分类；忽略过的名字冷却期内不再提。
 */
export async function scanVocabulary(args: {
  ownerKey: string;
  client: FireflyHttpClient;
  store: AiStore;
  log: RunLog;
}): Promise<VocabScanStats> {
  const { ownerKey, client, store, log } = args;
  const stats: VocabScanStats = { splits: 0, patterns: 0, created: 0 };

  const [catalog, muted, splits] = await Promise.all([
    loadCategoryCatalog(client, { includeDisabled: true }),
    store.mutedVocabCategoryNames(ownerKey),
    looseSplits(client),
  ]);
  stats.splits = splits.length;
  if (splits.length === 0) return stats;

  const groups = [...groupPatterns(splits).values()].sort(
    (left, right) => right.count - left.count,
  );
  stats.patterns = groups.length;

  const activeNames = new Set(
    catalog.entries.filter((entry) => !entry.disabled).map((entry) => entry.name),
  );
  const budget = { left: MAX_SUGGESTIONS_PER_SCAN };

  // 信号二先跑：把已有的默认分类捞起来，好过让用户再造一个近义词。
  for (const entry of catalog.entries) {
    if (budget.left <= 0) break;
    if (!entry.disabled || entry.transactionsCount > 0 || muted.has(entry.name)) continue;
    const related = groups.find(
      (group) => group.count >= ENABLE_MIN_ROWS && namesRelate(group.pattern, entry.name),
    );
    if (!related) continue;
    const parent = parentOf(catalog, entry.parentId);
    await store.createVocabSuggestion(ownerKey, {
      action: 'enable',
      domain: entry.domain ?? related.domain,
      categoryId: entry.id,
      name: entry.name,
      parentId: parent?.id,
      parentName: parent?.name,
      icon: entry.icon,
      color: entry.color,
      reason: `近半年有 ${related.count} 笔「${related.label}」没归到合适的分类，和已停用的「${entry.name}」对得上。`,
      sampleCount: related.count,
      samples: related.samples,
    });
    log.add({
      kind: 'vocab_suggestion',
      action: 'enable',
      name: entry.name,
      sample_count: related.count,
      // 词表扫描全是本地统计，既没问模型也没读规则文档。
      basis: 'scan',
    });
    muted.add(entry.name);
    budget.left -= 1;
    stats.created += 1;
  }

  for (const group of groups) {
    if (budget.left <= 0) break;
    if (group.count < CREATE_MIN_ROWS) break;
    if (muted.has(group.label) || activeNames.has(group.label)) continue;
    // 图标色号和落位从近义分类抄一份，用户不用从零挑。
    const placement = recommendPlacement(catalog, group);
    await store.createVocabSuggestion(ownerKey, {
      action: 'create',
      domain: group.domain,
      name: group.label,
      parentId: placement?.parentId,
      parentName: placement?.parentName,
      icon: placement?.icon,
      color: placement?.color,
      reason: `近半年有 ${group.count} 笔「${group.label}」落在杂项或未分类里。`,
      sampleCount: group.count,
      samples: group.samples,
    });
    log.add({
      kind: 'vocab_suggestion',
      action: 'create',
      name: group.label,
      sample_count: group.count,
      basis: 'scan',
    });
    muted.add(group.label);
    budget.left -= 1;
    stats.created += 1;
  }

  return stats;
}

interface Placement {
  parentId?: string;
  parentName?: string;
  icon?: string;
  color?: string;
}

/**
 * 给新建建议找个落脚点：同域里名字沾边的分类，用它的组和图标色。
 * 找不到就留空，让用户在分类管理页自己挑。
 */
function recommendPlacement(catalog: CategoryCatalog, group: PatternGroup): Placement | undefined {
  const related = catalog.entries.find(
    (entry) =>
      !entry.disabled &&
      (entry.domain ?? 'expense') === group.domain &&
      namesRelate(group.pattern, entry.name),
  );
  if (!related) return undefined;
  const parent = related.parentId ? parentOf(catalog, related.parentId) : related;
  return {
    parentId: parent?.id,
    parentName: parent?.name,
    icon: related.icon ?? parent?.icon,
    color: related.color ?? parent?.color,
  };
}

function groupPatterns(splits: LooseSplit[]): Map<string, PatternGroup> {
  const groups = new Map<string, PatternGroup>();
  for (const split of splits) {
    const existing = groups.get(split.pattern);
    if (existing) {
      existing.count += 1;
      if (existing.samples.length < 5) existing.samples.push(split.label);
      continue;
    }
    groups.set(split.pattern, {
      pattern: split.pattern,
      label: split.label,
      domain: split.domain,
      count: 1,
      samples: [split.label],
    });
  }
  return groups;
}

/** 「宠物」对上「宠物用品」算相关；两边都归一化后互相包含即可。 */
function namesRelate(pattern: string, categoryName: string): boolean {
  const name = normalizeMerchant(categoryName);
  if (name.length < 2 || pattern.length < 2) return false;
  return pattern.includes(name) || name.includes(pattern);
}

function parentOf(
  catalog: CategoryCatalog,
  parentId: string | undefined,
): CategoryEntry | undefined {
  if (!parentId) return undefined;
  return catalog.entries.find((entry) => entry.id === parentId);
}

/** 未分类，外加挂着「杂项/其他」这类兜底分类的近半年流水。 */
async function looseSplits(client: FireflyHttpClient): Promise<LooseSplit[]> {
  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 86_400_000);
  const splits: LooseSplit[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await client.request('GET', '/api/v1/transactions', {
      query: {
        page,
        limit: 100,
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
      },
    });
    const data = record(body)?.data;
    if (!Array.isArray(data)) break;
    for (const item of data) {
      for (const split of splitsOf(record(item))) {
        const loose = toLooseSplit(split);
        if (loose) splits.push(loose);
      }
    }
    if (!hasNextPage(body, page) || splits.length >= MAX_SPLITS) break;
  }
  return splits.slice(0, MAX_SPLITS);
}

function splitsOf(resource: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const value = record(resource?.attributes)?.transactions;
  if (!Array.isArray(value)) return [];
  return value.flatMap((split) => {
    const item = record(split);
    return item ? [item] : [];
  });
}

function toLooseSplit(split: Record<string, unknown>): LooseSplit | undefined {
  const category = trimmed(split.category_name, 255);
  if (category && !MISC_CATEGORY_NAMES.has(category)) return undefined;
  const type = trimmed(split.type, 32);
  const domains = domainsForTransactionType(type);
  if (domains.length !== 1) return undefined;

  const destination = trimmed(split.destination_name, 255);
  const description = trimmed(split.description, 500);
  const source = trimmed(split.source_name, 255);
  const label = type === 'deposit' ? (source ?? description) : (destination ?? description);
  const [pattern] = ruleSubject([label, description]).merchants;
  if (!pattern || !label) return undefined;
  return { pattern, label: label.slice(0, 40), domain: domains[0] };
}
