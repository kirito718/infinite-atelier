import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

import { redactBridgeError } from "./bridge-utils.mjs";
import { isLoginId, publicDeviceLogin } from "./device-login.mjs";

const CLIENT_INFO = { name: "Infinite Atelier", version: "1.0.0" };
// Bound transport initialization and account operations, never long-running
// thread/turn generation requests or the user's device-code authorization wait.
const AUTH_RPC_METHODS = new Set(["initialize", "account/read", "account/login/start", "account/login/cancel", "account/logout"]);

export class CodexAppServerClient extends EventEmitter {
    constructor({ command = "codex", args = ["app-server", "--listen", "stdio://"], spawnProcess = (program, programArgs, options) => spawn(program, programArgs, options), generatedImagesDir = defaultGeneratedImagesDir(), authRpcTimeoutMs = 60_000 } = {}) {
        super();
        // Node clamps invalid/overflowing timer delays to 1ms; reject them instead.
        if (!Number.isInteger(authRpcTimeoutMs) || authRpcTimeoutMs < 1 || authRpcTimeoutMs > 2_147_483_647) {
            throw new RangeError("authRpcTimeoutMs must be an integer between 1 and 2147483647 milliseconds");
        }
        this.authRpcTimeoutMs = authRpcTimeoutMs;
        this.command = command;
        this.args = args;
        this.spawnProcess = spawnProcess;
        this.generatedImagesDir = generatedImagesDir;
        this.status = "disconnected";
        this.accountStatus = "disconnected";
        this.nextId = 1;
        this.pending = new Map();
        this.turns = new Map();
        this.earlyTurns = new Map();
        this.child = null;
        this.lines = null;
        this.connectPromise = null;
        this.authEpoch = 0;
        this.lifecycleEpoch = 0;
        this.authQueue = Promise.resolve();
        this.loginAttempt = null;
        this.loginPromise = null;
        this.logoutPromise = null;
    }

    async connect() {
        if (this.status === "connected") return;
        if (this.connectPromise) return this.connectPromise;

        this.status = "connecting";
        this.connectPromise = this.initializeConnection();
        try {
            await this.connectPromise;
            this.status = "connected";
        } catch (error) {
            this.status = "unavailable";
            throw bridgeError(error);
        } finally {
            this.connectPromise = null;
        }
    }

    async readAccount() {
        await this.connect();
        const epoch = this.authEpoch;
        const account = await this.sendRequest("account/read", { refreshToken: false });
        if (epoch === this.authEpoch) this.accountStatus = this.loginAttempt || this.loginPromise ? "connecting" : account?.account ? "connected" : "disconnected";
        return account;
    }

    async getAccountStatus() {
        if (this.loginAttempt || this.loginPromise) return "connecting";
        const epoch = this.authEpoch;
        if (this.status !== "connected") {
            try {
                await this.connect();
            } catch {
                return this.status === "connecting" ? "connecting" : "unavailable";
            }
        }
        try {
            await this.readAccount();
        } catch {
            if (epoch === this.authEpoch) this.accountStatus = this.status === "unavailable" ? "unavailable" : "disconnected";
        }
        return this.accountStatus;
    }

    enqueueAuth(operation) {
        const lifecycle = this.lifecycleEpoch;
        const check = () => {
            if (lifecycle !== this.lifecycleEpoch) throw new Error("Codex 登录连接已关闭，请重新连接。");
        };
        const queued = this.authQueue.then(() => {
            check();
            return operation(check);
        });
        this.authQueue = queued.catch(() => {});
        return queued;
    }

    async login() {
        // Capture before any await: an older caller waiting for logout must not
        // become a brand-new authorization request after close/reconnection.
        const lifecycle = this.lifecycleEpoch;
        if (this.logoutPromise) await this.logoutPromise;
        if (lifecycle !== this.lifecycleEpoch) throw new Error("Codex 登录连接已关闭，请重新连接。");
        if (this.loginPromise) return this.loginPromise;
        if (this.loginAttempt?.result) return { ...this.loginAttempt.result };
        const promise = this.enqueueAuth(async (check) => {
            const attempt = { loginId: null, result: null, completions: new Map() };
            this.loginAttempt = attempt;
            this.authEpoch++;
            this.accountStatus = "connecting";
            let result;
            try {
                await this.connect();
                check();
                result = await this.sendRequest("account/login/start", { type: "chatgptDeviceCode" });
                check();
                const login = publicDeviceLogin(result);
                attempt.loginId = login.loginId;
                attempt.result = login;
                const early = attempt.completions.get(login.loginId);
                attempt.completions.clear();
                if (early) this.finishLogin(attempt, early.success === true);
                return { ...login };
            } catch (error) {
                // A malformed/legacy response must not leave an invisible login
                // alive; never send an old cancellation into a replacement process.
                if (this.loginAttempt === attempt && isLoginId(result?.loginId) && this.status === "connected") {
                    await this.sendRequest("account/login/cancel", { loginId: result.loginId }).catch(() => {});
                }
                this.finishLogin(attempt, false);
                throw error;
            }
        });
        this.loginPromise = promise;
        try {
            return await promise;
        } finally {
            if (this.loginPromise === promise) this.loginPromise = null;
        }
    }

