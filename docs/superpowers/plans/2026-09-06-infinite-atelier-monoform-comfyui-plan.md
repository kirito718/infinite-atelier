# Infinite Atelier + MONOFORM + ComfyUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working director flow that captures Pose/Depth from MONOFORM, submits a versioned ComfyUI workflow through an Atelier server gateway, and inserts the resulting image into the Infinite Atelier canvas.

**Architecture:** Keep MONOFORM responsible for deterministic control-pass rendering and keep ComfyUI behind a same-origin Atelier gateway. The gateway owns upstream configuration, multipart uploads, workflow patching, WebSocket progress, HTTP fallback, cancellation, and scoped output retrieval. The existing canvas IndexedDB storage remains the browser's final image store.

**Tech Stack:** React/TypeScript, React Three Fiber/Three.js, Vite middleware, Node.js `http`/`node:test`, Vitest, ComfyUI HTTP and WebSocket APIs, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-06-infinite-atelier-monoform-comfyui-design.md`

## Execution status — 2026-09-07

Continued in the existing `feat/monoform-comfyui-generation` worktree without subagents. The existing main checkout is unchanged; this branch has not been merged or pushed.

| Tasks | Status                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1–6   | Previously implemented; reverified and hardened where integration exposed defects                                                                            |
| 7     | Implemented and verified in a real browser, including live-rig capture, cancellation, retry routing, separate result placement and reload persistence        |
| 8     | Docker/Compose/CI files and operator documentation implemented; real container execution remains unverified because Docker is unavailable on this host       |
| 9     | 141 automated tests, typecheck, both builds, real-HTTP fixture integration and Chromium smoke passed; real GPU inference remains an external acceptance step |

Full evidence and known limits: [verification record](../verification/2026-09-07-monoform-comfyui-verification.md). The whole-project format check still reports 54 existing/original-style source files; changed TypeScript/server files pass. Test fixtures must not be presented as real generated photographs.

## Global Constraints

- Browser code must never receive or choose the ComfyUI upstream URL or credential.
- Existing MONOFORM image/video export messages must remain compatible.
- ComfyUI workflows must be API-format JSON exported from ComfyUI, not UI layout JSON.
- The first workflow is versioned as `portrait-pose-depth` and must fail explicitly when required nodes/models are missing.
- Canvas output must use the existing `uploadImage(blob)` IndexedDB path.
- Message handlers must validate protocol, version, iframe source, and same-origin origin.
- Task cancellation and late completion notifications must be idempotent; a late success cannot overwrite `cancelled`.
- The first release supports a single-user/in-memory TTL task store; the API boundary must allow a persistent store later.
- Every task ends with targeted tests and a focused git commit.

## File Map

| File                                                | Responsibility                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `web/src/types/director.ts`                         | Typed MONOFORM envelope, capture request/result, validation helpers |
| `web/src/types/comfyui.ts`                          | Browser-facing job/status/output/error types                        |
| `web/src/lib/director-message.ts`                   | Pure runtime validation and origin-safe message parsing             |
| `web/monoform-studio/src/control-passes.js`         | Pure rig-to-OpenPose projection helpers                             |
| `web/monoform-studio/src/rig.js`                    | Stable internal joint mapping export                                |
| `web/monoform-studio/src/Viewport.jsx`              | Beauty, Pose, and Depth render modes                                |
| `web/monoform-studio/src/App.jsx`                   | Control capture action and iframe messages                          |
| `web/src/components/canvas/director-panel.tsx`      | iframe bridge, progress UI, and generation callbacks                |
| `web/src/services/comfyui-director.ts`              | Same-origin browser job client                                      |
| `web/src/lib/canvas/director-node-metadata.ts`      | ComfyUI provenance metadata                                         |
| `web/src/pages/canvas/project.tsx`                  | Submit task and create the result canvas node                       |
| `web/src/types/canvas.ts`                           | Optional provenance metadata fields                                 |
| `web/src/lib/canvas/canvas-node-factory.ts`         | Metadata helper for generated director images                       |
| `web/server/comfyui-client.mjs`                     | ComfyUI HTTP/WebSocket adapter                                      |
| `web/server/comfyui-workflows.mjs`                  | Workflow loading, validation, and node patching                     |
| `web/server/comfyui-task-store.mjs`                 | Task state, idempotency, TTL cleanup                                |
| `web/server/comfyui-api.mjs`                        | Atelier-facing HTTP API                                             |
| `web/server/workflows/portrait-pose-depth-api.json` | API-format ComfyUI workflow                                         |
| `web/vite.config.ts`                                | Mount dev and preview ComfyUI middleware                            |
| `web/package.json`, `web/package-lock.json`         | Server dependencies if required by multipart/WebSocket handling     |

---

### Task 1: Add typed bridge and job contracts

**Files:**

- Create: `web/src/types/director.ts`
- Create: `web/src/types/comfyui.ts`
- Create: `web/src/lib/director-message.ts`
- Test: `web/src/lib/director-message.test.ts`

**Interfaces:**

- `parseDirectorMessage(value: unknown): DirectorMessage | null`
- `isDirectorCaptureResult(value: unknown): value is DirectorCaptureResult`
- `isAllowedDirectorEvent(event: MessageEvent, iframeWindow: Window | null, expectedOrigin: string): boolean`
- `DirectorCaptureRequest`, `DirectorCaptureResult`, `ComfyUiJobCreate`, `ComfyUiJobStatus`, and `ComfyUiJobError` are the shared browser contracts.

- [x] **Step 1: Write failing validation tests**

Add tests for:

```ts
expect(
  parseDirectorMessage({
    protocol: "atelier-monoform",
    version: 1,
    source: "monoform",
    type: "ready",
  }),
).toMatchObject({ type: "ready" });
expect(
  parseDirectorMessage({
    protocol: "wrong",
    version: 1,
    source: "monoform",
    type: "ready",
  }),
).toBeNull();
expect(
  parseDirectorMessage({
    protocol: "atelier-monoform",
    version: 2,
    source: "monoform",
    type: "ready",
  }),
).toBeNull();
expect(
  isAllowedDirectorEvent(
    {
      origin: "http://localhost:3000",
      source: iframeWindow,
      data: {},
    } as MessageEvent,
    iframeWindow,
    "http://localhost:3000",
  ),
).toBe(true);
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `cd web && npm run test:unit -- src/lib/director-message.test.ts`

