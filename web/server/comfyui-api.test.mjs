import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createComfyUiApi } from "./comfyui-api.mjs";
import { createComfyUiTaskStore } from "./comfyui-task-store.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082", "hex");

test("task store permits the documented lifecycle and rejects skipped transitions", () => {
    const store = createComfyUiTaskStore({ ttlMs: 1000, clock: () => 0 });
    const task = store.create({ requestKey: "request-1", workflowId: "portrait-pose-depth" });

    assert.equal(task.status, "queued");
    assert.equal(store.update(task.taskId, { status: "uploading" }).status, "uploading");
    assert.equal(store.update(task.taskId, { status: "submitted", promptId: "prompt-1" }).status, "submitted");
    assert.equal(store.update(task.taskId, { status: "running", progress: { percent: 25 } }).status, "running");
    assert.equal(store.update(task.taskId, { status: "succeeded", output: { bytes: PNG, mimeType: "image/png" } }).status, "succeeded");
    assert.throws(() => store.update(task.taskId, { status: "queued" }), /already succeeded|invalid task transition/i);
    store.close();
});

test("task store reuses a request key and expires terminal output after its TTL", () => {
    let now = 10;
    const store = createComfyUiTaskStore({ ttlMs: 100, clock: () => now });
    const first = store.create({ requestKey: "same-request", workflowId: "portrait-pose-depth" });
    const duplicate = store.create({ requestKey: "same-request", workflowId: "portrait-pose-depth" });

    assert.equal(duplicate.taskId, first.taskId);
    store.update(first.taskId, { status: "uploading" });
    store.update(first.taskId, { status: "submitted" });
    store.update(first.taskId, { status: "running" });
    store.update(first.taskId, { status: "succeeded", output: { bytes: PNG, mimeType: "image/png" } });
    assert.equal(store.get(first.taskId).output.mimeType, "image/png");

    now = 111;
    assert.equal(store.get(first.taskId), undefined);
    assert.notEqual(store.create({ requestKey: "same-request", workflowId: "portrait-pose-depth" }).taskId, first.taskId);
    store.close();
});

test("task store cancellation is idempotent and blocks late updates", () => {
    const store = createComfyUiTaskStore({ ttlMs: 1000, clock: () => 0 });
    const task = store.create({ requestKey: "cancel-me", workflowId: "portrait-pose-depth" });
    store.update(task.taskId, { status: "uploading" });

    const cancelled = store.cancel(task.taskId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(store.cancel(task.taskId).status, "cancelled");
    assert.throws(() => store.update(task.taskId, { status: "succeeded", output: { bytes: PNG, mimeType: "image/png" } }), /cancelled/i);
    store.close();
});

test("HTTP API creates a job, reports progress, and serves only its own output", async () => {
    const fake = createFakeClient();
    const api = createTestApi(fake);
    const server = await listen(api);
    try {
        const created = await server.request("/api/comfyui/jobs", { method: "POST", headers: { "idempotency-key": "http-request" } });
        assert.equal(created.status, 202);
        const createdBody = await created.json();
        assert.equal(createdBody.status, "queued");

        const status = await waitForStatus(server.request, createdBody.taskId, "succeeded");
        assert.equal(status.status, "succeeded");
        assert.equal(status.output.mimeType, "image/png");
        assert.equal(status.promptId, "prompt-1");

        const output = await server.request(`/api/comfyui/jobs/${createdBody.taskId}/output`);
        assert.equal(output.status, 200);
        assert.equal(output.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await output.arrayBuffer()), PNG);

        const duplicate = await server.request("/api/comfyui/jobs", { method: "POST", headers: { "idempotency-key": "http-request" } });
        assert.equal(duplicate.status, 202);
        assert.equal((await duplicate.json()).taskId, createdBody.taskId);
        assert.equal(fake.calls.filter((call) => call.method === "queuePrompt").length, 1);
    } finally {
        await server.close();
    }
});

test("HTTP API rejects invalid input before contacting ComfyUI", async () => {
    const fake = createFakeClient();
    const api = createTestApi(fake, {
        parseMultipart: async () => ({
            fields: { workflowId: "unknown-workflow", prompt: "portrait", shotId: "shot-1", frame: "0", width: "1", height: "1" },
            files: { pose: imagePart(), depth: imagePart() },
        }),
    });
    const server = await listen(api);
    try {
        const response = await server.request("/api/comfyui/jobs", { method: "POST" });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, "WORKFLOW_INVALID");
        assert.equal(fake.calls.length, 0);
    } finally {
        await server.close();
    }
});

