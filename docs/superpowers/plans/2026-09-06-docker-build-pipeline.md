# Docker 打包与构建流水线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** 为 Infinite Atelier 增加包含 Codex CLI 的多架构 Docker 镜像、Compose 部署入口和 GHCR 构建发布流水线，同时保留现有同源 Codex 订阅生图链路。

**Architecture:** 使用 Node 22 slim 多阶段 Docker 构建：构建阶段分别安装主应用和 MONOFORM 的锁定依赖并生成静态产物，运行阶段保留 Vite preview 与 Codex App Server 所需的 Node 依赖。Compose 将 /data/codex 映射到命名卷，GitHub Actions 在 PR 上验证并在 main/版本标签上发布 linux/amd64 与 linux/arm64 镜像。

**Tech Stack:** Docker Buildx, Docker Compose, Node.js 22, Vite preview, @openai/codex, GitHub Actions, GHCR。

**Spec:** docs/superpowers/specs/2026-09-06-docker-build-pipeline-design.md

## Global Constraints

- CODEX_HOME 默认值为 /data/codex，只能通过 Docker volume 持久化，不得复制到镜像层、artifact 或日志。
- Codex CLI 默认版本固定为当前已验证的 0.153.4，升级必须通过显式 CODEX_CLI_VERSION 变更。
- Docker 运行时必须继续使用 Vite preview 的同源 /api/codex-subscription，不得重新引入浏览器直连 Bridge。
- Compose 默认端口绑定为 127.0.0.1:3000:3000，不得默认公开绑定到所有网卡。
- 主应用依赖安装必须使用 npm ci --legacy-peer-deps --include=optional；MONOFORM 使用其自身 lockfile。
- CI 不执行真实 OAuth 或真实图片生成，只验证构建和自动化测试。
- 不引入多用户权限或租户隔离；文档必须明确当前实例按单用户设计。

---

### Task 1: Add the deterministic multi-stage Docker image

**Files:**
- Create: Dockerfile
- Create: .dockerignore
- Create: docker/entrypoint.sh

**Interfaces:**
- Consumes: web/package-lock.json, web/monoform-studio/package-lock.json, web/vite.config.ts, existing npm run build:monoform and npm run build scripts.
- Produces: an image exposing TCP port 3000, running npm start, with codex available on PATH and CODEX_HOME=/data/codex.

- [ ] **Step 1: Add the Docker build contract test commands before implementation**

Run these commands from the repository root to establish the required tools and expected failure for the not-yet-created files:

~~~
docker version
docker compose version
test -f Dockerfile
~~~

Expected: Docker commands report their installed versions; the final test fails because Dockerfile has not been created yet.

- [ ] **Step 2: Write the multi-stage Dockerfile and build-context exclusions**

Create a Node 22 slim build stage that:

~~~
COPY web/package*.json ./
RUN npm ci --legacy-peer-deps --include=optional
COPY web/monoform-studio/package*.json ./monoform-studio/
RUN npm ci --prefix monoform-studio --include=optional
COPY web ./
RUN npm run build:monoform && npm run build
~~~

Create a runtime stage that copies the built dist, vite.config.ts, server, local-bridge, package manifests, and the build-stage node_modules; install @openai/codex at the pinned CODEX_CLI_VERSION globally; create /data/codex owned by the node user; set CODEX_HOME, expose 3000, add a Node-based HTTP health check, and run the entrypoint as node.

.dockerignore must exclude .git, .worktrees, all node_modules, all dist directories, .env* except .env.example, data, logs, test output, and local Codex/browser artifacts without excluding source, lockfiles, public assets, or the committed MONOFORM model files.

- [ ] **Step 3: Add the non-secret runtime entrypoint**

Create docker/entrypoint.sh with POSIX shell syntax that:

~~~
#!/bin/sh
set -eu
: "${CODEX_HOME:=/data/codex}"
export CODEX_HOME
mkdir -p "$CODEX_HOME"
command -v codex >/dev/null 2>&1 || {
  echo "Codex CLI is not installed in the image" >&2
  exit 1
}
exec "$@"
~~~

