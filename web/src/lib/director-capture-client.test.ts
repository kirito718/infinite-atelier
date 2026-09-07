import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirectorCaptureClient } from "./director-capture-client";

const origin = "http://localhost:3000";
const envelope = { protocol: "atelier-monoform", version: 1, source: "monoform" };
const ready = { ...envelope, type: "monoform:ready", payload: { projectKey: "director-1", capabilities: ["capture-pose", "capture-depth"] } };
const pass = { blob: new Blob(["png"], { type: "image/png" }), mimeType: "image/png", width: 1024, height: 1024 };

function fixture(timeoutMs = 30_000) {
    const frame = { postMessage: vi.fn() } as unknown as Window;
    const onReady = vi.fn();
    const onExport = vi.fn();
    const client = createDirectorCaptureClient({ nodeId: "director-1", getFrameWindow: () => frame, origin, onReady, onExport, timeoutMs });
    const deliver = (data: unknown, overrides = {}) => client.handleMessage({ source: frame, origin, data, ...overrides } as MessageEvent);
    const request = () => vi.mocked(frame.postMessage).mock.calls.at(-1)![0];
    return { client, frame, onReady, onExport, deliver, request };
}

afterEach(() => vi.useRealTimers());

describe("Director capture lifecycle", () => {
    it("captures the current frame with a same-origin request and accepts only its correlated result", async () => {
        const { client, frame, deliver, request } = fixture();
        deliver(ready);
        const result = client.capture();
        const sent = request();
        expect(vi.mocked(frame.postMessage).mock.calls[0][1]).toBe(origin);
        expect(sent.payload).toEqual({ passes: ["pose", "depth"], width: 1024, height: 1024 });
        let completed = false;
        void result.then(() => {
            completed = true;
        });
        const payload = { shotId: "shot-02", frame: 48, pose: pass, depth: pass };
        deliver({ ...envelope, type: "control.result", requestId: "old-request", payload });
        deliver({ ...envelope, type: "error", payload: { code: "CAPTURE_FAILED", message: "unrelated" } });
        await Promise.resolve();
        expect(completed).toBe(false);
        deliver({ ...envelope, type: "control.result", requestId: sent.requestId, payload });
        await expect(result).resolves.toMatchObject({ requestId: sent.requestId, payload: { shotId: "shot-02", frame: 48 } });
        client.dispose();
    });
    it("ignores foreign frames/origins and mismatched project keys, including legacy exports", async () => {
        const { client, deliver, onReady, onExport } = fixture();
        deliver(ready, { origin: "https://evil.example" });
        deliver(ready, { source: {} });
        deliver({ ...ready, payload: { ...ready.payload, projectKey: "other-director" } });
        deliver({ source: "monoform", type: "export", kind: "image", blob: pass.blob }, { source: {} });
        expect(onReady).not.toHaveBeenCalled();
        expect(onExport).not.toHaveBeenCalled();
        await expect(client.capture()).rejects.toMatchObject({ code: "NOT_READY" });
        deliver(ready);
        deliver({ source: "monoform", type: "export", kind: "image", blob: pass.blob });
        expect(onExport).toHaveBeenCalledWith("image", pass.blob);
        client.dispose();
    });
    it("cancels a capture, ignores its late response and allows a new request", async () => {
        const { client, deliver, request } = fixture();
        deliver(ready);
        const first = client.capture();
        const oldId = request().requestId;
        const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
        client.cancel();
        await cancelled;
        const second = client.capture();
        const newId = request().requestId;
        expect(newId).not.toBe(oldId);
        deliver({ ...envelope, type: "control.result", requestId: oldId, payload: { shotId: "shot-1", frame: 0, pose: pass, depth: pass } });
        deliver({ ...envelope, type: "control.result", requestId: newId, payload: { shotId: "shot-1", frame: 12, pose: pass, depth: pass } });
        await expect(second).resolves.toMatchObject({ payload: { frame: 12 } });
        client.dispose();
    });
    it("times out silent iframes and rejects mismatched output sizes without wedging retry", async () => {
        vi.useFakeTimers();
        const { client, deliver, request } = fixture(10);
        deliver(ready);
        const timeout = expect(client.capture()).rejects.toMatchObject({ code: "CAPTURE_TIMEOUT" });
        await vi.advanceTimersByTimeAsync(10);
        await timeout;
        const retry = client.capture();
        const invalid = expect(retry).rejects.toMatchObject({ code: "CAPTURE_INVALID" });
        deliver({ ...envelope, type: "control.result", requestId: request().requestId, payload: { shotId: "shot-1", frame: 0, pose: pass, depth: { ...pass, width: 512 } } });
        await invalid;
        client.dispose();
        expect(vi.getTimerCount()).toBe(0);
    });
    it("rejects duplicate capture and disposes an in-flight request", async () => {
        const { client, deliver } = fixture();
        deliver(ready);
        const first = client.capture();
        const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
        await expect(client.capture()).rejects.toMatchObject({ code: "CAPTURE_IN_PROGRESS" });
        client.dispose();
        await rejected;
        await expect(client.capture()).rejects.toMatchObject({ code: "NOT_READY" });
    });
});
