# syntax=docker/dockerfile:1.7

FROM rust:1.93-bookworm AS builder

WORKDIR /workspace
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
COPY migrations ./migrations
RUN --mount=type=cache,id=granary-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=granary-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=granary-release-target,target=/workspace/target \
    cargo build --release --locked \
    && cp /workspace/target/release/granary-server /granary-server

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /granary-server /usr/local/bin/granary-server

EXPOSE 8080
ENTRYPOINT ["granary-server"]
CMD ["serve"]
