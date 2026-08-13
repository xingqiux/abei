use std::collections::BTreeMap;

use axum::Json;
use axum::extract::Multipart;
use axum::extract::multipart::MultipartRejection;
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{ApiError, AppState, WriteGate, actor, authenticated_user_id};

const MAX_EML_BYTES: usize = 25 * 1024 * 1024;
const MAX_YAML_BYTES: usize = 256 * 1024;
const MAX_SECRETS_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ValidateInput {
    source_yaml: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateFlowInput {
    name: String,
    slug: String,
    source_yaml: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UpdateFlowInput {
    name: Option<String>,
    source_yaml: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CloneFlowInput {
    name: String,
    slug: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct TestFlowInput {
    mail_message_id: Option<i64>,
    mail_sample_id: Option<i64>,
    source_yaml: Option<String>,
    version: Option<i32>,
    timezone: String,
    secrets: BTreeMap<String, String>,
}

struct UploadedEml {
    raw: Vec<u8>,
    source_yaml: Option<String>,
    version: Option<i32>,
    timezone: String,
    secrets: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RollbackInput {
    target_version: i32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TestCaseInput {
    name: String,
    mail_sample_id: i64,
    #[serde(default = "empty_object")]
    expected: Value,
    #[serde(default = "enabled")]
    enabled: bool,
}

fn enabled() -> bool {
    true
}

fn empty_object() -> Value {
    json!({})
}

pub(crate) async fn validate(
    headers: HeaderMap,
    payload: Result<Json<ValidateInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    authenticated_user_id(&headers)?;
    let Json(input) = payload.map_err(json_error)?;
    Ok(Json(super::Service::validate_source(&input.source_yaml)?))
}

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    Ok(Json(state.parser.list(user_id).await?))
}

pub(crate) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<CreateFlowInput>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    let validation = super::Service::validate_source(&input.source_yaml)?;
    if gate.dry_run {
        return Ok((
            StatusCode::OK,
            Json(json!({
                "dry_run": true,
                "data": {
                    "name": input.name,
                    "slug": input.slug,
                    "validation": validation["data"],
                }
            })),
        ));
    }
    Ok((
        StatusCode::CREATED,
        Json(
            state
                .parser
                .create(user_id, &input.name, &input.slug, &input.source_yaml)
                .await?,
        ),
    ))
}

pub(crate) async fn get(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "解析流程")?;
    Ok(Json(state.parser.get(user_id, id).await?))
}

pub(crate) async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<UpdateFlowInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "解析流程")?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    if let Some(source) = input.source_yaml.as_deref() {
        super::Service::validate_source(source)?;
    }
    if gate.dry_run {
        return Ok(Json(json!({
            "dry_run": true,
            "data": { "id": id.to_string(), "name": input.name, "source_yaml": input.source_yaml }
        })));
    }
    Ok(Json(
        state
            .parser
            .update(
                user_id,
                id,
                input.name.as_deref(),
                input.source_yaml.as_deref(),
            )
            .await?,
    ))
}

pub(crate) async fn clone_flow(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<CloneFlowInput>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "解析流程")?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    if gate.dry_run {
        return Ok((
            StatusCode::OK,
            Json(json!({
                "dry_run": true,
                "data": { "source_id": id.to_string(), "name": input.name, "slug": input.slug }
            })),
        ));
    }
    Ok((
        StatusCode::CREATED,
        Json(
            state
                .parser
                .clone_flow(user_id, id, &input.name, &input.slug)
                .await?,
        ),
    ))
}

pub(crate) async fn test(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<TestFlowInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "解析流程")?;
    let Json(input) = payload.map_err(json_error)?;
    Ok(Json(
        state
            .parser
            .test(
                user_id,
                id,
                input.mail_message_id,
                input.mail_sample_id,
                input.source_yaml.as_deref(),
                input.version,
                &input.timezone,
                input.secrets,
            )
            .await?,
    ))
}

pub(crate) async fn test_eml(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Multipart, MultipartRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let flow_id = resource_id(path, "解析流程")?;
    let upload = parse_eml_upload(payload).await?;
    Ok(Json(
        state
            .parser
            .test_eml(
                user_id,
                flow_id,
                &upload.raw,
                upload.source_yaml.as_deref(),
                upload.version,
                &upload.timezone,
                upload.secrets,
            )
            .await?,
    ))
}

