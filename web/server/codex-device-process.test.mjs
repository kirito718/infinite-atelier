import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAccountApi } from "./account-api.mjs";
import { createCodexSubscriptionApi } from "./codex-subscription-api.mjs";
import { CodexAppServerClient } from "../local-bridge/app-server-client.mjs";

const PREFIX = "/api/codex-subscription/v1";
const executable = fileURLToPath(new URL("../test-support/fake-codex-device.mjs", import.meta.url));

test("real HTTP and stdio process wire preserve device auth and user homes through restart", { timeout: 15000 }, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "atelier-device-wire-"));
    const children = [];
    const makeApi = () =>
        createAccountApi({
            dataDir,
            allowRegistration: true,
            codexFactory: ({ codexHome, tempRoot }) =>
                createCodexSubscriptionApi({
                    tempRoot,
                    codex: new CodexAppServerClient({
                        command: process.execPath,
                        args: [executable, "app-server", "--listen", "stdio://"],
                        generatedImagesDir: join(codexHome, "generated_images"),
                        spawnProcess: (program, args, options) => {
                            assert.equal(program, process.execPath, "the test must never run the real Codex executable");
                            const child = spawn(program, args, { ...options, env: { ...process.env, CODEX_HOME: codexHome, ATELIER_QA_DEVICE_FIXTURE: "1" } });
                            children.push(child);
                            return child;
                        },
                    }),
                }),
        });
    let api = makeApi();
    const server = createServer((req, res) => void api.handle(req, res));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
        await api.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await Promise.all(children.map((child) => (child.exitCode !== null || child.signalCode !== null ? undefined : once(child, "exit"))));
        await rm(dataDir, { recursive: true, force: true });
    });
    const request = (path, user = {}, method = "GET", body) =>
        fetch(origin + path, {
            method,
            headers: { origin, "x-atelier-request": "1", ...(user.cookie && { cookie: user.cookie }), ...(user.id && { "x-atelier-user": user.id }), ...(body !== undefined && { "content-type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    const register = async (username) => {
        const r = await request("/api/account/register", {}, "POST", { username, password: "wire-fixture-not-a-real-password" });
        assert.equal(r.status, 201);
        return { id: (await r.json()).user.id, cookie: r.headers.get("set-cookie").split(";")[0] };
    };
    const login = async (user) => {
        const r = await request(PREFIX + "/login", user, "POST");
        assert.equal(r.status, 200, await r.clone().text());
        const value = await r.json();
        assert.deepEqual(Object.keys(value).sort(), ["loginId", "type", "userCode", "verificationUrl"]);
        assert.equal(value.type, "chatgptDeviceCode");
        assert.equal(value.verificationUrl, "https://auth.openai.com/codex/device");
        return value;
    };
    const status = async (user) => (await (await request(PREFIX + "/status", user)).json()).status;
    const control = (user, action, loginId) => writeFile(join(dataDir, "codex", user.id, ".atelier-qa-control.json"), JSON.stringify({ action, loginId }));
    const until = async (user, expected) => {
        for (let i = 0; i < 100; i++) {
            if ((await status(user)) === expected) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.fail(`Expected ${expected}`);
    };
    const alice = await register("alice"),
        bob = await register("bob");
    const a = await login(alice),
        b = await login(bob);
    assert.notEqual(a.userCode, b.userCode);
    assert.notEqual(a.loginId, b.loginId);
    assert.deepEqual(await login(alice), a, "repeated start must reuse the same pending process attempt");
    assert.equal(await status(alice), "connecting");
    await request(PREFIX + "/login/cancel", alice, "POST", { loginId: b.loginId });
    assert.equal(await status(bob), "connecting");
    assert.equal(await status(alice), "connecting");
    await control(alice, "complete", a.loginId);
    await until(alice, "connected");
    assert.equal(await status(bob), "connecting");
    await request(PREFIX + "/login/cancel", bob, "POST", { loginId: b.loginId });
    await until(bob, "disconnected");
    const retry = await login(bob);
    assert.notEqual(retry.loginId, b.loginId);
    await control(bob, "fail", retry.loginId);
    await until(bob, "disconnected");
    await api.close();
    api = makeApi();
    assert.equal(await status(alice), "connected", "authorized fixture state must remain in the same user's home");
    assert.equal(await status(bob), "disconnected", "a cancelled/failed code must not reappear after restart");
    await request(PREFIX + "/logout", alice, "POST");
    await until(alice, "disconnected");
    for (const user of [alice, bob]) {
        const wire = (await readFile(join(dataDir, "codex", user.id, ".atelier-qa-wire.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
        const starts = wire.filter((item) => item.method === "account/login/start");
        assert.equal(starts.length, user.id === alice.id ? 1 : 2);
        assert.ok(starts.every((item) => item.loginType === "chatgptDeviceCode"));
        assert.ok(wire.some((item) => item.method === "initialize"));
        assert.ok(!JSON.stringify(wire).includes(user.id === alice.id ? a.userCode : b.userCode));
    }
});
