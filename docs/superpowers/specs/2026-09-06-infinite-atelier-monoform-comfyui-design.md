# Infinite Atelier + MONOFORM + ComfyUI

## 1. Status and objective

- Status: design approved in conversation; implementation has not started.
- Date: 2026-09-06.
- Objective: allow a director to arrange one or more characters in MONOFORM, capture the current shot as Pose and Depth control images, submit those controls to ComfyUI, and insert the returned photorealistic image into the Infinite Atelier canvas.

The first implementation targets a single-user local or single-server Docker deployment. The interfaces must also support a remote GPU-hosted ComfyUI instance without exposing ComfyUI directly to the browser.

## 2. Architectural decision

Use a server-side ComfyUI Gateway inside the existing Atelier Node/Vite server for the first release. The gateway owns the ComfyUI base URL, credentials, workflow registry, task lifecycle, WebSocket connection, and output retrieval. It is isolated behind a provider adapter so it can later move to a standalone `atelier-generation-gateway` container without changing the browser or MONOFORM contracts.

The browser never calls ComfyUI directly. MONOFORM produces deterministic control assets; the gateway performs orchestration; the canvas stores the final result using the existing IndexedDB image storage.

```text
Canvas project.tsx
  <-> typed, origin-validated postMessage
DirectorPanel.tsx
  <-> iframe
MONOFORM App.jsx / Viewport.jsx
  -> pose.png + depth.png + shot metadata
Atelier /api/comfyui/jobs
  -> upload controls, patch API workflow, submit job
ComfyUI HTTP + WebSocket API
  -> history + view output
Atelier image-storage
  -> Infinite Atelier Image node
```

## 3. Scope boundaries

### In scope

1. Capture the active MONOFORM shot and frame.
2. Produce a Pose pass and a Depth pass using the same camera and output dimensions.
3. Submit a versioned ComfyUI API-format workflow.
4. Track queued, running, completed, failed, and cancelled states.
5. Return a PNG to the browser and create an Image node next to the Director node.
6. Preserve generation provenance in canvas metadata.
7. Run with ComfyUI in the same Docker Compose network or on a private remote GPU host.

### Out of scope for the first release

- Direct browser-to-ComfyUI communication.
- An arbitrary workflow editor inside Infinite Atelier.
- Multi-tenant billing or quota management.
- Durable distributed task scheduling. The task store may start as an in-memory TTL store for a single-user deployment.
- Video generation through ComfyUI. Video remains an independent provider path.

## 4. Component responsibilities and file changes

### MONOFORM

`web/monoform-studio/src/App.jsx`

- Add `captureControlPasses()`.
- Freeze playback at the active frame while capturing.
- Serialize `shotId`, frame, camera, aspect ratio, and control-pass dimensions.
- Emit `monoform:ready`, `monoform:control-result`, and `monoform:error` messages.
- Keep the existing image/video export message compatible.

`web/monoform-studio/src/Viewport.jsx`

- Extend `CameraPreview` with `renderMode: "beauty" | "pose" | "depth"`.
- Pose mode renders a 2D OpenPose-compatible skeleton pass from the current rig projection.
- Depth mode renders a linearized grayscale depth pass using the active shot camera.
- Ensure every pass uses the same camera transform, aspect ratio, and output dimensions.

`web/monoform-studio/src/rig.js`

- Add a stable internal-rig-to-OpenPose keypoint mapping.
- Keep the mapping separate from the visual rig implementation so future rig changes do not silently change workflow inputs.

### Atelier browser

`web/src/components/canvas/director-panel.tsx`

- Own the iframe reference and handshake state.
- Validate `event.source` against the iframe window and `event.origin` against the expected same-origin origin.
- Send typed control-capture requests and forward results to the page controller.
- Display generation progress, cancellation, retry, and terminal errors.
- Keep ordinary MONOFORM image/video exports working.

`web/src/pages/canvas/project.tsx`

- Add `handleDirectorComfyGenerate`.
- Submit captured controls to the same-origin Atelier API.
- Poll or subscribe to task status and handle cancellation.
- Download the final image, call the existing `uploadImage(blob)`, and create an Image node beside the Director node.

New browser modules:

- `web/src/types/director.ts`: message envelopes and control-pass types.
- `web/src/types/comfyui.ts`: job request, status, output, and error types.
- `web/src/services/comfyui-director.ts`: same-origin API client; no ComfyUI URL or credential in browser state.
- `web/src/lib/canvas/director-node-metadata.ts`: provenance metadata builder.