Expected: FAIL because the contracts and validators do not exist.

- [x] **Step 3: Implement the minimal contracts and validators**

Use literal unions for `source`, protocol version, message types, pass kinds, and job states. Treat missing, unknown, or incorrectly typed fields as invalid. Do not inspect blobs or perform network calls in the pure validator.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `cd web && npm run test:unit -- src/lib/director-message.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/types/director.ts web/src/types/comfyui.ts web/src/lib/director-message.ts web/src/lib/director-message.test.ts
git commit -m "feat: define director and comfyui contracts"
```

### Task 2: Build pure Pose/Depth capture primitives

**Files:**

- Create: `web/monoform-studio/src/control-passes.js`
- Create: `web/monoform-studio/src/control-passes.test.js`
- Modify: `web/monoform-studio/src/rig.js`

**Interfaces:**

- `OPENPOSE_KEYPOINTS`: ordered stable keypoint definitions.
- `projectPoseKeypoints({ object, camera, width, height }): Array<{ name: string, x: number, y: number, visible: boolean }>`
- `poseConnections`: stable bone pairs used by the renderer.
- `clampDepth(value): number` returns a `[0, 1]` depth value.

- [x] **Step 1: Write failing pure mapping tests**

Cover a standing rig, a translated rig, and a point behind the camera. Assert that the same input produces identical ordered keypoints, screen coordinates stay inside output bounds when visible, and depth values are clamped.

- [x] **Step 2: Run the focused Node test and verify it fails**

Run: `cd web && node --test monoform-studio/src/control-passes.test.js`

Expected: FAIL because the helper module does not exist.

- [x] **Step 3: Implement mapping and clamping helpers**

Export the OpenPose mapping from `rig.js`, calculate world joint positions from the existing `poseForObject()` data, project through the active camera, and keep the renderer-independent helpers free of React and DOM state.

