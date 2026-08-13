SHELL := /bin/sh
COMPOSE := docker compose
WEB_DIR := abei-web
APP_DIR := firefly-iii
AGENT_DIR := abei-agent
ABEI_DIR := abei

# Firefly 对外端口。改这里要同步改 .env 的 FIREFLY_PORT 和 abei-web/vite.config.ts 的 proxy。
FIREFLY_PORT := $(or $(FIREFLY_PORT),18001)
# 下面端口要和 .env、compose.yml、abei-web/vite.config.ts 对齐。
ABEI_API_PORT := $(or $(ABEI_API_PORT),18002)
ABEI_AGENT_PORT := $(or $(ABEI_AGENT_PORT),18003)
ABEI_SERVER_PORT := $(or $(ABEI_SERVER_PORT),18005)
WEB_PORT := $(or $(WEB_PORT),5173)

# 本机 artisan serve 用 root .env 的同套 PostgreSQL（db 容器映射在 127.0.0.1:15432）。
DEV_DB_ENV := DB_CONNECTION=pgsql DB_HOST=127.0.0.1 DB_PORT=$(or $(POSTGRES_PORT),15432) \
	DB_DATABASE=$(or $(POSTGRES_DB),firefly) DB_USERNAME=$(or $(POSTGRES_USER),firefly) \
	DB_PASSWORD=$(or $(POSTGRES_PASSWORD),firefly-local-only)
ABEI_SERVER_DB_ENV := POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=$(or $(POSTGRES_PORT),15432) \
	POSTGRES_DB=$(or $(POSTGRES_DB),firefly) POSTGRES_USER=$(or $(POSTGRES_USER),firefly) \
	POSTGRES_PASSWORD=$(or $(POSTGRES_PASSWORD),firefly-local-only)

.DEFAULT_GOAL := help

.PHONY: help free-ports install-cli man dev dev-web up down logs test test-web test-backend test-agent test-rust test-e2e build build-image

help:
	@echo "dev         本地开发：清端口、重装 abei 命令行，再起 db/mail + 本机 Firefly/abei-server/api/agent + vite (5173)"
	@echo "dev-web     只开发前端：先清掉占着开发端口的旧进程，Firefly、abei-api 与 agent 用容器跑，本机起 vite (5173)"
	@echo "up          起 7 个容器：db mail app abei-server abei-api abei-agent abei-web"
	@echo "down        停本地容器"
	@echo "logs        跟随 app、abei-server、abei-api、abei-agent 与 abei-web 日志"
	@echo "man         生成 abei 的 man 页到 abei/target/man/abei.1"
	@echo "test        全部测试：web vitest + Firefly PHPUnit + agent vitest + abei 三道闸"
	@echo "test-e2e    浏览器主路径：起 db/mail/app/abei-api + playwright（自己拉 vite，数据现播）"
	@echo "build       出产物：abei-web 静态 + abei-agent 打包 + abei release 二进制 + composer 装依赖"
	@echo "build-image 构建 app、abei-api、abei-agent 与 abei-web 镜像"
	@echo ""
	@echo "宿主端口：18001 Firefly / 18002 abei-api / 18003 abei-agent / 18004 abei-web / 18005 abei-server"

.env:
	cp .env.example .env

up: .env
	$(COMPOSE) up -d --build --wait db mail app abei-server abei-api abei-agent abei-web

down:
	$(COMPOSE) down --remove-orphans

logs:
	$(COMPOSE) logs -f app abei-server abei-api abei-agent abei-web

free-ports:
	@command -v lsof >/dev/null || { echo "需要 lsof 才能清理开发端口" >&2; exit 2; }
	@set -u; \
		for port in $(FIREFLY_PORT) $(ABEI_API_PORT) $(ABEI_AGENT_PORT) $(WEB_PORT) $(ABEI_SERVER_PORT); do \
			pids=$$(lsof -ti tcp:$$port -sTCP:LISTEN 2>/dev/null || true); \
			[ -z "$$pids" ] && continue; \
			for pid in $$pids; do \
				comm=$$(ps -p $$pid -o comm= 2>/dev/null || true); \
				case "$$comm" in \
				*OrbStack*|*[Dd]ocker*|*vpnkit*|*podman*) \
					echo "端口 $$port 的监听者是容器运行时（$${comm}），杀它会连累整个容器环境。先停掉占这个端口的容器（docker ps 找它，或 make down）再来" >&2; \
					exit 1;; \
				esac; \
				echo "端口 $$port 被 $$pid 占着，先停掉"; kill "$$pid" 2>/dev/null || true; \
			done; \
			n=0; \
			while [ $$n -lt 30 ] && lsof -ti tcp:$$port -sTCP:LISTEN >/dev/null 2>&1; do sleep 0.1; n=$$((n + 1)); done; \
			pids=$$(lsof -ti tcp:$$port -sTCP:LISTEN 2>/dev/null || true); \
			for pid in $$pids; do echo "端口 $$port 被 $$pid 占着，还赖着，强杀"; kill -9 "$$pid" 2>/dev/null || true; done; \
		done; \
		failed=0; \
		for port in $(FIREFLY_PORT) $(ABEI_API_PORT) $(ABEI_AGENT_PORT) $(WEB_PORT) $(ABEI_SERVER_PORT); do \
			pids=$$(lsof -ti tcp:$$port -sTCP:LISTEN 2>/dev/null || true); \
			for pid in $$pids; do echo "端口 $$port 仍被 $$pid 占着，停止启动" >&2; failed=1; done; \
		done; \
		exit $$failed

