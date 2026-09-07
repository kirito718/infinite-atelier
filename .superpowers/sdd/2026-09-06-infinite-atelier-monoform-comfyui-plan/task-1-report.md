# Task 1 report

## Status

Complete. Added the versioned MONOFORM bridge envelope, capture contracts, ComfyUI browser job contracts, and pure runtime validation helpers.

## Files

- `web/src/types/director.ts`
- `web/src/types/comfyui.ts`
- `web/src/lib/director-message.ts`
- `web/src/lib/director-message.test.ts`

The validator accepts only the supported protocol/version, source, message type, field shapes, and iframe origin/source pairing. Blob contents are never inspected; only the runtime Blob type is checked for capture passes.

## Tests and commands

- `npm run test:unit -- src/lib/director-message.test.ts` (initially failed because `director-message` did not exist; final: 1 file passed, 4 tests passed)
- `npm run typecheck` (passed)
- `git diff --check` (passed)

## Self-review

- Existing image/video export messages are unaffected; the new parser supports both the short and namespaced ready/control-result/error message spellings described by the specification.
- Origin and iframe-window checks are explicit and require an exact expected origin.
- No network, filesystem, or blob-content work is performed by the pure validators.
- Unknown fields and malformed optional payloads are rejected.

## Concerns

The ComfyUI job contracts intentionally leave `workflowId` extensible for future workflow registry entries while retaining `portrait-pose-depth` as the first known workflow. Later tasks should keep server-side validation stricter than the browser-facing type.

## Review fixes

- `isAllowedDirectorEvent` now rejects a null iframe window even when the event source is also null; a regression test covers this confused-deputy case.
- `ComfyUiJobCreate.workflowId` is now constrained to the first-release literal `portrait-pose-depth` instead of widening to `string`.

Verification after fixes:

```text
$ npm run test:unit -- src/lib/director-message.test.ts
Test Files  1 passed (1)
Tests       4 passed (4)

$ npm run typecheck
tsc --noEmit: passed

$ git diff --check
passed
```