- [x] **Step 4: Run the focused Node test and verify it passes**

Run: `cd web && node --test monoform-studio/src/control-passes.test.js`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add web/monoform-studio/src/control-passes.js web/monoform-studio/src/control-passes.test.js web/monoform-studio/src/rig.js
git commit -m "feat: add deterministic director control pass mapping"
```

### Task 3: Render control passes and expose the MONOFORM capture action

**Files:**

- Modify: `web/monoform-studio/src/Viewport.jsx`
- Modify: `web/monoform-studio/src/App.jsx`
- Test/build: `web/monoform-studio/src/control-passes.test.js`, embedded build output

**Interfaces:**

- `CameraPreview` accepts `renderMode: "beauty" | "pose" | "depth"`.
- `captureControlPasses({ shotId, frame, width, height }): Promise<DirectorCaptureResult>` is an App-level action.
- App emits `monoform:ready`, responds to `control.capture`, and emits `control.result` or `error` with the original `requestId`.

- [x] **Step 1: Add a failing renderer contract test**

Extend the pure tests to assert that `renderMode` accepts only `beauty`, `pose`, or `depth` and that the capture result requires both requested passes with matching dimensions.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `cd web && node --test monoform-studio/src/control-passes.test.js`

Expected: FAIL on the missing render-mode/result assertions.

- [x] **Step 3: Implement Pose and Depth render modes**

Use the existing `CameraPreview` scene and camera setup. Pose mode draws the projected joints and `poseConnections` onto a transparent/black canvas. Depth mode uses a depth material or depth texture and linearizes the active camera range to grayscale. Keep export canvas dimensions deterministic and use `toBlob("image/png")`.

- [x] **Step 4: Implement the iframe handshake and request correlation**

On mount, post `ready` only when the studio can capture. On `control.capture`, freeze playback, capture requested passes, include shot/frame/camera metadata, and restore the previous playback state in `finally`. Reject a second capture while one is active.

- [x] **Step 5: Build the embedded studio**

Run: `cd web && npm run build:monoform`

Expected: the embedded MONOFORM build completes and syncs into `web/public/monoform`.

- [x] **Step 6: Commit**

```bash
git add web/monoform-studio/src/Viewport.jsx web/monoform-studio/src/App.jsx web/public/monoform
git commit -m "feat: expose monoform pose and depth capture"
```

### Task 4: Implement the ComfyUI workflow registry and adapter

**Files:**

- Create: `web/server/comfyui-workflows.mjs`
- Create: `web/server/comfyui-client.mjs`
- Create: `web/server/comfyui-workflows.test.mjs`
- Create: `web/server/comfyui-client.test.mjs`
- Create: `web/server/workflows/portrait-pose-depth-api.json`
- Modify: `web/package.json`, `web/package-lock.json` only if a WebSocket client dependency is needed

**Interfaces:**

- `createWorkflowRegistry({ directory, manifests }): { get(workflowId), patch(workflowId, inputs) }`
- `createComfyUiClient({ baseUrl, apiPrefix, fetchImpl, websocketFactory, timeoutMs })`
- `client.uploadImage({ bytes, filename, mimeType, subfolder }) -> { name, subfolder, type }`
- `client.queuePrompt({ prompt, clientId, promptId }) -> { prompt_id, number, node_errors }`
- `client.waitForCompletion({ clientId, promptId, onProgress, signal }) -> void`
- `client.getHistory(promptId) -> ComfyHistory`
- `client.getOutput(fileRef) -> { bytes, mimeType }`
- `client.interrupt(promptId) -> void`

- [x] **Step 1: Write failing workflow tests**

Test that the registry loads `portrait-pose-depth`, patches only declared logical nodes, rejects an unknown workflow, and rejects a manifest that points to a missing node.

- [x] **Step 2: Run workflow tests and verify they fail**

Run: `cd web && node --test server/comfyui-workflows.test.mjs`

Expected: FAIL because the registry and workflow file do not exist.

- [x] **Step 3: Add the API-format workflow and registry**

Store the exported workflow JSON and a manifest containing logical node IDs for Pose, Depth, positive prompt, negative prompt, seed, dimensions, and the output node. Deep-clone before patching so one request cannot mutate the registry cache.

- [x] **Step 4: Write failing adapter tests with injected fetch and WebSocket doubles**

Assert multipart upload fields, `/prompt` request body, WebSocket completion on `executing` with `node: null`, history output selection, binary `/view` retrieval, and targeted interrupt payload.

- [x] **Step 5: Run adapter tests and verify they fail**

Run: `cd web && node --test server/comfyui-client.test.mjs`

Expected: FAIL because the adapter does not exist.

- [x] **Step 6: Implement the adapter**

Keep the upstream base URL fixed at construction. Support an optional `/api` prefix, pass no browser-controlled headers, and use a request-scoped `clientId` and UUID `promptId`. When WebSocket progress disconnects, expose a controlled error so the task layer can switch to history polling.

- [x] **Step 7: Run both focused test files**

Run: `cd web && node --test server/comfyui-workflows.test.mjs server/comfyui-client.test.mjs`

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add web/server/comfyui-workflows.mjs web/server/comfyui-client.mjs web/server/comfyui-workflows.test.mjs web/server/comfyui-client.test.mjs web/server/workflows/portrait-pose-depth-api.json web/package.json web/package-lock.json
git commit -m "feat: add comfyui workflow adapter"
```

