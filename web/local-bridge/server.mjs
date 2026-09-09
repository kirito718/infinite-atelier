import { isLoginId, publicDeviceLogin } from "./device-login.mjs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { redactBridgeError, requireBridgeRequest, terminalTask } from "./bridge-utils.mjs";
import { createCodexAppServerClient } from "./app-server-client.mjs";

const DEFAULT_CLEANUP_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export function createBridgeServer({ secret, codex = createCodexAppServerClient(), cleanupMs = DEFAULT_CLEANUP_MS, tempRoot = tmpdir() } = {}) {
    if (typeof secret !== "string" || secret.length === 0) {
        throw new Error("A bridge secret is required");
    }

    const api = createCodexSubscriptionApi({ codex, cleanupMs, tempRoot, publicBasePath: "", endpointLabel: "Bridge" });
    const server = createServer(async (request, response) => {
        try {
            requireBridgeRequest(request, secret);
        } catch (error) {
            sendJson(response, 401, { error: redactBridgeError(error.message) });
            return;
        }

        try {
            await api.handle(request, response);
        } catch (error) {
            const statusCode = error instanceof HttpError ? error.statusCode : 500;
            sendJson(response, statusCode, { error: sanitizeDiagnostic(error) });
        }
    });

    server.on("close", () => void api.close());

    return server;
}

export function createCodexSubscriptionApi({ codex = createCodexAppServerClient(), cleanupMs = DEFAULT_CLEANUP_MS, tempRoot = tmpdir(), publicBasePath = "/api/codex-subscription", endpointLabel = "Codex subscription" } = {}) {
    const tasks = new Map();
    let closed = false;

    return {
        handle: async (request, response) => {
            try {
                await routeRequest({ request, response, codex, tasks, cleanupMs, tempRoot, publicBasePath, endpointLabel });
            } catch (error) {
                const statusCode = error instanceof HttpError ? error.statusCode : 500;
                sendJson(response, statusCode, { error: sanitizeDiagnostic(error, undefined, `${endpointLabel} request failed`) });
            }
        },
        close: async () => {
            if (closed) return;
            closed = true;
            for (const task of tasks.values()) {
                clearTimeout(task.cleanupTimer);
                task.controller.abort(abortError());
                void cleanupTaskFiles(task);
            }
            await codex.close?.();
        },
    };
}

async function routeRequest({ request, response, codex, tasks, cleanupMs, tempRoot, publicBasePath, endpointLabel }) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    const pathname = normalizeBridgePath(url.pathname);

    if (method === "GET" && pathname === "/v1/status") {
        const rawStatus = typeof codex.getAccountStatus === "function" ? await codex.getAccountStatus() : typeof codex.getStatus === "function" ? codex.getStatus() : codex.status;
        const status = ["disconnected", "connecting", "connected", "unavailable"].includes(rawStatus) ? rawStatus : "unavailable";
        sendJson(response, 200, { status });
        return;
    }

    if (method === "POST" && pathname === "/v1/login") {
        const result = publicDeviceLogin(await codex.login());
        sendJson(response, 200, result);
        return;
    }

    if (method === "POST" && pathname === "/v1/login/cancel") {
        const body = await readJsonBody(request);
        if (!isLoginId(body?.loginId)) throw new HttpError(400, "A valid loginId is required");
        await codex.cancelLogin(body.loginId);
        response.writeHead(204).end();
        return;
    }

    if (method === "POST" && pathname === "/v1/logout") {
        await codex.logout();
        response.writeHead(204).end();
        return;
    }

    if (method === "POST" && pathname === "/v1/images") {
        const body = await readJsonBody(request);
        const input = validateImageRequest(body);
        const task = await createImageTask({ input, codex, tasks, cleanupMs, tempRoot });
        sendJson(response, 202, { taskId: task.id });
        return;
    }

    const taskMatch = /^\/v1\/images\/([0-9a-f-]+)$/i.exec(pathname);
    if (taskMatch) {
        const task = tasks.get(taskMatch[1]);
        if (!task) throw new HttpError(404, "Image task not found");

        if (method === "GET") {
            sendJson(response, 200, publicTask(task, publicBasePath));
            return;
        }
        if (method === "DELETE") {
            clearTimeout(task.cleanupTimer);
            if (!terminalTask(task.status)) task.controller.abort(abortError());
            task.status = "cancelled";
            task.files = [];
            delete task.error;
            await cleanupTaskFiles(task);
            scheduleTaskExpiry(task, tasks, cleanupMs);
            response.writeHead(204).end();
            return;
        }
    }

    const fileMatch = /^\/v1\/images\/([0-9a-f-]+)\/files\/([0-9a-f-]+)$/i.exec(pathname);
    if (method === "GET" && fileMatch) {
        const task = tasks.get(fileMatch[1]);
        const file = task?.files.find((candidate) => candidate.fileId === fileMatch[2]);
        if (!task || !file || task.status !== "succeeded" || !isContained(task.workDir, file.path)) {
            throw new HttpError(404, "Generated image not found");
        }
        const bytes = await readFile(file.path);
        response.writeHead(200, {
            "content-type": file.mimeType,
            "content-length": bytes.length,
            "content-disposition": `attachment; filename="${headerFileName(file.name)}"`,
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
        });
        response.end(bytes);
        return;
    }

    throw new HttpError(404, `${endpointLabel} endpoint not found`);
}

