//! 透传逃生舱。还没建模的 Firefly 接口从这里走，客户端不必绕过 abei-api 另开一条连接。
//! 建模一个域之后，对应路径就该从透传改成正式资源接口。
//!
//! 这条路由曾经是「全方法全路径」的：带着用户的 Firefly 令牌，任何路径都放行，等于
//! 把 Firefly 的整个权限面摊给前端，能力目录在这条路上完全失效。现在只放行
//! [`ALLOWED`] 里 abei-web 确实在用的那些，其余一律 404。
//!
//! [`ALLOWED`] 是一份待办清单，不是配置：每建模一个域，就从这里删掉对应几行，
//! 表空了这个模块就该整个删掉。加行之前先想想能不能在 abei-api 上开正式端点。

use axum::body::to_bytes;
use axum::extract::{Request, State};
use axum::http::Method;
use axum::response::Response;

use crate::auth::AuthToken;
use crate::problem::Problem;
use crate::state::AppState;

const PREFIX: &str = "/v1/firefly";
const MAX_BODY: usize = 16 * 1024 * 1024;

/// 放行清单：方法 + 路径模板。`{}` 匹配一段非空路径（Firefly 的资源 id）。
///
/// 盘点自 abei-web 里所有 `proxy*`/`viaFirefly` 调用点（2026-08-13）。注释里写的是
/// 这条路对应前端哪个功能，方便逐条迁移。
const ALLOWED: &[(Method, &str)] = &[
    // 账户：账户页、账户详情、账户下的交易列表
    (Method::GET, "/api/v1/accounts"),
    (Method::POST, "/api/v1/accounts"),
    (Method::GET, "/api/v1/accounts/{}"),
    (Method::PUT, "/api/v1/accounts/{}"),
    (Method::DELETE, "/api/v1/accounts/{}"),
    (Method::GET, "/api/v1/accounts/{}/transactions"),
    // 交易：新建、改、删，以及交易的附件列表
    (Method::POST, "/api/v1/transactions"),
    (Method::PUT, "/api/v1/transactions/{}"),
    (Method::DELETE, "/api/v1/transactions/{}"),
    (Method::GET, "/api/v1/transactions/{}/attachments"),
    // 附件：交易详情里的上传、下载、改名与删除
    (Method::POST, "/api/v1/attachments"),
    (Method::PUT, "/api/v1/attachments/{}"),
    (Method::DELETE, "/api/v1/attachments/{}"),
    (Method::GET, "/api/v1/attachments/{}/download"),
    (Method::POST, "/api/v1/attachments/{}/upload"),
    // 预算：预算页与预算额度
    (Method::GET, "/api/v1/budgets"),
    (Method::POST, "/api/v1/budgets"),
    (Method::PUT, "/api/v1/budgets/{}"),
    (Method::DELETE, "/api/v1/budgets/{}"),
    (Method::POST, "/api/v1/budgets/with-limit"),
    (Method::GET, "/api/v1/budgets/{}/limits"),
    (Method::POST, "/api/v1/budgets/{}/limits"),
    (Method::PUT, "/api/v1/budgets/{}/limits/{}"),
    // 分类与标签：分类与标签页
    (Method::GET, "/api/v1/categories"),
    (Method::POST, "/api/v1/categories"),
    (Method::PUT, "/api/v1/categories/{}"),
    (Method::DELETE, "/api/v1/categories/{}"),
    (Method::GET, "/api/v1/tags"),
    (Method::POST, "/api/v1/tags"),
    (Method::PUT, "/api/v1/tags/{}"),
    (Method::DELETE, "/api/v1/tags/{}"),
    // 阿贝在 Firefly 里加的两个接口：预算分组与分类统计
    (Method::GET, "/api/v1/abei/budget-groups"),
    (Method::PUT, "/api/v1/abei/budget-groups/{}"),
    (Method::GET, "/api/v1/abei/category-stats"),
    // 录入交易时的补全与搜索
    (Method::GET, "/api/v1/autocomplete/accounts"),
    (Method::GET, "/api/v1/autocomplete/categories"),
    (Method::GET, "/api/v1/autocomplete/tags"),
    (Method::GET, "/api/v1/search/accounts"),
    (Method::GET, "/api/v1/search/transactions"),
    // 分析页的图表与洞察
    (Method::GET, "/api/v1/chart/account/overview"),
    (Method::GET, "/api/v1/insight/expense/asset"),
    (Method::GET, "/api/v1/insight/expense/category"),
    (Method::GET, "/api/v1/insight/expense/tag"),
    (Method::GET, "/api/v1/insight/expense/budget"),
    (Method::GET, "/api/v1/insight/expense/no-category"),
    (Method::GET, "/api/v1/insight/expense/no-budget"),
    (Method::GET, "/api/v1/insight/income/revenue"),
    (Method::GET, "/api/v1/insight/report/overview"),
    (Method::GET, "/api/v1/summary/basic"),
    // 订阅（Firefly 的 recurrences）：订阅页与「立刻记一笔」
    (Method::GET, "/api/v1/recurrences"),
    (Method::POST, "/api/v1/recurrences/{}/trigger"),
    // 设置页：币种、关于、令牌管理与数据导出
    (Method::GET, "/api/v1/currencies"),
    (Method::GET, "/api/v1/about"),
    (Method::GET, "/api/v1/tokens"),
    (Method::POST, "/api/v1/tokens"),
    (Method::DELETE, "/api/v1/tokens/{}"),
    (Method::GET, "/api/v1/data/export/{}"),
];