### Task 5: Add the server-side task store and Atelier job API

**Files:**

- Create: `web/server/comfyui-task-store.mjs`
- Create: `web/server/comfyui-api.mjs`
- Create: `web/server/comfyui-api.test.mjs`

**Interfaces:**

- `createComfyUiTaskStore({ ttlMs, clock }): { create, get, update, cancel, close }`
- `createComfyUiApi({ client, registry, store, maxBytes, parseMultipart }): { handle, close }`
- API paths: `POST /api/comfyui/jobs`, `GET /api/comfyui/jobs/:taskId`, `GET /api/comfyui/jobs/:taskId/output`, `DELETE /api/comfyui/jobs/:taskId`.

- [x] **Step 1: Write failing task-store tests**

Cover state transitions, idempotency for the same request key, TTL cleanup, cancellation idempotence, and rejection of updates after `cancelled`.

- [x] **Step 2: Run task-store tests and verify they fail**

Run: `cd web && node --test server/comfyui-api.test.mjs`

Expected: FAIL because the task store and API do not exist.

- [x] **Step 3: Implement task store transitions**

Allow only `queued -> uploading -> submitted -> running -> succeeded|failed|cancelled`. Store final output bytes only for the task TTL. Make `cancel()` return the existing terminal state when called more than once.

- [x] **Step 4: Implement multipart request parsing and input validation**

Accept `pose` and `depth` image parts, enforce a byte limit and `image/png`/`image/webp` MIME allowlist, validate dimensions and required text fields, and reject unknown workflow IDs before contacting ComfyUI. If the existing Node runtime has no suitable built-in multipart parser, add `busboy` and lock its version.

- [x] **Step 5: Implement asynchronous job orchestration**

Create the task, upload controls, patch the workflow, submit the prompt, update progress from WebSocket messages, fall back to periodic history reads after a WebSocket disconnect, fetch the selected output, and store it on success. On cancellation, call `client.interrupt(promptId)` and prevent later callbacks from changing the task.

- [x] **Step 6: Add API integration tests**

Use a fake ComfyUI client and an HTTP server. Assert `202` creation, `200` status, scoped binary output, `DELETE` cancellation, duplicate-submit reuse, invalid-input `400`, and late-success-after-cancel behavior.

- [x] **Step 7: Run focused server tests**

