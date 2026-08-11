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
    let exists: bool = client
        .query_one("SELECT to_regclass('abei_ai.feedback') IS NOT NULL", &[])
        .await
        .unwrap()
        .get(0);
    assert!(exists);
    let events_exist: bool = client
        .query_one(
            "SELECT to_regclass('abei_ai.feedback_events') IS NOT NULL",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert!(events_exist);
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
}
