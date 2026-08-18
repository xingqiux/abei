//! OpenAPI 文档。它是**导出产物**，不是真源——整份文档由能力目录算出来，
//! 用途只有一个：给 abei-web 生成 TS 类型和 Zod 校验。
//!
//! 这里没用 utoipa：能力参数已经是 JSON Schema 了，utoipa 的 derive 会逼着把每个参数类型
//! 再声明一遍（两个真源，正是方案要避免的），它的 builder 又只是把同一份 JSON 换个类型装。
//! 直接从目录拼 JSON 更短也更诚实。

use abei_core::{Capability, Method, Verb};
use serde_json::{Map, Value, json};

pub fn document() -> Value {
    let catalog = abei_core::catalog();
    let mut paths = Map::new();
    // 目录里的模式已经摊平过（见 abei_core 的 inline_defs），所以没有共享组件要挂。
    let schemas = Map::new();

    for capability in catalog.capabilities() {
        let params = serde_json::to_value(&capability.params).unwrap_or_else(|_| json!({}));
        let operation = operation(capability, &params);
        let entry = paths
            .entry(capability.route_path())
            .or_insert_with(|| json!({}));
        if let Some(item) = entry.as_object_mut() {
            item.insert(method_key(capability.method()), operation);
        }
    }

    insert_mail_workbench_paths(&mut paths);
    insert_bill_inbox_paths(&mut paths);
    insert_parser_platform_paths(&mut paths);
    insert_feedback_admin_paths(&mut paths);

    paths.insert(
        "/health".to_owned(),
        json!({
            "get": {
                "operationId": "health",
                "summary": "健康检查",
                "tags": ["system"],
                "security": [],
                "responses": { "200": ok_response("服务在线。") }
            }
        }),
    );

    paths.insert(
        "/v1/openapi.json".to_owned(),
        json!({
            "get": {
                "operationId": "openapi",
                "summary": "导出 OpenAPI 文档",
                "tags": ["system"],
                "security": [],
                "responses": { "200": ok_response("OpenAPI 文档。") }
            }
        }),
    );

    paths.insert("/v1/catalog".to_owned(), json!({
        "get": {
            "operationId": "catalog",
            "summary": "能力目录",
            "description": "资源、动词、参数 schema、风险档与示例。CLI、agent、web 都从这里取。",
            "tags": ["system"],
            "responses": { "200": ok_response("完整能力目录。"), "401": problem_response() }
        }
    }));

    paths.insert(
        "/v1/session".to_owned(),
        json!({
            "get": {
                "operationId": "session.get",
                "summary": "查看当前可信身份",
                "tags": ["system"],
                "x-abei-risk": "read",
                "x-abei-backend": "api",
                "parameters": [],
                "responses": {
                    "200": json_response("当前令牌对应的用户和角色。", json!({
                        "type": "object",
                        "required": ["data"],
                        "properties": {
                            "data": {
                                "type": "object",
                                "required": ["user_id", "actor", "role", "is_owner"],
                                "properties": {
                                    "user_id": { "type": "integer", "minimum": 1 },
                                    "actor": { "type": "string" },
                                    "role": { "type": "string" },
                                    "is_owner": { "type": "boolean" }
                                }
                            }
                        }
                    })),
                    "401": problem_response()
                }
            }
        }),
    );

    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "阿贝 API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "资源接口与能力目录。邮件、解析和账单草稿由 abei-server 持有，最终交易通过 Firefly III 官方 API 入账。",
        },
        "servers": [{ "url": "/", "description": "当前实例" }],
        "security": [{ "fireflyToken": [] }],
        "components": {
            "securitySchemes": {
                "fireflyToken": {
                    "type": "http",
                    "scheme": "bearer",
                    "description": "Firefly III 的个人访问令牌，原样透传。",
                }
            },
            "schemas": schemas,
        },
        "paths": paths,
    })
}