# 把 abei 命令行装进 ~/.cargo/bin，终端里的 abei 才跟得上源码——不装的话它停在
# 上一次 cargo install 的版本，新命令看不见。--target-dir 指到工作区 target 复用
# 编译缓存，没改动时几秒就完。
install-cli:
	cd $(ABEI_DIR) && cargo install --path crates/abei-cli --locked --target-dir target

man:
	mkdir -p $(ABEI_DIR)/target/man
	cd $(ABEI_DIR) && cargo run -q -p abei-cli --example man > target/man/abei.1
	@echo "已生成 $(ABEI_DIR)/target/man/abei.1"

# `make dev` 的本机 abei-api 与容器版抢 18002，所以停掉容器版。dev-web 的后端虽然
# 就用容器版，也得先停再 up——容器映射的端口由容器运行时（OrbStack/Docker）监听，
# free-ports 杀不得（会连累整个容器环境），先停容器它才放手。
dev: .env
	@command -v php >/dev/null || { echo "需要本机 PHP：make dev 用 artisan serve 跑 Firefly" >&2; exit 2; }
	@command -v cargo >/dev/null || { echo "需要本机 Rust：make dev 用 cargo run 跑 abei-api" >&2; exit 2; }
	$(COMPOSE) up -d --wait db mail
	@echo "停掉 app/abei-server/abei-api/abei-agent/abei-web 容器，把端口让给本机开发进程（make up 可恢复）"
	@$(COMPOSE) stop app abei-server abei-api abei-agent abei-web >/dev/null 2>&1 || true
	@$(MAKE) free-ports
	@$(MAKE) install-cli
	@cd $(APP_DIR) && $(DEV_DB_ENV) php artisan migrate --force
	@set -eu; \
		( cd $(APP_DIR) && exec env $(DEV_DB_ENV) php artisan serve --host=127.0.0.1 --port=$(FIREFLY_PORT) ) & \
		php_pid=$$!; \
		( set -a; . ./.env; set +a; cd $(ABEI_DIR) && exec env $(ABEI_SERVER_DB_ENV) ABEI_SERVER_ADDR=127.0.0.1:$(ABEI_SERVER_PORT) ABEI_MAIL_STORAGE=$(CURDIR)/$(APP_DIR)/storage/app GOOGLE_OAUTH_REDIRECT_URL=http://127.0.0.1:5173/oauth/google/callback cargo run -q -p abei-server ) & \
		server_pid=$$!; \
		( cd $(ABEI_DIR) && exec env FIREFLY_URL=http://127.0.0.1:$(FIREFLY_PORT) ABEI_WEB_URL=http://127.0.0.1:5173 ABEI_SERVER_URL=http://127.0.0.1:$(ABEI_SERVER_PORT) cargo run -q -p abei-api ) & \
		api_pid=$$!; \
		( set -a; . ./.env; set +a; cd $(AGENT_DIR) && exec env $(DEV_DB_ENV) FIREFLY_URL=http://127.0.0.1:$(FIREFLY_PORT) npm run dev -- agent serve ) & \
		agent_pid=$$!; \
		( cd $(WEB_DIR) && exec npm run dev ) & \
		web_pid=$$!; \
		pids="$$php_pid $$server_pid $$api_pid $$agent_pid $$web_pid"; \
		trap 'trap - INT TERM EXIT; kill $$pids 2>/dev/null || true; wait $$pids 2>/dev/null || true' INT TERM EXIT; \
		while true; do \
			for process in "firefly:$$php_pid" "abei-server:$$server_pid" "abei-api:$$api_pid" "abei-agent:$$agent_pid" "vite:$$web_pid"; do \
				name=$${process%%:*}; pid=$${process#*:}; \
				if ! kill -0 "$$pid" 2>/dev/null; then \
					if wait "$$pid"; then status=1; else status=$$?; fi; \
					echo "$$name 已退出，停止本轮开发环境" >&2; \
					exit "$$status"; \
				fi; \
			done; \
			sleep 1; \
		done

dev-web: .env
	@$(COMPOSE) stop app abei-server abei-api abei-agent >/dev/null 2>&1 || true
	@$(MAKE) free-ports
	ABEI_WEB_URL=http://127.0.0.1:5173 GOOGLE_OAUTH_REDIRECT_URL=http://127.0.0.1:5173/oauth/google/callback $(COMPOSE) up -d --build --wait db mail app abei-server abei-api abei-agent
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
	$(COMPOSE) up -d --build --wait db mail app abei-server abei-api
	cd $(WEB_DIR) && npx playwright install chromium && npx playwright test

build:
	cd $(WEB_DIR) && npm run build
	$(COMPOSE) run --rm agent-test sh -lc 'npm ci && npm run build'
	cd $(ABEI_DIR) && cargo build --release --workspace
	cd $(APP_DIR) && composer install --no-interaction --no-progress

build-image: .env
	$(COMPOSE) build app abei-server abei-api abei-agent abei-web
