use std::fmt::Write;

use axum::Json;
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_postgres::Row;
use tokio_postgres::error::SqlState;

use crate::{ApiError, AppState, WriteGate, actor, authenticated_user_id};

const MAX_CONTENT_BYTES: usize = 1024 * 1024;
const PROFILE_DOC_COLUMNS: &str = "slug, title, content_md, version, content_sha256, \
    updated_by, updated_source, created_at::text AS created_at, \
    updated_at::text AS updated_at";

#[derive(Debug, Serialize)]
struct ProfileDoc {
    slug: String,
    title: String,
    content_md: String,
    version: i32,
    content_sha256: String,
    updated_by: String,
    updated_source: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateProfileDoc {
    slug: String,
    title: String,
    content_md: String,
    source: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UpdateProfileDoc {
    expected_version: i32,
    title: Option<String>,
    content_md: Option<String>,
    source: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DeleteProfileDoc {
    expected_version: i32,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let client = state.pool.get().await.map_err(ApiError::database)?;
    let rows = client
        .query(
            "SELECT slug, title, version, content_sha256, updated_by, updated_source, \
                    created_at::text AS created_at, updated_at::text AS updated_at \
             FROM abei_ai.profile_docs WHERE user_id = $1 ORDER BY title, slug",
            &[&user_id],
        )
        .await
        .map_err(ApiError::database)?;
    let documents = rows
        .iter()
        .map(|row| {
            json!({
                "slug": row.get::<_, String>("slug"),
                "title": row.get::<_, String>("title"),
                "version": row.get::<_, i32>("version"),
                "content_sha256": row.get::<_, String>("content_sha256"),
                "updated_by": row.get::<_, String>("updated_by"),
                "updated_source": row.get::<_, String>("updated_source"),
                "created_at": row.get::<_, String>("created_at"),
                "updated_at": row.get::<_, String>("updated_at"),
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({ "data": documents })))
}

pub(crate) async fn get(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let slug = profile_slug(path)?;
    let document = load(&state, user_id, &slug).await?;
    Ok(Json(json!({ "data": document })))
}

pub(crate) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<CreateProfileDoc>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let actor = actor(&headers)?.name;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    validate_slug(&input.slug)?;
    let title = validate_title(&input.title)?;
    validate_content(&input.content_md)?;
    validate_source(&input.source)?;
    let hash = content_hash(&input.content_md);

    if gate.dry_run {
        return Ok((
            StatusCode::OK,
            Json(json!({
                "dry_run": true,
                "data": {
                    "slug": input.slug,
                    "title": title,
                    "version": 1,
                    "content_sha256": hash,
                    "content_bytes": input.content_md.len(),
                    "updated_by": actor,
                    "updated_source": input.source,
                }
            })),
        ));
    }
    gate.require_confirmation("profile-doc.create")?;

    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let sql = format!(
        "INSERT INTO abei_ai.profile_docs \
         (user_id, slug, title, content_md, version, content_sha256, updated_by, updated_source) \
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7) RETURNING {PROFILE_DOC_COLUMNS}"
    );
    let row = transaction
        .query_one(
            &sql,
            &[
                &user_id,
                &input.slug,
                &title,
                &input.content_md,
                &hash,
                &actor,
                &input.source,
            ],
        )
        .await
        .map_err(|error| {
            if is_unique_violation(&error) {
                ApiError::conflict(format!("profile-doc {} 已存在。", input.slug))
            } else {
                ApiError::database(error)
            }
        })?;
    let document = profile_doc_from_row(&row);
    insert_revision(&transaction, user_id, &document).await?;
    transaction.commit().await.map_err(ApiError::database)?;

    Ok((StatusCode::CREATED, Json(json!({ "data": document }))))
}

pub(crate) async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<UpdateProfileDoc>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let actor = actor(&headers)?.name;
    let slug = profile_slug(path)?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    if input.expected_version < 1 {
        return Err(ApiError::invalid_params("expected_version 必须是正整数。"));
    }
    if input.title.is_none() && input.content_md.is_none() {
        return Err(ApiError::invalid_params(
            "title 和 content_md 至少要提供一个。",
        ));
    }
    let requested_title = input.title.as_deref().map(validate_title).transpose()?;
    if let Some(content) = &input.content_md {
        validate_content(content)?;
    }
    validate_source(&input.source)?;

    if gate.dry_run {
        let current = load(&state, user_id, &slug).await?;
        ensure_version(&current, input.expected_version)?;
        let title = requested_title.unwrap_or_else(|| current.title.clone());
        let content = input.content_md.as_deref().unwrap_or(&current.content_md);
        let hash = content_hash(content);
        let no_op = title == current.title && content == current.content_md;
        return Ok(Json(json!({
            "dry_run": true,
            "data": {
                "slug": slug,
                "title": title,
                "from_version": current.version,
                "to_version": if no_op { current.version } else { current.version + 1 },
                "content_sha256": hash,
                "content_bytes": content.len(),
                "no_op": no_op,
                "updated_by": actor,
                "updated_source": input.source,
            }
        })));
    }
    gate.require_confirmation("profile-doc.update")?;

    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let sql = format!(
        "SELECT {PROFILE_DOC_COLUMNS} FROM abei_ai.profile_docs \
         WHERE user_id = $1 AND slug = $2 FOR UPDATE"
    );
    let row = transaction
        .query_opt(&sql, &[&user_id, &slug])
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found(format!("profile-doc {slug} 不存在。")))?;
    let current = profile_doc_from_row(&row);
    ensure_version(&current, input.expected_version)?;
    let title = requested_title.unwrap_or_else(|| current.title.clone());
    let content = input
        .content_md
        .unwrap_or_else(|| current.content_md.clone());

    if title == current.title && content == current.content_md {
        transaction.commit().await.map_err(ApiError::database)?;
        return Ok(Json(json!({ "data": current, "no_op": true })));
    }

    let hash = content_hash(&content);
    let sql = format!(
        "UPDATE abei_ai.profile_docs SET title = $3, content_md = $4, \
         version = version + 1, content_sha256 = $5, updated_by = $6, \
         updated_source = $7, updated_at = now() \
         WHERE user_id = $1 AND slug = $2 RETURNING {PROFILE_DOC_COLUMNS}"
    );
    let row = transaction
        .query_one(
            &sql,
            &[
                &user_id,
                &slug,
                &title,
                &content,
                &hash,
                &actor,
                &input.source,
            ],
        )
        .await
        .map_err(ApiError::database)?;
    let document = profile_doc_from_row(&row);
    insert_revision(&transaction, user_id, &document).await?;
    transaction.commit().await.map_err(ApiError::database)?;

    Ok(Json(json!({ "data": document, "no_op": false })))
}

pub(crate) async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<DeleteProfileDoc>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let slug = profile_slug(path)?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    if input.expected_version < 1 {
        return Err(ApiError::invalid_params("expected_version 必须是正整数。"));
    }

    if gate.dry_run {
        let current = load(&state, user_id, &slug).await?;
        ensure_version(&current, input.expected_version)?;
        let client = state.pool.get().await.map_err(ApiError::database)?;
        let revision_count: i64 = client
            .query_one(
                "SELECT count(*)::bigint FROM abei_ai.profile_doc_revisions \
                 WHERE user_id = $1 AND slug = $2",
                &[&user_id, &slug],
            )
            .await
            .map_err(ApiError::database)?
            .get(0);
        return Ok(Json(json!({
            "dry_run": true,
            "data": {
                "slug": current.slug,
                "title": current.title,
                "version": current.version,
                "revision_count": revision_count,
            }
        })));
    }
    gate.require_confirmation("profile-doc.delete")?;

    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let sql = format!(
        "SELECT {PROFILE_DOC_COLUMNS} FROM abei_ai.profile_docs \
         WHERE user_id = $1 AND slug = $2 FOR UPDATE"
    );
    let row = transaction
        .query_opt(&sql, &[&user_id, &slug])
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found(format!("profile-doc {slug} 不存在。")))?;
    let current = profile_doc_from_row(&row);
    ensure_version(&current, input.expected_version)?;
    let revision_count = transaction
        .execute(
            "DELETE FROM abei_ai.profile_doc_revisions WHERE user_id = $1 AND slug = $2",
            &[&user_id, &slug],
        )
        .await
        .map_err(ApiError::database)?;
    transaction
        .execute(
            "DELETE FROM abei_ai.profile_docs WHERE user_id = $1 AND slug = $2",
            &[&user_id, &slug],
        )
        .await
        .map_err(ApiError::database)?;
    transaction.commit().await.map_err(ApiError::database)?;