The script must set the Dockerfile default when CODEX_HOME is unset, must not print token contents, recursively list CODEX_HOME, or overwrite the existing Nginx-specific web/docker-entrypoint.sh.

- [ ] **Step 4: Run syntax and Docker build verification**

Run:

~~~
sh -n docker/entrypoint.sh
docker build --progress=plain --tag infinite-atelier:local .
docker image inspect infinite-atelier:local --format '{{json .Config.ExposedPorts}}'
~~~

Expected: shell syntax passes, the image builds successfully for the host architecture, and image metadata includes 3000/tcp. If Docker is unavailable, report that exact environment limitation rather than claiming the image passed.

- [ ] **Step 5: Commit the image scaffolding**

~~~
git add Dockerfile .dockerignore docker/entrypoint.sh
git commit -m "feat: add Codex-enabled Docker image"
~~~

### Task 2: Add Compose deployment with persistent Codex state

**Files:**
- Create: compose.yaml

**Interfaces:**
- Consumes: Dockerfile image contract from Task 1.
- Produces: service atelier, named volume codex-data, default loopback binding, and overridable IMAGE_TAG, ATELIER_IMAGE, ATELIER_BIND_ADDRESS, ATELIER_PORT, and CODEX_CLI_VERSION variables.

- [ ] **Step 1: Add the Compose configuration validation command**

Run before writing the file:

~~~
docker compose -f compose.yaml config
~~~

Expected: fail because compose.yaml does not exist yet.

- [ ] **Step 2: Write the Compose service**

Define a service named atelier with a build context at the repository root, a CODEX_CLI_VERSION build argument defaulting to 0.153.4, an image defaulting to ghcr.io/kirito718/infinite-atelier with IMAGE_TAG latest, a port mapping defaulting to 127.0.0.1:3000:3000, CODEX_HOME set to /data/codex, the codex-data volume mounted at /data/codex, and restart unless-stopped. Keep the default binding loopback-only and do not put OAuth tokens or API keys in the file.

- [ ] **Step 3: Verify Compose expansion and persistent volume behavior**

Run:

~~~
docker compose config
docker compose build
docker compose up -d
docker compose ps
docker compose exec atelier node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
docker compose down
docker volume ls --format '{{.Name}}' | rg 'codex-data'
~~~

Expected: normalized Compose output shows 127.0.0.1 binding and codex-data; the service starts and the in-container homepage request succeeds; stopping the service does not delete the named volume.

- [ ] **Step 4: Commit the Compose deployment entrypoint**

~~~
git add compose.yaml
git commit -m "feat: add persistent Codex Compose deployment"
~~~

### Task 3: Add GitHub Actions verification and GHCR publishing

**Files:**
- Create: .github/workflows/docker.yml

**Interfaces:**
- Consumes: repository lockfiles and Dockerfile from Tasks 1–2.
- Produces: a PR verification job and a main/tag publishing job for the repository's ghcr.io image.

- [ ] **Step 1: Add workflow validation checks before implementation**

Run:

~~~
test -f .github/workflows/docker.yml
~~~

Expected: fail because the workflow does not exist yet.

- [ ] **Step 2: Write the workflow with separate verification and publish behavior**

The workflow must:

1. Trigger on pull_request, pushes to main, and tags matching v*.
2. Set permissions.contents to read and permissions.packages to write.
3. Use Node 22 and cache both web/package-lock.json and web/monoform-studio/package-lock.json.
4. Run, in order, npm ci --legacy-peer-deps --include=optional in web, npm ci --prefix web/monoform-studio --include=optional, npm run test:codex --prefix web, npm run test:unit --prefix web, npm run typecheck --prefix web, npm run build:monoform --prefix web, and npm run build --prefix web.
5. Set up QEMU and Buildx, use metadata-action for latest, short SHA, and semver tag labels, and use GitHub Actions cache.
6. Build linux/amd64 for PRs and linux/amd64 plus linux/arm64 for main/version tags.
7. Log in to GHCR and set push true only when the event is not pull_request.
8. Never upload CODEX_HOME, .env, node_modules, or application runtime data as artifacts.

