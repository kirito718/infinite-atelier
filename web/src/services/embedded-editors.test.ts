import { expect, it } from "vitest";
import { createEmbeddedEditorBridge } from "./embedded-editors";

function browserFixture() {
    const events = new EventTarget();
    const sent: unknown[] = [];
    const frameWindow = { postMessage: (data: unknown) => sent.push(data) };
    const frame = { src: "http://localhost/monoform/index.html", contentWindow: frameWindow };
    const browser = Object.assign(events, { location: { origin: "http://localhost" }, document: { querySelectorAll: () => [frame] } });
    const emit = (data: unknown, origin = "http://localhost", source: unknown = frameWindow) => events.dispatchEvent(Object.assign(new Event("message"), { data, origin, source }));
    return { browser: browser as unknown as Window, emit, sent, frameWindow };
}
it("waits for the matching iframe flush acknowledgement before allowing navigation", async () => {
    const { browser, emit, sent } = browserFixture();
    const bridge = createEmbeddedEditorBridge(browser, () => "alice");
    emit({ type: "atelier:editor-status", userId: "alice", pending: true });
    expect(bridge.hasPending()).toBe(true);
    let finished = false;
    const flushing = bridge.flush().then(() => {
        finished = true;
    });
    const message = sent[0] as { requestId: string };
    expect(finished).toBe(false);
    emit({ type: "atelier:editor-flushed", userId: "alice", requestId: message.requestId, ok: true }, "http://evil.test");
    await Promise.resolve();
    expect(finished).toBe(false);
    emit({ type: "atelier:editor-status", userId: "alice", pending: false });
    emit({ type: "atelier:editor-flushed", userId: "alice", requestId: message.requestId, ok: true });
    await flushing;
    expect(finished).toBe(true);
    bridge.dispose();
});
it("rejects unsafe or wrong-account status messages and surfaces an editor save failure", async () => {
    const { browser, emit, sent } = browserFixture();
    const bridge = createEmbeddedEditorBridge(browser, () => "alice");
    emit({ type: "atelier:editor-status", userId: "bobby", pending: true });
    expect(bridge.hasPending()).toBe(false);
    emit({ type: "atelier:editor-status", userId: "alice", pending: true });
    const flushing = bridge.flush();
    const message = sent[0] as { requestId: string };
    emit({ type: "atelier:editor-flushed", userId: "alice", requestId: message.requestId, ok: false, error: "editor offline" });
    await expect(flushing).rejects.toThrow("导演台");
    expect(bridge.hasPending()).toBe(true);
    bridge.dispose();
});