    finishLogin(attempt, success) {
        if (this.loginAttempt !== attempt) return;
        attempt.result = null;
        attempt.completions.clear();
        this.loginAttempt = null;
        this.authEpoch++;
        this.accountStatus = success ? "connected" : "disconnected";
    }

    async cancelLogin(loginId) {
        return this.enqueueAuth(async (check) => {
            const attempt = this.loginAttempt;
            if (!attempt || attempt.loginId !== loginId) return;
            await this.sendRequest("account/login/cancel", { loginId });
            check();
            this.finishLogin(attempt, false);
        });
    }

    async logout() {
        if (this.logoutPromise) return this.logoutPromise;
        const promise = this.enqueueAuth(async (check) => {
            await this.connect();
            check();
            const attempt = this.loginAttempt;
            if (attempt?.loginId) {
                await this.sendRequest("account/login/cancel", { loginId: attempt.loginId });
                check();
                this.finishLogin(attempt, false);
            }
            await this.sendRequest("account/logout");
            check();
            this.authEpoch++;
            this.accountStatus = "disconnected";
        });
        this.logoutPromise = promise;
        try {
            await promise;
        } finally {
            if (this.logoutPromise === promise) this.logoutPromise = null;
        }
    }

    invalidateAuth() {
        if (this.loginAttempt) this.finishLogin(this.loginAttempt, false);
        this.lifecycleEpoch++;
        this.authEpoch++;
        this.loginPromise = null;
        this.logoutPromise = null;
        this.accountStatus = "disconnected";
    }

    async generateImage({ prompt, references = [], workDir, signal } = {}) {
        await this.connect();
        throwIfAborted(signal);

        const threadResult = await this.sendRequest("thread/start", {
            cwd: workDir,
            approvalPolicy: "never",
            sandbox: "workspace-write",
            serviceName: "infinite_atelier",
            ephemeral: true,
        });
        const threadId = threadResult?.thread?.id;
        if (!threadId) throw new Error("Codex did not return a thread id");

        const turnResult = await this.sendRequest("turn/start", {
            threadId,
            input: [{ type: "text", text: `$imagegen ${prompt}` }, ...references.map((path) => ({ type: "localImage", path }))],
        });
        const turnId = turnResult?.turn?.id;
        if (!turnId) throw new Error("Codex did not return a turn id");

        return this.waitForTurn({ threadId, turnId, workDir, signal });
    }

    async cancel({ threadId, turnId }) {
        await this.connect();
        await this.sendRequest("turn/interrupt", { threadId, turnId });
    }

    async close() {
        this.lines?.close();
        this.lines = null;
        if (this.child) {
            const child = this.child;
            this.child = null;
            child.kill();
        }
        this.invalidateAuth();
        this.rejectPending(new Error("Codex app-server connection closed"));
        this.status = "disconnected";
        this.accountStatus = "disconnected";
    }

