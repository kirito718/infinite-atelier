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

test("task store can fail from upload and submission stages", () => {
    const store = createComfyUiTaskStore({ ttlMs: 1000, clock: () => 0 });
    const uploading = store.create({ workflowId: "portrait-pose-depth" });
    store.update(uploading.taskId, { status: "uploading" });
    assert.equal(store.update(uploading.taskId, { status: "failed", error: { code: "UPLOAD_FAILED", message: "failed", retryable: true } }).status, "failed");

    const submitted = store.create({ workflowId: "portrait-pose-depth" });
    store.update(submitted.taskId, { status: "uploading" });
    store.update(submitted.taskId, { status: "submitted", promptId: "prompt-2" });
    assert.equal(store.update(submitted.taskId, { status: "failed", error: { code: "QUEUE_FAILED", message: "failed", retryable: true } }).status, "failed");
    store.close();
});

test("task store validates output before committing succeeded", () => {
    const store = createComfyUiTaskStore({ ttlMs: 1000, clock: () => 0 });
    const task = store.create({ workflowId: "portrait-pose-depth" });
    store.update(task.taskId, { status: "uploading" });
    assert.throws(() => store.update(task.taskId, { status: "succeeded", output: { bytes: "not-bytes", mimeType: "image/png" } }), /output|binary|bytes/i);
    assert.equal(store.get(task.taskId).status, "uploading");
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

test("HTTP API rejects oversized or mismatched control dimensions before upload", async () => {
    const fake = createFakeClient();
    const api = createTestApi(fake, {
        parseMultipart: async () => ({
            fields: { workflowId: "portrait-pose-depth", prompt: "portrait", shotId: "shot-1", frame: "0", width: "2", height: "2" },
            files: { pose: imagePart({ width: 8193, height: 1 }), depth: imagePart({ width: 2, height: 2 }) },
        }),
    });
    const server = await listen(api);
    try {
        const response = await server.request("/api/comfyui/jobs", { method: "POST" });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, "INPUT_INVALID");
        assert.equal(fake.calls.filter((call) => call.method === "uploadImage").length, 0);
    } finally {
        await server.close();
    }
});

test("HTTP API rejects source dimensions that differ from the requested output", async () => {
    const fake = createFakeClient();
    const api = createTestApi(fake, {
        parseMultipart: async () => ({
            fields: { workflowId: "portrait-pose-depth", prompt: "portrait", shotId: "shot-1", frame: "0", width: "2", height: "2" },
            files: { pose: imagePart({ width: 1, height: 1 }), depth: imagePart({ width: 2, height: 2 }) },
        }),
    });
    const server = await listen(api);
    try {
        const response = await server.request("/api/comfyui/jobs", { method: "POST" });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, "INPUT_DIMENSIONS_MISMATCH");
        assert.equal(fake.calls.filter((call) => call.method === "uploadImage").length, 0);
    } finally {
        await server.close();
    }
});

test("HTTP API marks upload failures terminal instead of leaving a task uploading", async () => {
    const fake = createFakeClient({
        uploadImage: async () => {
            throw Object.assign(new Error("upload failed"), { code: "COMFYUI_UPLOAD_FAILED" });
        },
    });
    const api = createTestApi(fake);
    const server = await listen(api);
    try {
        const created = await server.request("/api/comfyui/jobs", { method: "POST", headers: { "idempotency-key": "upload-failure" } });
        const body = await created.json();
        const failed = await waitForStatus(server.request, body.taskId, "failed");
        assert.equal(failed.error.code, "UPLOAD_FAILED");
    } finally {
        await server.close();
    }
});

test("HTTP API marks queue failures terminal after uploads", async () => {
    const fake = createFakeClient({
        queuePrompt: async () => {
            throw Object.assign(new Error("queue failed"), { code: "COMFYUI_QUEUE_FAILED" });
        },
    });
    const api = createTestApi(fake);
    const server = await listen(api);
    try {
        const created = await server.request("/api/comfyui/jobs", { method: "POST", headers: { "idempotency-key": "queue-failure" } });
        const body = await created.json();
        const failed = await waitForStatus(server.request, body.taskId, "failed");
        assert.equal(failed.error.code, "QUEUE_FAILED");
    } finally {
        await server.close();
    }
});

