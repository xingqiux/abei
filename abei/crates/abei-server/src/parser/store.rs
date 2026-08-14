use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;
use std::sync::Arc;

use deadpool_postgres::Pool;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use tokio::sync::Semaphore;
use tokio_postgres::{Row, Transaction};

use super::definition;
use super::engine::{self, ParseContext};
use super::model::{Node, ParseOutput, ParserFlowDefinition};
use crate::ApiError;
use crate::mail;

const MAX_CONCURRENT_TESTS: usize = 2;

pub(super) async fn install_builtins(
    pool: &Pool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut client = pool.get().await?;
    for builtin in super::builtins::FLOWS {
        let definition = definition::parse_yaml(builtin.source)
            .map_err(|error| format!("内建解析流程 {} 无效：{error}", builtin.slug))?;
        let definition_json = serde_json::to_value(&definition)?;
        let scripts = script_sources(&definition);
        let checksum = definition::checksum(&definition)
            .map_err(|error| format!("内建解析流程 {} 无法计算 checksum：{error}", builtin.slug))?;
        let transaction = client.transaction().await?;
        transaction
            .query_one(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                &[&format!("abei-parser-builtin:{}", builtin.slug)],
            )
            .await?;
        let flow_id = match transaction
            .query_opt(
                "SELECT id FROM abei_ai.parser_flows
                 WHERE owner_user_id IS NULL AND slug = $1 FOR UPDATE",
                &[&builtin.slug],
            )
            .await?
        {
            Some(row) => row.get::<_, i64>(0),
            None => transaction
                .query_one(
                    "INSERT INTO abei_ai.parser_flows
                       (owner_user_id, name, slug, status, draft_definition,
                        draft_source_yaml, draft_script_sources)
                     VALUES (NULL,$1,$2,'draft',$3,$4,$5) RETURNING id",
                    &[
                        &builtin.name,
                        &builtin.slug,
                        &definition_json,
                        &builtin.source,
                        &scripts,
                    ],
                )
                .await?
                .get(0),
        };
        let version = match transaction
            .query_opt(
                "SELECT version FROM abei_ai.parser_flow_versions
                 WHERE flow_id = $1 AND checksum = $2",
                &[&flow_id, &checksum],
            )
            .await?
        {
            Some(row) => row.get::<_, i32>(0),
            None => {
                let version: i32 = transaction
                    .query_one(
                        "SELECT COALESCE(max(version), 0) + 1
                         FROM abei_ai.parser_flow_versions WHERE flow_id = $1",
                        &[&flow_id],
                    )
                    .await?
                    .get(0);
                transaction
                    .execute(
                        "INSERT INTO abei_ai.parser_flow_versions
                           (flow_id, version, definition, source_yaml, script_sources,
                            checksum, created_by)
                         VALUES ($1,$2,$3,$4,$5,$6,'abei-server')",
                        &[
                            &flow_id,
                            &version,
                            &definition_json,
                            &builtin.source,
                            &scripts,
                            &checksum,
                        ],
                    )
                    .await?;
                version
            }
        };
        transaction
            .execute(
                "UPDATE abei_ai.parser_flows SET name = $2, status = 'published',
                   current_version = $3, draft_definition = $4, draft_source_yaml = $5,
                   draft_script_sources = $6, updated_at = now()
                 WHERE id = $1 AND owner_user_id IS NULL",
                &[
                    &flow_id,
                    &builtin.name,
                    &version,
                    &definition_json,
                    &builtin.source,
                    &scripts,
                ],
            )
            .await?;
        transaction.commit().await?;
    }
    install_builtin_mail_rules(&mut client).await?;
    Ok(())
}

async fn install_builtin_mail_rules(
    client: &mut deadpool_postgres::Client,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    for builtin in super::builtins::MAIL_RULES {
        let conditions: crate::mail::rules::Condition = serde_json::from_str(builtin.conditions)?;
        conditions.validate()?;
        let row = client
            .query_one(
                "SELECT f.id, v.definition->>'channel_key'
                 FROM abei_ai.parser_flows f
                 JOIN abei_ai.parser_flow_versions v
                   ON v.flow_id = f.id AND v.version = f.current_version
                 WHERE f.owner_user_id IS NULL AND f.slug = $1 AND f.status = 'published'",
                &[&builtin.flow_slug],
            )
            .await?;
        let flow_id: i64 = row.get(0);
        let channel_key: String = row.get(1);
        let checksum = crate::mail::rules_checksum(builtin.conditions, &channel_key, Some(flow_id));
        client
            .execute(
                // FOR SHARE：这条语句是「先读一遍用户表，再按它插外键行」。不锁的话，读到的
                // 快照和语句末尾的外键检查之间有窗口，期间用户被删掉就会撞 mail_rules_user_id_fkey。
                "WITH users AS (
                   SELECT id AS user_id FROM public.users FOR SHARE
                 ), inserted AS (
                   INSERT INTO abei_ai.mail_rules
                     (user_id, name, enabled, position, current_version, draft_conditions,
                      draft_channel_key, draft_parser_flow_id, builtin_key)
                   SELECT user_id, $1, true, $2, 1, $3::text::jsonb, $4, $5, $6 FROM users
                   ON CONFLICT DO NOTHING
                   RETURNING id
                 )
                 INSERT INTO abei_ai.mail_rule_versions
                   (rule_id, version, conditions, channel_key, parser_flow_id, checksum, created_by)
                 SELECT id, 1, $3::text::jsonb, $4, $5, $7, 'abei-server:builtin'
                 FROM inserted",
                &[
                    &builtin.name,
                    &builtin.position,
                    &builtin.conditions,
                    &channel_key,
                    &flow_id,
                    &builtin.key,
                    &checksum,
                ],
            )
            .await?;
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) struct Service {
    pool: Pool,
    mail: mail::Service,
    permits: Arc<Semaphore>,
}

#[derive(Debug)]
struct FlowDraft {
    id: i64,
    name: String,
    source_yaml: String,
    definition: ParserFlowDefinition,
}

#[derive(Debug)]
struct GateCase {
    id: i64,
    name: String,
    message_id: i64,
    expected: Value,
}