    Ok(Json(json!({
        "data": {
            "slug": current.slug,
            "title": current.title,
            "version": current.version,
            "revision_count": revision_count,
            "deleted": true,
        }
    })))
}

async fn load(state: &AppState, user_id: i64, slug: &str) -> Result<ProfileDoc, ApiError> {
    let client = state.pool.get().await.map_err(ApiError::database)?;
    let sql = format!(
        "SELECT {PROFILE_DOC_COLUMNS} FROM abei_ai.profile_docs \
         WHERE user_id = $1 AND slug = $2"
    );
    client
        .query_opt(&sql, &[&user_id, &slug])
        .await
        .map_err(ApiError::database)?
        .map(|row| profile_doc_from_row(&row))
        .ok_or_else(|| ApiError::not_found(format!("profile-doc {slug} 不存在。")))
}

async fn insert_revision(
    transaction: &tokio_postgres::Transaction<'_>,
    user_id: i64,
    document: &ProfileDoc,
) -> Result<(), ApiError> {
    transaction
        .execute(
            "INSERT INTO abei_ai.profile_doc_revisions \
             (user_id, slug, version, title, content_md, content_sha256, updated_by, updated_source) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            &[
                &user_id,
                &document.slug,
                &document.version,
                &document.title,
                &document.content_md,
                &document.content_sha256,
                &document.updated_by,
                &document.updated_source,
            ],
        )
        .await
        .map_err(ApiError::database)?;
    Ok(())
}

