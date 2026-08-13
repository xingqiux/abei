pub(crate) struct BuiltinFlow {
    pub(crate) name: &'static str,
    pub(crate) slug: &'static str,
    pub(crate) source: &'static str,
}

pub(crate) struct BuiltinMailRule {
    pub(crate) key: &'static str,
    pub(crate) name: &'static str,
    pub(crate) flow_slug: &'static str,
    pub(crate) position: i32,
    pub(crate) conditions: &'static str,
}

pub(crate) const MAIL_RULES: &[BuiltinMailRule] = &[
    BuiltinMailRule {
        key: "cmb-credit-card-daily",
        name: "招商银行每日信用管家",
        flow_slug: "cmb-credit-card-daily",
        position: 100,
        conditions: r#"{"type":"all","conditions":[{"type":"text","field":"from","operator":"equals","value":"ccsvc@message.cmbchina.com"},{"type":"text","field":"subject","operator":"contains","value":"每日信用管家"}]}"#,
    },
    BuiltinMailRule {
        key: "cmb-transaction-statement",
        name: "招商银行交易流水",
        flow_slug: "cmb-transaction-statement",
        position: 110,
        conditions: r#"{"type":"all","conditions":[{"type":"text","field":"from","operator":"domain","value":"cmbchina.com"},{"type":"text","field":"subject","operator":"contains","value":"交易流水"},{"type":"text","field":"attachment_extension","operator":"equals","value":"zip"}]}"#,
    },
    BuiltinMailRule {
        key: "alipay-statement",
        name: "支付宝交易流水",
        flow_slug: "alipay-statement",
        position: 120,
        conditions: r#"{"type":"all","conditions":[{"type":"text","field":"subject","operator":"contains","value":"支付宝"},{"type":"text","field":"subject","operator":"contains","value":"交易流水"},{"type":"text","field":"attachment_extension","operator":"equals","value":"zip"}]}"#,
    },
    BuiltinMailRule {
        key: "wechat-pay-statement",
        name: "微信支付账单流水",
        flow_slug: "wechat-pay-statement",
        position: 130,
        conditions: r#"{"type":"all","conditions":[{"type":"text","field":"subject","operator":"contains","value":"微信支付"},{"type":"text","field":"body_html","operator":"contains","value":"tenpay.wechatpay.cn/userroll/userbilldownload"}]}"#,
    },
    BuiltinMailRule {
        key: "boc-transaction-statement",
        name: "中国银行交易流水",
        flow_slug: "boc-transaction-statement",
        position: 140,
        conditions: r#"{"type":"all","conditions":[{"type":"text","field":"subject","operator":"contains","value":"中国银行"},{"type":"text","field":"subject","operator":"contains","value":"交易流水"},{"type":"text","field":"attachment_extension","operator":"equals","value":"pdf"}]}"#,
    },
];

pub(crate) const FLOWS: &[BuiltinFlow] = &[
    BuiltinFlow {
        name: "支付宝交易流水",
        slug: "alipay-statement",
        source: ALIPAY,
    },
    BuiltinFlow {
        name: "微信支付账单流水",
        slug: "wechat-pay-statement",
        source: WECHAT,
    },
    BuiltinFlow {
        name: "招商银行交易流水",
        slug: "cmb-transaction-statement",
        source: CMB_TRANSACTION,
    },
    BuiltinFlow {
        name: "招商银行每日信用管家",
        slug: "cmb-credit-card-daily",
        source: CMB_CREDIT_DAILY,
    },
    BuiltinFlow {
        name: "中国银行交易流水",
        slug: "boc-transaction-statement",
        source: BOC_TRANSACTION,
    },
];

const ALIPAY: &str = r#"
schema_version: 1
channel_key: alipay
statement_kind: transaction_statement
nodes:
  - id: select-archive
    type: select_attachment
    filename: "*.zip"
  - id: unzip
    type: unzip
    password_key: alipay_zip_password
  - id: select-csv
    type: select_artifact
    filename: "*.csv"
  - id: decode
    type: decode_text
    candidates: [utf-8, gb18030, gbk, big5]
  - id: table
    type: csv_table
    header_contains: [交易时间, 交易对方, 收/支, 金额, 交易订单号]
  - id: fields
    type: rename_fields
    mapping:
      交易时间: occurred_at
      交易分类: provider_category
      交易对方: counterparty
      对方账号: counterparty_account
      商品说明: description
      收/支: direction
      金额: amount
      收/付款方式: payment_method
      交易状态: provider_status
      交易订单号: provider_transaction_id
      商家订单号: merchant_order_id
      备注: remark
  - id: date
    type: parse_date
    source: occurred_at
  - id: amount
    type: parse_money
    source: amount
    negative_when:
      direction: [支出]
  - id: currency
    type: set_constant
    values:
      currency_code: CNY
  - id: normalize
    type: normalize_bill_rows
    default_currency: CNY
