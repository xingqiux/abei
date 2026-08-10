//! hledger 式查询语法。
//!
//! 位置参数就是筛选条件，写法贴近说话：
//!
//! ```text
//! abei tx list 餐饮 date:2026-07 amt:'>100' not:cat:房租
//! ```
//!
//! 前缀限定类型，`not:` 取反，空格并列（并列是「且」）。
//! `date:` 能翻译成 abei-api 的 start/end，直接下推；其余条件 API 还没有对应参数，
//! 在客户端过滤——这样查询语法不必等 API 补齐就能用，等 API 支持了再逐条下推。

use std::fmt;

use miette::{Diagnostic, NamedSource, SourceSpan};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cmp {
    Greater,
    GreaterEqual,
    Less,
    LessEqual,
    Equal,
}

impl Cmp {
    fn test(self, value: f64, bound: f64) -> bool {
        match self {
            Self::Greater => value > bound,
            Self::GreaterEqual => value >= bound,
            Self::Less => value < bound,
            Self::LessEqual => value <= bound,
            // 金额按分比较，避免浮点毛刺。
            Self::Equal => (value - bound).abs() < 0.005,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Term {
    /// 裸词：描述、账户、分类里任意一处包含即算命中。
    Text(String),
    Description(String),
    Account(String),
    Category(String),
    Currency(String),
    Amount(Cmp, f64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Filter {
    pub negated: bool,
    pub term: Term,
}

/// 解析结果。`start`/`end` 下推给 API，`filters` 留在客户端。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Query {
    pub start: Option<String>,
    pub end: Option<String>,
    pub filters: Vec<Filter>,
}

impl Query {
    pub fn is_empty(&self) -> bool {
        self.start.is_none() && self.end.is_none() && self.filters.is_empty()
    }
}

/// 查询语法错误。miette 负责画波浪线指到出错的那几个字符。
///
/// Diagnostic 手写而不是 derive：derive 出来的 impl 会触发 unused_assignments，
/// 而那个 lint 没法只对宏产物关掉——手写这十来行反倒更省事，也看得见发生了什么。
#[derive(Debug, thiserror::Error)]
#[error("查询条件写得不对")]
pub struct QueryError {
    src: NamedSource<String>,
    span: SourceSpan,
    message: String,
    help: Option<String>,
}

impl Diagnostic for QueryError {
    fn code<'a>(&'a self) -> Option<Box<dyn fmt::Display + 'a>> {
        Some(Box::new("abei::query"))
    }

    fn help<'a>(&'a self) -> Option<Box<dyn fmt::Display + 'a>> {
        self.help
            .as_ref()
            .map(|text| Box::new(text) as Box<dyn fmt::Display>)
    }

    fn source_code(&self) -> Option<&dyn miette::SourceCode> {
        Some(&self.src)
    }

    fn labels(&self) -> Option<Box<dyn Iterator<Item = miette::LabeledSpan> + '_>> {
        Some(Box::new(std::iter::once(
            miette::LabeledSpan::new_with_span(Some(self.message.clone()), self.span),
        )))
    }
}

struct Cursor {
    text: String,
    offset: usize,
}

fn fail(cursor: &Cursor, span: SourceSpan, message: &str, help: Option<&str>) -> Box<QueryError> {
    Box::new(QueryError {
        src: NamedSource::new("查询", cursor.text.clone()).with_language("text"),
        span,
        message: message.to_owned(),
        help: help.map(str::to_owned),
    })
}

/// 解析一串位置参数。
pub fn parse(terms: &[String]) -> Result<Query, Box<QueryError>> {
    let text = terms.join(" ");
    let mut cursor = Cursor {
        text: text.clone(),
        offset: 0,
    };
    let mut query = Query::default();

    for raw in terms {
        let start = cursor.offset;
        cursor.offset += raw.chars().count() + 1;
        if raw.is_empty() {
            continue;
        }
        parse_term(&cursor, raw, start, &mut query)?;
    }

    Ok(query)
}

