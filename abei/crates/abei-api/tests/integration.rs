//! 端到端测试。Firefly 用假服务顶替，不依赖本机真的跑着 Firefly。
//!
//! 假上游和起服务的代码在 abei_api::testkit 里，abei-cli 的端到端测试吃的是同一份。

use abei_api::config::Config;
use abei_api::state::AppState;
use abei_api::testkit::{
    GOOD_TOKEN, Recorder, mock_firefly, spawn, start_api, start_api_recording,
};
use axum::http::{Method, StatusCode};
use serde_json::{Value, json};

struct Harness {
    base: String,
    client: reqwest::Client,
    /// 假上游收到的写请求。断言「到底发了什么出去」用，读测试用不上。
    sent: Recorder,
}

impl Harness {
    async fn start() -> Self {
        Self {
            base: start_api().await,
            client: reqwest::Client::new(),
            sent: Recorder::default(),
        }
    }

    /// 起一套会记录上游写请求的。
    async fn recording() -> Self {
        let sent = Recorder::default();
        Self {
            base: start_api_recording(sent.clone()).await,
            client: reqwest::Client::new(),
            sent,
        }
    }

    async fn get(&self, path: &str) -> reqwest::Response {
        self.client
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .unwrap()
    }

    async fn get_auth(&self, path: &str) -> reqwest::Response {
        self.send(Method::GET, path, None).await
    }

    async fn post(&self, path: &str, body: Value) -> reqwest::Response {
        self.send(Method::POST, path, Some(body)).await
    }

    async fn patch(&self, path: &str, body: Value) -> reqwest::Response {
        self.send(Method::PATCH, path, Some(body)).await
    }

    async fn put(&self, path: &str, body: Value) -> reqwest::Response {
        self.send(Method::PUT, path, Some(body)).await
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>) -> reqwest::Response {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(GOOD_TOKEN);
        if let Some(body) = body {
            request = request.json(&body);
        }
        request.send().await.unwrap()
    }

    /// 上游收到的某个请求体。没收到就是 None。
    fn upstream(&self, marker: &str) -> Option<Value> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .find(|(where_to, _)| where_to.contains(marker))
            .map(|(_, body)| body.clone())
    }

    fn upstream_calls(&self) -> usize {
        self.sent.lock().unwrap().len()
    }

    fn upstream_count(&self, marker: &str) -> usize {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .filter(|(where_to, _)| where_to.contains(marker))
            .count()
    }
}

#[tokio::test]
async fn health_needs_no_token() {
    let harness = Harness::start().await;
    let response = harness.get("/health").await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["service"], "abei-api");
    assert_eq!(body["web_url"], "http://127.0.0.1:18004");
}

#[tokio::test]
async fn openapi_needs_no_token_and_is_generated_from_the_catalog() {
    let harness = Harness::start().await;
    let response = harness.get("/v1/openapi.json").await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["openapi"], "3.1.0");
    assert_eq!(
        body["paths"]["/v1/transactions/summary"]["get"]["operationId"],
        "transactions.summary"
    );
}

#[tokio::test]
async fn missing_token_is_a_problem_json() {
    let harness = Harness::start().await;
    let response = harness.get("/v1/catalog").await;
    assert_eq!(response.status(), 401);
    assert_eq!(
        response.headers()["content-type"],
        "application/problem+json"
    );
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["reason"], "MissingToken");
    assert_eq!(body["status"], 401);
    assert!(body["type"].as_str().unwrap().ends_with("missing-token"));
}

#[tokio::test]
async fn firefly_rejecting_the_token_becomes_invalid_token() {
    let harness = Harness::start().await;
    let response = harness
        .client
        .get(format!("{}/v1/catalog", harness.base))
        .bearer_auth("wrong")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["reason"], "InvalidToken");
}

