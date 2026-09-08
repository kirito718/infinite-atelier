import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createAccountApi } from "./account-api.mjs";

const PASSWORD = "correct horse battery staple";
const STATE = "infinite-canvas:canvas_store";
const CONFIG = "infinite-canvas:ai_config_store";
const statePath = (key = STATE) => `/api/account/state/${encodeURIComponent(key)}`;
const filePath = (key = "image:example") => `/api/account/files/${encodeURIComponent(key)}`;

async function withApp(run, options = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), "atelier-accounts-test-"));
    let api = createAccountApi({ dataDir, allowRegistration: true, ...options });
    const server = createServer((req, res) => void api.handle(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(path, { method = "GET", body, cookie, userId, headers = {}, raw } = {}) {
        return fetch(base + path, {
            method,
            headers: { origin: base, "x-atelier-request": "1", ...(body !== undefined && { "content-type": "application/json" }), ...(cookie && { cookie }), ...(userId && { "x-atelier-user": userId }), ...headers },
            body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        });
    }
    async function register(username) {
        const response = await request("/api/account/register", { method: "POST", body: { username, displayName: username, password: PASSWORD } });
        assert.equal(response.status, 201, await response.clone().text());
        const { user } = await response.json();
        return { user, userId: user.id, cookie: response.headers.get("set-cookie").split(";")[0] };
    }
    try {
        await run({
            request,
            register,
            dataDir,
            base,
            restart: async () => {
                await api.close();
                api = createAccountApi({ dataDir, allowRegistration: true, ...options });
            },
        });
    } finally {
        await api.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await rm(dataDir, { recursive: true, force: true });
    }
}

test("registration issues an HttpOnly session; passwords and session tokens are hashed", async () => {
    await withApp(async ({ request, register, dataDir }) => {
        assert.equal((await (await request("/api/account/session")).json()).user, null);
        const account = await register("alice");
        const response = await request("/api/account/login", { method: "POST", body: { username: "ALICE", password: PASSWORD } });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("set-cookie"), /HttpOnly/i);
        assert.match(response.headers.get("set-cookie"), /SameSite=Lax/i);
        assert.equal((await (await request("/api/account/session", account)).json()).user.id, account.user.id);
        const db = new Database(join(dataDir, "atelier.sqlite"), { readonly: true });
        const user = db.prepare("SELECT * FROM users").get();
        assert.ok(user.password_hash && !user.password_hash.includes(PASSWORD));
        const session = db.prepare("SELECT * FROM sessions").get();
        assert.ok(session.token_hash && session.token_hash !== account.cookie.split("=")[1]);
        db.close();
        assert.equal((await request("/api/account/login", { method: "POST", body: { username: "alice", password: "wrong-password" } })).status, 401);
        assert.equal((await request("/api/account/register", { method: "POST", body: { username: "alice", password: PASSWORD } })).status, 409);
    });
});

test("registration closes after the first account unless explicitly enabled", async () => {
    await withApp(
        async ({ request, register }) => {
            assert.equal((await (await request("/api/account/session")).json()).registrationAllowed, true);
            await register("first");
            assert.equal((await (await request("/api/account/session")).json()).registrationAllowed, false);
            assert.equal((await request("/api/account/register", { method: "POST", body: { username: "second", password: PASSWORD } })).status, 403);
        },
        { allowRegistration: false },
    );
});

test("all business APIs require auth and state-changing requests reject CSRF and stale identities", async () => {
    await withApp(async ({ request, register }) => {
        for (const path of ["/api/account/state", filePath(), "/api/codex-subscription/v1/status", "/api-proxy?target=https://example.com"]) {
            assert.equal((await request(path)).status, 401, path);
        }
        const alice = await register("alice");
        assert.equal((await request(statePath(), { ...alice, method: "PUT", body: { value: "{}", expectedRevision: 0 }, headers: { origin: "https://evil.test" } })).status, 403);
        assert.equal((await request(statePath(), { ...alice, method: "PUT", body: { value: "{}", expectedRevision: 0 }, headers: { "x-atelier-request": "" } })).status, 403);
        assert.equal((await request(statePath(), { ...alice, userId: undefined, method: "PUT", body: { value: "{}", expectedRevision: 0 } })).status, 409);
        const bob = await register("bobby");
        const changed = await request(statePath(), { ...bob, userId: alice.userId, method: "PUT", body: { value: "{}", expectedRevision: 0 } });
        assert.equal(changed.status, 409);
        assert.equal((await changed.json()).code, "ACCOUNT_CHANGED");
        assert.equal((await request("/api/account/logout", { ...bob, userId: alice.userId, method: "POST" })).status, 409);
    });
});