impl Service {
    pub(crate) fn new(pool: Pool, mail: mail::Service) -> Self {
        Self {
            pool,
            mail,
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_TESTS)),
        }
    }

    pub(crate) fn validate_source(source_yaml: &str) -> Result<Value, ApiError> {
        let definition = definition::parse_yaml(source_yaml).map_err(ApiError::invalid_params)?;
        let normalized_yaml = definition::to_yaml(&definition).map_err(ApiError::invalid_params)?;
        let checksum = definition::checksum(&definition).map_err(ApiError::invalid_params)?;
        Ok(json!({
            "data": {
                "valid": true,
                "checksum": checksum,
                "definition": definition,
                "normalized_yaml": normalized_yaml,
            }
        }))
    }

    pub(crate) async fn published_definition(
        &self,
        user_id: i64,
        flow_id: i64,
        version: i32,
    ) -> Result<(ParserFlowDefinition, String), ApiError> {
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT v.definition, v.checksum
                 FROM abei_ai.parser_flow_versions v
                 JOIN abei_ai.parser_flows f ON f.id = v.flow_id
                 WHERE v.flow_id = $2 AND v.version = $3
                   AND (f.owner_user_id = $1 OR f.owner_user_id IS NULL)",
                &[&user_id, &flow_id, &version],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("已发布的解析流程版本不存在。"))?;
        let definition = serde_json::from_value(row.get::<_, Value>(0))
            .map_err(|error| ApiError::internal(format!("解析流程版本损坏：{error}")))?;
        definition::validate(&definition).map_err(ApiError::internal)?;
        Ok((definition, row.get(1)))
    }

    pub(crate) async fn list(&self, user_id: i64) -> Result<Value, ApiError> {
        let rows = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query(
                "SELECT f.id, f.owner_user_id, f.name, f.slug, f.status, f.current_version,
                        f.cloned_from_flow_id, f.updated_at::text,
                        v.checksum, v.created_at::text AS published_at,
                        v.definition->>'channel_key' AS channel_key
                 FROM abei_ai.parser_flows f
                 LEFT JOIN abei_ai.parser_flow_versions v
                   ON v.flow_id = f.id AND v.version = f.current_version
                 WHERE f.owner_user_id = $1 OR f.owner_user_id IS NULL
                 ORDER BY f.owner_user_id NULLS FIRST, f.updated_at DESC, f.id DESC",
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?;
        Ok(json!({
            "data": rows.iter().map(flow_summary_json).collect::<Vec<_>>()
        }))
    }

    pub(crate) async fn create(
        &self,
        user_id: i64,
        name: &str,
        slug: &str,
        source_yaml: &str,
    ) -> Result<Value, ApiError> {
        validate_name_slug(name, slug)?;
        let definition = definition::parse_yaml(source_yaml).map_err(ApiError::invalid_params)?;
        let definition_json = serde_json::to_value(&definition)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let scripts = script_sources(&definition);
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_one(
                "INSERT INTO abei_ai.parser_flows
                   (owner_user_id, name, slug, draft_definition, draft_source_yaml,
                    draft_script_sources)
                 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
                &[
                    &user_id,
                    &name.trim(),
                    &slug,
                    &definition_json,
                    &source_yaml,
                    &scripts,
                ],
            )
            .await
            .map_err(write_error)?;
        self.get(user_id, row.get(0)).await
    }

    pub(crate) async fn get(&self, user_id: i64, id: i64) -> Result<Value, ApiError> {
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let row = client
            .query_opt(
                "SELECT f.id, f.owner_user_id, f.name, f.slug, f.status, f.current_version,
                        f.draft_definition, f.draft_source_yaml, f.cloned_from_flow_id,
                        f.created_at::text, f.updated_at::text,
                        v.checksum, v.created_at::text AS published_at,
                        v.definition->>'channel_key' AS channel_key
                 FROM abei_ai.parser_flows f
                 LEFT JOIN abei_ai.parser_flow_versions v
                   ON v.flow_id = f.id AND v.version = f.current_version
                 WHERE f.id = $2 AND (f.owner_user_id = $1 OR f.owner_user_id IS NULL)",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("解析流程不存在。"))?;
        let cases = client
            .query(
                "SELECT c.id, c.name, c.mail_sample_id, c.expected, c.enabled,
                        c.created_at::text, c.updated_at::text, m.id AS mail_message_id,
                        m.subject, m.from_address
                 FROM abei_ai.parser_test_cases c
                 JOIN abei_ai.mail_samples s ON s.id = c.mail_sample_id
                 JOIN abei_ai.mail_messages m ON m.id = s.mail_message_id
                 WHERE c.flow_id = $1 AND c.owner_user_id = $2 ORDER BY c.id",
                &[&id, &user_id],
            )
            .await
            .map_err(ApiError::database)?;
        Ok(json!({
            "data": {
                "id": row.get::<_, i64>("id").to_string(),
                "type": "parser-flow",
                "attributes": {
                    "owner": if row.get::<_, Option<i64>>("owner_user_id").is_some() { "user" } else { "system" },
                    "name": row.get::<_, String>("name"),
                    "slug": row.get::<_, String>("slug"),
                    "status": row.get::<_, String>("status"),
                    "current_version": row.get::<_, Option<i32>>("current_version"),
                    "draft_definition": row.get::<_, Value>("draft_definition"),
                    "draft_source_yaml": row.get::<_, String>("draft_source_yaml"),
                    "cloned_from_flow_id": row.get::<_, Option<i64>>("cloned_from_flow_id").map(|value| value.to_string()),
                    "published_checksum": row.get::<_, Option<String>>("checksum"),
                    "channel_key": row.get::<_, Option<String>>("channel_key"),
                    "published_at": row.get::<_, Option<String>>("published_at"),
                    "created_at": row.get::<_, String>("created_at"),
                    "updated_at": row.get::<_, String>("updated_at"),
                    "test_cases": cases.iter().map(test_case_json).collect::<Vec<_>>(),
                }
            }
        }))
    }

    pub(crate) async fn update(
        &self,
        user_id: i64,
        id: i64,
        name: Option<&str>,
        source_yaml: Option<&str>,
    ) -> Result<Value, ApiError> {
        if name.is_none() && source_yaml.is_none() {
            return Err(ApiError::invalid_params("至少要更新 name 或 source_yaml。"));
        }
        if name.is_some_and(|value| value.trim().is_empty() || value.chars().count() > 120) {
            return Err(ApiError::invalid_params("name 必须是 1 到 120 个字符。"));
        }
        let current = self.load_owned_draft(user_id, id).await?;
        let source_yaml = source_yaml.unwrap_or(&current.source_yaml);
        let definition = definition::parse_yaml(source_yaml).map_err(ApiError::invalid_params)?;
        let definition_json = serde_json::to_value(&definition)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let scripts = script_sources(&definition);
        self.pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                "UPDATE abei_ai.parser_flows SET name = $3, draft_definition = $4,
                   draft_source_yaml = $5, draft_script_sources = $6, updated_at = now()
                 WHERE id = $2 AND owner_user_id = $1",
                &[
                    &user_id,
                    &id,
                    &name.unwrap_or(&current.name).trim(),
                    &definition_json,
                    &source_yaml,
                    &scripts,
                ],
            )
            .await
            .map_err(write_error)?;
        self.get(user_id, id).await
    }

    pub(crate) async fn clone_flow(
        &self,
        user_id: i64,
        source_id: i64,
        name: &str,
        slug: &str,
    ) -> Result<Value, ApiError> {
        validate_name_slug(name, slug)?;
        let source = self.load_visible_draft(user_id, source_id).await?;
        let definition_json = serde_json::to_value(&source.definition)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let scripts = script_sources(&source.definition);
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_one(
                "INSERT INTO abei_ai.parser_flows
                   (owner_user_id, name, slug, draft_definition, draft_source_yaml,
                    draft_script_sources, cloned_from_flow_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
                &[
                    &user_id,
                    &name.trim(),
                    &slug,
                    &definition_json,
                    &source.source_yaml,
                    &scripts,
                    &source_id,
                ],
            )
            .await
            .map_err(write_error)?;
        self.get(user_id, row.get(0)).await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn test(
        &self,
        user_id: i64,
        flow_id: i64,
        mail_message_id: Option<i64>,
        mail_sample_id: Option<i64>,
        source_yaml: Option<&str>,
        version: Option<i32>,
        timezone: &str,
        secrets: BTreeMap<String, String>,
    ) -> Result<Value, ApiError> {
        if mail_message_id.is_some() == mail_sample_id.is_some() {
            return Err(ApiError::invalid_params(
                "mail_message_id 和 mail_sample_id 必须且只能提供一个。",
            ));
        }
        if source_yaml.is_some() && version.is_some() {
            return Err(ApiError::invalid_params(
                "source_yaml 和 version 不能同时提供。",
            ));
        }
        let (definition, flow_version) = self
            .test_definition(user_id, flow_id, source_yaml, version)
            .await?;
        let message_id = match mail_message_id {
            Some(id) if id > 0 => id,
            Some(_) => return Err(ApiError::invalid_params("mail_message_id 必须是正整数。")),
            None => {
                self.sample_message_id(user_id, mail_sample_id.unwrap())
                    .await?
            }
        };
        self.run_and_record(
            user_id,
            flow_id,
            flow_version,
            message_id,
            None,
            &definition,
            timezone,
            secrets,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn test_eml(
        &self,
        user_id: i64,
        flow_id: i64,
        raw_eml: &[u8],
        source_yaml: Option<&str>,
        version: Option<i32>,
        timezone: &str,
        secrets: BTreeMap<String, String>,
    ) -> Result<Value, ApiError> {
        let (definition, flow_version) = self
            .test_definition(user_id, flow_id, source_yaml, version)
            .await?;
        self.run_raw_and_record(
            user_id,
            flow_id,
            flow_version,
            None,
            None,
            &definition,
            raw_eml,
            timezone,
            secrets,
        )
        .await
    }

    pub(crate) async fn test_source_eml(
        &self,
        source_yaml: &str,
        raw_eml: &[u8],
        timezone: &str,
        secrets: BTreeMap<String, String>,
    ) -> Result<Value, ApiError> {
        let definition = definition::parse_yaml(source_yaml).map_err(ApiError::invalid_params)?;
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| ApiError::internal("解析执行器已经关闭。"))?;
        let output = engine::execute(
            &definition,
            raw_eml,
            &ParseContext {
                timezone: timezone.to_owned(),
                secrets,
            },
        )
        .await
        .map_err(ApiError::invalid_params)?;
        Ok(json!({
            "data": {
                "run_id": Value::Null,
                "status": "succeeded",
                "output": output,
            }
        }))
    }

    pub(crate) async fn publish_preview(
        &self,
        user_id: i64,
        flow_id: i64,
    ) -> Result<Value, ApiError> {
        let flow = self.load_owned_draft(user_id, flow_id).await?;
        let cases = self.gate_cases(user_id, flow_id).await?;
        let (results, outputs) = self.run_gate_cases(user_id, &flow, &cases).await?;
        let comparison = self
            .compare_with_published(user_id, flow_id, &cases, &outputs)
            .await?;
        let checksum = definition::checksum(&flow.definition).map_err(ApiError::invalid_params)?;
        Ok(json!({
            "dry_run": true,
            "data": {
                "flow_id": flow_id.to_string(),
                "checksum": checksum,
                "test_cases": results,
                "comparison": comparison,
                "ready": true,
            }
        }))
    }

    pub(crate) async fn publish(
        &self,
        user_id: i64,
        flow_id: i64,
        actor: &str,
    ) -> Result<Value, ApiError> {
        let flow = self.load_owned_draft(user_id, flow_id).await?;
        let cases = self.gate_cases(user_id, flow_id).await?;
        self.run_gate_cases(user_id, &flow, &cases).await?;
        let checksum = definition::checksum(&flow.definition).map_err(ApiError::invalid_params)?;
        let definition_json = serde_json::to_value(&flow.definition)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let scripts = script_sources(&flow.definition);
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        assert_owned_locked(&transaction, user_id, flow_id).await?;
        let existing = transaction
            .query_opt(
                "SELECT version FROM abei_ai.parser_flow_versions
                 WHERE flow_id = $1 AND checksum = $2",
                &[&flow_id, &checksum],
            )
            .await
            .map_err(ApiError::database)?;
        let version = if let Some(row) = existing {
            row.get::<_, i32>(0)
        } else {
            let version: i32 = transaction
                .query_one(
                    "SELECT COALESCE(max(version), 0) + 1
                     FROM abei_ai.parser_flow_versions WHERE flow_id = $1",
                    &[&flow_id],
                )
                .await
                .map_err(ApiError::database)?
                .get(0);
            transaction
                .execute(
                    "INSERT INTO abei_ai.parser_flow_versions
                       (flow_id, version, definition, source_yaml, script_sources,
                        checksum, created_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)",
                    &[
                        &flow_id,
                        &version,
                        &definition_json,
                        &flow.source_yaml,
                        &scripts,
                        &checksum,
                        &actor,
                    ],
                )
                .await
                .map_err(ApiError::database)?;
            version
        };
        transaction
            .execute(
                "UPDATE abei_ai.parser_flows SET status = 'published', current_version = $3,
                   updated_at = now() WHERE owner_user_id = $1 AND id = $2",
                &[&user_id, &flow_id, &version],
            )
            .await
            .map_err(ApiError::database)?;
        transaction.commit().await.map_err(ApiError::database)?;
        self.get(user_id, flow_id).await
    }

    pub(crate) async fn rollback(
        &self,
        user_id: i64,
        flow_id: i64,
        target_version: i32,
    ) -> Result<Value, ApiError> {
        if target_version < 1 {
            return Err(ApiError::invalid_params("target_version 必须是正整数。"));
        }
        self.load_owned_draft(user_id, flow_id).await?;
        let (definition, source_yaml) = self.load_version(user_id, flow_id, target_version).await?;
        let definition_json = serde_json::to_value(&definition)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let scripts = script_sources(&definition);
        self.pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                "UPDATE abei_ai.parser_flows SET status = 'published', current_version = $3,
                   draft_definition = $4, draft_source_yaml = $5,
                   draft_script_sources = $6, updated_at = now()
                 WHERE owner_user_id = $1 AND id = $2",
                &[
                    &user_id,
                    &flow_id,
                    &target_version,
                    &definition_json,
                    &source_yaml,
                    &scripts,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        self.get(user_id, flow_id).await
    }

    pub(crate) async fn retire(&self, user_id: i64, flow_id: i64) -> Result<Value, ApiError> {
        let changed = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                "UPDATE abei_ai.parser_flows SET status = 'retired', updated_at = now()
                 WHERE owner_user_id = $1 AND id = $2",
                &[&user_id, &flow_id],
            )
            .await
            .map_err(ApiError::database)?;
        if changed == 0 {
            return Err(ApiError::not_found("解析流程不存在。"));
        }
        self.get(user_id, flow_id).await
    }

    pub(crate) async fn versions(&self, user_id: i64, flow_id: i64) -> Result<Value, ApiError> {
        self.load_visible_draft(user_id, flow_id).await?;
        let rows = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query(
                "SELECT version, checksum, created_by, created_at::text
                 FROM abei_ai.parser_flow_versions WHERE flow_id = $1 ORDER BY version DESC",
                &[&flow_id],
            )
            .await
            .map_err(ApiError::database)?;
        Ok(json!({
            "data": rows.iter().map(|row| json!({
                "version": row.get::<_, i32>("version"),
                "checksum": row.get::<_, String>("checksum"),
                "created_by": row.get::<_, String>("created_by"),
                "created_at": row.get::<_, String>("created_at"),
            })).collect::<Vec<_>>()
        }))
    }

    pub(crate) async fn version(
        &self,
        user_id: i64,
        flow_id: i64,
        version: i32,
    ) -> Result<Value, ApiError> {
        self.load_visible_draft(user_id, flow_id).await?;
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let row = client
            .query_opt(
                "SELECT version, definition, source_yaml, checksum, created_by, created_at::text
                 FROM abei_ai.parser_flow_versions WHERE flow_id = $1 AND version = $2",
                &[&flow_id, &version],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("解析流程版本不存在。"))?;
        let definition = row.get::<_, Value>("definition");
        let previous = client
            .query_opt(
                "SELECT version, definition FROM abei_ai.parser_flow_versions
                 WHERE flow_id = $1 AND version < $2 ORDER BY version DESC LIMIT 1",
                &[&flow_id, &version],
            )
            .await
            .map_err(ApiError::database)?;
        let mut changes = Vec::new();
        if let Some(previous) = &previous {
            json_diff(
                "",
                &previous.get::<_, Value>("definition"),
                &definition,
                &mut changes,
            );
        }
        let truncated = changes.len() > 500;
        changes.truncate(500);
        Ok(json!({
            "data": {
                "flow_id": flow_id.to_string(),
                "version": row.get::<_, i32>("version"),
                "definition": definition,
                "source_yaml": row.get::<_, String>("source_yaml"),
                "checksum": row.get::<_, String>("checksum"),
                "created_by": row.get::<_, String>("created_by"),
                "created_at": row.get::<_, String>("created_at"),
                "compared_to_version": previous.as_ref().map(|row| row.get::<_, i32>("version")),
                "diff_from_previous": changes,
                "diff_truncated": truncated,
            }
        }))
    }

    pub(crate) async fn create_test_case(
        &self,
        user_id: i64,
        flow_id: i64,
        name: &str,
        mail_sample_id: i64,
        expected: Value,
        enabled: bool,
    ) -> Result<Value, ApiError> {
        validate_test_case(name, mail_sample_id, &expected)?;
        self.load_owned_draft(user_id, flow_id).await?;
        self.sample_message_id(user_id, mail_sample_id).await?;
        let id: i64 = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_one(
                "INSERT INTO abei_ai.parser_test_cases
                   (flow_id, owner_user_id, name, mail_sample_id, expected, enabled)
                 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
                &[
                    &flow_id,
                    &user_id,
                    &name.trim(),
                    &mail_sample_id,
                    &expected,
                    &enabled,
                ],
            )
            .await
            .map_err(write_error)?
            .get(0);
        self.test_case(user_id, id).await
    }

    pub(crate) async fn update_test_case(
        &self,
        user_id: i64,
        case_id: i64,
        name: &str,
        mail_sample_id: i64,
        expected: Value,
        enabled: bool,
    ) -> Result<Value, ApiError> {
        validate_test_case(name, mail_sample_id, &expected)?;
        self.sample_message_id(user_id, mail_sample_id).await?;
        let changed = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                "UPDATE abei_ai.parser_test_cases SET name = $3, mail_sample_id = $4,
                   expected = $5, enabled = $6, updated_at = now()
                 WHERE owner_user_id = $1 AND id = $2",
                &[
                    &user_id,
                    &case_id,
                    &name.trim(),
                    &mail_sample_id,
                    &expected,
                    &enabled,
                ],
            )
            .await
            .map_err(write_error)?;
        if changed == 0 {
            return Err(ApiError::not_found("解析测试用例不存在。"));
        }
        self.test_case(user_id, case_id).await
    }

    pub(crate) async fn delete_test_case(
        &self,
        user_id: i64,
        case_id: i64,
    ) -> Result<(), ApiError> {
        let changed = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                "DELETE FROM abei_ai.parser_test_cases WHERE owner_user_id = $1 AND id = $2",
                &[&user_id, &case_id],
            )
            .await
            .map_err(ApiError::database)?;
        if changed == 0 {
            Err(ApiError::not_found("解析测试用例不存在。"))
        } else {
            Ok(())
        }
    }

    pub(crate) async fn test_run(&self, user_id: i64, run_id: i64) -> Result<Value, ApiError> {
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT id, flow_id, flow_version, parser_test_case_id, mail_message_id,
                        status, duration_ms, result_summary, node_results, error_summary,
                        started_at::text, finished_at::text
                 FROM abei_ai.parser_test_runs WHERE owner_user_id = $1 AND id = $2",
                &[&user_id, &run_id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("解析测试运行不存在。"))?;
        Ok(json!({ "data": test_run_json(&row) }))
    }

    async fn test_case(&self, user_id: i64, case_id: i64) -> Result<Value, ApiError> {
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT c.id, c.name, c.mail_sample_id, c.expected, c.enabled,
                        c.created_at::text, c.updated_at::text, m.id AS mail_message_id,
                        m.subject, m.from_address
                 FROM abei_ai.parser_test_cases c
                 JOIN abei_ai.mail_samples s ON s.id = c.mail_sample_id
                 JOIN abei_ai.mail_messages m ON m.id = s.mail_message_id
                 WHERE c.owner_user_id = $1 AND c.id = $2",
                &[&user_id, &case_id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("解析测试用例不存在。"))?;
        Ok(json!({ "data": test_case_json(&row) }))
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_and_record(
        &self,
        user_id: i64,
        flow_id: i64,
        flow_version: Option<i32>,
        message_id: i64,
        case_id: Option<i64>,
        definition: &ParserFlowDefinition,
        timezone: &str,
        secrets: BTreeMap<String, String>,
    ) -> Result<Value, ApiError> {
        let raw = self.mail.raw_message(user_id, message_id).await?;
        self.run_raw_and_record(
            user_id,
            flow_id,
            flow_version,
            Some(message_id),
            case_id,
            definition,
            &raw,
            timezone,
            secrets,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_raw_and_record(
        &self,
        user_id: i64,
        flow_id: i64,
        flow_version: Option<i32>,
        message_id: Option<i64>,
        case_id: Option<i64>,
        definition: &ParserFlowDefinition,
        raw: &[u8],
        timezone: &str,
        secrets: BTreeMap<String, String>,
    ) -> Result<Value, ApiError> {
        let run_id: i64 = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_one(
                "INSERT INTO abei_ai.parser_test_runs
                   (flow_id, flow_version, owner_user_id, parser_test_case_id,
                    mail_message_id, status)
                 VALUES ($1,$2,$3,$4,$5,'running') RETURNING id",
                &[&flow_id, &flow_version, &user_id, &case_id, &message_id],
            )
            .await
            .map_err(ApiError::database)?
            .get(0);
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| ApiError::internal("解析执行器已经关闭。"))?;
        let result = engine::execute(
            definition,
            raw,
            &ParseContext {
                timezone: timezone.to_owned(),
                secrets,
            },
        )
        .await;
        match result {
            Ok(output) => {
                self.finish_run(run_id, &output).await?;
                Ok(json!({
                    "data": {
                        "run_id": run_id.to_string(),
                        "status": "succeeded",
                        "output": output,
                    }
                }))
            }
            Err(error) => {
                self.fail_run(run_id, &error).await?;
                Err(ApiError::invalid_params(error))
            }
        }
    }

    async fn test_definition(
        &self,
        user_id: i64,
        flow_id: i64,
        source_yaml: Option<&str>,
        version: Option<i32>,
    ) -> Result<(ParserFlowDefinition, Option<i32>), ApiError> {
        match (source_yaml, version) {
            (Some(source), None) => Ok((
                definition::parse_yaml(source).map_err(ApiError::invalid_params)?,
                None,
            )),
            (None, Some(version)) if version > 0 => Ok((
                self.load_version(user_id, flow_id, version).await?.0,
                Some(version),
            )),
            (None, Some(_)) => Err(ApiError::invalid_params("version 必须是正整数。")),
            (None, None) => Ok((
                self.load_visible_draft(user_id, flow_id).await?.definition,
                None,
            )),
            (Some(_), Some(_)) => Err(ApiError::invalid_params(
                "source_yaml 和 version 不能同时提供。",
            )),
        }
    }

    async fn finish_run(&self, run_id: i64, output: &ParseOutput) -> Result<(), ApiError> {
        let summary = json!({
            "document": output.document,
            "metrics": output.metrics,
            "warnings": output.warnings,
            "valid_rows_preview": output.valid_rows.iter().take(20).collect::<Vec<_>>(),
            "invalid_rows_preview": output.invalid_rows.iter().take(20).collect::<Vec<_>>(),
        });
        let nodes = serde_json::to_value(&output.node_results)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        self.pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                "UPDATE abei_ai.parser_test_runs SET status = 'succeeded',
                   duration_ms = $2, result_summary = $3, node_results = $4,
                   finished_at = now() WHERE id = $1",
                &[
                    &run_id,
                    &(output.metrics.duration_ms as i32),
                    &summary,
                    &nodes,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        Ok(())
    }

    async fn fail_run(&self, run_id: i64, error: &str) -> Result<(), ApiError> {
        self.pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                "UPDATE abei_ai.parser_test_runs SET status = 'failed', error_summary = $2,
                   finished_at = now() WHERE id = $1",
                &[&run_id, &truncate(error, 4_000)],
            )
            .await
            .map_err(ApiError::database)?;
        Ok(())
    }

    async fn run_gate_cases(
        &self,
        user_id: i64,
        flow: &FlowDraft,
        cases: &[GateCase],
    ) -> Result<(Vec<Value>, Vec<ParseOutput>), ApiError> {
        if cases.is_empty() {
            return Err(ApiError::conflict(
                "发布前至少需要一个已启用的邮件样本测试。",
            ));
        }
        let mut results = Vec::new();
        let mut outputs = Vec::new();
        for case in cases {
            let raw = self.mail.raw_message(user_id, case.message_id).await?;
            let _permit = self
                .permits
                .acquire()
                .await
                .map_err(|_| ApiError::internal("解析执行器已经关闭。"))?;
            let output = engine::execute(
                &flow.definition,
                &raw,
                &ParseContext {
                    timezone: "UTC".to_owned(),
                    secrets: BTreeMap::new(),
                },
            )
            .await
            .map_err(|error| {
                ApiError::conflict(format!("测试用例「{}」执行失败：{error}", case.name))
            })?;
            let assertions = assert_expected(&case.expected, &output).map_err(|error| {
                ApiError::conflict(format!("测试用例「{}」没有通过：{error}", case.name))
            })?;
            self.record_gate_success(user_id, flow.id, case, &output)
                .await?;
            results.push(json!({
                "id": case.id.to_string(),
                "name": case.name,
                "status": "succeeded",
                "assertions": assertions,
                "metrics": output.metrics,
            }));
            outputs.push(output);
        }
        Ok((results, outputs))
    }

    async fn compare_with_published(
        &self,
        user_id: i64,
        flow_id: i64,
        cases: &[GateCase],
        draft_outputs: &[ParseOutput],
    ) -> Result<Value, ApiError> {
        let current_version = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_one(
                "SELECT current_version FROM abei_ai.parser_flows
                 WHERE owner_user_id = $1 AND id = $2",
                &[&user_id, &flow_id],
            )
            .await
            .map_err(ApiError::database)?
            .get::<_, Option<i32>>(0);
        let Some(current_version) = current_version else {
            return Ok(json!({
                "baseline_version": Value::Null,
                "breaking": false,
                "changes": [],
            }));
        };
        let baseline = self
            .load_version(user_id, flow_id, current_version)
            .await?
            .0;
        let mut changes = Vec::new();
        for (case, draft) in cases.iter().zip(draft_outputs) {
            let raw = self.mail.raw_message(user_id, case.message_id).await?;
            let _permit = self
                .permits
                .acquire()
                .await
                .map_err(|_| ApiError::internal("解析执行器已经关闭。"))?;
            let previous = engine::execute(
                &baseline,
                &raw,
                &ParseContext {
                    timezone: "UTC".to_owned(),
                    secrets: BTreeMap::new(),
                },
            )
            .await
            .map_err(|error| {
                ApiError::conflict(format!(
                    "当前发布版本在测试用例「{}」上无法重放：{error}",
                    case.name
                ))
            })?;
            changes.extend(output_breaking_changes(case, &previous, draft)?);
        }
        Ok(json!({
            "baseline_version": current_version,
            "breaking": !changes.is_empty(),
            "changes": changes,
        }))
    }

    async fn record_gate_success(
        &self,
        user_id: i64,
        flow_id: i64,
        case: &GateCase,
        output: &ParseOutput,
    ) -> Result<(), ApiError> {
        let summary = json!({ "metrics": output.metrics, "gate": true });
        let nodes = serde_json::to_value(&output.node_results)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        self.pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                "INSERT INTO abei_ai.parser_test_runs
                   (flow_id, owner_user_id, parser_test_case_id, mail_message_id, status,
                    duration_ms, result_summary, node_results, finished_at)
                 VALUES ($1,$2,$3,$4,'succeeded',$5,$6,$7,now())",
                &[
                    &flow_id,
                    &user_id,
                    &case.id,
                    &case.message_id,
                    &(output.metrics.duration_ms as i32),
                    &summary,
                    &nodes,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        Ok(())
    }

    async fn gate_cases(&self, user_id: i64, flow_id: i64) -> Result<Vec<GateCase>, ApiError> {
        let rows = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query(
                "SELECT c.id, c.name, s.mail_message_id, c.expected
                 FROM abei_ai.parser_test_cases c
                 JOIN abei_ai.mail_samples s ON s.id = c.mail_sample_id
                 WHERE c.owner_user_id = $1 AND c.flow_id = $2 AND c.enabled = true
                 ORDER BY c.id",
                &[&user_id, &flow_id],
            )
            .await
            .map_err(ApiError::database)?;
        Ok(rows
            .iter()
            .map(|row| GateCase {
                id: row.get("id"),
                name: row.get("name"),
                message_id: row.get("mail_message_id"),
                expected: row.get("expected"),
            })
            .collect())
    }

    async fn sample_message_id(&self, user_id: i64, sample_id: i64) -> Result<i64, ApiError> {
        if sample_id <= 0 {
            return Err(ApiError::invalid_params("mail_sample_id 必须是正整数。"));
        }
        self.pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT mail_message_id FROM abei_ai.mail_samples WHERE user_id = $1 AND id = $2",
                &[&user_id, &sample_id],
            )
            .await
            .map_err(ApiError::database)?
            .map(|row| row.get(0))
            .ok_or_else(|| ApiError::not_found("邮件样本不存在。"))
    }

    async fn load_owned_draft(&self, user_id: i64, id: i64) -> Result<FlowDraft, ApiError> {
        self.load_draft(user_id, id, false).await
    }

    async fn load_visible_draft(&self, user_id: i64, id: i64) -> Result<FlowDraft, ApiError> {
        self.load_draft(user_id, id, true).await
    }

    async fn load_draft(
        &self,
        user_id: i64,
        id: i64,
        include_system: bool,
    ) -> Result<FlowDraft, ApiError> {
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT id, name, draft_definition, draft_source_yaml
                 FROM abei_ai.parser_flows
                 WHERE id = $2 AND (owner_user_id = $1 OR ($3 AND owner_user_id IS NULL))",
                &[&user_id, &id, &include_system],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("解析流程不存在。"))?;
        let definition = serde_json::from_value(row.get::<_, Value>("draft_definition"))
            .map_err(|error| ApiError::internal(format!("解析流程定义损坏：{error}")))?;
        Ok(FlowDraft {
            id: row.get("id"),
            name: row.get("name"),
            source_yaml: row.get("draft_source_yaml"),
            definition,
        })
    }

    async fn load_version(
        &self,
        user_id: i64,
        flow_id: i64,
        version: i32,
    ) -> Result<(ParserFlowDefinition, String), ApiError> {
        self.load_visible_draft(user_id, flow_id).await?;
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT definition, source_yaml FROM abei_ai.parser_flow_versions
                 WHERE flow_id = $1 AND version = $2",
                &[&flow_id, &version],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("解析流程版本不存在。"))?;
        let definition = serde_json::from_value(row.get::<_, Value>("definition"))
            .map_err(|error| ApiError::internal(format!("解析流程版本损坏：{error}")))?;
        Ok((definition, row.get("source_yaml")))
    }
}

async fn assert_owned_locked(
    transaction: &Transaction<'_>,
    user_id: i64,
    flow_id: i64,
) -> Result<(), ApiError> {
    transaction
        .query_opt(
            "SELECT id FROM abei_ai.parser_flows
             WHERE owner_user_id = $1 AND id = $2 FOR UPDATE",
            &[&user_id, &flow_id],
        )
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found("解析流程不存在。"))?;
    Ok(())
}

