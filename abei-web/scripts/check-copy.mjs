#!/usr/bin/env node
/**
 * 界面文案禁用词检查。
 *
 * 为什么要有这条命令：文案规范（05-文案规范）里的「平实≠口语」靠 code review
 * 守不住——「卡住」「搞定」「拿主意」这类词一次进来一两个，评审时看着都不算大事，
 * 攒到一屏上就成了另一个产品的口气。规范里点名的词交给机器看。
 *
 * 只看会出现在屏幕上的文本：字符串字面量、模板串、JSX 里的中文正文。
 * 注释里怎么写不管——注释是写给维护者的，把「这封邮件卡住了」逼成
 * 「这封邮件处于待解锁状态」只会让注释更难读。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

/**
 * 禁用词表。加词就往这里加，一行一个，右边写清为什么不许用。
 * 只列口语词和自造词；术语替换（可直接入账 → 待入账）不在这里管——
 * 那是一次性的改名，长期靠术语表和评审，不该让每次提交都背一张替换表。
 */
const BANNED = [
  ['卡住', '状态说不清。按术语表写「待解锁」或「解析失败」'],
  ['划掉', '口语。用「忽略」'],
  ['拿主意', '口语。用「确认」'],
  ['搞定', '口语。写清楚做完之后是什么状态'],
  ['非法', '指责用户。说清楚哪一项不符合要求'],
  ['无效操作', '没说出了什么事，也没说现在能怎么办'],
  ['要你', '把用户当被使唤的一方。改成陈述这一步要做什么'],
]

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', 'src')

/** 生成代码不归我们写，跳过 */
const SKIP_DIRS = new Set(['generated', 'node_modules'])

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...walk(full))
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      // 测试文件里的中文是用例标题，不上屏
      out.push(full)
    }
  }
  return out
}

/**
 * 把注释挖空，行号保持不变（换行留着，其余字符换成空格）。
 * 粗糙但够用：字符串里出现 `//` 的情况在中文文案里基本不存在，
 * 而漏杀一条注释顶多是多报一次，比漏报强。
 */
function stripComments(source) {
  const blanked = (text) => text.replace(/[^\n]/g, ' ')
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blanked)
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead + blanked(match.slice(lead.length)))
}

const hits = []
for (const file of walk(root)) {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
  lines.forEach((line, index) => {
    // 只看含中文的行：英文标识符里不会藏中文禁用词
    if (!/[一-龥]/.test(line)) return
    for (const [word, why] of BANNED) {
      if (line.includes(word)) {
        hits.push({ file: relative(join(here, '..'), file), line: index + 1, word, why, text: line.trim() })
      }
    }
  })
}

if (hits.length === 0) {
  console.log(`文案检查通过：${BANNED.length} 个禁用词，0 处命中。`)
  process.exit(0)
}

console.error(`文案检查不通过：${hits.length} 处命中禁用词。`)
for (const hit of hits) {
  console.error(`\n${hit.file}:${hit.line}  「${hit.word}」——${hit.why}`)
  console.error(`  ${hit.text}`)
}
process.exit(1)