"#;

const WECHAT: &str = r#"
schema_version: 1
channel_key: wechat
statement_kind: transaction_statement
nodes:
  - id: select-html
    type: select_html_body
  - id: extract-link
    type: extract_links
    selector: "a[href*='downloadfilefromemail']"
  - id: download
    type: download
    allowed_domains: [tenpay.wechatpay.cn]
    timeout_seconds: 30
    max_bytes: 26214400
  - id: unzip
    type: unzip
    password_key: wechat_zip_password
  - id: table
    type: switch
    cases:
      - filename: "*.csv"
        parser:
          type: csv_table
          header_contains: [交易时间, 交易对方, 收/支, 金额(元), 交易单号]
      - filename: "*.xlsx"
        parser:
          type: xlsx_sheet
          header_contains: [交易时间, 交易对方, 收/支, 金额(元), 交易单号]
  - id: fields
    type: rename_fields
    mapping:
      交易时间: occurred_at
      交易类型: provider_category
      交易对方: counterparty
      商品: description
      收/支: direction
      金额(元): amount
      支付方式: payment_method
      当前状态: provider_status
      交易单号: provider_transaction_id
      商户单号: merchant_order_id
      备注: remark
  - id: date
    type: parse_date
    source: occurred_at
  - id: amount
    type: parse_money
    source: amount
    negative_when:
      direction: [支出]
  - id: currency
    type: set_constant
    values:
      currency_code: CNY
  - id: normalize
    type: normalize_bill_rows
    default_currency: CNY
"#;

const CMB_TRANSACTION: &str = r#"
schema_version: 1
channel_key: cmb
statement_kind: transaction_statement
nodes:
  - id: select-archive
    type: select_attachment
    filename: "*.zip"
  - id: unzip
    type: unzip
    password_key: cmb_zip_password
  - id: select-pdf
    type: select_artifact
    filename: "*.pdf"
  - id: pdf-text
    type: pdf_to_text
  - id: table
    type: whitespace_table
    columns: [date, currency_code, amount, balance_after, summary, counterparty]
    first_column_regex: '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
    min_columns: 5
  - id: description
    type: join_fields
    target: description
    sources: [summary, counterparty]
    separator: " - "
  - id: date
    type: parse_date
    source: date
    target: occurred_at
  - id: amount
    type: parse_money
    source: amount
  - id: normalize
    type: normalize_bill_rows
    default_currency: CNY
"#;

const CMB_CREDIT_DAILY: &str = r##"
schema_version: 1
channel_key: cmb
statement_kind: credit_card_daily
nodes:
  - id: select-html
    type: select_html_body
  - id: transactions
    type: html_elements
    row_selector: '#fixBand3 > table > tbody > tr[style*="height:61.6px"]'
    fields:
      time: 'span#fixBand5 font'
      amount: 'span#fixBand12 font[style*="font-size:16px"]'
      detail: 'span#fixBand12 font[style*="font-size:12px"]'
    document_fields:
      statement_date: '#loopHeader1 font[style*="font-size:19px"]'
  - id: fields
    type: transform_script
    source: |
      fn transform(row, context) {
          let date = row["statement_date"].sub_string(0, 10);
          date.replace("/", "-");
          let amount_parts = row["amount"].split(" ");
          let detail = row["detail"];
          let kind = detail.sub_string(7, 2);
          let signed = money(amount_parts[1]);
          if kind == "消费" || kind == "取现" {
              signed = "-" + signed;
          }
          let card = detail.sub_string(2, 4);
          let counterparty = detail.sub_string(10);
          emit(#{
              occurred_at: date + " " + row["time"],
              signed_amount: signed,
              currency_code: amount_parts[0],
              description: counterparty,
              counterparty: counterparty,
              account_hint: "招商银行信用卡(" + card + ")",
              payment_method: "招商银行信用卡(" + card + ")",
              provider_category: kind
          });
      }
  - id: normalize
    type: normalize_bill_rows
    default_currency: CNY
"##;

const BOC_TRANSACTION: &str = r#"
schema_version: 1
channel_key: boc
statement_kind: transaction_statement
nodes:
  - id: select-pdf
    type: select_attachment
    filename: "*.pdf"
  - id: pdf-text
    type: pdf_to_text
    password_key: boc_pdf_password
  - id: table
    type: whitespace_table
    columns: [date, time, currency, amount, balance_after, summary, channel, outlet, remark, counterparty, counterparty_account, counterparty_bank]
    first_column_regex: '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
    min_columns: 5
  - id: occurred
    type: join_fields
    target: occurred_at
    sources: [date, time]
    separator: " "
  - id: description
    type: join_fields
    target: description
    sources: [summary, counterparty, remark]
    separator: " - "
  - id: currency
    type: map_values
    field: currency
    values:
      人民币: CNY
    default: CNY
  - id: currency-field
    type: rename_fields
    mapping:
      currency: currency_code
  - id: date
    type: parse_date
    source: occurred_at
  - id: amount
    type: parse_money
    source: amount
  - id: normalize
    type: normalize_bill_rows
    default_currency: CNY