fn insert_mail_workbench_paths(paths: &mut Map<String, Value>) {
    let definitions = [
        (
            "/v1/mailboxes",
            "get",
            "mailboxes.list",
            "查看邮箱连接",
            false,
            false,
        ),
        (
            "/v1/mailboxes/{id}",
            "get",
            "mailboxes.get",
            "查看邮箱连接",
            false,
            false,
        ),
        (
            "/v1/mailboxes/{id}",
            "put",
            "mailboxes.update",
            "更新邮箱连接",
            true,
            false,
        ),
        (
            "/v1/mailboxes/{id}/sync",
            "post",
            "mailboxes.sync",
            "同步新邮件",
            true,
            false,
        ),
        (
            "/v1/mailboxes/{id}/rescan",
            "post",
            "mailboxes.rescan",
            "扫描历史邮件",
            true,
            true,
        ),
        (
            "/v1/mail-sync-runs",
            "get",
            "mail-sync-runs.list",
            "查看同步记录",
            false,
            false,
        ),
        (
            "/v1/mail-sync-runs/{id}",
            "get",
            "mail-sync-runs.get",
            "查看同步进度",
            false,
            false,
        ),
        (
            "/v1/mail-sync-runs/{id}/cancel",
            "post",
            "mail-sync-runs.cancel",
            "取消邮箱同步",
            true,
            false,
        ),
        (
            "/v1/mail-messages",
            "get",
            "mail-messages.list",
            "查看邮件索引",
            false,
            false,
        ),
        (
            "/v1/mail-messages/{id}",
            "get",
            "mail-messages.get",
            "查看邮件详情",
            false,
            false,
        ),
        (
            "/v1/mail-messages/{id}/raw",
            "get",
            "mail-messages.raw",
            "下载原始 EML",
            false,
            false,
        ),
        (
            "/v1/mail-messages/{id}/cache",
            "post",
            "mail-messages.cache",
            "缓存邮件内容",
            true,
            false,
        ),
        (
            "/v1/mail-messages/{id}/reroute",
            "post",
            "mail-messages.reroute",
            "重新归类邮件",
            true,
            false,
        ),
        (
            "/v1/mail-rules",
            "get",
            "mail-rules.list",
            "查看邮件规则",
            false,
            false,
        ),
        (
            "/v1/mail-rules",
            "post",
            "mail-rules.create",
            "创建邮件规则草稿",
            true,
            false,
        ),
        (
            "/v1/mail-rules/test",
            "post",
            "mail-rules.test",
            "测试邮件规则",
            false,
            false,
        ),
        (
            "/v1/mail-rules/{id}",
            "patch",
            "mail-rules.update",
            "更新邮件规则草稿",
            true,
            false,
        ),
        (
            "/v1/mail-rules/{id}/publish",
            "post",
            "mail-rules.publish",
            "发布邮件规则",
            true,
            true,
        ),
        (
            "/v1/mail-rules/{id}/apply",
            "post",
            "mail-rules.apply",
            "把规则套到历史邮件上",
            true,
            true,
        ),
        (
            "/v1/mail-rules/{id}/apply-status",
            "get",
            "mail-rules.apply-status",
            "查看批量重归类进度",
            false,
            false,
        ),
        (
            "/v1/mail-rules/{id}/rollback",
            "post",
            "mail-rules.rollback",
            "回滚邮件规则",
            true,
            true,
        ),
        (
            "/v1/mail-samples",
            "get",
            "mail-samples.list",
            "查看固定样本",
            false,
            false,
        ),
        (
            "/v1/mail-samples",
            "post",
            "mail-samples.create",
            "固定邮件样本",
            true,
            false,
        ),
        (
            "/v1/mail-samples/{id}",
            "delete",
            "mail-samples.delete",
            "删除固定样本",
            true,
            true,
        ),
    ];

    for (path, method, operation_id, summary, write, confirm) in definitions {
        let entry = paths.entry(path.to_owned()).or_insert_with(|| json!({}));
        let mut parameters = Vec::new();
        if path.contains("{id}") {
            parameters.push(json!({
                "name": "id",
                "in": "path",
                "required": true,
                "schema": { "type": "string", "pattern": id_pattern(path) }
            }));
        }
        if write && operation_id != "mail-rules.test" {
            parameters.extend(generic_gate_parameters(confirm));
        }
        let mut operation = json!({
            "operationId": operation_id,
            "summary": summary,
            "tags": [operation_id.split('.').next().unwrap_or("mail")],
            "x-abei-risk": if confirm { "confirm" } else if write { "draft" } else { "read" },
            "x-abei-backend": "server",
            "parameters": parameters,
            "responses": {
                "200": ok_response(summary),
                "400": problem_response(),
                "401": problem_response(),
                "404": problem_response(),
                "502": problem_response()
            }
        });
        if write || operation_id == "mail-rules.test" {
            operation["requestBody"] = json!({
                "required": false,
                "content": { "application/json": { "schema": { "type": "object" } } }
            });
        }
        if confirm {
            operation["responses"]["409"] = problem_response();
        }
        if matches!(operation_id, "mailboxes.sync" | "mailboxes.rescan") {
            operation["responses"]["202"] = ok_response("同步任务已创建。");
        }
        if operation_id == "mail-rules.apply-status" {
            operation["description"] = json!(
                "这条规则最近一次批量重归类跑到哪儿了。从来没跑过返回 state=idle；\
                 任务失去心跳返回 state=interrupted，说明服务在处理途中重启过。"
            );
            operation["responses"]["200"] =
                json_response("批量重归类的进度。", mail_rule_apply_run_schema());
        }
        if operation_id == "mail-rules.apply" {
            operation["description"] = json!(
                "按已发布的规则条件重扫历史邮件：命中的重新归类，已经解析出账单的顺带重新解析一遍。\
                 处理在后台跑，这里立刻返回任务标识；进度用 mail-rules.apply-status 查。\
                 同一条规则同时只允许一个任务在跑，重复发起返回 409。"
            );
            operation["requestBody"] = json!({
                "required": false,
                "content": { "application/json": { "schema": {
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
                            "enum": ["unclassified", "all"],
                            "default": "unclassified",
                            "description": "只扫没归类的，还是全部邮件。"
                        },
                        "limit": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 2000,
                            "default": 500,
                            "description": "这一趟最多看多少封，从最近的往回数。"
                        }
                    }
                } } }
            });
            // 200 只剩预览用：真正发起时任务是后台跑的，回的是 202 和一个刚开出来的任务。
            operation["responses"]["200"] = ok_response("预览：这一趟会命中多少封。");
            operation["responses"]["202"] =
                json_response("任务已创建，处理在后台进行。", mail_rule_apply_run_schema());
        }
        if operation_id == "mail-messages.raw" {
            operation["responses"]["200"] = json!({
                "description": "原始 RFC 822 邮件。",
                "content": { "message/rfc822": { "schema": { "type": "string", "format": "binary" } } }
            });
        }
        if let Some(item) = entry.as_object_mut() {
            item.insert(method.to_owned(), operation);
        }
    }
}

/// 一次批量重归类的进度。发起和查询回的是同一个形状，客户端只写一套解析。
fn mail_rule_apply_run_schema() -> Value {
    json!({
        "type": "object",
        "required": ["data"],
        "properties": {
            "data": {
                "type": "object",
                "required": ["state", "matched", "rerouted", "reparse_jobs", "failed",
                             "total_scanned"],
                "properties": {
                    "run_id": { "type": ["string", "null"], "description": "任务标识。从来没跑过是 null。" },
                    "state": {
                        "type": "string",
                        "enum": ["idle", "running", "interrupted", "succeeded", "failed"],
                        "description": "interrupted 是任务失去心跳，多半是服务在处理途中重启了。"
                    },
                    "scope": { "type": ["string", "null"], "enum": ["unclassified", "all", null] },
                    "total_scanned": { "type": "integer", "description": "这一趟一共看过多少封邮件。" },
                    "matched": { "type": "integer", "description": "条件命中、要处理的邮件数。" },
                    "rerouted": { "type": "integer", "description": "已经改完归类的邮件数。" },
                    "reparse_jobs": { "type": "integer", "description": "顺带排上的解析任务数。" },
                    "failed": { "type": "integer", "description": "单封处理出错的数量，不影响其余。" },
                    "error": { "type": ["string", "null"], "description": "整批没跑起来时的原因。" },
                    "created_at": { "type": "string" },
                    "finished_at": { "type": ["string", "null"] }
                }
            }
        }
    })
}