test("DELETE cancels the prompt and ignores a late successful callback", async () => {
    let release;
    const waiting = new Promise((resolve) => {
        release = resolve;
    });
    const fake = createFakeClient({ waiting });
    const api = createTestApi(fake);
    const server = await listen(api);
    try {
        const created = await server.request("/api/comfyui/jobs", { method: "POST", headers: { "idempotency-key": "cancel-request" } });
        const body = await created.json();
        await waitForPromptId(server.request, body.taskId);

        const cancelled = await server.request(`/api/comfyui/jobs/${body.taskId}`, { method: "DELETE" });
        assert.equal(cancelled.status, 200);
        assert.equal((await cancelled.json()).status, "cancelled");
        release();
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal((await server.request(`/api/comfyui/jobs/${body.taskId}`)).status, 200);
        assert.equal((await (await server.request(`/api/comfyui/jobs/${body.taskId}`)).json()).status, "cancelled");
        assert.deepEqual(
            fake.calls.filter((call) => call.method === "interrupt").map((call) => call.promptId),
            ["prompt-1"],
        );
    } finally {
        await server.close();
    }
});

function createTestApi(client, options = {}) {
    const store = createComfyUiTaskStore({ ttlMs: 10_000 });
    const registry = {
        get(workflowId) {
            if (workflowId !== "portrait-pose-depth") throw new Error("unknown workflow");
            return { manifest: { id: workflowId, outputNode: "21" } };
        },
        patch(workflowId, inputs) {
            assert.equal(workflowId, "portrait-pose-depth");
            return { manifest: { id: workflowId, outputNode: "21" }, workflow: { inputs } };
        },
    };
    const parseMultipart =
        options.parseMultipart ??
        (async () => ({
            fields: { workflowId: "portrait-pose-depth", prompt: "portrait", shotId: "shot-1", frame: "0", width: "1", height: "1" },
            files: { pose: imagePart(), depth: imagePart() },
        }));
    return createComfyUiApi({ client, registry, store, parseMultipart, maxBytes: 10 * 1024 * 1024 });
}

function createFakeClient({ waiting = Promise.resolve() } = {}) {
    const calls = [];
    return {
        calls,
        async uploadImage(input) {
            calls.push({ method: "uploadImage", input });
            return { name: input.filename, subfolder: "", type: "input" };
        },
        async queuePrompt(input) {
            calls.push({ method: "queuePrompt", input });
            return { prompt_id: "prompt-1" };
        },
        async waitForCompletion({ onProgress }) {
            calls.push({ method: "waitForCompletion" });
            onProgress?.({ nodeId: "18", step: 1, max: 2, percent: 50 });
            await waiting;
        },
        async getHistory() {
            calls.push({ method: "getHistory" });
            return { "prompt-1": { outputs: { 21: { images: [{ filename: "result.png", type: "output" }] } } } };
        },
        async getOutput() {
            calls.push({ method: "getOutput" });
            return { bytes: PNG, mimeType: "image/png" };
        },
        async interrupt(promptId) {
            calls.push({ method: "interrupt", promptId });
        },
        async close() {},
    };
}

function imagePart() {
    return { filename: "control.png", mimeType: "image/png", bytes: PNG, width: 1, height: 1 };
}

async function listen(api) {
    const httpServer = createServer((request, response) => void api.handle(request, response));
    await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", resolve);
    });
    const { port } = httpServer.address();
    const request = (path, options = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers: { "content-type": "multipart/form-data; boundary=test", ...options.headers } });
    return {
        request,
        close: async () => {
            await api.close();
            await new Promise((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
        },
    };
}

async function waitForStatus(request, taskId, expected) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await request(`/api/comfyui/jobs/${taskId}`);
        assert.equal(response.status, 200);
        const body = await response.json();
        if (body.status === expected) return body;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`task ${taskId} did not reach ${expected}`);
}

async function waitForPromptId(request, taskId) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await request(`/api/comfyui/jobs/${taskId}`);
        assert.equal(response.status, 200);
        const body = await response.json();
        if (body.promptId) return body;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`task ${taskId} did not receive a prompt id`);
}
