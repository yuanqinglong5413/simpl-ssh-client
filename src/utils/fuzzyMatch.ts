/**
 * 简单子序列模糊匹配 + scoring。
 * 返回匹配得分（越高越好），不匹配返回 -1。
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  if (q.length === 0) return 0;
  if (q.length > t.length) return -1;

  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let lastMatchIdx = -2;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 1;

      // 连续匹配加分
      if (ti === lastMatchIdx + 1) {
        consecutive++;
        score += consecutive * 2;
      } else {
        consecutive = 0;
      }

      // 首字母匹配加分
      if (ti === 0) score += 3;

      // 单词边界匹配加分（空格/斜杠/点后的字符）
      if (ti > 0 && /[\s/.\-_]/.test(t[ti - 1])) score += 2;

      lastMatchIdx = ti;
      qi++;
    }
  }

  // 未完全匹配
  if (qi < q.length) return -1;

  // 长度接近加分（越短越好）
  score += Math.max(0, 10 - (t.length - q.length));

  return score;
}

/**
 * 过滤并排序匹配项。
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  getLabel: (item: T) => string
): T[] {
  if (!query.trim()) return items;

  const scored = items
    .map((item) => ({
      item,
      score: fuzzyScore(query, getLabel(item)),
    }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((x) => x.item);
}