pub(crate) async fn test_eml_source(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Multipart, MultipartRejection>,
) -> Result<Json<Value>, ApiError> {
    authenticated_user_id(&headers)?;
    let upload = parse_eml_upload(payload).await?;
    if upload.version.is_some() {
        return Err(ApiError::invalid_params(
            "未绑定流程的 EML 测试不能指定 version。",
        ));
    }
    let source_yaml = upload
        .source_yaml
        .ok_or_else(|| ApiError::invalid_params("缺少 source_yaml。"))?;
    Ok(Json(
        state
            .parser
            .test_source_eml(&source_yaml, &upload.raw, &upload.timezone, upload.secrets)
            .await?,
    ))
}

async fn parse_eml_upload(
    payload: Result<Multipart, MultipartRejection>,
) -> Result<UploadedEml, ApiError> {
    let mut multipart = payload
        .map_err(|error| ApiError::invalid_params(format!("EML 上传请求无法读取：{error}")))?;
    let mut raw_eml = None;
    let mut source_yaml = None;
    let mut version = None;
    let mut timezone = String::new();
    let mut secrets = BTreeMap::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| ApiError::invalid_params(format!("EML 上传字段无法读取：{error}")))?
    {
        let name = field
            .name()
            .ok_or_else(|| ApiError::invalid_params("EML 上传字段缺少名称。"))?
            .to_owned();
        match name.as_str() {
            "eml" => {
                if raw_eml.is_some() {
                    return Err(ApiError::invalid_params("eml 字段不能重复。"));
                }
                let bytes = field.bytes().await.map_err(|error| {
                    ApiError::invalid_params(format!("EML 文件无法读取：{error}"))
                })?;
                if bytes.is_empty() || bytes.len() > MAX_EML_BYTES {
                    return Err(ApiError::invalid_params("EML 必须非空且不能超过 25 MiB。"));
                }
                raw_eml = Some(bytes.to_vec());
            }
            "source_yaml" => {
                let value = field.text().await.map_err(|error| {
                    ApiError::invalid_params(format!("source_yaml 无法读取：{error}"))
                })?;
                if value.len() > MAX_YAML_BYTES {
                    return Err(ApiError::invalid_params(
                        "ParserFlow YAML 不能超过 256 KiB。",
                    ));
                }
                source_yaml = Some(value);
            }
            "version" => {
                let value = field.text().await.map_err(|error| {
                    ApiError::invalid_params(format!("version 无法读取：{error}"))
                })?;
                version = Some(
                    value
                        .parse::<i32>()
                        .map_err(|_| ApiError::invalid_params("version 必须是正整数。"))?,
                );
            }
            "timezone" => {
                timezone = field.text().await.map_err(|error| {
                    ApiError::invalid_params(format!("timezone 无法读取：{error}"))
                })?;
                if timezone.len() > 120 {
                    return Err(ApiError::invalid_params("timezone 最多 120 个字符。"));
                }
            }
            "secrets" => {
                let value = field.text().await.map_err(|error| {
                    ApiError::invalid_params(format!("secrets 无法读取：{error}"))
                })?;
                if value.len() > MAX_SECRETS_BYTES {
                    return Err(ApiError::invalid_params("secrets 不能超过 64 KiB。"));
                }
                secrets =
                    serde_json::from_str::<BTreeMap<String, String>>(&value).map_err(|error| {
                        ApiError::invalid_params(format!("secrets 不是字符串映射：{error}"))
                    })?;
            }
            _ => {
                return Err(ApiError::invalid_params(format!(
                    "EML 上传不支持字段 {name}。"
                )));
            }
        }
    }

    Ok(UploadedEml {
        raw: raw_eml.ok_or_else(|| ApiError::invalid_params("缺少 eml 文件。"))?,
        source_yaml,
        version,
        timezone,
        secrets,
    })
}

pub(crate) async fn publish(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let actor = actor(&headers)?.name;
    let id = resource_id(path, "解析流程")?;
    let gate = parse_gate(gate)?;
    if gate.dry_run {
        return Ok(Json(state.parser.publish_preview(user_id, id).await?));
    }
    gate.require_confirmation("parser-flows.publish")?;
    Ok(Json(state.parser.publish(user_id, id, &actor).await?))
}