fn validate_name_slug(name: &str, slug: &str) -> Result<(), ApiError> {
    if name.trim().is_empty() || name.chars().count() > 120 {
        return Err(ApiError::invalid_params("name 必须是 1 到 120 个字符。"));
    }
    if slug.is_empty()
        || slug.len() > 80
        || !slug.bytes().enumerate().all(|(index, byte)| {
            (byte.is_ascii_lowercase() || byte.is_ascii_digit())
                || (index > 0 && matches!(byte, b'-' | b'_'))
        })
    {
        return Err(ApiError::invalid_params(
            "slug 必须以小写字母或数字开头，只能包含小写字母、数字、中划线和下划线。",
        ));
    }
    Ok(())
}

fn validate_test_case(name: &str, sample_id: i64, expected: &Value) -> Result<(), ApiError> {
    if name.trim().is_empty() || name.chars().count() > 120 {
        return Err(ApiError::invalid_params("name 必须是 1 到 120 个字符。"));
    }
    if sample_id <= 0 {
        return Err(ApiError::invalid_params("mail_sample_id 必须是正整数。"));
    }
    let object = expected
        .as_object()
        .ok_or_else(|| ApiError::invalid_params("expected 必须是 JSON 对象。"))?;
    let allowed = [
        "valid_rows",
        "invalid_rows",
        "warnings",
        "amount_total",
        "rows",
    ];
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(ApiError::invalid_params(format!(
            "expected 不支持字段 {key}。"
        )));
    }
    Ok(())
}

