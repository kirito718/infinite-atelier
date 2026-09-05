import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

import { redactBridgeError } from "./bridge-utils.mjs";

const CLIENT_INFO = { name: "Infinite Atelier", version: "1.0.0" };

export class CodexAppServerClient extends EventEmitter {
    constructor({ command = "codex", args = ["app-server", "--listen", "stdio://"], spawnProcess = (program, programArgs, options) => spawn(program, programArgs, options) } = {}) {
        super();
        this.command = command;
        this.args = args;
        this.spawnProcess = spawnProcess;
        this.status = "disconnected";
        this.nextId = 1;
        this.pending = new Map();
        this.turns = new Map();
        this.earlyTurns = new Map();
        this.child = null;
        this.lines = null;
        this.connectPromise = null;
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
        return this.sendRequest("account/read", { refreshToken: false });
    }

    async login() {
        await this.connect();
        const result = await this.sendRequest("account/login/start", {
            type: "chatgpt",
            useHostedLoginSuccessPage: true,
            appBrand: "codex",
        });
        return { authUrl: result.authUrl };
    }

    async logout() {
        await this.connect();
        await this.sendRequest("account/logout");
    }

    async generateImage({ prompt, references = [], workDir, signal } = {}) {
        await this.connect();
        throwIfAborted(signal);

        const threadResult = await this.sendRequest("thread/start", {
            cwd: workDir,
            approvalPolicy: "never",
            sandbox: "workspaceWrite",
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
            this.child.kill();
            this.child = null;
        }
        this.rejectPending(new Error("Codex app-server connection closed"));
        this.status = "disconnected";
    }

    async initializeConnection() {
        const child = this.spawnProcess(this.command, this.args, {
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;
        this.lines = createInterface({ input: child.stdout });
        this.lines.on("line", (line) => this.handleLine(line));
        child.stderr?.on("data", (chunk) => {
            const diagnostic = redactBridgeError(chunk.toString().trim());
            if (diagnostic) this.emit("diagnostic", diagnostic);
        });
        child.once("error", (error) => this.handleDisconnect(error));
        child.once("exit", (code, signal) => {
            this.handleDisconnect(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
        });

        await this.sendRequest("initialize", { clientInfo: CLIENT_INFO });
        this.sendNotification("initialized", {});
    }

    sendRequest(method, params) {
        if (!this.child?.stdin?.writable) {
            return Promise.reject(new Error("Codex app-server is not connected"));
        }

        const id = this.nextId;
        this.nextId += 1;
        const message = params === undefined ? { method, id } : { method, id, params };
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
                if (!error) return;
                this.pending.delete(id);
                reject(bridgeError(error));
            });
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

        if (method === "item/completed" && params.item?.type === "imageGeneration") {
            const key = turnKey(params.threadId, params.turnId);
            const turn = this.turns.get(key) ?? this.earlyTurns.get(key) ?? { imageItems: [] };
            turn.imageItems.push(params.item);
            if (!this.turns.has(key)) this.earlyTurns.set(key, turn);
            return;
        }

        if (method === "turn/completed") {
            const key = turnKey(params.threadId, params.turn?.id);
            const turn = this.turns.get(key) ?? this.earlyTurns.get(key) ?? { imageItems: [] };
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
            Promise.all(turn.imageItems.map((item) => readImageItem(item, turn.workDir))).then(
                (files) => turn.resolve({ files: files.filter(Boolean) }),
                (error) => turn.reject(bridgeError(error)),
            );
        } else {
            const message = turn.completed.error?.message ?? `Codex turn ${turn.completed.status}`;
            turn.reject(bridgeError(message));
        }
    }

    handleDisconnect(error) {
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

async function readImageItem(item, workDir) {
    const data = decodeImageData(item.result);
    if (data) return { ...data, name: `generated-${item.id}${extensionForImageMime(data.mimeType)}` };
    if (!item.savedPath) throw new Error("Codex image result did not include image data");
    if (!isContained(workDir, item.savedPath)) {
        throw new Error("Codex saved image path is outside the task directory");
    }
    return {
        bytes: await readFile(item.savedPath),
        mimeType: mimeTypeForPath(item.savedPath),
        name: basename(item.savedPath),
    };
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
    if (!match) return null;
    return { mimeType: match[1].toLowerCase(), bytes: Buffer.from(match[2], "base64") };
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