/// 路径是否命中模板。`{}` 匹配一段非空路径，段数必须一样。
fn matches(template: &str, path: &str) -> bool {
    let mut template = template.split('/');
    let mut actual = path.split('/');
    loop {
        match (template.next(), actual.next()) {
            (None, None) => return true,
            (Some(expected), Some(segment)) => {
                if expected == "{}" {
                    if segment.is_empty() {
                        return false;
                    }
                } else if expected != segment {
                    return false;
                }
            }
            _ => return false,
        }
    }
}

fn allowed(method: &Method, path: &str) -> bool {
    ALLOWED
        .iter()
        .any(|(allowed, template)| allowed == method && matches(template, path))
}

pub async fn proxy(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    request: Request,
) -> Result<Response, Problem> {
    let path = request
        .uri()
        .path()
        .strip_prefix(PREFIX)
        .unwrap_or_default()
        .to_owned();
    if path.is_empty() || path == "/" {
        return Err(Problem::not_found(
            "透传要带上 Firefly 的完整路径，例如 /v1/firefly/api/v1/about。",
        ));
    }

    let method = request.method().clone();
    if !allowed(&method, &path) {
        return Err(Problem::not_found(format!(
            "{method} {path} 不在透传白名单里。abei-api 只放行 abei-web 当前用到的 Firefly 接口；\
             新增用途请在 abei-api 上开正式端点。"
        )));
    }
    let query = request.uri().query().map(str::to_owned);
    let headers = request.headers().clone();
    let body = to_bytes(request.into_body(), MAX_BODY)
        .await
        .map_err(|error| Problem::invalid_params(format!("请求体读不下来：{error}")))?;

    state
        .firefly
        .proxy(&token, method, &path, query.as_deref(), &headers, body)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_paths_abei_web_actually_calls_are_allowed() {
        // 抽自 abei-web 的调用点，id 换成了真实形态。这些断言塌了就说明前端会白屏。
        for (method, path) in [
            (Method::GET, "/api/v1/accounts"),
            (Method::DELETE, "/api/v1/accounts/7"),
            (Method::GET, "/api/v1/accounts/7/transactions"),
            (Method::PUT, "/api/v1/transactions/42"),
            (Method::GET, "/api/v1/transactions/42/attachments"),
            (Method::POST, "/api/v1/attachments/9/upload"),
            (Method::PUT, "/api/v1/budgets/7/limits/3"),
            (Method::DELETE, "/api/v1/categories/5"),
            (Method::PUT, "/api/v1/abei/budget-groups/2"),
            (Method::POST, "/api/v1/recurrences/5/trigger"),
            (Method::DELETE, "/api/v1/tokens/1"),
            (Method::GET, "/api/v1/data/export/transactions"),
        ] {
            assert!(allowed(&method, path), "{method} {path} 被挡了");
        }
    }

    #[test]
    fn everything_outside_the_list_is_refused() {
        for (method, path) in [
            // 换个方法就不行：清单是按方法列的
            (Method::DELETE, "/api/v1/budgets/7/limits"),
            (Method::POST, "/api/v1/about"),
            // Firefly 的用户管理和系统配置从来不该经这条路
            (Method::GET, "/api/v1/users"),
            (Method::POST, "/api/v1/users"),
            (Method::GET, "/api/v1/configuration"),
            (Method::GET, "/api/v1/preferences"),
            // 多一段少一段都不算命中
            (Method::GET, "/api/v1/accounts/7/transactions/1"),
            (Method::GET, "/api/v1/accounts//transactions"),
            (Method::GET, "/api/v1"),
        ] {
            assert!(!allowed(&method, path), "{method} {path} 不该放行");
        }
    }

    /// abei-web 里出现过的全部 Firefly 路径（2026-08-13 盘点，44 条）。
    ///
    /// 这里只管路径在不在清单里，不管方法——漏一条路径就是前端某个页面直接白屏，
    /// 而这种漏很容易发生：`getInsightRanking` 那四条就是靠间接调用藏起来的。
    #[test]
    fn every_path_abei_web_mentions_has_a_home_in_the_list() {
        for path in [
            "/api/v1/abei/budget-groups",
            "/api/v1/abei/budget-groups/1",
            "/api/v1/abei/category-stats",
            "/api/v1/about",
            "/api/v1/accounts",
            "/api/v1/accounts/1",
            "/api/v1/accounts/1/transactions",
            "/api/v1/attachments",
            "/api/v1/attachments/1",
            "/api/v1/attachments/1/download",
            "/api/v1/attachments/1/upload",
            "/api/v1/autocomplete/accounts",
            "/api/v1/autocomplete/categories",
            "/api/v1/autocomplete/tags",
            "/api/v1/budgets",
            "/api/v1/budgets/with-limit",
            "/api/v1/budgets/1",
            "/api/v1/budgets/1/limits",
            "/api/v1/budgets/1/limits/2",
            "/api/v1/categories",
            "/api/v1/categories/1",
            "/api/v1/chart/account/overview",
            "/api/v1/currencies",
            "/api/v1/data/export/transactions",
            "/api/v1/insight/expense/asset",
            "/api/v1/insight/expense/budget",
            "/api/v1/insight/expense/category",
            "/api/v1/insight/expense/no-budget",
            "/api/v1/insight/expense/no-category",
            "/api/v1/insight/expense/tag",
            "/api/v1/insight/income/revenue",
            "/api/v1/insight/report/overview",
            "/api/v1/recurrences",
            "/api/v1/recurrences/1/trigger",
            "/api/v1/search/accounts",
            "/api/v1/search/transactions",
            "/api/v1/summary/basic",
            "/api/v1/tags",
            "/api/v1/tags/1",
            "/api/v1/tokens",
            "/api/v1/tokens/1",
            "/api/v1/transactions",
            "/api/v1/transactions/1",
            "/api/v1/transactions/1/attachments",
        ] {
            assert!(
                ALLOWED.iter().any(|(_, template)| matches(template, path)),
                "{path} 不在透传白名单里，前端会白屏"
            );
        }
    }

    #[test]
    fn a_wildcard_matches_exactly_one_segment() {
        assert!(matches("/api/v1/accounts/{}", "/api/v1/accounts/7"));
        assert!(!matches("/api/v1/accounts/{}", "/api/v1/accounts"));
        assert!(!matches("/api/v1/accounts/{}", "/api/v1/accounts/7/x"));
        assert!(!matches("/api/v1/accounts/{}", "/api/v1/accounts/"));
    }
}
