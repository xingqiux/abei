/**
 * 《个人记账规则》文档：读全文、解析可判定的那一块、代码层直接命中。
 *
 * 文档存在 abei-server 的 `abei_ai.profile_docs` 里，agent 一律经 abei-api
 * （和 bill-task-service 同一条路，PAT 只当 Authorization 头带过去）去读，
 * 不直连 abei-server，也不碰数据库。
 *
 * 两种用法，界线要分清：
 * - 全文：整段塞进 system 提示，告诉模型「优先遵循这份规则」。写得再随意也没关系。
 * - 「商户固定分类」块：按固定行格式解析成代码规则，跑批时先撞一遍，命中的不进模型。
 *   解析不出来的行只是没被代码用上，全文那份仍然会喂给模型，所以不必报错。
 */

import { FireflyHttpError } from '../core/errors.js';
import type { FireflyHttpClient } from '../core/http-client.js';
import type { RuleSubject } from './categorization.js';
import { record, trimmed } from './shared.js';

/** 规范 slug。整个产品只认这一份规则文档。 */
export const RULES_DOC_SLUG = 'personal-accounting-rules';

/** 可判定规则住在这一块下面；其余块只喂给模型。 */
export const MERCHANT_RULES_SECTION = '商户固定分类';

/**
 * 被用户行为反复推翻的规则搬到这一块。解析只看「商户固定分类」，
 * 所以搬过来就等于停用，原文还留着，回头查得到。
 */
export const RETIRED_RULES_SECTION = '已失效规则';

/** 全文注进提示词的上限，防止有人写了一本书把上下文顶爆。 */
const MAX_DOC_CHARS = 20_000;

/** 一条从文档里解析出来的商户规则。 */
export interface DocRule {
  /** 「商户名含」后面那个词，原样保留（匹配时才归一化）。 */
  pattern: string;
  categoryName: string;
  /** 原文整行，出现在建议依据里：`rule:<原文行>`。 */
  line: string;
}

export interface RulesDoc {
  contentMd: string;
  rules: DocRule[];
}

/**
 * 拉规则文档全文。没建文档（404）返回 undefined，调用方跳过注入即可——
 * 「还没写规则」是常态，不是故障。
 */
export async function loadRulesDoc(
  client: FireflyHttpClient,
  abeiUrl: string,
): Promise<RulesDoc | undefined> {
  let body: unknown;
  try {
    body = await client
      .withBaseUrl(abeiUrl)
      .request('GET', `/v1/profile-doc/${encodeURIComponent(RULES_DOC_SLUG)}`);
  } catch (error) {
    if (error instanceof FireflyHttpError && error.status === 404) return undefined;
    throw error;
  }
  const contentMd = trimmed(record(record(body)?.data)?.content_md, MAX_DOC_CHARS);
  if (!contentMd) return undefined;
  return { contentMd, rules: parseMerchantRules(contentMd) };
}

/** 规则文档的原样一份：正文不截断，带版本号，用来做增量写回。 */
export interface RulesDocRecord {
  contentMd: string;
  version: number;
}

/**
 * 读文档原文和版本号。和 loadRulesDoc 的区别：这里不截断正文——
 * 截断过的正文写回去等于把用户后半份规则删了。没建文档返回 undefined。
 */
export async function loadRulesDocRecord(
  client: FireflyHttpClient,
  abeiUrl: string,
): Promise<RulesDocRecord | undefined> {
  let body: unknown;
  try {
    body = await client
      .withBaseUrl(abeiUrl)
      .request('GET', `/v1/profile-doc/${encodeURIComponent(RULES_DOC_SLUG)}`);
  } catch (error) {
    if (error instanceof FireflyHttpError && error.status === 404) return undefined;
    throw error;
  }
  const data = record(record(body)?.data);
  const version = Number(data?.version);
  if (typeof data?.content_md !== 'string' || !Number.isInteger(version) || version < 1) {
    return undefined;
  }
  return { contentMd: data.content_md, version };
}

/**
 * 写回一版。`expected_version` 对不上服务端返回 409，调用方当作「这一轮先算了」，
 * 下一轮读到新版本再来——学习是可以等的，覆盖用户刚写的东西不可以。
 */
