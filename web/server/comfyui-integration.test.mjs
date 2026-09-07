import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createConfiguredComfyUiApi } from "./comfyui-gateway.mjs";
import { fixturePng, startFakeComfyUi } from "../test-support/fake-comfyui.mjs";

async function fixture(options = {}, env = {}) {
    const upstream = await startFakeComfyUi(options);
    const api = createConfiguredComfyUiApi({ env: { COMFYUI_BASE_URL: upstream.baseUrl, COMFYUI_API_PREFIX: "/api", COMFYUI_TASK_TTL_MS: "1000", ...env } });
    const server = createServer((req, res) => void api.handle(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const request = (path, init) => fetch(`http://127.0.0.1:${server.address().port}/api/comfyui${path}`, init);
    return {
        upstream,
        request,
        async close() {
            await api.close();
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
            await upstream.close();
        },
    };
}
function form() {
    const data = new FormData();
    for (const [key, value] of Object.entries({ workflowId: "portrait-pose-depth", prompt: "Integration fixture portrait", shotId: "shot-02", frame: "48", width: "64", height: "64", seed: "42" })) data.set(key, value);
    for (const kind of ["pose", "depth"]) data.set(kind, new Blob([fixturePng()], { type: "image/png" }), `${kind}.png`);
    return data;
}
async function waitFor(request, taskId, state) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const response = await request(`/jobs/${taskId}`);
        const task = await response.json();
        if (task.status === state) return task;
        if (task.status === "failed") assert.fail(`Unexpected failure: ${JSON.stringify(task.error)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Job did not reach ${state}`);
}

test("real HTTP gateway uploads controls, patches the workflow, falls back from WS and serves a scoped PNG", async () => {
    const app = await fixture({ autoComplete: false });
    try {
        const response = await app.request("/jobs", { method: "POST", headers: { "idempotency-key": "integration-request" }, body: form() });
        assert.equal(response.status, 202);
        const created = await response.json();
        const running = await waitFor(app.request, created.taskId, "running");
        for (let attempt = 0; attempt < 50 && !app.upstream.state.websocketAttempts; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(app.upstream.state.websocketAttempts > 0, "the fixture must actually drop a WebSocket connection");
        app.upstream.complete(running.promptId);
        const completed = await waitFor(app.request, created.taskId, "succeeded");
        const duplicate = await (await app.request("/jobs", { method: "POST", headers: { "idempotency-key": "integration-request" }, body: form() })).json();
        assert.equal(duplicate.taskId, created.taskId);
        assert.equal(app.upstream.state.submissions.length, 1);
        assert.equal(app.upstream.state.uploads.length, 2);
        const queued = app.upstream.state.submissions[0];
        assert.equal(queued.prompt_id, completed.promptId);
        assert.equal(queued.prompt["6"].inputs.text, "Integration fixture portrait");
        assert.equal(queued.prompt["8"].inputs.width, 64);
        assert.equal(queued.prompt["18"].inputs.seed, 42);
        assert.match(queued.prompt["12"].inputs.image, /^atelier\/pose-task_/);
        assert.ok(app.upstream.state.historyRequests > 0);
        const output = await app.request(`/jobs/${created.taskId}/output`);
        assert.equal(output.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await output.arrayBuffer()), app.upstream.output);
        assert.equal((await app.request("/jobs/not-this-task/output")).status, 404);
    } finally {
        await app.close();
    }
});

test("HTTP cancellation remains terminal after late history completion and does not use global interrupt", async () => {
    const app = await fixture({ autoComplete: false }, { COMFYUI_WS_ENABLED: "false" });
    try {
        const created = await (await app.request("/jobs", { method: "POST", body: form() })).json();
        const running = await waitFor(app.request, created.taskId, "running");
        assert.equal((await app.request(`/jobs/${created.taskId}`, { method: "DELETE" })).status, 200);
        assert.equal((await app.request(`/jobs/${created.taskId}`, { method: "DELETE" })).status, 200);
        app.upstream.complete(running.promptId);
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal((await (await app.request(`/jobs/${created.taskId}`)).json()).status, "cancelled");
        assert.equal((await app.request(`/jobs/${created.taskId}/output`)).status, 404);
        assert.deepEqual(app.upstream.state.cancellations, [running.promptId]);
        assert.equal(app.upstream.state.websocketAttempts, 0);
    } finally {
        await app.close();
    }
});

test("HTTP upstream queue validation failures are reported as queue errors, not connectivity outages", async () => {
    const app = await fixture({ rejectQueue: true });
    try {
        const created = await (await app.request("/jobs", { method: "POST", body: form() })).json();
        const failed = await waitFor(app.request, created.taskId, "failed");
        assert.equal(failed.error.code, "QUEUE_FAILED");
        assert.match(failed.error.message, /checkpoint/);
    } finally {
        await app.close();
    }
});
