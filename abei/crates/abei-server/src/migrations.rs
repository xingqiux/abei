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
    Migration {
        version: "0007_drop_legacy_bill_migration",
        sql: include_str!("../migrations/0007_drop_legacy_bill_migration.sql"),
    },
    Migration {
        version: "0008_bill_row_link_state",
        sql: include_str!("../migrations/0008_bill_row_link_state.sql"),
    },
];

/// 迁移串行化用的咨询锁编号。随手挑的常量，只要全仓库只有这一处用就行。
const ADVISORY_LOCK: i64 = 8_105_000;

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
        // 两个进程同时启动（或者两个测试各自建池）时，`FOR UPDATE` 锁不住还不存在的行，
        // 两边都会去跑同一条迁移，后提交的那个撞主键。这把事务级咨询锁把这一段串起来，
        // 提交或回滚时自动释放。
        transaction
            .execute("SELECT pg_advisory_xact_lock($1)", &[&ADVISORY_LOCK])
            .await?;
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
