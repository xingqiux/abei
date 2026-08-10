use std::fmt;
use std::str::FromStr;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 风险档。read 直接执行；draft 只写草稿；confirm 必须人工确认后才落库。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Read,
    Draft,
    Confirm,
}

impl Risk {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Draft => "draft",
            Self::Confirm => "confirm",
        }
    }

    /// 只读能力不需要 --dry-run / --yes 闸门。
    pub fn is_write(self) -> bool {
        !matches!(self, Self::Read)
    }
}

/// 这条能力当前由谁执行。把某个域从 Firefly 搬进阿贝时只改这一格，客户端无感。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Firefly,
    Abei,
    Agent,
}

impl Backend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Firefly => "firefly",
            Self::Abei => "abei",
            Self::Agent => "agent",
        }
    }
}

/// HTTP 方法。core 不依赖 http crate，自带一份够用的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    Get,
    Post,
    Patch,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
        }
    }
}

impl fmt::Display for Method {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 动词作用在集合上还是单个对象上，决定路由里带不带 {id}。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Collection,
    Item,
}

/// 固定动词表。跨资源含义一致，不允许同义动词并存（不会同时有 add 和 create）。
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum Verb {
    List,
    Show,
    Create,
    Update,
    Delete,
    Summary,
    Search,
    Review,
    Import,
    Ignore,
    Retry,
    Sync,
    Process,
    Unlock,
    Split,
}

impl Verb {
    pub const ALL: &'static [Verb] = &[
        Verb::List,
        Verb::Show,
        Verb::Create,
        Verb::Update,
        Verb::Delete,
        Verb::Summary,
        Verb::Search,
        Verb::Review,
        Verb::Import,
        Verb::Ignore,
        Verb::Retry,
        Verb::Sync,
        Verb::Process,
        Verb::Unlock,
        Verb::Split,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Show => "show",
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
            Self::Summary => "summary",
            Self::Search => "search",
            Self::Review => "review",
            Self::Import => "import",
            Self::Ignore => "ignore",
            Self::Retry => "retry",
            Self::Sync => "sync",
            Self::Process => "process",
            Self::Unlock => "unlock",
            Self::Split => "split",
        }
    }

    /// 五个标准 CRUD 动词走裸 REST 路径，其余动词在路径末尾追加自己的名字。
    pub fn is_crud(self) -> bool {
        matches!(
            self,
            Self::List | Self::Show | Self::Create | Self::Update | Self::Delete
        )
    }

    pub fn target(self) -> Target {
        match self {
            Self::List
            | Self::Create
            | Self::Summary
            | Self::Search
            | Self::Sync
            | Self::Process => Target::Collection,
            Self::Show
            | Self::Update
            | Self::Delete
            | Self::Review
            | Self::Import
            | Self::Ignore
            | Self::Retry
            | Self::Unlock
            | Self::Split => Target::Item,
        }
    }

    pub fn method(self) -> Method {
        match self {
            Self::List | Self::Show | Self::Summary | Self::Search | Self::Review => Method::Get,
            Self::Create
            | Self::Import
            | Self::Ignore
            | Self::Retry
            | Self::Unlock
            | Self::Split
            | Self::Sync
            | Self::Process => Method::Post,
            Self::Update => Method::Patch,
            Self::Delete => Method::Delete,
        }
    }
}

impl fmt::Display for Verb {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerbParseError(pub String);

impl fmt::Display for VerbParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "未知动词：{}", self.0)
    }
}

impl std::error::Error for VerbParseError {}

impl FromStr for Verb {
    type Err = VerbParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Verb::ALL
            .iter()
            .copied()
            .find(|verb| verb.as_str() == value)
            .ok_or_else(|| VerbParseError(value.to_owned()))
    }
}

/// 一条示例。command 给 CLI 帮助和文档用，params 给 agent 和 web 用，二者等价。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Example {
    /// 中文说明这条示例在做什么。
    pub title: String,
    /// 等价的命令行写法。
    pub command: String,
    /// 等价的参数对象。
    pub params: Value,
}

