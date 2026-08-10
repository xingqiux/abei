//! 唯一需要「现在几点」的地方：裸 `abei` 默认看本月。
//!
//! 按本机时区算——记账的「本月」是人所在地的本月，不是 UTC 的。

/// 本机时区的当前月份，`YYYY-MM`。
pub fn current_month() -> String {
    let now = jiff::Zoned::now();
    format!("{:04}-{:02}", now.year(), now.month())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_month_is_a_parseable_month() {
        let month = current_month();
        let parsed = crate::query::parse(&[format!("date:{month}")]).unwrap();
        assert_eq!(parsed.start.unwrap(), format!("{month}-01"));
        assert!(parsed.end.unwrap().starts_with(&month));
    }
}
