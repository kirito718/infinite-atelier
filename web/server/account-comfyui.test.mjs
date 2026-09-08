import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountApi } from "./account-api.mjs";
import { createConfiguredComfyUiApi } from "./comfyui-gateway.mjs";
import { fixturePng, startFakeComfyUi } from "../test-support/fake-comfyui.mjs";

async function app(t, { factory } = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), "atelier-account-comfy-"));
    const upstream = await startFakeComfyUi();
    const users = [];
    const api = createAccountApi({
        dataDir,
        allowRegistration: true,
        comfyuiFactory: ({ userId }) => {
            users.push(userId);
            return factory
                ? factory({ userId })
                : createConfiguredComfyUiApi({
                      env: {
                          COMFYUI_BASE_URL: upstream.baseUrl,
                          COMFYUI_API_PREFIX: "/api",
                          COMFYUI_WS_ENABLED: "false",
                          COMFYUI_TASK_TTL_MS: "10000",
                      },
                  });
        },
    });
    const server = createServer((req, res) => void api.handle(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
        await api.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await upstream.close();
        await rm(dataDir, { recursive: true, force: true });
    });
    const request = (path, account = {}, init = {}) =>
        fetch(base + path, {
            ...init,
            headers: {
                origin: base,
                "x-atelier-request": "1",
                ...(account.cookie && { cookie: account.cookie }),
                ...(account.userId && { "x-atelier-user": account.userId }),
                ...init.headers,
            },
        });
    async function register(username) {
        const response = await request(
            "/api/account/register",
            {},
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ username, password: "account-comfy-test-password" }),
            },
        );
        assert.equal(response.status, 201, await response.clone().text());
        return { userId: (await response.json()).user.id, cookie: response.headers.get("set-cookie").split(";")[0] };
    }
    return { api, request, register, users, upstream };
}

function form() {
    const data = new FormData();
    for (const [key, value] of Object.entries({ workflowId: "portrait-pose-depth", prompt: "Account scoped portrait", shotId: "shot-1", frame: "0", width: "64", height: "64" })) data.set(key, value);
    for (const kind of ["pose", "depth"]) data.set(kind, new Blob([fixturePng()], { type: "image/png" }), `${kind}.png`);
    return data;
}

async function waitForOutput(request, account, taskId) {
    for (let attempt = 0; attempt < 150; attempt++) {
        const response = await request(`/api/comfyui/jobs/${taskId}`, account);
        assert.equal(response.status, 200);
        const task = await response.json();
        if (task.status === "succeeded") return;
        assert.notEqual(task.status, "failed", JSON.stringify(task.error));
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Account ComfyUI task did not complete");
}

test("ComfyUI routes require auth, same-origin writes and the original account before opening a runtime", async (t) => {
    const { request, register, users } = await app(t);
    for (const path of ["/api/comfyui/jobs", "/api/comfyui/jobs/other", "/api/comfyui/jobs/other/output"]) {
        assert.equal((await request(path)).status, 401);
    }
    const alice = await register("alice");
    const bob = await register("bob");
    assert.equal((await request("/api/comfyui/jobs", alice, { method: "POST", body: form(), headers: { origin: "https://foreign.example" } })).status, 403);
    assert.equal((await request("/api/comfyui/jobs", { cookie: alice.cookie }, { method: "POST", body: form() })).status, 409);
    for (const method of ["GET", "DELETE"]) {
        const response = await request("/api/comfyui/jobs/other", { cookie: bob.cookie, userId: alice.userId }, { method });
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, "ACCOUNT_CHANGED");
    }
    assert.deepEqual(users, []);
});

test("authenticated ComfyUI jobs, output, cancellation and idempotency are isolated per user", async (t) => {
    const { request, register, users, upstream } = await app(t);
    const alice = await register("alice");
    const bob = await register("bob");
    const create = async (account) => {
        const response = await request("/api/comfyui/jobs", account, { method: "POST", headers: { "idempotency-key": "same-account-request" }, body: form() });
        assert.equal(response.status, 202, await response.clone().text());
        return response.json();
    };
    const a = await create(alice);
    const b = await create(bob);
    assert.notEqual(a.taskId, b.taskId);
    await Promise.all([waitForOutput(request, alice, a.taskId), waitForOutput(request, bob, b.taskId)]);
    assert.equal((await create(alice)).taskId, a.taskId);
    assert.equal((await create(bob)).taskId, b.taskId);
    assert.deepEqual(users, [alice.userId, bob.userId], "one isolated runtime is reused per user");
    assert.equal(upstream.state.submissions.length, 2);
    for (const [owner, other, taskId] of [
        [alice, bob, a.taskId],
        [bob, alice, b.taskId],
    ]) {
        for (const suffix of ["", "/output"]) assert.equal((await request(`/api/comfyui/jobs/${taskId}${suffix}`, other)).status, 404);
        assert.equal((await request(`/api/comfyui/jobs/${taskId}`, other, { method: "DELETE" })).status, 404);
        const image = await request(`/api/comfyui/jobs/${taskId}/output`, owner);
        assert.equal(image.status, 200);
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), upstream.output);
    }
    assert.deepEqual(upstream.state.cancellations, [], "a foreign DELETE must never reach the GPU queue");
});

test("ComfyUI configuration failures are sanitized and do not break account persistence", async (t) => {
    const { request, register } = await app(t, {
        factory: () => {
            throw new Error("secret-value /private/workflows/path");
        },
    });
    const alice = await register("alice");
    const response = await request("/api/comfyui/jobs/any", alice);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(JSON.parse(text).code, "COMFYUI_UNAVAILABLE");
    assert.doesNotMatch(text, /secret-value|private\/workflows/);
    assert.equal((await request("/api/account/state", alice)).status, 200);
});

test("shutdown closes every account's ComfyUI runtime once", async (t) => {
    const closed = [];
    const { api, request, register, users } = await app(t, {
        factory: ({ userId }) => ({
            async handle(_req, res) {
                res.writeHead(200, { "content-type": "application/json" }).end("{}");
            },
            async close() {
                closed.push(userId);
            },
        }),
    });
    for (const username of ["alice", "bob"]) {
        const account = await register(username);
        assert.equal((await request("/api/comfyui/jobs/any", account)).status, 200);
    }
    await api.close();
    await api.close();
    assert.deepEqual(closed.sort(), users.sort());
});
