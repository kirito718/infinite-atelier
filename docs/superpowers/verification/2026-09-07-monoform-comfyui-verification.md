# MONOFORM / ComfyUI implementation verification

Date: 2026-09-07 (Asia/Shanghai)

## Scope and status

Continued the existing `2026-09-06-infinite-atelier-monoform-comfyui-plan.md` in the existing `feat/monoform-comfyui-generation` worktree. No subagents were used. The original `main` checkout and its port-3000 service were left unchanged; changes have not been pushed or merged.

- Tasks 1–6: existing implementation reviewed and reverified.
- Task 7: Director-to-canvas flow implemented, including current shot/frame capture, prompt input, progress, cancellation, retry and IndexedDB persistence.
- Task 8: environment configuration, Dockerfiles, private Compose topology, CI workflow and operator documentation implemented. Container execution is **not verified** on this machine.
- Task 9: automated tests, real-HTTP fake-upstream integration, and real Chromium dev/production-preview smoke completed. Actual GPU inference with the required models is **not verified**.

Implementation commits in this continuation: `3cf2408`, `80ac54e`, `e1f55f4`, `6b821b7`, `14647ff`. Earlier commits remain in the branch history.

## Automated evidence

Commands run from `web/` against the final implementation:

| Command                                                  | Result              |
| -------------------------------------------------------- | ------------------- |
| `npm run test:codex`                                     | 86 passed, 0 failed |
| `npm run test:unit`                                      | 42 passed, 0 failed |
| `node --test monoform-studio/src/control-passes.test.js` | 13 passed, 0 failed |
| `npm run typecheck`                                      | Passed              |
| `npm run build:monoform`                                 | Passed              |
| `npm run build`                                          | Passed              |
| `git diff --check`                                       | Passed              |

Total: **141 automated tests passed**. The Node suite includes the existing Codex/bridge tests, so the existing provider paths remain covered.

`web/server/comfyui-integration.test.mjs` runs actual HTTP servers and the production gateway/client/workflow registry, not only an injected adapter. It verifies multipart image upload, workflow patching, a real failed WebSocket upgrade with history fallback, scoped output bytes, idempotent submission, cancellation followed by late completion, disabled WebSocket monitoring, and upstream queue-error classification.

### Formatting and build warnings

- All 25 changed TypeScript/server `.mjs` files passed their scoped Prettier check.
- Generated MONOFORM bundles and local browser-test artifacts are now excluded from formatting.
- Whole-project `npm run format:check` still reports **54 existing/original-style source files**, including the independently styled embedded MONOFORM source. A pre-resume file (`src/constant/canvas.ts` at `e75a402`) was checked separately and also failed the current formatter rules. Unrelated source was not mass-reformatted.
- Builds retain the existing large-chunk warnings; the main application bundle is approximately 2.55 MB before gzip. This is not a build failure, but remains a performance follow-up.

## Browser evidence

The browser exercised both development and fresh production-preview builds on an isolated port. The upstream fixture returned a control PNG deliberately; it did **not** run a diffusion model or produce a real photograph.

Verified actions:

1. Create a canvas and Director node; load embedded MONOFORM and change the character action.
2. Capture the currently selected shot/frame, including a non-zero frame (`360`).
3. Submit the two control PNGs, observe generation status, download and store the result.
4. Reload and verify both provenance and the PNG Blob remain in IndexedDB.
5. Verify initial image placement at a 32-unit horizontal gap from its Director.
6. Cancel a running job and confirm a job-scoped upstream cancellation request and a terminal cancelled state.
7. Simulate a missing-checkpoint queue error, then retry after restoring the fixture and observe success.
8. Click the failed image node's own **重试** action; verify it reopens the same Director rather than a generic image-provider configuration.
9. Verify repeated results no longer overlap: a failed result at `(781.5, 380)` and its successful retry at `(781.5, 652)` remain separate, with the successful PNG (37,976 bytes in that fixture run) still present after reload.

Final production-smoke browser logs contain no JavaScript errors or shader compilation errors. The normal Three.js context-release messages when temporary capture canvases unmount are informational.

