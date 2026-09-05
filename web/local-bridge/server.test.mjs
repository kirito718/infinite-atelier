import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { requireBridgeRequest } from "./bridge-utils.mjs";
import { CodexAppServerClient } from "./app-server-client.mjs";
import { createBridgeServer } from "./server.mjs";

const SECRET = "test-bridge-secret";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("Codex client initializes once and sends documented image turn inputs", { timeout: 500 }, async () => {
    const process = createFakeAppServerProcess();
    const client = new CodexAppServerClient({ spawnProcess: () => process });

    const account = await client.readAccount();
    const login = await client.login();
    const generated = await client.generateImage({
        prompt: "Carve a translucent tower",
        references: ["/tmp/task/reference-0.png"],
        workDir: "/tmp/task",
    });

    assert.deepEqual(account, { account: null, requiresOpenaiAuth: true });
    assert.deepEqual(login, { authUrl: "https://chatgpt.com/auth/test" });
    assert.deepEqual(generated.files[0].bytes, PNG_BYTES);
    assert.equal(generated.files[0].mimeType, "image/png");

    const requests = process.messages.filter((message) => message.id !== undefined);
    assert.deepEqual(
        requests.map(({ id, method }) => ({ id, method })),
        [
            { id: 1, method: "initialize" },
            { id: 2, method: "account/read" },
            { id: 3, method: "account/login/start" },
            { id: 4, method: "thread/start" },
            { id: 5, method: "turn/start" },
        ],
    );
    assert.deepEqual(requests[0].params, {
        clientInfo: { name: "Infinite Atelier", version: "1.0.0" },
    });
    assert.deepEqual(process.messages[1], { method: "initialized", params: {} });
    assert.deepEqual(requests[2].params, {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "codex",
    });
    assert.deepEqual(requests[4].params.input, [
        { type: "text", text: "$imagegen Carve a translucent tower" },
        { type: "localImage", path: "/tmp/task/reference-0.png" },
    ]);

    await client.close();
});

test("Codex client interrupts the active image turn when cancelled", async () => {
    const process = createFakeAppServerProcess({ completeTurn: false });
    const client = new CodexAppServerClient({ spawnProcess: () => process });
    const controller = new AbortController();
    const generation = client.generateImage({
        prompt: "A moss-covered observatory",
        references: [],
        workDir: "/tmp/task",
        signal: controller.signal,
    });

    await waitUntil(() => process.messages.some((message) => message.method === "turn/start"));
    controller.abort();

    await assert.rejects(generation, { name: "AbortError" });
    await waitUntil(() => process.messages.some((message) => message.method === "turn/interrupt"));
    const interrupt = process.messages.find((message) => message.method === "turn/interrupt");
    assert.deepEqual(interrupt.params, { threadId: "thread-1", turnId: "turn-1" });

    await client.close();
});

test("status endpoint reports the Codex connection state", async () => {
    await withServer({ status: "connected" }, async ({ request }) => {
        const response = await request("/v1/status");

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: "connected" });
    });
});