#[tokio::test]
async fn catalog_serves_the_whole_capability_list() {
    let harness = Harness::start().await;
    let response = harness.get_auth("/v1/catalog").await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();

    let capabilities = body["capabilities"].as_array().unwrap();
    assert_eq!(
        capabilities.len(),
        abei_core::catalog().capabilities().len()
    );

    let summary = capabilities
        .iter()
        .find(|c| c["id"] == "transactions.summary")
        .unwrap();
    assert_eq!(summary["label"], "汇总消费");
    assert_eq!(summary["risk"], "read");
    assert_eq!(summary["backend"], "firefly");
    assert_eq!(summary["tool_name"], "transactions_summary");
    assert_eq!(summary["command"][0], "transactions");
    assert!(summary["params"]["properties"]["start"].is_object());
    assert!(!summary["examples"].as_array().unwrap().is_empty());

    let feedback = capabilities
        .iter()
        .find(|c| c["id"] == "feedback.create")
        .unwrap();
    assert!(feedback["fixed_params"].as_object().unwrap().is_empty());
    assert_eq!(feedback["risk"], "draft");
    assert_eq!(feedback["params"]["required"], json!(["kind", "message"]));

    assert!(
        body["resources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["name"] == "transactions")
    );
}

/// 目录里的每条能力都必须真的挂上了路由，方法也要对得上。
///
/// 只看「挂没挂上」：API fallback 的 404 说明路径没挂，资源不存在的 404 是合法业务
/// 响应；405 说明方法挂错。参数校验不合格（400）不算漂移。
#[tokio::test]
async fn every_capability_route_is_mounted() {
    let harness = Harness::start().await;
    for capability in abei_core::catalog().capabilities() {
        let path = capability.path_param().map_or_else(
            || capability.route_path(),
            |name| capability.route_path().replace(&format!("{{{name}}}"), "1"),
        );
        // 写能力一律带 dry_run，探活不该真改数据。
        let probe = if capability.risk.is_write() {
            format!("{path}?dry_run=true")
        } else {
            path.clone()
        };
        let method = match capability.method() {
            abei_core::Method::Get => Method::GET,
            abei_core::Method::Post => Method::POST,
            abei_core::Method::Patch => Method::PATCH,
            abei_core::Method::Delete => Method::DELETE,
            abei_core::Method::Put => Method::PUT,
        };
        let response = harness.send(method, &probe, Some(json!({}))).await;
        let status = response.status();

        assert_ne!(
            status,
            StatusCode::METHOD_NOT_ALLOWED,
            "{} 挂在 {path} 上的方法不是 {:?}",
            capability.id(),
            capability.method()
        );
        if status == StatusCode::NOT_FOUND {
            let body = response.text().await.unwrap_or_default();
            assert!(
                !body.contains("没有这个接口"),
                "{} 的路由 {path} 没挂上",
                capability.id()
            );
        }
    }
}

#[tokio::test]
async fn bills_list_reaches_firefly() {
    let harness = Harness::start().await;
    let response = harness.get_auth("/v1/bills?status=pending").await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["data"][0]["attributes"]["source"], "alipay");
}

#[tokio::test]
async fn bills_review_returns_the_groups() {
    let harness = Harness::start().await;
    let response = harness.get_auth("/v1/bills/42/review").await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert!(body["data"]["groups"]["attention"].is_array());
}

#[tokio::test]
async fn bills_review_detects_the_existing_withdrawal_combination() {
    let harness = Harness::start().await;
    let response = harness.get_auth("/v1/bills/53/review").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();

    assert_eq!(body["summary"]["new"], 0);
    assert_eq!(body["summary"]["attention"], 1);
    assert!(body["new_candidates"].as_array().unwrap().is_empty());
    assert_eq!(body["existing_candidates"][0]["row_id"], "802");
    assert!(
        body["data"]["groups"]["importable"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let row = &body["data"]["groups"]["attention"][0];
    assert_eq!(row["id"], "802");
    assert_eq!(row["attributes"]["group"], "attention");
    assert_eq!(
        row["attributes"]["issues"][0]["code"],
        "existing_firefly_transaction"
    );
    let candidate = &row["attributes"]["existing_transaction_candidates"][0];
    assert_eq!(candidate["confidence"], "high");
    assert_eq!(candidate["match_kind"], "same_day_combination");
    assert_eq!(candidate["transaction_group_ids"], json!(["397", "398"]));
    assert_eq!(candidate["amount"], "2952.95");
    assert_eq!(candidate["currency_code"], "CNY");
}

#[tokio::test]
async fn bills_sync_preserves_the_upstream_accepted_status() {
    let harness = Harness::start().await;
    let response = harness.post("/v1/bills/sync", json!({ "limit": 10 })).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["data"]["attributes"]["status"], "queued");
    assert_eq!(body["data"]["attributes"]["authenticated_user_id"], "1");
}

#[tokio::test]
async fn bills_sync_can_wait_for_final_counts() {
    let harness = Harness::start().await;
    let response = harness
        .post(
            "/v1/bills/sync",
            json!({ "limit": 10, "wait": true, "timeout_seconds": 2 }),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["data"]["attributes"]["status"], "succeeded");
    assert_eq!(body["data"]["attributes"]["counts"]["matched"], 2);
}

#[tokio::test]
async fn bills_sync_wait_reports_failed_and_cancelled_runs() {
    for (limit, expected_status) in [(98, "failed"), (99, "cancelled")] {
        let harness = Harness::start().await;
        let response = harness
            .post(
                "/v1/bills/sync",
                json!({ "limit": limit, "wait": true, "timeout_seconds": 2 }),
            )
            .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["reason"], "SyncFailed");
        assert_eq!(
            body["upstream"]["data"]["attributes"]["status"],
            expected_status
        );
    }
}