### Control-pass fidelity

Browser checks exposed and fixed two rendering defects that the original tests did not cover:

- Depth shader uniform values existed in JavaScript but lacked GLSL declarations, causing shader compilation to fail.
- `Canvas.onCreated` was being treated as capture readiness before live character rigs/animations had mounted. Control capture now waits for every visible character's live joint positions and rendered frames, with a bounded timeout.

Pose now uses the anatomy-specific OpenPose body color palette rather than one arbitrary color per person. Two repeated captures of the same “招手” state were byte-identical for **both** passes; switching to the T-pose changed **both** hashes:

| Capture              | Pose SHA-256                                                       | Depth SHA-256                                                      |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Wave, repeated twice | `eacc2d6aadc3529b3aa23403519b98126a536a3d57736cba97fc5d04d4f22ac8` | `7d7f6544cdd6e50e28582073df4e9350bcb7550d5497f6c0f1f47b12e5639ffe` |
| T-pose               | `61974eb2a709c4ad9696d920387fce6d84c59d57f79dbfd44f8e3d93c6721b60` | `c9e1f284cc6d445ad29416d7cc6eafa2ba3f26ecde957edec92dff9090ec600a` |

The Wave Pose contained 5,522 nonblack/color pixels; Depth contained 81,356 nonblack pixels, zero colored pixels and 17 grayscale shades. Both PNGs were 1024×1024. These checks establish deterministic rendered control passes, not diffusion-model quality.

Local screenshots are retained under `web/output/playwright/`, including `comfyui-production-persisted.png`, `comfyui-retry-succeeded.png` and `comfyui-final-retry-layout.png`. They are local QA artifacts, not published assets.

## Reliability and security review

- Iframe source, origin, protocol, version, capabilities and request correlation are checked. Late/cancelled replies cannot start a new generation.
- Browser job requests cannot override the configured upstream. Invalid URL schemes, URL credentials/query fragments and API-prefix traversal fail closed.
- Browser-bundle scans found no server-side ComfyUI configuration values or fixture upstream URL.
- Create-response cancellation races are covered on both sides: the returned upstream prompt ID is cancelled even when queue acceptance arrives late.
- Failed/unconfirmed cancellation is reported honestly; a lost create response without a task ID is not described as confirmed upstream cancellation.
- Polling/body-read aborts and timeouts are bounded. Completed delay listeners are removed. Cached history can finish a task even when the WebSocket completion event was missed.
- Upstream execution failures become terminal promptly instead of waiting indefinitely for an output that cannot appear.
- Control Blobs are not serialized into canvas JSON. Output retrieval is task-scoped and PNG/WebP content is checked before storing it.
- This remains the documented single-user/private deployment model, not a multi-tenant public GPU API.

## Deployment evidence and remaining acceptance

Compose and CI YAML were parsed, the shell entrypoint passed `sh -n`, and the Compose structure was checked for its optional GPU profile, persistent volumes and lack of a public ComfyUI port. The pinned ComfyUI source was inspected for `/api/jobs/{job_id}/cancel`. The host has no Docker command, so neither `docker compose config` nor image build/container startup was executed locally; no CI run or registry push is claimed.

The temporary fake upstream and test browser were stopped. A fresh, ordinary production preview remains at `http://127.0.0.1:3001` **without** a ComfyUI upstream:

- `/canvas`: HTTP 200.
- `/api/comfyui/jobs`: HTTP 503 with the explicit server-configuration instruction.

Release acceptance still needs:

- [ ] A reachable real ComfyUI GPU host with licensed checkpoint/ControlNet files; verify an actual photorealistic output and acceptable pose/depth adherence.
- [ ] Docker-host validation: `docker compose --profile gpu config`, image builds, health checks, persistent volumes and GPU runtime startup.
- [ ] A separate decision on normalizing legacy formatting and splitting the existing large bundles.

See [operator instructions](../../comfyui.md) for model names, environment variables, native/Mac/remote-GPU deployment and troubleshooting. Environment changes require restarting/recreating the Atelier process/container.
