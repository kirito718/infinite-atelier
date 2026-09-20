import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountApi } from "./account-api.mjs";
import { createCodexSubscriptionApi } from "./codex-subscription-api.mjs";

const API = "/api/codex-subscription/v1";
async function fixture(t) {
    const dataDir = await mkdtemp(join(tmpdir(), "atelier-device-account-test-"));
    const clients = new Map();
    const api = createAccountApi({
        dataDir,
        allowRegistration: true,
        codexFactory: ({ userId, codexHome, tempRoot }) => {
            let pending = null,
                sequence = 0;
            const code = `TEST-${String(clients.size + 1).padStart(4, "0")}`;
            const client = {
                codexHome,
                getAccountStatus: async () => (pending ? "connecting" : "disconnected"),
                login: async () =>
                    (pending ??= {
                        type: "chatgptDeviceCode",
                        loginId: `${userId}:${++sequence}`,
                        verificationUrl: "https://auth.openai.com/codex/device",
                        userCode: code,
                        accessToken: "must-not-reach-the-browser",
                        refreshToken: "must-not-reach-the-browser-either",
                    }),
                cancelLogin: async (id) => {
                    if (pending?.loginId === id) pending = null;
                },
                logout: async () => {
                    pending = null;
                },
            };
            clients.set(userId, client);
            return createCodexSubscriptionApi({ codex: client, tempRoot });
        },
    });
    const server = createServer((req, res) => void api.handle(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
        await api.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await rm(dataDir, { recursive: true, force: true });
    });
    const request = (path, account = {}, { method = "GET", body, headers = {} } = {}) =>
        fetch(base + path, {
            method,
            headers: { origin: base, "x-atelier-request": "1", ...(account.cookie && { cookie: account.cookie }), ...(account.userId && { "x-atelier-user": account.userId }), ...(body !== undefined && { "content-type": "application/json" }), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    const register = async (username) => {
        const response = await request("/api/account/register", {}, { method: "POST", body: { username, password: "device-code-fixture-password" } });
        assert.equal(response.status, 201);
        return { userId: (await response.json()).user.id, cookie: response.headers.get("set-cookie").split(";")[0] };
    };
    return { request, register, clients };
}

test("device login and cancel retain account auth, same-origin and stale-identity protection", async (t) => {
    const { request, register, clients } = await fixture(t);
    for (const path of ["/login", "/login/cancel", "/logout"]) assert.equal((await request(API + path, {}, { method: "POST", body: { loginId: "foreign-id" } })).status, 401);
    assert.equal(clients.size, 0);
    const alice = await register("alice");
    const bob = await register("bob");
    for (const path of ["/login", "/login/cancel"]) {
        assert.equal((await request(API + path, alice, { method: "POST", body: { loginId: "id" }, headers: { origin: "https://foreign.example" } })).status, 403);
        assert.equal((await request(API + path, { cookie: bob.cookie, userId: alice.userId }, { method: "POST", body: { loginId: "id" } })).status, 409);
    }
    assert.equal(clients.size, 0, "rejected requests must not start any user's CLI");
});

test("device-code HTTP responses omit credentials, are not cacheable, and remain scoped to each user", async (t) => {
    const { request, register, clients } = await fixture(t);
    const alice = await register("alice");
    const bob = await register("bob");
    const start = async (account) => {
        const response = await request(API + "/login", account, { method: "POST" });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const body = await response.json();
        assert.deepEqual(Object.keys(body).sort(), ["loginId", "type", "userCode", "verificationUrl"]);
        assert.equal(body.type, "chatgptDeviceCode");
        assert.equal(body.verificationUrl, "https://auth.openai.com/codex/device");
        return body;
    };
    const a = await start(alice);
    const b = await start(bob);
    assert.notEqual(a.userCode, b.userCode);
    assert.notEqual(a.loginId, b.loginId);
    assert.deepEqual(await start(alice), a);
    assert.notEqual(clients.get(alice.userId).codexHome, clients.get(bob.userId).codexHome);
    assert.equal((await request(API + "/login/cancel", alice, { method: "POST", body: { loginId: b.loginId } })).status, 204);
    assert.equal((await (await request(API + "/status", bob)).json()).status, "connecting");
    assert.equal((await (await request(API + "/status", alice)).json()).status, "connecting");
    assert.equal((await request(API + "/login/cancel", alice, { method: "POST", body: { loginId: a.loginId } })).status, 204);
    assert.equal((await (await request(API + "/status", alice)).json()).status, "disconnected");
    assert.equal((await (await request(API + "/status", bob)).json()).status, "connecting");
    assert.equal((await request(API + "/logout", alice, { method: "POST" })).status, 204);
    assert.equal((await (await request(API + "/status", bob)).json()).status, "connecting");
    const documents = await (await request("/api/account/state", alice)).json();
    assert.equal(JSON.stringify(documents).includes(a.userCode), false);
});

test("device cancellation rejects missing, malformed and oversized login identifiers", async (t) => {
    const { request, register } = await fixture(t);
    const alice = await register("alice");
    for (const body of [null, {}, [], { loginId: "" }, { loginId: 123 }, { loginId: "x".repeat(201) }, { loginId: "id\n" }]) {
        const response = await request(API + "/login/cancel", alice, { method: "POST", body });
        assert.equal(response.status, 400);
    }
});