test("state is isolated by owner, encrypted at rest and recovered with its session after restart", async () => {
    await withApp(async ({ request, register, restart, dataDir }) => {
        const alice = await register("alice");
        const bob = await register("bobby");
        const value = JSON.stringify({ state: { config: { channels: [{ apiKey: "sk-private-test-value" }] } }, version: 0 });
        assert.equal((await request(statePath(CONFIG), { ...alice, method: "PUT", body: { value, expectedRevision: 0 } })).status, 200);
        assert.deepEqual(await (await request(statePath(CONFIG), bob)).json(), { value: null, revision: 0 });
        const db = new Database(join(dataDir, "atelier.sqlite"), { readonly: true });
        assert.ok(!db.prepare("SELECT value FROM documents").get().value.includes("sk-private-test-value"));
        db.close();
        await restart();
        assert.deepEqual(await (await request(statePath(CONFIG), alice)).json(), { value, revision: 1 });
        assert.equal((await (await request("/api/account/session", alice)).json()).user.username, "alice");
        assert.ok((await readdir(dataDir)).includes("encryption.key"));
    });
});

test("optimistic revisions reject lost updates and tombstones cannot be resurrected with an old revision", async () => {
    await withApp(async ({ request, register }) => {
        const account = await register("alice");
        const put = (value, expectedRevision) => request(statePath(), { ...account, method: "PUT", body: { value, expectedRevision } });
        assert.equal((await put('{"state":{"projects":[]}}', 0)).status, 200);
        const results = await Promise.all([put('{"title":"first"}', 1), put('{"title":"second"}', 1)]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal((await put(null, 2)).status, 200);
        assert.equal((await put("{}", 0)).status, 409);
        assert.deepEqual(await (await request(statePath(), account)).json(), { value: null, revision: 3 });
        assert.equal((await put("not json", 3)).status, 400);
        assert.equal((await request(statePath("../../bad"), { ...account, method: "PUT", body: { value: "{}", expectedRevision: 0 } })).status, 400);
    });
});

test("private media supports ranges, is owner-scoped, and survives server replacement", async () => {
    await withApp(async ({ request, register, restart }) => {
        const alice = await register("alice");
        const bob = await register("bobby");
        const upload = await request(filePath(), { ...alice, method: "PUT", raw: "0123456789", headers: { "content-type": "image/png" } });
        assert.equal(upload.status, 200);
        assert.deepEqual(await upload.json(), { storageKey: "image:example", mimeType: "image/png", bytes: 10 });
        assert.equal((await request(filePath(), bob)).status, 404);
        const range = await request(filePath(), { ...alice, headers: { range: "bytes=2-5" } });
        assert.equal(range.status, 206);
        assert.equal(range.headers.get("content-range"), "bytes 2-5/10");
        assert.equal(await range.text(), "2345");
        assert.equal((await request(filePath(), { ...alice, headers: { range: "bytes=100-" } })).status, 416);
        assert.equal((await request(filePath() + "?account=" + bob.userId, alice)).status, 409);
        await restart();
        assert.equal(await (await request(filePath(), alice)).text(), "0123456789");
        assert.equal((await request(filePath(), { ...bob, method: "DELETE" })).status, 204);
        assert.equal((await request(filePath(), alice)).status, 200);
        await request(filePath(), { ...alice, method: "DELETE" });
        assert.equal((await request(filePath(), alice)).status, 404);
    });
});

test("upload limits reject oversized data, executable media types, and unsafe storage keys", async () => {
    await withApp(
        async ({ request, register }) => {
            const alice = await register("alice");
            const upload = (key, value, mime = "image/png") => request(filePath(key), { ...alice, method: "PUT", raw: value, headers: { "content-type": mime } });
            assert.equal((await upload("image:one", "12345")).status, 200);
            assert.equal((await upload("image:one", "123456")).status, 413);
            assert.equal(await (await request(filePath("image:one"), alice)).text(), "12345");
            assert.equal((await upload("image:two", "12345")).status, 413);
            assert.equal((await upload("image:evil", "<x>", "text/html")).status, 415);
            assert.equal((await upload("image:../../evil", "x")).status, 400);
            assert.equal((await (await request("/api/account/files", alice)).json()).files.length, 1);
        },
        { maxUploadBytes: 5, quotaBytes: 8 },
    );
});

test("changing passwords revokes older sessions; logout makes its cookie unusable", async () => {
    await withApp(async ({ request, register }) => {
        const alice = await register("alice");
        const changed = await request("/api/account/password", { ...alice, method: "POST", body: { currentPassword: PASSWORD, newPassword: "this is a new secure password" } });
        assert.equal(changed.status, 200);
        assert.equal((await (await request("/api/account/session", alice)).json()).user, null);
        const fresh = { ...alice, cookie: changed.headers.get("set-cookie").split(";")[0] };
        assert.equal((await request("/api/account/state", fresh)).status, 200);
        assert.equal((await request("/api/account/login", { method: "POST", body: { username: "alice", password: PASSWORD } })).status, 401);
        assert.equal((await request("/api/account/logout", { ...fresh, method: "POST" })).status, 204);
        assert.equal((await request("/api/account/state", fresh)).status, 401);
    });
});

test("legacy import is atomic, idempotent, checks missing media and never replaces existing documents", async () => {
    await withApp(async ({ request, register }) => {
        const alice = await register("alice");
        const entries = [
            { key: STATE, value: JSON.stringify({ state: { projects: [{ nodes: [{ storageKey: "image:legacy" }, { storageKey: "" }] }] } }) },
            { key: "monoform-project", value: '{"objects":[]}' },
        ];
        const body = { migrationId: "legacy-browser-001", entries };
        assert.deepEqual(await (await request("/api/account/import/legacy-browser-001", alice)).json(), { imported: false, canImport: true });
        const run = () => request("/api/account/import", { ...alice, method: "POST", body });
        assert.equal((await run()).status, 400);
        assert.equal((await (await request("/api/account/state", alice)).json()).entries.length, 0);
        await request(filePath("image:legacy"), { ...alice, method: "PUT", raw: "image", headers: { "content-type": "image/png" } });
        assert.equal((await run()).status, 200);
        assert.deepEqual(await (await request("/api/account/import/legacy-browser-001", alice)).json(), { imported: true, canImport: true });
        assert.equal((await run()).status, 200);
        assert.equal((await (await request(statePath(), alice)).json()).revision, 1);
        assert.equal((await request("/api/account/import", { ...alice, method: "POST", body: { ...body, migrationId: "another-browser" } })).status, 409);
    });
});

test("each Codex runtime has a distinct persistent home and unauthenticated calls never create one", async () => {
    const homes = [];
    await withApp(
        async ({ request, register, restart }) => {
            assert.equal((await request("/api/codex-subscription/v1/status")).status, 401);
            assert.equal(homes.length, 0);
            const alice = await register("alice");
            const bob = await register("bobby");
            await request("/api/codex-subscription/v1/status", alice);
            await request("/api/codex-subscription/v1/status", bob);
            assert.equal(homes.length, 2);
            assert.notEqual(homes[0], homes[1]);
            assert.ok(homes[0].includes(alice.userId));
            await restart();
            await request("/api/codex-subscription/v1/status", alice);
            assert.equal(homes[2], homes[0]);
        },
        {
            codexFactory: ({ codexHome }) => {
                homes.push(codexHome);
                return {
                    handle: async (_req, res) => {
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end('{"status":"disconnected"}');
                    },
                    close: async () => {},
                };
            },
        },
    );
});

test("proxy strips app cookies and upstream Set-Cookie while preserving a user-provided model credential", async () => {
    let observed;
    let observedUrl;
    const upstream = createServer((req, res) => {
        observed = req.headers;
        observedUrl = req.url;
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "atelier_session=attacker" });
        res.end('{"ok":true}');
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    try {
        await withApp(
            async ({ request, register }) => {
                const alice = await register("alice");
                const url = `http://127.0.0.1:${upstream.address().port}/test`;
                const result = await request("/api-proxy?target=" + encodeURIComponent(url) + "&page=2&account=provider-account", { ...alice, headers: { authorization: "Bearer model-key", "x-goog-api-key": "gemini-model-key" } });
                assert.equal(result.status, 200);
                assert.equal(result.headers.get("set-cookie"), null);
                assert.equal(observed.cookie, undefined);
                assert.equal(observed["x-atelier-user"], undefined);
                assert.equal(observed.authorization, "Bearer model-key");
                assert.equal(observed["x-goog-api-key"], "gemini-model-key");
                assert.equal(observedUrl, "/test?page=2&account=provider-account");
            },
            { allowPrivateUpstreams: true },
        );
        await withApp(async ({ request, register }) => {
            const alice = await register("alice");
            assert.equal((await request("/api-proxy?target=" + encodeURIComponent(`http://127.0.0.1:${upstream.address().port}`), alice)).status, 403);
            assert.equal((await request("/api-proxy?target=file%3A%2F%2F%2Fetc%2Fpasswd", alice)).status, 400);
        });
    } finally {
        upstream.closeAllConnections();
        await new Promise((resolve) => upstream.close(resolve));
    }
});

test("backup restore commits all documents together and rolls back the whole batch on conflict", async () => {
    await withApp(async ({ request, register }) => {
        const alice = await register("alice");
        await request(statePath(), { ...alice, method: "PUT", body: { value: '{"original":true}', expectedRevision: 0 } });
        const entries = [
            { key: CONFIG, value: '{"restored":true}', expectedRevision: 0 },
            { key: STATE, value: '{"restored":true}', expectedRevision: 0 },
        ];
        const result = await request("/api/account/restore", { ...alice, method: "POST", body: { entries } });
        assert.equal(result.status, 409);
        assert.deepEqual(await (await request(statePath(CONFIG), alice)).json(), { value: null, revision: 0 });
        entries[1].expectedRevision = 1;
        assert.equal((await request("/api/account/restore", { ...alice, method: "POST", body: { entries } })).status, 200);
        assert.equal((await (await request(statePath(), alice)).json()).value, '{"restored":true}');
    });
});

test("redirects to a different upstream origin never carry provider credentials", async () => {
    let observed;
    const target = createServer((req, res) => {
        observed = req.headers;
        res.end("ok");
    });
    await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
    const redirect = createServer((_req, res) => {
        res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/result` });
        res.end();
    });
    await new Promise((resolve) => redirect.listen(0, "127.0.0.1", resolve));
    try {
        await withApp(
            async ({ request, register }) => {
                const alice = await register("alice");
                const response = await request("/api-proxy?target=" + encodeURIComponent(`http://127.0.0.1:${redirect.address().port}/`), {
                    ...alice,
                    headers: { authorization: "Bearer provider-secret", "x-api-key": "api-secret", "x-goog-api-key": "google-secret", "x-custom-signature": "custom-secret" },
                });
                assert.equal(response.status, 200);
                for (const key of ["authorization", "x-api-key", "x-goog-api-key", "x-custom-signature", "cookie", "x-atelier-user"]) assert.equal(observed[key], undefined, key);
            },
            { allowPrivateUpstreams: true },
        );
    } finally {
        for (const server of [redirect, target]) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    }
});

