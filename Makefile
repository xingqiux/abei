SHELL := /bin/sh
COMPOSE := docker compose
E2E_PROJECT ?= firefly-ai-accounting-e2e
E2E_COMPOSE := docker compose --env-file .env.example -p $(E2E_PROJECT) --profile e2e
EMPTY_START_PROJECT ?= firefly-ai-accounting-empty-start
EMPTY_START_COMPOSE := docker compose --env-file .env.example -p $(EMPTY_START_PROJECT)
EMPTY_START_FIREFLY_PORT ?= 18021
EMPTY_START_GRANARY_PORT ?= 18022
EMPTY_START_GRANARY_SERVER_PORT ?= 18023
EMPTY_START_POSTGRES_PORT ?= 15442
EMPTY_START_GRANARY_POSTGRES_PORT ?= 15443
EMPTY_START_SMTP_PORT ?= 13035
EMPTY_START_IMAP_PORT ?= 13153
GRANARY_TEST_PROJECT ?= firefly-ai-accounting-granary-test
GRANARY_TEST_COMPOSE := docker compose --env-file .env.example -p $(GRANARY_TEST_PROJECT) --profile granary-test
GRANARY_TEST_SMTP_PORT ?= 13026
GRANARY_TEST_IMAP_PORT ?= 13144

.DEFAULT_GOAL := help

.PHONY: help bootstrap up up-server down clean reset ps logs logs-server build test test-server test-backend test-cli test-web test-e2e test-empty-start lint analyze-backend audit migrate migrate-server shell config release

help:
	@echo "bootstrap      Create .env when missing and build local images"
	@echo "up             Start PostgreSQL, local mail, Firefly and Granary"
	@echo "up-server      Start the new Granary PostgreSQL and Rust server"
	@echo "down           Stop the local stack"
	@echo "clean          Delete all local, test, empty-start and E2E containers and data"
	@echo "reset          Delete local containers and development data, then restart"
	@echo "ps             Show service status"
	@echo "logs           Follow application and Granary logs"
	@echo "logs-server    Follow the new Granary server and database logs"
	@echo "build          Build source images"
	@echo "test           Run backend, CLI and Granary automated checks"
	@echo "test-server    Run Rust unit and PostgreSQL integration tests"
	@echo "test-backend   Run PHPUnit against the isolated PostgreSQL test database"
	@echo "test-cli       Run CLI tests in Node 22"
	@echo "test-web       Run Granary tests in Node 22"
	@echo "test-e2e       Run the isolated Granary browser journey from empty volumes"
	@echo "test-empty-start  Verify the default development stack from empty volumes"
	@echo "lint           Run backend, CLI and Granary linters"
	@echo "analyze-backend  Run full-tree Mago analysis against the upstream baseline"
	@echo "audit          Audit Firefly Composer/npm, CLI and Granary dependencies"
	@echo "migrate        Run backend migrations"
	@echo "migrate-server Run granary-server database migrations"
	@echo "shell          Open a shell in the backend container"
	@echo "config         Render and validate the Compose configuration"
	@echo "release        Run all checks, builds, empty-start and isolated E2E gates"

.env:
	cp .env.example .env

bootstrap: .env build

up: .env
	$(COMPOSE) --profile granary up -d --build --wait db mail app granary-db granary-migrate granary-server granary-web

up-server: .env
	$(COMPOSE) --profile granary up -d --build --wait granary-db granary-migrate granary-server

down:
	$(COMPOSE) down --remove-orphans

clean:
	@status=0; \
		$(COMPOSE) --profile test --profile e2e --profile granary --profile granary-test down -v --remove-orphans || status=$$?; \
		$(GRANARY_TEST_COMPOSE) down -v --remove-orphans || status=$$?; \
		$(E2E_COMPOSE) down -v --remove-orphans || status=$$?; \
		$(EMPTY_START_COMPOSE) down -v --remove-orphans || status=$$?; \
		exit $$status

reset: .env
	$(COMPOSE) down -v --remove-orphans
	$(COMPOSE) --profile granary up -d --build db mail app granary-db granary-migrate granary-server granary-web

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f app granary-web

logs-server:
	$(COMPOSE) --profile granary logs -f granary-server granary-db

build: .env
	$(COMPOSE) --profile granary build granary-server
	$(COMPOSE) build app granary-web backend-test
	$(COMPOSE) run --rm cli-test sh -lc 'npm ci && npm run build'

test: test-server test-backend test-cli test-web

test-server:
	@set -eu; \
		cleanup() { \
			status=$$?; \
			trap - EXIT INT TERM; \
			$(GRANARY_TEST_COMPOSE) down --remove-orphans >/dev/null 2>&1 || true; \
			exit "$$status"; \
		}; \
		trap cleanup EXIT INT TERM; \
		GRANARY_TEST_POSTGRES_PORT='$(or $(GRANARY_TEST_POSTGRES_PORT),15434)' \
		MAIL_SMTP_PORT='$(GRANARY_TEST_SMTP_PORT)' MAIL_IMAP_PORT='$(GRANARY_TEST_IMAP_PORT)' \
			$(GRANARY_TEST_COMPOSE) up -d --wait granary-test-db mail; \
		DATABASE_URL='postgres://$(or $(GRANARY_TEST_POSTGRES_USER),granary_test):$(or $(GRANARY_TEST_POSTGRES_PASSWORD),granary-test-only)@127.0.0.1:$(or $(GRANARY_TEST_POSTGRES_PORT),15434)/$(or $(GRANARY_TEST_POSTGRES_DB),granary_test)' \
		GRANARY_TEST_SMTP_PORT='$(GRANARY_TEST_SMTP_PORT)' \
		GRANARY_TEST_IMAP_PORT='$(GRANARY_TEST_IMAP_PORT)' \
			cargo test --locked --manifest-path granary-server/Cargo.toml

