use axum::Json;
use axum::body::Body;
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Value, json};

use super::rows::{RowUpdate, SplitPart};
use crate::{ApiError, AppState, WriteGate, actor, authenticated_user_id};

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct DocumentQuery {
    source: Option<String>,
    channel: Option<String>,
    status: Option<String>,
    page: Option<u32>,
    limit: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct RowQuery {
    group: Option<String>,
    source: Option<String>,
    channel: Option<String>,
    document_id: Option<String>,
    page: Option<u32>,
    limit: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct ReparseInput {
    version: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SecretInput {
    #[serde(alias = "value")]
    secret: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct BulkRowsInput {
    row_ids: Vec<Value>,
    filter: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BulkRowsUpdateInput {
    row_ids: Vec<Value>,
    values: RowUpdate,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SplitInput {
    splits: Vec<SplitPart>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PrepareImportInput {
    row_id: i64,
    #[serde(default)]
    dry_run: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompleteImportInput {
    transaction_group_id: i64,
    #[serde(default)]
    reconciled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FailImportInput {
    #[serde(default)]
    retryable: bool,
    firefly_status: Option<i32>,
    error_code: String,
    error_message: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UncertainImportInput {
    error_message: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct MappingQuery {
    channel: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AccountMappingInput {
    channel_key: String,
    account_hint: String,
    firefly_account_id: i64,
    firefly_account_name: String,
    firefly_account_type: Option<String>,
}

pub(crate) async fn list_documents(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<DocumentQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let Query(query) = query.map_err(query_error)?;
    Ok(Json(
        state
            .billing
            .list_documents(
                user_id,
                query.channel.as_deref().or(query.source.as_deref()),
                query.status.as_deref(),
                query.page.unwrap_or(1),
                query.limit.unwrap_or(50),
            )
            .await?,
    ))
}

pub(crate) async fn get_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    Ok(Json(
        state
            .billing
            .get_document(user_id, resource_id(path, "账单文档")?)
            .await?,
    ))
}

pub(crate) async fn document_revisions(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    Ok(Json(
        state
            .billing
            .document_revisions(user_id, resource_id(path, "账单文档")?)
            .await?,
    ))
}

pub(crate) async fn document_artifacts(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    Ok(Json(
        state
            .billing
            .document_artifacts(user_id, resource_id(path, "账单文档")?)
            .await?,
    ))
}

pub(crate) async fn document_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    Ok(Json(
        state
            .billing
            .document_events(user_id, resource_id(path, "账单文档")?)
            .await?,
    ))
}

pub(crate) async fn download_artifact(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let (bytes, filename, mime_type) = state
        .billing
        .download_artifact(user_id, resource_id(path, "账单工件")?)
        .await?;
    let content_type = HeaderValue::from_str(&mime_type)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    let filename = filename
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '_') {
                value
            } else {
                '_'
            }
        })
        .collect::<String>();
    let disposition = HeaderValue::from_str(&format!(
        "attachment; filename=\"{}\"",
        if filename.is_empty() {
            "artifact.bin"
        } else {
            &filename
        }
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("attachment"));
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    response
        .headers_mut()
        .insert(header::CONTENT_DISPOSITION, disposition);
    Ok(response)
}

pub(crate) async fn document_review(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    Ok(Json(
        state
            .billing
            .document_review(user_id, resource_id(path, "账单文档")?)
            .await?,
    ))
}

pub(crate) async fn document_rows(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "账单文档")?;
    Ok(Json(
        state
            .billing
            .list_rows(user_id, None, None, Some(id), 1, 500)
            .await?,
    ))
}

pub(crate) async fn reparse_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<ReparseInput>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "账单文档")?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    if input.version.is_some_and(|version| version < 1) {
        return Err(ApiError::invalid_params("version 必须是正整数。"));
    }
    if gate.dry_run {
        state.billing.get_document(user_id, id).await?;
        return Ok((
            StatusCode::OK,
            Json(json!({
                "dry_run": true,
                "would": { "bill_document_id": id.to_string(), "version": input.version }
            })),
        ));
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(
            state
                .billing
                .reparse_document(user_id, id, input.version)
                .await?,
        ),
    ))
}

pub(crate) async fn archive_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    document_lifecycle(state, headers, path, gate, "archived", true).await
}

pub(crate) async fn restore_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    document_lifecycle(state, headers, path, gate, "active", false).await
}

async fn document_lifecycle(
    state: AppState,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    lifecycle: &'static str,
    confirm: bool,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "账单文档")?;
    let gate = parse_gate(gate)?;
    if gate.dry_run {
        state.billing.get_document(user_id, id).await?;
        return Ok(Json(json!({ "dry_run": true, "would": {
            "bill_document_id": id.to_string(), "lifecycle": lifecycle
        }})));
    }
    if confirm {
        gate.require_confirmation("bill-documents.archive")?;
    }
    Ok(Json(
        state
            .billing
            .set_document_lifecycle(user_id, id, lifecycle)
            .await?,
    ))
}

pub(crate) async fn get_parse_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    Ok(Json(
        state
            .billing
            .get_parse_job(user_id, resource_id(path, "解析任务")?)
            .await?,
    ))
}