fn parse_term(
    cursor: &Cursor,
    raw: &str,
    start: usize,
    query: &mut Query,
) -> Result<(), Box<QueryError>> {
    let width = raw.chars().count();
    let (negated, body, body_start) = match raw.strip_prefix("not:") {
        Some(rest) => {
            if rest.is_empty() {
                return Err(fail(
                    cursor,
                    (start, width).into(),
                    "not: 后面没有条件",
                    Some("写成 not:cat:房租 这样，not: 取反它后面那一条。"),
                ));
            }
            (true, rest, start + 4)
        }
        None => (false, raw, start),
    };
    let body_width = body.chars().count();

    let Some((prefix, value)) = split_prefix(body) else {
        query.filters.push(Filter {
            negated,
            term: Term::Text(body.to_owned()),
        });
        return Ok(());
    };

    if value.is_empty() {
        return Err(fail(
            cursor,
            (body_start, body_width).into(),
            "冒号后面是空的",
            Some(&format!("写成 {prefix}:内容。")),
        ));
    }

    let term = match prefix {
        "date" => {
            let (from, to) = parse_date(cursor, value, body_start + 5, value.chars().count())?;
            if negated {
                return Err(fail(
                    cursor,
                    (start, width).into(),
                    "日期不支持取反",
                    Some("换个写法：直接写你要的区间，比如 date:2026-07。"),
                ));
            }
            query.start = Some(from);
            query.end = Some(to);
            return Ok(());
        }
        "desc" => Term::Description(value.to_owned()),
        "acct" | "account" => Term::Account(value.to_owned()),
        "cat" | "category" => Term::Category(value.to_owned()),
        "cur" | "currency" => Term::Currency(value.to_uppercase()),
        "amt" | "amount" => {
            let (cmp, bound) = parse_amount(
                cursor,
                value,
                body_start + prefix.chars().count() + 1,
                value.chars().count(),
            )?;
            Term::Amount(cmp, bound)
        }
        other => {
            let known = ["date", "desc", "acct", "cat", "cur", "amt", "not"];
            // 距离相同的候选一并列出，别替用户拍板（dat 既像 date 也像 cat）。
            let guesses = crate::suggest::closest(other, known);
            let hint = if guesses.is_empty() {
                format!("认得的前缀：{}。", known.join("、"))
            } else {
                format!(
                    "是不是想写 {}？",
                    guesses
                        .iter()
                        .map(|g| format!("{g}:"))
                        .collect::<Vec<_>>()
                        .join(" 或 ")
                )
            };
            return Err(fail(
                cursor,
                (body_start, other.chars().count()).into(),
                "不认得这个前缀",
                Some(&hint),
            ));
        }
    };

    query.filters.push(Filter { negated, term });
    Ok(())
}

/// 只切第一个冒号，值里还能再有冒号（比如 desc:a:b）。
fn split_prefix(body: &str) -> Option<(&str, &str)> {
    let index = body.find(':')?;
    let prefix = &body[..index];
    // 前缀必须是纯字母，否则当裸词（比如中文里出现的冒号）。
    if prefix.is_empty() || !prefix.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    Some((prefix, &body[index + 1..]))
}

fn parse_amount(
    cursor: &Cursor,
    value: &str,
    span_start: usize,
    span_width: usize,
) -> Result<(Cmp, f64), Box<QueryError>> {
    let (cmp, rest) = if let Some(rest) = value.strip_prefix(">=") {
        (Cmp::GreaterEqual, rest)
    } else if let Some(rest) = value.strip_prefix("<=") {
        (Cmp::LessEqual, rest)
    } else if let Some(rest) = value.strip_prefix('>') {
        (Cmp::Greater, rest)
    } else if let Some(rest) = value.strip_prefix('<') {
        (Cmp::Less, rest)
    } else {
        (Cmp::Equal, value)
    };

    rest.trim().parse::<f64>().map(|bound| (cmp, bound)).map_err(|_| {
        fail(
            cursor,
            (span_start, span_width).into(),
            "金额不是数字",
            Some("写成 amt:'>100'、amt:'<=50' 或 amt:45.6；比较号要用引号包住，不然会被 shell 当重定向。"),
        )
    })
}

/// `2026`、`2026-07`、`2026-07-15`、`2026-07-01..2026-07-31` 都认。
fn parse_date(
    cursor: &Cursor,
    value: &str,
    span_start: usize,
    span_width: usize,
) -> Result<(String, String), Box<QueryError>> {
    let bad = |message: &str| {
        fail(
            cursor,
            (span_start, span_width).into(),
            message,
            Some(
                "认得的写法：date:2026、date:2026-07、date:2026-07-15、date:2026-07-01..2026-07-31。",
            ),
        )
    };

    if let Some((from, to)) = value.split_once("..") {
        let start = if from.is_empty() {
            "1970-01-01".to_owned()
        } else {
            expand(from).ok_or_else(|| bad("区间起点写得不对"))?.0
        };
        let end = if to.is_empty() {
            "2999-12-31".to_owned()
        } else {
            expand(to).ok_or_else(|| bad("区间终点写得不对"))?.1
        };
        return Ok((start, end));
    }

    expand(value).ok_or_else(|| bad("日期写得不对"))
}