export async function saveRulesDoc(
  client: FireflyHttpClient,
  abeiUrl: string,
  args: { contentMd: string; expectedVersion: number },
): Promise<void> {
  await client
    .withBaseUrl(abeiUrl)
    .request('PATCH', `/v1/profile-doc/${encodeURIComponent(RULES_DOC_SLUG)}`, {
      query: { confirm: true },
      json: {
        expected_version: args.expectedVersion,
        content_md: args.contentMd,
        source: 'cli',
      },
    });
}

/**
 * 取出 `## 商户固定分类` 那一块，逐行解析。
 *
 * 认的行长这样：`- 商户名含「滴滴」 → 交通出行`
 * 容忍的写法：列表符号可有可无；「」『』""''「中英引号」都行；
 * 箭头 → -> => ⇒ ➜ 都认；右边可以带「分类」「归为」「记为」这类前缀词。
 * 认不出来的行直接跳过——它仍然会随全文喂给模型。
 */
export function parseMerchantRules(contentMd: string): DocRule[] {
  const rules: DocRule[] = [];
  const seen = new Set<string>();
  for (const raw of sectionLines(contentMd, MERCHANT_RULES_SECTION)) {
    const rule = parseRuleLine(raw);
    if (!rule) continue;
    const key = normalizePattern(rule.pattern);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rules.push(rule);
  }
  return rules;
}

/** 单行解析，导出是为了能单独测。 */
export function parseRuleLine(raw: string): DocRule | undefined {
  const line = raw.trim();
  if (!line || line.startsWith('#') || line.startsWith('>')) return undefined;
  const body = line.replace(LIST_BULLET, '');
  const arrow = ARROW.exec(body);
  if (!arrow) return undefined;

  const left = body.slice(0, arrow.index);
  // 引号里的内容最可信：有引号就只认引号里那一段，没有才去啃前缀词。
  const quoted = QUOTED.exec(left);
  const pattern = quoted ? quoted[1].trim() : unquote(left.replace(SUBJECT_PREFIX, ''));
  const categoryName = unquote(
    body.slice(arrow.index + arrow[0].length).replace(TARGET_PREFIX, ''),
  );
  if (!pattern || !categoryName) return undefined;
  return { pattern, categoryName, line };
}

/**
 * 代码层命中：把规则里的词按归一化后的形式，在这一行的全文和商户名里找包含。
 * `allowed` 是当前这批流水能用的分类白名单，规则和模型走同一道校验——
 * 规则指向的分类不在白名单里就当没命中，绝不把不存在的分类名写回去。
 */
export function matchDocRule(
  rules: DocRule[],
  subject: RuleSubject,
  allowed: Set<string>,
): DocRule | undefined {
  for (const rule of rules) {
    if (!allowed.has(rule.categoryName)) continue;
    const needle = normalizePattern(rule.pattern);
    if (!needle) continue;
    if (subject.haystack.includes(needle)) return rule;
    if (subject.merchants.some((merchant) => merchant.includes(needle))) return rule;
  }
  return undefined;
}

/** 指向账本里没有的分类的规则。跑批时挑出来记进运行记录，让人知道这条白写了。 */
export function unknownCategoryRules(rules: DocRule[], known: Set<string>): DocRule[] {
  return rules.filter((rule) => !known.has(rule.categoryName));
}

/** 要往「商户固定分类」里加的一条。 */
export interface RuleAddition {
  pattern: string;
  categoryName: string;
}

/** 要搬进「已失效规则」的一条。line 是文档里的原文行。 */
export interface RuleRetirement {
  line: string;
  /** 一句话说清为什么停用，写进括号里。 */
  reason: string;
}

/** 规则行的标准写法。学出来的规则一律照这个格式写，人改过的行不动。 */
export function formatRuleLine(pattern: string, categoryName: string): string {
  return `- 商户名含「${pattern}」 → ${categoryName}`;
}

/**
 * 增量改文档：只动相关的那几行，其余一个字节都不碰。
 *
 * 失效的规则从「商户固定分类」里搬到「已失效规则」，不是删除；新学的追加在
 * 「商户固定分类」末尾。缺哪一块就在文末补一个。没有任何改动时原样返回。
 */