pub(crate) async fn retry_parse_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "解析任务")?;
    let gate = parse_gate(gate)?;
    if gate.dry_run {
        state.billing.get_parse_job(user_id, id).await?;
        return Ok(Json(
            json!({ "dry_run": true, "would": { "parse_job_id": id.to_string(), "action": "retry" } }),
        ));
    }
    Ok(Json(state.billing.retry_parse_job(user_id, id).await?))
}

pub(crate) async fn cancel_parse_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "解析任务")?;
    let gate = parse_gate(gate)?;
    if gate.dry_run {
        state.billing.get_parse_job(user_id, id).await?;
        return Ok(Json(
            json!({ "dry_run": true, "would": { "parse_job_id": id.to_string(), "action": "cancel" } }),
        ));
    }
    Ok(Json(state.billing.cancel_parse_job(user_id, id).await?))
}

pub(crate) async fn submit_job_secret(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<SecretInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "解析任务")?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    if gate.dry_run {
        state.billing.get_parse_job(user_id, id).await?;
        return Ok(Json(
            json!({ "dry_run": true, "would": { "parse_job_id": id.to_string(), "action": "submit_secret" } }),
        ));
    }
    gate.require_confirmation("parse-jobs.secret")?;
    Ok(Json(
        state
            .billing
            .submit_job_secret(user_id, id, &input.secret)
            .await?,
    ))
}

pub(crate) async fn retry_document_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let document_id = resource_id(path, "账单文档")?;
    let job_id = state
        .billing
        .latest_parse_job_id(user_id, document_id)
        .await?;
    let gate = parse_gate(gate)?;
    if gate.dry_run {
        return Ok(Json(
            json!({ "dry_run": true, "would": { "parse_job_id": job_id.to_string(), "action": "retry" } }),
        ));
    }
    Ok(Json(state.billing.retry_parse_job(user_id, job_id).await?))
}

pub(crate) async fn submit_document_secret(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<SecretInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let document_id = resource_id(path, "账单文档")?;
    let job_id = state
        .billing
        .latest_parse_job_id(user_id, document_id)
        .await?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    if gate.dry_run {
        return Ok(Json(
            json!({ "dry_run": true, "would": { "parse_job_id": job_id.to_string(), "action": "submit_secret" } }),
        ));
    }
    gate.require_confirmation("bills.unlock")?;
    Ok(Json(
        state
            .billing
            .submit_job_secret(user_id, job_id, &input.secret)
            .await?,
    ))
}

pub(crate) async fn list_rows(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<RowQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let Query(query) = query.map_err(query_error)?;
    let document_id = query.document_id.as_deref().map(parse_id).transpose()?;
    Ok(Json(
        state
            .billing
            .list_rows(
                user_id,
                query.group.as_deref(),
                query.channel.as_deref().or(query.source.as_deref()),
                document_id,
                query.page.unwrap_or(1),
                query.limit.unwrap_or(200),
            )
            .await?,
    ))
}

