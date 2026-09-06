# Task 3 report: MONOFORM Pose/Depth capture

## Delivered

- `web/monoform-studio/src/App.jsx`
  - Announces `atelier-monoform` v1 `monoform:ready` once when embedded.
  - Validates same-origin `control.capture` requests from its parent, preserves the original `requestId`, and responds with `control.result` or `monoform:error`.
  - Adds an exclusive control-capture lock, rejects overlapping image/video/control exports, freezes playback, restores the prior playback state in `finally`, and captures exact requested frame snapshots.
  - Exports matching PNG `pose` and `depth` blobs with camera/shot/frame metadata through hidden deterministic-size canvases.
  - Leaves the existing `source: "monoform", type: "export"` image and video postMessage behavior unchanged.

- `web/monoform-studio/src/Viewport.jsx`
  - Extends `CameraPreview` with `renderMode: "beauty" | "pose" | "depth"`; unsupported values fall back to `beauty`.
  - Pose mode produces a black-background OpenPose-style canvas from the Task 2 ordered keypoints and connections.
  - Pose mode samples the loaded Mixamo GLB's world-space bones when available, so clip animation and live bone rotations override the static rig projection.
  - Depth mode renders the existing preview scene with a linearized near/far grayscale `MeshDepthMaterial` override.

- `web/monoform-studio/src/control-passes.js`
  - Adds pure render-mode and capture-result validation helpers.
  - Accepts optional live world-bone positions without changing Task 2's keypoint ordering or fallback projection.

- `web/monoform-studio/src/control-passes.test.js`
  - Adds renderer-mode and exact output-dimension/result-shape coverage.

- `web/public/monoform`
  - Rebuilt embedded MONOFORM entry bundle and generated assets.

## Test-first evidence

1. Added failing imports/assertions for `isControlRenderMode` and `validateControlCaptureResult`.
2. Ran `cd web && node --test monoform-studio/src/control-passes.test.js`.
3. Observed the expected RED failure: `control-passes.js` did not export `isControlRenderMode`.
4. Implemented the helpers and rendering/capture integration.

## Verification

| Command | Result |
| --- | --- |
| `cd web && node --test monoform-studio/src/control-passes.test.js` | PASS: 6 tests |
| `cd web && npm run build:monoform` | PASS: Vite embedded build and sync into `web/public/monoform` |
| `cd web && npm run build` | PASS: production web build |
| `git diff --check` | PASS |

The two Vite builds retain pre-existing chunk-size/dynamic-import warnings; neither reports a new compilation or runtime error.

## Rulings

- Pose uses a black canvas rather than transparent output. This is the most broadly compatible input for common OpenPose/ControlNet workflows and avoids alpha interpretation differences in ComfyUI nodes.
- Control capture intentionally requires both `pose` and `depth`. The version-1 `DirectorCaptureResult` contract requires both fields and the target ComfyUI workflow consumes both controls.
- The same-origin iframe bridge targets `window.location.origin`; only the pre-existing legacy image/video export messages retain `"*"` so existing host behavior is preserved exactly.

## Concerns and follow-up

- The pure tests cover render-mode/result contracts and off-frame dimensions, but a headless WebGL/browser capture smoke test is not available in this worktree. Before release, manually trigger `control.capture` against an embedded director and inspect both PNGs at 1024×1024 and a non-square size.
- The live-bone path uses the available Mixamo GLB world transforms. If the GLB cannot load, Pose deterministically falls back to Task 2's saved rig/keyframe projection; this preserves control generation but is less exact for clip-only motion.
- The MONOFORM sync script intentionally retains old hashed bundles. The rebuilt `index.html` references only the current generated assets; old unreferenced files are harmless and were not removed by this task.

## Review-fix follow-up

### Root cause and corrections

1. **Pose/Depth camera mismatch**: the Pose projection read the saved shot's `aspectRatio`, while the Depth canvas used the requested output ratio. Added `controlPassCamera()` so a capture snapshots one camera with the requested `width:height`, original focal length, and fixed shared `near`/`far`. Both the Pose projector and Depth renderer now receive that same capture camera. The regression test covers a square request from a 16:9 source camera.
2. **Capture mutual exclusion**: control capture held its own lock but did not acquire the image/video export lock. It now acquires and releases the shared lock in `finally`; all three handlers use `isCaptureBusy()`, and export controls are disabled while a control capture is mounted.
3. **v1 result validator**: it previously accepted empty or partial `passes` through `every()`. It now requires precisely the version-1 `pose` and `depth` pair before validating their PNG blobs and dimensions.

### Review-fix verification

| Command | Result |
| --- | --- |
| `cd web && node --test monoform-studio/src/control-passes.test.js` | PASS: 8 tests, including aspect, shared-busy-guard, and v1 pass-pair regressions |
| `cd web && npm run build:monoform` | PASS |
| `cd web && npm run build` | PASS |
| `git diff --check` | PASS |

The same existing chunk-size/dynamic-import warnings remain; no new build errors were reported.