/// 把粗粒度日期摊成闭区间：2026-07 -> (2026-07-01, 2026-07-31)。
fn expand(value: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = value.split('-').collect();
    let year: u32 = parts.first()?.parse().ok()?;
    if !(1970..=2999).contains(&year) || parts.first()?.len() != 4 {
        return None;
    }

    match parts.len() {
        1 => Some((format!("{year}-01-01"), format!("{year}-12-31"))),
        2 => {
            let month: u32 = parts[1].parse().ok()?;
            if !(1..=12).contains(&month) {
                return None;
            }
            Some((
                format!("{year}-{month:02}-01"),
                format!("{year}-{month:02}-{:02}", days_in_month(year, month)),
            ))
        }
        3 => {
            let month: u32 = parts[1].parse().ok()?;
            let day: u32 = parts[2].parse().ok()?;
            if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
                return None;
            }
            let stamp = format!("{year}-{month:02}-{day:02}");
            Some((stamp.clone(), stamp))
        }
        _ => None,
    }
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        _ => 0,
    }
}

/// 一行交易在客户端过滤时看的字段。
#[derive(Debug, Default)]
pub struct Candidate<'a> {
    pub description: Option<&'a str>,
    pub account: Option<&'a str>,
    pub category: Option<&'a str>,
    pub currency: Option<&'a str>,
    pub amount: Option<f64>,
}

impl Term {
    fn matches(&self, row: &Candidate<'_>) -> bool {
        let contains = |field: Option<&str>, needle: &str| {
            field.is_some_and(|value| value.to_lowercase().contains(&needle.to_lowercase()))
        };
        match self {
            Self::Text(needle) => {
                contains(row.description, needle)
                    || contains(row.account, needle)
                    || contains(row.category, needle)
            }
            Self::Description(needle) => contains(row.description, needle),
            Self::Account(needle) => contains(row.account, needle),
            Self::Category(needle) => contains(row.category, needle),
            Self::Currency(needle) => row
                .currency
                .is_some_and(|value| value.eq_ignore_ascii_case(needle)),
            Self::Amount(cmp, bound) => row
                .amount
                .is_some_and(|value| cmp.test(value.abs(), *bound)),
        }
    }
}

impl Query {
    /// 并列条件是「且」，`not:` 取反。
    pub fn accepts(&self, row: &Candidate<'_>) -> bool {
        self.filters
            .iter()
            .all(|filter| filter.term.matches(row) != filter.negated)
    }
}

