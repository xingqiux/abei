use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

const MAX_DEPTH: usize = 8;
const MAX_NODES: usize = 100;
const MAX_VALUE_CHARS: usize = 512;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Condition {
    All {
        conditions: Vec<Condition>,
    },
    Any {
        conditions: Vec<Condition>,
    },
    Not {
        condition: Box<Condition>,
    },
    Text {
        field: TextField,
        operator: TextOperator,
        value: String,
        #[serde(default)]
        header_name: Option<String>,
    },
    AttachmentCount {
        operator: NumberOperator,
        value: usize,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextField {
    From,
    To,
    Subject,
    Folder,
    Header,
    BodyText,
    BodyHtml,
    AttachmentFilename,
    AttachmentExtension,
    AttachmentMime,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextOperator {
    Equals,
    Contains,
    Prefix,
    Suffix,
    Domain,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NumberOperator {
    Equals,
    AtLeast,
    AtMost,
}

#[derive(Debug, Clone, Default)]
pub struct MailFacts {
    pub from: Option<String>,
    pub to: Vec<String>,
    pub subject: Option<String>,
    pub folder: String,
    pub headers: BTreeMap<String, Vec<String>>,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub attachments: Vec<AttachmentFacts>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AttachmentFacts {
    pub filename: String,
    pub mime: String,
    pub size: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub kind: &'static str,
    pub matched: bool,
    pub reason: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MetadataMatch {
    Matched,
    Unmatched,
    NeedsContent,
}

impl Condition {
    pub fn validate(&self) -> Result<(), String> {
        let mut nodes = 0;
        self.validate_at(0, &mut nodes)
    }

    pub fn evaluate(&self, facts: &MailFacts) -> Diagnostic {
        match self {
            Self::All { conditions } => {
                let children = conditions
                    .iter()
                    .map(|condition| condition.evaluate(facts))
                    .collect::<Vec<_>>();
                let matched = !children.is_empty() && children.iter().all(|item| item.matched);
                Diagnostic {
                    kind: "all",
                    matched,
                    reason: format!(
                        "{} / {} 个条件通过",
                        children.iter().filter(|item| item.matched).count(),
                        children.len()
                    ),
                    children,
                }
            }
            Self::Any { conditions } => {
                let children = conditions
                    .iter()
                    .map(|condition| condition.evaluate(facts))
                    .collect::<Vec<_>>();
                let matched = children.iter().any(|item| item.matched);
                Diagnostic {
                    kind: "any",
                    matched,
                    reason: format!(
                        "{} / {} 个条件通过",
                        children.iter().filter(|item| item.matched).count(),
                        children.len()
                    ),
                    children,
                }
            }
            Self::Not { condition } => {
                let child = condition.evaluate(facts);
                Diagnostic {
                    kind: "not",
                    matched: !child.matched,
                    reason: if child.matched {
                        "内部条件命中，因此否定条件不通过".to_owned()
                    } else {
                        "内部条件未命中，因此否定条件通过".to_owned()
                    },
                    children: vec![child],
                }
            }
            Self::Text {
                field,
                operator,
                value,
                header_name,
            } => {
                let candidates = candidates(*field, header_name.as_deref(), facts);
                let matched = candidates
                    .iter()
                    .any(|candidate| text_matches(candidate, *operator, value));
                Diagnostic {
                    kind: "text",
                    matched,
                    reason: format!(
                        "检查 {} 个值，{}",
                        candidates.len(),
                        if matched { "已命中" } else { "未命中" }
                    ),
                    children: Vec::new(),
                }
            }
            Self::AttachmentCount { operator, value } => {
                let count = facts.attachments.len();
                let matched = match operator {
                    NumberOperator::Equals => count == *value,
                    NumberOperator::AtLeast => count >= *value,
                    NumberOperator::AtMost => count <= *value,
                };
                Diagnostic {
                    kind: "attachment_count",
                    matched,
                    reason: format!("实际附件数为 {count}"),
                    children: Vec::new(),
                }
            }
        }
    }

    pub fn requires_body(&self) -> bool {
        match self {
            Self::All { conditions } | Self::Any { conditions } => {
                conditions.iter().any(Self::requires_body)
            }
            Self::Not { condition } => condition.requires_body(),
            Self::Text { field, .. } => matches!(field, TextField::BodyText | TextField::BodyHtml),
            Self::AttachmentCount { .. } => false,
        }
    }

    pub(crate) fn metadata_match(&self, facts: &MailFacts) -> MetadataMatch {
        match self {
            Self::All { conditions } => {
                let mut needs_content = false;
                for condition in conditions {
                    match condition.metadata_match(facts) {
                        MetadataMatch::Unmatched => return MetadataMatch::Unmatched,
                        MetadataMatch::NeedsContent => needs_content = true,
                        MetadataMatch::Matched => {}
                    }
                }
                if needs_content {
                    MetadataMatch::NeedsContent
                } else {
                    MetadataMatch::Matched
                }
            }
            Self::Any { conditions } => {
                let mut needs_content = false;
                for condition in conditions {
                    match condition.metadata_match(facts) {
                        MetadataMatch::Matched => return MetadataMatch::Matched,
                        MetadataMatch::NeedsContent => needs_content = true,
                        MetadataMatch::Unmatched => {}
                    }
                }
                if needs_content {
                    MetadataMatch::NeedsContent
                } else {
                    MetadataMatch::Unmatched
                }
            }
            Self::Not { condition } => match condition.metadata_match(facts) {
                MetadataMatch::Matched => MetadataMatch::Unmatched,
                MetadataMatch::Unmatched => MetadataMatch::Matched,
                MetadataMatch::NeedsContent => MetadataMatch::NeedsContent,
            },
            Self::Text {
                field: TextField::BodyText | TextField::BodyHtml,
                ..
            } => MetadataMatch::NeedsContent,
            _ => {
                if self.evaluate(facts).matched {
                    MetadataMatch::Matched
                } else {
                    MetadataMatch::Unmatched
                }
            }
        }
    }

    fn validate_at(&self, depth: usize, nodes: &mut usize) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err(format!("条件嵌套最多 {MAX_DEPTH} 层。"));
        }
        *nodes += 1;
        if *nodes > MAX_NODES {
            return Err(format!("一条规则最多 {MAX_NODES} 个条件。"));
        }

        match self {
            Self::All { conditions } | Self::Any { conditions } => {
                if conditions.is_empty() {
                    return Err("all/any 条件组不能为空。".to_owned());
                }
                for condition in conditions {
                    condition.validate_at(depth + 1, nodes)?;
                }
            }
            Self::Not { condition } => condition.validate_at(depth + 1, nodes)?,
            Self::Text {
                field,
                operator,
                value,
                header_name,
            } => {
                let value = value.trim();
                if value.is_empty() || value.chars().count() > MAX_VALUE_CHARS {
                    return Err(format!("条件值必须是 1 到 {MAX_VALUE_CHARS} 个字符。"));
                }
                if *field == TextField::Header {
                    let name = header_name.as_deref().unwrap_or("");
                    if name.is_empty()
                        || name.len() > 80
                        || !name
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                    {
                        return Err("Header 条件需要合法的 header_name。".to_owned());
                    }
                } else if header_name.is_some() {
                    return Err("只有 Header 条件可以提供 header_name。".to_owned());
                }
                if *operator == TextOperator::Domain
                    && !matches!(field, TextField::From | TextField::To)
                {
                    return Err("domain 操作只适用于 from 或 to。".to_owned());
                }
            }
            Self::AttachmentCount { value, .. } if *value > 1000 => {
                return Err("附件数量条件不能超过 1000。".to_owned());
            }
            Self::AttachmentCount { .. } => {}
        }
        Ok(())
    }
}

fn candidates<'a>(
    field: TextField,
    header_name: Option<&str>,
    facts: &'a MailFacts,
) -> Vec<&'a str> {
    match field {
        TextField::From => facts.from.as_deref().into_iter().collect(),
        TextField::To => facts.to.iter().map(String::as_str).collect(),
        TextField::Subject => facts.subject.as_deref().into_iter().collect(),
        TextField::Folder => vec![facts.folder.as_str()],
        TextField::Header => header_name
            .and_then(|name| facts.headers.get(&name.to_ascii_lowercase()))
            .map(|values| values.iter().map(String::as_str).collect())
            .unwrap_or_default(),
        TextField::BodyText => facts.body_text.as_deref().into_iter().collect(),
        TextField::BodyHtml => facts.body_html.as_deref().into_iter().collect(),
        TextField::AttachmentFilename => facts
            .attachments
            .iter()
            .map(|attachment| attachment.filename.as_str())
            .collect(),
        TextField::AttachmentExtension => facts
            .attachments
            .iter()
            .filter_map(|attachment| attachment.filename.rsplit_once('.').map(|(_, ext)| ext))
            .collect(),
        TextField::AttachmentMime => facts
            .attachments
            .iter()
            .map(|attachment| attachment.mime.as_str())
            .collect(),
    }
}

fn text_matches(candidate: &str, operator: TextOperator, expected: &str) -> bool {
    let candidate = candidate.trim().to_lowercase();
    let expected = expected.trim().to_lowercase();
    match operator {
        TextOperator::Equals => candidate == expected,
        TextOperator::Contains => candidate.contains(&expected),
        TextOperator::Prefix => candidate.starts_with(&expected),
        TextOperator::Suffix => candidate.ends_with(&expected),
        TextOperator::Domain => {
            let domain = candidate
                .rsplit_once('@')
                .map(|(_, domain)| domain)
                .unwrap_or(candidate.as_str());
            domain == expected || domain.ends_with(&format!(".{expected}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> MailFacts {
        MailFacts {
            from: Some("service@mail.example.com".to_owned()),
            to: vec!["me@example.net".to_owned()],
            subject: Some("八月交易流水".to_owned()),
            folder: "INBOX".to_owned(),
            attachments: vec![AttachmentFacts {
                filename: "statement-202608.csv".to_owned(),
                mime: "text/csv".to_owned(),
                size: 42,
            }],
            ..MailFacts::default()
        }
    }

    #[test]
    fn nested_conditions_return_explainable_results() {
        let condition = Condition::All {
            conditions: vec![
                Condition::Text {
                    field: TextField::From,
                    operator: TextOperator::Domain,
                    value: "example.com".to_owned(),
                    header_name: None,
                },
                Condition::Text {
                    field: TextField::AttachmentExtension,
                    operator: TextOperator::Equals,
                    value: "csv".to_owned(),
                    header_name: None,
                },
            ],
        };
        condition.validate().unwrap();
        let diagnostic = condition.evaluate(&facts());
        assert!(diagnostic.matched);
        assert_eq!(diagnostic.children.len(), 2);
    }

    #[test]
    fn body_only_rules_are_detected_before_imap_fetch() {
        let condition = Condition::Not {
            condition: Box::new(Condition::Text {
                field: TextField::BodyHtml,
                operator: TextOperator::Contains,
                value: "交易明细".to_owned(),
                header_name: None,
            }),
        };
        assert!(condition.requires_body());
        assert_eq!(
            condition.metadata_match(&facts()),
            MetadataMatch::NeedsContent
        );
    }

    #[test]
    fn metadata_can_reject_a_body_rule_without_fetching_content() {
        let condition = Condition::All {
            conditions: vec![
                Condition::Text {
                    field: TextField::From,
                    operator: TextOperator::Domain,
                    value: "bank.example".to_owned(),
                    header_name: None,
                },
                Condition::Text {
                    field: TextField::BodyText,
                    operator: TextOperator::Contains,
                    value: "statement".to_owned(),
                    header_name: None,
                },
            ],
        };
        assert_eq!(condition.metadata_match(&facts()), MetadataMatch::Unmatched);
    }

    #[test]
    fn metadata_short_circuits_an_any_group() {
        let condition = Condition::Any {
            conditions: vec![
                Condition::Text {
                    field: TextField::Subject,
                    operator: TextOperator::Contains,
                    value: "交易流水".to_owned(),
                    header_name: None,
                },
                Condition::Text {
                    field: TextField::BodyText,
                    operator: TextOperator::Contains,
                    value: "statement".to_owned(),
                    header_name: None,
                },
            ],
        };
        assert_eq!(condition.metadata_match(&facts()), MetadataMatch::Matched);
    }

    #[test]
    fn empty_groups_and_misplaced_domain_operators_are_rejected() {
        assert!(Condition::All { conditions: vec![] }.validate().is_err());
        assert!(
            Condition::Text {
                field: TextField::Subject,
                operator: TextOperator::Domain,
                value: "example.com".to_owned(),
                header_name: None,
            }
            .validate()
            .is_err()
        );
    }
}