#[tokio::test]
async fn bills_sync_wait_rejects_timeout_values_outside_the_contract() {
    for timeout in [0, 601] {
        let harness = Harness::start().await;
        let response = harness
            .post(
                "/v1/bills/sync",
                json!({ "limit": 10, "wait": true, "timeout_seconds": timeout }),
            )
            .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["reason"], "InvalidParams");
        assert!(body["detail"].as_str().unwrap().contains("1 到 600"));
    }
}

#[tokio::test]
async fn bills_sync_wait_times_out_without_cancelling_the_run() {
    let harness = Harness::start().await;
    let response = harness
        .post(
            "/v1/bills/sync",
            json!({ "limit": 100, "wait": true, "timeout_seconds": 1 }),
        )
        .await;
    assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["reason"], "SyncTimeout");
    assert_eq!(body["upstream"]["data"]["attributes"]["status"], "running");
}

#[tokio::test]
async fn mailbox_settings_use_the_verified_user_id() {
    let harness = Harness::start().await;
    let response = harness
        .client
        .get(format!("{}/v1/bills/mailbox", harness.base))
        .bearer_auth(GOOD_TOKEN)
        .header("x-abei-authenticated-user-id", "999")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["data"]["attributes"]["authenticated_user_id"], "1");

    let response = harness
        .send(
            Method::PUT,
            "/v1/bills/mailbox",
            Some(json!({ "enabled": true, "email": "bills@example.com", "password": "secret" })),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["data"]["attributes"]["email"], "bills@example.com");
    assert_eq!(body["data"]["attributes"]["has_password"], true);
}

#[tokio::test]
async fn google_oauth_routes_use_the_verified_user_id() {
    let harness = Harness::start().await;
    let response = harness
        .post("/v1/bills/mailbox/google/connect", json!({}))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["data"]["attributes"]["authenticated_user_id"], "1");

    let response = harness
        .post(
            "/v1/bills/mailbox/google/callback",
            json!({ "code": "code", "state": "state" }),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["data"]["attributes"]["code"], "code");
    assert_eq!(body["data"]["attributes"]["authenticated_user_id"], "1");

    let response = harness
        .client
        .delete(format!("{}/v1/bills/mailbox/google", harness.base))
        .bearer_auth(GOOD_TOKEN)
        .header("x-abei-authenticated-user-id", "999")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["data"]["attributes"]["authenticated_user_id"], "1");
}

/// confirm 档的能力，不带确认参数就该被挡在服务端——CLI 的 --yes 只是本地礼貌，
/// 真正拦住的是这一道。
#[tokio::test]
async fn confirm_capabilities_are_blocked_without_confirmation() {
    let harness = Harness::recording().await;
    let response = harness
        .post("/v1/bills/42/import", json!({ "all": true }))
        .await;

    assert_eq!(response.status(), 409);
    assert_eq!(
        response.headers()["content-type"],
        "application/problem+json"
    );
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["reason"], "ConfirmationRequired");
    assert_eq!(body["resource"], "bills");
    assert_eq!(body["verb"], "import");
    let detail = body["detail"].as_str().unwrap();
    assert!(detail.contains("dry_run"), "{detail}");
    assert!(detail.contains("--yes"), "{detail}");

    // 被挡下就不该有任何东西发给上游。
    assert_eq!(harness.upstream_calls(), 0);
}