fn output_breaking_changes(
    case: &GateCase,
    previous: &ParseOutput,
    draft: &ParseOutput,
) -> Result<Vec<Value>, ApiError> {
    let mut changes = Vec::new();
    if draft.valid_rows.len() < previous.valid_rows.len() {
        changes.push(json!({
            "case_id": case.id.to_string(),
            "case_name": case.name,
            "code": "valid_rows_decreased",
            "before": previous.valid_rows.len(),
            "after": draft.valid_rows.len(),
        }));
    }

    let before_totals = amount_totals(previous)?;
    let after_totals = amount_totals(draft)?;
    for currency in before_totals
        .keys()
        .chain(after_totals.keys())
        .collect::<BTreeSet<_>>()
    {
        let before = before_totals
            .get(currency)
            .copied()
            .unwrap_or(Decimal::ZERO);
        let after = after_totals.get(currency).copied().unwrap_or(Decimal::ZERO);
        if before != after {
            changes.push(json!({
                "case_id": case.id.to_string(),
                "case_name": case.name,
                "code": "amount_total_changed",
                "currency_code": currency,
                "before": before.to_string(),
                "after": after.to_string(),
            }));
        }
    }

    let draft_rows = draft
        .valid_rows
        .iter()
        .enumerate()
        .map(|(index, row)| (row_identity(row, index), row))
        .collect::<BTreeMap<_, _>>();
    for (index, previous_row) in previous.valid_rows.iter().enumerate() {
        let identity = row_identity(previous_row, index);
        let Some(draft_row) = draft_rows.get(&identity) else {
            continue;
        };
        let before = serde_json::to_value(previous_row)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let after = serde_json::to_value(draft_row)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        for field in [
            "occurred_at",
            "signed_amount",
            "currency_code",
            "description",
            "counterparty",
            "account_hint",
            "payment_method",
            "provider_transaction_id",
            "merchant_order_id",
        ] {
            let before_value = before.get(field).unwrap_or(&Value::Null);
            let after_value = after.get(field).unwrap_or(&Value::Null);
            if value_present(before_value) && !value_present(after_value) {
                changes.push(json!({
                    "case_id": case.id.to_string(),
                    "case_name": case.name,
                    "code": "field_became_empty",
                    "row": identity,
                    "field": field,
                    "before": before_value,
                    "after": after_value,
                }));
            }
        }
    }
    Ok(changes)
}

