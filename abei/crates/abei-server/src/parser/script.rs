use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rhai::{Array, Dynamic, Engine, ImmutableString, Map, Scope};
use rust_decimal::Decimal;

use super::model::{Diagnostic, RawRecord, Severity};

const MAX_OPERATIONS: u64 = 100_000;
const MAX_STRING_BYTES: usize = 64 * 1024;
const MAX_COLLECTION_ITEMS: usize = 20_000;
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct ScriptOutput {
    pub records: Vec<RawRecord>,
    pub diagnostics: Vec<Diagnostic>,
}

pub(crate) fn sandbox_engine(timeout: Duration) -> Engine {
    configured_engine(
        timeout,
        Arc::new(Mutex::new(Vec::new())),
        Arc::new(Mutex::new(Vec::new())),
    )
}

pub(crate) fn transform_records(
    source: &str,
    records: &[RawRecord],
    timezone: &str,
    node_id: &str,
) -> Result<ScriptOutput, String> {
    if records.len() > 10_000 {
        return Err("脚本单次最多处理 10,000 条记录。".to_owned());
    }

    let emitted = Arc::new(Mutex::new(Vec::<Map>::new()));
    let warnings = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let batches = records.len().max(1).div_ceil(1_000) as u32;
    let timeout = Duration::from_millis(200).saturating_mul(batches.min(10));
    let engine = configured_engine(timeout, emitted.clone(), warnings.clone());
    let ast = engine
        .compile(source)
        .map_err(|error| format!("Rhai 无法编译：{error}"))?;
    let context = rhai::serde::to_dynamic(BTreeMap::from([(
        "timezone".to_owned(),
        timezone.to_owned(),
    )]))
    .map_err(|error| format!("脚本上下文无法创建：{error}"))?;

    let mut output = Vec::new();
    let mut diagnostics = Vec::new();
    let mut output_bytes = 0_usize;
    for record in records {
        let row = rhai::serde::to_dynamic(&record.fields)
            .map_err(|error| format!("脚本输入无法创建：{error}"))?;
        let emitted_before = emitted.lock().map_err(lock_error)?.len();
        let warnings_before = warnings.lock().map_err(lock_error)?.len();
        let output_before = output.len();
        let result = engine
            .call_fn::<Dynamic>(&mut Scope::new(), &ast, "transform", (row, context.clone()))
            .map_err(|error| format!("Rhai transform 执行失败：{error}"))?;

        let maps = {
            let values = emitted.lock().map_err(lock_error)?;
            values[emitted_before..].to_vec()
        };
        if maps.is_empty() {
            append_return_value(&mut output, result, record)?;
        } else {
            for map in maps {
                output.push(record_from_map(map, record)?);
            }
        }
        {
            let values = warnings.lock().map_err(lock_error)?;
            diagnostics.extend(values[warnings_before..].iter().map(|(code, message)| {
                Diagnostic {
                    severity: Severity::Warning,
                    code: code.clone(),
                    message: message.clone(),
                    node_id: Some(node_id.to_owned()),
                    locator: Some(record.locator.clone()),
                }
            }));
        }
        if output.len() > MAX_COLLECTION_ITEMS {
            return Err("脚本单次最多输出 20,000 条记录。".to_owned());
        }
        for record in &output[output_before..] {
            output_bytes = output_bytes.saturating_add(
                record
                    .fields
                    .iter()
                    .map(|(key, value)| key.len().saturating_add(value.len()))
                    .sum::<usize>(),
            );
        }
        if output_bytes > MAX_OUTPUT_BYTES {
            return Err("脚本输出总大小不能超过 8 MiB。".to_owned());
        }
    }

    Ok(ScriptOutput {
        records: output,
        diagnostics,
    })
}

fn configured_engine(
    timeout: Duration,
    emitted: Arc<Mutex<Vec<Map>>>,
    warnings: Arc<Mutex<Vec<(String, String)>>>,
) -> Engine {
    let started = Instant::now();
    let mut engine = Engine::new();
    engine
        .set_max_operations(MAX_OPERATIONS)
        .set_max_call_levels(32)
        .set_max_expr_depths(64, 32)
        .set_max_variables(256)
        .set_max_functions(64)
        .set_max_modules(0)
        .set_max_string_size(MAX_STRING_BYTES)
        .set_max_array_size(MAX_COLLECTION_ITEMS)
        .set_max_map_size(512)
        .on_progress(move |_| (started.elapsed() > timeout).then(|| Dynamic::from("脚本执行超时")))
        .on_print(|_| {})
        .on_debug(|_, _, _| {});

    engine.register_fn("money", |value: ImmutableString| {
        normalize_money(&value).unwrap_or_default()
    });
    engine.register_fn("text", |value: Dynamic| clean_text(&dynamic_text(&value)));
    engine.register_fn("optional_text", |value: Dynamic| {
        let value = clean_text(&dynamic_text(&value));
        if value.is_empty() {
            Dynamic::UNIT
        } else {
            Dynamic::from(value)
        }
    });
    engine.register_fn("first_non_empty", |values: Array| {
        values
            .iter()
            .map(dynamic_text)
            .map(|value| clean_text(&value))
            .find(|value| !value.is_empty())
            .unwrap_or_default()
    });
    engine.register_fn(
        "datetime",
        |value: ImmutableString, _timezone: ImmutableString| clean_text(&value),
    );
    engine.register_fn("emit", move |value: Map| {
        if let Ok(mut values) = emitted.lock()
            && values.len() < MAX_COLLECTION_ITEMS
        {
            values.push(value);
        }
    });
    engine.register_fn(
        "warning",
        move |code: ImmutableString, message: ImmutableString| {
            if let Ok(mut values) = warnings.lock()
                && values.len() < MAX_COLLECTION_ITEMS
            {
                values.push((code.to_string(), message.to_string()));
            }
        },
    );
    engine
}