`web/src/types/canvas.ts` and `web/src/lib/canvas/canvas-node-factory.ts`

- Add optional provenance fields such as `generationProvider`, `generationTaskId`, `comfyPromptId`, `workflowId`, `directorNodeId`, `directorShotId`, and `directorFrame`.
- Keep the existing generic `imageMetadata()` helper and add a ComfyUI-specific metadata helper rather than overloading provider concerns into it.

### Server

New modules:

- `web/server/comfyui-api.mjs`: request handlers for the Atelier-facing job API.
- `web/server/comfyui-client.mjs`: ComfyUI HTTP and WebSocket adapter.
- `web/server/comfyui-workflows.mjs`: workflow registry and node-input patching.
- `web/server/comfyui-task-store.mjs`: task state, TTL cleanup, and idempotency lookup.
- `web/server/workflows/portrait-pose-depth-api.json`: first API-format workflow.

`web/vite.config.ts`

- Add `comfyuiApiPlugin()` alongside the existing Codex subscription plugin.
- Do not reuse the generic target-based API proxy for ComfyUI; the gateway must use a fixed server-side `COMFYUI_BASE_URL`.

## 5. Browser message protocol

All messages use this envelope:

```ts
type AtelierMonoformMessage = {
  protocol: "atelier-monoform";
  version: 1;
  source: "atelier" | "monoform";
  type: string;
  requestId?: string;
  nodeId?: string;
  payload?: unknown;
};
```

### Handshake

```json
{
  "protocol": "atelier-monoform",
  "version": 1,
  "source": "monoform",
  "type": "ready",
  "payload": {
    "capabilities": ["capture-image", "capture-pose", "capture-depth"],
    "projectKey": "director-node-id"
  }
}
```

### Capture request

```json
{
  "protocol": "atelier-monoform",
  "version": 1,
  "source": "atelier",
  "type": "control.capture",
  "requestId": "req_123",
  "payload": {
    "shotId": "shot-01",
    "frame": 0,
    "passes": ["pose", "depth"],
    "width": 1024,
    "height": 1024
  }
}
```

### Capture result

The structured-clone payload contains `Blob` values in the first implementation. If memory pressure is observed, switch to transferable `ArrayBuffer` values without changing the envelope.

```text
monoform:control-result
  requestId
  shotId
  frame
  pose: { blob, mimeType, width, height }
  depth: { blob, mimeType, width, height }
  camera: { position, rotation, focalLength, aspectRatio }
```

Errors include a stable code (`CAPTURE_FAILED`, `UNSUPPORTED_CAPABILITY`, `INVALID_REQUEST`) and a user-safe message.

## 6. Atelier-facing job API

### Create

`POST /api/comfyui/jobs` as `multipart/form-data`.

Fields:

```text
workflowId
prompt
negativePrompt
seed
shotId
frame
width
height
pose
depth
reference (optional)
```

Response:

```json
{
  "taskId": "task_123",
  "status": "queued",
  "workflowId": "portrait-pose-depth"
}
```

### Status

`GET /api/comfyui/jobs/:taskId`

```json
{
  "taskId": "task_123",
  "status": "running",
  "progress": { "nodeId": "ksampler", "step": 12, "max": 24, "percent": 50 },
  "promptId": "comfy-prompt-id"
}
```

### Output and cancellation

- `GET /api/comfyui/jobs/:taskId/output` returns `image/png`.
- `DELETE /api/comfyui/jobs/:taskId` requests targeted cancellation.

Job states are `queued`, `uploading`, `submitted`, `running`, `succeeded`, `failed`, and `cancelled`.

## 7. ComfyUI adapter contract

The adapter uses the following local-compatible sequence:

1. `POST /upload/image` for `pose.png` and `depth.png`.
2. Load a versioned API-format workflow and patch the `LoadImage`, prompt, seed, and size nodes.
3. `POST /prompt` with `prompt`, `client_id`, and a generated `prompt_id`.
4. Connect to `/ws?clientId=<client_id>` for execution events.
5. Treat `executing` with `node: null` for the matching prompt as terminal success.
6. Fetch `/history/{prompt_id}`.
7. Fetch output files using `/view?filename=...&subfolder=...&type=output`.
8. Stream the selected output through the Atelier gateway.

The workflow must be exported using ComfyUI's API format (`File -> Export (API)`), not the UI layout JSON. The official examples document this format and the WebSocket/history/view sequence:

