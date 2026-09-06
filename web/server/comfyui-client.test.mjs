import assert from "node:assert/strict";
import test from "node:test";

import { ComfyUiWebSocketError, createComfyUiClient, selectComfyUiOutput } from "./comfyui-client.mjs";

test("uploads a control image as ComfyUI input multipart data", async () => {
    const calls = [];
    const client = createComfyUiClient({
        baseUrl: "http://comfyui.internal:8188",
        apiPrefix: "/api",
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return jsonResponse({ name: "controls/pose.png", subfolder: "director", type: "input" });
        },
        websocketFactory: unavailableWebSocket,
    });

    const result = await client.uploadImage({
        bytes: new Uint8Array([1, 2, 3]),
        filename: "pose.png",
        mimeType: "image/png",
        subfolder: "director",
    });

    assert.deepEqual(result, { name: "controls/pose.png", subfolder: "director", type: "input" });
    assert.equal(calls[0].url, "http://comfyui.internal:8188/api/upload/image");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body.get("type"), "input");
    assert.equal(calls[0].init.body.get("subfolder"), "director");
    const uploaded = calls[0].init.body.get("image");
    assert.equal(uploaded.name, "pose.png");
    assert.equal(uploaded.type, "image/png");
    assert.deepEqual(new Uint8Array(await uploaded.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test("combines caller abort with the request timeout for uploads", async () => {
    const caller = new AbortController();
    let capturedSignal;
    const client = createComfyUiClient({
        baseUrl: "http://comfyui.internal:8188",
        timeoutMs: 10,
        fetchImpl: (_url, init) =>
            new Promise((resolve, reject) => {
                capturedSignal = init.signal;
                if (capturedSignal.aborted) reject(capturedSignal.reason);
                else capturedSignal.addEventListener("abort", () => reject(capturedSignal.reason), { once: true });
            }),
        websocketFactory: unavailableWebSocket,
    });

    const pending = client.uploadImage({ bytes: new Uint8Array([1]), filename: "pose.png", mimeType: "image/png", signal: caller.signal }).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const timedOut = capturedSignal?.aborted === true;
    if (!timedOut) caller.abort();
    assert.equal(timedOut, true);
    assert.equal((await pending).code, "COMFYUI_UNAVAILABLE");
});

test("caller abort still cancels a request before its timeout", async () => {
    const controller = new AbortController();
    let capturedSignal;
    const client = createComfyUiClient({
        baseUrl: "http://comfyui.internal:8188",
        timeoutMs: 1_000,
        fetchImpl: (_url, init) =>
            new Promise((resolve, reject) => {
                capturedSignal = init.signal;
                if (capturedSignal.aborted) reject(capturedSignal.reason);
                else capturedSignal.addEventListener("abort", () => reject(capturedSignal.reason), { once: true });
            }),
        websocketFactory: unavailableWebSocket,
    });

    const pending = client.uploadImage({ bytes: new Uint8Array([1]), filename: "pose.png", mimeType: "image/png", signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.code === "COMFYUI_UNAVAILABLE");
    assert.equal(capturedSignal?.aborted, true);
});

test("queues a prompt with request-scoped client and prompt identifiers", async () => {
    const calls = [];
    const client = createComfyUiClient({
        baseUrl: "https://comfyui.internal",
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return jsonResponse({ prompt_id: "server-prompt", number: 8, node_errors: {} });
        },
        websocketFactory: unavailableWebSocket,
    });

    const result = await client.queuePrompt({ prompt: { 3: { class_type: "KSampler", inputs: {} } }, clientId: "client-1", promptId: "prompt-1" });

    assert.deepEqual(result, { prompt_id: "server-prompt", number: 8, node_errors: {} });
    assert.equal(calls[0].url, "https://comfyui.internal/prompt");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
        prompt: { 3: { class_type: "KSampler", inputs: {} } },
        client_id: "client-1",
        prompt_id: "prompt-1",
    });
    assert.deepEqual(calls[0].init.headers, { "content-type": "application/json" });
});

test("resolves completion only for its prompt and exposes ComfyUI progress", async () => {
    const socket = new WebSocketDouble();
    let websocketUrl;
    const progress = [];
    const client = createComfyUiClient({
        baseUrl: "http://comfyui.internal:8188",
        apiPrefix: "/api",
        fetchImpl: unavailableFetch,
        websocketFactory: (url) => {
            websocketUrl = url;
            return socket;
        },
    });

    const waiting = client.waitForCompletion({ clientId: "client-1", promptId: "prompt-1", onProgress: (value) => progress.push(value) });
    socket.emit("message", { type: "progress", data: { prompt_id: "prompt-1", node: "18", value: 6, max: 12 } });
    socket.emit("message", { type: "executing", data: { prompt_id: "other-prompt", node: null } });
    socket.emit("message", { type: "executing", data: { prompt_id: "prompt-1", node: null } });

    await waiting;
    assert.equal(websocketUrl, "ws://comfyui.internal:8188/api/ws?clientId=client-1");
    assert.deepEqual(progress, [{ nodeId: "18", step: 6, max: 12, percent: 50 }]);
});