    async initializeConnection() {
        const child = this.spawnProcess(this.command, this.args, {
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;
        const lines = createInterface({ input: child.stdout });
        this.lines = lines;
        lines.on("line", (line) => {
            if (this.child === child && this.lines === lines) this.handleLine(line);
        });
        child.stderr?.on("data", (chunk) => {
            if (this.child !== child) return;
            const diagnostic = redactBridgeError(chunk.toString().trim());
            if (diagnostic) this.emit("diagnostic", diagnostic);
        });
        child.once("error", (error) => {
            if (this.child === child) this.handleDisconnect(error);
        });
        child.once("exit", (code, signal) => {
            if (this.child === child) this.handleDisconnect(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
        });

        await this.sendRequest("initialize", { clientInfo: CLIENT_INFO });
        this.sendNotification("initialized", {});
    }

    sendRequest(method, params) {
        const child = this.child;
        if (!child?.stdin?.writable) {
            return Promise.reject(new Error("Codex app-server is not connected"));
        }

        const id = this.nextId;
        this.nextId += 1;
        const message = params === undefined ? { method, id } : { method, id, params };
        return new Promise((resolve, reject) => {
            let timer;
            const settle = (handler) => (value) => {
                if (timer !== undefined) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                handler(value);
            };
            const pending = { resolve: settle(resolve), reject: settle(reject) };
            this.pending.set(id, pending);
            if (AUTH_RPC_METHODS.has(method)) {
                const timeoutMs = this.authRpcTimeoutMs;
                timer = setTimeout(() => {
                    // A completed request or a replacement transport is never
                    // owned by this deadline, even if its callback was queued.
                    if (this.child !== child || this.pending.get(id) !== pending) return;
                    this.handleDisconnect(new Error(`Codex ${method} timed out after ${timeoutMs}ms; reconnect and retry.`));
                }, timeoutMs);
            }
            const fail = (error) => {
                if (this.pending.get(id) !== pending) return;
                this.pending.delete(id);
                pending.reject(bridgeError(error));
            };
            try {
                child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
                    if (error) fail(error);
                });
            } catch (error) {
                fail(error);
            }
        });
    }

    sendNotification(method, params) {
        if (!this.child?.stdin?.writable) throw new Error("Codex app-server is not connected");
        this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }

    handleLine(line) {
        let message;
        try {
            message = parseJsonRpcLine(line);
        } catch (error) {
            this.emit("diagnostic", bridgeError(error).message);
            return;
        }

        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error !== undefined) {
                pending.reject(bridgeError(message.error?.message ?? "Codex request failed"));
            } else {
                pending.resolve(message.result);
            }
            return;
        }

        if (message.method) this.handleNotification(message.method, message.params ?? {});
    }

    handleNotification(method, params) {
        this.emit("notification", { method, params });
        this.emit(method, params);

        if (method === "account/updated") {
            if (this.loginAttempt || this.logoutPromise) return;
            if (params.authMode === null || typeof params.authMode === "string") {
                this.authEpoch++;
                this.accountStatus = params.authMode ? "connected" : "disconnected";
            }
            return;
        }

        if (method === "account/login/completed") {
            const attempt = this.loginAttempt;
            if (!attempt || !isLoginId(params.loginId)) return;
            if (!attempt.loginId) {
                // A response and its completion may arrive in one stdout chunk,
                // before the awaited start response resumes its microtask.
                if (attempt.completions.size < 16) attempt.completions.set(params.loginId, { success: params.success === true });
            } else if (params.loginId === attempt.loginId) this.finishLogin(attempt, params.success === true);
            return;
        }

        if (method === "item/completed" && params.item?.type === "imageGeneration") {
            const key = turnKey(params.threadId, params.turnId);
            const turn = this.turns.get(key) ?? this.earlyTurns.get(key) ?? { imageItems: [] };
            appendImageItem(turn, params.item);
            if (!this.turns.has(key)) this.earlyTurns.set(key, turn);
            return;
        }

        if (method === "turn/completed") {
            const key = turnKey(params.threadId, params.turn?.id);
            const turn = this.turns.get(key) ?? this.earlyTurns.get(key) ?? { imageItems: [] };
            for (const item of params.turn?.items || []) appendImageItem(turn, item);
            turn.completed = params.turn;
            if (this.turns.has(key)) this.finishTurn(key, turn);
            else this.earlyTurns.set(key, turn);
        }
    }

    waitForTurn({ threadId, turnId, workDir, signal }) {
        const key = turnKey(threadId, turnId);
        return new Promise((resolve, reject) => {
            const abort = () => {
                this.turns.delete(key);
                this.earlyTurns.delete(key);
                void this.sendRequest("turn/interrupt", { threadId, turnId }).catch(() => {});
                reject(signal.reason ?? abortError());
            };
            if (signal?.aborted) {
                abort();
                return;
            }
            signal?.addEventListener("abort", abort, { once: true });
            const turn = this.earlyTurns.get(key) ?? { imageItems: [] };
            this.earlyTurns.delete(key);
            Object.assign(turn, {
                resolve,
                reject,
                workDir,
                removeAbortListener: () => signal?.removeEventListener("abort", abort),
            });
            this.turns.set(key, turn);
            if (turn.completed) this.finishTurn(key, turn);
        });
    }

    finishTurn(key, turn) {
        this.turns.delete(key);
        this.earlyTurns.delete(key);
        turn.removeAbortListener();
        if (turn.completed.status === "completed") {
            Promise.all(turn.imageItems.map((item) => readImageItem(item, turn.workDir, this.generatedImagesDir))).then(
                (files) => turn.resolve({ files: files.filter(Boolean) }),
                (error) => turn.reject(bridgeError(error)),
            );
        } else {
            const message = turn.completed.error?.message ?? `Codex turn ${turn.completed.status}`;
            turn.reject(bridgeError(message));
        }
    }

    handleDisconnect(error) {
        const child = this.child;
        this.child = null;
        this.lines?.close();
        this.lines = null;
        // On an error rather than a normal exit, stop only this owned transport.
        if (child?.exitCode === null && child?.signalCode === null) child.kill();
        this.invalidateAuth();
        if (this.status !== "disconnected") this.status = "unavailable";
        this.rejectPending(error);
        for (const turn of this.turns.values()) {
            turn.removeAbortListener();
            turn.reject(bridgeError(error));
        }
        this.turns.clear();
        this.earlyTurns.clear();
    }

    rejectPending(error) {
        for (const pending of this.pending.values()) pending.reject(bridgeError(error));
        this.pending.clear();
    }
}

