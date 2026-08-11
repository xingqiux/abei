pub mod auth;
pub mod docs;

use abei_core::Method;

use crate::client::Client;
use crate::error::CliError;
use crate::io::Io;

/// 裸 `abei`：一眼看完最近的钱怎么走的。
pub async fn overview(io: &mut Io, client: &Client, month: &str) -> Result<(), CliError> {
    let (start, end) = month_bounds(month);
    let summary = client
        .request(
            Method::Get,
            "/v1/transactions/summary",
            &[
                ("start".to_owned(), start.clone()),
                ("end".to_owned(), end.clone()),
            ],
            None,
        )
        .await?;

    io.line(&crate::render::summary(&summary, io.tty))
        .map_err(|error| CliError::Other(error.to_string()))?;

    let accounts = client
        .request(
            Method::Get,
            "/v1/accounts",
            &[("type".to_owned(), "asset".to_owned())],
            None,
        )
        .await?;
    let rows = crate::normalize::rows_for("accounts.list", &accounts);
    if !rows.is_empty() {
        io.blank()
            .map_err(|error| CliError::Other(error.to_string()))?;
        io.line("资产账户")
            .map_err(|error| CliError::Other(error.to_string()))?;
        io.line(&crate::render::table(&rows, io.tty))
            .map_err(|error| CliError::Other(error.to_string()))?;
    }

    io.note("");
    io.note("看具体交易：abei tx list　全部用法：abei --help　给 AI 看：abei guide");
    Ok(())
}

/// `2026-08` -> (2026-08-01, 2026-08-31)
fn month_bounds(month: &str) -> (String, String) {
    let query = crate::query::parse(&[format!("date:{month}")]);
    match query {
        Ok(parsed) => (
            parsed.start.unwrap_or_else(|| format!("{month}-01")),
            parsed.end.unwrap_or_else(|| format!("{month}-28")),
        ),
        Err(_) => (format!("{month}-01"), format!("{month}-28")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn month_bounds_cover_the_whole_month() {
        assert_eq!(
            month_bounds("2026-08"),
            ("2026-08-01".to_owned(), "2026-08-31".to_owned())
        );
        assert_eq!(
            month_bounds("2024-02"),
            ("2024-02-01".to_owned(), "2024-02-29".to_owned())
        );
    }
}