pub(crate) async fn get_row(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    Ok(Json(
        state
            .billing
            .get_row(user_id, resource_id(path, "账单流水")?)
            .await?,
    ))
}

pub(crate) async fn update_row(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<RowUpdate>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "账单流水")?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    input.validate()?;
    if gate.dry_run {
        state.billing.get_row(user_id, id).await?;
        return Ok(Json(
            json!({ "dry_run": true, "would": { "row_id": id.to_string(), "values": input } }),
        ));
    }
    Ok(Json(state.billing.update_row(user_id, id, &input).await?))
}

pub(crate) async fn update_rows_many(
    State(state): State<AppState>,
    headers: HeaderMap,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<BulkRowsUpdateInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    let ids = resource_ids(&input.row_ids)?;
    if ids.is_empty() || ids.len() > 500 {
        return Err(ApiError::invalid_params(
            "row_ids 必须包含 1 到 500 条流水。",
        ));
    }
    input.values.validate()?;
    if gate.dry_run {
        return Ok(Json(
            state
                .billing
                .preview_update_rows(user_id, &ids, &input.values)
                .await?,
        ));
    }
    Ok(Json(
        state
            .billing
            .update_rows_many(user_id, &ids, &input.values)
            .await?,
    ))
}

pub(crate) async fn dismiss_rows(
    State(state): State<AppState>,
    headers: HeaderMap,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<BulkRowsInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    let ids = resource_ids(&input.row_ids)?;
    let machine = input.filter.as_deref() == Some("machine_duplicates");
    if input.filter.is_some() && !machine {
        return Err(ApiError::invalid_params("filter 不支持。"));
    }
    if gate.dry_run {
        return Ok(Json(
            state
                .billing
                .preview_dismiss_rows(user_id, &ids, machine)
                .await?,
        ));
    }
    gate.require_confirmation("rows.dismiss")?;
    Ok(Json(
        state
            .billing
            .dismiss_rows(user_id, &ids, machine, input.reason.as_deref())
            .await?,
    ))
}

pub(crate) async fn restore_rows(
    State(state): State<AppState>,
    headers: HeaderMap,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<BulkRowsInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    let ids = resource_ids(&input.row_ids)?;
    if gate.dry_run {
        return Ok(Json(
            state.billing.preview_restore_rows(user_id, &ids).await?,
        ));
    }
    Ok(Json(state.billing.restore_rows(user_id, &ids).await?))
}

pub(crate) async fn mark_row_unique(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "账单流水")?;
    let gate = parse_gate(gate)?;
    if gate.dry_run {
        state.billing.get_row(user_id, id).await?;
        return Ok(Json(
            json!({ "dry_run": true, "would": { "row_id": id.to_string(), "duplicate_state": "unique" } }),
        ));
    }
    Ok(Json(state.billing.mark_row_unique(user_id, id).await?))
}

pub(crate) async fn split_row(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<SplitInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let actor = actor(&headers)?.name;
    let id = resource_id(path, "账单流水")?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    if gate.dry_run {
        state.billing.get_row(user_id, id).await?;
        return Ok(Json(
            json!({ "dry_run": true, "would": { "row_id": id.to_string(), "splits": input.splits.len() } }),
        ));
    }
    Ok(Json(
        state
            .billing
            .split_row(user_id, id, &actor, &input.splits)
            .await?,
    ))
}

pub(crate) async fn inbox_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    Ok(Json(state.billing.inbox_summary(user_id).await?))
}

pub(crate) async fn prepare_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<PrepareImportInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let Json(input) = payload.map_err(json_error)?;
    if input.row_id <= 0 {
        return Err(ApiError::invalid_params("row_id 必须是正整数。"));
    }
    Ok(Json(
        state
            .billing
            .prepare_import(user_id, input.row_id, input.dry_run)
            .await?,
    ))
}

pub(crate) async fn get_import_attempt(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = opaque_id(path, "导入尝试")?;
    Ok(Json(state.billing.get_import_attempt(user_id, &id).await?))
}

