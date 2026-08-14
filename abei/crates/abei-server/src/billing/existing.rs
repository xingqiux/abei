//! 拿一条待入账的流水去 Firefly 里找「是不是已经有这一笔了」。
//!
//! 从 abei-api 原样搬过来的（原 `existing_transactions.rs`），逻辑一行没改，只是把错误
//! 类型换成 abei-server 的 `ApiError`。搬家的原因是入账 saga 整条沉进了 abei-server：
//! 发给 Firefly 之前的最后一次查重必须和写入在同一个进程里，中间隔一次网络调用的话，
//! 「查完到写入」之间的窗口就没法收窄。
//!
//! 这是幂等性的最后一道闸：`external_id` 挡住我们自己的重复提交，这里挡住用户在别处
//! （手输、别的导入工具）已经记过的同一笔账。

use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::str::FromStr;

use rust_decimal::Decimal;
use serde_json::{Map, Value, json};

use crate::ApiError;
use crate::firefly::Firefly;

const PAGE_SIZE: u32 = 500;
const MAX_PAGES: u64 = 100;
const MAX_COMBINATION_GROUPS: usize = 6;
const MAX_COMBINATION_VISITS: usize = 50_000;
const MAX_CANDIDATES_PER_ROW: usize = 20;

#[derive(Clone, Debug)]
struct MatchTarget {
    date: String,
    amount: Decimal,
    currency: String,
    kind: Option<String>,
    descriptions: Vec<String>,
    merchants: Vec<String>,
    account_ids: BTreeSet<String>,
    account_names: Vec<String>,
}

#[derive(Clone, Debug)]
struct ExistingGroup {
    ids: Vec<String>,
    date: String,
    amount: Decimal,
    currency: String,
    kind: Option<String>,
    descriptions: Vec<String>,
    merchants: Vec<String>,
    account_ids: BTreeSet<String>,
    account_names: Vec<String>,
    transaction_count: usize,
}

/// 给一份账单复核结果标注「Firefly 里可能已经有了」。
///
/// 目前只有 abei-api 那份拷贝在用；等复核接口也从 abei-api 转发下来之后，这份接手，
/// 那时候 abei-api 的 `existing_transactions.rs` 整个删掉。
#[allow(dead_code, reason = "等复核接口下沉后接手，见上面的注释")]
pub(crate) async fn enrich_review(
    firefly: &Firefly,
    token: &str,
    review: &mut Value,
) -> Result<(), ApiError> {
    let Some(groups) = review.pointer("/data/groups").and_then(Value::as_object) else {
        return Ok(());
    };
    let targets = groups
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(MatchTarget::from_review_row)
        .collect::<Vec<_>>();
    let Some((start, end)) = date_range(&targets) else {
        add_empty_candidate_fields(review);
        return Ok(());
    };
    let existing = fetch_groups(firefly, token, &start, &end).await?;
    enrich_review_with_groups(review, &existing);
    Ok(())
}

pub(crate) async fn candidates_for_payload(
    firefly: &Firefly,
    token: &str,
    payload: &Value,
) -> Result<Vec<Value>, ApiError> {
    let Some(target) = MatchTarget::from_payload(payload) else {
        return Ok(Vec::new());
    };
    let existing = fetch_groups(firefly, token, &target.date, &target.date).await?;
    Ok(match_candidates(&target, &existing))
}

pub(crate) fn has_high_confidence(candidates: &[Value]) -> bool {
    candidates
        .iter()
        .any(|candidate| candidate["confidence"] == "high")
}