/// 干跑只向 Server 准备预览，不向 Firefly 写交易，也不创建导入尝试。
#[tokio::test]
async fn dry_run_import_previews_without_committing() {
    let harness = Harness::recording().await;
    let response = harness
        .post("/v1/bills/42/import?dry_run=true", json!({ "all": true }))
        .await;

    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["dry_run"], true, "预览要打记号，免得被当成已执行");
    assert_eq!(body["summary"]["would_import"], 2);
    assert_eq!(body["summary"]["imported"], 0);
    assert_eq!(body["rows"].as_array().unwrap().len(), 2);
    assert!(body["rows"][0]["attempt_id"].is_null());

    let sent = harness
        .upstream("/internal/v1/bill-imports/prepare")
        .unwrap();
    assert_eq!(sent["dry_run"], true);
    assert!(harness.upstream("/api/v1/transactions").is_none());
}

#[tokio::test]
async fn dry_run_import_explains_the_existing_transaction_exclusion() {
    let harness = Harness::recording().await;
    let response = harness
        .post(
            "/v1/bills/53/import?dry_run=true",
            json!({ "all": true, "include_payload": true }),
        )
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["summary"]["total"], 1);
    assert_eq!(body["summary"]["would_import"], 0);
    assert_eq!(body["summary"]["skipped"], 1);
    assert_eq!(body["rows"][0]["row_id"], "802");
    assert_eq!(
        body["rows"][0]["reason_code"],
        "existing_firefly_transaction"
    );
    assert!(
        body["rows"][0]["exclusion_reason"]
            .as_str()
            .unwrap()
            .contains("已有高置信")
    );
    assert_eq!(
        body["rows"][0]["existing_transaction_candidates"][0]["transaction_group_ids"],
        json!(["397", "398"])
    );
    assert!(body["rows"][0]["payload"].is_object());
    assert_eq!(harness.upstream_count("POST /api/v1/transactions"), 0);
}

#[tokio::test]
async fn confirmed_import_commits_upstream() {
    let harness = Harness::recording().await;
    let response = harness
        .post("/v1/bills/42/import?confirm=true", json!({ "all": true }))
        .await;

    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert!(body.get("dry_run").is_none(), "真跑不该打预览记号");
    assert_eq!(body["summary"]["imported"], 2);
    assert_eq!(body["summary"]["uncertain"], 0);

    assert_eq!(
        harness
            .upstream("/internal/v1/bill-imports/prepare")
            .unwrap()["dry_run"],
        false
    );
    assert!(harness.upstream("/api/v1/transactions").is_some());
    assert!(harness.upstream("/complete").is_some());
}

#[tokio::test]
async fn confirmed_import_rechecks_existing_transactions_before_sending() {
    let harness = Harness::recording().await;
    let response = harness
        .post("/v1/bills/53/import?confirm=true", json!({ "all": true }))
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["summary"]["imported"], 0);
    assert_eq!(body["summary"]["skipped"], 1);
    assert_eq!(
        body["rows"][0]["reason_code"],
        "existing_firefly_transaction"
    );
    assert_eq!(harness.upstream_count("POST /api/v1/transactions"), 0);
    assert_eq!(harness.upstream_count("mark-sending"), 0);
    assert_eq!(harness.upstream_count("/reject"), 1);
}

#[tokio::test]
async fn account_mapping_is_verified_then_saved_in_server() {
    let harness = Harness::recording().await;
    let response = harness
        .put(
            "/v1/bill-account-mappings",
            json!({
                "channel_key": "cmb",
                "account_hint": "招商银行信用卡(5599)",
                "firefly_account_id": 10
            }),
        )
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    let sent = harness.upstream("PUT /v1/bill-account-mappings").unwrap();
    assert_eq!(sent["firefly_account_id"], 10);
    assert_eq!(sent["firefly_account_name"], "招行卡");
    assert_eq!(sent["firefly_account_type"], "asset");
}

#[tokio::test]
async fn uncertain_import_can_be_reconciled_by_external_id() {
    let harness = Harness::recording().await;
    let attempt_id = "00000000-0000-0000-0000-000000000001";
    let response = harness
        .post(
            &format!("/v1/bill-import-attempts/{attempt_id}/reconcile"),
            json!({}),
        )
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["match_count"], 1);
    assert_eq!(body["data"]["status"], "succeeded");
    assert_eq!(
        harness.upstream("/complete").unwrap()["transaction_group_id"],
        9
    );
}