/// 邮箱那几条允许传 current 指代自己的邮箱，别的资源只收数字 id。
fn id_pattern(path: &str) -> &'static str {
    if path.starts_with("/v1/mailboxes/") {
        "^([1-9][0-9]*|current)$"
    } else {
        "^[1-9][0-9]*$"
    }
}

/// 收件箱的读接口。这几条是转发给 abei-server 的，不在能力目录里，
/// 但 web 直接按它们的响应形状写界面，所以字段得写下来。
fn insert_bill_inbox_paths(paths: &mut Map<String, Value>) {
    paths.insert(
        "/v1/bill-rows".to_owned(),
        json!({
            "get": {
                "operationId": "bill-rows.list",
                "summary": "查看账单流水",
                "tags": ["bill-rows"],
                "x-abei-risk": "read",
                "x-abei-backend": "server",
                "parameters": [
                    {
                        "name": "group", "in": "query", "required": false,
                        "schema": { "type": "string",
                            "enum": ["importable", "attention", "dismissed", "imported"] },
                        "description": "四分组之一。不填是全部。"
                    },
                    {
                        "name": "channel", "in": "query", "required": false,
                        "schema": { "type": "string" },
                        "description": "渠道 key，例如 cmb。"
                    },
                    {
                        "name": "source", "in": "query", "required": false,
                        "schema": { "type": "string" },
                        "description": "channel 的旧名字，等价。"
                    },
                    {
                        "name": "document_id", "in": "query", "required": false,
                        "schema": { "type": "string", "pattern": "^[1-9][0-9]*$" },
                        "description": "只看某一封邮件解析出来的流水。点名之后归档的文档也看得见。"
                    },
                    { "name": "page", "in": "query", "required": false,
                      "schema": { "type": "integer", "minimum": 1 } },
                    { "name": "limit", "in": "query", "required": false,
                      "schema": { "type": "integer", "minimum": 1, "maximum": 500 } }
                ],
                "responses": {
                    "200": json_response("账单流水分页。", bill_rows_schema()),
                    "400": problem_response(),
                    "401": problem_response(),
                    "502": problem_response()
                }
            }
        }),
    );
    paths.insert(
        "/v1/bill-rows/undo-import".to_owned(),
        json!({
            "post": {
                "operationId": "bill-rows.undo-import",
                "summary": "撤销入账",
                "description": "删掉账本里对应的交易，再把这几行放回待处理。\
                                Firefly 里那笔本来就不在也算撤销成功；删不掉的行原样停在已入账，\
                                逐行报错。会动账本，必须带 confirm=true。",
                "tags": ["bill-rows"],
                "x-abei-risk": "confirm",
                "x-abei-backend": "server",
                "parameters": generic_gate_parameters(true),
                "requestBody": {
                    "required": true,
                    "content": { "application/json": { "schema": {
                        "type": "object",
                        "required": ["row_ids"],
                        "properties": {
                            "row_ids": {
                                "type": "array",
                                "items": { "type": ["string", "integer"] },
                                "description": "要撤销的流水 id，一次最多 500 条。"
                            }
                        }
                    } } }
                },
                "responses": {
                    "200": json_response("逐行的撤销结果。", undo_import_schema()),
                    "400": problem_response(),
                    "401": problem_response(),
                    "409": problem_response(),
                    "502": problem_response()
                }
            }
        }),
    );
    paths.insert(
        "/v1/bill-inbox/summary".to_owned(),
        json!({
            "get": {
                "operationId": "bill-inbox.summary",
                "summary": "查看收件箱概览",
                "description": "四分组计数、渠道条、解析任务与最近一次同步。所有计数都按同一套 SQL 口径算，逐渠道加起来等于总数。",
                "tags": ["bill-inbox"],
                "x-abei-risk": "read",
                "x-abei-backend": "server",
                "parameters": [],
                "responses": {
                    "200": json_response("收件箱概览。", bill_inbox_summary_schema()),
                    "401": problem_response(),
                    "502": problem_response()
                }
            }
        }),
    );
}

/// 撤销入账的响应：逐行一个结局，加一份汇总。
///
/// 逐行说，是因为一批里每一行的下场可能都不一样——一行的交易删掉了，另一行 Firefly
/// 不让删。整批只回一个「成功/失败」会让用户以为全撤了。
fn undo_import_schema() -> Value {
    json!({
        "type": "object",
        "required": ["data"],
        "properties": {
            "data": {
                "type": "object",
                "required": ["rows", "summary"],
                "properties": {
                    "rows": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["row_id", "outcome"],
                            "properties": {
                                "row_id": { "type": "string" },
                                "outcome": {
                                    "type": "string",
                                    "enum": ["undone", "not_imported", "not_found", "failed"],
                                    "description": "undone 是交易已删（或本来就不在）、行已回待处理。"
                                },
                                "transaction_group_id": { "type": ["string", "null"] },
                                "error": { "type": ["string", "null"] }
                            }
                        }
                    },
                    "summary": {
                        "type": "object",
                        "required": ["total", "undone", "failed"],
                        "properties": {
                            "total": { "type": "integer" },
                            "undone": { "type": "integer" },
                            "not_imported": { "type": "integer" },
                            "not_found": { "type": "integer" },
                            "failed": { "type": "integer" }
                        }
                    }
                }
            }
        }
    })
}

fn bill_row_counts_schema() -> Value {
    json!({
        "type": "object",
        "required": ["importable", "attention", "dismissed", "imported"],
        "properties": {
            "importable": { "type": "integer" },
            "attention": { "type": "integer" },
            "dismissed": { "type": "integer" },
            "imported": { "type": "integer" }
        }
    })
}