pub(crate) async fn rollback(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<RollbackInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "解析流程")?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    if gate.dry_run {
        return Ok(Json(json!({
            "dry_run": true,
            "data": { "id": id.to_string(), "target_version": input.target_version }
        })));
    }
    gate.require_confirmation("parser-flows.rollback")?;
    Ok(Json(
        state
            .parser
            .rollback(user_id, id, input.target_version)
            .await?,
    ))
}

pub(crate) async fn retire(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "解析流程")?;
    let gate = parse_gate(gate)?;
    if gate.dry_run {
        return Ok(Json(json!({
            "dry_run": true,
            "data": { "id": id.to_string(), "action": "retire" }
        })));
    }
    gate.require_confirmation("parser-flows.retire")?;
    Ok(Json(state.parser.retire(user_id, id).await?))
}

pub(crate) async fn versions(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "解析流程")?;
    Ok(Json(state.parser.versions(user_id, id).await?))
}

pub(crate) async fn version(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<(String, String)>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let (flow_id, version) = nested_ids(path, "解析流程", "版本")?;
    let version =
        i32::try_from(version).map_err(|_| ApiError::invalid_params("版本号超出范围。"))?;
    Ok(Json(state.parser.version(user_id, flow_id, version).await?))
}

pub(crate) async fn create_test_case(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<TestCaseInput>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let flow_id = resource_id(path, "解析流程")?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    if gate.dry_run {
        return Ok((
            StatusCode::OK,
            Json(json!({ "dry_run": true, "data": input_preview(&input) })),
        ));
    }
    Ok((
        StatusCode::CREATED,
        Json(
            state
                .parser
                .create_test_case(
                    user_id,
                    flow_id,
                    &input.name,
                    input.mail_sample_id,
                    input.expected,
                    input.enabled,
                )
                .await?,
        ),
    ))
}

pub(crate) async fn update_test_case(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<TestCaseInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let case_id = resource_id(path, "解析测试用例")?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    if gate.dry_run {
        return Ok(Json(
            json!({ "dry_run": true, "data": input_preview(&input) }),
        ));
    }
    Ok(Json(
        state
            .parser
            .update_test_case(
                user_id,
                case_id,
                &input.name,
                input.mail_sample_id,
                input.expected,
                input.enabled,
            )
            .await?,
    ))
}

pub(crate) async fn delete_test_case(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let case_id = resource_id(path, "解析测试用例")?;
    let gate = parse_gate(gate)?;
    if gate.dry_run {
        return Ok(StatusCode::NO_CONTENT);
    }
    gate.require_confirmation("parser-test-cases.delete")?;
    state.parser.delete_test_case(user_id, case_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn test_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let run_id = resource_id(path, "解析测试运行")?;
    Ok(Json(state.parser.test_run(user_id, run_id).await?))
}

fn input_preview(input: &TestCaseInput) -> Value {
    json!({
        "name": input.name,
        "mail_sample_id": input.mail_sample_id.to_string(),
        "expected": input.expected,
        "enabled": input.enabled,
    })
}

fn resource_id(path: Result<Path<String>, PathRejection>, label: &str) -> Result<i64, ApiError> {
    let value = path
        .map_err(|error| ApiError::invalid_params(format!("{label} id 不对：{error}")))?
        .0;
    positive_id(&value, label)
}

fn nested_ids(
    path: Result<Path<(String, String)>, PathRejection>,
    left_label: &str,
    right_label: &str,
) -> Result<(i64, i64), ApiError> {
    let Path((left, right)) = path.map_err(|error| ApiError::invalid_params(error.body_text()))?;
    Ok((
        positive_id(&left, left_label)?,
        positive_id(&right, right_label)?,
    ))
}

fn positive_id(value: &str, label: &str) -> Result<i64, ApiError> {
    value
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| ApiError::invalid_params(format!("{label} id 必须是正整数。")))
}

fn parse_gate(gate: Result<Query<WriteGate>, QueryRejection>) -> Result<WriteGate, ApiError> {
    gate.map(|Query(gate)| gate)
        .map_err(|error| ApiError::invalid_params(error.body_text()))
}

fn json_error(error: JsonRejection) -> ApiError {
    ApiError::invalid_params(error.body_text())
}
