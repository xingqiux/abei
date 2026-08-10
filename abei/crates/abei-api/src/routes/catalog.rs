//! 能力目录。CLI 靠它做 explain 和 did-you-mean，agent 靠它构造工具，
//! web 靠它取中文标签和表单 schema——三边不再各存一份。

use axum::Json;
use serde_json::Value;

use crate::problem::Problem;

pub async fn get_catalog() -> Result<Json<Value>, Problem> {
    let view = abei_core::catalog().view();
    serde_json::to_value(view)
        .map(Json)
        .map_err(|error| Problem::internal(error.to_string()))
}