fn bill_rows_schema() -> Value {
    json!({
        "type": "object",
        "required": ["data"],
        "properties": {
            "data": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["id", "type", "attributes"],
                    "properties": {
                        "id": { "type": "string" },
                        "type": { "const": "bill-row" },
                        "attributes": {
                            "type": "object",
                            "required": ["group", "attention_kind", "issues"],
                            "properties": {
                                "group": {
                                    "type": "string",
                                    "enum": ["importable", "attention", "dismissed", "imported"]
                                },
                                "attention_kind": {
                                    "type": ["string", "null"],
                                    "enum": ["account_unmapped", "pairing_suggested",
                                             "duplicate_suspect", "import_failed",
                                             "import_pending", "needs_fix", null],
                                    "description": "待确认的行为什么要人看。非待确认的行是 null。前端按这个分节，不要拿 reasons 的中文做匹配。"
                                },
                                "issues": {
                                    "type": "array",
                                    "description": "每一条都带 code 和 message。进了待确认的行至少有一条。",
                                    "items": {
                                        "type": "object",
                                        "required": ["code", "message"],
                                        "properties": {
                                            "code": {
                                                "type": "string",
                                                "description": "account_mapping_required / account_mapping_ambiguous / invalid_date / missing_amount / missing_type / missing_description / duplicate_suspect / pair_suggested / import_failed 等。"
                                            },
                                            "message": { "type": "string" },
                                            "severity": { "type": "string" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            "meta": { "type": "object" }
        }
    })
}

fn bill_inbox_summary_schema() -> Value {
    json!({
        "type": "object",
        "required": ["counts", "channels", "needs_code", "unprocessed", "failed"],
        "properties": {
            "pending_total": { "type": "integer" },
            "needs_code": { "type": "integer", "description": "等用户补密码的邮件数（按文档的最新一条解析任务算）。" },
            "unprocessed": { "type": "integer", "description": "排队中或正在解析的邮件数。" },
            "failed": { "type": "integer", "description": "解析失败的邮件数。" },
            "unclassified_mail": { "type": "integer" },
            "counts": bill_row_counts_schema(),
            "channels": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["key", "name", "counts"],
                    "properties": {
                        "key": { "type": "string", "description": "渠道标识，例如 cmb。" },
                        "name": { "type": "string", "description": "中文显示名，例如「招商银行」。认不出来的 key 原样返回。" },
                        "last_received_at": { "type": ["string", "null"] },
                        "needs_code": { "type": "integer" },
                        "unprocessed": { "type": "integer" },
                        "failed": { "type": "integer" },
                        "parsed": { "type": "integer" },
                        "to_store": { "type": "integer" },
                        "last_status": { "type": ["string", "null"] },
                        "counts": bill_row_counts_schema()
                    }
                }
            },
            "todo": { "type": "object" },
            "parse_jobs": { "type": "array", "items": { "type": "object" } },
            "mailbox_sync": { "type": "object" }
        }
    })
}

fn generic_gate_parameters(confirm_required: bool) -> Vec<Value> {
    vec![
        json!({
            "name": "dry_run",
            "in": "query",
            "required": false,
            "schema": { "type": "boolean" },
            "description": "只校验和预览，不写入。"
        }),
        json!({
            "name": "confirm",
            "in": "query",
            "required": false,
            "schema": { "type": "boolean" },
            "description": if confirm_required { "必须显式确认。" } else { "可选确认标记。" }
        }),
    ]
}

fn insert_feedback_admin_paths(paths: &mut Map<String, Value>) {
    let definitions = [
        (
            "/v1/admin/feedback/submissions",
            "get",
            "admin.feedback.submissions.list",
            "查看反馈收件箱",
        ),
        (
            "/v1/admin/feedback/submissions/{id}",
            "get",
            "admin.feedback.submissions.get",
            "查看反馈提交详情",
        ),
        (
            "/v1/admin/feedback/submissions/{id}",
            "patch",
            "admin.feedback.submissions.update",
            "驳回或脱敏反馈提交",
        ),
        (
            "/v1/admin/feedback/submissions/{id}/link",
            "post",
            "admin.feedback.submissions.link",
            "关联或重新关联反馈提交",
        ),
        (
            "/v1/admin/feedback/submissions/{id}/messages",
            "post",
            "admin.feedback.submissions.message",
            "向反馈提交者追问",
        ),
        (
            "/v1/admin/feedback/items",
            "get",
            "admin.feedback.items.list",
            "查看反馈事项",
        ),
        (
            "/v1/admin/feedback/items/{id}",
            "get",
            "admin.feedback.items.get",
            "查看反馈事项详情",
        ),
        (
            "/v1/admin/feedback/items/{id}",
            "patch",
            "admin.feedback.items.update",
            "修改反馈事项",
        ),
        (
            "/v1/admin/feedback/items/{id}/updates",
            "post",
            "admin.feedback.items.publish-update",
            "发布反馈处理进展",
        ),
        (
            "/v1/admin/feedback/items/{id}/merge",
            "post",
            "admin.feedback.items.merge",
            "合并重复反馈事项",
        ),
        (
            "/v1/admin/feedback/items/{id}/archive",
            "post",
            "admin.feedback.items.archive",
            "归档反馈事项",
        ),
        (
            "/v1/admin/feedback/items/{id}/restore",
            "post",
            "admin.feedback.items.restore",
            "恢复反馈事项",
        ),
    ];

    for (path, method, operation_id, summary) in definitions {
        let entry = paths.entry(path.to_owned()).or_insert_with(|| json!({}));
        let mut parameters = feedback_admin_query_parameters(operation_id);
        if path.contains("{id}") {
            parameters.insert(
                0,
                json!({
                    "name": "id",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "integer", "minimum": 1 }
                }),
            );
        }
        let mut operation = json!({
            "operationId": operation_id,
            "summary": summary,
            "description": "仅 owner 可调用；所有状态变化由 abei-server 写入不可变审计事件。",
            "tags": ["admin-feedback"],
            "x-abei-risk": if method == "get" { "read" } else { "draft" },
            "x-abei-backend": "server",
            "parameters": parameters,
            "responses": {
                "200": ok_response(summary),
                "400": problem_response(),
                "401": problem_response(),
                "403": problem_response(),
                "404": problem_response(),
                "409": problem_response(),
                "502": problem_response()
            }
        });
        if let Some(schema) = feedback_admin_body_schema(operation_id) {
            operation["requestBody"] = json!({
                "required": true,
                "content": { "application/json": { "schema": schema } }
            });
        }
        if matches!(
            operation_id,
            "admin.feedback.submissions.message" | "admin.feedback.items.publish-update"
        ) {
            operation["responses"]["201"] = ok_response(summary);
        }
        if let Some(item) = entry.as_object_mut() {
            item.insert(method.to_owned(), operation);
        }
    }
}

fn feedback_admin_query_parameters(operation_id: &str) -> Vec<Value> {
    let names: &[(&str, Value)] = match operation_id {
        "admin.feedback.submissions.list" => &[
            ("state", json!({ "type": "string" })),
            (
                "kind",
                json!({ "type": "string", "enum": ["bug", "experience", "suggestion"] }),
            ),
            (
                "target",
                json!({ "type": "string", "enum": ["cli", "app", "web"] }),
            ),
            ("item_id", json!({ "type": "integer", "minimum": 1 })),
            (
                "limit",
                json!({ "type": "integer", "minimum": 1, "maximum": 100 }),
            ),
            ("offset", json!({ "type": "integer", "minimum": 0 })),
        ],
        "admin.feedback.items.list" => &[
            ("archived", json!({ "type": "boolean" })),
            (
                "kind",
                json!({ "type": "string", "enum": ["bug", "experience", "suggestion"] }),
            ),
            (
                "target",
                json!({ "type": "string", "enum": ["cli", "app", "web"] }),
            ),
            ("status", json!({ "type": "string" })),
            (
                "severity",
                json!({ "type": "string", "enum": ["critical", "high", "normal", "low"] }),
            ),
            (
                "limit",
                json!({ "type": "integer", "minimum": 1, "maximum": 100 }),
            ),
            ("offset", json!({ "type": "integer", "minimum": 0 })),
        ],
        _ => &[],
    };
    names
        .iter()
        .map(|(name, schema)| {
            json!({
                "name": name,
                "in": "query",
                "required": false,
                "schema": schema
            })
        })
        .collect()
}

fn feedback_admin_body_schema(operation_id: &str) -> Option<Value> {
    let text = || json!({ "type": "string", "minLength": 1, "maxLength": 4000 });
    Some(match operation_id {
        "admin.feedback.submissions.update" => json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["state", "reason"],
            "properties": {
                "state": { "type": "string", "enum": ["dismissed", "redacted"] },
                "reason": text()
            }
        }),
        "admin.feedback.submissions.link" => json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["reason"],
            "properties": {
                "item_id": { "type": ["integer", "null"], "minimum": 1 },
                "new": { "type": "boolean" },
                "title": { "type": ["string", "null"], "minLength": 1, "maxLength": 160 },
                "reason": text()
            }
        }),
        "admin.feedback.submissions.message" => json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["message"],
            "properties": { "message": text() }
        }),
        "admin.feedback.items.update" => json!({
            "type": "object",
            "additionalProperties": false,
            "minProperties": 1,
            "properties": {
                "title": { "type": "string", "minLength": 1, "maxLength": 160 },
                "kind": { "type": "string", "enum": ["bug", "experience", "suggestion"] },
                "target": { "type": "string", "enum": ["cli", "app", "web"] },
                "status": { "type": "string", "enum": ["open", "reviewing", "planned", "in_progress", "completed", "closed"] },
                "severity": { "type": ["string", "null"], "enum": ["critical", "high", "normal", "low", null] },
                "public_summary": { "type": "string", "maxLength": 4000 },
                "close_reason": { "type": ["string", "null"], "maxLength": 4000 },
                "update": { "type": ["string", "null"], "maxLength": 4000 }
            }
        }),
        "admin.feedback.items.publish-update" => json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["body"],
            "properties": { "body": text() }
        }),
        "admin.feedback.items.merge" => json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["target_id", "reason"],
            "properties": {
                "target_id": { "type": "integer", "minimum": 1 },
                "reason": text()
            }
        }),
        "admin.feedback.items.archive" | "admin.feedback.items.restore" => json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["reason"],
            "properties": { "reason": text() }
        }),
        _ => return None,
    })
}