fn amount_totals(output: &ParseOutput) -> Result<BTreeMap<String, Decimal>, ApiError> {
    let mut totals = BTreeMap::new();
    for row in &output.valid_rows {
        let amount = Decimal::from_str(&row.signed_amount).map_err(|_| {
            ApiError::internal(format!("解析输出金额 {} 无法汇总。", row.signed_amount))
        })?;
        *totals
            .entry(row.currency_code.clone())
            .or_insert(Decimal::ZERO) += amount;
    }
    Ok(totals)
}

fn row_identity(row: &super::model::BillRowDraft, index: usize) -> String {
    row.provider_transaction_id
        .as_ref()
        .map(|value| format!("provider:{value}"))
        .or_else(|| {
            row.merchant_order_id
                .as_ref()
                .map(|value| format!("merchant:{value}"))
        })
        .unwrap_or_else(|| format!("row:{}", index + 1))
}

fn value_present(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(value) => !value.trim().is_empty(),
        _ => true,
    }
}

fn json_diff(path: &str, before: &Value, after: &Value, changes: &mut Vec<Value>) {
    if before == after {
        return;
    }
    match (before, after) {
        (Value::Object(before), Value::Object(after)) => {
            for key in before.keys().chain(after.keys()).collect::<BTreeSet<_>>() {
                let child = format!("{}/{}", path, json_pointer_segment(key));
                match (before.get(key), after.get(key)) {
                    (Some(before), Some(after)) => json_diff(&child, before, after, changes),
                    (Some(before), None) => {
                        push_json_change(changes, &child, "removed", Some(before), None)
                    }
                    (None, Some(after)) => {
                        push_json_change(changes, &child, "added", None, Some(after))
                    }
                    (None, None) => {}
                }
            }
        }
        (Value::Array(before), Value::Array(after)) => {
            if let (Some(before), Some(after)) = (array_by_id(before), array_by_id(after)) {
                for key in before.keys().chain(after.keys()).collect::<BTreeSet<_>>() {
                    let child = format!("{}/{}", path, json_pointer_segment(key));
                    match (before.get(key), after.get(key)) {
                        (Some(before), Some(after)) => json_diff(&child, before, after, changes),
                        (Some(before), None) => {
                            push_json_change(changes, &child, "removed", Some(before), None)
                        }
                        (None, Some(after)) => {
                            push_json_change(changes, &child, "added", None, Some(after))
                        }
                        (None, None) => {}
                    }
                }
            } else {
                for index in 0..before.len().max(after.len()) {
                    let child = format!("{path}/{index}");
                    match (before.get(index), after.get(index)) {
                        (Some(before), Some(after)) => json_diff(&child, before, after, changes),
                        (Some(before), None) => {
                            push_json_change(changes, &child, "removed", Some(before), None)
                        }
                        (None, Some(after)) => {
                            push_json_change(changes, &child, "added", None, Some(after))
                        }
                        (None, None) => {}
                    }
                }
            }
        }
        _ => push_json_change(changes, path, "changed", Some(before), Some(after)),
    }
}