export function applyRuleEdits(
  contentMd: string,
  edits: { added?: RuleAddition[]; retired?: RuleRetirement[]; today?: string },
): string {
  const added = edits.added ?? [];
  const retired = edits.retired ?? [];
  if (added.length === 0 && retired.length === 0) return contentMd;
  const today = edits.today ?? new Date().toISOString().slice(0, 10);

  let lines = contentMd.split(/\r?\n/);
  const retiredLines: string[] = [];
  for (const item of retired) {
    const index = findRuleLine(lines, item.line);
    if (index < 0) continue;
    lines.splice(index, 1);
    retiredLines.push(`- ${item.line.trim().replace(LIST_BULLET, '')}（${today} 起不再适用：${item.reason}）`);
  }

  if (added.length) {
    lines = appendToSection(
      lines,
      MERCHANT_RULES_SECTION,
      added.map((rule) => formatRuleLine(rule.pattern, rule.categoryName)),
    );
  }
  if (retiredLines.length) {
    lines = appendToSection(lines, RETIRED_RULES_SECTION, retiredLines);
  }
  return lines.join('\n');
}

/** 在「商户固定分类」块里按原文找那一行。找不到就当它已经被人删了，不报错。 */
function findRuleLine(lines: string[], line: string): number {
  const range = sectionRange(lines, MERCHANT_RULES_SECTION);
  if (!range) return -1;
  const wanted = line.trim();
  for (let index = range.start; index < range.end; index += 1) {
    if (lines[index].trim() === wanted) return index;
  }
  return -1;
}

/** 追加到某一块的末尾（跳过块尾空行）。块不存在就在文末补一个。 */
function appendToSection(lines: string[], heading: string, entries: string[]): string[] {
  const range = sectionRange(lines, heading);
  if (!range) {
    const tail = [...lines];
    while (tail.length && tail[tail.length - 1].trim() === '') tail.pop();
    return [...tail, '', `## ${heading}`, ...entries, ''];
  }
  let insertAt = range.end;
  while (insertAt > range.start && lines[insertAt - 1].trim() === '') insertAt -= 1;
  return [...lines.slice(0, insertAt), ...entries, ...lines.slice(insertAt)];
}

/** 某个标题块的正文行区间 `[start, end)`，标题行本身不算在内。 */
function sectionRange(lines: string[], heading: string): { start: number; end: number } | undefined {
  const headingIndex = lines.findIndex((line) => headingText(line) === heading);
  if (headingIndex < 0) return undefined;
  let end = headingIndex + 1;
  while (end < lines.length && headingText(lines[end]) === undefined) end += 1;
  return { start: headingIndex + 1, end };
}

/** 注进 system 提示的那一段。调用方直接拼在自己的系统提示后面。 */
export function rulesSystemSection(contentMd: string): string {
  return [
    '下面是用户自己写的《个人记账规则》。它优先于你的判断：',
    '规则说了怎么归类的，就照规则来；规则没说的，才按常识判断。',
    '规则里出现的分类名如果不在给定清单里，忽略那一条。',
    '',
    contentMd,
  ].join('\n');
}

const LIST_BULLET = /^[-*+•·]\s*/u;
const ARROW = /\s*(?:→|➜|⇒|=>|->|—>)\s*/u;
const QUOTED = /[「『“"'‘]([^」』”"'’]{1,120})[」』”"'’]/u;
/** 只在没有引号时才啃前缀，而且名词部分必须出现，免得把「含羞草」啃成「羞草」。 */
const SUBJECT_PREFIX = /^(?:商户名?|商家名?|名称|对方|交易对方)\s*(?:含有|包含|含|是|为)?\s*/u;
const TARGET_PREFIX = /^(?:分类|类别|归为|归到|记为|记到|算作)(?:\s*[:：]\s*|\s+)/u;
const QUOTES = /^[「『“”"'‘’]+|[」』“”"'‘’]+$/gu;
const TRAILING_PUNCTUATION = /[。.;；,，]+$/u;

function unquote(value: string): string {
  return value.trim().replace(TRAILING_PUNCTUATION, '').replace(QUOTES, '').trim();
}

/** 匹配两头共用的清洗：全角折半角、转小写、去空白。学习那边也用同一把尺子。 */
export function normalizePattern(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

/** 取 `## <标题>` 到下一个同级或更高级标题之间的行。 */
function sectionLines(contentMd: string, heading: string): string[] {
  const lines = contentMd.split(/\r?\n/);
  const start = lines.findIndex((line) => headingText(line) === heading);
  if (start < 0) return [];
  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (headingText(line) !== undefined) break;
    collected.push(line);
  }
  return collected;
}

function headingText(line: string): string | undefined {
  const match = /^#{1,6}\s+(.*)$/u.exec(line.trim());
  return match ? match[1].trim() : undefined;
}
