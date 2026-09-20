#!/usr/bin/env node
// Test-only stdio peer. It never contacts OpenAI or reads/writes real auth.json.
// Install only in an isolated acceptance container, never in a production PATH.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

const home = process.env.CODEX_HOME;
if (process.env.ATELIER_QA_DEVICE_FIXTURE !== "1" || !home || !isAbsolute(home) || process.argv.slice(2).join(" ") !== "app-server --listen stdio://") {
    process.stderr.write("This test-only Codex peer is disabled.\n");
    process.exit(64);
}
mkdirSync(home, { recursive: true, mode: 0o700 });
const sessionFile = join(home, ".atelier-qa-session.json");
const controlFile = join(home, ".atelier-qa-control.json");
const wireFile = join(home, ".atelier-qa-wire.jsonl");
let authorized = existsSync(sessionFile) && JSON.parse(readFileSync(sessionFile, "utf8")).connected === true;
let pending = null;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method, params) => send({ method, params });
function complete(loginId, success) {
    if (!pending || loginId !== pending.loginId) return;
    pending = null;
    if (success) {
        authorized = true;
        writeFileSync(sessionFile, JSON.stringify({ fixture: true, connected: true }), { mode: 0o600 });
    }
    notify("account/login/completed", { loginId, success, error: success ? null : "Fixture authorization declined" });
    notify("account/updated", { authMode: authorized ? "chatgpt" : null, planType: null });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
    const message = JSON.parse(line);
    appendFileSync(wireFile, JSON.stringify({ method: message.method, ...(message.method === "account/login/start" && { loginType: message.params?.type }), ...(message.params?.loginId && { loginId: message.params.loginId }) }) + "\n", { mode: 0o600 });
    if (message.id === undefined) return;
    const reply = (result) => send({ id: message.id, result });
    switch (message.method) {
        case "initialize":
            return reply({ userAgent: "atelier-test-fixture" });
        case "account/read":
            return reply({ account: authorized ? { type: "chatgpt", email: "fixture@example.invalid", planType: "unknown" } : null, requiresOpenaiAuth: true });
        case "account/login/start": {
            if (message.params?.type !== "chatgptDeviceCode") return send({ id: message.id, error: { code: -32602, message: "Fixture refuses browser/loopback OAuth" } });
            const loginId = randomUUID();
            pending = { type: "chatgptDeviceCode", loginId, verificationUrl: "https://auth.openai.com/codex/device", userCode: `TEST-ONLY-${loginId.slice(0, 8)}` };
            return reply(pending);
        }
        case "account/login/cancel": {
            const matches = pending?.loginId === message.params?.loginId;
            reply({ status: matches ? "canceled" : "notFound" });
            if (matches) complete(message.params.loginId, false);
            return;
        }
        case "account/logout": {
            pending = null;
            authorized = false;
            if (existsSync(sessionFile)) unlinkSync(sessionFile);
            reply({});
            return notify("account/updated", { authMode: null, planType: null });
        }
        default:
            return send({ id: message.id, error: { code: -32601, message: "Test peer only supports account operations" } });
    }
});
const timer = setInterval(() => {
    if (!existsSync(controlFile)) return;
    let command;
    try {
        command = JSON.parse(readFileSync(controlFile, "utf8"));
    } catch {
        return;
    }
    unlinkSync(controlFile);
    if (command.action === "complete" || command.action === "fail") complete(command.loginId, command.action === "complete");
}, 25);
timer.unref();
lines.on("close", () => {
    clearInterval(timer);
    process.exit(0);
});
