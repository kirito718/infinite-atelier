# Accounts and Persistent Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace browser-only business storage with isolated, authenticated, restart-safe server storage and an explicit non-destructive migration.

**Architecture:** Same-origin Node middleware owns SQLite documents, hashed sessions and private media files. Frontend hydration occurs only after account resolution; revision-checked writes never silently overwrite another browser. Embedded MONOFORM uses the same API independently of the main Zustand stores.

**Tech Stack:** React 19, Zustand 5, Vite 7, Node.js, better-sqlite3, node:crypto, Vitest and node:test.

**Spec:** `docs/superpowers/specs/2026-09-08-accounts-persistence-design.md`

## Global Constraints

- Server is the authority; browser data is preserved only as legacy input and device preferences.
- Every data/file/task operation is scoped to the authenticated user; encrypted config, hashed passwords and hashed session tokens.
- API writes require `X-Atelier-Request: 1` and `X-Atelier-User` for authenticated operations. State writes use expectedRevision; no last-write-wins fallback.
- Default closed registration after the first account. Entire ATELIER_DATA_DIR must survive container replacement.
- Scope excludes collaboration, email recovery, external cloud services and changes to other worktrees.

## Task 1 — Storage and authenticated HTTP boundary (local critical path)

**Files:** create `web/server/account-database.mjs`, `web/server/account-api.mjs`, `web/server/account-http.mjs`, `web/server/account-files.mjs`, `web/server/account-proxy.mjs`, `web/server/account-api.test.mjs`; modify `web/vite.config.ts`, `web/package.json` / lockfile.

**Interfaces:** `createAccountApi({dataDir,allowRegistration,secureCookies,codexFactory,...})` returns `{handle(req,res),close()}`. Database `readState(userId,key)`, `writeState(userId,key,value,expectedRevision)`; absent revision is 0. HTTP paths and JSON are defined in the spec.

- [x] Write HTTP tests using an actual temporary directory, ephemeral port and explicit Cookie / Origin / X-Atelier-Request headers:
  ```js
  const created = await request('/api/account/register', {username:'alice',password:'correct horse battery'});
  assert.equal(created.status, 201);
  assert.equal((await request('/api/account/state', {cookie: bobCookie})).body.entries.length, 0);
  ```
- [x] Run `node --test server/account-api.test.mjs`; observe missing account API failure before implementation.
- [x] Implement SQLite schemas, salt/hash session and password handling, encryption key persistence, validation and atomic revision writes:
  ```sql
  UPDATE documents SET value = ?, revision = revision + 1 WHERE user_id = ? AND key = ? AND revision = ?;
  ```
- [x] Implement bounded uploads, authenticated range downloads, per-user Codex runtimes and guarded proxy; wire both Vite modes with the same API.
- [x] Add independent restart, wrong-password, cross-user file/task, CSRF, stale-account, encrypted-at-rest, CAS, migration and invalid-input assertions; run the real HTTP suite and baseline Codex tests.

## Task 2 — Account screens and lifecycle (parallel bounded UI work)

**Files:** modify `web/src/stores/use-user-store.ts`, `web/src/components/layout/user-status-actions.tsx`; create `web/src/components/account/account-gate.tsx`, `account-actions.tsx`, account tests. No edits to persistence services or main.tsx.

**Consumes:** parent-owned `services/account-client.ts`: `getAccountSession()`, `loginAccount({username,password})`, `registerAccount({username,password,displayName})`, `logoutAccount()`, `changeAccountPassword({currentPassword,newPassword})`, returning `{user}` (session also registrationAllowed). `services/account-session.ts`: `hydrateUserData(userId):Promise<void>`, `clearUserData():void`; `services/server-storage.ts`: `flushServerChanges():Promise<void>`.

**Produces:** `AccountGate({children})` gates all app content; `AccountActions` shows username, logout and password dialog; useUserStore retains `clearSession()` and exposes async refresh/sign-in/sign-up/sign-out actions.

