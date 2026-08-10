SHELL := /bin/sh
COMPOSE := docker compose
WEB_DIR := abei-web
APP_DIR := firefly-iii
AGENT_DIR := abei-agent
ABEI_DIR := abei

# Firefly 对外端口。改这里要同步改 .env 的 FIREFLY_PORT 和 abei-web/vite.config.ts 的 proxy。
FIREFLY_PORT := $(or $(FIREFLY_PORT),18001)
BILL_WORKER_INTERVAL := $(or $(BILL_WORKER_INTERVAL),300)

# 本机 artisan serve 用 root .env 的同套 PostgreSQL（db 容器映射在 127.0.0.1:15432）。
DEV_DB_ENV := DB_CONNECTION=pgsql DB_HOST=127.0.0.1 DB_PORT=$(or $(POSTGRES_PORT),15432) \
	DB_DATABASE=$(or $(POSTGRES_DB),firefly) DB_USERNAME=$(or $(POSTGRES_USER),firefly) \
	DB_PASSWORD=$(or $(POSTGRES_PASSWORD),firefly-local-only)

.DEFAULT_GOAL := help

.PHONY: help dev dev-web up down logs test test-web test-backend test-agent test-rust test-e2e build build-image

help:
	@echo "dev         本地开发：起 db/mail + 本机 Firefly/abei-api/agent/worker + vite (5173)"
	@echo "dev-web     只开发前端：Firefly、abei-api 与 agent 用容器跑，本机起 vite (5173)"
	@echo "up          起 7 个容器：db mail app bill-worker abei-api abei-agent abei-web"
	@echo "down        停本地容器"
	@echo "logs        跟随 app、bill-worker、abei-api、abei-agent 与 abei-web 日志"
	@echo "test        全部测试：web vitest + Firefly PHPUnit + agent vitest + abei 三道闸"
	@echo "test-e2e    浏览器主路径：起 db/mail/app/abei-api + playwright（自己拉 vite，数据现播）"
	@echo "build       出产物：abei-web 静态 + abei-agent 打包 + abei release 二进制 + composer 装依赖"
	@echo "build-image 构建 app、abei-api、abei-agent 与 abei-web 镜像"
	@echo ""
	@echo "宿主端口：18001 Firefly / 18002 abei-api / 18003 abei-agent / 18004 abei-web"

.env:
	cp .env.example .env

up: .env
	$(COMPOSE) up -d --build --wait db mail app bill-worker abei-api abei-agent abei-web

down:
	$(COMPOSE) down --remove-orphans

logs:
	$(COMPOSE) logs -f app bill-worker abei-api abei-agent abei-web

# `make dev` 的本机 abei-api 与容器版抢 18002，所以停掉容器版；dev-web 只开发前端，
# 后端三项都留在 Docker 网络里，只停会占用页面入口的 abei-web。
dev: .env
	@command -v php >/dev/null || { echo "需要本机 PHP：make dev 用 artisan serve 跑 Firefly" >&2; exit 2; }
	@command -v cargo >/dev/null || { echo "需要本机 Rust：make dev 用 cargo run 跑 abei-api" >&2; exit 2; }
	$(COMPOSE) up -d --wait db mail
	@echo "停掉 app/bill-worker/abei-api/abei-agent/abei-web 容器，把端口让给本机开发进程（make up 可恢复）"
	@$(COMPOSE) stop app bill-worker abei-api abei-agent abei-web >/dev/null 2>&1 || true
	@cd $(APP_DIR) && $(DEV_DB_ENV) php artisan migrate --force
	@set -eu; \
		( cd $(APP_DIR) && exec env $(DEV_DB_ENV) php artisan serve --host=127.0.0.1 --port=$(FIREFLY_PORT) ) & \
		php_pid=$$!; \
		( cd $(APP_DIR) && while true; do env $(DEV_DB_ENV) php artisan firefly-iii:sync-bill-mailbox --limit=100 || true; env $(DEV_DB_ENV) php artisan firefly-iii:process-bill-tasks --limit=100 || true; sleep $(BILL_WORKER_INTERVAL); done ) & \
		worker_pid=$$!; \
		( cd $(ABEI_DIR) && exec env FIREFLY_URL=http://127.0.0.1:$(FIREFLY_PORT) cargo run -q -p abei-api ) & \
		api_pid=$$!; \
		( set -a; . ./.env; set +a; cd $(AGENT_DIR) && exec env $(DEV_DB_ENV) FIREFLY_URL=http://127.0.0.1:$(FIREFLY_PORT) npm run dev -- agent serve ) & \
		agent_pid=$$!; \
		trap 'kill $$php_pid $$worker_pid $$api_pid $$agent_pid 2>/dev/null || true' INT TERM EXIT; \
		cd $(WEB_DIR) && npm run dev

dev-web: .env
	$(COMPOSE) up -d --build --wait db mail app bill-worker abei-api abei-agent
	@$(COMPOSE) stop abei-web >/dev/null 2>&1 || true
	cd $(WEB_DIR) && npm run dev

test: test-web test-backend test-agent test-rust

test-web:
	cd $(WEB_DIR) && npm run test:run

# test-db 的数据在 tmpfs 里，随容器存活。跑前跑后都清掉，保证每次都是空库开始，
# 中途失败也不会把半截迁移状态留给下一次。
test-backend:
	$(COMPOSE) build backend-test
	@$(COMPOSE) rm -fsv test-db >/dev/null 2>&1 || true
	@trap '$(COMPOSE) rm -fsv test-db >/dev/null 2>&1 || true' EXIT INT TERM; \
		$(COMPOSE) run --rm backend-test

test-agent:
	$(COMPOSE) run --rm agent-test

# abei 的三道闸，缺一不可。
test-rust:
	cd $(ABEI_DIR) && cargo fmt --all -- --check
	cd $(ABEI_DIR) && cargo clippy --workspace --all-targets --all-features -- -D warnings
	cd $(ABEI_DIR) && cargo test --workspace --all-features

# e2e 要 db/mail/app/abei-api 四个容器：前端由 playwright 自己拉 vite（端口 5174，见
# playwright.config.ts），vite 把 /v1 代理到 18002，账本请求全程经 abei-api，少了它整轮必挂。
# 数据由 playwright 跑前调 firefly-iii 的 system:seed-e2e 现播，所以不用先手动准备账本。
# --wait 会等 abei-api 的 healthcheck（GET /health）转绿，不必额外轮询。
test-e2e: .env
	$(COMPOSE) up -d --build --wait db mail app abei-api
	cd $(WEB_DIR) && npx playwright install chromium && npx playwright test

build:
	cd $(WEB_DIR) && npm run build
	$(COMPOSE) run --rm agent-test sh -lc 'npm ci && npm run build'
	cd $(ABEI_DIR) && cargo build --release --workspace
	cd $(APP_DIR) && composer install --no-interaction --no-progress

build-image: .env
	$(COMPOSE) build app abei-api abei-agent abei-web