test("bridge endpoints reject requests without a token and non-loopback peers", async () => {
    await withServer({ status: "disconnected" }, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/v1/status`);

        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: "Unauthorized local bridge request" });
    });

    assert.throws(
        () =>
            requireBridgeRequest(
                {
                    headers: { "x-atelier-bridge-token": SECRET },
                    socket: { remoteAddress: "192.0.2.10" },
                },
                SECRET,
            ),
        /Unauthorized local bridge request/,
    );
});

test("creates an image task, decodes references, and exposes contained metadata", async () => {
    const codex = {
        status: "connected",
        async generateImage({ references }) {
            assert.equal(references.length, 1);
            assert.deepEqual(await readFile(references[0]), PNG_BYTES);
            return {
                files: [{ bytes: PNG_BYTES, mimeType: "image/png", name: "concept.png" }],
            };
        },
    };

    await withServer(codex, async ({ request }) => {
        const created = await request("/v1/images", {
            method: "POST",
            body: JSON.stringify({
                operation: "edit",
                prompt: "Turn this into a paper sculpture",
                references: [`data:image/png;base64,${PNG_BYTES.toString("base64")}`],
            }),
        });

        assert.equal(created.status, 202);
        const { taskId } = await created.json();
        const task = await waitForTask(request, taskId, "succeeded");

        assert.equal(task.status, "succeeded");
        assert.equal(task.files.length, 1);
        assert.deepEqual(task.files[0], {
            fileId: task.files[0].fileId,
            name: "concept.png",
            mimeType: "image/png",
            size: PNG_BYTES.length,
            url: `/v1/images/${taskId}/files/${task.files[0].fileId}`,
        });
        assert.equal(JSON.stringify(task).includes(tmpdir()), false);
    });
});

test("downloads a generated image by its opaque file id", async () => {
    const codex = {
        status: "connected",
        async generateImage() {
            return { files: [{ bytes: PNG_BYTES, mimeType: "image/png", name: "result.png" }] };
        },
    };

    await withServer(codex, async ({ request }) => {
        const created = await request("/v1/images", {
            method: "POST",
            body: JSON.stringify({ operation: "generate", prompt: "A copper fox", references: [] }),
        });
        const { taskId } = await created.json();
        const task = await waitForTask(request, taskId, "succeeded");
        const response = await request(task.files[0].url);

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG_BYTES);
    });
});

test("rejects video operations before creating a task", async () => {
    await withServer({ status: "connected" }, async ({ request }) => {
        const response = await request("/v1/images", {
            method: "POST",
            body: JSON.stringify({ operation: "video", prompt: "Animate this", references: [] }),
        });

        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /generate or edit/);
    });
});

test("cleans task files after failure and redacts diagnostics", async () => {
    let workDir;
    const codex = {
        status: "connected",
        async generateImage(options) {
            workDir = options.workDir;
            await writeFile(join(workDir, "partial.png"), PNG_BYTES);
            throw new Error(`Bearer eyJsecret.token.value failed at ${workDir}/partial.png`);
        },
    };

    await withServer(codex, async ({ request }) => {
        const created = await request("/v1/images", {
            method: "POST",
            body: JSON.stringify({ operation: "generate", prompt: "A blue bird", references: [] }),
        });
        const { taskId } = await created.json();
        const task = await waitForTask(request, taskId, "failed");

        assert.equal(task.error.includes("eyJsecret"), false);
        assert.equal(task.error.includes(workDir), false);
        assert.match(task.error, /\[redacted\]/);
        await assert.rejects(access(workDir, constants.F_OK), { code: "ENOENT" });
    });
});

test("cancels a running task and cleans its directory", async () => {
    let workDir;
    let generationStartedResolve;
    const generationStarted = new Promise((resolve) => {
        generationStartedResolve = resolve;
    });
    const codex = {
        status: "connected",
        async generateImage({ signal, workDir: taskDir }) {
            workDir = taskDir;
            await writeFile(join(workDir, "partial.png"), PNG_BYTES);
            generationStartedResolve();
            await new Promise((resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
        },
    };

    await withServer(codex, async ({ request }) => {
        const created = await request("/v1/images", {
            method: "POST",
            body: JSON.stringify({ operation: "generate", prompt: "A blue bird", references: [] }),
        });
        const { taskId } = await created.json();
        await generationStarted;

        const cancelled = await request(`/v1/images/${taskId}`, { method: "DELETE" });
        assert.equal(cancelled.status, 204);
        const task = await waitForTask(request, taskId, "cancelled");
        assert.equal(task.status, "cancelled");
        await assert.rejects(access(workDir, constants.F_OK), { code: "ENOENT" });
    });
});

test("rejects non-image generated files without exposing their path", async () => {
    const codex = {
        status: "connected",
        async generateImage() {
            return {
                files: [{ bytes: Buffer.from("not an image"), mimeType: "video/mp4", name: "clip.mp4" }],
            };
        },
    };

    await withServer(codex, async ({ request }) => {
        const created = await request("/v1/images", {
            method: "POST",
            body: JSON.stringify({ operation: "generate", prompt: "A still frame", references: [] }),
        });
        const { taskId } = await created.json();
        const task = await waitForTask(request, taskId, "failed");

        assert.equal(task.files.length, 0);
        assert.match(task.error, /image output/);
        assert.equal(JSON.stringify(task).includes(tmpdir()), false);
    });
});

test("starts ChatGPT login and logs out through Codex", async () => {
    const codex = {
        status: "disconnected",
        async login() {
            return { authUrl: "https://chatgpt.com/auth/test" };
        },
        async logout() {},
    };

    await withServer(codex, async ({ request }) => {
        const login = await request("/v1/login", { method: "POST", body: "{}" });
        assert.equal(login.status, 200);
        assert.deepEqual(await login.json(), { authUrl: "https://chatgpt.com/auth/test" });

        const logout = await request("/v1/logout", { method: "POST", body: "{}" });
        assert.equal(logout.status, 204);
    });
});

async function withServer(codex, callback) {
    const server = createBridgeServer({ secret: SECRET, codex, cleanupMs: 50 });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const request = (path, options = {}) =>
        fetch(`${baseUrl}${path}`, {
            ...options,
            headers: {
                "content-type": "application/json",
                "x-atelier-bridge-token": SECRET,
                ...options.headers,
            },
        });

    try {
        await callback({ baseUrl, request });
    } finally {
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
}

async function waitForTask(request, taskId, expectedStatus) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const response = await request(`/v1/images/${taskId}`);
        assert.equal(response.status, 200);
        const task = await response.json();
        if (task.status === expectedStatus) return task;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Task ${taskId} did not reach ${expectedStatus}`);
}

function createFakeAppServerProcess({ completeTurn = true } = {}) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.messages = [];
    child.kill = () => {
        child.emit("exit", 0, null);
        return true;
    };

    let buffered = "";
    child.stdin.on("data", (chunk) => {
        buffered += chunk.toString();
        const lines = buffered.split("\n");
        buffered = lines.pop();
        for (const line of lines) {
            if (!line) continue;
            const message = JSON.parse(line);
            child.messages.push(message);
            if (message.id === undefined) continue;

            if (message.method === "initialize") {
                respond({ id: message.id, result: { userAgent: "fake" } });
            } else if (message.method === "account/read") {
                respond({ id: message.id, result: { account: null, requiresOpenaiAuth: true } });
            } else if (message.method === "account/login/start") {
                respond({
                    id: message.id,
                    result: {
                        type: "chatgpt",
                        loginId: "login-1",
                        authUrl: "https://chatgpt.com/auth/test",
                    },
                });
            } else if (message.method === "thread/start") {
                respond({ id: message.id, result: { thread: { id: "thread-1" } } });
            } else if (message.method === "turn/start") {
                if (!completeTurn) {
                    respond({
                        id: message.id,
                        result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } },
                    });
                    continue;
                }
                const messages = [
                    {
                        id: message.id,
                        result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } },
                    },
                    {
                        method: "item/completed",
                        params: {
                            threadId: "thread-1",
                            turnId: "turn-1",
                            item: {
                                type: "imageGeneration",
                                id: "image-1",
                                status: "completed",
                                revisedPrompt: null,
                                result: `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
                                failure: null,
                            },
                        },
                    },
                    {
                        method: "turn/completed",
                        params: {
                            threadId: "thread-1",
                            turn: { id: "turn-1", status: "completed", items: [], error: null },
                        },
                    },
                ];
                child.stdout.write(`${messages.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
            } else if (message.method === "turn/interrupt") {
                respond({ id: message.id, result: {} });
            }
        }
    });

    return child;

    function respond(message) {
        child.stdout.write(`${JSON.stringify(message)}\n`);
    }
}

async function waitUntil(predicate) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("Condition was not reached");
}
