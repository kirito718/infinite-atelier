# Remote ChatGPT login repair

## Problem and evidence

Web login currently requests `account/login/start` with `type: chatgpt`. Its OAuth redirect uses the Codex host's localhost callback, which is not the browser's machine in a remote Docker deployment. Changing that URL to the public app hostname is not a valid OAuth fix.

Official documentation fetched on 2026-09-09:
- https://learn.chatgpt.com/docs/auth — recommends device-code auth for headless/remote environments; users or workspace admins may need to enable it.
- https://learn.chatgpt.com/docs/app-server — managed `chatgptDeviceCode` login, completion notification, and cancellation by `loginId`.

The installed **Codex 0.153.4**, matching the Docker pin, was checked using offline `app-server generate-json-schema` with an empty temporary CODEX_HOME. It supports the documented device-code request and response. No real OAuth login was initiated.

## Design

- All web/bridge login starts use `{type: "chatgptDeviceCode"}`. Do not fall back to loopback browser OAuth.
- Return only `{type: "chatgptDeviceCode", loginId, verificationUrl, userCode}`. Validate the official HTTPS verification URL and bounded nonempty strings; never return tokens or persist the code in browser storage/configuration.
- The web UI displays the code, a manual-copy option, and an explicit new-tab link to the official verification page. It explains device-code opt-in and polls the existing account status to detect success/failure.
- A pending attempt reports `connecting`, not `disconnected`. Repeated starts reuse the same pending attempt. Completion/cancellation is scoped to its login ID; stale notifications must not re-authenticate a logged-out client.
- Add same-origin authenticated `POST /api/codex-subscription/v1/login/cancel` with JSON `{loginId}`. Cancel only that attempt; canceling an absent/stale ID is a no-op. Logout cancels outstanding login before removing credentials.
- Device codes are UI/component memory only. Account changes and closed UI invalidate late callbacks; reopening can request the same pending code again.
- Keep the per-user CODEX_HOME, the current CLI version, generation APIs, cookie/CSRF protection and all existing storage behavior unchanged. No callback port exposure, token pasting, global credential reuse, or public URL rewriting.

## Acceptance

Protocol, HTTP, client/UI and account-isolation regressions pass; typecheck and production build pass. Browser smoke verifies the device-code UI with deterministic fake transport only. Real ChatGPT account authorization remains a user action, not an automated test.
