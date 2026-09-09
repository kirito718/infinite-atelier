# Authentication and integration UX contract

## Scope and authority

This records the account/Codex flow shared by the existing configuration page and settings overlay. It is not a claim that unrelated canvas, asset, billing or marketing flows have received a new accessibility/design audit.

Sources, in precedence order:

1. User requirement: remote Docker browser login must not depend on a localhost OAuth callback.
2. `docs/superpowers/specs/2026-09-09-codex-device-login-design.md` and the existing accounts-persistence design.
3. Pinned Codex 0.153.4 managed device-code schema and actual server authorization checks.
4. Shared components and verified behavior, not test count alone.

## Canonical UI map

| Capability | Owner | Contract and evidence |
| --- | --- | --- |
| Locale | `web/src/i18n`, `AppProviders` | Chinese/English action and error meanings agree |
| Account form | `account-gate.tsx` | App-owned errors, password-manager/paste support, server-validated credentials |
| Account permission | `account-api.mjs`, `account-client.ts` | HttpOnly session, same-origin writes, original-user binding; UI never substitutes for server authorization |
| Drawer | `channel-editor-drawer.tsx` / Ant Design | Existing modal focus/scroll owner; closing unmounts local login state |
| Button/Input | Ant Design through `AppProviders` | Native semantic actions, accessible field names, read-only code selection |
| Codex login state | `codex-login-controller.ts` | Starting/waiting/connected/cancel/error; stale async work cannot publish into a new view or account |
| Codex RPC auth state | `app-server-client.mjs` | Scoped login ID and transport lifetime; initialization/auth RPC deadlines; no short deadline on user authorization wait or thread/turn RPCs |
| Feedback | `CodexLoginPanel` | Persistent inline status/error/copy feedback; no browser alert/confirm/prompt |
| Data navigation/date/table | Not part of this flow | No new table, selector, pager, CRUD route or date input is introduced |

## Flow ledger

- **Open settings:** read status; do not start an external authorization as a side effect.
- **Connect:** explicitly request a device code; display only a validated official HTTPS link and code. No automatic popup or loopback fallback.
- **Waiting:** poll status without overlapping mutations; allow explicit cancel. Do not invent a code-expiry countdown.
- **Close/reopen:** closing discards local state, not the server authorization. Reopening can explicitly recover the existing pending code.
- **Completion:** only verified current status may show connected; clear the displayed code.
- **Failure/timeout:** show an actionable in-app error and permit retry. A stalled auth RPC is bounded to 60 seconds by default; abort the owned transport and invalidate old queued work. This is not a 60-second limit on entering a device code.
- **Cancel:** cancel only the indicated pending attempt; stale IDs do not cancel a newer one. Do not claim logout from cancel alone.
- **Disconnect:** cancel outstanding authorization before logging out. Do not claim success if the server rejects the operation.
- **Account/session change:** immediately clear local codes, invalidate late results and abort old requests; never display another account's code.

## Security, clipboard and resilience

Codes remain transient memory and are never stored in channel configuration, localStorage/sessionStorage, backups or URL query/fragment state. OAuth credentials remain in each account's private server Codex home. The official link uses `noopener noreferrer`; the user must opt in/authorize on OpenAI's page.

Copy is an explicit user action. A failed clipboard operation leaves the code selectable for manual copying. Codes are not announced or persisted as generic success notifications.

A transport failure may invalidate in-flight work sharing that transport; a disconnected/unresponsive CLI is not evidence that an external operation succeeded. Existing task and data error handling must remain intact.

## Verification scope

Run the current full test suite, typecheck and build. In addition to focused controller/transport tests, verify the production Docker package and real browser → HTTPS proxy → account API → stdio process path. A deterministic test-only peer may emulate the provider boundary; that evidence must never be labeled a real ChatGPT account authorization. Check keyboard access, code/link visibility, desktop/narrow layout, language parity, failure recovery, account isolation and absence of code persistence.
