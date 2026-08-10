# syntax=docker/dockerfile:1.7
#
# abei-api。构建上下文是 abei/ 这个 workspace 根。
# CLI 不在这里打包：那是装在人的机器上的东西，不该塞进服务镜像。

FROM rust:1.93-bookworm AS builder

WORKDIR /workspace
COPY Cargo.toml Cargo.lock* ./
COPY crates ./crates
RUN --mount=type=cache,id=abei-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=abei-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=abei-release-target,target=/workspace/target \
    cargo build --release --locked --bin abei-api \
    && cp /workspace/target/release/abei-api /abei-api

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /abei-api /usr/local/bin/abei-api

# 容器里必须监听 0.0.0.0，默认的 127.0.0.1 在容器里等于谁都连不上。
ENV ABEI_API_HOST=0.0.0.0 \
    ABEI_API_PORT=18002

EXPOSE 18002

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS http://127.0.0.1:18002/health || exit 1

ENTRYPOINT ["abei-api"]
