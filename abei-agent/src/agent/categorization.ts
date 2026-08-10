import type { FireflyHttpClient } from '../core/http-client.js';
import type { CategoryRule } from './store.js';
import { hasNextPage, record, trimmed, unique } from './shared.js';

/** 三个固定域，跟 firefly-iii 的 categories.domain 一一对应。 */
export const CATEGORY_DOMAINS = ['income', 'expense', 'transfer'] as const;
export type CategoryDomain = (typeof CATEGORY_DOMAINS)[number];

/** 收支流水的白名单：收入域 + 支出域。转账桶另算。 */
export const INCOME_EXPENSE_DOMAINS: CategoryDomain[] = ['income', 'expense'];
export const TRANSFER_DOMAINS: CategoryDomain[] = ['transfer'];

const MAX_CATEGORY_PAGES = 10;
const MAX_CATALOG_SIZE = 500;

export interface CategoryEntry {
  id: string;
  name: string;
  /** fork 还没上 domain 字段时是 undefined。 */
  domain?: CategoryDomain;
  parentId?: string;
  icon?: string;
  color?: string;
  disabled: boolean;
  transactionsCount: number;
}

export interface CategoryCatalog {
  entries: CategoryEntry[];
  /**
   * 词表 domain 字段是否已经落地。没落地就退回 v0.1 行为（不按域过滤），
   * 免得分类引擎在 firefly-iii 那半边上线之前直接哑掉。
   */
  hasDomains: boolean;
}

/**
 * 拉未禁用分类当白名单。Firefly 的默认列表本来就不返回 disabled 的，
 * includeDisabled 只给词表扫描用（要看「从未使用的默认组」）。
 */
export async function loadCategoryCatalog(
  client: FireflyHttpClient,
  options: { includeDisabled?: boolean } = {},
): Promise<CategoryCatalog> {
  const entries: CategoryEntry[] = [];
  let hasDomains = false;

  for (let page = 1; page <= MAX_CATEGORY_PAGES; page += 1) {
    const body = await client.request('GET', '/api/v1/categories', {
      query: {
        page,
        limit: 100,
        ...(options.includeDisabled ? { include_disabled: 1 } : {}),
      },
    });
    const data = record(body)?.data;
    if (!Array.isArray(data)) break;
    for (const item of data) {
      const resource = record(item);
      const attributes = record(resource?.attributes);
      const name = trimmed(attributes?.name, 255);
      if (!attributes || !name) continue;
      const domain = parseDomain(attributes.domain);
      if (domain) hasDomains = true;
      entries.push({
        id: String(resource?.id ?? ''),
        name,
        domain,
        parentId: trimmed(attributes.parent_id, 32),
        icon: trimmed(attributes.icon, 64),
        color: trimmed(attributes.color, 16),
        disabled: Boolean(attributes.disabled_at),
        transactionsCount: Number(attributes.transactions_count ?? 0),
      });
    }
    if (!hasNextPage(body, page) || entries.length >= MAX_CATALOG_SIZE) break;
  }

  return { entries: entries.slice(0, MAX_CATALOG_SIZE), hasDomains };
}

/**
 * 白名单精确校验用的名字集合：只含未禁用、且落在给定域里的分类。
 * domain 缺省按支出域算（跟 firefly-iii 的列默认值一致）。
 */
export function allowedCategoryNames(
  catalog: CategoryCatalog,
  domains: CategoryDomain[],
): Set<string> {
  const wanted = new Set(domains);
  const names = catalog.entries
    .filter((entry) => !entry.disabled)
    .filter((entry) => !catalog.hasDomains || wanted.has(entry.domain ?? 'expense'))
    .map((entry) => entry.name);
  return new Set(names);
}

/** 未禁用分类的名字 → id，回填建议要把 category_id 一起给前端。 */
export function categoryIdsByName(catalog: CategoryCatalog): Map<string, string> {
  const ids = new Map<string, string>();
  for (const entry of catalog.entries) {
    if (!entry.disabled && entry.id && !ids.has(entry.name)) ids.set(entry.name, entry.id);
  }
  return ids;
}

/** 规则被自动停用时写进 disabled_reason 的固定说法。 */
export const RULE_DISABLED_CATEGORY_GONE = '目标分类已删除';