function normalizeBridgePath(pathname) {
    if (pathname === "/api/codex-subscription") return "/";
    if (pathname.startsWith("/api/codex-subscription/")) return pathname.slice("/api/codex-subscription".length);
    if (pathname === "/codex-local") return "/";
    if (pathname.startsWith("/codex-local/")) return pathname.slice("/codex-local".length);
    return pathname;
}

async function createImageTask({ input, codex, tasks, cleanupMs, tempRoot }) {
    const workDir = await mkdtemp(join(tempRoot, "infinite-atelier-image-"));
    const task = {
        id: randomUUID(),
        status: "generating",
        files: [],
        workDir,
        controller: new AbortController(),
        cleanupTimer: null,
    };

    try {
        const references = [];
        for (let index = 0; index < input.references.length; index += 1) {
            const decoded = decodeDataImage(input.references[index]);
            const path = join(workDir, `reference-${index}${extensionForMime(decoded.mimeType)}`);
            await writeFile(path, decoded.bytes, { flag: "wx" });
            references.push(path);
        }

        tasks.set(task.id, task);
        queueMicrotask(() => {
            void runImageTask({
                task,
                codex,
                input: { ...input, references },
                cleanupMs,
                tasks,
            });
        });
        return task;
    } catch (error) {
        await cleanupTaskFiles(task);
        throw error;
    }
}

async function runImageTask({ task, codex, input, cleanupMs, tasks }) {
    try {
        const result = await codex.generateImage({
            prompt: input.prompt,
            operation: input.operation,
            references: input.references,
            workDir: task.workDir,
            signal: task.controller.signal,
        });
        if (task.controller.signal.aborted) throw task.controller.signal.reason ?? abortError();
        if (!Array.isArray(result?.files) || result.files.length === 0) {
            throw new Error("Codex did not return an image output");
        }

        const stagedFiles = [];
        for (const candidate of result.files) {
            if (task.controller.signal.aborted) throw task.controller.signal.reason ?? abortError();
            if (typeof candidate?.mimeType !== "string" || !candidate.mimeType.startsWith("image/")) {
                throw new Error("Codex returned a non-image output");
            }
            const bytes = await containedOutputBytes(candidate, task.workDir);
            const fileId = randomUUID();
            const name = safeOutputName(candidate.name, candidate.mimeType, stagedFiles.length);
            const path = join(task.workDir, `${fileId}${extensionForMime(candidate.mimeType)}`);
            await writeFile(path, bytes, { flag: "wx" });
            stagedFiles.push({ fileId, name, mimeType: candidate.mimeType, size: bytes.length, path });
        }

        task.files = stagedFiles;
        task.status = "succeeded";
        scheduleTaskExpiry(task, tasks, cleanupMs);
    } catch (error) {
        task.files = [];
        const cancelled = task.controller.signal.aborted || error?.name === "AbortError";
        const diagnostic = cancelled ? undefined : sanitizeDiagnostic(error, task.workDir);
        await cleanupTaskFiles(task);
        task.status = cancelled ? "cancelled" : "failed";
        if (diagnostic) task.error = diagnostic;
        else delete task.error;
        scheduleTaskExpiry(task, tasks, cleanupMs);
    }
}

