# Codex Subscription Image Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Codex subscription image generation into Infinite Atelier's same-origin backend API so remote deployments no longer depend on a separate loopback bridge.

**Architecture:** Reuse the tested Codex App Server JSON-RPC client as an internal service, expose its task and OAuth operations through a Vite dev/preview middleware mounted at `/api/codex-subscription`, and update the frontend client to use that same-origin API. The service keeps all credentials and filesystem work server-side while preserving polling, cancellation, and artifact download semantics.

**Tech Stack:** Node.js ESM, Vite middleware, Codex App Server stdio JSON-RPC, React/TypeScript, Vitest, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-06-codex-subscription-image-provider-design.md`

## Global Constraints

- Codex OAuth credentials stay server-side in `CODEX_HOME`; do not add an API-key fallback.
- The browser calls only `/api/codex-subscription/v1/*`; do not expose `43127`, `codex-local`, or bridge secrets.
- Every generation task owns its temporary directory and rejects path/symlink escapes.
- Codex subscription remains image-only; video routing is unchanged.
- Apply TDD for each behavior: write a failing test, run it red, implement the minimum, then run it green.

---

### Task 1: Extract a reusable same-origin Codex subscription API handler

**Files:**
- Create: `web/server/codex-subscription-api.mjs`
- Create: `web/server/codex-subscription-api.test.mjs`
- Modify: `web/local-bridge/server.mjs` only if shared task logic must be extracted without changing behavior.
- Test: `web/server/codex-subscription-api.test.mjs`

**Interfaces:**
- Consumes: `createCodexAppServerClient()` from `web/local-bridge/app-server-client.mjs` and the existing task lifecycle behavior.
- Produces: `createCodexSubscriptionApi({ codex, cleanupMs, tempRoot })` returning `{ handle(request, response), close() }`, with the API paths from the spec.

- [ ] **Step 1: Write the failing tests** for direct `/v1/status`, `/v1/images`, and `/api/codex-subscription/v1/images` paths, plus login/logout and task file download without any secret header.
- [ ] **Step 2: Run the API test file** with `node --test server/codex-subscription-api.test.mjs`; confirm the new handler is missing and the test fails for the expected reason.
- [ ] **Step 3: Implement the handler** by moving the existing task lifecycle into a reusable same-origin API module, normalizing both mounted and full paths, and preserving redaction, cancellation, cleanup, and contained-output checks.
- [ ] **Step 4: Run the API test file again** and confirm all new API tests pass, including late Codex notifications and cancellation cleanup.
- [ ] **Step 5: Run the existing App Server and bridge utility tests** to prove the extraction did not regress JSON-RPC parsing or filesystem validation.

### Task 2: Mount the API inside Vite dev and preview without a separate Bridge process

**Files:**
- Modify: `web/vite.config.ts`
- Modify: `web/scripts/start-atelier.mjs`
- Modify: `web/package.json`
- Create: `web/vite.config.test.ts` only if plugin behavior cannot be covered through the API handler tests.
- Test: `web/server/codex-subscription-api.test.mjs` and the existing build/typecheck commands.

**Interfaces:**
- Consumes: `createCodexSubscriptionApi` from Task 1.
- Produces: a Vite plugin that mounts `/api/codex-subscription` in both `configureServer` and `configurePreviewServer`, owns one service instance per Vite process, and closes it with the server.

- [ ] **Step 1: Add a failing integration test** that starts the configured preview server path with the API plugin and asserts `/api/codex-subscription/v1/status` is handled without a bridge token.
- [ ] **Step 2: Run the integration test** and confirm the current Vite configuration returns the static 404 or does not mount the route.
- [ ] **Step 3: Implement the Vite plugin** with one in-process service, no proxy rewrite, and lifecycle cleanup; change `dev:atelier` so it launches only Vite while retaining loopback-first local binding.
- [ ] **Step 4: Change `npm start`/preview documentation** so remote deployment uses the same API-enabled Vite process and no `INFINITE_ATELIER_BRIDGE_*` variables.
- [ ] **Step 5: Run the integration test, build, and typecheck** and confirm the API is present in both dev and preview configuration.

### Task 3: Point the frontend Codex client and channel metadata at the new API

**Files:**
- Modify: `web/src/services/codex-image.ts`
- Modify: `web/src/stores/use-config-store.ts`
- Modify: `web/src/services/codex-image.test.ts` if needed for request-path assertions.
- Modify: `web/src/components/layout/channel-editor-drawer.tsx` only for user-facing diagnostics if the new API error wording requires it.
- Test: `web/src/services/codex-image.test.ts` and existing router/store tests.

**Interfaces:**
- Consumes: `/api/codex-subscription/v1/*` from Task 1.
- Produces: unchanged `beginCodexLogin`, `getCodexStatus`, task polling, cancellation, and file-download functions for the canvas caller.

- [ ] **Step 1: Write failing request tests** asserting status/login/image/download use `/api/codex-subscription/v1` and that errors say “Codex subscription request” rather than “bridge”.
- [ ] **Step 2: Run the focused unit tests** and confirm they fail because the client still uses `/codex-local/v1`.
- [ ] **Step 3: Update the base path and channel metadata**; keep the `codex-subscription::gpt-image-2` model identifier as an image capability but remove the obsolete `/codex-local` base URL.
- [ ] **Step 4: Run focused unit tests**, then the router/store tests, and confirm both Codex and normal provider routing remain correct.

### Task 4: Remove the standalone Bridge startup and document remote deployment

**Files:**
- Retain: `web/local-bridge/server.mjs` only as an unreferenced compatibility/test wrapper; it is not started by any package script and is not exposed by Vite.
- Modify: `web/scripts/start-atelier.mjs`
- Modify: `web/README.md` or the repository README containing the current local bridge instructions.
- Modify: `web/local-bridge` tests or move them to `web/server` if they only exercise the removed server wrapper.

**Interfaces:**
- Consumes: the in-process Vite API plugin and App Server client from Tasks 1–2.
- Produces: one-command local/preview startup and remote deployment instructions with Codex CLI, `CODEX_HOME`, OAuth, and `0.0.0.0` binding details.

- [ ] **Step 1: Write a failing startup test or script assertion** that `dev:atelier` no longer spawns `local-bridge/server.mjs` or sets `INFINITE_ATELIER_BRIDGE_TOKEN`.
- [ ] **Step 2: Run the assertion** and confirm the current launcher still starts the standalone bridge.
- [ ] **Step 3: Simplify the launcher** to start only the API-enabled Vite process and remove obsolete bridge environment variables and proxy configuration; keep the legacy wrapper solely for regression tests until a separate cleanup change removes it.
- [ ] **Step 4: Update deployment documentation** with local and remote commands, server-side OAuth behavior, and the requirement that `codex` is installed on the remote host.
- [ ] **Step 5: Run the full verification suite**: bridge/App Server tests that remain, unit tests, typecheck, build, and a fresh local HTTP smoke test for status/login route protection.

### Task 5: Regression review and handoff

**Files:**
- Modify: only files identified by failing verification.
- Test: all project test and build commands.

- [ ] **Step 1: Inspect the diff** for any leftover `codex-local`, `43127`, bridge-token, or browser-visible credential path.
- [ ] **Step 2: Run the complete test suite and build** from a clean running process.
- [ ] **Step 3: Run a live status smoke test** against the local app and confirm the Codex account status response is server-generated.
- [ ] **Step 4: Verify the remote startup command** binds the frontend/API to the configured host and no second bridge process is required.
- [ ] **Step 5: Report evidence and remaining operational prerequisites** without claiming image generation success unless a real subscription generation is explicitly run.
