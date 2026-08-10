# abei

阿贝的 Rust workspace。

- `crates/abei-core` — 能力目录。一条能力是「资源 × 动词 × 参数 schema」，加上风险档和当前后端。
  resource 和 verb 是一等字段，命令路径、agent 工具名、HTTP 路由都由它们直接算出，没有翻译表。
- `crates/abei-api` — HTTP 服务。资源接口、能力目录端点、Firefly 透传逃生舱。

## 跑起来

```sh
cargo run -p abei-api
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ABEI_API_HOST` | `127.0.0.1` | 监听地址 |
| `ABEI_API_PORT` | `18002` | 监听端口 |
| `FIREFLY_URL` | `http://127.0.0.1:18001` | Firefly III 地址 |
| `ABEI_LOG` | `info` | 日志级别 |

鉴权是把 Firefly 的个人访问令牌原样透传：请求带 `Authorization: Bearer <PAT>`，
abei-api 拿它问一次 Firefly，结果缓存 60 秒。自己不存密码也不发令牌。

## 接口

| 路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /health` | 否 | 健康检查 |
| `GET /v1/openapi.json` | 否 | OpenAPI 文档，从能力目录算出来，给 web 端生成类型用 |
| `GET /v1/catalog` | 是 | 能力目录：资源、动词、schema、风险档、中文标签、示例 |
| `GET /v1/transactions` | 是 | 查交易 |
| `GET /v1/transactions/{id}` | 是 | 查单笔 |
| `GET /v1/transactions/summary` | 是 | 消费汇总 |
| `GET /v1/accounts` | 是 | 查账户 |
| `* /v1/firefly/*path` | 是 | 透传逃生舱，还没建模的 Firefly 接口从这里走 |

错误一律是 RFC 9457 problem+json：`reason` 是机读驼峰码，`title`/`detail` 给人看，
出错时还会带上 `resource`/`verb` 指明是哪条能力。

## 验证门

三条都要过：

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

测试不依赖本机跑着 Firefly，集成测试自带一个假的。
