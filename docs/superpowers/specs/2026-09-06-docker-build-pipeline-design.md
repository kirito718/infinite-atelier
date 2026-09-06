# Docker 打包与构建流水线设计

## 背景

Infinite Atelier 当前通过 Vite preview 同时提供前端静态资源和同源 `/api/codex-subscription` 接口。Codex 订阅生图由服务端启动 Codex CLI 的 App Server 完成，ChatGPT OAuth 状态由 `CODEX_HOME` 管理。现有仓库已经支持本地与远程 Node.js 启动，但缺少可复现的 Docker 镜像、持久化凭据卷和 GitHub Actions 发布流程。

本设计的目标是在不改变现有订阅生图链路的前提下，提供适合单用户远程服务器的容器化部署方式，并把构建结果发布到 GitHub Container Registry。

## 目标与非目标

### 目标

- 构建一个包含主前端、内嵌 MONOFORM 和 Codex CLI 的多阶段镜像。
- 保持 Vite preview 与 Codex 同源 API 的现有运行方式，不再引入额外 Bridge 服务。
- 使用命名卷持久化 `CODEX_HOME`，使容器重建不导致 OAuth 状态丢失。
- 提供 `compose.yaml` 作为本地和远程单机部署入口。
- 提供 GitHub Actions，在 PR 上验证，在 `main` 和版本标签上发布多架构 GHCR 镜像。
- 支持 `linux/amd64` 和 `linux/arm64`。
- 明确单用户、安全边界、首次登录和升级流程。

### 非目标

- 不在本次改造中实现多用户权限隔离、租户级 OAuth 或服务端用户数据库。
- 不在 CI 中执行真实 ChatGPT OAuth、真实生图或保存任何订阅凭据。
- 不把个人 GitHub、Codex 或 API Token 写入镜像、工作流文件或仓库变量。
- 不把应用拆成 Nginx 静态容器和独立 Bridge 容器。

## 方案与架构

采用单容器 Node 运行时方案：

```text
GitHub Actions
  ├─ PR: tests + typecheck + build + docker build
  └─ main/tag: buildx linux/amd64,linux/arm64 -> GHCR

Docker build
  ├─ build stage: Node 22 + web lockfile + monoform lockfile
  │   ├─ npm ci --legacy-peer-deps --include=optional
  │   ├─ npm ci --prefix monoform-studio
  │   ├─ npm run build:monoform
  │   └─ npm run build
  └─ runtime stage: Node 22 slim
      ├─ Vite preview + same-origin Codex API
      ├─ pinned @openai/codex CLI
      └─ /data/codex <- codex-data volume (CODEX_HOME)

Browser -> :3000 -> Vite preview middleware -> Codex App Server -> ChatGPT subscription
```

运行时继续使用 `vite preview`，因为 `web/vite.config.ts` 的 `configurePreviewServer` 会挂载 Codex API。这样浏览器只访问同源 `/api/codex-subscription`，容器内部的 Codex CLI 不需要向浏览器暴露端口，也不需要重新引入 loopback Bridge。

## 文件职责

- `Dockerfile`：多阶段依赖安装、MONOFORM 构建、主应用构建、运行时镜像和固定 Codex CLI 版本。
- `.dockerignore`：排除本地依赖、构建产物、凭据、工作树和测试缓存，避免泄露或扩大构建上下文。
- `docker/entrypoint.sh`：初始化 `CODEX_HOME` 目录、设置安全默认值并以非调试模式启动应用。
- `compose.yaml`：声明应用服务、`codex-data` 命名卷、默认回环端口和可覆盖的镜像/端口配置。
- `.github/workflows/docker.yml`：PR 校验、GHCR 登录、Buildx 多架构构建、镜像标签和缓存。
- `README.md`：Docker 构建、首次启动、Codex 登录、卷备份、升级和反向代理说明。

现有 `web/docker-entrypoint.sh` 是为官方 Nginx 镜像生成运行时 `config.js` 的脚本，本方案不将它复用为 Node 容器入口，避免把 Nginx 的文件路径假设带入新的运行时。若未来继续保留 Nginx 部署，应让它与 Node 容器入口保持职责分离。

## 构建与运行时细节

### 构建阶段

- 使用 Node 22 slim 作为构建基线，满足当前 Vite、Monoform 和 Codex CLI 的 Node 兼容范围。
- 主应用依赖按 `web/package-lock.json` 安装，并使用项目现有的 `--legacy-peer-deps --include=optional` 兼容参数。
- MONOFORM 依赖按 `web/monoform-studio/package-lock.json` 安装，随后执行 `npm run build:monoform` 将产物同步到 `web/public/monoform`。
- 执行 `npm run build` 生成主应用 `web/dist`。
- Codex CLI 版本通过 `ARG CODEX_CLI_VERSION` 固定，默认值与当前已验证的 CLI 版本一致；升级必须通过提交显式修改。

### 运行时

