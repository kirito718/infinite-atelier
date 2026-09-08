# Codex device-code login repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make browser-initiated ChatGPT login work against a remote Docker deployment without a localhost callback.

**Architecture:** Use the official managed device-code RPC already present in pinned Codex 0.153.4. Keep credentials in each account's server-side Codex home; the browser only displays short-lived verification information and polls account state.

**Tech Stack:** Node >=22.12, Codex app-server stdio JSON-RPC, React/TypeScript, Ant Design, Vitest/node:test.

**Spec:** `docs/superpowers/specs/2026-09-09-codex-device-login-design.md`

## Global constraints

- Keep CODEX_CLI_VERSION=0.153.4 and all account/CSRF/storage isolation.
- No real OAuth requests, token copying, browser-storage persistence of verification codes, callback port exposure, or paid generation during verification.
- Work on `fix/codex-device-login` in the existing checkout; do not modify other worktrees.
- Backend and frontend worker file sets are disjoint. Do not stage or commit each other's unfinished changes.

## Task 1: Device-code RPC lifecycle and protected HTTP API (main worker)

**Files:** `web/local-bridge/app-server-client.mjs`, `web/local-bridge/server.mjs`, related node tests in `web/local-bridge/` and `web/server/`.

**Interface:** POST `/v1/login` returns `{type:"chatgptDeviceCode",loginId,verificationUrl,userCode}`; POST `/v1/login/cancel` receives `{loginId}` and returns 204. The public prefix remains `/api/codex-subscription`. GET `/v1/status` retains `{status}` and reports `connecting` for pending authorization.

- [x] Add failing RPC/HTTP regressions for the device response, pending status, invalid/loopback responses, cancellation/logout, stale completions and account isolation.
- [x] Implement the minimal managed-login lifecycle, allowlisted verification URL and selected public response fields.
- [x] Run node tests and review diagnostics for credential leakage.

## Task 2: Browser login experience (frontend worker)

**Files:** `web/src/services/codex-image.ts` and tests; `web/src/components/layout/channel-editor-drawer.tsx`; a focused login panel/controller and tests if needed; the `config.codex` entries in both locale files.

**Interface:** Export `CodexLogin` with the Task 1 shape, `beginCodexLogin(options?)`, `cancelCodexLogin(loginId, options?)`; retain all generation APIs and `getCodexStatus()`.

- [x] Add failing tests for official verification URL/code display, errors, cancellation and late results after account/UI changes.
- [x] Remove automatic OAuth popup navigation; show explicit official-page link, selectable/copyable code and opt-in help.
- [x] Poll without erasing a pending code, clear it on terminal outcomes, and allow recovery/retry when reopening a pending attempt.
- [x] Run frontend tests and typecheck.

## Task 3: Integration, documentation and verification (main worker)

**Files:** README.md and this plan; no unrelated deployment changes.

- [x] Update Docker/remote login instructions and document device-code opt-in; remove misleading localhost browser-login expectations.
- [x] Review the patches, run the entire suite, typecheck, production build and diff checks.
- [x] Verify the UI with a fake login transport, without authenticating a real ChatGPT account.
- [x] Record exact results and leave deployment/publication separate from this requested code change.

Verification record: `docs/superpowers/verification/2026-09-09-codex-device-login.md`. Publication and real account authorization remain outside this change.