- [x] Write lifecycle tests for anonymous gate, successful bootstrap, failed hydration, and logout failure without false success; observe failures with Vitest.
- [x] Implement accessible Chinese forms with validation, pending/error states, registration availability and password change.
- [x] Hydrate before setting authenticated, flush before logout, clear on identity switch. Broadcast only account-change notifications (not credentials) and react to expired/stale sessions.
- [x] Run focused tests and typecheck; report exact changed paths.

## Task 3 — MONOFORM persistence (parallel independent embedded app)

**Files:** only `web/monoform-studio/src` and associated standalone storage tests.

**Consumes:** `GET /api/account/session`; state GET/PUT contracts in spec. Raw JSON document keys `monoform-project[-embedKey]`, `monoform-custom-poses[-embedKey]`. Header captures actual bootstrap user id.

**Produces:** bootstrap-before-render, debounced revision-checked project/pose saving, visible pending/error/conflict states, retry and safe standalone login link.

- [x] Add adapter tests that catch lost writes, unauthorized writes, version conflicts and accidental localStorage fallback; run them red.
- [x] Replace business localStorage reads/writes with bootstrapped API state. Do not overwrite local legacy data or change unrelated 3D workflows.
- [x] Warn before closing unsaved changes, prevent stale-account writes and preserve explicit file export/import.
- [x] Run tests and standalone build; report exact paths; main worker rebuilds distributed assets last.

## Task 4 — Main app storage and migration (local after API contracts)

**Files:** create `web/src/services/account-client.ts`, `account-session.ts`, `server-storage.ts`, `server-files.ts`, `legacy-migration.ts`, `web/src/components/account/persistence-notices.tsx`; modify `lib/localforage-storage.ts`, business stores, image/file storage, backup/restore, api-proxy, main.tsx, codex-image request headers.

**Interfaces:** `serverStorage:StateStorage`, `hydrateUserData(userId)`, `clearUserData()`, `getActiveUserId()`, `flushServerChanges()`, `subscribeSyncStatus(listener)`, `getSyncSnapshot()`; migration `{migrationId,entries}` submitted only after blobs upload.

- [x] Write Vitest tests for serial CAS saves, pending edits during an in-flight request, retry without data loss, conflict without overwrite and account epoch isolation.
- [x] Implement in-memory snapshot + save queue; disable store auto-hydration; hydrate from server before enabling writes.
- [x] Switch media resolution/upload/deletion and backup enumeration to authenticated server APIs. Add explicit beforeunload / saving / failed-save UI.
- [x] Test then implement legacy discovery and migration: no write to old databases; reject nonempty remote accounts; upload referenced media then commit atomically and mark success afterwards.
- [x] Mount account gate and migration notices, run all unit tests and typecheck.

## Task 5 — Deployment, integration and verification

**Files:** `README.md`, `web/.env.example`, root `Dockerfile`, `compose.yaml`, `.dockerignore`, scripts/package settings if required.

- [x] Document registration configuration, HTTPS/Secure Cookie, persisted key/database/uploads/Codex, migration and consistent stopped-service backup/recovery.
- [ ] Build/run the Node image: Dockerfile and Compose are implemented, but this environment has no Docker executable. Validate on the deployment host before production use; no external deployment performed.
- [x] Run `npm run test:unit`, `npm run test:codex`, `npm run typecheck`, `npm run build:monoform`, `npm run build` and new storage tests.
- [x] Browser check fresh signup/login, create/reload canvas, migrate data, save MONOFORM, logout/login, second account isolation. Verify server restart against a disposable persisted directory.
- [x] Review diff and security boundaries; record exact results and any environment-specific checks not performed.

## Verification handoff

See `docs/superpowers/verification/2026-09-08-accounts-persistence.md` for the 242 passing tests, browser/restart checks, review fixes, and the Docker / live-OAuth limitations.