async fn fetch_groups(
    firefly: &Firefly,
    token: &str,
    start: &str,
    end: &str,
) -> Result<Vec<ExistingGroup>, ApiError> {
    let mut page = 1_u32;
    let mut groups = Vec::new();
    loop {
        let value = firefly
            .get_json(
                token,
                "/api/v1/transactions",
                &[
                    ("start", start.to_owned()),
                    ("end", end.to_owned()),
                    ("page", page.to_string()),
                    ("limit", PAGE_SIZE.to_string()),
                ],
            )
            .await?;
        groups.extend(
            value["data"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(ExistingGroup::from_resource),
        );
        let total_pages = value["meta"]["pagination"]["total_pages"]
            .as_u64()
            .unwrap_or(1)
            .min(MAX_PAGES);
        if u64::from(page) >= total_pages {
            break;
        }
        page = page.saturating_add(1);
    }
    Ok(groups)
}

fn enrich_review_with_groups(review: &mut Value, existing: &[ExistingGroup]) {
    let mut candidate_index = Vec::new();
    let mut moved = Vec::new();
    let (importable_count, attention_count) = {
        let Some(groups) = review
            .pointer_mut("/data/groups")
            .and_then(Value::as_object_mut)
        else {
            return;
        };
        for group_name in ["attention", "dismissed", "imported"] {
            if let Some(rows) = groups.get_mut(group_name).and_then(Value::as_array_mut) {
                for row in rows {
                    enrich_row(row, existing, &mut candidate_index, false);
                }
            }
        }
        if let Some(importable) = groups.get_mut("importable").and_then(Value::as_array_mut) {
            let mut kept = Vec::with_capacity(importable.len());
            for mut row in std::mem::take(importable) {
                let high = enrich_row(&mut row, existing, &mut candidate_index, true);
                if high {
                    moved.push(row);
                } else {
                    kept.push(row);
                }
            }
            *importable = kept;
        }
        if !moved.is_empty() {
            groups
                .entry("attention".to_owned())
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .expect("review attention group is an array")
                .extend(moved.clone());
        }
        (
            groups
                .get("importable")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
            groups
                .get("attention")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
        )
    };
    let moved_ids = moved
        .iter()
        .filter_map(|row| string(row.get("id")))
        .collect::<BTreeSet<_>>();
    if !moved_ids.is_empty() {
        if let Some(new_candidates) = review
            .get_mut("new_candidates")
            .and_then(Value::as_array_mut)
        {
            new_candidates.retain(|candidate| {
                string(candidate.get("row_id")).is_none_or(|id| !moved_ids.contains(&id))
            });
        }
        let existing_candidates = review
            .get_mut("existing_candidates")
            .and_then(Value::as_array_mut);
        if let Some(existing_candidates) = existing_candidates {
            existing_candidates.extend(moved.iter().map(existing_review_candidate));
        } else {
            review["existing_candidates"] =
                Value::Array(moved.iter().map(existing_review_candidate).collect());
        }
        if let Some(rows) = review
            .pointer_mut("/data/rows")
            .and_then(Value::as_array_mut)
        {
            for row in rows {
                if string(row.get("id")).is_some_and(|id| moved_ids.contains(&id)) {
                    copy_enrichment_from_moved(row, &moved);
                }
            }
        }
    }
    if let Some(summary) = review.get_mut("summary").and_then(Value::as_object_mut) {
        summary.insert("new".to_owned(), Value::from(importable_count));
        summary.insert("attention".to_owned(), Value::from(attention_count));
    }
    review["existing_transaction_candidates"] = Value::Array(candidate_index);
}

fn existing_review_candidate(row: &Value) -> Value {
    let attributes = &row["attributes"];
    json!({
        "row_id": row["id"],
        "reason": "existing_firefly_transaction",
        "row_number": attributes["row_number"],
        "status": attributes["status"],
        "occurred_at": attributes["occurred_at"],
        "direction": attributes["direction"],
        "amount": attributes["amount"],
        "firefly_amount": attributes["firefly_amount"],
        "currency_code": attributes["currency_code"],
        "counterparty": attributes["counterparty"],
        "description_preview": attributes["description"],
        "firefly_type": attributes["firefly_type"],
        "source_name": attributes["source_name"],
        "destination_name": attributes["destination_name"],
        "category_name": attributes["category_name"],
        "issues": attributes["issues"],
        "existing_transaction_candidates": attributes["existing_transaction_candidates"],
    })
}

fn copy_enrichment_from_moved(row: &mut Value, moved: &[Value]) {
    let Some(id) = string(row.get("id")) else {
        return;
    };
    let Some(source) = moved
        .iter()
        .find(|candidate| string(candidate.get("id")).as_deref() == Some(id.as_str()))
    else {
        return;
    };
    if let (Some(target), Some(source)) = (
        row.get_mut("attributes").and_then(Value::as_object_mut),
        source.get("attributes").and_then(Value::as_object),
    ) {
        for key in [
            "group",
            "issues",
            "reasons",
            "existing_transaction_candidates",
        ] {
            if let Some(value) = source.get(key) {
                target.insert(key.to_owned(), value.clone());
            }
        }
    }
}

fn enrich_row(
    row: &mut Value,
    existing: &[ExistingGroup],
    candidate_index: &mut Vec<Value>,
    move_high_to_attention: bool,
) -> bool {
    let candidates = MatchTarget::from_review_row(row)
        .map(|target| match_candidates(&target, existing))
        .unwrap_or_default();
    let high = has_high_confidence(&candidates);
    if let Some(attributes) = row.get_mut("attributes").and_then(Value::as_object_mut) {
        attributes.insert(
            "existing_transaction_candidates".to_owned(),
            Value::Array(candidates.clone()),
        );
        if high && move_high_to_attention {
            attributes.insert("group".to_owned(), Value::String("attention".to_owned()));
            append_existing_issue(attributes);
        }
    }
    if !candidates.is_empty() {
        candidate_index.push(json!({
            "row_id": row["id"],
            "candidates": candidates,
        }));
    }
    high
}

fn append_existing_issue(attributes: &mut Map<String, Value>) {
    let issues = attributes
        .entry("issues".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(issues) = issues.as_array_mut() else {
        return;
    };
    if !issues
        .iter()
        .any(|issue| issue["code"] == "existing_firefly_transaction")
    {
        issues.push(json!({
            "severity": "warning",
            "code": "existing_firefly_transaction",
            "message": "Firefly 中已有高置信匹配交易，必须人工确认后再处理。",
            "node_id": null,
            "locator": null,
        }));
    }
    let reasons = attributes
        .entry("reasons".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Some(reasons) = reasons.as_array_mut()
        && !reasons
            .iter()
            .any(|reason| reason == "Firefly 中已有高置信匹配交易，必须人工确认后再处理。")
    {
        reasons.push(Value::String(
            "Firefly 中已有高置信匹配交易，必须人工确认后再处理。".to_owned(),
        ));
    }
}

fn add_empty_candidate_fields(review: &mut Value) {
    if let Some(groups) = review
        .pointer_mut("/data/groups")
        .and_then(Value::as_object_mut)
    {
        for row in groups
            .values_mut()
            .filter_map(Value::as_array_mut)
            .flatten()
        {
            if let Some(attributes) = row.get_mut("attributes").and_then(Value::as_object_mut) {
                attributes.insert(
                    "existing_transaction_candidates".to_owned(),
                    Value::Array(Vec::new()),
                );
            }
        }
    }
    review["existing_transaction_candidates"] = Value::Array(Vec::new());
}

fn date_range(targets: &[MatchTarget]) -> Option<(String, String)> {
    let start = targets.iter().map(|target| target.date.as_str()).min()?;
    let end = targets.iter().map(|target| target.date.as_str()).max()?;
    Some((start.to_owned(), end.to_owned()))
}

fn match_candidates(target: &MatchTarget, existing: &[ExistingGroup]) -> Vec<Value> {
    let same_day = existing
        .iter()
        .filter(|group| group.date == target.date && group.currency == target.currency)
        .cloned()
        .collect::<Vec<_>>();
    let mut candidates = same_day
        .iter()
        .filter(|group| group.amount == target.amount)
        .filter_map(|group| candidate(target, group, "transaction_group"))
        .collect::<Vec<_>>();
    let combinations = amount_combinations(&same_day, target.amount);
    candidates.extend(combinations.iter().filter_map(|indexes| {
        let combined = combine_groups(indexes.iter().map(|index| &same_day[*index]));
        candidate(target, &combined, "same_day_combination")
    }));
    candidates.sort_by(candidate_order);
    candidates
        .dedup_by(|left, right| left["transaction_group_ids"] == right["transaction_group_ids"]);
    candidates.truncate(MAX_CANDIDATES_PER_ROW);
    candidates
}

fn candidate(target: &MatchTarget, existing: &ExistingGroup, match_kind: &str) -> Option<Value> {
    if target.date != existing.date
        || target.amount != existing.amount
        || target.currency != existing.currency
    {
        return None;
    }
    let mut matched_on = vec!["date", "amount", "currency_code"];
    let type_match = target.kind.is_some() && target.kind == existing.kind;
    if type_match {
        matched_on.push("type");
    }
    let account_id_match = !target.account_ids.is_disjoint(&existing.account_ids);
    let account_name_match = text_sets_match(&target.account_names, &existing.account_names);
    if account_id_match {
        matched_on.push("account_id");
    } else if account_name_match {
        matched_on.push("account_name");
    }
    let merchant_match = text_sets_match(&target.merchants, &existing.merchants);
    if merchant_match {
        matched_on.push("merchant");
    }
    let description_match = text_sets_match(&target.descriptions, &existing.descriptions);
    if description_match {
        matched_on.push("description");
    }
    let confidence =
        if account_id_match || account_name_match || merchant_match || description_match {
            "high"
        } else if type_match {
            "medium"
        } else {
            "low"
        };
    Some(json!({
        "confidence": confidence,
        "match_kind": match_kind,
        "transaction_group_ids": existing.ids,
        "transaction_count": existing.transaction_count,
        "date": existing.date,
        "amount": existing.amount.normalize().to_string(),
        "currency_code": existing.currency,
        "type": existing.kind,
        "matched_on": matched_on,
        "descriptions": limited(&existing.descriptions),
        "merchants": limited(&existing.merchants),
        "account_names": limited(&existing.account_names),
    }))
}

fn candidate_order(left: &Value, right: &Value) -> Ordering {
    confidence_rank(&left["confidence"])
        .cmp(&confidence_rank(&right["confidence"]))
        .then_with(|| {
            left["transaction_group_ids"]
                .as_array()
                .map_or(usize::MAX, Vec::len)
                .cmp(
                    &right["transaction_group_ids"]
                        .as_array()
                        .map_or(usize::MAX, Vec::len),
                )
        })
        .then_with(|| left.to_string().cmp(&right.to_string()))
}

fn confidence_rank(value: &Value) -> u8 {
    match value.as_str() {
        Some("high") => 0,
        Some("medium") => 1,
        _ => 2,
    }
}

fn amount_combinations(groups: &[ExistingGroup], target: Decimal) -> Vec<Vec<usize>> {
    let eligible = groups
        .iter()
        .enumerate()
        .filter(|(_, group)| group.amount > Decimal::ZERO && group.amount < target)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let mut visits = 0;
    let mut found = Vec::new();
    let mut selected = Vec::new();
    search_combinations(
        groups,
        &eligible,
        target,
        0,
        Decimal::ZERO,
        &mut selected,
        &mut visits,
        &mut found,
    );
    found
}

#[allow(clippy::too_many_arguments)]
fn search_combinations(
    groups: &[ExistingGroup],
    eligible: &[usize],
    target: Decimal,
    position: usize,
    sum: Decimal,
    selected: &mut Vec<usize>,
    visits: &mut usize,
    found: &mut Vec<Vec<usize>>,
) {
    if *visits >= MAX_COMBINATION_VISITS || found.len() >= MAX_CANDIDATES_PER_ROW {
        return;
    }
    *visits += 1;
    if sum == target {
        if selected.len() >= 2 {
            found.push(selected.clone());
        }
        return;
    }
    if sum > target || selected.len() >= MAX_COMBINATION_GROUPS {
        return;
    }
    for next in position..eligible.len() {
        let index = eligible[next];
        let next_sum = sum + groups[index].amount;
        if next_sum > target {
            continue;
        }
        selected.push(index);
        search_combinations(
            groups,
            eligible,
            target,
            next + 1,
            next_sum,
            selected,
            visits,
            found,
        );
        selected.pop();
        if *visits >= MAX_COMBINATION_VISITS || found.len() >= MAX_CANDIDATES_PER_ROW {
            break;
        }
    }
}

fn combine_groups<'a>(groups: impl Iterator<Item = &'a ExistingGroup>) -> ExistingGroup {
    let groups = groups.collect::<Vec<_>>();
    let first = groups[0];
    let same_kind = groups.iter().all(|group| group.kind == first.kind);
    ExistingGroup {
        ids: groups.iter().flat_map(|group| group.ids.clone()).collect(),
        date: first.date.clone(),
        amount: groups.iter().map(|group| group.amount).sum(),
        currency: first.currency.clone(),
        kind: same_kind.then(|| first.kind.clone()).flatten(),
        descriptions: groups
            .iter()
            .flat_map(|group| group.descriptions.clone())
            .collect(),
        merchants: groups
            .iter()
            .flat_map(|group| group.merchants.clone())
            .collect(),
        account_ids: groups
            .iter()
            .flat_map(|group| group.account_ids.iter().cloned())
            .collect(),
        account_names: groups
            .iter()
            .flat_map(|group| group.account_names.clone())
            .collect(),
        transaction_count: groups.iter().map(|group| group.transaction_count).sum(),
    }
}

impl MatchTarget {
    fn from_review_row(row: &Value) -> Option<Self> {
        let attributes = row.get("attributes")?;
        let kind = string(attributes.get("firefly_type"));
        let date = date(
            string(attributes.get("firefly_date"))
                .or_else(|| string(attributes.get("occurred_at")))?
                .as_str(),
        )?;
        let amount = decimal(attributes.get("firefly_amount"))
            .or_else(|| decimal(attributes.get("amount")))?;
        let currency = currency(attributes.get("currency_code"))?;
        let source_name = string(attributes.get("source_name"));
        let destination_name = string(attributes.get("destination_name"));
        let source_id = string(attributes.get("source_account_id"));
        let destination_id = string(attributes.get("destination_account_id"));
        let (account_names, merchants) = directional_names(
            kind.as_deref(),
            source_name.clone(),
            destination_name.clone(),
        );
        let account_ids = directional_ids(kind.as_deref(), source_id, destination_id);
        Some(Self {
            date,
            amount,
            currency,
            kind,
            descriptions: strings([
                attributes.get("firefly_description"),
                attributes.get("description"),
            ]),
            merchants: extend_strings(merchants, string(attributes.get("counterparty"))),
            account_ids,
            account_names,
        })
    }

    fn from_payload(payload: &Value) -> Option<Self> {
        let transactions = payload.get("transactions")?.as_array()?;
        if transactions.is_empty() {
            return None;
        }
        let first = &transactions[0];
        let target_date = date(string(first.get("date"))?.as_str())?;
        let currency = currency(first.get("currency_code"))?;
        if !transactions.iter().all(|transaction| {
            string(transaction.get("date"))
                .and_then(|value| date(&value))
                .as_deref()
                == Some(target_date.as_str())
                && currency_code(transaction.get("currency_code")).as_deref()
                    == Some(currency.as_str())
        }) {
            return None;
        }
        let amount = transactions
            .iter()
            .map(|transaction| decimal(transaction.get("amount")))
            .collect::<Option<Vec<_>>>()?
            .into_iter()
            .sum();
        let kinds = transactions
            .iter()
            .filter_map(|transaction| string(transaction.get("type")))
            .collect::<BTreeSet<_>>();
        let kind = (kinds.len() == 1)
            .then(|| kinds.into_iter().next())
            .flatten();
        let mut descriptions = Vec::new();
        let mut merchants = Vec::new();
        let mut account_names = Vec::new();
        let mut account_ids = BTreeSet::new();
        for transaction in transactions {
            push_string(&mut descriptions, string(transaction.get("description")));
            let transaction_kind = string(transaction.get("type"));
            let (accounts, counterparties) = directional_names(
                transaction_kind.as_deref(),
                string(transaction.get("source_name")),
                string(transaction.get("destination_name")),
            );
            account_names.extend(accounts);
            merchants.extend(counterparties);
            account_ids.extend(directional_ids(
                transaction_kind.as_deref(),
                string(transaction.get("source_id")),
                string(transaction.get("destination_id")),
            ));
        }
        Some(Self {
            date: target_date,
            amount,
            currency,
            kind,
            descriptions,
            merchants,
            account_ids,
            account_names,
        })
    }
}

impl ExistingGroup {
    fn from_resource(resource: &Value) -> Option<Self> {
        let transactions = resource
            .pointer("/attributes/transactions")
            .and_then(Value::as_array)?;
        if transactions.is_empty() {
            return None;
        }
        let first = &transactions[0];
        let target_date = date(string(first.get("date"))?.as_str())?;
        let currency = currency(first.get("currency_code"))?;
        let same_date_currency = transactions.iter().all(|transaction| {
            string(transaction.get("date"))
                .and_then(|value| date(&value))
                .as_deref()
                == Some(target_date.as_str())
                && currency_code(transaction.get("currency_code")).as_deref()
                    == Some(currency.as_str())
        });
        if !same_date_currency {
            return None;
        }
        let amount = transactions
            .iter()
            .map(|transaction| decimal(transaction.get("amount")))
            .collect::<Option<Vec<_>>>()?
            .into_iter()
            .sum();
        let kinds = transactions
            .iter()
            .filter_map(|transaction| string(transaction.get("type")))
            .collect::<BTreeSet<_>>();
        let kind = (kinds.len() == 1)
            .then(|| kinds.into_iter().next())
            .flatten();
        let mut descriptions = Vec::new();
        let mut merchants = Vec::new();
        let mut account_names = Vec::new();
        let mut account_ids = BTreeSet::new();
        for transaction in transactions {
            push_string(&mut descriptions, string(transaction.get("description")));
            let transaction_kind = string(transaction.get("type"));
            let (accounts, counterparties) = directional_names(
                transaction_kind.as_deref(),
                string(transaction.get("source_name")),
                string(transaction.get("destination_name")),
            );
            account_names.extend(accounts);
            merchants.extend(counterparties);
            account_ids.extend(directional_ids(
                transaction_kind.as_deref(),
                string(transaction.get("source_id")),
                string(transaction.get("destination_id")),
            ));
        }
        Some(Self {
            ids: vec![string(resource.get("id"))?],
            date: target_date,
            amount,
            currency,
            kind,
            descriptions,
            merchants,
            account_ids,
            account_names,
            transaction_count: transactions.len(),
        })
    }
}

fn directional_names(
    kind: Option<&str>,
    source: Option<String>,
    destination: Option<String>,
) -> (Vec<String>, Vec<String>) {
    match kind {
        Some("withdrawal") => (
            source.into_iter().collect(),
            destination.into_iter().collect(),
        ),
        Some("deposit") => (
            destination.into_iter().collect(),
            source.into_iter().collect(),
        ),
        Some("transfer") => (
            source
                .clone()
                .into_iter()
                .chain(destination.clone())
                .collect(),
            Vec::new(),
        ),
        _ => (
            source
                .clone()
                .into_iter()
                .chain(destination.clone())
                .collect(),
            source.into_iter().chain(destination).collect(),
        ),
    }
}

fn directional_ids(
    kind: Option<&str>,
    source: Option<String>,
    destination: Option<String>,
) -> BTreeSet<String> {
    match kind {
        Some("withdrawal") => source.into_iter().collect(),
        Some("deposit") => destination.into_iter().collect(),
        _ => source.into_iter().chain(destination).collect(),
    }
}

fn text_sets_match(left: &[String], right: &[String]) -> bool {
    left.iter().any(|left| {
        let left = normalize_text(left);
        left.chars().count() >= 2
            && right.iter().any(|right| {
                let right = normalize_text(right);
                right.chars().count() >= 2
                    && (left == right || left.contains(&right) || right.contains(&left))
            })
    })
}

fn normalize_text(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn decimal(value: Option<&Value>) -> Option<Decimal> {
    let value = value?;
    if let Some(value) = value.as_str() {
        Decimal::from_str(value).ok()
    } else {
        Decimal::from_str(&value.to_string()).ok()
    }
}

fn string(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let value = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_i64().map(|value| value.to_string()))?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn date(value: &str) -> Option<String> {
    let value = value.get(..10)?;
    let bytes = value.as_bytes();
    (bytes.len() == 10 && bytes[4] == b'-' && bytes[7] == b'-').then(|| value.to_owned())
}

fn currency(value: Option<&Value>) -> Option<String> {
    currency_code(value).or_else(|| Some("CNY".to_owned()))
}

fn currency_code(value: Option<&Value>) -> Option<String> {
    string(value).map(|value| value.to_ascii_uppercase())
}

fn strings<const N: usize>(values: [Option<&Value>; N]) -> Vec<String> {
    values.into_iter().filter_map(string).collect()
}

fn push_string(values: &mut Vec<String>, value: Option<String>) {
    if let Some(value) = value {
        values.push(value);
    }
}

fn extend_strings(mut values: Vec<String>, value: Option<String>) -> Vec<String> {
    push_string(&mut values, value);
    values
}

fn limited(values: &[String]) -> Vec<&str> {
    values.iter().map(String::as_str).take(8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(amount: &str) -> MatchTarget {
        MatchTarget {
            date: "2026-07-15".to_owned(),
            amount: Decimal::from_str(amount).unwrap(),
            currency: "CNY".to_owned(),
            kind: Some("withdrawal".to_owned()),
            descriptions: vec!["信用卡还款".to_owned()],
            merchants: Vec::new(),
            account_ids: BTreeSet::from(["10".to_owned()]),
            account_names: vec!["招商银行信用卡".to_owned()],
        }
    }

    fn group(id: &str, amount: &str) -> ExistingGroup {
        ExistingGroup {
            ids: vec![id.to_owned()],
            date: "2026-07-15".to_owned(),
            amount: Decimal::from_str(amount).unwrap(),
            currency: "CNY".to_owned(),
            kind: Some("withdrawal".to_owned()),
            descriptions: vec!["信用卡还款".to_owned()],
            merchants: Vec::new(),
            account_ids: BTreeSet::from(["10".to_owned()]),
            account_names: vec!["招商银行信用卡".to_owned()],
            transaction_count: 1,
        }
    }

    #[test]
    fn one_group_with_multiple_splits_is_matched_by_its_total() {
        let resource = json!({
            "id": "397",
            "attributes": { "transactions": [
                { "type": "withdrawal", "date": "2026-07-15T10:00:00+08:00",
                  "amount": "1000.00", "currency_code": "CNY", "source_id": "10",
                  "source_name": "招商银行信用卡", "description": "信用卡还款" },
                { "type": "withdrawal", "date": "2026-07-15T10:00:00+08:00",
                  "amount": "1952.95", "currency_code": "CNY", "source_id": "10",
                  "source_name": "招商银行信用卡", "description": "信用卡还款" }
            ]}
        });
        let existing = ExistingGroup::from_resource(&resource).unwrap();
        let candidates = match_candidates(&target("2952.95"), &[existing]);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0]["confidence"], "high");
        assert_eq!(candidates[0]["transaction_count"], 2);
    }

    #[test]
    fn same_day_groups_can_match_as_a_combination() {
        let candidates = match_candidates(
            &target("2952.95"),
            &[group("397", "1000.00"), group("398", "1952.95")],
        );
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0]["match_kind"], "same_day_combination");
        assert_eq!(
            candidates[0]["transaction_group_ids"],
            json!(["397", "398"])
        );
    }

    #[test]
    fn date_amount_and_currency_without_context_is_not_high_confidence() {
        let mut existing = group("9", "2952.95");
        existing.kind = Some("deposit".to_owned());
        existing.descriptions = vec!["工资".to_owned()];
        existing.account_ids.clear();
        existing.account_names = vec!["现金".to_owned()];
        let candidates = match_candidates(&target("2952.95"), &[existing]);
        assert_eq!(candidates[0]["confidence"], "low");
    }
}