"#;

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::str::FromStr;

    use base64::Engine;
    use mail_parser::MessageParser;
    use rust_decimal::Decimal;
    use scraper::{Html, Selector};

    use super::*;
    use crate::parser::definition;
    use crate::parser::engine::{self, ParseContext};
    use crate::parser::model::{Node, NodeDefinition, ParseOutput};

    #[test]
    fn every_builtin_is_valid_and_has_a_stable_checksum() {
        let mut checksums = std::collections::BTreeSet::new();
        for flow in FLOWS {
            let definition = definition::parse_yaml(flow.source)
                .unwrap_or_else(|error| panic!("{}: {error}", flow.slug));
            let checksum = definition::checksum(&definition).unwrap();
            assert!(checksums.insert(checksum));
        }
    }

    #[test]
    fn public_cmb_daily_example_matches_the_builtin() {
        let public_example =
            include_str!("../../../../testdata/parser-workbench/cmb-credit-daily-flow.yaml");
        assert_eq!(
            definition::checksum(&definition::parse_yaml(public_example).unwrap()).unwrap(),
            definition::checksum(&flow("cmb-credit-card-daily")).unwrap()
        );
    }

    #[tokio::test]
    async fn golden_alipay_matches_the_legacy_parser() {
        let Some(bytes) = read_golden("9/derived/alipay-202606151853-20260515_20260615.csv") else {
            return;
        };
        let mut flow = flow("alipay-statement");
        replace_prefix_with_attachment(&mut flow.nodes, 3, "*.csv");
        let output = engine::execute(
            &flow,
            &attachment_eml("statement.csv", "application/octet-stream", &bytes),
            &ParseContext::default(),
        )
        .await
        .unwrap();

        assert_summary(&output, 167, "262.88");
        assert_eq!(
            output
                .valid_rows
                .first()
                .unwrap()
                .provider_transaction_id
                .as_deref(),
            Some("2026061522001414871443694067")
        );
        assert_eq!(
            output
                .valid_rows
                .last()
                .unwrap()
                .provider_transaction_id
                .as_deref(),
            Some("2026051523001114871455735901")
        );
    }

    #[tokio::test]
    async fn golden_wechat_matches_the_legacy_parser() {
        let Some(bytes) = read_golden("13/derived/wechat-pay-202606151913-20260515_20260615.xlsx")
        else {
            return;
        };
        let mut flow = flow("wechat-pay-statement");
        replace_prefix_with_attachment(&mut flow.nodes, 4, "*.xlsx");
        let output = engine::execute(
            &flow,
            &attachment_eml(
                "statement.xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                &bytes,
            ),
            &ParseContext::default(),
        )
        .await
        .unwrap();

        assert_summary(&output, 117, "2471.85");
        assert_eq!(
            output
                .valid_rows
                .first()
                .unwrap()
                .provider_transaction_id
                .as_deref(),
            Some("4500000196202606158689154966")
        );
        assert_eq!(
            output
                .valid_rows
                .last()
                .unwrap()
                .provider_transaction_id
                .as_deref(),
            Some("53110001633083202605153663961205")
        );
    }

    #[tokio::test]
    async fn golden_cmb_statement_matches_the_legacy_parser() {
        let Some(bytes) =
            read_golden("15/derived/cmb-transaction-202606161744-20260601_20260614.pdf")
        else {
            return;
        };
        let mut flow = flow("cmb-transaction-statement");
        replace_prefix_with_attachment(&mut flow.nodes, 3, "*.pdf");
        let output = engine::execute(
            &flow,
            &attachment_eml("statement.pdf", "application/pdf", &bytes),
            &ParseContext::default(),
        )
        .await
        .unwrap();

        assert_summary(&output, 85, "710.75");
        assert_eq!(
            output.valid_rows.first().unwrap().occurred_at,
            "2026-06-01 0:00:00.0"
        );
        assert_eq!(
            output.valid_rows.last().unwrap().occurred_at,
            "2026-06-14 0:00:00.0"
        );
    }

    #[tokio::test]
    async fn golden_boc_statement_matches_the_legacy_parser() {
        let Some(bytes) =
            read_golden("18/derived/boc-transaction-202606171644-20260601_20260617.txt")
        else {
            return;
        };
        let mut flow = flow("boc-transaction-statement");
        replace_prefix_with_attachment(&mut flow.nodes, 2, "*.txt");
        let output = engine::execute(
            &flow,
            &attachment_eml("statement.txt", "text/plain", &bytes),
            &ParseContext::default(),
        )
        .await
        .unwrap();

        assert_summary(&output, 8, "99.16");
        assert_eq!(
            output.valid_rows.first().unwrap().occurred_at,
            "2026-06-16 16:46:14.0"
        );
        assert_eq!(
            output.valid_rows.last().unwrap().occurred_at,
            "2026-06-10 11:03:31.0"
        );
    }

    #[tokio::test]
    async fn golden_cmb_daily_parses_every_transaction_from_the_real_eml() {
        let Some(raw_eml) = read_golden("1/20260809163337883/message-2527.eml") else {
            return;
        };
        let output = engine::execute(
            &flow("cmb-credit-card-daily"),
            &raw_eml,
            &ParseContext::default(),
        )
        .await
        .unwrap();

        assert_summary(&output, 9, "-306.79");
        assert_eq!(
            output.valid_rows.first().unwrap().description,
            "支付宝-千里香馄饨报春路"
        );
        assert_eq!(
            output.valid_rows.last().unwrap().description,
            "支付宝-上海盒马网络科技有限公司"
        );
    }

    #[tokio::test]
    async fn cmb_daily_parses_the_public_workbench_fixture() {
        let raw_eml =
            include_bytes!("../../../../testdata/parser-workbench/cmb-credit-daily-sample.eml");
        let message = MessageParser::default().parse(raw_eml).unwrap();
        let html = message.body_html(0).unwrap();
        let document = Html::parse_document(&html);
        let statement_date = document
            .select(&Selector::parse("#loopHeader1 font[style*='font-size:19px']").unwrap())
            .next()
            .map(|element| element.text().collect::<String>());
        assert_eq!(statement_date.as_deref(), Some("2026/08/11 每日账单"));
        let output = engine::execute(
            &flow("cmb-credit-card-daily"),
            raw_eml,
            &ParseContext::default(),
        )
        .await
        .unwrap();

        assert_summary(&output, 1, "-12.34");
        let row = output.valid_rows.first().unwrap();
        assert_eq!(row.occurred_at, "2026-08-11 08:30:00");
        assert_eq!(row.description, "测试商户");
        assert_eq!(row.account_hint.as_deref(), Some("招商银行信用卡(1234)"));
    }

    fn flow(slug: &str) -> crate::parser::model::ParserFlowDefinition {
        let builtin = FLOWS.iter().find(|flow| flow.slug == slug).unwrap();
        definition::parse_yaml(builtin.source).unwrap()
    }

    fn replace_prefix_with_attachment(
        nodes: &mut Vec<NodeDefinition>,
        prefix_len: usize,
        filename: &str,
    ) {
        nodes.splice(
            0..prefix_len,
            [NodeDefinition {
                id: "select-golden".to_owned(),
                enabled: true,
                operation: Node::SelectAttachment {
                    filename: Some(filename.to_owned()),
                    mime: None,
                    required: true,
                },
            }],
        );
    }

    fn assert_summary(output: &ParseOutput, expected_rows: usize, expected_total: &str) {
        assert_eq!(output.invalid_rows.len(), 0, "{:?}", output.invalid_rows);
        assert_eq!(output.valid_rows.len(), expected_rows);
        let total = output
            .valid_rows
            .iter()
            .map(|row| Decimal::from_str(&row.signed_amount).unwrap())
            .sum::<Decimal>();
        assert_eq!(total, Decimal::from_str(expected_total).unwrap());
    }

    fn read_golden(relative: &str) -> Option<Vec<u8>> {
        let path = golden_root().join(relative);
        if !path.exists() {
            eprintln!("跳过本机真实账单对拍，fixture 不存在：{}", path.display());
            return None;
        }
        Some(std::fs::read(path).unwrap())
    }

    fn golden_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../testdata/bill-inbox-golden")
    }

    fn attachment_eml(filename: &str, mime: &str, bytes: &[u8]) -> Vec<u8> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        let body = encoded
            .as_bytes()
            .chunks(76)
            .map(|chunk| std::str::from_utf8(chunk).unwrap())
            .collect::<Vec<_>>()
            .join("\r\n");
        format!(
            "From: bank@example.com\r\nTo: user@example.com\r\nSubject: golden\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=golden\r\n\r\n--golden\r\nContent-Type: text/plain; charset=utf-8\r\n\r\ngolden\r\n--golden\r\nContent-Type: {mime}; name=\"{filename}\"\r\nContent-Disposition: attachment; filename=\"{filename}\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{body}\r\n--golden--\r\n"
        )
        .into_bytes()
    }
}
