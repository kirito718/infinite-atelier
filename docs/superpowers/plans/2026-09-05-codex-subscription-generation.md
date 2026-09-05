# Codex Subscription Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a locally running Infinite Atelier use the signed-in user's Codex subscription for image generation and editing, without exposing ChatGPT credentials to the browser or changing video-provider behaviour.

**Architecture:** A loopback-only Node bridge owns one Codex App Server stdio connection and temporary media files. Vite injects a random bridge capability header while proxying same-origin `/codex-local/*` calls, so the React app neither stores nor transmits Codex credentials. Image nodes dispatch through the bridge only when their model is `codex-subscription::gpt-image-2`; video nodes continue using the existing API provider path.

**Tech Stack:** React 19, TypeScript, Zustand, Vite, Node.js 24 built-in `node:test`, Codex App Server JSON-RPC.

---

## File structure

| File | Responsibility |
| --- | --- |
| `web/local-bridge/bridge-utils.mjs` | Request validation, task state transitions, redacted errors, temporary-directory cleanup. |
| `web/local-bridge/app-server-client.mjs` | JSONL client for App Server initialization, account state, login, logout, image turns, and cancellation. |
| `web/local-bridge/server.mjs` | Loopback HTTP API, in-memory tasks, file handoff, and ownership checks. |
| `web/local-bridge/*.test.mjs` | Bridge unit tests run by Node without a real ChatGPT login. |
| `web/scripts/start-atelier.mjs` | Creates a random bridge secret, starts the bridge and Vite dev/preview process, and stops both together. |
| `web/vite.config.ts` | Same-origin proxy that attaches the per-launch bridge secret. |
| `web/src/services/codex-image.ts` | Browser client for Codex status/login/task polling/download/cancellation. |
| `web/src/stores/use-config-store.ts` | Codex channel type, persisted migration, image-only readiness, and selection helpers. |
| `web/src/components/layout/channel-editor-drawer.tsx` | Read-only Codex subscription channel card and account controls. |
| `web/src/pages/canvas/project.tsx` | Image-node dispatch to Codex and asset import; leaves video path untouched. |
| `web/src/i18n/locales/{zh-CN,en-US}.ts` | All visible Codex connection, limit, and video-provider messages. |

### Task 1: Add a testable local bridge foundation

**Files:**
- Create: `web/local-bridge/bridge-utils.mjs`
- Create: `web/local-bridge/bridge-utils.test.mjs`
- Modify: `web/package.json`

- [ ] **Step 1: Write failing bridge utility tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { redactBridgeError, requireBridgeRequest, terminalTask } from "./bridge-utils.mjs";

test("rejects requests without the launch capability", () => {
    assert.throws(() => requireBridgeRequest({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }, "secret"), /Unauthorized local bridge request/);
});

test("redacts OAuth-like tokens from bridge errors", () => {
    assert.equal(redactBridgeError("request failed Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature"), "request failed Bearer [redacted]");
});

test("marks success and failure as terminal", () => {
    assert.equal(terminalTask("succeeded"), true);
    assert.equal(terminalTask("failed"), true);
    assert.equal(terminalTask("generating"), false);
});
```

- [ ] **Step 2: Run tests and verify the expected missing-module failure**

Run: `node --test local-bridge/bridge-utils.test.mjs`

Expected: FAIL because `bridge-utils.mjs` does not exist.

- [ ] **Step 3: Implement the minimal bridge utilities**

```js
import { isIP } from "node:net";

export function terminalTask(status) {
    return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function redactBridgeError(value) {
    return String(value).replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]").replace(/(sk-|eyJ)[A-Za-z0-9._-]+/g, "[redacted]");
}

export function requireBridgeRequest(req, secret) {
    const address = req.socket.remoteAddress || "";
    const loopback = address === "::1" || address === "::ffff:127.0.0.1" || address === "127.0.0.1" || (isIP(address) === 4 && address.startsWith("127."));
    if (!loopback || req.headers["x-atelier-bridge-token"] !== secret) throw new Error("Unauthorized local bridge request");
}
```

- [ ] **Step 4: Add the test command and verify it passes**

Add this script to `web/package.json`:

```json
"test:bridge": "node --test local-bridge/*.test.mjs"
```

Run: `npm run test:bridge`

Expected: PASS with 3 passing tests.

- [ ] **Step 5: Commit the bridge foundation**

```bash
git add web/package.json web/local-bridge/bridge-utils.mjs web/local-bridge/bridge-utils.test.mjs
git commit -m "feat: add local Codex bridge foundation"
```

### Task 2: Implement the Codex App Server client and task API

**Files:**
- Create: `web/local-bridge/app-server-client.mjs`
- Create: `web/local-bridge/server.mjs`
- Create: `web/local-bridge/server.test.mjs`

- [ ] **Step 1: Write failing task lifecycle tests using a fake Codex client**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createBridgeServer } from "./server.mjs";

test("creates a Codex image task and exposes its generated file once", async () => {
    const bridge = createBridgeServer({
        secret: "test-secret",
        codex: { account: async () => ({ status: "connected" }), generateImage: async () => ({ files: [{ path: "/tmp/output.png", mimeType: "image/png" }] }) },
    });
    const task = await bridge.createImageTask({ prompt: "red cube", references: [] });
    assert.equal(task.status, "succeeded");
    assert.equal(task.files[0].mimeType, "image/png");
});

test("keeps a video request out of the Codex bridge", async () => {
    const bridge = createBridgeServer({ secret: "test-secret", codex: {} });
    await assert.rejects(() => bridge.createImageTask({ prompt: "clip", operation: "video", references: [] }), /only generates images/);
});
```

