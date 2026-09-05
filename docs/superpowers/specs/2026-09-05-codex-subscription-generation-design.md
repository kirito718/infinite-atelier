# Codex Subscription Image Generation Design

## Goal

Add a local-only Codex subscription channel to Infinite Atelier. It lets the user log in to ChatGPT through Codex, generate or edit images from an image node, and places results back on the current canvas and in the local asset library.

Video generation remains on the existing configured provider channel. It must never be represented as being covered by the Codex subscription.

## Product boundary

The app remains a browser-local creative workspace. Its React frontend never receives, stores, logs, or exports a ChatGPT access token. A small local bridge process is the only component allowed to speak to Codex App Server, and it binds to loopback only.

The integration has two visible modes:

| Mode | Image generation | Video generation | Billing / credentials |
| --- | --- | --- | --- |
| Codex subscription | Codex `$imagegen` | Disabled in this channel | User completes ChatGPT login; consumption follows their Codex limits |
| Existing provider | Existing image API | Existing video API | Existing API key and provider billing |

The image node's selected channel determines which mode runs. A Codex-selected image node never falls back silently to an API-key channel. A video node cannot select the Codex channel.

## Architecture

```text
React canvas (localhost:3000)
  │ HTTP + server-sent task events, loopback only
  ▼
Atelier local bridge (127.0.0.1, random port and per-launch capability secret)
  │ JSON-RPC over stdio
  ▼
Codex App Server
  │ managed ChatGPT OAuth and subscription limits
  ▼
Codex image-generation skill ($imagegen)
```

### Local bridge

Add a Node-based bridge under `web/local-bridge/`, started by a new local development command alongside Vite. It starts `codex app-server` with the documented stdio transport and acts as its sole client. It owns temporary reference-image files and generated result files until the frontend imports the returned result into the existing browser asset storage.

The bridge exposes only loopback endpoints. On each launch it generates an unguessable capability secret, returns it to Vite through the local launcher, and requires it on every frontend request. It must reject non-loopback `Origin` values. There is no remote mode, LAN binding, reverse proxy, or persisted subscription credential in this release.

### Codex adapter

The bridge has one narrow adapter interface:

```ts
type CodexImageRequest = {
  prompt: string;
  references: Array<{ path: string; mimeType: string }>;
  operation: "generate" | "edit";
};

type CodexImageResult = {
  taskId: string;
  files: Array<{ path: string; mimeType: string }>;
};
```

It starts a Codex thread/turn using the local authenticated account and an explicit `$imagegen` instruction. Reference images are passed as local-image inputs. The implementation obtains the exact protocol types from the installed `codex app-server generate-ts` output rather than pinning an undocumented JSON event shape in source.

The adapter maps three user-facing task states: `queued`, `generating`, and terminal `succeeded` or `failed`. Successful local files are served once to the requesting page, converted by the existing `uploadMediaFile` path, and then cleared from bridge temporary storage. Failed jobs retain only a short, redacted diagnostic message.

### Frontend

Add a `Codex subscription` image channel in configuration, shown separately from API-key channels. Its setup panel has:

1. `Connect ChatGPT` — asks the bridge to begin the official login flow and opens the returned authorization URL.
2. An account-state badge — disconnected, connecting, connected, or usage unavailable.
3. `Disconnect` — clears the bridge's Codex login through App Server; it does not touch existing provider keys.

In the canvas, an image node selected for the Codex channel uses the bridge task API. Its existing loading, retry, cancellation, output-node, and asset-import behaviours are reused. A reference image leads to the `edit` operation; no reference is `generate`.

Video nodes retain the current `requestVideoGeneration` path and exclude Codex from the model picker. The UI copy says that video requires a configured video provider.

## Data and safety rules

- ChatGPT OAuth tokens remain in Codex-managed local credential storage; the bridge and browser do not serialize them.
- API keys already saved in browser configuration are not sent to Codex.
- Temporary files are created in a bridge-specific directory with restrictive permissions, associated to one task, and removed after import, cancellation, or a bounded expiry.
- The bridge accepts a maximum number and size of references matching the existing image-node limits. It rejects paths outside its temporary directory.
- Every generation is user-initiated from the canvas. There is no automatic generation, background retry, or external sharing.

## Failure handling

| Condition | Behaviour |
| --- | --- |
| Codex CLI/App Server unavailable | Show a setup action and keep provider channels usable. |
| Login cancelled or expires | Mark only the Codex channel disconnected; preserve the canvas node and prompt. |
| Subscription limit or image skill unavailable | Show the returned status in the node and offer retry after the user resolves it. Do not fall back to an API key. |
| Reference transfer or generated-file import fails | Mark the node failed with a retry action; clear temporary files. |
| Video requested through Codex | Prevent selection and direct the user to configure a video provider. |
| Bridge stopped during a task | Mark active Codex tasks failed after connection loss; later generations require an explicit retry. |

## Verification

1. Unit-test the bridge's origin/capability enforcement, task state mapping, temporary-file cleanup, and error redaction using a mocked Codex adapter.
2. Unit-test the frontend channel selector: Codex is valid for image nodes and absent for video nodes.
3. Run TypeScript checks and production build for both the frontend and bridge.
4. Manual local smoke test: connect ChatGPT, create one image node, generate an image, confirm it appears on the canvas and in assets, and confirm browser storage contains no OAuth token.
5. Manual negative checks: cancel login, stop the bridge mid-task, attempt a video node with Codex selected, and confirm none silently use an API key.

## Non-goals

- No hosted service, shared account, team account pooling, or remote App Server access.
- No claim that Codex subscription covers video generation.
- No automatic prompt planning, batch campaigns, brand-kit features, or model routing in this release.
- No modification to existing provider APIs or migration of current API keys.
