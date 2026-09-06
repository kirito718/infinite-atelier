# Codex 订阅直连生图设计

## 目标

让 Infinite Atelier 使用 Codex 订阅直接调用 `$imagegen` 生成或编辑图片，同时支持远程服务器部署；浏览器不再依赖单独的 `codex-local` loopback Bridge。

## 架构

Vite 的应用后端 API 内置 Codex Subscription Image Provider。该 Provider 在服务进程内管理一个 Codex App Server 子进程，使用当前 Codex CLI 的 ChatGPT OAuth 状态和 App Server JSON-RPC 协议发起 `$imagegen` 任务。前端只访问同源 `/api/codex-subscription/v1/*`，不接触 OAuth 凭据、Codex CLI、临时目录或内部端口。

```text
Browser
  -> /api/codex-subscription/v1/*
  -> Infinite Atelier API (Vite dev/preview middleware)
  -> CodexSubscriptionImageService
  -> codex app-server (stdio)
  -> Codex subscription $imagegen
  -> task-owned image artifact
```

## API

- `GET /api/codex-subscription/v1/status` returns `disconnected | connecting | connected | unavailable`.
- `POST /api/codex-subscription/v1/login` returns an OAuth URL. The server owns the login lifecycle and never returns credentials.
- `POST /api/codex-subscription/v1/logout` logs the Codex account out through App Server.
- `POST /api/codex-subscription/v1/images` accepts `{ prompt, operation, references }` and returns `202 { taskId }`.
- `GET /api/codex-subscription/v1/images/:taskId` returns task state and same-origin artifact URLs.
- `DELETE /api/codex-subscription/v1/images/:taskId` cancels a running task and schedules cleanup.
- `GET /api/codex-subscription/v1/images/:taskId/files/:fileId` streams a generated image only when the task succeeded.

The API accepts both its mounted path and the path after middleware mount so it can be tested directly and mounted by Vite without a reverse-proxy rewrite.

## Security and filesystem boundary

- OAuth credentials remain in Codex CLI's server-side `CODEX_HOME`; no browser storage or API key fallback is introduced.
- Each image task gets a private temporary working directory. Reference images are copied into that directory before being sent to Codex.
- Image results are accepted only as image data or files contained by the task directory or the trusted Codex generated-images directory, with realpath checks to reject symlink escapes.
- Generated files are copied into task-owned files before they are exposed through an artifact URL.
- Error messages are redacted so absolute server paths and credentials do not reach the browser.

## Remote deployment

- The remote host must have the Codex CLI available on `PATH`, persistent writable `CODEX_HOME`, and a long-lived Node/Vite process.
- `npm start` must serve the built frontend and mount the same API middleware; no separately launched port `43127` or bridge token is required.
- The user completes OAuth through the URL returned by the remote server. Login completion is observed by the server-side App Server session.
- The first implementation is single-instance/single-user. Multi-user credential isolation is explicitly out of scope.

## Compatibility and non-goals

- Codex subscription is an image-only channel in the Atelier model selector. Video continues to use its configured video provider.
- The existing frontend routing behavior, task polling, cancellation, and reference-image editing semantics are preserved.
- The old standalone bridge is removed from the default startup path; the App Server client remains an internal implementation module and is not exposed as a public bridge.