- [ComfyUI basic API example](https://github.com/Comfy-Org/ComfyUI/blob/master/script_examples/basic_api_example.py)
- [ComfyUI WebSocket API example](https://github.com/Comfy-Org/ComfyUI/blob/master/script_examples/websockets_api_example.py)
- [ComfyUI server routes](https://github.com/Comfy-Org/ComfyUI/blob/master/server.py)

The adapter supports a configurable `apiPrefix` because current ComfyUI exposes both legacy routes and `/api`-prefixed aliases. Managed ComfyUI services may have different history/job routes and authentication, so those differences stay inside the adapter profile rather than leaking into browser code.

## 8. Workflow registry

The first workflow is `portrait-pose-depth` and is stored as API-format JSON. A manifest maps logical inputs to node IDs:

```ts
{
  id: "portrait-pose-depth",
  version: 1,
  inputNodes: {
    pose: "12",
    depth: "13",
    positivePrompt: "6",
    negativePrompt: "7",
    seed: "3"
  },
  outputNode: "21",
  requiredModels: [
    "checkpoint.safetensors",
    "controlnet-openpose.safetensors",
    "controlnet-depth.safetensors"
  ]
}
```

Custom nodes, ControlNet models, checkpoint names, VAE, LoRA, sampler, and ComfyUI version are deployment prerequisites and must be documented with the workflow. The gateway reports missing workflow inputs as an actionable terminal error rather than silently switching workflows.

## 9. Canvas result and provenance

On success, `project.tsx` downloads the PNG, stores it through `uploadImage()`, and creates a normal `CanvasNodeType.Image`. Metadata includes:

```text
source = monoform
generationProvider = comfyui
generationTaskId
comfyPromptId
workflowId
directorNodeId
directorShotId
directorFrame
```

Pose and Depth can be retained as hidden linked assets in Phase 2. Phase 1 only needs the final image node.

## 10. Deployment contract

### Docker Compose, same host

```text
atelier:3000  ->  comfyui:8188
```

```env
COMFYUI_BASE_URL=http://comfyui:8188
COMFYUI_API_PREFIX=
COMFYUI_WS_ENABLED=true
COMFYUI_TASK_TTL_MS=3600000
```

### Remote GPU host

```text
browser -> Atelier HTTPS -> private network -> ComfyUI GPU host
```

ComfyUI remains private. The browser never receives its URL or credentials. For Mac Docker-to-host development, `http://host.docker.internal:8188` may be used as the server-side base URL.

Models and `custom_nodes` use persistent volumes and pinned versions. Output files are streamed through Atelier and cleaned using a TTL policy.

## 11. Reliability and security

- Generate an idempotency key from Director node, shot, frame, workflow, prompt, seed, and control-image hashes.
- Ignore duplicate submit clicks for the same active request.
- Validate MIME type and maximum dimensions before forwarding images.
- Allow only the configured ComfyUI origin; never accept a client-supplied upstream URL.
- Store provider credentials only in server environment/configuration.
- Use request-scoped `client_id` and `prompt_id` values.
- Handle WebSocket disconnects with HTTP history polling fallback.
- Make cancellation idempotent and keep terminal task cleanup separate from late notifications.
- Do not expose arbitrary ComfyUI filenames; output access is scoped to the Atelier task.

## 12. Verification plan

### Unit tests

- Message envelope validation and origin filtering.
- OpenPose keypoint mapping.
- Depth/pose capture request correlation by `requestId`.
- Workflow node patching and missing-node errors.
- ComfyUI response parsing, terminal events, and output selection.
- Idempotency and cancellation races.

### Integration tests

- Mock ComfyUI `/upload/image`, `/prompt`, `/ws`, `/history`, `/view`, and `/interrupt`.
- Submit a control pair and assert the final image is returned.
- Drop WebSocket connection and verify polling fallback.
- Send a late completion after cancellation and assert the task remains cancelled.

### Browser smoke test

1. Open a Director node.
2. Add or pose a person.
3. Click “生成真人图”.
4. Confirm Pose/Depth capture completes.
5. Confirm progress reaches `succeeded`.
6. Confirm a new Image node appears on the canvas.
7. Reload the canvas and confirm the image remains available from IndexedDB.

## 13. Delivery sequence

1. Implement the typed MONOFORM bridge and control-pass renderer.
2. Implement the ComfyUI adapter and one workflow manifest.
3. Add the Atelier job API and task lifecycle.
4. Connect `project.tsx` to create the final canvas Image node.
5. Add Docker environment documentation and integration tests.
6. Add retries, caching, and linked control assets after the first end-to-end run is verified.

No implementation should begin until this specification has been reviewed and approved as a document.