impl Example {
    pub fn new(title: &str, command: &str, params: Value) -> Self {
        Self {
            title: title.to_owned(),
            command: command.to_owned(),
            params,
        }
    }
}

/// 一条能力。
pub struct Capability {
    pub resource: &'static str,
    pub verb: Verb,
    pub risk: Risk,
    pub backend: Backend,
    /// 中文标签。CLI 帮助、web 助手工具行、审批卡都用这一份，不再各自硬编码。
    pub label: &'static str,
    pub description: &'static str,
    pub examples: Vec<Example>,
    pub params: Schema,
}

impl Capability {
    pub fn define(resource: &'static str, verb: Verb) -> CapabilityBuilder {
        CapabilityBuilder {
            resource,
            verb,
            risk: Risk::Read,
            backend: Backend::Firefly,
            label: "",
            description: "",
            examples: Vec::new(),
        }
    }

    /// 稳定标识，形如 `transactions.list`。
    pub fn id(&self) -> String {
        format!("{}.{}", self.resource, self.verb)
    }

    /// agent 工具名。连字符换下划线，满足各家模型对工具名的字符限制。
    pub fn tool_name(&self) -> String {
        format!("{}_{}", self.resource.replace('-', "_"), self.verb)
    }

    /// CLI 命令路径，名词在前。
    pub fn command_path(&self) -> [&str; 2] {
        [self.resource, self.verb.as_str()]
    }

    /// HTTP 路由模板。CRUD 走裸 REST 路径，意图动词追加动词段。
    pub fn route_path(&self) -> String {
        let base = format!("/v1/{}", self.resource);
        match (self.verb.target(), self.verb.is_crud()) {
            (Target::Collection, true) => base,
            (Target::Collection, false) => format!("{base}/{}", self.verb),
            (Target::Item, true) => format!("{base}/{{id}}"),
            (Target::Item, false) => format!("{base}/{{id}}/{}", self.verb),
        }
    }

    pub fn method(&self) -> Method {
        self.verb.method()
    }