test("reports a controlled error when WebSocket progress disconnects", async () => {
    const socket = new WebSocketDouble();
    const client = createComfyUiClient({
        baseUrl: "http://comfyui.internal:8188",
        fetchImpl: unavailableFetch,
        websocketFactory: () => socket,
    });

    const waiting = client.waitForCompletion({ clientId: "client-1", promptId: "prompt-1" });
    socket.emit("close", { code: 1006 });

    await assert.rejects(waiting, (error) => error instanceof ComfyUiWebSocketError && error.code === "COMFYUI_WEBSOCKET_DISCONNECTED");
});

test("retrieves history, selects the declared output, and downloads its bytes", async () => {
    const calls = [];
    const png = new Uint8Array([137, 80, 78, 71]);
    const client = createComfyUiClient({
        baseUrl: "http://comfyui.internal:8188",
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            if (url.includes("/history/")) {
                return jsonResponse({
                    "prompt-1": {
                        outputs: {
                            21: { images: [{ filename: "final.png", subfolder: "director", type: "output" }] },
                        },
                    },
                });
            }
            return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
        },
        websocketFactory: unavailableWebSocket,
    });

    const history = await client.getHistory("prompt-1");
    const output = selectComfyUiOutput(history, { promptId: "prompt-1", outputNode: "21" });
    const artifact = await client.getOutput(output);

    assert.deepEqual(output, { filename: "final.png", subfolder: "director", type: "output" });
    assert.deepEqual(artifact, { bytes: Buffer.from(png), mimeType: "image/png" });
    assert.equal(calls[0].url, "http://comfyui.internal:8188/history/prompt-1");
    assert.equal(calls[1].url, "http://comfyui.internal:8188/view?filename=final.png&subfolder=director&type=output");
});

test("sends a job-scoped cancel request with the configured API prefix", async () => {
    const calls = [];
    const client = createComfyUiClient({
        baseUrl: "http://comfyui.internal:8188",
        apiPrefix: "/api",
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return new Response(null, { status: 204 });
        },
        websocketFactory: unavailableWebSocket,
    });

    await client.interrupt("prompt-1");

    assert.equal(calls[0].url, "http://comfyui.internal:8188/api/jobs/prompt-1/cancel");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, undefined);
});

test("reports that job-scoped cancellation is unsupported instead of falling back to legacy interrupt", async () => {
    const calls = [];
    const client = createComfyUiClient({
        baseUrl: "http://comfyui.internal:8188",
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return new Response("not found", { status: 404 });
        },
        websocketFactory: unavailableWebSocket,
    });

    await assert.rejects(client.interrupt("prompt-1"), (error) => error.code === "COMFYUI_TARGETED_CANCEL_UNSUPPORTED");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://comfyui.internal:8188/jobs/prompt-1/cancel");
});

test("reports a clear capability error when the default WebSocket implementation is unavailable", async () => {
    const originalWebSocket = globalThis.WebSocket;
    try {
        globalThis.WebSocket = undefined;
        const client = createComfyUiClient({ baseUrl: "http://comfyui.internal:8188", fetchImpl: unavailableFetch });

        await assert.rejects(client.waitForCompletion({ clientId: "client-1", promptId: "prompt-1" }), (error) => error instanceof ComfyUiWebSocketError && error.code === "COMFYUI_WEBSOCKET_UNAVAILABLE");
    } finally {
        globalThis.WebSocket = originalWebSocket;
    }
});

class WebSocketDouble {
    #listeners = new Map();

    addEventListener(type, listener) {
        const listeners = this.#listeners.get(type) || [];
        listeners.push(listener);
        this.#listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
        this.#listeners.set(
            type,
            (this.#listeners.get(type) || []).filter((candidate) => candidate !== listener),
        );
    }

    emit(type, payload) {
        const event = type === "message" ? { data: JSON.stringify(payload) } : payload;
        for (const listener of this.#listeners.get(type) || []) listener(event);
    }
}

function jsonResponse(value) {
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function unavailableFetch() {
    throw new Error("fetch should not be called");
}

function unavailableWebSocket() {
    throw new Error("WebSocket should not be created");
}