fn array_by_id(values: &[Value]) -> Option<BTreeMap<&str, &Value>> {
    if values.is_empty() {
        return None;
    }
    values
        .iter()
        .map(|value| Some((value.get("id")?.as_str()?, value)))
        .collect()
}

fn push_json_change(
    changes: &mut Vec<Value>,
    path: &str,
    kind: &str,
    before: Option<&Value>,
    after: Option<&Value>,
) {
    changes.push(json!({
        "path": if path.is_empty() { "/" } else { path },
        "kind": kind,
        "before": before.map(compact_diff_value),
        "after": after.map(compact_diff_value),
    }));
}

fn compact_diff_value(value: &Value) -> Value {
    let encoded = value.to_string();
    if encoded.chars().count() <= 1_000 {
        value.clone()
    } else {
        Value::String(format!(
            "{}…",
            encoded.chars().take(1_000).collect::<String>()
        ))
    }
}

fn json_pointer_segment(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn assert_expected(expected: &Value, output: &ParseOutput) -> Result<Vec<Value>, String> {
    let expected = expected
        .as_object()
        .ok_or_else(|| "expected 必须是对象。".to_owned())?;
    let mut assertions = Vec::new();
    assert_count(
        expected,
        "valid_rows",
        output.valid_rows.len(),
        &mut assertions,
    )?;
    assert_count(
        expected,
        "invalid_rows",
        output.invalid_rows.len(),
        &mut assertions,
    )?;
    assert_count(expected, "warnings", output.warnings.len(), &mut assertions)?;
    if let Some(value) = expected.get("amount_total") {
        let expected = decimal_value(value, "amount_total")?;
        let actual = output
            .valid_rows
            .iter()
            .try_fold(Decimal::ZERO, |sum, row| {
                Decimal::from_str(&row.signed_amount)
                    .map(|amount| sum + amount)
                    .map_err(|_| format!("输出金额 {} 无法汇总。", row.signed_amount))
            })?;
        if expected != actual {
            return Err(format!("金额合计期望 {expected}，实际 {actual}。"));
        }
        assertions.push(json!({ "field": "amount_total", "actual": actual.to_string() }));
    }
    if let Some(rows) = expected.get("rows") {
        let rows = rows
            .as_array()
            .ok_or_else(|| "expected.rows 必须是数组。".to_owned())?;
        for (index, expected_row) in rows.iter().enumerate() {
            let actual = output
                .valid_rows
                .get(index)
                .ok_or_else(|| format!("缺少第 {} 条输出。", index + 1))?;
            let actual = serde_json::to_value(actual).map_err(|error| error.to_string())?;
            let expected_row = expected_row
                .as_object()
                .ok_or_else(|| format!("expected.rows[{}] 必须是对象。", index))?;
            for (field, expected_value) in expected_row {
                if actual.get(field) != Some(expected_value) {
                    return Err(format!(
                        "第 {} 条的 {field} 期望 {expected_value}，实际 {}。",
                        index + 1,
                        actual.get(field).unwrap_or(&Value::Null)
                    ));
                }
            }
        }
        assertions.push(json!({ "field": "rows", "checked": rows.len() }));
    }
    Ok(assertions)
}

fn assert_count(
    expected: &serde_json::Map<String, Value>,
    name: &str,
    actual: usize,
    assertions: &mut Vec<Value>,
) -> Result<(), String> {
    let Some(value) = expected.get(name) else {
        return Ok(());
    };
    let count = value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| format!("expected.{name} 必须是非负整数。"))?;
    if count != actual {
        return Err(format!("{name} 期望 {count}，实际 {actual}。"));
    }
    assertions.push(json!({ "field": name, "actual": actual }));
    Ok(())
}