    /// 只能由人现场输入的参数名（密码、验证码这类）。
    ///
    /// 从参数模式里的 `x-abei-human-only` 读出来，按声明顺序。agent 拿它决定
    /// 「哪些字段不给模型看、要弹给人填」，不必自己走一遍 schema，更不必另存一份名单。
    pub fn human_only(&self) -> Vec<String> {
        self.params
            .as_value()
            .get("properties")
            .and_then(Value::as_object)
            .map(|properties| {
                properties
                    .iter()
                    .filter(|(_, schema)| {
                        schema.get("x-abei-human-only") == Some(&Value::Bool(true))
                    })
                    .map(|(name, _)| name.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 命令行上不带 `--` 直接写的那个参数名。
    ///
    /// 从参数模式里的 `x-abei-positional` 读出来。`abei tx search 星巴克` 比
    /// `abei tx search --query 星巴克` 顺口，而这件事只该在参数定义里说一次。
    /// id 不用标：路径里带 {id} 的能力自动就是位置参数。
    pub fn positional(&self) -> Option<String> {
        self.params
            .as_value()
            .get("properties")
            .and_then(Value::as_object)?
            .iter()
            .find(|(_, schema)| schema.get("x-abei-positional") == Some(&Value::Bool(true)))
            .map(|(name, _)| name.clone())
    }

    pub fn view(&self) -> CapabilityView {
        CapabilityView {
            id: self.id(),
            resource: self.resource.to_owned(),
            verb: self.verb,
            risk: self.risk,
            backend: self.backend,
            label: self.label.to_owned(),
            description: self.description.to_owned(),
            method: self.method(),
            path: self.route_path(),
            tool_name: self.tool_name(),
            command: self.command_path().map(str::to_owned).to_vec(),
            human_only: self.human_only(),
            examples: self.examples.clone(),
            params: self.params.clone(),
        }
    }
}

impl fmt::Debug for Capability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Capability")
            .field("id", &self.id())
            .field("risk", &self.risk)
            .field("backend", &self.backend)
            .finish()
    }
}

pub struct CapabilityBuilder {
    resource: &'static str,
    verb: Verb,
    risk: Risk,
    backend: Backend,
    label: &'static str,
    description: &'static str,
    examples: Vec<Example>,
}

impl CapabilityBuilder {
    pub fn risk(mut self, risk: Risk) -> Self {
        self.risk = risk;
        self
    }

    pub fn backend(mut self, backend: Backend) -> Self {
        self.backend = backend;
        self
    }

    pub fn label(mut self, label: &'static str) -> Self {
        self.label = label;
        self
    }

    pub fn description(mut self, description: &'static str) -> Self {
        self.description = description;
        self
    }

    pub fn example(mut self, title: &str, command: &str, params: Value) -> Self {
        self.examples.push(Example::new(title, command, params));
        self
    }

    /// 收尾：绑定参数类型，从它生成 JSON Schema。
    pub fn params<P: JsonSchema>(self) -> Capability {
        let mut schema = SchemaGenerator::default().into_root_schema_for::<P>();
        inline_defs(&mut schema);
        Capability {
            resource: self.resource,
            verb: self.verb,
            risk: self.risk,
            backend: self.backend,
            label: self.label,
            description: self.description,
            examples: self.examples,
            params: schema,
        }
    }
}

/// 把 `$ref` 展开成实际内容，`$defs` 随后丢掉。
///
/// 目录是给三种消费者看的：CLI 按它生成 flag、agent 按它生成工具定义、web 按它生成类型。
/// 三边都得自己解引用的话，就等于同一件事写三遍——不如在唯一真源这里摊平一次。
/// 参数类型都是浅层结构，展开不会炸；真出现自引用会在这里被 `depth` 拦住。
fn inline_defs(schema: &mut Schema) {
    let Some(root) = schema.as_object().cloned() else {
        return;
    };
    let Some(Value::Object(defs)) = root.get("$defs").cloned() else {
        return;
    };

    if let Some(object) = schema.as_object_mut() {
        let mut value = Value::Object(object.clone());
        expand(&mut value, &defs, 0);
        if let Value::Object(expanded) = value {
            *object = expanded
                .into_iter()
                .filter(|(key, _)| key != "$defs")
                .collect();
        }
    }
}

fn expand(value: &mut Value, defs: &serde_json::Map<String, Value>, depth: u8) {
    if depth > 8 {
        return;
    }
    match value {
        Value::Object(map) => {
            if let Some(name) = map
                .get("$ref")
                .and_then(Value::as_str)
                .and_then(|reference| reference.strip_prefix("#/$defs/"))
                && let Some(target) = defs.get(name)
            {
                let mut resolved = target.clone();
                expand(&mut resolved, defs, depth + 1);
                // `$ref` 旁边写的东西（比如 description）盖在展开结果上。
                if let Value::Object(resolved) = &mut resolved {
                    for (key, own) in map.iter() {
                        if key != "$ref" {
                            resolved.insert(key.clone(), own.clone());
                        }
                    }
                }
                *value = resolved;
                return;
            }
            for nested in map.values_mut() {
                expand(nested, defs, depth + 1);
            }
        }
        Value::Array(items) => {
            for item in items {
                expand(item, defs, depth + 1);
            }
        }
        _ => {}
    }
}

/// 能力的对外形态。`/v1/catalog` 输出的就是它，CLI 与 agent 反序列化的也是它。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityView {
    pub id: String,
    pub resource: String,
    pub verb: Verb,
    pub risk: Risk,
    pub backend: Backend,
    pub label: String,
    pub description: String,
    pub method: Method,
    pub path: String,
    pub tool_name: String,
    pub command: Vec<String>,
    /// 只能由人现场输入的参数名。空数组是常态。
    pub human_only: Vec<String>,
    pub examples: Vec<Example>,
    pub params: Schema,
}
