//! did-you-mean。clap 自带的只认静态子命令名，这里补目录里的资源别名、
//! 以及「动词写在前面」这种词序错误。

/// Damerau-Levenshtein 距离（含相邻换位）。
pub fn distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }

    // (a.len()+1) x (b.len()+1) 的表，滚动三行不够（换位要看前两行），直接开满。
    let width = b.len() + 1;
    let mut table = vec![0usize; (a.len() + 1) * width];
    for (i, cell) in table.iter_mut().enumerate().take(width) {
        *cell = i;
    }
    for i in 0..=a.len() {
        table[i * width] = i;
    }

    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut best = (table[(i - 1) * width + j] + 1)
                .min(table[i * width + j - 1] + 1)
                .min(table[(i - 1) * width + j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                best = best.min(table[(i - 2) * width + j - 2] + 1);
            }
            table[i * width + j] = best;
        }
    }
    table[a.len() * width + b.len()]
}

/// 允许的编辑距离随词长放宽：短词错一个字母就够远了。
fn threshold(input: &str) -> usize {
    match input.chars().count() {
        0..=3 => 1,
        4..=7 => 2,
        _ => 3,
    }
}

/// 从候选里挑最接近的几个，按距离升序。
pub fn closest<'a>(input: &str, candidates: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let limit = threshold(input);
    let lowered = input.to_lowercase();
    let mut scored: Vec<(usize, &str)> = candidates
        .into_iter()
        .filter_map(|candidate| {
            let d = distance(&lowered, &candidate.to_lowercase());
            (d <= limit).then_some((d, candidate))
        })
        .collect();
    scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));
    scored.dedup_by(|a, b| a.1 == b.1);
    scored.into_iter().take(3).map(|(_, name)| name).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_strings_have_zero_distance() {
        assert_eq!(distance("transactions", "transactions"), 0);
    }

    #[test]
    fn transposition_costs_one() {
        // 纯 Levenshtein 会算 2，Damerau 算 1。
        assert_eq!(distance("tarnsactions", "transactions"), 1);
    }

    #[test]
    fn empty_is_full_length() {
        assert_eq!(distance("", "abc"), 3);
        assert_eq!(distance("abc", ""), 3);
    }

    #[test]
    fn typos_find_the_right_resource() {
        let names = ["transactions", "accounts", "bills"];
        assert_eq!(closest("transaction", names), vec!["transactions"]);
        assert_eq!(closest("acounts", names), vec!["accounts"]);
        assert_eq!(closest("tarnsactions", names), vec!["transactions"]);
    }

    /// 差太远就别乱猜。
    #[test]
    fn unrelated_input_suggests_nothing() {
        assert!(closest("frobnicate", ["transactions", "accounts"]).is_empty());
    }

    #[test]
    fn case_is_ignored() {
        assert_eq!(closest("Accounts", ["accounts"]), vec!["accounts"]);
    }
}