fn decimal_value(value: &Value, name: &str) -> Result<Decimal, String> {
    let value = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_f64().map(|value| value.to_string()))
        .ok_or_else(|| format!("expected.{name} 必须是金额字符串或数字。"))?;
    Decimal::from_str(&value).map_err(|_| format!("expected.{name} 不是有效金额。"))
}

fn script_sources(definition: &ParserFlowDefinition) -> Value {
    Value::Object(
        definition
            .nodes
            .iter()
            .filter_map(|node| match &node.operation {
                Node::TransformScript { source } => Some((node.id.clone(), json!(source))),
                _ => None,
            })
            .collect(),
    )
}

fn flow_summary_json(row: &Row) -> Value {
    json!({
        "id": row.get::<_, i64>("id").to_string(),
        "type": "parser-flow",
        "attributes": {
            "owner": if row.get::<_, Option<i64>>("owner_user_id").is_some() { "user" } else { "system" },
            "name": row.get::<_, String>("name"),
            "slug": row.get::<_, String>("slug"),
            "status": row.get::<_, String>("status"),
            "current_version": row.get::<_, Option<i32>>("current_version"),
            "cloned_from_flow_id": row.get::<_, Option<i64>>("cloned_from_flow_id").map(|value| value.to_string()),
            "published_checksum": row.get::<_, Option<String>>("checksum"),
            "channel_key": row.get::<_, Option<String>>("channel_key"),
            "published_at": row.get::<_, Option<String>>("published_at"),
            "updated_at": row.get::<_, String>("updated_at"),
        }
    })
}