- [ ] **Step 2: Run tests and verify the expected missing-module failure**

Run: `node --test local-bridge/server.test.mjs`

Expected: FAIL because `server.mjs` does not exist.

- [ ] **Step 3: Implement the App Server JSONL client**

Create `app-server-client.mjs` with a `CodexAppServerClient` class that:

```js
await client.initialize({ clientInfo: { name: "Infinite Atelier", version: "1.0.0" } });
const account = await client.request("account/read", {});
const login = await client.request("account/login/start", { type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "codex" });
const thread = await client.request("thread/start", {});
await client.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "$imagegen\nCreate the requested image and return the generated local artifact." }] });
```

Use a monotonically increasing JSON-RPC `id`, line-delimited JSON on child-process stdin/stdout, a pending-request map, and a notification handler. Generate the TypeScript schema from the installed CLI at implementation time and use its concrete turn-completion/local-artifact fields in the client; do not copy an undocumented event payload from a network trace. `generateImage` must append the user prompt and add each reference as the documented `localImage` input.

- [ ] **Step 4: Implement the loopback bridge HTTP API**

`server.mjs` must create the following endpoints and call `requireBridgeRequest` before reading the body:

| Method and path | Response |
| --- | --- |
| `GET /v1/status` | `{ status: "disconnected" | "connecting" | "connected" | "unavailable" }` |
| `POST /v1/login` | `{ authUrl }` from `account/login/start` |
| `POST /v1/logout` | `204` after App Server logout |
| `POST /v1/images` | `202 { taskId }`; accepts `{ prompt, references }` only |
| `GET /v1/images/:taskId` | Current task status and file metadata, never file paths outside the task directory |
| `GET /v1/images/:taskId/files/:fileId` | The generated image bytes for that task only |
| `DELETE /v1/images/:taskId` | Cancels the App Server turn and removes task files |

For `POST /v1/images`, validate nonempty prompt, require `operation` to be `generate` or `edit`, reject `video`, decode each `data:` image reference into a task-specific `mkdtemp` directory, and call `codex.generateImage`. On success move returned files into that task directory, permit only `image/*` mime types, and mark the task succeeded. On every terminal failure/cancellation, delete the task directory; schedule the same cleanup for succeeded tasks after a 10-minute expiry.

- [ ] **Step 5: Run the complete bridge test suite**

Run: `npm run test:bridge`

Expected: PASS; task lifecycle, video rejection, token validation, redaction, and cleanup tests all pass.

- [ ] **Step 6: Commit the bridge API**

```bash
git add web/local-bridge/app-server-client.mjs web/local-bridge/server.mjs web/local-bridge/server.test.mjs
git commit -m "feat: add Codex subscription image bridge"
```

### Task 3: Add a secure local launcher and Vite proxy

**Files:**
- Create: `web/scripts/start-atelier.mjs`
- Modify: `web/vite.config.ts`
- Modify: `web/package.json`
- Test: `web/local-bridge/bridge-utils.test.mjs`

- [ ] **Step 1: Write the failing launcher test for secret propagation**

Add this assertion to `bridge-utils.test.mjs`:

```js
import { createBridgeToken } from "./bridge-utils.mjs";

test("creates a different nonempty launch token each time", () => {
    assert.match(createBridgeToken(), /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(createBridgeToken(), createBridgeToken());
});
```

- [ ] **Step 2: Run the test and verify it fails because the token factory is missing**

Run: `npm run test:bridge`

Expected: FAIL with `createBridgeToken is not a function`.

- [ ] **Step 3: Implement the launcher and proxy**

Add this bridge utility:

```js
import { randomBytes } from "node:crypto";
export function createBridgeToken() { return randomBytes(32).toString("base64url"); }
```

