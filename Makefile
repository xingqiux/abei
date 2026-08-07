SHELL := /bin/sh
COMPOSE := docker compose
WEB_DIR := abaku-web
APP_DIR := firefly-iii
CLI_DIR := firefly-cli

# Firefly 对外端口。改这里要同步改 .env 的 FIREFLY_PORT 和 abaku-web/vite.config.ts 的 proxy。
FIREFLY_PORT := $(or $(FIREFLY_PORT),18001)
BILL_WORKER_INTERVAL := $(or $(BILL_WORKER_INTERVAL),300)

# 本机 artisan serve 用 root .env 的同套 PostgreSQL（db 容器映射在 127.0.0.1:15432）。
DEV_DB_ENV := DB_CONNECTION=pgsql DB_HOST=127.0.0.1 DB_PORT=$(or $(POSTGRES_PORT),15432) \
	DB_DATABASE=$(or $(POSTGRES_DB),firefly) DB_USERNAME=$(or $(POSTGRES_USER),firefly) \
	DB_PASSWORD=$(or $(POSTGRES_PASSWORD),firefly-local-only)

.DEFAULT_GOAL := help

.PHONY: help dev dev-web up down logs test test-web test-backend test-cli test-e2e build build-image

help:
	@echo "dev         本地开发：起 db/mail + 本机 Firefly/agent/worker + vite (5173)"
	@echo "dev-web     只开发前端：Firefly 用容器跑，本地只起 vite (5173)"
	@echo "up          起 6 个容器：db mail app bill-worker abaku-agent abaku-web"
	@echo "down        停本地容器"
	@echo "logs        跟随 app、bill-worker 与 abaku-web 日志"
	@echo "test        全部测试：web vitest + Firefly PHPUnit + CLI"
	@echo "test-e2e    浏览器主路径：起 db/mail/app + playwright（自己拉 vite，数据现播）"
	@echo "build       出产物：abaku-web 静态 + firefly-cli 打包 + composer 装依赖"
	@echo "build-image 构建 app、abaku-agent 与 abaku-web 镜像"

.env:
	cp .env.example .env

up: .env
	$(COMPOSE) up -d --build --wait db mail app bill-worker abaku-agent abaku-web

down:
	$(COMPOSE) down --remove-orphans

logs:
	$(COMPOSE) logs -f app bill-worker abaku-agent abaku-web

dev: .env
	@command -v php >/dev/null || { echo "需要本机 PHP：make dev 用 artisan serve 跑 Firefly" >&2; exit 2; }
	$(COMPOSE) up -d --wait db mail
	@echo "停掉 app/bill-worker/abaku-agent 容器，把端口让给本机开发进程（make up 可恢复）"
	@$(COMPOSE) stop app bill-worker abaku-agent >/dev/null 2>&1 || true
	@cd $(APP_DIR) && $(DEV_DB_ENV) php artisan migrate --force
	@set -eu; \
		( cd $(APP_DIR) && exec env $(DEV_DB_ENV) php artisan serve --host=127.0.0.1 --port=$(FIREFLY_PORT) ) & \
		php_pid=$$!; \
		( cd $(APP_DIR) && while true; do env $(DEV_DB_ENV) php artisan firefly-iii:sync-bill-mailbox --limit=100 || true; env $(DEV_DB_ENV) php artisan firefly-iii:process-bill-tasks --limit=100 || true; sleep $(BILL_WORKER_INTERVAL); done ) & \
		worker_pid=$$!; \
		( set -a; . ./.env; set +a; cd $(CLI_DIR) && exec env $(DEV_DB_ENV) FIREFLY_URL=http://127.0.0.1:$(FIREFLY_PORT) npm run dev -- agent serve ) & \
		agent_pid=$$!; \
		trap 'kill $$php_pid $$worker_pid $$agent_pid 2>/dev/null || true' INT TERM EXIT; \
		cd $(WEB_DIR) && npm run dev

dev-web: .env
	$(COMPOSE) up -d --wait db mail app bill-worker abaku-agent
	cd $(WEB_DIR) && npm run dev

test: test-web test-backend test-cli

test-web:
	cd $(WEB_DIR) && npm run test:run

# test-db 的数据在 tmpfs 里，随容器存活。跑前跑后都清掉，保证每次都是空库开始，
# 中途失败也不会把半截迁移状态留给下一次。
test-backend:
	$(COMPOSE) build backend-test
	@$(COMPOSE) rm -fsv test-db >/dev/null 2>&1 || true
	@trap '$(COMPOSE) rm -fsv test-db >/dev/null 2>&1 || true' EXIT INT TERM; \
		$(COMPOSE) run --rm backend-test

test-cli:
	$(COMPOSE) run --rm cli-test

# e2e 只要 db/mail/app 三个容器：前端由 playwright 自己拉 vite（端口 5174，见 playwright.config.ts），
# 数据由 playwright 跑前调 firefly-iii 的 system:seed-e2e 现播，所以不用先手动准备账本。
test-e2e: .env
	$(COMPOSE) up -d --build --wait db mail app
	cd $(WEB_DIR) && npx playwright install chromium && npx playwright test

build:
	cd $(WEB_DIR) && npm run build
	$(COMPOSE) run --rm cli-test sh -lc 'npm ci && npm run build'
	cd $(APP_DIR) && composer install --no-interaction --no-progress

build-image: .env
	$(COMPOSE) build app abaku-agent abaku-web
