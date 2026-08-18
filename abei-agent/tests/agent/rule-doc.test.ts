/**
 * 规则文档的解析与命中。
 *
 * 这些用例守的是「用户照着模板写的那一行，代码到底认不认」。
 * 格式变了这里就得跟着变——那正是要人先看一眼的地方。
 */

import { describe, expect, test } from 'vitest';

import { ruleSubject } from '../../src/agent/categorization.js';
import {
  applyRuleEdits,
  formatRuleLine,
  loadRulesDoc,
  loadRulesDocRecord,
  matchDocRule,
  parseMerchantRules,
  parseRuleLine,
  rulesSystemSection,
  saveRulesDoc,
  unknownCategoryRules,
} from '../../src/agent/rule-doc.js';
import { FireflyHttpClient } from '../../src/core/http-client.js';

const DOC = [
  '# 个人记账规则',
  '## 总原则',
  '- 拿不准就留空。',
  '## 商户固定分类',
  '- 商户名含「滴滴」 → 交通出行',
  '- 商户名含"星巴克" → 分类 餐饮/咖啡',
  '* 商户名含‘美团’ -> 餐饮',
  '- 「盒马」 ⇒ 日用百货',
  '- 这一行没有箭头，认不出来',
  '- 商户名含「幽灵店」 → 不存在的分类',
  '## 已失效规则',
  '- 商户名含「旧的」 → 旧分类',
].join('\n');

describe('规则文档解析', () => {
  test('只认「商户固定分类」这一块，别的块不进代码层', () => {
    const rules = parseMerchantRules(DOC);
    expect(rules.map((rule) => rule.pattern)).toEqual(['滴滴', '星巴克', '美团', '盒马', '幽灵店']);
    expect(rules.map((rule) => rule.categoryName)).toEqual([
      '交通出行',
      '餐饮/咖啡',
      '餐饮',
      '日用百货',
      '不存在的分类',
    ]);
    // 依据要能原样回指到文档里那一行。
    expect(rules[0].line).toBe('- 商户名含「滴滴」 → 交通出行');
  });

  test('认不出来的行只是跳过，不炸', () => {
    expect(parseRuleLine('- 这一行没有箭头')).toBeUndefined();
    expect(parseRuleLine('## 商户固定分类')).toBeUndefined();
    expect(parseRuleLine('')).toBeUndefined();
    expect(parseRuleLine('- 商户名含「」 → 餐饮')).toBeUndefined();
    expect(parseRuleLine('- 商户名含「滴滴」 → ')).toBeUndefined();
  });

  test('没有引号也认，而且不会把「含羞草」啃掉一半', () => {
    expect(parseRuleLine('- 含羞草 → 日用百货')).toEqual({
      pattern: '含羞草',
      categoryName: '日用百货',
      line: '- 含羞草 → 日用百货',
    });
  });

  test('同一个词写两遍只留第一条', () => {
    const rules = parseMerchantRules(
      ['## 商户固定分类', '- 商户名含「滴滴」 → 交通出行', '- 商户名含「 滴滴 」 → 打车'].join(
        '\n',
      ),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].categoryName).toBe('交通出行');
  });

  test('文档里没有这一块就是零条规则', () => {
    expect(parseMerchantRules('# 个人记账规则\n## 总原则\n- 随便写\n')).toEqual([]);
  });
});

describe('代码层命中', () => {
  const rules = parseMerchantRules(DOC);
  const allowed = new Set(['交通出行', '餐饮/咖啡', '餐饮', '日用百货']);

  test('商户名包含就算命中，回的是文档里那一行', () => {
    const hit = matchDocRule(rules, ruleSubject(['滴滴出行科技有限公司']), allowed);
    expect(hit?.categoryName).toBe('交通出行');
    expect(hit?.line).toContain('滴滴');
  });

  test('全角半角、大小写、空格都不影响命中', () => {
    const rules2 = parseMerchantRules('## 商户固定分类\n- 商户名含「Ｓｔａｒｂｕｃｋｓ」 → 餐饮\n');
    expect(
      matchDocRule(rules2, ruleSubject(['STARBUCKS 北京店']), new Set(['餐饮']))?.categoryName,
    ).toBe('餐饮');
  });

  test('规则指向的分类不在白名单里就当没命中', () => {
    expect(matchDocRule(rules, ruleSubject(['幽灵店 门店']), allowed)).toBeUndefined();
  });

  test('挑得出指向不存在分类的规则，好写进运行记录', () => {
    expect(unknownCategoryRules(rules, allowed).map((rule) => rule.pattern)).toEqual(['幽灵店']);
  });

  test('对不上任何词就交给模型', () => {
    expect(matchDocRule(rules, ruleSubject(['某不知名小店']), allowed)).toBeUndefined();
  });
});