test-backend:
	$(COMPOSE) build backend-test
	@set -eu; \
		cleanup() { \
			status=$$?; cleanup_status=0; \
			trap - EXIT INT TERM; \
			$(COMPOSE) --profile test rm -sf test-db >/dev/null 2>&1 || cleanup_status=$$?; \
			if [ "$$status" -ne 0 ]; then exit "$$status"; fi; \
			exit "$$cleanup_status"; \
		}; \
		trap cleanup EXIT INT TERM; \
		$(COMPOSE) run --rm backend-test

test-cli:
	$(COMPOSE) run --rm cli-test

test-web:
	$(COMPOSE) run --rm web-test

test-e2e:
	@set -eu; \
		cleanup() { \
			status=$$?; cleanup_status=0; \
			trap - EXIT INT TERM; \
			$(E2E_COMPOSE) down -v --remove-orphans || cleanup_status=$$?; \
			if [ "$$status" -ne 0 ]; then exit "$$status"; fi; \
			exit "$$cleanup_status"; \
		}; \
		trap cleanup EXIT INT TERM; \
		$(E2E_COMPOSE) down -v --remove-orphans; \
		$(E2E_COMPOSE) up --build --quiet-build --attach e2e --abort-on-container-exit --exit-code-from e2e e2e

test-empty-start:
	@set -eu; \
		export COMPOSE_PROJECT_NAME='$(EMPTY_START_PROJECT)'; \
		export APP_URL='http://localhost:$(EMPTY_START_FIREFLY_PORT)'; \
		export FIREFLY_PORT='$(EMPTY_START_FIREFLY_PORT)'; \
		export GRANARY_WEB_PORT='$(EMPTY_START_GRANARY_PORT)'; \
		export GRANARY_SERVER_PORT='$(EMPTY_START_GRANARY_SERVER_PORT)'; \
		export POSTGRES_PORT='$(EMPTY_START_POSTGRES_PORT)'; \
		export GRANARY_POSTGRES_PORT='$(EMPTY_START_GRANARY_POSTGRES_PORT)'; \
		export MAIL_SMTP_PORT='$(EMPTY_START_SMTP_PORT)'; \
		export MAIL_IMAP_PORT='$(EMPTY_START_IMAP_PORT)'; \
		cleanup() { \
			status=$$?; cleanup_status=0; \
			trap - EXIT INT TERM; \
			$(EMPTY_START_COMPOSE) down -v --remove-orphans || cleanup_status=$$?; \
			if [ "$$status" -ne 0 ]; then exit "$$status"; fi; \
			exit "$$cleanup_status"; \
		}; \
		trap cleanup EXIT INT TERM; \
		$(EMPTY_START_COMPOSE) --profile granary down -v --remove-orphans; \
		$(EMPTY_START_COMPOSE) --profile granary up -d --build --wait --wait-timeout 300 db mail app granary-db granary-migrate granary-server granary-web; \
		$(EMPTY_START_COMPOSE) exec -T db sh -lc 'pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"' >/dev/null; \
		$(EMPTY_START_COMPOSE) exec -T granary-db sh -lc 'pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"' >/dev/null; \
		$(EMPTY_START_COMPOSE) exec -T app curl -fsS 'http://127.0.0.1/health' >/dev/null; \
		$(EMPTY_START_COMPOSE) exec -T granary-server curl -fsS 'http://127.0.0.1:8080/health/ready' >/dev/null; \
		$(EMPTY_START_COMPOSE) exec -T granary-web wget -q -O /dev/null 'http://127.0.0.1/index.html'; \
		$(EMPTY_START_COMPOSE) exec -T app php -r 'foreach ([3025, 3143] as $$port) { $$socket = @fsockopen("mail", $$port, $$errno, $$error, 5); if (false === $$socket) { exit(1); } fclose($$socket); }'

lint:
	cargo fmt --all --manifest-path granary-server/Cargo.toml -- --check
	cargo clippy --locked --all-targets --manifest-path granary-server/Cargo.toml -- -D warnings
	$(COMPOSE) build backend-test
	$(COMPOSE) run --rm --no-deps backend-test vendor/bin/mago lint --minimum-fail-level=warning
	$(COMPOSE) run --rm cli-test sh -lc 'npm ci && npm run lint && npm run format:check'
	$(COMPOSE) run --rm web-test sh -lc 'npm ci && npm run lint'

analyze-backend:
	$(COMPOSE) build backend-test
	$(COMPOSE) run --rm --no-deps backend-test vendor/bin/mago analyze

audit:
	$(COMPOSE) run --rm --no-deps firefly-composer-audit
	$(COMPOSE) run --rm --no-deps firefly-node-audit
	$(COMPOSE) run --rm cli-test sh -lc 'npm ci && npm audit --registry=https://registry.npmjs.org'
	$(COMPOSE) run --rm web-test sh -lc 'npm ci && npm audit --registry=https://registry.npmjs.org'

migrate:
	$(COMPOSE) exec app php artisan migrate

migrate-server:
	$(COMPOSE) --profile granary run --rm granary-migrate

shell:
	$(COMPOSE) exec app sh

config: .env
	$(COMPOSE) --profile test --profile e2e --profile granary --profile granary-test config --quiet

release:
	+$(MAKE) -j1 config
	+$(MAKE) -j1 test-e2e
	+$(MAKE) -j1 test
	+$(MAKE) -j1 lint
	+$(MAKE) -j1 audit
	+$(MAKE) -j1 build
	+$(MAKE) -j1 test-empty-start