fn insert_parser_platform_paths(paths: &mut Map<String, Value>) {
    let definitions = [
        (
            "/v1/parser-flows/validate",
            "post",
            "parser-flows.validate",
            "校验解析流程",
            "read",
            true,
        ),
        (
            "/v1/parser-flows/test-eml",
            "post",
            "parser-flows.test-eml-source",
            "用本地 EML 测试解析定义",
            "read",
            true,
        ),
        (
            "/v1/parser-flows",
            "get",
            "parser-flows.list",
            "查看解析流程",
            "read",
            false,
        ),
        (
            "/v1/parser-flows",
            "post",
            "parser-flows.create",
            "创建解析流程草稿",
            "draft",
            true,
        ),
        (
            "/v1/parser-flows/{id}",
            "get",
            "parser-flows.get",
            "查看解析流程",
            "read",
            false,
        ),
        (
            "/v1/parser-flows/{id}",
            "patch",
            "parser-flows.update",
            "更新解析流程草稿",
            "draft",
            true,
        ),
        (
            "/v1/parser-flows/{id}/clone",
            "post",
            "parser-flows.clone",
            "复制解析流程",
            "draft",
            true,
        ),
        (
            "/v1/parser-flows/{id}/test",
            "post",
            "parser-flows.test",
            "测试解析流程",
            "read",
            true,
        ),
        (
            "/v1/parser-flows/{id}/test-eml",
            "post",
            "parser-flows.test-eml",
            "上传 EML 测试解析流程",
            "read",
            true,
        ),
        (
            "/v1/parser-flows/{id}/publish",
            "post",
            "parser-flows.publish",
            "发布解析流程",
            "confirm",
            false,
        ),
        (
            "/v1/parser-flows/{id}/rollback",
            "post",
            "parser-flows.rollback",
            "回滚解析流程",
            "confirm",
            true,
        ),
        (
            "/v1/parser-flows/{id}/retire",
            "post",
            "parser-flows.retire",
            "停用解析流程",
            "confirm",
            false,
        ),
        (
            "/v1/parser-flows/{id}/versions",
            "get",
            "parser-flows.versions",
            "查看解析流程版本",
            "read",
            false,
        ),
        (
            "/v1/parser-flows/{id}/versions/{version}",
            "get",
            "parser-flows.version",
            "查看解析流程版本",
            "read",
            false,
        ),
        (
            "/v1/parser-flows/{id}/test-cases",
            "post",
            "parser-test-cases.create",
            "创建解析测试用例",
            "draft",
            true,
        ),
        (
            "/v1/parser-test-cases/{id}",
            "patch",
            "parser-test-cases.update",
            "更新解析测试用例",
            "draft",
            true,
        ),
        (
            "/v1/parser-test-cases/{id}",
            "delete",
            "parser-test-cases.delete",
            "删除解析测试用例",
            "confirm",
            false,
        ),
        (
            "/v1/parser-test-runs/{id}",
            "get",
            "parser-test-runs.get",
            "查看解析测试运行",
            "read",
            false,
        ),
    ];

    for (path, method, operation_id, summary, risk, body) in definitions {
        let entry = paths.entry(path.to_owned()).or_insert_with(|| json!({}));
        let mut parameters = Vec::new();
        if path.contains("{id}") {
            parameters.push(json!({
                "name": "id",
                "in": "path",
                "required": true,
                "schema": { "type": "string", "pattern": "^[1-9][0-9]*$" }
            }));
        }
        if path.contains("{version}") {
            parameters.push(json!({
                "name": "version",
                "in": "path",
                "required": true,
                "schema": { "type": "integer", "minimum": 1 }
            }));
        }
        if matches!(risk, "draft" | "confirm") {
            parameters.extend(generic_gate_parameters(risk == "confirm"));
        }
        let mut operation = json!({
            "operationId": operation_id,
            "summary": summary,
            "tags": [operation_id.split('.').next().unwrap_or("parser")],
            "x-abei-risk": risk,
            "x-abei-backend": "server",
            "parameters": parameters,
            "responses": {
                "200": ok_response(summary),
                "400": problem_response(),
                "401": problem_response(),
                "404": problem_response(),
                "502": problem_response()
            }
        });
        if path.ends_with("/test-eml") {
            let mut required = vec!["eml"];
            if !path.contains("{id}") {
                required.push("source_yaml");
            }
            operation["requestBody"] = json!({
                "required": true,
                "content": {
                    "multipart/form-data": {
                        "schema": {
                            "type": "object",
                            "required": required,
                            "properties": {
                                "eml": { "type": "string", "format": "binary" },
                                "source_yaml": { "type": "string", "maxLength": 262144 },
                                "version": { "type": "integer", "minimum": 1 },
                                "timezone": { "type": "string", "maxLength": 120 },
                                "secrets": { "type": "string", "description": "JSON 字符串映射。" }
                            }
                        }
                    }
                }
            });
        } else if body {
            operation["requestBody"] = json!({
                "required": true,
                "content": { "application/json": { "schema": { "type": "object" } } }
            });
        }
        if risk == "confirm" {
            operation["responses"]["409"] = problem_response();
        }
        if operation_id.ends_with(".create") || operation_id == "parser-flows.clone" {
            operation["responses"]["201"] = ok_response(summary);
        }
        if let Some(item) = entry.as_object_mut() {
            item.insert(method.to_owned(), operation);
        }
    }
}