#[tokio::test]
async fn retryable_import_runs_the_new_import_protocol() {
    let harness = Harness::recording().await;
    let attempt_id = "00000000-0000-0000-0000-000000000002";
    let response = harness
        .post(
            &format!("/v1/bill-import-attempts/{attempt_id}/retry?confirm=true"),
            json!({}),
        )
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["summary"]["imported"], 1);
    assert!(
        harness
            .upstream("/internal/v1/bill-imports/prepare")
            .is_some()
    );
    assert!(harness.upstream("/api/v1/transactions").is_some());
    assert!(harness.upstream("/complete").is_some());
}

/// 导入要么整份要么挑行，两个都给或都不给都是参数错。
#[tokio::test]
async fn import_needs_exactly_one_of_all_or_row_ids() {
    let harness = Harness::recording().await;
    for body in [json!({}), json!({ "all": true, "row_ids": [1, 2] })] {
        let response = harness.post("/v1/bills/42/import?confirm=true", body).await;
        assert_eq!(response.status(), 400);
        let problem: Value = response.json().await.unwrap();
        assert_eq!(problem["reason"], "InvalidParams");
    }
    assert_eq!(harness.upstream_calls(), 0);
}

/// 干跑不把密码递给上游。密码只在真执行那一次经手。
#[tokio::test]
async fn unlock_dry_run_never_forwards_the_password() {
    let harness = Harness::recording().await;
    let response = harness
        .post(
            "/v1/bills/43/unlock?dry_run=true",
            json!({ "secret": "hunter2" }),
        )
        .await;

    assert_eq!(response.status(), 200);
    let text = response.text().await.unwrap();
    assert!(!text.contains("hunter2"), "密码不能回显：{text}");
    assert_eq!(harness.upstream_calls(), 0, "干跑不该打到上游");
}

#[tokio::test]
async fn confirmed_unlock_forwards_the_password_once() {
    let harness = Harness::recording().await;
    let response = harness
        .post(
            "/v1/bills/43/unlock?confirm=true",
            json!({ "secret": "hunter2" }),
        )
        .await;

    assert_eq!(response.status(), 200);
    assert_eq!(
        harness.upstream("/v1/bills/43/unlock").unwrap()["secret"],
        "hunter2"
    );
    assert_eq!(harness.upstream_calls(), 1);
}

#[tokio::test]
async fn unlock_rejects_an_empty_password() {
    let harness = Harness::recording().await;
    let response = harness
        .post("/v1/bills/43/unlock?confirm=true", json!({ "secret": "" }))
        .await;
    assert_eq!(response.status(), 400);
    assert_eq!(harness.upstream_calls(), 0);
}

/// draft 档不用确认参数就能过服务端（CLI 那边仍要 --yes）。
#[tokio::test]
async fn draft_capabilities_pass_without_confirmation() {
    let harness = Harness::recording().await;
    let response = harness.post("/v1/bills/42/retry", json!({})).await;
    assert_eq!(response.status(), 200);
    assert!(harness.upstream("/v1/bills/42/retry").is_some());
}

/// 机器写入永远记成建议，调用方说了不算。
#[tokio::test]
async fn row_updates_are_always_recorded_as_suggestions() {
    let harness = Harness::recording().await;
    let response = harness
        .patch(
            "/v1/bill-rows/7",
            json!({ "category_name": "餐饮", "firefly_type": "withdrawal" }),
        )
        .await;

    assert_eq!(response.status(), 200);
    let sent = harness.upstream("/v1/bill-rows/7").unwrap();
    assert_eq!(sent["as_suggestion"], true);
    assert_eq!(sent["category_name"], "餐饮");
}

#[tokio::test]
async fn row_batch_updates_use_the_explicit_route_and_keep_account_ids() {
    let harness = Harness::recording().await;
    let response = harness
        .patch(
            "/v1/bill-rows/update-many",
            json!({
                "row_ids": [8, 7, 7],
                "firefly_type": "transfer",
                "source_account_id": 10,
                "destination_account_id": 11,
                "category_name": "内部转账"
            }),
        )
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["affected_count"], 2);
    let sent = harness.upstream("PATCH /v1/bill-rows/update-many").unwrap();
    assert_eq!(sent["row_ids"], json!([7, 8]));
    assert_eq!(sent["values"]["as_suggestion"], true);
    assert_eq!(sent["values"]["source_account_id"], 10);
    assert_eq!(sent["values"]["destination_account_id"], 11);
    assert_eq!(harness.upstream_count("PATCH /v1/bill-rows/update-many"), 1);
    assert_eq!(
        harness.upstream_count("PATCH /v1/bill-rows/update-many/"),
        0
    );
}

