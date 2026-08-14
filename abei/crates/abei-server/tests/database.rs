use abei_server::{create_pool, initialize};

#[tokio::test]
async fn schema_bootstrap_is_idempotent_when_test_database_is_configured() {
    let Ok(url) = std::env::var("ABEI_TEST_DATABASE_URL") else {
        return;
    };
    let pool = create_pool(url.parse().unwrap(), 1).unwrap();
    initialize(&pool).await.unwrap();
    initialize(&pool).await.unwrap();

    let client = pool.get().await.unwrap();
    for table in [
        "feedback",
        "feedback_events",
        "feedback_items",
        "feedback_submissions",
        "feedback_updates",
        "feedback_messages",
        "feedback_audit_events",
        "mail_rules",
        "mail_rule_versions",
        "mail_messages",
        "mail_samples",
        "mail_sync_runs",
        "parser_flows",
        "parser_flow_versions",
        "bill_documents",
        "parse_jobs",
        "bill_document_revisions",
        "bill_artifacts",
        "bill_rows",
        "bill_import_attempts",
    ] {
        let exists: bool = client
            .query_one(
                "SELECT to_regclass($1) IS NOT NULL",
                &[&format!("abei_ai.{table}")],
            )
            .await
            .unwrap()
            .get(0);
        assert!(exists, "abei_ai.{table} was not created");
    }
    let mailboxes_exist: bool = client
        .query_one("SELECT to_regclass('abei_ai.mailboxes') IS NOT NULL", &[])
        .await
        .unwrap()
        .get(0);
    assert!(mailboxes_exist);
    let oauth_states_exist: bool = client
        .query_one(
            "SELECT to_regclass('abei_ai.mailbox_oauth_states') IS NOT NULL",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(oauth_states_exist);
    // 旧账单迁移已取消，0007 把整套脚手架删干净了：不留列，也不留报告表。
    let legacy_columns: Vec<String> = client
        .query(
            "SELECT (table_name || '.' || column_name)::text
             FROM information_schema.columns
             WHERE table_schema = 'abei_ai' AND column_name LIKE 'legacy_bill_%'
             ORDER BY 1",
            &[],
        )
        .await
        .unwrap()
        .iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(legacy_columns, Vec::<String>::new());
    let legacy_runs_exist: bool = client
        .query_one(
            "SELECT to_regclass('abei_ai.legacy_bill_migration_runs') IS NOT NULL",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(!legacy_runs_exist);
    // 没了 legacy 列兜底，邮件必须挂在某个邮箱上。
    let mailbox_user_id_nullable: String = client
        .query_one(
            "SELECT is_nullable::text FROM information_schema.columns
             WHERE table_schema = 'abei_ai' AND table_name = 'mail_messages'
               AND column_name = 'mailbox_user_id'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(mailbox_user_id_nullable, "NO");
    for table in ["profile_docs", "profile_doc_revisions"] {
        let exists: bool = client
            .query_one(
                "SELECT to_regclass($1) IS NOT NULL",
                &[&format!("abei_ai.{table}")],
            )
            .await
            .unwrap()
            .get(0);
        assert!(exists, "abei_ai.{table} was not created");
    }
    let columns: Vec<String> = client
        .query(
            "SELECT column_name::text FROM information_schema.columns \
             WHERE table_schema = 'abei_ai' AND table_name = 'feedback'",
            &[],
        )
        .await
        .unwrap()
        .iter()
        .map(|row| row.get(0))
        .collect();
    for expected in ["status", "response", "duplicate_of", "deleted_at"] {
        assert!(columns.iter().any(|column| column == expected));
    }

    let immutable_trigger_exists: bool = client
        .query_one(
            "SELECT EXISTS (
               SELECT 1 FROM pg_trigger
               WHERE tgname = 'feedback_audit_events_immutable' AND NOT tgisinternal
             )",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(immutable_trigger_exists);
}

#[tokio::test]
async fn legacy_feedback_migration_is_idempotent_and_does_not_invent_an_owner() {
    let Ok(url) = std::env::var("ABEI_TEST_DATABASE_URL") else {
        return;
    };
    let pool = create_pool(url.parse().unwrap(), 1).unwrap();
    initialize(&pool).await.unwrap();
    let client = pool.get().await.unwrap();
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let legacy_id: i64 = client
        .query_one(
            "INSERT INTO abei_ai.feedback
               (title, body, labels, kind, submitted_by, source, status, response)
             VALUES ($1, $2, ARRAY['legacy-test']::text[], 'bug', 'legacy-actor', 'cli',
                     'completed', 'Migrated response')
             RETURNING id",
            &[
                &format!("Legacy feedback migration {suffix}"),
                &format!("Legacy feedback body {suffix}"),
            ],
        )
        .await
        .unwrap()
        .get(0);
    drop(client);

    initialize(&pool).await.unwrap();
    initialize(&pool).await.unwrap();

    let client = pool.get().await.unwrap();
    let submission = client
        .query_one(
            "SELECT count(*)::bigint AS count, min(user_id) AS user_id
             FROM abei_ai.feedback_submissions WHERE legacy_feedback_id = $1",
            &[&legacy_id],
        )
        .await
        .unwrap();
    assert_eq!(submission.get::<_, i64>("count"), 1);
    assert_eq!(submission.get::<_, Option<i64>>("user_id"), None);

    for (table, expected) in [
        ("feedback_items", 1_i64),
        ("feedback_updates", 1_i64),
        ("feedback_audit_events", 1_i64),
    ] {
        let count: i64 = client
            .query_one(
                &format!(
                    "SELECT count(*)::bigint FROM abei_ai.{table} WHERE legacy_feedback_id = $1"
                ),
                &[&legacy_id],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(count, expected, "{table} must contain one migrated row");
    }
}