/// 文档的磁盘形态：缩进 2 空格、末尾一个换行。
///
/// 键序是确定的——serde_json 没开 `preserve_order`，对象走 `BTreeMap`，
/// 所以同一份代码永远输出同一串字节，签进仓库的生成物才能用 diff 看住。
pub fn document_text() -> String {
    let mut text = serde_json::to_string_pretty(&document()).expect("文档一定能序列化");
    text.push('\n');
    text
}

fn operation(capability: &Capability, params: &Value) -> Value {
    let path_param = capability.path_param();
    let reading = matches!(capability.method(), Method::Get);
    let mut parameters = Vec::new();

    if let Some(name) = path_param {
        let description = params["properties"][name]
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("对象标识。");
        parameters.push(json!({
            "name": name,
            "in": "path",
            "required": true,
            "description": description,
            "schema": { "type": "string" }
        }));
    }

    // 读操作的参数进查询串；写操作进请求体——服务端就是这么收的，文档不能说另一套。
    if reading && let Some(properties) = params.get("properties").and_then(Value::as_object) {
        let required: Vec<&str> = params
            .get("required")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();

        for (name, schema) in properties {
            // 路径参数已经单独声明过，别在 query 里再来一遍。
            if path_param == Some(name.as_str()) {
                continue;
            }
            parameters.push(json!({
                "name": name,
                "in": "query",
                "required": required.contains(&name.as_str()),
                "description": schema.get("description").and_then(Value::as_str).unwrap_or_default(),
                "schema": strip_description(schema),
            }));
        }
    }

    let mut operation = json!({
        "operationId": capability.id(),
        "summary": capability.label,
        "description": capability.description,
        "tags": [capability.resource],
        "x-abei-risk": capability.risk.as_str(),
        "x-abei-backend": capability.backend.as_str(),
        "responses": {
            "200": ok_response(capability.description),
            "400": problem_response(),
            "401": problem_response(),
            "502": problem_response(),
        }
    });

    if !reading {
        parameters.extend(gate_parameters(capability));
        operation["requestBody"] = if capability.id() == "feedback.create" {
            feedback_create_request_body(params)
        } else {
            request_body(params, path_param)
        };
        // confirm 档没带确认参数就是 409，得让生成的客户端知道这不是「失败」。
        operation["responses"]["409"] = problem_response();
    }

    if capability.verb == Verb::Create
        && let Some(responses) = operation["responses"].as_object_mut()
        && let Some(response) = responses.get("200").cloned()
    {
        responses.insert("201".to_owned(), response);
    }

    if matches!(capability.id().as_str(), "bills.sync" | "feedback.create")
        && let Some(responses) = operation["responses"].as_object_mut()
        && let Some(response) = responses.get("200").cloned()
    {
        responses.insert("202".to_owned(), response);
    }

    operation["parameters"] = Value::Array(parameters);
    operation
}