#[tokio::test]
async fn row_batch_update_dry_run_returns_real_affected_ids() {
    let harness = Harness::recording().await;
    let response = harness
        .patch(
            "/v1/bill-rows/update-many?dry_run=true",
            json!({ "row_ids": [8, 7, 7], "category_name": "餐饮" }),
        )
        .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["dry_run"], true);
    assert_eq!(body["would"]["row_ids"], json!([7, 8]));
    assert_eq!(body["would"]["affected_count"], 2);
}

#[tokio::test]
async fn row_batch_updates_reject_non_positive_ids_and_invalid_values() {
    let harness = Harness::recording().await;
    for body in [
        json!({ "row_ids": [0, 7], "category_name": "餐饮" }),
        json!({ "row_ids": [7], "firefly_type": "spending" }),
        json!({ "row_ids": [7], "firefly_date": "2026-7-1" }),
        json!({ "row_ids": [7], "firefly_amount": "0" }),
        json!({ "row_ids": [7], "source_account_id": 0 }),
    ] {
        let response = harness.patch("/v1/bill-rows/update-many", body).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    assert_eq!(harness.upstream_calls(), 0);
}

#[tokio::test]
async fn row_dismiss_forwards_reason_and_dry_run_count() {
    let harness = Harness::recording().await;
    let response = harness
        .post(
            "/v1/bill-rows/dismiss?dry_run=true",
            json!({ "row_ids": [7, 8], "reason": "账单外消费" }),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["would"]["affected_count"], 2);
    assert_eq!(body["would"]["row_ids"], json!([7, 8]));
    assert_eq!(
        harness.upstream("POST /v1/bill-rows/dismiss").unwrap()["reason"],
        "账单外消费"
    );
}

/// 银行原文和 as_suggestion 都不给调用方碰，拼错的字段也不能被悄悄丢掉。
#[tokio::test]
async fn row_updates_refuse_fields_that_are_not_theirs() {
    let harness = Harness::recording().await;
    for body in [
        json!({ "occurred_at": "2026-07-15" }),
        json!({ "counterparty": "改一下" }),
        json!({ "amount": "999.00" }),
        json!({ "as_suggestion": false }),
        json!({ "categry_name": "餐饮" }),
    ] {
        let response = harness.patch("/v1/bill-rows/7", body.clone()).await;
        assert_eq!(response.status(), 400, "{body} 不该被接受");
        let problem: Value = response.json().await.unwrap();
        assert_eq!(problem["reason"], "InvalidParams");
    }
    assert_eq!(harness.upstream_calls(), 0);
}

#[tokio::test]
async fn row_updates_need_at_least_one_field() {
    let harness = Harness::recording().await;
    let response = harness.patch("/v1/bill-rows/7", json!({})).await;
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert!(
        body["detail"].as_str().unwrap().contains("--firefly-type"),
        "报错要提示能填什么：{body}"
    );
}

#[tokio::test]
async fn row_updates_validate_the_type_and_date() {
    let harness = Harness::recording().await;

    let response = harness
        .patch("/v1/bill-rows/7", json!({ "firefly_type": "spending" }))
        .await;
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert!(body["detail"].as_str().unwrap().contains("withdrawal"));

    let response = harness
        .patch("/v1/bill-rows/7", json!({ "firefly_date": "2026-7-1" }))
        .await;
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["reason"], "InvalidDate");

    assert_eq!(harness.upstream_calls(), 0);
}

#[tokio::test]
async fn splitting_needs_at_least_two_positive_parts() {
    let harness = Harness::recording().await;

    let one = json!({ "splits": [{ "amount": "45.00", "description": "只有一笔" }] });
    assert_eq!(
        harness.post("/v1/bill-rows/7/split", one).await.status(),
        400
    );

    let zero = json!({ "splits": [
        { "amount": "0.00", "description": "零" },
        { "amount": "45.00", "description": "正常" }
    ]});
    assert_eq!(
        harness.post("/v1/bill-rows/7/split", zero).await.status(),
        400
    );
    assert_eq!(harness.upstream_calls(), 0);

    let good = json!({ "splits": [
        { "amount": "20.00", "description": "菜" },
        { "amount": "25.00", "description": "酒" }
    ]});
    let response = harness.post("/v1/bill-rows/7/split", good).await;
    assert_eq!(response.status(), 200);
    let sent = harness.upstream("/v1/bill-rows/7/split").unwrap();
    assert_eq!(sent["splits"].as_array().unwrap().len(), 2);
}