impl fmt::Display for Term {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Text(v) => write!(f, "{v}"),
            Self::Description(v) => write!(f, "desc:{v}"),
            Self::Account(v) => write!(f, "acct:{v}"),
            Self::Category(v) => write!(f, "cat:{v}"),
            Self::Currency(v) => write!(f, "cur:{v}"),
            Self::Amount(cmp, v) => {
                let sign = match cmp {
                    Cmp::Greater => ">",
                    Cmp::GreaterEqual => ">=",
                    Cmp::Less => "<",
                    Cmp::LessEqual => "<=",
                    Cmp::Equal => "",
                };
                write!(f, "amt:{sign}{v}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(terms: &[&str]) -> Query {
        parse(&terms.iter().map(|t| (*t).to_owned()).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn bare_word_becomes_text_filter() {
        let query = q(&["餐饮"]);
        assert_eq!(query.filters.len(), 1);
        assert_eq!(query.filters[0].term, Term::Text("餐饮".into()));
        assert!(!query.filters[0].negated);
    }

    #[test]
    fn month_expands_to_a_closed_range() {
        let query = q(&["date:2026-07"]);
        assert_eq!(query.start.as_deref(), Some("2026-07-01"));
        assert_eq!(query.end.as_deref(), Some("2026-07-31"));
    }

    #[test]
    fn february_knows_about_leap_years() {
        assert_eq!(q(&["date:2024-02"]).end.as_deref(), Some("2024-02-29"));
        assert_eq!(q(&["date:2026-02"]).end.as_deref(), Some("2026-02-28"));
        // 世纪年要能被 400 整除才是闰年。
        assert_eq!(q(&["date:2100-02"]).end.as_deref(), Some("2100-02-28"));
        assert_eq!(q(&["date:2000-02"]).end.as_deref(), Some("2000-02-29"));
    }

    #[test]
    fn year_and_single_day_both_work() {
        let year = q(&["date:2026"]);
        assert_eq!(year.start.as_deref(), Some("2026-01-01"));
        assert_eq!(year.end.as_deref(), Some("2026-12-31"));

        let day = q(&["date:2026-07-15"]);
        assert_eq!(day.start.as_deref(), Some("2026-07-15"));
        assert_eq!(day.end.as_deref(), Some("2026-07-15"));
    }

    #[test]
    fn ranges_and_open_ends_work() {
        let range = q(&["date:2026-07-01..2026-08-15"]);
        assert_eq!(range.start.as_deref(), Some("2026-07-01"));
        assert_eq!(range.end.as_deref(), Some("2026-08-15"));

        let open = q(&["date:2026-07.."]);
        assert_eq!(open.start.as_deref(), Some("2026-07-01"));
        assert_eq!(open.end.as_deref(), Some("2999-12-31"));
    }

    #[test]
    fn amount_comparisons_parse() {
        assert_eq!(
            q(&["amt:>100"]).filters[0].term,
            Term::Amount(Cmp::Greater, 100.0)
        );
        assert_eq!(
            q(&["amt:<=50.5"]).filters[0].term,
            Term::Amount(Cmp::LessEqual, 50.5)
        );
        assert_eq!(
            q(&["amt:45"]).filters[0].term,
            Term::Amount(Cmp::Equal, 45.0)
        );
    }

    #[test]
    fn not_prefix_negates() {
        let query = q(&["not:cat:房租"]);
        assert!(query.filters[0].negated);
        assert_eq!(query.filters[0].term, Term::Category("房租".into()));
    }

    #[test]
    fn currency_is_normalised_to_upper_case() {
        assert_eq!(
            q(&["cur:cny"]).filters[0].term,
            Term::Currency("CNY".into())
        );
    }

    #[test]
    fn values_may_contain_colons() {
        assert_eq!(
            q(&["desc:a:b"]).filters[0].term,
            Term::Description("a:b".into())
        );
    }

    /// 中文冒号或非字母前缀不算限定词，整串当裸词。
    #[test]
    fn non_alphabetic_prefixes_stay_text() {
        assert_eq!(
            q(&["午饭:好吃"]).filters[0].term,
            Term::Text("午饭:好吃".into())
        );
    }

    #[test]
    fn unknown_prefix_suggests_the_right_one() {
        let error = *parse(&["dat:2026-07".to_owned()]).unwrap_err();
        assert!(error.message.contains("不认得这个前缀"));
        assert!(error.help.as_deref().unwrap().contains("date"));
    }

    #[test]
    fn bad_amount_and_date_are_rejected() {
        assert!(parse(&["amt:>abc".to_owned()]).is_err());
        assert!(parse(&["date:2026-13".to_owned()]).is_err());
        assert!(parse(&["date:2026-02-30".to_owned()]).is_err());
        assert!(parse(&["cat:".to_owned()]).is_err());
        assert!(parse(&["not:".to_owned()]).is_err());
    }

    /// 出错时 span 要指到出错的那一段，不是整行。
    #[test]
    fn error_span_points_at_the_bad_token() {
        let error = *parse(&["餐饮".to_owned(), "dat:2026".to_owned()]).unwrap_err();
        // "餐饮 " 三个字符之后才是 dat。
        assert_eq!(error.span.offset(), 3);
        assert_eq!(error.span.len(), 3);
    }

    #[test]
    fn filters_are_anded_and_negation_flips() {
        let query = q(&["餐饮", "not:cat:房租", "amt:>10"]);
        let hit = Candidate {
            description: Some("餐饮外卖"),
            category: Some("吃饭"),
            amount: Some(45.0),
            ..Default::default()
        };
        assert!(query.accepts(&hit));

        let rent = Candidate {
            description: Some("餐饮外卖"),
            category: Some("房租"),
            amount: Some(45.0),
            ..Default::default()
        };
        assert!(!query.accepts(&rent));

        let cheap = Candidate {
            description: Some("餐饮外卖"),
            category: Some("吃饭"),
            amount: Some(5.0),
            ..Default::default()
        };
        assert!(!query.accepts(&cheap));
    }

    /// 支出金额在 Firefly 里是正数，但为防负号写法，比较取绝对值。
    #[test]
    fn amount_comparison_ignores_sign() {
        let query = q(&["amt:>100"]);
        let row = Candidate {
            amount: Some(-450.0),
            ..Default::default()
        };
        assert!(query.accepts(&row));
    }

    #[test]
    fn text_search_covers_account_and_category() {
        let query = q(&["招行"]);
        let row = Candidate {
            description: Some("午饭"),
            account: Some("招行卡"),
            ..Default::default()
        };
        assert!(query.accepts(&row));
    }

    #[test]
    fn empty_query_accepts_everything() {
        let query = Query::default();
        assert!(query.is_empty());
        assert!(query.accepts(&Candidate::default()));
    }
}