- 运行时使用 Node 22 slim，不携带源码和 MONOFORM 的开发依赖。
- 保留 Vite preview 及其运行时所需依赖，因为当前 Codex API 作为 Vite preview 插件提供。
- `CODEX_HOME` 默认设置为 `/data/codex`，并由 Compose 的 `codex-data` 命名卷持久化。
- 默认监听 `0.0.0.0:3000`，Compose 将宿主机端口默认绑定到 `127.0.0.1:3000`。
- 入口脚本使用 `exec` 运行应用，确保容器能够正确转发 SIGTERM 并优雅退出。
- 健康检查只请求本地应用状态接口或主页，不要求 Codex 已登录；登录状态是业务状态，不是进程存活状态。

## 数据流与安全边界

1. 用户访问容器提供的页面。
2. 浏览器向同源 `/api/codex-subscription/v1/status`、`/login`、`/images` 发请求。
3. Vite preview 中间件将请求交给 Codex 订阅 API。
4. API 在服务端启动或复用 `codex app-server --listen stdio://`，并通过 JSON-RPC 完成登录、图片生成和文件下载。
5. Codex CLI 从 `/data/codex` 读取 OAuth 状态，把临时生成文件写入受控目录；容器 API 只返回不透明的任务和文件标识。

必须遵守以下边界：

- 不把 `CODEX_HOME` 复制进镜像层、构建缓存或 GitHub Actions artifact。
- 不把 Codex OAuth token、生成文件绝对路径或 Bridge secret 写入浏览器存储和公开日志。
- Docker 默认只绑定回环地址；需要远程访问时，放在 VPN、访问控制或 HTTPS 反向代理后面。
- 当前实例按单用户设计；如果需要多人使用，应先增加认证和租户隔离，而不是直接扩大端口暴露范围。

## Compose 部署流程

Compose 应提供以下可复现流程：

```text
docker compose build
docker compose up -d
打开 http://127.0.0.1:3000
配置 -> Codex 订阅 -> 连接 ChatGPT
docker compose logs -f atelier
docker compose down                 # 保留 codex-data
docker compose down -v              # 明确删除卷，仅用于重置登录状态
```

默认 Compose 文件不包含真实凭据。用户可以通过 `.env` 覆盖镜像标签、端口、Codex CLI 版本或分析配置，但不得将 `.env` 提交到仓库。

## GitHub Actions 流程

- `pull_request`：安装并缓存 Buildx 依赖，运行 `npm run test:codex`、`npm run test:unit`、`npm run typecheck`、`npm run build`，再执行不推送的 Docker 构建。
- `push` 到 `main`：运行同一验证链路后，登录 GHCR，构建并推送 `linux/amd64` 与 `linux/arm64` 镜像，更新 `main` 和短 SHA 标签。
- 版本标签（`v*`）：额外生成语义版本标签和稳定版本标签。
- 使用 `docker/metadata-action`、`docker/setup-buildx-action`、`docker/login-action` 和 `docker/build-push-action`，启用 GitHub Actions 缓存。
- 工作流权限只需要 `contents: read` 和 `packages: write`；不需要个人访问令牌。
- CI 不运行真实 OAuth；容器首次启动后的登录由部署者在浏览器完成。

## 错误处理与可观测性

- 构建阶段失败应直接退出并保留 npm/Vite/Docker 的原始错误，不使用静默降级。
- 入口脚本发现 `codex` 不可执行时应给出明确诊断并退出，避免页面显示“服务正常”但生图必然失败。
- Codex 登录未完成、网络不可达或账户失效属于业务状态，由现有 API 返回 `disconnected`、`connecting` 或 `unavailable`；不应让健康检查因此失败。
- 应用日志可以包含任务状态和经过脱敏的错误，但不得包含 OAuth token、`CODEX_HOME` 文件内容或完整服务器路径。

## 验证策略

### 本地

- `docker build --progress=plain .` 成功完成多阶段构建。
- `docker compose up -d` 后容器保持运行，健康检查通过，主页和同源 Codex status 接口返回成功。
- `docker compose down` 后重新 `up`，`codex-data` 卷仍存在。
- 在真实登录环境中手动完成一次 Codex 登录和一张图片生成；该步骤不纳入 CI。

### CI

- 运行现有 Codex 桥接/API 测试、单元测试、类型检查和生产构建。
- 校验 Dockerfile 能在目标架构构建，不要求在 CI 里启动真实 Codex 登录。
- 检查工作流不会上传 `CODEX_HOME`、`.env`、`node_modules` 或构建缓存中的敏感内容。

## 迁移与回滚

- 现有 Node.js 部署可以继续使用；Docker 是新增部署入口，不改变现有脚本。
- 从现有部署迁移时，只需把原 `CODEX_HOME` 内容复制到 `codex-data` 对应卷，并确保容器用户可读写。
- 回滚时使用旧 GHCR 标签或旧 Compose `IMAGE_TAG`，无需删除卷；OAuth 状态和用户本地画布数据保持不变。