- [ ] **Step 3: Validate workflow syntax and repository references**

Run:

~~~
git diff --check
git grep -n "CODEX_HOME\|packages: write\|linux/amd64\|linux/arm64" .github/workflows/docker.yml
~~~

Expected: no whitespace errors; the workflow visibly contains the credential boundary, GHCR permission, and both target architectures. If actionlint is installed, also run actionlint .github/workflows/docker.yml.

- [ ] **Step 4: Commit the workflow**

~~~
git add .github/workflows/docker.yml
git commit -m "ci: build and publish multi-arch Docker images"
~~~

### Task 4: Document Docker operations and Codex persistence

**Files:**
- Modify: README.md after the existing Codex subscription local/remote section.

**Interfaces:**
- Consumes: Dockerfile, compose.yaml, and GHCR image naming from Tasks 1–3.
- Produces: copy-pasteable local/remote instructions and explicit credential/security boundaries.

- [ ] **Step 1: Add documentation checks before editing**

Run:

~~~
rg -n "Docker|docker compose|CODEX_HOME|GHCR" README.md
~~~

Expected: existing README has no complete Docker deployment section, so the new instructions have a clear insertion point after the current remote Node deployment notes.

- [ ] **Step 2: Document build, start, login, upgrade, backup, and reset operations**

Add commands covering:

~~~
docker compose build
docker compose up -d
docker compose logs -f atelier
docker compose down
docker compose down -v
~~~

Explain that the first Codex login is completed from the browser through the application UI, that codex-data preserves OAuth state across image upgrades, that down -v intentionally resets the login state, and that ATELIER_BIND_ADDRESS should remain loopback-only unless a protected HTTPS reverse proxy/VPN is configured.

Document GHCR pull usage with IMAGE_TAG, multi-architecture support, single-user scope, and the fact that CI does not perform real OAuth or image generation.

- [ ] **Step 3: Run documentation and diff verification**

Run:

~~~
rg -n "docker compose build|codex-data|连接 ChatGPT|HTTPS|单用户|ghcr.io/kirito718/infinite-atelier" README.md
git diff --check
~~~

Expected: all operational and security terms are present and there are no whitespace errors.

- [ ] **Step 4: Commit the deployment documentation**

~~~
git add README.md
git commit -m "docs: document Docker Codex deployment"
~~~

### Task 5: Run the complete release verification

**Files:**
- Test: Dockerfile, compose.yaml, .github/workflows/docker.yml, README.md, and the existing application test suite.

**Interfaces:**
- Consumes: all implementation tasks above.
- Produces: fresh evidence that the local image, Compose runtime, application tests, and repository state are ready to publish.

- [ ] **Step 1: Run the existing application verification suite**

From web run:

~~~
npm run test:codex
npm run test:unit
npm run typecheck
npm run build:monoform
npm run build
~~~

Expected: all tests pass, TypeScript exits 0, and both builds exit 0.

- [ ] **Step 2: Run Docker and Compose smoke tests**

From the repository root run:

~~~
docker build --progress=plain --tag infinite-atelier:verification .
docker compose config
docker compose up -d
docker compose ps
docker compose exec atelier node -e "fetch('http://127.0.0.1:3000/api/codex-subscription/v1/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
docker compose down
~~~

Expected: image build, Compose normalization, container startup, and same-origin status endpoint all succeed without displaying credential contents.

- [ ] **Step 3: Inspect the final diff and ignored-file boundary**

Run:

~~~
git status --short
git diff --check
git diff --stat HEAD~4..HEAD
git check-ignore -v web/node_modules web/dist .env codex-data 2>/dev/null || true
~~~

Expected: only the intended Docker, workflow, documentation, and plan/spec files are tracked; dependencies, builds, .env, and runtime data remain ignored.

- [ ] **Step 4: Report deployment artifacts and evidence**

Report the exact image name, Compose service name, volume name, default bind address, CLI version, test/build results, and any environment limitation (for example unavailable Docker daemon). Do not claim a real Codex login or generation was tested unless it was performed manually outside CI.