/// 写闸门的两个查询参数。三个客户端撞的是同一道闸，文档里就该有它。
fn gate_parameters(capability: &Capability) -> Vec<Value> {
    let confirm_required = capability.risk == abei_core::Risk::Confirm;
    vec![
        json!({
            "name": "dry_run",
            "in": "query",
            "required": false,
            "description": "只跑校验和预览，不落库。响应会带 dry_run: true。",
            "schema": { "type": "boolean" }
        }),
        json!({
            "name": "confirm",
            "in": "query",
            "required": false,
            "description": if confirm_required {
                "显式确认。这条能力是 confirm 档，不带它也不带 dry_run 就是 409。"
            } else {
                "显式确认。这条能力是 draft 档，不带也能执行。"
            },
            "schema": { "type": "boolean" }
        }),
    ]
}

/// 写操作的请求体：能力的参数模式去掉 id（id 走路径）。
fn request_body(params: &Value, path_param: Option<&str>) -> Value {
    let mut schema = params.clone();
    if let Some(path_param) = path_param
        && let Some(object) = schema.as_object_mut()
    {
        if let Some(Value::Object(properties)) = object.get_mut("properties") {
            properties.remove(path_param);
        }
        if let Some(Value::Array(required)) = object.get_mut("required") {
            required.retain(|name| name.as_str() != Some(path_param));
        }
    }

    json!({
        "required": schema
            .get("required")
            .and_then(Value::as_array)
            .is_some_and(|list| !list.is_empty()),
        "content": { "application/json": { "schema": schema } }
    })
}

fn feedback_create_request_body(params: &Value) -> Value {
    let mut schema = params.clone();
    let object = schema
        .as_object_mut()
        .expect("feedback create params are an object schema");
    let properties = object
        .entry("properties")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("feedback create properties are an object");
    properties.insert(
        "idempotency_key".to_owned(),
        json!({
            "type": "string",
            "minLength": 8,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9._:-]+$",
            "description": "客户端为一次提交生成并在重试时复用。"
        }),
    );
    properties.insert(
        "submitted_via".to_owned(),
        json!({
            "type": "string",
            "enum": ["cli", "app", "web"],
            "description": "实际提交入口。"
        }),
    );
    properties.insert(
        "context".to_owned(),
        json!({
            "type": "object",
            "additionalProperties": false,
            "description": "客户端自动采集的受限运行上下文；不得放入命令参数、令牌、财务正文或工具输出。",
            "properties": {
                "cli_version": { "type": "string", "maxLength": 64 },
                "os": { "type": "string", "maxLength": 64 },
                "arch": { "type": "string", "maxLength": 64 },
                "recorded_at": { "type": "string", "maxLength": 64 },
                "recent": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "capability_id": { "type": "string", "maxLength": 128 },
                        "request_id": { "type": ["string", "null"], "maxLength": 128 },
                        "result": { "type": "string", "enum": ["success", "error"] },
                        "error_reason": { "type": ["string", "null"], "maxLength": 128 },
                        "error_code": { "type": ["string", "null"], "maxLength": 128 },
                        "exit_code": { "type": "integer" },
                        "recorded_at": { "type": "string", "maxLength": 64 }
                    }
                }
            }
        }),
    );
    let required = object
        .entry("required")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .expect("feedback create required is an array");
    for field in ["idempotency_key", "submitted_via"] {
        if !required.iter().any(|value| value.as_str() == Some(field)) {
            required.push(Value::String(field.to_owned()));
        }
    }
    request_body(&schema, None)
}

fn ok_response(description: &str) -> Value {
    json!({
        "description": description,
        "content": { "application/json": { "schema": { "type": "object" } } }
    })
}

fn json_response(description: &str, schema: Value) -> Value {
    json!({
        "description": description,
        "content": { "application/json": { "schema": schema } }
    })
}

fn problem_response() -> Value {
    json!({
        "description": "RFC 9457 problem+json。reason 是机读驼峰码。",
        "content": { "application/problem+json": { "schema": {
            "type": "object",
            "required": ["type", "title", "status", "reason"],
            "properties": {
                "type": { "type": "string" },
                "title": { "type": "string" },
                "status": { "type": "integer" },
                "reason": { "type": "string", "description": "机读错误码，驼峰。" },
                "detail": { "type": "string" },
                "resource": { "type": "string" },
                "verb": { "type": "string" },
                "upstream": {}
            }
        }}}
    })
}

/// 描述已经提到 parameter 层了，schema 里不用再留一份。
fn strip_description(schema: &Value) -> Value {
    let mut cloned = schema.clone();
    if let Some(object) = cloned.as_object_mut() {
        object.remove("description");
    }
    cloned
}

