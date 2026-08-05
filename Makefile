SHELL := /bin/sh
COMPOSE := docker compose
WEB_DIR := granary-web
APP_DIR := firefly-iii
CLI_DIR := firefly-cli

# Firefly 对外端口。改这里要同步改 .env 的 FIREFLY_PORT 和 granary-web/vite.config.ts 的 proxy。
FIREFLY_PORT := $(or $(FIREFLY_PORT),18001)

# 本机 artisan serve 用 root .env 的同套 PostgreSQL（db 容器映射在 127.0.0.1:15432）。
DEV_DB_ENV := DB_CONNECTION=pgsql DB_HOST=127.0.0.1 DB_PORT=$(or $(POSTGRES_PORT),15432) \
	DB_DATABASE=$(or $(POSTGRES_DB),firefly) DB_USERNAME=$(or $(POSTGRES_USER),firefly) \
	DB_PASSWORD=$(or $(POSTGRES_PASSWORD),firefly-local-only)

.DEFAULT_GOAL := help

.PHONY: help dev dev-web up down logs test test-web test-backend test-cli build build-image

help:
	@echo "dev         本地开发：起 db/mail 容器 + 本机 artisan serve ($(FIREFLY_PORT)) + vite (5173)"
	@echo "dev-web     只开发前端：Firefly 用容器跑，本地只起 vite (5173)"
	@echo "up          起 4 个容器：db mail app granary-web"
	@echo "down        停本地容器"
	@echo "logs        跟随 app 与 granary-web 日志"
	@echo "test        全部测试：web vitest + Firefly PHPUnit + CLI"
	@echo "build       出产物：granary-web 静态 + firefly-cli 打包 + composer 装依赖"
	@echo "build-image 构建 app 与 granary-web 镜像"

.env:
	cp .env.example .env

up: .env
	$(COMPOSE) up -d --build --wait db mail app granary-web

down:
	$(COMPOSE) down --remove-orphans

logs:
	$(COMPOSE) logs -f app granary-web

dev: .env
	@command -v php >/dev/null || { echo "需要本机 PHP：make dev 用 artisan serve 跑 Firefly" >&2; exit 2; }
	$(COMPOSE) up -d --wait db mail
	@echo "停掉 app 容器，把 $(FIREFLY_PORT) 端口让给本机 artisan serve（make up 可恢复）"
	@$(COMPOSE) stop app >/dev/null 2>&1 || true
	@cd $(APP_DIR) && $(DEV_DB_ENV) php artisan migrate --force
	@set -eu; \
		( cd $(APP_DIR) && exec env $(DEV_DB_ENV) php artisan serve --host=127.0.0.1 --port=$(FIREFLY_PORT) ) & \
		php_pid=$$!; \
		trap 'kill $$php_pid 2>/dev/null || true' INT TERM EXIT; \
		cd $(WEB_DIR) && npm run dev

dev-web: .env
	$(COMPOSE) up -d --wait db mail app
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

build:
	cd $(WEB_DIR) && npm run build
	$(COMPOSE) run --rm cli-test sh -lc 'npm ci && npm run build'
	cd $(APP_DIR) && composer install --no-interaction --no-progress

build-image: .env
	$(COMPOSE) build app granary-web