test("HTTP API turns a getOutput timeout into a terminal output failure and expires it", async () => {
    const fake = createFakeClient({
        getOutput: async () => {
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        },
    });
    const api = createTestApi(fake, { ttlMs: 25 });
    const server = await listen(api);
    try {
        const created = await server.request("/api/comfyui/jobs", { method: "POST", headers: { "idempotency-key": "output-timeout" } });
        const body = await created.json();
        const failed = await waitForStatus(server.request, body.taskId, "failed");
        assert.equal(failed.error.code, "OUTPUT_FAILED");
        assert.equal(failed.error.retryable, true);
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal((await server.request(`/api/comfyui/jobs/${body.taskId}`)).status, 404);
    } finally {
        await server.close();
    }
});

test("HTTP API rejects an overlong idempotency key", async () => {
    const fake = createFakeClient();
    const api = createTestApi(fake);
    const server = await listen(api);
    try {
        const response = await server.request("/api/comfyui/jobs", { method: "POST", headers: { "idempotency-key": "k".repeat(257) } });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, "TASK_KEY_INVALID");
    } finally {
        await server.close();
    }
});

test("HTTP API rejects a changed payload under the same idempotency key", async () => {
    const fake = createFakeClient();
    let prompt = "portrait";
    const api = createTestApi(fake, {
        parseMultipart: async () => ({
            fields: { workflowId: "portrait-pose-depth", prompt, shotId: "shot-1", frame: "0", width: "1", height: "1" },
            files: { pose: imagePart(), depth: imagePart() },
        }),
    });
    const server = await listen(api);
    try {
        const first = await server.request("/api/comfyui/jobs", { method: "POST", headers: { "idempotency-key": "fingerprint-key" } });
        assert.equal(first.status, 202);
        prompt = "different prompt";
        const conflict = await server.request("/api/comfyui/jobs", { method: "POST", headers: { "idempotency-key": "fingerprint-key" } });
        assert.equal(conflict.status, 409);
        assert.equal((await conflict.json()).error.code, "TASK_IDEMPOTENCY_CONFLICT");
    } finally {
        await server.close();
    }
});

test("DELETE aborts in-flight control uploads and prevents queue submission", async () => {
    let uploadStarted;
    const started = new Promise((resolve) => {
        uploadStarted = resolve;
    });
    const fake = createFakeClient({
        uploadImage: async ({ signal }) => {
            uploadStarted();
            await new Promise((resolve, reject) => {
                if (signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
            });
        },
    });
    const api = createTestApi(fake);
    const server = await listen(api);
    try {
        const created = await server.request("/api/comfyui/jobs", { method: "POST", headers: { "idempotency-key": "upload-cancel" } });
        const body = await created.json();
        await uploadStarted;
        const cancelled = await server.request(`/api/comfyui/jobs/${body.taskId}`, { method: "DELETE" });
        assert.equal(cancelled.status, 200);
        assert.equal((await cancelled.json()).status, "cancelled");
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(fake.calls.filter((call) => call.method === "queuePrompt").length, 0);
        assert.equal(
            fake.calls.filter((call) => call.method === "uploadImage").every((call) => call.input.signal.aborted),
            true,
        );
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
    const store = createComfyUiTaskStore({ ttlMs: options.ttlMs ?? 10_000 });
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

function createFakeClient({ waiting = Promise.resolve(), uploadImage, queuePrompt, getOutput } = {}) {
    const calls = [];
    return {
        calls,
        async uploadImage(input) {
            calls.push({ method: "uploadImage", input });
            if (uploadImage) return uploadImage(input);
            return { name: input.filename, subfolder: "", type: "input" };
        },
        async queuePrompt(input) {
            calls.push({ method: "queuePrompt", input });
            if (queuePrompt) return queuePrompt(input);
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
            if (getOutput) return getOutput();
            return { bytes: PNG, mimeType: "image/png" };
        },
        async interrupt(promptId) {
            calls.push({ method: "interrupt", promptId });
        },
        async close() {},
    };
}

function imagePart({ width = 1, height = 1 } = {}) {
    const bytes = Buffer.from(PNG);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return { filename: "control.png", mimeType: "image/png", bytes, width, height };
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