`start-atelier.mjs` must generate one token, spawn `node local-bridge/server.mjs` with `ATELIER_BRIDGE_TOKEN`, then spawn either `vite --host 127.0.0.1 --port 3000` or `vite preview --host 127.0.0.1 --port 3000` with the same token. On either child exit or `SIGINT`, it must terminate both children and exit nonzero only when startup failed.

Extend `vite.config.ts` with one proxy for `/codex-local` in both `server.proxy` and `preview.proxy`:

```ts
"/codex-local": {
    target: "http://127.0.0.1:3456",
    changeOrigin: false,
    configure(proxy) {
        proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("x-atelier-bridge-token", process.env.ATELIER_BRIDGE_TOKEN || ""));
    },
}
```

Add `dev:atelier` and `start:atelier` scripts that invoke the launcher. The existing `dev` and `start` scripts remain unchanged for API-only use.

- [ ] **Step 4: Verify tests, proxy health, and loopback-only listeners**

Run: `npm run test:bridge && npm run dev:atelier`

Expected: bridge reports readiness and Vite serves `http://127.0.0.1:3000`; `lsof -nP -iTCP:3456 -sTCP:LISTEN` shows only `127.0.0.1:3456`.

- [ ] **Step 5: Commit the launcher and proxy**

```bash
git add web/scripts/start-atelier.mjs web/vite.config.ts web/package.json web/local-bridge/bridge-utils.mjs web/local-bridge/bridge-utils.test.mjs
git commit -m "feat: launch Codex bridge locally"
```

### Task 4: Add the Codex subscription channel to configuration

**Files:**
- Create: `web/src/services/codex-image.ts`
- Modify: `web/src/stores/use-config-store.ts`
- Modify: `web/src/components/layout/channel-editor-drawer.tsx`
- Modify: `web/src/i18n/locales/zh-CN.ts`
- Modify: `web/src/i18n/locales/en-US.ts`
- Modify: `web/package.json`

- [ ] **Step 1: Add Vitest and write failing config selector tests**

Install `vitest` as a development dependency and add this script to `web/package.json`:

```json
"test:unit": "vitest run"
```

Create `web/src/stores/use-config-store.test.ts` using Vitest, with these assertions:

```ts
expect(modelCapabilityOf(configWithCodex, "codex-subscription::gpt-image-2")).toBe("image");
expect(isCodexSubscriptionModel("codex-subscription::gpt-image-2")).toBe(true);
expect(selectableModelsByCapability(configWithCodex, "video")).not.toContain("codex-subscription::gpt-image-2");
expect(isAiConfigReady(configWithCodex, "codex-subscription::gpt-image-2")).toBe(true);
```

- [ ] **Step 2: Run the test and verify the Codex helpers do not yet exist**

Run: `npm run test:unit -- use-config-store.test.ts`

Expected: FAIL because `isCodexSubscriptionModel` is not exported.

- [ ] **Step 3: Add minimal configuration and browser bridge client**

Add a persisted channel with fixed id `codex-subscription`, an empty `apiKey`, base URL `/codex-local`, and exactly one image model `gpt-image-2`. Export:

```ts
export const CODEX_SUBSCRIPTION_CHANNEL_ID = "codex-subscription";
export function isCodexSubscriptionModel(value: string) { return decodeChannelModel(value)?.channelId === CODEX_SUBSCRIPTION_CHANNEL_ID; }
```

Export `isAiConfigReady` and change it so a Codex image model is ready when selected, independent of `apiKey`; all other models retain the existing requirement. `codex-image.ts` must expose `getCodexStatus`, `beginCodexLogin`, `logoutCodex`, `createCodexImageTask`, `waitForCodexImageTask`, and `downloadCodexImage`. Every request uses `/codex-local/v1/*`, throws the bridge's redacted error message, and accepts an `AbortSignal` for cancellation.

The channel editor renders a non-editable `Codex subscription` card with Connect, Disconnect, and status actions. It must not render Base URL, API Key, fetch-model, or custom-script controls for that channel.

- [ ] **Step 4: Run unit tests and typecheck**

Run: `npm run test:unit -- use-config-store.test.ts && npm run typecheck`

Expected: PASS and TypeScript exits 0.

- [ ] **Step 5: Commit configuration support**

```bash
git add web/src/services/codex-image.ts web/src/stores/use-config-store.ts web/src/stores/use-config-store.test.ts web/src/components/layout/channel-editor-drawer.tsx web/src/i18n/locales/zh-CN.ts web/src/i18n/locales/en-US.ts web/package.json
git commit -m "feat: add Codex subscription image channel"
```

### Task 5: Route image nodes through Codex and preserve video behaviour

**Files:**
- Create: `web/src/services/image-generation-router.ts`
- Create: `web/src/services/image-generation-router.test.ts`
- Modify: `web/src/pages/canvas/project.tsx`
- Modify: `web/src/services/codex-image.ts`
- Modify: `web/src/i18n/locales/zh-CN.ts`
- Modify: `web/src/i18n/locales/en-US.ts`

