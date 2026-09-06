import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";

import { createCodexSubscriptionApi } from "./codex-subscription-api.mjs";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("same-origin Codex API exposes status without a bridge secret", async () => {
    await withApi({ status: "connected" }, async ({ request }) => {
        const response = await request("/api/codex-subscription/v1/status");

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: "connected" });
    });
});

test("same-origin Codex API accepts a generated image task and serves its artifact", async () => {
    await withApi(
        {
            status: "connected",
            async generateImage() {
                return { files: [{ bytes: PNG_BYTES, mimeType: "image/png", name: "result.png" }] };
            },
        },
        async ({ request }) => {
            const created = await request("/api/codex-subscription/v1/images", {
                method: "POST",
                body: JSON.stringify({ operation: "generate", prompt: "A copper fox", references: [] }),
            });
            assert.equal(created.status, 202);
            const { taskId } = await created.json();
            const task = await waitForTask(request, taskId, "succeeded");
            assert.match(task.files[0].url, new RegExp(`^/api/codex-subscription/v1/images/${taskId}/files/`));
            const artifact = await request(`/api/codex-subscription/v1/images/${taskId}/files/${task.files[0].fileId}`);

            assert.equal(artifact.status, 200);
            assert.equal(artifact.headers.get("content-type"), "image/png");
            assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), PNG_BYTES);
        },
    );
});

test("same-origin Codex API still accepts the mounted request path after middleware stripping", async () => {
    await withApi({ status: "connected" }, async ({ request }) => {
        const response = await request("/v1/status");

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: "connected" });
    });
});

test("same-origin Codex API starts OAuth and logs out without returning credentials", async () => {
    await withApi(
        {
            status: "disconnected",
            async login() {
                return { authUrl: "https://chatgpt.com/auth/test" };
            },
            async logout() {},
        },
        async ({ request }) => {
            const login = await request("/api/codex-subscription/v1/login", { method: "POST", body: "{}" });
            assert.equal(login.status, 200);
            assert.deepEqual(await login.json(), { authUrl: "https://chatgpt.com/auth/test" });

            const logout = await request("/api/codex-subscription/v1/logout", { method: "POST", body: "{}" });
            assert.equal(logout.status, 204);
        },
    );
});

async function withApi(codex, callback) {
    const api = createCodexSubscriptionApi({ codex, cleanupMs: 100 });
    const server = createServer((request, response) => api.handle(request, response));
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const request = (path, options = {}) =>
        fetch(`${baseUrl}${path}`, {
            ...options,
            headers: { "content-type": "application/json", ...options.headers },
        });

    try {
        await callback({ request });
    } finally {
        await api.close();
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
}

async function waitForTask(request, taskId, expectedStatus) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const response = await request(`/api/codex-subscription/v1/images/${taskId}`);
        assert.equal(response.status, 200);
        const task = await response.json();
        if (task.status === expectedStatus) return task;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Task ${taskId} did not reach ${expectedStatus}`);
}
