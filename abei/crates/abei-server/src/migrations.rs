use deadpool_postgres::Pool;
use sha2::{Digest, Sha256};

struct Migration {
    version: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: "0001_mail_workbench",
        sql: include_str!("../migrations/0001_mail_workbench.sql"),
    },
    Migration {
        version: "0002_parser_platform",
        sql: include_str!("../migrations/0002_parser_platform.sql"),
    },
    Migration {
        version: "0003_bill_automation",
        sql: include_str!("../migrations/0003_bill_automation.sql"),
    },
    Migration {
        version: "0004_bill_imports",
        sql: include_str!("../migrations/0004_bill_imports.sql"),
    },
    Migration {
        version: "0005_legacy_bill_migration",
        sql: include_str!("../migrations/0005_legacy_bill_migration.sql"),
    },
    Migration {
        version: "0006_builtin_mail_rules",
        sql: include_str!("../migrations/0006_builtin_mail_rules.sql"),
    },
];

pub async fn run(pool: &Pool) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut client = pool.get().await?;
    client
        .batch_execute(
            r#"
            CREATE SCHEMA IF NOT EXISTS abei_ai;
            CREATE TABLE IF NOT EXISTS abei_ai.schema_migrations (
              version TEXT PRIMARY KEY,
              checksum CHAR(64) NOT NULL,
              applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            "#,
        )
        .await?;

    for migration in MIGRATIONS {
        let checksum = checksum(migration.sql);
        let transaction = client.transaction().await?;
        let applied = transaction
            .query_opt(
                "SELECT checksum FROM abei_ai.schema_migrations WHERE version = $1 FOR UPDATE",
                &[&migration.version],
            )
            .await?;
        if let Some(row) = applied {
            let existing: String = row.get(0);
            if existing != checksum {
                return Err(format!(
                    "migration {} 的内容已改变：数据库是 {}，代码是 {}",
                    migration.version, existing, checksum
                )
                .into());
            }
            transaction.commit().await?;
            continue;
        }

        transaction.batch_execute(migration.sql).await?;
        transaction
            .execute(
                "INSERT INTO abei_ai.schema_migrations (version, checksum) VALUES ($1, $2)",
                &[&migration.version, &checksum],
            )
            .await?;
        transaction.commit().await?;
    }

    Ok(())
}

fn checksum(sql: &str) -> String {
    Sha256::digest(sql.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_checksum_is_stable() {
        assert_eq!(checksum("SELECT 1;"), checksum("SELECT 1;"));
        assert_ne!(checksum("SELECT 1;"), checksum("SELECT 2;"));
    }
}