- [ ] **Step 1: Write failing image dispatch tests around a pure router**

```ts
import { describe, expect, it, vi } from "vitest";
import { routeImageGeneration } from "./image-generation-router";

it("uses Codex for a selected Codex image model", async () => {
    const codex = vi.fn().mockResolvedValue({ dataUrl: "data:image/png;base64,AA==" });
    const provider = vi.fn();
    await routeImageGeneration({ model: "codex-subscription::gpt-image-2", prompt: "studio product photo", references: [], codex, provider });
    expect(codex).toHaveBeenCalledWith(expect.objectContaining({ prompt: "studio product photo", operation: "generate" }));
    expect(provider).not.toHaveBeenCalled();
});

it("uses the existing provider for a normal image model", async () => {
    const codex = vi.fn();
    const provider = vi.fn().mockResolvedValue({ dataUrl: "data:image/png;base64,AA==" });
    await routeImageGeneration({ model: "default::gpt-image-2", prompt: "studio product photo", references: [], codex, provider });
    expect(provider).toHaveBeenCalled();
    expect(codex).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests and verify dispatch has not changed**

Run: `npm run test:unit -- image-generation-router.test.ts`

Expected: FAIL because the Codex task client is not called.

- [ ] **Step 3: Implement the smallest image-only branch**

Implement `routeImageGeneration` with a single decision on `isCodexSubscriptionModel(model)`. Its `codex` callback receives `{ prompt, operation: references.length ? "edit" : "generate", references, signal }`; its `provider` callback receives `{ prompt, references, signal }`. It returns a single `{ dataUrl: string }` result.

At the existing image `Promise.all` call near `handleGenerateNode`, call that router. The Codex callback must be:

```ts
const task = await createCodexImageTask({ prompt: effectivePrompt, operation: referenceImages.length ? "edit" : "generate", references: referenceImages });
const result = await waitForCodexImageTask(task.taskId, { signal: controller.signal });
const blob = await downloadCodexImage(result.taskId, result.files[0].id, { signal: controller.signal });
const uploaded = await uploadImage(blob);
```

Reuse the existing `CanvasNodeImage`, `uploadImage`, node-size, generation-history, cancellation, partial-failure, and retry paths. Do not alter `requestVideoGeneration`, `requestEdit`, or the text/audio branches. When the bridge reports unavailable/disconnected, mark only the pending image item with the translated error and retain its prompt.

- [ ] **Step 4: Run focused tests, complete typecheck, and production build**

Run: `npm run test:unit -- image-generation-router.test.ts && npm run test:bridge && npm run typecheck && npm run build:monoform && npm run build`

Expected: all commands exit 0; bundle-size warnings may remain, but no errors occur.

- [ ] **Step 5: Commit image-node integration**

```bash
git add web/src/pages/canvas/project.tsx web/src/services/codex-image.ts web/src/services/image-generation-router.ts web/src/services/image-generation-router.test.ts web/src/i18n/locales/zh-CN.ts web/src/i18n/locales/en-US.ts
git commit -m "feat: generate canvas images with Codex subscription"
```

### Task 6: Run authenticated local verification and document the feature

**Files:**
- Modify: `README.md`
- Modify: `web/package.json`

- [ ] **Step 1: Add a manual verification checklist to the README**

Document these exact checks: run `npm run dev:atelier`; connect the user's ChatGPT account in the Codex subscription card; generate one prompt-only image; edit it with one reference; confirm both appear in canvas and assets; confirm a video node requests the configured provider; disconnect; and confirm `localStorage`/IndexedDB contain no ChatGPT token.

- [ ] **Step 2: Run the full automated suite**

Run: `npm run test:bridge && npm run test:unit && npm run typecheck && npm run build:monoform && npm run build`

Expected: all test suites and builds pass.

- [ ] **Step 3: Run the authenticated smoke test**

Run: `npm run dev:atelier`

Use the local UI to complete ChatGPT login, then perform every README checklist item. Capture only task status and generated test assets; do not record OAuth URLs, tokens, or account details.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain Codex subscription image setup"
```

## Plan self-review

- Spec coverage: Tasks 1-3 implement the local-only bridge, capability secret, temporary files, and App Server login; Task 4 implements the image-only configuration channel; Task 5 preserves provider video and imports results into canvas/assets; Task 6 covers authenticated and negative verification.
- No silent fallback: Task 4 treats Codex readiness separately and Task 5 handles its errors on the selected image node. Video never selects the Codex channel.
- Credential boundary: the browser receives only status, auth URL, task IDs, and generated image bytes; token validation, App Server auth, and temporary files remain inside the loopback bridge.