Run: `cd web && node --test server/comfyui-api.test.mjs`

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add web/server/comfyui-task-store.mjs web/server/comfyui-api.mjs web/server/comfyui-api.test.mjs web/package.json web/package-lock.json
git commit -m "feat: add comfyui generation job api"
```

### Task 6: Mount the gateway and add the browser job client

**Files:**

- Modify: `web/vite.config.ts`
- Create: `web/src/services/comfyui-director.ts`
- Create: `web/src/services/comfyui-director.test.ts`

**Interfaces:**

- `comfyuiApiPlugin({ createApi }): Plugin`
- `createComfyUiJob(input: ComfyUiJobCreate): Promise<ComfyUiJobStatus>`
- `getComfyUiJob(taskId: string): Promise<ComfyUiJobStatus>`
- `getComfyUiOutput(taskId: string): Promise<Blob>`
- `cancelComfyUiJob(taskId: string): Promise<void>`

- [x] **Step 1: Write failing browser-client tests**

Mock `fetch` and assert multipart field names, same-origin relative URLs, `202` handling, normalized error responses, output MIME preservation, and cancellation method/path.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `cd web && npm run test:unit -- src/services/comfyui-director.test.ts`

Expected: FAIL because the client does not exist.

- [x] **Step 3: Implement the browser client**

Use relative `/api/comfyui/...` URLs only. Do not add a target URL parameter. Convert `Blob` values to `FormData` parts and preserve the server's task/error envelope.

- [x] **Step 4: Mount the server API in dev and preview**

Mirror the existing Codex plugin pattern in `vite.config.ts`, including close handling. Read `COMFYUI_BASE_URL`, `COMFYUI_API_PREFIX`, `COMFYUI_TASK_TTL_MS`, and optional request limits only on the Node side.

- [x] **Step 5: Run the focused test and the server API test**

Run: `cd web && npm run test:unit -- src/services/comfyui-director.test.ts && node --test server/comfyui-api.test.mjs`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add web/vite.config.ts web/src/services/comfyui-director.ts web/src/services/comfyui-director.test.ts
git commit -m "feat: expose same-origin comfyui client"
```

### Task 7: Connect DirectorPanel and create the canvas result node

**Files:**

- Modify: `web/src/components/canvas/director-panel.tsx`
- Modify: `web/src/pages/canvas/project.tsx`
- Modify: `web/src/types/canvas.ts`
- Modify: `web/src/lib/canvas/canvas-node-factory.ts`
- Create: `web/src/lib/canvas/director-node-metadata.ts`
- Create: `web/src/lib/canvas/director-node-metadata.test.ts`

**Interfaces:**

- `DirectorPanel` gains `onGenerateComfy(input: DirectorCaptureResult): void` and `onGenerationCancel(): void` callbacks.
- `buildDirectorComfyMetadata(uploaded, task): CanvasNodeMetadata`.
- `handleDirectorComfyGenerate(directorNodeId, captureResult): Promise<void>`.

- [x] **Step 1: Write failing provenance tests**

Assert that metadata includes provider, task ID, prompt ID, workflow ID, director node ID, shot ID, frame, dimensions, MIME type, and storage key while not storing raw control blobs in canvas JSON.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `cd web && npm run test:unit -- src/lib/canvas/director-node-metadata.test.ts`

Expected: FAIL because the helper does not exist.

- [x] **Step 3: Implement metadata and canvas insertion**

Reuse the existing `createCanvasNode`, `uploadImage`, `imageMetadata`, and Director-node positioning logic. Set the new image node to `loading` before the request, update it to `success` after storage, and set an actionable `errorDetails` on failure.

- [x] **Step 4: Implement the typed iframe bridge in DirectorPanel**

Keep existing export handling, add `iframeRef`, send `control.capture` with a generated `requestId`, accept only matching responses from the current iframe, and expose terminal task progress to the panel. Never use `'*'` for the target origin when the iframe is same-origin.

- [x] **Step 5: Add the “生成真人图” action**

The action requests Pose/Depth from MONOFORM, submits them through the browser client, polls status until terminal, downloads the output, and inserts it beside the Director node. Disable duplicate clicks while a request is active and allow cancellation.

- [x] **Step 6: Run unit tests and typecheck**

Run: `cd web && npm run test:unit -- src/lib/canvas/director-node-metadata.test.ts && npm run typecheck`

Expected: PASS with no new TypeScript errors.

- [x] **Step 7: Commit**