fn append_return_value(
    output: &mut Vec<RawRecord>,
    result: Dynamic,
    source: &RawRecord,
) -> Result<(), String> {
    if result.is_unit() {
        return Ok(());
    }
    if result.is::<Map>() {
        output.push(record_from_map(result.cast::<Map>(), source)?);
        return Ok(());
    }
    if result.is::<Array>() {
        for item in result.cast::<Array>() {
            if !item.is::<Map>() {
                return Err("transform 返回的数组只能包含对象。".to_owned());
            }
            output.push(record_from_map(item.cast::<Map>(), source)?);
        }
        return Ok(());
    }
    Err("transform 必须调用 emit，或返回对象/对象数组。".to_owned())
}

fn record_from_map(map: Map, source: &RawRecord) -> Result<RawRecord, String> {
    if map.len() > 128 {
        return Err("脚本输出对象最多包含 128 个字段。".to_owned());
    }
    let mut fields = BTreeMap::new();
    for (key, value) in map {
        if value.is::<Map>() || value.is::<Array>() {
            return Err(format!(
                "脚本输出字段 {key} 必须是标量，不能嵌套对象或数组。"
            ));
        }
        let value = dynamic_text(&value);
        if value.len() > MAX_STRING_BYTES {
            return Err(format!("脚本输出字段 {key} 超过 64 KiB。"));
        }
        fields.insert(key.to_string(), value);
    }
    Ok(RawRecord {
        fields,
        locator: source.locator.clone(),
    })
}

pub(crate) fn normalize_money(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("金额为空。".to_owned());
    }
    let parenthesized = trimmed.starts_with('(') && trimmed.ends_with(')');
    let mut normalized = String::with_capacity(trimmed.len());
    for character in trimmed.chars() {
        if character.is_ascii_digit() || matches!(character, '.' | '-' | '+') {
            normalized.push(character);
        }
    }
    if normalized.is_empty() || matches!(normalized.as_str(), "+" | "-" | ".") {
        return Err(format!("无法识别金额 {value:?}。"));
    }
    let mut amount =
        Decimal::from_str(&normalized).map_err(|_| format!("无法识别金额 {value:?}。"))?;
    if parenthesized && !amount.is_sign_negative() {
        amount.set_sign_negative(true);
    }
    Ok(amount.normalize().to_string())
}

fn clean_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn dynamic_text(value: &Dynamic) -> String {
    if value.is_unit() {
        String::new()
    } else if value.is::<ImmutableString>() {
        value.clone_cast::<ImmutableString>().to_string()
    } else {
        value.to_string()
    }
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "脚本结果收集器不可用。".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::model::SourceLocator;

    fn record() -> RawRecord {
        RawRecord {
            fields: BTreeMap::from([
                ("amount".to_owned(), "￥1,234.50".to_owned()),
                ("direction".to_owned(), "支出".to_owned()),
            ]),
            locator: SourceLocator {
                row: Some(3),
                ..SourceLocator::default()
            },
        }
    }

    #[test]
    fn script_can_emit_pure_data() {
        let output = transform_records(
            r#"
                fn transform(row, context) {
                    let amount = money(row["amount"]);
                    emit(#{
                        signed_amount: if row["direction"] == "支出" { "-" + amount } else { amount },
                        currency_code: "CNY",
                        occurred_at: datetime("2026-08-11 10:00:00", context.timezone),
                        description: "测试"
                    });
                }
            "#,
            &[record()],
            "Asia/Shanghai",
            "script",
        )
        .expect("script should run");
        assert_eq!(output.records[0].fields["signed_amount"], "-1234.5");
        assert_eq!(output.records[0].locator.row, Some(3));
    }

    #[test]
    fn script_substring_keeps_an_ascii_date_prefix() {
        let source = RawRecord {
            fields: BTreeMap::from([
                (
                    "statement_date".to_owned(),
                    "2026/08/11 每日账单".to_owned(),
                ),
                ("time".to_owned(), "08:30:00".to_owned()),
            ]),
            locator: SourceLocator::default(),
        };
        let output = transform_records(
            r#"
                fn transform(row, context) {
                    let date = row["statement_date"].sub_string(0, 10);
                    date.replace("/", "-");
                    emit(#{ occurred_at: date + " " + row["time"] });
                }
            "#,
            &[source],
            "Asia/Shanghai",
            "script",
        )
        .unwrap();

        assert_eq!(
            output.records[0].fields["occurred_at"],
            "2026-08-11 08:30:00"
        );
    }

    #[test]
    fn operation_limit_stops_infinite_loop() {
        let error = transform_records(
            "fn transform(row, context) { loop {} }",
            &[record()],
            "UTC",
            "script",
        )
        .expect_err("loop must be stopped");
        assert!(
            error.contains("operations") || error.contains("超时"),
            "{error}"
        );
    }

    #[test]
    fn money_parser_handles_parentheses_and_grouping() {
        assert_eq!(normalize_money("(1,234.50)").unwrap(), "-1234.5");
        assert_eq!(normalize_money("+12.00 元").unwrap(), "12");
    }

    #[test]
    fn nested_output_values_are_rejected() {
        let error = transform_records(
            r#"
                fn transform(row, context) {
                    emit(#{ nested: #{ value: "not allowed" } });
                }
            "#,
            &[record()],
            "UTC",
            "script",
        )
        .unwrap_err();
        assert!(error.contains("不能嵌套"), "{error}");
    }
}
