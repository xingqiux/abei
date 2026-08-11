//! 鉴权：透传 Firefly 的个人访问令牌，自己不存密码也不发令牌。

use axum::extract::{FromRequestParts, Request, State};
use axum::http::HeaderMap;
use axum::http::request::Parts;
use axum::middleware::Next;
use axum::response::Response;

use crate::firefly::VerifiedUser;
use crate::problem::Problem;
use crate::state::AppState;

/// 当前请求携带的 Firefly 令牌，由鉴权中间件放进扩展里。
#[derive(Clone, Debug)]
pub struct AuthToken(pub String);

/// 已由 Firefly 验证的用户身份，供内部后端做权限和审计。
#[derive(Clone, Debug)]
pub struct AuthIdentity(pub VerifiedUser);

impl<S: Send + Sync> FromRequestParts<S> for AuthToken {
    type Rejection = Problem;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<AuthToken>()
            .cloned()
            .ok_or_else(Problem::missing_token)
    }
}

pub async fn require_token(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, Problem> {
    let token = bearer(request.headers()).ok_or_else(Problem::missing_token)?;
    let identity = state.verify(&token).await?;
    request.extensions_mut().insert(AuthToken(token));
    request.extensions_mut().insert(AuthIdentity(identity));
    Ok(next.run(request).await)
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("authorization")?.to_str().ok()?;
    let (scheme, token) = raw.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn accepts_bearer_case_insensitively() {
        assert_eq!(bearer(&headers("Bearer abc")).as_deref(), Some("abc"));
        assert_eq!(bearer(&headers("bearer abc")).as_deref(), Some("abc"));
    }

    #[test]
    fn rejects_other_schemes_and_empty_tokens() {
        assert!(bearer(&headers("Basic abc")).is_none());
        assert!(bearer(&headers("Bearer   ")).is_none());
        assert!(bearer(&HeaderMap::new()).is_none());
    }
}
