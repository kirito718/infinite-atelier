# Remote Codex device-code login verification — initial 2026-09-09 pass

The stronger follow-up audit and final status are in [the completion audit](2026-09-09-device-login-final-audit.md). Counts and limitations below describe the initial pass, not the final image.

## Scope

Repair browser-initiated ChatGPT authentication against a remote Docker host. The old browser OAuth flow used a localhost callback on the Codex host, which a browser on another machine cannot reach. The replacement uses managed device-code authentication, not callback URL rewriting or an exposed callback port.

Branch: `fix/codex-device-login`, based on `main` at `2903c86`.

## Protocol evidence

- Official pages fetched: https://learn.chatgpt.com/docs/auth and https://learn.chatgpt.com/docs/app-server.
- Local `codex --version`: **0.153.4**, matching the existing Docker pin.
- `codex app-server generate-json-schema` ran with a fresh empty temporary CODEX_HOME. The generated schema confirms `chatgptDeviceCode`, `loginId`, `verificationUrl`, `userCode`, and cancellation by login ID.
- No real device authorization request, OAuth login, user auth-cache read/copy, or paid generation was performed.

## Automated checks

| Check | Result |
| --- | --- |
| Frontend Vitest | 257 passed |
| Server/bridge node:test | 137 passed |
| MONOFORM node:test | 88 passed |
| Container helper node:test | 26 passed |
| Total `npm test` | **508 passed, 0 failed** |
| `npm run typecheck` | Passed |
| `npm run build:all` | Passed (application and embedded studio) |
| `git diff --check` | Passed |

Coverage includes official-URL validation, rejection of legacy/loopback login responses, selected response fields/no tokens, non-cacheable responses, account/CSRF/stale-identity checks, independent user runtimes, pending-code reuse, early and stale notifications, cancellation/logout ordering, invalid ID boundaries, delayed polling and clipboard work, and UI/account changes.

Two lifecycle issues found during independent review were reproduced before repair and verified afterwards:

1. A login call already waiting for logout could cross a later close; it now captures its lifecycle before awaiting logout.
2. Buffered stdout from a disconnected process could override a replacement account read; transport callbacks now belong to their captured child/readline and are disposed on disconnect.

The reviewer independently reran both new regression tests and confirmed the reported issues closed.

## Browser smoke

Used the production build on an isolated loopback preview with a temporary application account/database. Its PATH could not resolve a Codex executable. Browser routing supplied only deterministic fake verification data; no official authorization page was opened or completed.

Verified:

- The device-code input, opt-in instructions and exact official verification link render correctly.
- No automatic OAuth popup is opened; the link has `noopener noreferrer` and contains no code.
- Clipboard UI succeeds; localStorage/sessionStorage contain no device code.
- Closing and reopening the drawer lets the user recover the same pending code.
- Canceling removes that code; retry creates a new one.
- A simulated completion changes the UI to connected and clears the code.
- All intercepted application Codex requests carry the account binding and CSRF marker.

Local ignored evidence: `web/output/playwright/codex-device-code.png`, `codex-device-lifecycle-qa.log`; test/build logs are under `web/output/codex-device-*.log`.

## Boundaries and rollout

Real user authorization must be completed by the user on OpenAI's official page. Device-code login may need enabling in ChatGPT security settings or workspace permissions. Server outbound connectivity/account eligibility was not validated against a real authorization request.

This repair does not publish or deploy the application. A Docker image containing the matching frontend/backend must be built and rolled out before an existing deployment receives it. Preserve the data volume and the existing correct ATELIER_PUBLIC_URL setting.
