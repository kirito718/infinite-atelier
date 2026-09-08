import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexAppServerClient } from "./app-server-client.mjs";

const LOGIN = { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
function fixture(t, options = {}) {
    const client = new CodexAppServerClient();
    client.status = "connected";
    const requests = [];
    const state = { account: null };
    client.sendRequest = async (method, params) => {
        requests.push({ method, params });
        if (method === "account/login/start") return options.start ? options.start(client) : { ...LOGIN, accessToken: "never-return-this-token" };
        if (method === "account/read") return options.read ? options.read() : { account: state.account, requiresOpenaiAuth: true };
        if (method === "account/login/cancel") return options.cancel ? options.cancel(params) : { status: "canceled" };
        if (method === "account/logout") {
            state.account = null;
            return options.logout ? options.logout() : {};
        }
        throw new Error(`Unexpected request ${method}`);
    };
    t.after(() => client.close());
    const complete = (loginId = LOGIN.loginId, success = true) => client.handleNotification("account/login/completed", { loginId, success, error: success ? null : "expired" });
    return { client, requests, state, complete };
}

test("starts the pinned CLI's device-code flow and exposes only verification information", async (t) => {
    const { client, requests } = fixture(t);
    assert.deepEqual(await client.login(), LOGIN);
    assert.deepEqual(requests, [{ method: "account/login/start", params: { type: "chatgptDeviceCode" } }]);
    assert.equal(client.accountStatus, "connecting");
    assert.equal(await client.getAccountStatus(), "connecting");
    assert.equal(requests.length, 1, "polling must not overwrite pending authorization with account:null");
});

test("coalesces concurrent starts and reuses a pending code when the drawer reopens", async (t) => {
    const gate = deferred();
    t.after(() => gate.resolve(LOGIN));
    const { client, requests } = fixture(t, { start: () => gate.promise });
    const first = client.login();
    const second = client.login();
    first.catch(() => {});
    second.catch(() => {});
    await tick();
    assert.equal(await client.getAccountStatus(), "connecting");
    gate.resolve(LOGIN);
    assert.deepEqual(await first, LOGIN);
    assert.deepEqual(await second, LOGIN);
    assert.deepEqual(await client.login(), LOGIN);
    assert.equal(requests.filter((r) => r.method === "account/login/start").length, 1);
});

test("completion before the start response is reconciled only with the returned login ID", async (t) => {
    const { client } = fixture(t, {
        start: (client) => {
            client.handleNotification("account/login/completed", { loginId: "unrelated", success: false });
            client.handleNotification("account/login/completed", { loginId: LOGIN.loginId, success: true });
            return LOGIN;
        },
    });
    await client.login();
    assert.equal(client.accountStatus, "connected");
});

test("only the current login may complete; duplicate or stale notifications cannot replace its outcome", async (t) => {
    let sequence = 0;
    const { client, complete } = fixture(t, { start: () => ({ ...LOGIN, loginId: `login-${++sequence}` }) });
    await client.login();
    complete("different", true);
    assert.equal(client.accountStatus, "connecting");
    complete("login-1", false);
    assert.equal(client.accountStatus, "disconnected");
    await client.login();
    complete("login-1", true);
    assert.equal(client.accountStatus, "connecting");
    complete("login-2", true);
    complete("login-2", false);
    assert.equal(client.accountStatus, "connected");
});

test("cancellation is scoped and does not cancel a newer attempt or accept its late completion", async (t) => {
    const { client, requests, complete } = fixture(t);
    await client.login();
    await client.cancelLogin("stale-id");
    assert.equal(requests.filter((r) => r.method === "account/login/cancel").length, 0);
    assert.equal(client.accountStatus, "connecting");
    await client.cancelLogin(LOGIN.loginId);
    assert.deepEqual(requests.at(-1), { method: "account/login/cancel", params: { loginId: LOGIN.loginId } });
    assert.equal(client.accountStatus, "disconnected");
    complete();
    assert.equal(client.accountStatus, "disconnected");
    await client.cancelLogin(LOGIN.loginId);
    assert.equal(requests.filter((r) => r.method === "account/login/cancel").length, 1);
});

test("logout waits for an in-flight start, cancels it, then removes credentials", async (t) => {
    const gate = deferred();
    t.after(() => gate.resolve(LOGIN));
    const { client, requests, complete } = fixture(t, { start: () => gate.promise });
    const starting = client.login();
    starting.catch(() => {});
    const stopping = client.logout();
    stopping.catch(() => {});
    await tick();
    gate.resolve(LOGIN);
    await starting;
    await stopping;
    assert.deepEqual(
        requests.map((r) => r.method),
        ["account/login/start", "account/login/cancel", "account/logout"],
    );
    complete();
    assert.equal(client.accountStatus, "disconnected");
});

test("an unconfirmed cancellation cannot be reported as a completed logout", async (t) => {
    const { client, requests } = fixture(t, {
        cancel: () => {
            throw new Error("cancel failed");
        },
    });
    await client.login();
    await assert.rejects(client.logout(), /cancel failed/);
    assert.equal(
        requests.some((r) => r.method === "account/logout"),
        false,
    );
});

test("an earlier account read cannot overwrite a successful logout", async (t) => {
    const gate = deferred();
    t.after(() => gate.resolve({ account: { type: "chatgpt" } }));
    const { client } = fixture(t, { read: () => gate.promise });
    const pending = client.readAccount();
    await tick();
    await client.logout();
    gate.resolve({ account: { type: "chatgpt" } });
    await pending;
    assert.equal(client.accountStatus, "disconnected");
});

test("account-updated null represents logout, not a connected account", async (t) => {
    const { client } = fixture(t);
    client.handleNotification("account/updated", { authMode: "chatgpt" });
    assert.equal(client.accountStatus, "connected");
    client.handleNotification("account/updated", { authMode: null });
    assert.equal(client.accountStatus, "disconnected");
});

test("closed clients discard late device codes and queued authorization operations", async (t) => {
    const gate = deferred();
    t.after(() => gate.resolve(LOGIN));
    const { client, requests, complete } = fixture(t, { start: () => gate.promise });
    const starting = client.login();
    starting.catch(() => {});
    const stopping = client.logout();
    stopping.catch(() => {});
    await tick();
    await client.close();
    gate.resolve(LOGIN);
    await assert.rejects(starting);
    await assert.rejects(stopping);
    complete();
    assert.equal(client.accountStatus, "disconnected");
    assert.deepEqual(
        requests.map((r) => r.method),
        ["account/login/start"],
    );
});

test("invalid codes and loopback, unsafe or legacy URLs never become browser login instructions", async (t) => {
    const invalid = [
        { type: "chatgpt", loginId: LOGIN.loginId, authUrl: "http://localhost:1455/auth/callback" },
        { ...LOGIN, userCode: "" },
        { ...LOGIN, userCode: "x".repeat(129) },
        { ...LOGIN, loginId: "" },
        ...["http://localhost:1455/", "http://auth.openai.com/codex/device", "https://auth.openai.com.evil.test/codex/device", "https://evil.test/", "javascript:alert(1)", "https://user:pass@auth.openai.com/codex/device"].map((verificationUrl) => ({
            ...LOGIN,
            verificationUrl,
        })),
    ];
    for (const result of invalid)
        await t.test(JSON.stringify(result), async (t) => {
            const { client, requests } = fixture(t, { start: () => result });
            await assert.rejects(client.login());
            assert.notEqual(client.accountStatus, "connecting");
            assert.equal(
                requests.some((r) => r.method === "account/login/start" && r.params.type === "chatgpt"),
                false,
            );
        });
});

test("a start already waiting for logout cannot cross a subsequent close", async (t) => {
    const gate = deferred();
    t.after(() => gate.resolve({}));
    const { client, requests } = fixture(t, { logout: () => gate.promise });
    let connections = 0;
    client.connect = async () => {
        connections++;
        client.status = "connected";
    };
    const loggingOut = client.logout();
    loggingOut.catch(() => {});
    const closing = client.logoutPromise.then(() => client.close());
    const staleStart = client.login();
    staleStart.catch(() => {});
    await tick();
    gate.resolve({});
    await loggingOut;
    await closing;
    await assert.rejects(staleStart, /已关闭/);
    assert.equal(connections, 1);
    assert.equal(
        requests.some((r) => r.method === "account/login/start"),
        false,
    );
});

function transport({ read } = {}) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.messages = [];
    child.notify = (method, params) => child.stdout.write(JSON.stringify({ method, params }) + "\n");
    child.kill = () => {
        child.emit("exit", 0, null);
        return true;
    };
    let buffered = "";
    child.stdin.on("data", (chunk) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop();
        for (const line of lines) {
            const message = JSON.parse(line);
            child.messages.push(message);
            if (message.id === undefined) continue;
            const result = message.method === "account/login/start" ? LOGIN : message.method === "account/read" ? (read?.() ?? { account: null }) : {};
            Promise.resolve(result).then((result) => child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n"));
        }
    });
    return child;
}

test("buffered notifications from a disconnected process cannot override the replacement account read", async (t) => {
    const readStarted = deferred(),
        readResult = deferred();
    t.after(() => readResult.resolve({ account: null }));
    const oldProcess = transport();
    const nextProcess = transport({
        read: () => {
            readStarted.resolve();
            return readResult.promise;
        },
    });
    const children = [oldProcess, nextProcess];
    const client = new CodexAppServerClient({
        spawnProcess: () => {
            const child = children.shift();
            assert.ok(child, "must not start an unexpected process");
            return child;
        },
    });
    t.after(() => client.close());
    await client.login();
    oldProcess.emit("exit", 1, null);
    const status = client.getAccountStatus();
    await readStarted.promise;
    oldProcess.notify("account/updated", { authMode: "chatgpt" });
    oldProcess.notify("account/login/completed", { loginId: LOGIN.loginId, success: true });
    readResult.resolve({ account: null, requiresOpenaiAuth: true });
    assert.equal(await status, "disconnected");
    assert.equal(client.accountStatus, "disconnected");
});