/// id 不是正整数就地挡掉，不让上游回一个含糊的 404。
#[tokio::test]
async fn write_routes_validate_the_id_before_the_gate() {
    let harness = Harness::recording().await;
    let response = harness
        .post("/v1/bills/abc/import?confirm=true", json!({ "all": true }))
        .await;
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["resource"], "bills");
    assert_eq!(body["verb"], "import");
    assert_eq!(harness.upstream_calls(), 0);
}

#[tokio::test]
async fn transactions_list_reaches_firefly() {
    let harness = Harness::start().await;
    let response = harness
        .get_auth("/v1/transactions?start=2026-08-01&end=2026-08-31&type=withdrawal")
        .await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["meta"]["pagination"]["count"], 2);
}

#[tokio::test]
async fn unknown_query_field_is_rejected_with_a_hint() {
    let harness = Harness::start().await;
    let response = harness.get_auth("/v1/transactions?strat=2026-08-01").await;
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["reason"], "InvalidParams");
    let detail = body["detail"].as_str().unwrap();
    assert!(detail.contains("strat"), "报错要点名拼错的字段：{detail}");
    assert!(detail.contains("start"), "报错要给出正确字段：{detail}");
}

#[tokio::test]
async fn bad_date_is_rejected_before_reaching_firefly() {
    let harness = Harness::start().await;
    let response = harness.get_auth("/v1/transactions?start=2026-8-1").await;
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["reason"], "InvalidDate");
    assert!(body["detail"].as_str().unwrap().contains("YYYY-MM-DD"));
}

#[tokio::test]
async fn bad_enum_lists_the_allowed_values() {
    let harness = Harness::start().await;
    let response = harness.get_auth("/v1/transactions?type=spending").await;
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["reason"], "InvalidParams");
    assert!(body["detail"].as_str().unwrap().contains("withdrawal"));
}

#[tokio::test]
async fn transactions_show_validates_the_id() {
    let harness = Harness::start().await;
    let response = harness.get_auth("/v1/transactions/abc").await;
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["reason"], "InvalidParams");
    assert_eq!(body["resource"], "transactions");
    assert_eq!(body["verb"], "show");
}

#[tokio::test]
async fn search_reaches_fireflys_full_text_endpoint() {
    let harness = Harness::start().await;
    let response = harness
        .get_auth("/v1/transactions/search?query=星巴克")
        .await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    // 假上游把搜索词回显进摘要，能读到就说明词确实转发出去了。
    assert_eq!(
        body["data"][0]["attributes"]["transactions"][0]["description"],
        "在星巴克消费"
    );
}

/// `/v1/transactions/search` 必须排在 `/v1/transactions/{id}` 前面，
/// 否则 search 会被当成 id 走进 show，报一个「id 得是正整数」的怪错。
#[tokio::test]
async fn search_is_not_swallowed_by_the_id_route() {
    let harness = Harness::start().await;
    let response = harness
        .get_auth("/v1/transactions/search?query=星巴克")
        .await;
    assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn search_needs_something_to_search_for() {
    let harness = Harness::start().await;
    for path in [
        "/v1/transactions/search",
        "/v1/transactions/search?query=",
        "/v1/transactions/search?query=%20%20",
    ] {
        let response = harness.get_auth(path).await;
        assert_eq!(response.status(), 400, "{path}");
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["reason"], "InvalidParams", "{path}");
    }
}

/// 上游限 500 字，就地挡掉，别换回一个含糊的 422。
#[tokio::test]
async fn search_terms_have_a_ceiling() {
    let harness = Harness::start().await;
    let long = "星".repeat(501);
    let response = harness
        .get_auth(&format!("/v1/transactions/search?query={long}"))
        .await;
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["reason"], "InvalidParams");
    assert_eq!(body["resource"], "transactions");
    assert_eq!(body["verb"], "search");
    // 按字数算，不是按字节：500 个汉字得放行。
    let ok = "星".repeat(500);
    let response = harness
        .get_auth(&format!("/v1/transactions/search?query={ok}"))
        .await;
    assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn summary_aggregates_what_firefly_returned() {
    let harness = Harness::start().await;
    let response = harness
        .get_auth("/v1/transactions/summary?start=2026-08-01&end=2026-08-31")
        .await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();

    assert_eq!(body["totals"]["count"], 2);
    // 3000 那笔是「账户转账」，默认不算日常消费。
    assert_eq!(body["daily_consumption"]["count"], 1);
    assert_eq!(body["daily_consumption"]["total"], "45.00");
    assert_eq!(body["top_categories"][0]["name"], "餐饮");
    assert_eq!(body["range"]["start"], "2026-08-01");
}