/** 规则级联用：账本里现存的全部分类名（含被禁用的，禁用不等于删除）。 */
export function knownCategoryNames(catalog: CategoryCatalog): string[] {
  return unique(catalog.entries.map((entry) => entry.name));
}

export function parseDomain(value: unknown): CategoryDomain | undefined {
  return typeof value === 'string' && (CATEGORY_DOMAINS as readonly string[]).includes(value)
    ? (value as CategoryDomain)
    : undefined;
}

/** 收支方向 → 域。回填和词表扫描都按这张表挑白名单。 */
export function domainsForTransactionType(type: string | undefined): CategoryDomain[] {
  if (type === 'withdrawal') return ['expense'];
  if (type === 'deposit') return ['income'];
  if (type === 'transfer') return ['transfer'];
  return [...CATEGORY_DOMAINS];
}

const BRACKETS = /[（(【[][^）)】\]]*[）)】\]]/gu;
const SEPARATORS = /[-–—_|/\\·•]/u;
const TRAILING_CODE = /[\s#]*(?:no\.?)?\d{2,}$/iu;
const REGION_PREFIX = /^(?:北京|上海|天津|重庆|[一-龥]{2,3}(?:省|市|自治区))/u;
/**
 * 只砍明确的门店/公司后缀，且贪婪匹配保住尽量长的头部：
 * 宁可留成「肯德基北京朝阳」这种偏细的键，也不能截成「肯德」去撞别的牌子。
 * 想按品牌一网打尽，用 keyword 规则。
 */
const STORE_SUFFIXES = [
  /^(.{2,})[一-龥]{0,4}(?:分店|门店|旗舰店|专卖店|连锁店)$/u,
  /^(.{2,})(?:股份有限公司|有限责任公司|有限公司|分公司|服务中心)$/u,
];

/**
 * 对手方归一化：「美团-北京朝阳店」→「美团」。
 * bill-ingestion 那边只做了小写和空白折叠，门店编号/地区后缀是这里补的，
 * 规则一多就得抬到共享实现，眼下够用。
 */
export function normalizeMerchant(value: string | undefined): string {
  if (!value) return '';
  let text = value.normalize('NFKC').toLowerCase().replace(BRACKETS, ' ');
  text = text.replace(/\s+/gu, ' ').trim();
  if (!text) return '';

  const [head] = text.split(SEPARATORS);
  if (head && head.trim().length >= 2) text = head.trim();

  text = text.replace(TRAILING_CODE, '').trim();

  const withoutRegion = text.replace(REGION_PREFIX, '').trim();
  if (withoutRegion.length >= 2) text = withoutRegion;

  for (const pattern of STORE_SUFFIXES) {
    const match = pattern.exec(text);
    if (match?.[1] && match[1].length >= 2) {
      text = match[1];
      break;
    }
  }

  return text.replace(/\s+/gu, '').slice(0, 120);
}

export interface RuleSubject {
  /** 归一化后的候选商户名，按可信度从高到低。 */
  merchants: string[];
  /** 关键词匹配用的小写全文。 */
  haystack: string;
}

export function ruleSubject(texts: Array<string | undefined>): RuleSubject {
  const present = texts.flatMap((text) => (text && text.trim() ? [text.trim()] : []));
  return {
    merchants: unique(present.map(normalizeMerchant).filter((text) => text.length >= 2)),
    haystack: present.join(' ').normalize('NFKC').toLowerCase(),
  };
}

/**
 * 规则优先于模型：商户规则要求归一化后完全相等，关键词规则做包含。
 * 规则指向的分类不在白名单里（被删、被禁用、域不对）就当没命中——
 * 分类名回写前的白名单校验对规则一视同仁。
 */
export function matchCategoryRule(
  rules: CategoryRule[],
  subject: RuleSubject,
  allowed: Set<string>,
): CategoryRule | undefined {
  const usable = rules.filter((rule) => rule.enabled && allowed.has(rule.category_name));
  const merchants = new Set(subject.merchants);
  for (const rule of usable) {
    if (rule.pattern_type === 'merchant' && merchants.has(normalizeMerchant(rule.pattern))) {
      return rule;
    }
  }
  for (const rule of usable) {
    const keyword = rule.pattern.normalize('NFKC').toLowerCase().trim();
    if (rule.pattern_type === 'keyword' && keyword && subject.haystack.includes(keyword)) {
      return rule;
    }
  }
  return undefined;
}