fn test_case_json(row: &Row) -> Value {
    json!({
        "id": row.get::<_, i64>("id").to_string(),
        "type": "parser-test-case",
        "attributes": {
            "name": row.get::<_, String>("name"),
            "mail_sample_id": row.get::<_, i64>("mail_sample_id").to_string(),
            "expected": row.get::<_, Value>("expected"),
            "enabled": row.get::<_, bool>("enabled"),
            "mail_message": {
                "id": row.get::<_, i64>("mail_message_id").to_string(),
                "subject": row.get::<_, Option<String>>("subject"),
                "from_address": row.get::<_, Option<String>>("from_address"),
            },
            "created_at": row.get::<_, String>("created_at"),
            "updated_at": row.get::<_, String>("updated_at"),
        }
    })
}

fn test_run_json(row: &Row) -> Value {
    json!({
        "id": row.get::<_, i64>("id").to_string(),
        "type": "parser-test-run",
        "attributes": {
            "flow_id": row.get::<_, i64>("flow_id").to_string(),
            "flow_version": row.get::<_, Option<i32>>("flow_version"),
            "parser_test_case_id": row.get::<_, Option<i64>>("parser_test_case_id").map(|value| value.to_string()),
            "mail_message_id": row.get::<_, Option<i64>>("mail_message_id").map(|value| value.to_string()),
            "status": row.get::<_, String>("status"),
            "duration_ms": row.get::<_, Option<i32>>("duration_ms"),
            "result_summary": row.get::<_, Value>("result_summary"),
            "node_results": row.get::<_, Value>("node_results"),
            "error_summary": row.get::<_, Option<String>>("error_summary"),
            "started_at": row.get::<_, String>("started_at"),
            "finished_at": row.get::<_, Option<String>>("finished_at"),
        }
    })
}

fn write_error(error: tokio_postgres::Error) -> ApiError {
    if error
        .as_db_error()
        .is_some_and(|error| error.code() == &tokio_postgres::error::SqlState::UNIQUE_VIOLATION)
    {
        ApiError::conflict("名称或 slug 已经存在。")
    } else {
        ApiError::database(error)
    }
}

fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expected_assertions_cover_counts_amounts_and_fields() {
        let output = ParseOutput {
            document: super::super::model::BillDocumentDraft {
                channel_key: "demo".to_owned(),
                ..super::super::model::BillDocumentDraft::default()
            },
            valid_rows: vec![super::super::model::BillRowDraft {
                occurred_at: "2026-08-11 10:00:00".to_owned(),
                signed_amount: "-12.5".to_owned(),
                currency_code: "CNY".to_owned(),
                description: "Coffee".to_owned(),
                ..super::super::model::BillRowDraft::default()
            }],
            invalid_rows: Vec::new(),
            warnings: Vec::new(),
            metrics: super::super::model::ParseMetrics {
                duration_ms: 1,
                input_artifacts: 1,
                records: 1,
                valid_rows: 1,
                invalid_rows: 0,
            },
            node_results: Vec::new(),
            artifacts: Vec::new(),
        };
        let expected = json!({
            "valid_rows": 1,
            "amount_total": "-12.50",
            "rows": [{ "currency_code": "CNY", "description": "Coffee" }]
        });
        assert!(assert_expected(&expected, &output).is_ok());
    }

    #[test]
    fn slug_validation_rejects_uppercase_and_leading_dash() {
        assert!(validate_name_slug("Demo", "demo-flow").is_ok());
        assert!(validate_name_slug("Demo", "Demo").is_err());
        assert!(validate_name_slug("Demo", "-demo").is_err());
    }

    #[test]
    fn version_diff_tracks_node_fields_by_stable_id() {
        let before = json!({
            "channel_key": "demo",
            "nodes": [
                { "id": "select", "type": "select_attachment", "filename": "*.csv" },
                { "id": "normalize", "type": "normalize_bill_rows", "default_currency": "CNY" }
            ]
        });
        let after = json!({
            "channel_key": "demo",
            "nodes": [
                { "id": "normalize", "type": "normalize_bill_rows", "default_currency": "USD" },
                { "id": "select", "type": "select_attachment", "filename": "*.csv" }
            ]
        });
        let mut changes = Vec::new();
        json_diff("", &before, &after, &mut changes);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0]["path"], "/nodes/normalize/default_currency");
        assert_eq!(changes[0]["before"], "CNY");
        assert_eq!(changes[0]["after"], "USD");
    }

    #[test]
    fn publish_comparison_reports_rows_amounts_and_empty_fields() {
        let row = |id: &str, amount: &str, description: &str| super::super::model::BillRowDraft {
            occurred_at: "2026-08-11 10:00:00".to_owned(),
            signed_amount: amount.to_owned(),
            currency_code: "CNY".to_owned(),
            description: description.to_owned(),
            provider_transaction_id: Some(id.to_owned()),
            ..super::super::model::BillRowDraft::default()
        };
        let output = |rows: Vec<super::super::model::BillRowDraft>| ParseOutput {
            document: super::super::model::BillDocumentDraft::default(),
            metrics: super::super::model::ParseMetrics {
                valid_rows: rows.len(),
                records: rows.len(),
                ..super::super::model::ParseMetrics::default()
            },
            valid_rows: rows,
            invalid_rows: Vec::new(),
            warnings: Vec::new(),
            node_results: Vec::new(),
            artifacts: Vec::new(),
        };
        let previous = output(vec![row("a", "-10", "Coffee"), row("b", "20", "Salary")]);
        let draft = output(vec![row("a", "-9", "")]);
        let changes = output_breaking_changes(
            &GateCase {
                id: 7,
                name: "golden".to_owned(),
                message_id: 9,
                expected: json!({}),
            },
            &previous,
            &draft,
        )
        .unwrap();
        let codes = changes
            .iter()
            .filter_map(|change| change["code"].as_str())
            .collect::<BTreeSet<_>>();
        assert!(codes.contains("valid_rows_decreased"));
        assert!(codes.contains("amount_total_changed"));
        assert!(codes.contains("field_became_empty"));
    }
}
