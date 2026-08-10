/**
 * 简单子序列模糊匹配（大小写不敏感）：query 为空视为全部匹配；
 * 否则要求 query 的每个字符按原有顺序依次出现在 target 中（不要求连续）。
 * 命令面板的「跳转」「动作」区按此匹配页面名称/关键词（规范 §5）。
 */
export function fuzzyMatch(query: string, target: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const t = target.toLowerCase()
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
  }
  return qi === q.length
}