```bash
git add web/src/components/canvas/director-panel.tsx web/src/pages/canvas/project.tsx web/src/types/canvas.ts web/src/lib/canvas/canvas-node-factory.ts web/src/lib/canvas/director-node-metadata.ts web/src/lib/canvas/director-node-metadata.test.ts
git commit -m "feat: connect director generation to canvas"
```

### Task 8: Add Docker configuration and operator documentation

**Files:**

- Modify: `docker-compose.yml` or the repository's existing compose file
- Create or modify: `.env.example`
- Create: `docs/comfyui.md`
- Modify: `README.md`

**Interfaces:**

- Environment variables: `COMFYUI_BASE_URL`, `COMFYUI_API_PREFIX`, `COMFYUI_WS_ENABLED`, `COMFYUI_TASK_TTL_MS`.
- Compose service name: `comfyui`; Atelier connects to `http://comfyui:8188` by default in the bundled example.

- [x] **Step 1: Write the configuration validation test**

Add a server-side test that an unset base URL fails closed, a valid Compose URL is accepted, and a client request cannot override the configured upstream.

- [x] **Step 2: Run the configuration test and verify it fails**

Run: `cd web && node --test server/comfyui-api.test.mjs`

Expected: FAIL until the configuration is wired into the gateway constructor.

- [x] **Step 3: Add Compose and environment examples**

Document the Atelier-to-ComfyUI private network, model/custom-node persistent volumes, GPU runtime requirements, and Mac `host.docker.internal` development override. Do not put real keys in committed files.

- [x] **Step 4: Add operator documentation**

Document the required ComfyUI workflow export, checkpoint/ControlNet/custom-node prerequisites, health checks, output cleanup, and the remote-GPU topology. Include a troubleshooting table for missing nodes, WebSocket disconnect, invalid workflow, and output-not-found errors.

- [ ] **Step 5: Run formatting and build checks**

Run:

```bash
cd web
npm run format:check
npm run typecheck
npm run build:monoform
npm run build
```

Expected: all commands pass. If Docker is available, also run `docker compose config` and a smoke start; if it is unavailable, report that separately rather than claiming a container run was verified.

- [x] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example docs/comfyui.md README.md
git commit -m "docs: add comfyui deployment configuration"
```

### Task 9: End-to-end verification and final review

**Files:**

- Test: existing bridge/server tests plus the browser smoke path
- Review: all files listed in the File Map

- [x] **Step 1: Run the complete automated suite**

Run:

```bash
cd web
npm run test:codex
npm run test:unit
npm run typecheck
npm run build:monoform
npm run build
```

Expected: all automated checks pass.

- [x] **Step 2: Run the fake-ComfyUI integration flow**

Start the test server with the fake adapter, create a Director job with two PNG control passes, wait for `succeeded`, fetch output, and assert that cancellation prevents a late completion from changing the state.

- [x] **Step 3: Run the real browser smoke flow**

Open a Director node, pose a person, click “生成真人图”, confirm control capture, observe progress, verify the Image node appears, reload the canvas, and verify the stored image remains available.

- [x] **Step 4: Review security and failure evidence**

Check that no ComfyUI URL or credential is present in browser bundles, that invalid origins are ignored, that arbitrary upstream URLs are rejected, and that the final task state is not overwritten by late WebSocket events.

- [x] **Step 5: Commit verification notes**

```bash
git add docs/superpowers/plans/2026-09-06-infinite-atelier-monoform-comfyui-plan.md
git commit -m "docs: finalize comfyui implementation plan"
```

## Execution handoff

Implement tasks in order. Do not start Task 3 until Tasks 1 and 2 have passing tests; do not start Task 7 until the server API and browser client are independently passing. After each task, review the focused diff and test output before proceeding.

## External release acceptance still pending

- [ ] Validate real ComfyUI GPU inference with the required licensed models; a fake upstream is not evidence of photorealistic generation.
- [ ] Build and smoke-run the Compose containers on a Docker/NVIDIA host.
- [ ] Resolve the remaining repository-wide formatting expectation as a separate, deliberate cleanup rather than rewriting unrelated source during this feature.
