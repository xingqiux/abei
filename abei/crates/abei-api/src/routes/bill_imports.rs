use abei_core::{BillsImportParams, Risk};
use axum::Json;
use axum::extract::{Extension, Path, State};
use axum::http::Method;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{AuthIdentity, AuthToken};
use crate::extract::{Gate, ValidJson, check_id};
use crate::firefly::VerifiedUser;
use crate::problem::Problem;
use crate::state::AppState;

const MAX_IMPORT_SELECTION: usize = 5_000;

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ResourceId {
    String(String),
    Number(u64),
}

impl ResourceId {
    fn parse(&self) -> Result<i64, Problem> {
        let value = match self {
            Self::String(value) => value.parse::<i64>().ok().filter(|value| *value > 0),
            Self::Number(value) => i64::try_from(*value).ok().filter(|value| *value > 0),
        };
        value.ok_or_else(|| Problem::invalid_params("row_ids 必须全部是正整数。"))
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RowsImportInput {
    row_ids: Vec<ResourceId>,
    #[serde(default)]
    include_payload: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MappingInput {
    channel_key: String,
    account_hint: String,
    firefly_account_id: ResourceId,
}

pub async fn import_rows(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    AuthToken(token): AuthToken,
    gate: Gate,
    ValidJson(input): ValidJson<RowsImportInput>,
) -> Result<Json<Value>, Problem> {
    gate.check(Risk::Confirm, "bill-rows.import")?;
    let row_ids = parse_row_ids(&input.row_ids)?;
    Ok(Json(
        run_imports(
            &state,
            &identity.0,
            &token,
            &row_ids,
            gate,
            input.include_payload,
        )
        .await,
    ))
}

pub async fn import_document(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    AuthToken(token): AuthToken,
    Path(path_id): Path<String>,
    gate: Gate,
    ValidJson(input): ValidJson<BillsImportParams>,
) -> Result<Json<Value>, Problem> {
    let at = |problem: Problem| problem.at("bills", "import");
    gate.check(Risk::Confirm, "bills.import").map_err(at)?;
    let document_id = check_id(&path_id)
        .map_err(at)?
        .parse::<i64>()
        .map_err(|_| at(Problem::invalid_params("账单文档 id 必须是正整数。")))?;
    let picking_all = input.all.unwrap_or(false);
    let selected = input.row_ids.unwrap_or_default();
    if picking_all != selected.is_empty() {
        return Err(at(Problem::invalid_params(
            "要么 all=true 导入整份，要么给 row_ids 挑几行，二选一。",
        )));
    }
    let row_ids = if picking_all {
        document_row_ids(&state, &identity.0, document_id)
            .await
            .map_err(at)?
    } else {
        let ids = selected
            .into_iter()
            .map(|value| {
                i64::try_from(value)
                    .ok()
                    .filter(|value| *value > 0)
                    .ok_or_else(|| Problem::invalid_params("row_ids 必须全部是正整数。"))
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(at)?;
        validate_selection_count(ids.len()).map_err(at)?;
        ids
    };
    Ok(Json(
        run_imports(
            &state,
            &identity.0,
            &token,
            &row_ids,
            gate,
            input.include_payload.unwrap_or(false),
        )
        .await,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UndoImportInput {
    row_ids: Vec<ResourceId>,
}

/// 撤销入账：删掉账本里那几笔，把行放回待处理。
///
/// 以前这件事由前端自己做——直接删 Firefly 的交易组。删完账本上没有了，abei 这边
/// 一无所知：行还停在已入账，「查看交易」指向一笔不存在的交易，而且再也重新入不了账。
/// 撤销会动账本，所以走确认闸；令牌和入账走同一条转交路径。
pub async fn undo_imports(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    AuthToken(token): AuthToken,
    gate: Gate,
    ValidJson(input): ValidJson<UndoImportInput>,
) -> Result<Json<Value>, Problem> {
    gate.check(Risk::Confirm, "bill-rows.undo-import")?;
    let row_ids = parse_row_ids(&input.row_ids)?;
    if gate.previewing() {
        return Ok(Json(json!({ "dry_run": true, "would": {
            "row_ids": row_ids, "action": "undo-import"
        }})));
    }
    let (_, value) = super::server::request_json_with_token(
        &state,
        &identity.0,
        Method::POST,
        "/internal/v1/bill-imports/undo",
        &json!({ "row_ids": row_ids }),
        &token,
    )
    .await?;
    Ok(Json(value))
}

pub async fn get_attempt(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Problem> {
    validate_attempt_id(&id)?;
    let (_, value) = server_json(
        &state,
        &identity.0,
        Method::GET,
        &format!("/v1/bill-import-attempts/{id}"),
        &Value::Null,
    )
    .await?;
    Ok(Json(value))
}

/// 对账：转发给 abei-server，它拿着用户令牌自己按 `external_id` 回查。
///
/// 这里以前有一整套同样的逻辑——查 Firefly、按结果分三支、分别再打回 abei-server。
/// 两处各写一遍就会各自漂移一点，而且这条路上真正危险的判断（「查不到」到底是
/// 没记上还是查询本身失败）必须由写状态的那一侧来做。现在只做转发。
pub async fn reconcile_attempt(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    AuthToken(token): AuthToken,
    Path(id): Path<String>,
) -> Result<Json<Value>, Problem> {
    validate_attempt_id(&id)?;
    let (_, value) = super::server::request_json_with_token(
        &state,
        &identity.0,
        Method::POST,
        &format!("/internal/v1/bill-imports/{id}/release"),
        &json!({}),
        &token,
    )
    .await?;
    // 对上了账 attempt 会落 reconciled/succeeded，没对上落 retryable。
    // match_count 是给客户端看的老字段，从结果状态推出来，不再单独查一遍。
    let match_count = match value["data"]["status"].as_str() {
        Some("reconciled" | "succeeded") => 1,
        _ => 0,
    };
    Ok(Json(
        json!({ "data": value["data"], "match_count": match_count }),
    ))
}

pub async fn retry_attempt(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    AuthToken(token): AuthToken,
    Path(id): Path<String>,
    gate: Gate,
) -> Result<Json<Value>, Problem> {
    gate.check(Risk::Confirm, "bill-import-attempts.retry")?;
    validate_attempt_id(&id)?;
    let (_, attempt) = server_json(
        &state,
        &identity.0,
        Method::GET,
        &format!("/v1/bill-import-attempts/{id}"),
        &Value::Null,
    )
    .await?;
    if attempt["data"]["status"] != "retryable" {
        return Err(Problem::new(
            axum::http::StatusCode::CONFLICT,
            "Conflict",
            "当前状态不允许这一步",
        )
        .detail("只有 retryable 导入尝试可以重试。"));
    }
    let row_id = parse_positive_id(&attempt["data"]["bill_row_id"])
        .ok_or_else(|| Problem::internal("导入尝试缺少 bill_row_id。"))?;
    Ok(Json(
        run_imports(&state, &identity.0, &token, &[row_id], gate, false).await,
    ))
}

pub async fn upsert_mapping(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    AuthToken(token): AuthToken,
    gate: Gate,
    ValidJson(input): ValidJson<MappingInput>,
) -> Result<Json<Value>, Problem> {
    gate.check(Risk::Draft, "bill-account-mappings.update")?;
    let account_id = input.firefly_account_id.parse()?;
    let account = verified_account(&state, &token, account_id).await?;
    let body = json!({
        "channel_key": input.channel_key,
        "account_hint": input.account_hint,
        "firefly_account_id": account_id,
        "firefly_account_name": account.name,
        "firefly_account_type": account.kind,
    });
    if gate.previewing() {
        return Ok(Json(json!({ "dry_run": true, "would": body })));
    }
    let (_, value) = server_json(
        &state,
        &identity.0,
        Method::PUT,
        "/v1/bill-account-mappings",
        &body,
    )
    .await?;
    Ok(Json(value))
}

pub async fn delete_mapping(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    Path(id): Path<String>,
    gate: Gate,
) -> Result<Json<Value>, Problem> {
    gate.check(Risk::Confirm, "bill-account-mappings.delete")?;
    check_id(&id)?;
    if gate.previewing() {
        return Ok(Json(json!({ "dry_run": true, "would": {
            "account_mapping_id": id, "action": "delete"
        }})));
    }
    let (_, value) = server_json(
        &state,
        &identity.0,
        Method::DELETE,
        &format!("/v1/bill-account-mappings/{id}?confirm=true"),
        &Value::Null,
    )
    .await?;
    Ok(Json(value))
}

/// 确认「新账单就记进这个已有账户」。
///
/// confirm 档：这一下定的是一整条渠道往后所有账单的去向，绑错了要一笔笔撤回来。
pub async fn confirm_channel_account(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    Path(id): Path<String>,
    gate: Gate,
) -> Result<Json<Value>, Problem> {
    gate.check(Risk::Confirm, "bill-channel-accounts.confirm")?;
    check_id(&id)?;
    if gate.previewing() {
        return Ok(Json(json!({ "dry_run": true, "would": {
            "channel_account_id": id, "action": "confirm"
        }})));
    }
    let (_, value) = server_json(
        &state,
        &identity.0,
        Method::POST,
        &format!("/v1/bill-channel-accounts/{id}/confirm?confirm=true"),
        &Value::Null,
    )
    .await?;
    Ok(Json(value))
}

/// 把整批入账转发给 abei-server 跑完。
///
/// 这里以前是 saga 本身：prepare → 校账户 → 查重 → mark-sending → 写 Firefly →
/// complete，六步里有五步是打回 abei-server 的 HTTP 调用。谁都不真正拥有这条流程——
/// abei-api 崩在中间，abei-server 就留下一条没人收尾的 `sending`。
///
/// 现在整条 saga 在 abei-server 进程内跑完（见 `billing::runner`），abei-api 只做
/// 它本来该做的事：校验用户令牌，然后把令牌和行号交过去。响应逐字来自 abei-server，
/// 字段和以前一模一样。
async fn run_imports(
    state: &AppState,
    identity: &VerifiedUser,
    token: &str,
    row_ids: &[i64],
    gate: Gate,
    include_payload: bool,
) -> Value {
    let dry_run = gate.previewing();
    match super::server::request_json_with_token(
        state,
        identity,
        Method::POST,
        "/internal/v1/bill-imports/run",
        &json!({
            "row_ids": row_ids,
            "dry_run": dry_run,
            "include_payload": include_payload,
        }),
        token,
    )
    .await
    {
        Ok((_, value)) => value,
        // 整批都没跑起来（abei-server 连不上、令牌被拒……）。仍然按逐行的形状回，
        // 让界面用同一套渲染路径显示失败，而不是撞上一个它不认识的错误体。
        Err(problem) => {
            let detail = problem_detail(&problem);
            let rows = row_ids
                .iter()
                .map(|row_id| failed_row(*row_id, "failed", detail.clone(), None))
                .collect::<Vec<_>>();
            let mut response = import_response(rows);
            if dry_run {
                response["dry_run"] = Value::Bool(true);
            }
            response
        }
    }
}

async fn document_row_ids(
    state: &AppState,
    identity: &VerifiedUser,
    document_id: i64,
) -> Result<Vec<i64>, Problem> {
    let mut page = 1_u32;
    let mut ids = Vec::new();
    loop {
        let (_, value) = server_json(
            state,
            identity,
            Method::GET,
            &format!("/v1/bill-rows?document_id={document_id}&page={page}&limit=500"),
            &Value::Null,
        )
        .await?;
        ids.extend(
            value["data"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|row| {
                    (row["attributes"]["status"] == "pending")
                        .then(|| parse_positive_id(&row["id"]))
                        .flatten()
                }),
        );
        let total_pages = value["meta"]["pagination"]["total_pages"]
            .as_u64()
            .unwrap_or(page as u64);
        if page as u64 >= total_pages {
            break;
        }
        page = page.saturating_add(1);
        if ids.len() > MAX_IMPORT_SELECTION {
            return Err(Problem::invalid_params(format!(
                "整份账单最多支持 {MAX_IMPORT_SELECTION} 条待处理流水。"
            )));
        }
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

fn parse_row_ids(values: &[ResourceId]) -> Result<Vec<i64>, Problem> {
    let mut ids = values
        .iter()
        .map(ResourceId::parse)
        .collect::<Result<Vec<_>, _>>()?;
    ids.sort_unstable();
    ids.dedup();
    validate_selection_count(ids.len())?;
    Ok(ids)
}

fn validate_selection_count(count: usize) -> Result<(), Problem> {
    if count <= MAX_IMPORT_SELECTION {
        Ok(())
    } else {
        Err(Problem::invalid_params(format!(
            "每次最多选择 {MAX_IMPORT_SELECTION} 条流水，收到 {count} 条。"
        )))
    }
}

#[derive(Debug)]
struct AccountIdentity {
    name: String,
    kind: Option<String>,
}

async fn verified_account(
    state: &AppState,
    token: &str,
    account_id: i64,
) -> Result<AccountIdentity, Problem> {
    let account = state
        .firefly
        .get_json(token, &format!("/api/v1/accounts/{account_id}"), &[])
        .await?;
    let attributes = &account["data"]["attributes"];
    let name = attributes["name"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            Problem::upstream_error(axum::http::StatusCode::OK, "Firefly 账户响应缺少名称。")
        })?;
    let kind = attributes["type"].as_str().map(str::to_owned);
    if kind.as_deref().is_some_and(|value| {
        let normalized = value.to_ascii_lowercase();
        normalized.contains("expense") || normalized.contains("revenue")
    }) {
        return Err(Problem::invalid_params(
            "账单账户映射必须指向资产、现金或负债账户，不能指向收入/支出科目。",
        ));
    }
    Ok(AccountIdentity {
        name: name.to_owned(),
        kind,
    })
}

async fn server_json(
    state: &AppState,
    identity: &VerifiedUser,
    method: Method,
    path: &str,
    body: &Value,
) -> Result<(axum::http::StatusCode, Value), Problem> {
    super::server::request_json(state, identity, method, path, body).await
}

fn import_response(rows: Vec<Value>) -> Value {
    let imported = rows
        .iter()
        .filter(|row| row["action"] == "imported")
        .count();
    let skipped = rows.iter().filter(|row| row["action"] == "skip").count();
    let uncertain = rows
        .iter()
        .filter(|row| row["action"] == "uncertain")
        .count();
    let failed = rows.iter().filter(|row| row["action"] == "failed").count();
    let retryable = rows
        .iter()
        .filter(|row| row["action"] == "retryable")
        .count();
    let would_import = rows
        .iter()
        .filter(|row| row["action"] == "would_import")
        .count();
    json!({
        "summary": {
            "total": rows.len(),
            "imported": imported,
            "skipped": skipped,
            "failed": failed,
            "retryable": retryable,
            "uncertain": uncertain,
            "would_import": would_import,
        },
        "rows": rows,
        "empty_reason": if rows.is_empty() {
            Some("没有可处理的待处理流水；请查看 bills review 或按 row_ids 预览具体排除原因。")
        } else {
            None
        },
        "balance_chain": [],
    })
}

fn failed_row(row_id: i64, action: &str, error: String, attempt_id: Option<String>) -> Value {
    let reason_code = match action {
        "skip" => "import_excluded",
        "retryable" => "import_retryable",
        "uncertain" => "import_uncertain",
        _ => "import_failed",
    };
    let exclusion_reason = (action == "skip").then(|| error.clone());
    failed_row_with_reason(
        row_id,
        action,
        error,
        attempt_id,
        reason_code,
        exclusion_reason,
    )
}

fn failed_row_with_reason(
    row_id: i64,
    action: &str,
    error: String,
    attempt_id: Option<String>,
    reason_code: &str,
    exclusion_reason: Option<String>,
) -> Value {
    json!({
        "row_id": row_id.to_string(),
        "status": action,
        "action": action,
        "attempt_id": attempt_id,
        "error": error,
        "reason_code": reason_code,
        "exclusion_reason": exclusion_reason,
    })
}

fn parse_positive_id(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str()?.parse::<i64>().ok())
        .filter(|value| *value > 0)
}

fn validate_attempt_id(value: &str) -> Result<(), Problem> {
    if value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        Ok(())
    } else {
        Err(Problem::invalid_params("导入尝试 id 不对。"))
    }
}

fn problem_detail(problem: &Problem) -> String {
    problem
        .detail
        .clone()
        .unwrap_or_else(|| problem.title.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_summary_keeps_uncertain_separate_from_failed() {
        let value = import_response(vec![
            failed_row(1, "uncertain", "timeout".to_owned(), Some("a".repeat(36))),
            failed_row(2, "failed", "422".to_owned(), None),
            failed_row(4, "retryable", "503".to_owned(), Some("b".repeat(36))),
            json!({ "row_id": "3", "action": "imported" }),
        ]);
        assert_eq!(value["summary"]["imported"], 1);
        assert_eq!(value["summary"]["failed"], 1);
        assert_eq!(value["summary"]["uncertain"], 1);
        assert_eq!(value["summary"]["retryable"], 1);
    }

    #[test]
    fn duplicate_row_ids_are_sent_once() {
        let ids = parse_row_ids(&[
            ResourceId::Number(2),
            ResourceId::String("2".to_owned()),
            ResourceId::Number(1),
        ])
        .unwrap();
        assert_eq!(ids, vec![1, 2]);
    }
}