describe('拉全文', () => {
  function client(response: Response): FireflyHttpClient {
    return new FireflyHttpClient({
      baseUrl: 'http://firefly.test',
      token: 'pat',
      fetchImpl: (async () => response) as unknown as typeof fetch,
    });
  }

  test('拉回来就顺手把规则解析好', async () => {
    const doc = await loadRulesDoc(
      client(
        new Response(JSON.stringify({ data: { content_md: DOC } }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
      'http://abei.test',
    );
    expect(doc?.contentMd).toBe(DOC);
    expect(doc?.rules).toHaveLength(5);
  });

  test('还没建文档（404）当作没有规则，不是故障', async () => {
    const doc = await loadRulesDoc(
      client(new Response('{"message":"nope"}', { status: 404 })),
      'http://abei.test',
    );
    expect(doc).toBeUndefined();
  });

  test('注进提示词的那一段带着全文和「优先遵循」的话', () => {
    const section = rulesSystemSection('# 个人记账规则\n');
    expect(section).toContain('优先');
    expect(section).toContain('# 个人记账规则');
  });
});

describe('增量改文档', () => {
  const TEMPLATE = [
    '# 个人记账规则',
    '',
    '## 总原则',
    '- 拿不准就留空，别猜。',
    '',
    '## 商户固定分类',
    '- 商户名含「滴滴」 → 交通出行',
    '',
    '## 已失效规则',
    '- （不再适用的规则搬到这里）',
    '',
  ].join('\n');

  test('新规则追加在「商户固定分类」末尾，别的块一个字不动', () => {
    const next = applyRuleEdits(TEMPLATE, {
      added: [{ pattern: '星巴克', categoryName: '餐饮' }],
      today: '2026-08-15',
    });
    expect(next).toContain('- 商户名含「滴滴」 → 交通出行\n- 商户名含「星巴克」 → 餐饮\n');
    expect(next).toContain('## 总原则\n- 拿不准就留空，别猜。');
    expect(parseMerchantRules(next).map((rule) => rule.pattern)).toEqual(['滴滴', '星巴克']);
  });

  test('失效的规则是搬走不是删掉，还注明日期和原因', () => {
    const next = applyRuleEdits(TEMPLATE, {
      retired: [{ line: '- 商户名含「滴滴」 → 交通出行', reason: '最近 3 次都改成了「差旅」' }],
      today: '2026-08-15',
    });
    expect(parseMerchantRules(next)).toEqual([]);
    expect(next).toContain(
      '- 商户名含「滴滴」 → 交通出行（2026-08-15 起不再适用：最近 3 次都改成了「差旅」）',
    );
  });

  test('文档里缺哪一块就在文末补一个', () => {
    const next = applyRuleEdits('# 个人记账规则\n', {
      added: [{ pattern: '星巴克', categoryName: '餐饮' }],
      today: '2026-08-15',
    });
    expect(next).toContain('## 商户固定分类\n- 商户名含「星巴克」 → 餐饮');
  });

  test('要搬的那一行已经被人删了，安静跳过', () => {
    const next = applyRuleEdits(TEMPLATE, {
      retired: [{ line: '- 商户名含「不存在」 → 某分类', reason: '不管' }],
      today: '2026-08-15',
    });
    expect(next).toBe(TEMPLATE);
  });

  test('没有任何改动就原样返回', () => {
    expect(applyRuleEdits(TEMPLATE, {})).toBe(TEMPLATE);
  });

  test('规则行的标准写法是解析得回来的', () => {
    const line = formatRuleLine('星巴克', '餐饮');
    expect(parseRuleLine(line)).toMatchObject({ pattern: '星巴克', categoryName: '餐饮' });
  });
});

describe('读写原文', () => {
  test('读原文带版本号，正文不截断', async () => {
    const record = await loadRulesDocRecord(
      new FireflyHttpClient({
        baseUrl: 'http://firefly.test',
        token: 'pat',
        fetchImpl: (async () =>
          new Response(JSON.stringify({ data: { content_md: DOC, version: 7 } }), {
            headers: { 'Content-Type': 'application/json' },
          })) as unknown as typeof fetch,
      }),
      'http://abei.test',
    );
    expect(record).toEqual({ contentMd: DOC, version: 7 });
  });

  test('写回走 confirm 闸门，带 expected_version 和 source', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await saveRulesDoc(
      new FireflyHttpClient({
        baseUrl: 'http://firefly.test',
        token: 'pat',
        fetchImpl: (async (url: string, init: RequestInit) => {
          calls.push({ url, init });
          return new Response('{"data":{}}', { headers: { 'Content-Type': 'application/json' } });
        }) as unknown as typeof fetch,
      }),
      'http://abei.test',
      { contentMd: '# 新的\n', expectedVersion: 7 },
    );
    expect(calls[0].url).toContain('/v1/profile-doc/personal-accounting-rules');
    expect(calls[0].url).toContain('confirm=true');
    expect(calls[0].init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      expected_version: 7,
      content_md: '# 新的\n',
      source: 'cli',
    });
  });
});