#[tokio::test]
async fn summary_takes_extra_excluded_categories() {
    let harness = Harness::start().await;
    let response = harness
        .get_auth("/v1/transactions/summary?exclude_category=餐饮")
        .await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["daily_consumption"]["count"], 0);
}

#[tokio::test]
async fn accounts_list_reaches_firefly() {
    let harness = Harness::start().await;
    let response = harness.get_auth("/v1/accounts?type=asset").await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["data"][0]["attributes"]["name"], "招行卡");
}

#[tokio::test]
async fn proxy_forwards_to_firefly() {
    let harness = Harness::start().await;
    let response = harness.get_auth("/v1/firefly/api/v1/about").await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["data"]["version"], "6.0.0");
}

#[tokio::test]
async fn proxy_still_requires_a_token() {
    let harness = Harness::start().await;
    let response = harness.get("/v1/firefly/api/v1/about").await;
    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn feedback_proxy_preserves_submission_confirmation_and_reply_semantics() {
    let harness = Harness::start().await;
    let feedback = json!({
        "kind": "bug",
        "target": "cli",
        "message": "账单导入后没有结果",
        "submitted_via": "cli",
        "idempotency_key": "api-test-1",
        "context": { "cli_version": "test" }
    });

    let response = harness
        .post("/v1/feedback?dry_run=true", feedback.clone())
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["dry_run"], true);

    let response = harness.get_auth("/v1/feedback").await;
    let body: Value = response.json().await.unwrap();
    assert!(body["data"].as_array().unwrap().is_empty());

    let response = harness.post("/v1/feedback", feedback).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let first: Value = response.json().await.unwrap();
    assert_eq!(first["submission_id"], 1);
    assert_eq!(first["feedback_id"], 1);
    assert_eq!(first["occurrences"], 1);

    let response = harness.get_auth("/v1/feedback/1").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["data"]["title"], "账单导入后没有结果");

    let response = harness
        .post(
            "/v1/feedback",
            json!({
                "kind": "bug",
                "target": "cli",
                "message": "导入账单一直没有结果",
                "submitted_via": "web",
                "idempotency_key": "api-test-2",
                "context": {}
            }),
        )
        .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let pending: Value = response.json().await.unwrap();
    assert_eq!(pending["state"], "needs_confirmation");
    assert_eq!(pending["candidates"][0]["feedback_id"], 1);

    let response = harness
        .post(
            "/v1/feedback/submissions/2/confirm",
            json!({ "same_as": 1 }),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let linked: Value = response.json().await.unwrap();
    assert_eq!(linked["occurrences"], 2);

    let response = harness
        .post(
            "/v1/feedback/submissions/2/confirm",
            json!({ "same_as": 1 }),
        )
        .await;
    let repeated: Value = response.json().await.unwrap();
    assert_eq!(repeated["occurrences"], 2);

    let response = harness
        .post(
            "/v1/feedback/submissions/2/messages",
            json!({ "message": "补充：只在 0.2.0 出现" }),
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);

    let response = harness.get_auth("/v1/feedback/1").await;
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["messages"][0]["body"], "补充：只在 0.2.0 出现");
}

#[tokio::test]
async fn unavailable_feedback_server_is_a_plain_502() {
    let firefly = spawn(mock_firefly()).await;
    let config = Config {
        firefly_url: format!("http://{firefly}"),
        server_url: "http://127.0.0.1:1".to_owned(),
        ..Config::default()
    };
    let api = spawn(abei_api::build_app(AppState::new(&config).unwrap())).await;
    let response = reqwest::Client::new()
        .get(format!("http://{api}/v1/feedback"))
        .bearer_auth(GOOD_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 502);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["reason"], "ServerUnavailable");
    assert!(body["detail"].as_str().unwrap().contains("ABEI_SERVER_URL"));
}

#[tokio::test]
async fn unknown_route_points_at_the_catalog() {
    let harness = Harness::start().await;
    let response = harness.get_auth("/v1/nope").await;
    assert_eq!(response.status(), 404);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["reason"], "NotFound");
    assert!(body["detail"].as_str().unwrap().contains("/v1/catalog"));
}