fn method_key(method: Method) -> String {
    method.as_str().to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_capability_appears_in_the_document() {
        let document = document();
        for capability in abei_core::catalog().capabilities() {
            let operation =
                &document["paths"][capability.route_path()][method_key(capability.method())];
            assert!(
                operation.is_object(),
                "{} 没进 OpenAPI 文档",
                capability.id()
            );
            assert_eq!(operation["operationId"], capability.id());
            assert_eq!(operation["x-abei-risk"], capability.risk.as_str());
        }
    }

    #[test]
    fn params_become_query_parameters() {
        let document = document();
        let parameters = document["paths"]["/v1/transactions"]["get"]["parameters"]
            .as_array()
            .unwrap();
        let names: Vec<&str> = parameters
            .iter()
            .filter_map(|p| p["name"].as_str())
            .collect();
        assert!(names.contains(&"start"), "{names:?}");
        assert!(names.contains(&"type"), "{names:?}");
    }

    #[test]
    fn item_routes_declare_a_path_parameter() {
        let document = document();
        let parameters = document["paths"]["/v1/transactions/{id}"]["get"]["parameters"]
            .as_array()
            .unwrap();
        assert_eq!(parameters[0]["name"], "id");
        assert_eq!(parameters[0]["in"], "path");

        let profile = &document["paths"]["/v1/profile-doc/{slug}"]["patch"];
        assert_eq!(profile["parameters"][0]["name"], "slug");
        assert!(
            profile["requestBody"]["content"]["application/json"]["schema"]["properties"]
                .get("slug")
                .is_none()
        );

        let delete = &document["paths"]["/v1/profile-doc/{slug}"]["delete"];
        let delete_body =
            &delete["requestBody"]["content"]["application/json"]["schema"]["properties"];
        assert!(delete_body["expected_version"].is_object());
        assert!(delete_body.get("slug").is_none());
    }

    /// 写操作的参数在请求体里，不在查询串里——服务端就是这么收的。
    #[test]
    fn write_params_live_in_the_request_body() {
        let document = document();
        let import = &document["paths"]["/v1/bills/{id}/import"]["post"];

        let schema = &import["requestBody"]["content"]["application/json"]["schema"];
        assert!(schema["properties"]["all"].is_object());
        assert!(schema["properties"]["row_ids"].is_object());
        // id 走路径，不该在请求体里再要一遍。
        assert!(schema["properties"].get("id").is_none());

        let query: Vec<&str> = import["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["in"] == "query")
            .filter_map(|p| p["name"].as_str())
            .collect();
        assert!(
            !query.contains(&"all"),
            "写参数不该出现在查询串里：{query:?}"
        );
    }

    /// 写闸门要出现在文档里，409 也是。
    #[test]
    fn the_write_gate_is_documented() {
        let document = document();
        let import = &document["paths"]["/v1/bills/{id}/import"]["post"];
        let names: Vec<&str> = import["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p["name"].as_str())
            .collect();
        assert!(names.contains(&"dry_run"), "{names:?}");
        assert!(names.contains(&"confirm"), "{names:?}");
        assert!(import["responses"]["409"].is_object());

        // 只读操作没有闸门，也不会 409。
        let list = &document["paths"]["/v1/bills"]["get"];
        assert!(list["responses"].get("409").is_none());
        assert!(list.get("requestBody").is_none());
    }

    #[test]
    fn queued_mailbox_sync_documents_accepted() {
        let document = document();
        let sync = &document["paths"]["/v1/bills/sync"]["post"];
        assert!(sync["responses"]["202"].is_object());
        assert!(sync["responses"]["200"].is_object());
    }

    #[test]
    fn mail_workbench_routes_are_documented() {
        let document = document();
        for (path, method) in [
            ("/v1/mail-messages", "get"),
            ("/v1/mail-messages/{id}/raw", "get"),
            ("/v1/mail-rules/test", "post"),
            ("/v1/mail-rules/{id}/publish", "post"),
            ("/v1/mail-sync-runs/{id}", "get"),
            ("/v1/mail-sync-runs/{id}/cancel", "post"),
        ] {
            assert!(
                document["paths"][path][method].is_object(),
                "{method} {path}"
            );
        }
        assert_eq!(
            document["paths"]["/v1/mail-rules/{id}/publish"]["post"]["x-abei-risk"],
            "confirm"
        );
        assert_eq!(
            document["paths"]["/v1/mail-rules/test"]["post"]["x-abei-risk"],
            "read"
        );
        assert!(document["paths"]["/v1/mail-rules/test"]["post"]["requestBody"].is_object());
        assert_eq!(
            document["paths"]["/v1/mail-messages/{id}/raw"]["get"]["responses"]["200"]["content"]
                .as_object()
                .unwrap()
                .keys()
                .next()
                .unwrap(),
            "message/rfc822"
        );
    }

    #[test]
    fn creates_document_created_and_dry_run_statuses() {
        let document = document();
        let create = &document["paths"]["/v1/feedback"]["post"];
        assert!(create["responses"]["200"].is_object());
        assert!(create["responses"]["201"].is_object());
        assert!(create["responses"]["202"].is_object());
        let schema = &create["requestBody"]["content"]["application/json"]["schema"];
        assert!(schema["properties"]["idempotency_key"].is_object());
        assert!(schema["properties"]["submitted_via"].is_object());
        assert!(schema["properties"]["context"].is_object());
        assert!(
            schema["properties"]["context"]["properties"]["recent"]["properties"]["error_code"]
                .is_object()
        );
        assert!(
            schema["required"]
                .as_array()
                .unwrap()
                .iter()
                .any(|field| field == "idempotency_key")
        );
    }

    #[test]
    fn session_and_feedback_admin_routes_are_documented() {
        let document = document();
        assert_eq!(
            document["paths"]["/v1/session"]["get"]["operationId"],
            "session.get"
        );
        for (path, method) in [
            ("/v1/admin/feedback/submissions", "get"),
            ("/v1/admin/feedback/submissions/{id}", "get"),
            ("/v1/admin/feedback/submissions/{id}/link", "post"),
            ("/v1/admin/feedback/items", "get"),
            ("/v1/admin/feedback/items/{id}", "patch"),
            ("/v1/admin/feedback/items/{id}/merge", "post"),
            ("/v1/admin/feedback/items/{id}/archive", "post"),
            ("/v1/admin/feedback/items/{id}/restore", "post"),
        ] {
            assert!(
                document["paths"][path][method].is_object(),
                "{method} {path}"
            );
        }
    }

    #[test]
    fn internal_firefly_proxy_is_not_advertised() {
        let document = document();
        assert!(document["paths"].get("/v1/firefly/{path}").is_none());
    }

    /// 签进仓库的 `abei/openapi.json` 必须与代码一致。
    ///
    /// web 端从这个文件生成 TS 类型和 Zod 校验，生成时服务不一定在跑；文件一旦过期，
    /// 网页端就会照着一份不存在的契约写代码。改了目录忘了重导出，这条测试当场红。
    /// 重新生成：`cargo run -p abei-api -- --dump-openapi openapi.json`（在 `abei/` 下），
    /// 或 `ABEI_UPDATE_OPENAPI=1 cargo test -p abei-api`。
    #[test]
    fn the_checked_in_document_is_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../openapi.json");
        let expected = document_text();

        if std::env::var_os("ABEI_UPDATE_OPENAPI").is_some() {
            std::fs::write(&path, &expected).expect("写不出 openapi.json");
            return;
        }

        let actual = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            actual, expected,
            "abei/openapi.json 与代码不一致。重新生成：\
             在 abei/ 下跑 `cargo run -p abei-api -- --dump-openapi openapi.json`"
        );
    }

    /// 目录已经把 `$ref` 摊平了，文档里不该再出现引用。
    #[test]
    fn the_document_carries_no_dangling_refs() {
        let text = document().to_string();
        assert!(!text.contains("$ref"), "文档里还有 $ref");
        assert!(!text.contains("$defs"), "文档里还有 $defs");
    }
}