pub(crate) async fn mark_import_sending(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = opaque_id(path, "导入尝试")?;
    Ok(Json(state.billing.mark_import_sending(user_id, &id).await?))
}

pub(crate) async fn complete_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<CompleteImportInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = opaque_id(path, "导入尝试")?;
    let Json(input) = payload.map_err(json_error)?;
    Ok(Json(
        state
            .billing
            .complete_import(user_id, &id, input.transaction_group_id, input.reconciled)
            .await?,
    ))
}

pub(crate) async fn fail_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<FailImportInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = opaque_id(path, "导入尝试")?;
    let Json(input) = payload.map_err(json_error)?;
    Ok(Json(
        state
            .billing
            .fail_import(
                user_id,
                &id,
                input.retryable,
                input.firefly_status,
                &input.error_code,
                &input.error_message,
            )
            .await?,
    ))
}

pub(crate) async fn mark_import_uncertain(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<UncertainImportInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = opaque_id(path, "导入尝试")?;
    let Json(input) = payload.map_err(json_error)?;
    Ok(Json(
        state
            .billing
            .mark_import_uncertain(user_id, &id, &input.error_message)
            .await?,
    ))
}

pub(crate) async fn release_uncertain_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = opaque_id(path, "导入尝试")?;
    Ok(Json(
        state.billing.release_uncertain_import(user_id, &id).await?,
    ))
}

pub(crate) async fn list_account_mappings(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<MappingQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let Query(query) = query.map_err(query_error)?;
    Ok(Json(
        state
            .billing
            .list_account_mappings(user_id, query.channel.as_deref())
            .await?,
    ))
}

pub(crate) async fn upsert_account_mapping(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<AccountMappingInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let Json(input) = payload.map_err(json_error)?;
    Ok(Json(
        state
            .billing
            .upsert_account_mapping(
                user_id,
                &input.channel_key,
                &input.account_hint,
                input.firefly_account_id,
                &input.firefly_account_name,
                input.firefly_account_type.as_deref(),
            )
            .await?,
    ))
}

pub(crate) async fn delete_account_mapping(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "账户映射")?;
    let gate = parse_gate(gate)?;
    if gate.dry_run {
        return Ok(Json(json!({ "dry_run": true, "would": {
            "account_mapping_id": id.to_string(), "action": "delete"
        }})));
    }
    gate.require_confirmation("bill-account-mappings.delete")?;
    Ok(Json(
        state.billing.delete_account_mapping(user_id, id).await?,
    ))
}

fn resource_id(path: Result<Path<String>, PathRejection>, label: &str) -> Result<i64, ApiError> {
    let value = path
        .map_err(|error| ApiError::invalid_params(format!("{label} id 不对：{error}")))?
        .0;
    parse_id(&value)
}

fn opaque_id(path: Result<Path<String>, PathRejection>, label: &str) -> Result<String, ApiError> {
    let value = path
        .map_err(|error| ApiError::invalid_params(format!("{label} id 不对：{error}")))?
        .0;
    if value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        Ok(value)
    } else {
        Err(ApiError::invalid_params(format!("{label} id 不对。")))
    }
}

fn parse_id(value: &str) -> Result<i64, ApiError> {
    value
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| ApiError::invalid_params("资源 id 必须是正整数。"))
}

fn resource_ids(values: &[Value]) -> Result<Vec<i64>, ApiError> {
    let mut ids = values
        .iter()
        .map(|value| match value {
            Value::String(value) => parse_id(value),
            Value::Number(value) => value
                .as_i64()
                .filter(|id| *id > 0)
                .ok_or_else(|| ApiError::invalid_params("row_ids 必须是正整数。")),
            _ => Err(ApiError::invalid_params("row_ids 必须是正整数。")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

fn parse_gate(gate: Result<Query<WriteGate>, QueryRejection>) -> Result<WriteGate, ApiError> {
    gate.map(|Query(gate)| gate).map_err(query_error)
}

fn query_error(error: QueryRejection) -> ApiError {
    ApiError::invalid_params(error.body_text())
}

fn json_error(error: JsonRejection) -> ApiError {
    ApiError::invalid_params(error.body_text())
}
