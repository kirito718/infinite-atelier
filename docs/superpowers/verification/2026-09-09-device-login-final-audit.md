# Device-login completion audit — 2026-09-09

## Result and scope

The code repair and functional acceptance gates pass for runtime commit `7cac52af9de270b8bbda7f5aed04cb2d9dc40103` on `fix/codex-device-login`.

This includes an actual Linux Docker build, HTTPS reverse-proxy application authentication, browser → real account API → real RPC client → test-only stdio peer, and a separate probe using the unmodified real Codex 0.153.4 binary against OpenAI's official device-code endpoint. The real probe obtained a code and cancelled it immediately. It did **not** submit a code, authorize an account, disclose the real code, or retain credentials.

Publication/deployment and the operator's eventual account authorization are separate actions, not claimed here.

## Requirement-by-requirement evidence

| Requirement | Current authoritative evidence | Result |
| --- | --- | --- |
| Remote login does not depend on localhost OAuth callbacks | `app-server-client.mjs` sends only `chatgptDeviceCode`; wire logs from both test users contain only that login type; real Codex returned the official device-code response | Pass |
| Official URL and response-field validation | `device-login.mjs`, `codex-image.ts`; malformed/legacy/loopback/foreign-URL tests; browser link is `https://auth.openai.com/codex/device` with `noopener noreferrer` | Pass |
| No token exposure or browser persistence of device codes | Four-field HTTP responses; account API tests; real browser storage checks; wire audit contains no real auth.json | Pass |
| Pending/reopen/cancel/retry/failure/completion behavior | Controller/unit tests, spawned-process HTTP integration test, and real browser on Docker/HTTPS; expiry removes code and offers retry; close/reopen reuses pending code | Pass |
| Account and process isolation | Cookie/user-bound API tests; actual two-user HTTPS checks; stale user header rejected with 409; foreign cancellation leaves other attempt unchanged; separate UID-1000 homes | Pass |
| Logout and closed-transport races | Deterministic regression tests and independent review; old stdout and old queued requests cannot restore a closed connection | Pass |
| Unresponsive authorization recovers | Default 60-second deadline on initialization/account RPCs; 16 deadline cases; retry and queue release verified; thread/turn and user code-entry wait have no independent short deadline | Pass |
| Docker runtime can perform native TLS | Runtime installs `ca-certificates`; final image contains 150 CA certificates; native device-code request/cancel succeeds on the fresh image | Pass |
| Original deployment's same-origin safety is preserved | Actual browser signup and login behind HTTPS → HTTP reverse proxy with rewritten Host; Secure/HttpOnly/SameSite cookies; forged Origin rejected with 403 | Pass |
| Server persistence survives recreation | Standard 8-group container acceptance; separate full-stack container recreated with original volume, preserving app session/user identity and test-peer authorization state | Pass |
| UI is usable in relevant contexts | Chinese/English, 390px and desktop, keyboard input→copy→link, Escape, no automatic popup, explicit clipboard action, readable guidance in light/dark | Pass |
| Full regression suite/typecheck/build | 527 tests passed: frontend 258, server/bridge 154, MONOFORM 88, container helpers 27. Typecheck and Docker's `build:all` passed | Pass |
| Genuine account has been authorized | Not performed; user consent on OpenAI's page is required when using the feature | Not claimed |
| New image is deployed to the user's server | No deployment/publication requested as part of this code-acceptance step | Not claimed |

## Issues found and fixed during this audit

1. **Hanging auth RPCs:** a live but unresponsive process could leave login/polling/queued operations pending indefinitely. Added scoped deadlines, cleanup and retry tests. Killing an unresponsive transport also invalidates other work on that transport; this is not a promise that generation survives a broken process.
2. **Native TLS trust store missing:** `node:22-bookworm-slim` lacked `/etc/ssl/certs/ca-certificates.crt`. Node's bundled roots masked this gap. Real Codex failed to obtain a device code. Installing only the Debian system CA package in the same test container made the real request/cancel succeed; the Dockerfile now includes it permanently. The old immutable image fails the new CA gate, while the rebuilt image passes.
3. **Dark-theme guidance contrast:** actual rendered helper text was 3.65:1. Reused the existing semantic muted-foreground token; the verified ratios are 6.77:1 dark and 4.74:1 light. No global theme redesign was introduced.

## Final image and logs

- Runtime source: `7cac52af9de270b8bbda7f5aed04cb2d9dc40103`
- Image: `sha256:f3255804e431bc9e3dd0151f46cfd47da89434be1a5fc23a7752f61d85c9a915`
- Platform/runtime: Linux arm64, Node v22.23.2, Codex 0.153.4, non-root UID 1000.
- Final Docker report: `web/output/container-acceptance/20260909t020217242z-ce7d62ea62bc4959/report.json` — passed, eight checks passed, cleaned, not retained.
- Old-image negative CA gate: `web/output/container-acceptance/20260909t015441053z-caca47686bb704bd/report.json` — correctly rejected missing system CA, cleaned.
- Full tests/typecheck: `web/output/device-goal-ca-tests.log`.
- Browser/HTTP/wire evidence: `web/output/device-goal-e2e/`, including `http-isolation-result.json`, `wire-audit.json`, light/dark contrast logs and `mobile-english.png`.
- Fresh-image real native probe: `native-fresh-image-result.json` — official code returned, cancellation completed, account remained unconnected, temporary home removed. Real codes and raw auth diagnostics were not logged.

The test peer is guarded by an explicit test-only environment variable and is not installed in the production image PATH. Browser requests were not intercepted to fabricate application API responses in the full-stack audit. Only the separate provider peer was simulated for success/failure UI testing.

## Cleanup confirmation

The owned HTTPS proxy/browser were closed; the dedicated full-stack container and its labeled data volume were removed and rechecked. The fresh native probe container was automatically removed. Its temporary home and the local test TLS private key were deleted. The task-specific Lima VM is stopped. No production instance, user data volume, global Docker context or existing Codex credential store was changed.
