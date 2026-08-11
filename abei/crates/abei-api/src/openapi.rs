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

    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "阿贝 API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "资源接口与能力目录。账本操作在过渡期委托 Firefly III。",
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
    let has_id = capability.route_path().contains("{id}");
    let reading = matches!(capability.method(), Method::Get);
    let mut parameters = Vec::new();

    if has_id {
        parameters.push(json!({
            "name": "id",
            "in": "path",
            "required": true,
            "description": "对象 id，正整数。",
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
            if has_id && name == "id" {
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
        operation["requestBody"] = request_body(params, has_id);
        // confirm 档没带确认参数就是 409，得让生成的客户端知道这不是「失败」。
        operation["responses"]["409"] = problem_response();
    }

    if capability.verb == Verb::Create
        && let Some(responses) = operation["responses"].as_object_mut()
        && let Some(response) = responses.get("200").cloned()
    {
        responses.insert("201".to_owned(), response);
    }

    if capability.id() == "bills.sync"
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
fn request_body(params: &Value, has_id: bool) -> Value {
    let mut schema = params.clone();
    if has_id && let Some(object) = schema.as_object_mut() {
        if let Some(Value::Object(properties)) = object.get_mut("properties") {
            properties.remove("id");
        }
        if let Some(Value::Array(required)) = object.get_mut("required") {
            required.retain(|name| name.as_str() != Some("id"));
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

fn ok_response(description: &str) -> Value {
    json!({
        "description": description,
        "content": { "application/json": { "schema": { "type": "object" } } }
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
    fn creates_document_created_and_dry_run_statuses() {
        let document = document();
        let create = &document["paths"]["/v1/feedback"]["post"];
        assert!(create["responses"]["200"].is_object());
        assert!(create["responses"]["201"].is_object());
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