function appendImageItem(turn, item) {
    if (item?.type !== "imageGeneration" || turn.imageItems.some((candidate) => candidate.id === item.id)) return;
    turn.imageItems.push(item);
}

export function createCodexAppServerClient(options) {
    return new CodexAppServerClient(options);
}

export function parseJsonRpcLine(line) {
    const value = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid Codex app-server message");
    }
    return value;
}

async function readImageItem(item, workDir, generatedImagesDir) {
    const data = decodeImageData(item.result);
    if (data) return { ...data, name: `generated-${item.id}${extensionForImageMime(data.mimeType)}` };
    if (!item.savedPath) throw new Error("Codex image result did not include image data");
    const allowedRoot = isContained(workDir, item.savedPath) ? workDir : generatedImagesDir;
    if (!isContained(allowedRoot, item.savedPath)) {
        throw new Error("Codex saved image path is outside the task directory");
    }
    const containedPath = await requireContainedRealPath(allowedRoot, item.savedPath);
    return {
        bytes: await readFile(containedPath),
        mimeType: mimeTypeForPath(item.savedPath),
        name: basename(item.savedPath),
    };
}

function defaultGeneratedImagesDir() {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    return join(codexHome, "generated_images");
}

async function requireContainedRealPath(directory, path) {
    const [realDirectory, realPath] = await Promise.all([realpath(directory), realpath(path)]);
    if (!isContained(realDirectory, realPath)) {
        throw new Error("Codex saved image path is outside the task directory");
    }
    return realPath;
}

function isContained(directory, path) {
    if (typeof directory !== "string" || typeof path !== "string" || !isAbsolute(directory) || !isAbsolute(path)) {
        return false;
    }
    const rel = relative(resolve(directory), resolve(path));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function decodeImageData(value) {
    if (typeof value !== "string") return null;
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value);
    if (match) return { mimeType: match[1].toLowerCase(), bytes: Buffer.from(match[2], "base64") };

    const encoded = value.replace(/\s+/g, "");
    if (!/^[a-z0-9+/]+={0,2}$/i.test(encoded) || encoded.length % 4 === 1) return null;
    const bytes = Buffer.from(encoded, "base64");
    const mimeType = detectImageMime(bytes);
    return mimeType ? { mimeType, bytes } : null;
}

function detectImageMime(bytes) {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
    if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
    if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp" && ["avif", "avis"].includes(bytes.subarray(8, 12).toString("ascii"))) return "image/avif";
    return null;
}

function mimeTypeForPath(path) {
    const extension = extname(path).toLowerCase();
    return (
        {
            ".avif": "image/avif",
            ".gif": "image/gif",
            ".jpeg": "image/jpeg",
            ".jpg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
        }[extension] ?? "application/octet-stream"
    );
}

function extensionForImageMime(mimeType) {
    return (
        {
            "image/avif": ".avif",
            "image/gif": ".gif",
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/svg+xml": ".svg",
            "image/webp": ".webp",
        }[mimeType] ?? ".img"
    );
}

function turnKey(threadId, turnId) {
    return `${threadId}:${turnId}`;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason ?? abortError();
}

function abortError() {
    return new DOMException("Image generation cancelled", "AbortError");
}

function bridgeError(value) {
    const message = value instanceof Error ? value.message : String(value);
    const error = new Error(redactBridgeError(message));
    if (value?.name === "AbortError") error.name = "AbortError";
    return error;
}