test("HTTPS public origin issues Secure cookies and still rejects other origins", async () => {
    const publicUrl = "https://acceptance.example.test";
    await withApp(
        async ({ request }) => {
            const created = await request("/api/account/register", {
                method: "POST",
                body: { username: "tlsuser", password: PASSWORD },
                headers: { origin: publicUrl },
            });
            assert.equal(created.status, 201);
            assert.match(created.headers.get("set-cookie"), /; Secure(?:;|$)/i);
            assert.match(created.headers.get("set-cookie"), /; HttpOnly/i);
            const denied = await request("/api/account/login", {
                method: "POST",
                body: { username: "tlsuser", password: PASSWORD },
                headers: { origin: "https://untrusted.example.test", "x-forwarded-proto": "https" },
            });
            assert.equal(denied.status, 403);
            assert.equal((await denied.json()).code, "CSRF");
        },
        { publicUrl },
    );
});

test("authentication throttling cannot be bypassed by changing username case", async () => {
    await withApp(async ({ request }) => {
        for (let attempt = 0; attempt < 12; attempt++) {
            const denied = await request("/api/account/login", { method: "POST", body: { username: "ratelimituser", password: PASSWORD } });
            assert.equal(denied.status, 401);
        }
        const limited = await request("/api/account/login", { method: "POST", body: { username: "RATELIMITUSER", password: PASSWORD } });
        assert.equal(limited.status, 429);
        assert.equal((await limited.json()).code, "RATE_LIMITED");
    });
});

test("oversized authentication JSON is rejected before credential processing", async () => {
    await withApp(async ({ request }) => {
        const result = await request("/api/account/register", { method: "POST", body: { username: "largebody", password: "x".repeat(9000) } });
        assert.equal(result.status, 413);
        assert.equal((await result.json()).code, "TOO_LARGE");
        assert.equal((await (await request("/api/account/session")).json()).user, null);
    });
});