function scheduleTaskExpiry(task, tasks, cleanupMs) {
    clearTimeout(task.cleanupTimer);
    task.cleanupTimer = setTimeout(() => {
        void cleanupTaskFiles(task).finally(() => tasks.delete(task.id));
    }, cleanupMs);
    task.cleanupTimer.unref?.();
}

function validateImageRequest(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "Request body must be a JSON object");
    }
    if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
        throw new HttpError(400, "Prompt must not be empty");
    }
    if (!Array.isArray(body.references ?? [])) {
        throw new HttpError(400, "References must be an array");
    }
    const operation = body.operation ?? ((body.references?.length ?? 0) > 0 ? "edit" : "generate");
    if (operation !== "generate" && operation !== "edit") {
        throw new HttpError(400, "Operation must be generate or edit; video is not supported");
    }
    for (const reference of body.references ?? []) {
        if (typeof reference !== "string" || !reference.startsWith("data:image/")) {
            throw new HttpError(400, "References must be data:image values; video is not supported");
        }
    }
    return { prompt: body.prompt.trim(), operation, references: body.references ?? [] };
}

function decodeDataImage(value) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value);
    if (!match) throw new HttpError(400, "Reference must be a base64 data:image value");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length === 0) throw new HttpError(400, "Reference image must not be empty");
    return { mimeType: match[1].toLowerCase(), bytes };
}

async function containedOutputBytes(candidate, workDir) {
    if (Buffer.isBuffer(candidate.bytes)) return candidate.bytes;
    if (candidate.bytes instanceof Uint8Array) return Buffer.from(candidate.bytes);
    if (typeof candidate.path === "string" && isContained(workDir, candidate.path)) {
        const containedPath = await requireContainedRealPath(workDir, candidate.path);
        return readFile(containedPath);
    }
    throw new Error("Codex image output was not task-contained");
}

async function requireContainedRealPath(directory, path) {
    const [realDirectory, realPath] = await Promise.all([realpath(directory), realpath(path)]);
    if (!isContained(realDirectory, realPath)) {
        throw new Error("Codex image output was not task-contained");
    }
    return realPath;
}

function publicTask(task, publicBasePath) {
    const basePath = publicBasePath ? `${publicBasePath}/v1` : "/v1";
    const result = {
        taskId: task.id,
        status: task.status,
        files: task.files.map((file) => ({
            fileId: file.fileId,
            name: file.name,
            mimeType: file.mimeType,
            size: file.size,
            url: `${basePath}/images/${task.id}/files/${file.fileId}`,
        })),
    };
    if (task.error) result.error = task.error;
    return result;
}

async function readJsonBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
        throw new HttpError(400, "Request body must contain valid JSON");
    }
}

async function cleanupTaskFiles(task) {
    if (task.cleaned) return;
    task.cleaned = true;
    await rm(task.workDir, { recursive: true, force: true });
}

function sendJson(response, statusCode, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    response.writeHead(statusCode, {
        "content-type": "application/json; charset=utf-8",
        "content-length": bytes.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
    });
    response.end(bytes);
}

function isContained(directory, path) {
    if (typeof path !== "string" || !isAbsolute(path)) return false;
    const child = resolve(path);
    const rel = relative(resolve(directory), child);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function safeOutputName(value, mimeType, index) {
    const safeBase = typeof value === "string" ? basename(value).replace(/[^a-z0-9._ -]/gi, "_") : "";
    return safeBase || `generated-${index + 1}${extensionForMime(mimeType)}`;
}

function headerFileName(value) {
    return value.replace(/["\\\r\n]/g, "_");
}

function extensionForMime(mimeType) {
    return (
        {
            "image/avif": ".avif",
            "image/gif": ".gif",
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/svg+xml": ".svg",
            "image/webp": ".webp",
        }[mimeType.toLowerCase()] ?? ".img"
    );
}

function sanitizeDiagnostic(error, workDir, fallback = "Bridge request failed") {
    let message = redactBridgeError(error instanceof Error ? error.message : String(error));
    if (workDir) message = message.split(workDir).join("[path]");
    message = message.replace(/(^|[^A-Za-z0-9_/])(?:\/[^\s'"\])}>;,]+|[A-Za-z]:\\[^\s'"\])}>;,]+)/g, "$1[path]");
    return message || fallback;
}

function abortError() {
    return new DOMException("Image generation cancelled", "AbortError");
}

class HttpError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}