fn profile_doc_from_row(row: &Row) -> ProfileDoc {
    ProfileDoc {
        slug: row.get("slug"),
        title: row.get("title"),
        content_md: row.get("content_md"),
        version: row.get("version"),
        content_sha256: row.get("content_sha256"),
        updated_by: row.get("updated_by"),
        updated_source: row.get("updated_source"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn profile_slug(path: Result<Path<String>, PathRejection>) -> Result<String, ApiError> {
    let slug = path
        .map_err(|error| ApiError::invalid_params(format!("slug 不对：{error}")))?
        .0;
    validate_slug(&slug)?;
    Ok(slug)
}

fn validate_slug(slug: &str) -> Result<(), ApiError> {
    let mut bytes = slug.bytes();
    let valid = (1..=64).contains(&slug.len())
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err(ApiError::invalid_params(
            "slug 必须匹配 [a-z0-9][a-z0-9-]{0,63}。",
        ))
    }
}

fn validate_title(title: &str) -> Result<String, ApiError> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err(ApiError::invalid_params("title 不能为空，且最多 200 字。"));
    }
    Ok(title.to_owned())
}

fn validate_content(content: &str) -> Result<(), ApiError> {
    if content.len() > MAX_CONTENT_BYTES {
        return Err(ApiError::invalid_params("content_md 不能超过 1 MiB。"));
    }
    Ok(())
}

fn validate_source(source: &str) -> Result<(), ApiError> {
    if matches!(source, "cli" | "web") {
        Ok(())
    } else {
        Err(ApiError::invalid_params("source 只能是 cli 或 web。"))
    }
}

fn ensure_version(document: &ProfileDoc, expected: i32) -> Result<(), ApiError> {
    if document.version == expected {
        Ok(())
    } else {
        Err(ApiError::conflict(format!(
            "profile-doc {} 已是版本 {}，请求基于版本 {}。请重新读取后再修改。",
            document.slug, document.version, expected
        )))
    }
}

fn content_hash(content: &str) -> String {
    let mut hash = String::with_capacity(64);
    for byte in Sha256::digest(content.as_bytes()) {
        write!(hash, "{byte:02x}").expect("writing to String cannot fail");
    }
    hash
}

fn parse_gate(gate: Result<Query<WriteGate>, QueryRejection>) -> Result<WriteGate, ApiError> {
    gate.map(|Query(gate)| gate)
        .map_err(|error| ApiError::invalid_params(format!("查询参数不对：{error}")))
}

fn json_error(error: JsonRejection) -> ApiError {
    ApiError::invalid_params(format!("JSON 请求体不对：{}", error.body_text()))
}

fn is_unique_violation(error: &tokio_postgres::Error) -> bool {
    error
        .as_db_error()
        .is_some_and(|error| error.code() == &SqlState::UNIQUE_VIOLATION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_and_content_boundaries_are_enforced() {
        for valid in ["a", "personal-accounting-rules", "a1", &"a".repeat(64)] {
            validate_slug(valid).unwrap();
        }
        for invalid in ["", "-a", "A", "a_b", "a/b", &"a".repeat(65)] {
            assert!(validate_slug(invalid).is_err(), "{invalid}");
        }
        validate_content(&"x".repeat(MAX_CONTENT_BYTES)).unwrap();
        assert!(validate_content(&"x".repeat(MAX_CONTENT_BYTES + 1)).is_err());
    }

    #[test]
    fn content_hash_is_stable() {
        assert_eq!(
            content_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
