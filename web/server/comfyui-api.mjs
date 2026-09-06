import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import { selectComfyUiOutput } from "./comfyui-client.mjs";
import { ComfyUiTaskStoreError } from "./comfyui-task-store.mjs";

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_HISTORY_POLL_MS = 500;
const DEFAULT_HISTORY_TIMEOUT_MS = 120_000;
const MAX_SOURCE_IMAGE_DIMENSION = 8192;
const MAX_SOURCE_IMAGE_PIXELS = MAX_SOURCE_IMAGE_DIMENSION * MAX_SOURCE_IMAGE_DIMENSION;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/webp"]);

export function createComfyUiApi({ client, registry, store, maxBytes = DEFAULT_MAX_BYTES, parseMultipart = parseMultipartRequest, historyPollMs = DEFAULT_HISTORY_POLL_MS, historyTimeoutMs = DEFAULT_HISTORY_TIMEOUT_MS } = {}) {
    if (!client || typeof client.uploadImage !== "function" || typeof client.queuePrompt !== "function") throw new Error("A ComfyUI client is required");
    if (!registry || typeof registry.get !== "function" || typeof registry.patch !== "function") throw new Error("A workflow registry is required");
    if (!store || typeof store.create !== "function" || typeof store.get !== "function") throw new Error("A ComfyUI task store is required");
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive number");
    if (typeof parseMultipart !== "function") throw new Error("parseMultipart must be a function");

    const active = new Map();
    const cancellations = new Map();
    let closed = false;

    return {
        async handle(request, response) {
            if (closed) {
                sendError(response, 503, "COMFYUI_API_CLOSED", "ComfyUI API is closed", false);
                return;
            }
            try {
                await routeRequest(request, response);
            } catch (error) {
                if (response.writableEnded) return;
                const normalized = normalizeError(error);
                sendError(response, normalized.status, normalized.code, normalized.message, normalized.retryable);
            }
        },

        async close() {
            if (closed) return;
            closed = true;
            const pending = [...active.entries()].map(([taskId, entry]) => {
                entry.controller.abort();
                return cancelUpstream(taskId, entry, store.get(taskId)?.promptId);
            });
            await Promise.allSettled(pending);
            active.clear();
            cancellations.clear();
            store.close?.();
            await client.close?.();
        },
    };

    async function routeRequest(request, response) {
        // Keep idempotent cancellation outcomes bounded by the task store's TTL.
        for (const taskId of cancellations.keys()) if (!store.get(taskId)) cancellations.delete(taskId);
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const method = String(request.method ?? "GET").toUpperCase();
        const pathname = normalizePath(url.pathname);

        if (method === "POST" && pathname === "/jobs") {
            await createJob(request, response);
            return;
        }

        const match = /^\/jobs\/([^/]+)$/.exec(pathname);
        if (match) {
            const taskId = decodePathPart(match[1]);
            if (method === "GET") {
                sendTask(response, 200, taskId);
                return;
            }
            if (method === "DELETE") {
                await cancelJob(response, taskId);
                return;
            }
        }

        const outputMatch = /^\/jobs\/([^/]+)\/output$/.exec(pathname);
        if (method === "GET" && outputMatch) {
            sendOutput(response, decodePathPart(outputMatch[1]));
            return;
        }

        throw new HttpError(404, "COMFYUI_ROUTE_NOT_FOUND", "ComfyUI job endpoint not found", false);
    }

    async function createJob(request, response) {
        const parsed = await parseMultipart(request, { maxBytes });
        const input = validateJobInput(parsed, registry, maxBytes);
        const requestKey = request.headers?.["idempotency-key"] || input.idempotencyKey;
        const task = store.create({ requestKey, requestFingerprint: requestFingerprint(input), workflowId: input.workflowId });

        if (task.status === "queued" && !active.has(task.taskId)) {
            const controller = new AbortController();
            active.set(task.taskId, { controller, input });
            queueMicrotask(() => void runJob(task.taskId, input, controller));
        }
        sendJson(response, 202, publicTask(store.get(task.taskId)));
    }

    function cancelUpstream(taskId, entry, promptId) {
        if (cancellations.has(taskId)) return cancellations.get(taskId);
        const cancellation = (async () => {
            // A POST may have been accepted before its response arrived. Resolve
            // that response first; cancelling the proposed ID too early is a no-op.
            if (entry?.queuePromise) {
                try {
                    const queued = await entry.queuePromise;
                    promptId = queued?.prompt_id || promptId;
                } catch {
                    // The current pinned upstream honors our proposed UUID. If
                    // only the response was lost, still attempt a scoped cancel.
                }
            }
            if (promptId) {
                if (typeof client.interrupt !== "function") throw new Error("Scoped cancellation is unavailable");
                await client.interrupt(promptId);
            }
        })();
        cancellations.set(taskId, cancellation);
        return cancellation;
    }

    async function cancelJob(response, taskId) {
        const task = store.get(taskId);
        if (!task) throw new HttpError(404, "COMFYUI_TASK_NOT_FOUND", "ComfyUI task not found", false);
        const wasActive = !isTerminal(task.status);
        const cancelled = store.cancel(taskId);
        const entry = active.get(taskId);
        entry?.controller.abort();
        if (wasActive || cancellations.has(taskId)) {
            try {
                await cancelUpstream(taskId, entry, task.promptId);
            } catch {
                throw new HttpError(502, "CANCEL_UNCONFIRMED", "Local generation is cancelled, but upstream cancellation could not be confirmed; check the ComfyUI queue", true);
            }
        }
        sendJson(response, 200, publicTask(cancelled));
    }

    function isJobActive(taskId) {
        const entry = active.get(taskId);
        if (!entry || entry.controller.signal.aborted) return false;
        try {
            const current = store.get(taskId);
            return Boolean(current && !isTerminal(current.status));
        } catch {
            return false;
        }
    }

    function assertJobActive(taskId) {
        if (!isJobActive(taskId)) throw abortError();
    }

    function sendTask(response, status, taskId) {
        const task = store.get(taskId);
        if (!task) throw new HttpError(404, "COMFYUI_TASK_NOT_FOUND", "ComfyUI task not found", false);
        sendJson(response, status, publicTask(task));
    }

    function sendOutput(response, taskId) {
        const task = store.get(taskId);
        if (!task || task.status !== "succeeded" || !task.output?.bytes) {
            throw new HttpError(404, "COMFYUI_OUTPUT_NOT_FOUND", "Generated output is not available", false);
        }
        const bytes = toBuffer(task.output.bytes);
        response.writeHead(200, {
            "content-type": task.output.mimeType,
            "content-length": bytes.length,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
        });
        response.end(bytes);
    }

    async function runJob(taskId, input, controller) {
        const entry = active.get(taskId);
        let phase = "upload";
        try {
            assertJobActive(taskId);
            store.update(taskId, { status: "uploading" });
            const [pose, depth] = await Promise.all([
                client.uploadImage({ bytes: input.pose.bytes, filename: `pose-${taskId}.png`, mimeType: input.pose.mimeType, subfolder: "atelier", signal: controller.signal }),
                client.uploadImage({ bytes: input.depth.bytes, filename: `depth-${taskId}.png`, mimeType: input.depth.mimeType, subfolder: "atelier", signal: controller.signal }),
            ]);
            assertJobActive(taskId);

            const workflowInputs = {
                pose: workflowImageReference(pose),
                depth: workflowImageReference(depth),
                positivePrompt: input.prompt,
                width: input.width,
                height: input.height,
            };
            if (input.negativePrompt !== undefined) workflowInputs.negativePrompt = input.negativePrompt;
            if (input.seed !== undefined) workflowInputs.seed = input.seed;
            phase = "workflow";
            const patched = registry.patch(input.workflowId, workflowInputs);
            const clientId = randomUUID();
            const requestedPromptId = randomUUID();
            store.update(taskId, { promptId: requestedPromptId });
            phase = "queue";
            entry.queuePromise = client.queuePrompt({ prompt: patched.workflow, clientId, promptId: requestedPromptId });
            const queued = await entry.queuePromise;
            const promptId = typeof queued?.prompt_id === "string" && queued.prompt_id ? queued.prompt_id : requestedPromptId;
            if (!isJobActive(taskId)) {
                await cancelUpstream(taskId, entry, promptId);
                return;
            }
            store.update(taskId, { status: "submitted", promptId });

            // Keep the submitted state observable to clients before entering execution.
            await new Promise((resolve) => setImmediate(resolve));
            assertJobActive(taskId);
            store.update(taskId, { status: "running" });

            // History is authoritative even if a cached job finished before the
            // WebSocket connected. Monitor WS for progress/errors in parallel;
            // losing progress must never prevent a completed image from arriving.
            phase = "progress";
            const monitoring = new AbortController();
            const monitorSignal = AbortSignal.any([controller.signal, monitoring.signal]);
            let progressFailure;
            if (typeof client.waitForCompletion === "function") {
                void Promise.resolve()
                    .then(() =>
                        client.waitForCompletion({
                            clientId,
                            promptId,
                            signal: monitorSignal,
                            onProgress(progress) {
                                if (!isJobActive(taskId) || monitorSignal.aborted) return;
                                try {
                                    store.update(taskId, { status: "running", progress });
                                } catch {
                                    /* Cancellation won. */
                                }
                            },
                        }),
                    )
                    .catch((error) => {
                        if (monitorSignal.aborted || ["COMFYUI_WEBSOCKET_DISCONNECTED", "COMFYUI_WEBSOCKET_TIMEOUT"].includes(error?.code)) return;
                        progressFailure = error;
                        monitoring.abort(error);
                    });
            }
            let history;
            try {
                phase = "history";
                history = await waitForHistory(promptId, input.outputNode, monitorSignal);
                if (progressFailure) throw progressFailure;
            } finally {
                monitoring.abort();
            }
            const outputRef = selectComfyUiOutput(history, { promptId, outputNode: input.outputNode });
            assertJobActive(taskId);
            phase = "output";
            const output = await client.getOutput({ ...outputRef, signal: controller.signal });
            assertJobActive(taskId);
            store.update(taskId, { status: "succeeded", output: { bytes: output.bytes, mimeType: output.mimeType, width: output.width, height: output.height } });
        } catch (error) {
            if (!isJobActive(taskId)) return;
            const normalized = normalizeJobFailure(error, phase);
            try {
                if (normalized.code === "CANCELLED") store.cancel(taskId);
                else store.update(taskId, { status: "failed", error: normalized });
            } catch {
                // A concurrent DELETE may have made cancellation terminal.
            }
        } finally {
            active.delete(taskId);
        }
    }

    async function waitForHistory(promptId, outputNode, signal) {
        const deadline = Date.now() + historyTimeoutMs;
        let lastError;
        while (Date.now() < deadline) {
            if (signal?.aborted) throw signal.reason || abortError();
            try {
                const history = await client.getHistory(promptId, { signal });
                try {
                    selectComfyUiOutput(history, { promptId, outputNode });
                    return history;
                } catch (error) {
                    if (["COMFYUI_EXECUTION_FAILED", "CANCELLED"].includes(error?.code)) throw error;
                    // History may exist before the declared output node is ready.
                }
            } catch (error) {
                if (signal?.aborted) throw signal.reason || error;
                if (["COMFYUI_EXECUTION_FAILED", "CANCELLED"].includes(error?.code)) throw error;
                lastError = error;
            }
            await delay(historyPollMs, signal);
        }
        throw lastError ?? new Error(`Timed out waiting for ComfyUI prompt ${promptId}`);
    }
}

export async function parseMultipartRequest(request, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    const contentType = String(request.headers?.["content-type"] ?? "");
    const match = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    if (!match) throw new HttpError(400, "MULTIPART_INVALID", "Request must be multipart/form-data", false);
    const boundary = match[1] || match[2];
    const contentLength = Number(request.headers?.["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new HttpError(413, "REQUEST_TOO_LARGE", "Multipart request exceeds the byte limit", false);

    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes) throw new HttpError(413, "REQUEST_TOO_LARGE", "Multipart request exceeds the byte limit", false);
        chunks.push(bytes);
    }
    return parseMultipartBytes(Buffer.concat(chunks), boundary);
}

function parseMultipartBytes(body, boundary) {
    const marker = Buffer.from(`--${boundary}`);
    const fields = {};
    const files = {};
    let cursor = body.indexOf(marker);
    if (cursor !== 0) throw new HttpError(400, "MULTIPART_INVALID", "Multipart boundary is missing", false);
    while (cursor >= 0) {
        cursor += marker.length;
        if (body.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) break;
        if (!body.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) throw new HttpError(400, "MULTIPART_INVALID", "Malformed multipart boundary", false);
        const headerStart = cursor + 2;
        const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
        if (headerEnd < 0) throw new HttpError(400, "MULTIPART_INVALID", "Malformed multipart headers", false);
        const headers = parsePartHeaders(body.subarray(headerStart, headerEnd).toString("latin1"));
        const dataStart = headerEnd + 4;
        const nextBoundary = body.indexOf(marker, dataStart);
        if (nextBoundary < 0) throw new HttpError(400, "MULTIPART_INVALID", "Multipart closing boundary is missing", false);
        if (nextBoundary < dataStart + 2 || !body.subarray(nextBoundary - 2, nextBoundary).equals(Buffer.from("\r\n"))) throw new HttpError(400, "MULTIPART_INVALID", "Malformed multipart part", false);
        const data = body.subarray(dataStart, nextBoundary - 2);
        if (!headers.name) throw new HttpError(400, "MULTIPART_INVALID", "Multipart field name is missing", false);
        if (headers.filename !== undefined) {
            const file = { filename: headers.filename, mimeType: (headers["content-type"] || "application/octet-stream").split(";", 1)[0].trim().toLowerCase(), bytes: Buffer.from(data) };
            const dimensions = imageDimensions(file.bytes, file.mimeType);
            if (dimensions) Object.assign(file, dimensions);
            files[headers.name] = file;
        } else {
            fields[headers.name] = data.toString("utf8");
        }
        cursor = nextBoundary;
    }
    return { fields, files };
}

function parsePartHeaders(value) {
    const headers = {};
    for (const line of value.split("\r\n")) {
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        const key = line.slice(0, separator).trim().toLowerCase();
        const headerValue = line.slice(separator + 1).trim();
        headers[key] = headerValue;
    }
    const disposition = headers["content-disposition"] || "";
    const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1] ?? /(?:^|;)\s*name=([^;\s]+)/i.exec(disposition)?.[1];
    const filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1] ?? /(?:^|;)\s*filename=([^;\s]+)/i.exec(disposition)?.[1];
    return { ...headers, name, filename };
}

function validateJobInput(parsed, registry, maxBytes) {
    const fields = normalizeFields(parsed);
    const allowedFields = new Set(["workflowId", "prompt", "negativePrompt", "seed", "shotId", "frame", "width", "height", "camera", "idempotencyKey"]);
    if (Object.keys(fields).some((field) => !allowedFields.has(field))) throw new HttpError(400, "INPUT_INVALID", "Unsupported job field; upstream configuration is server-only", false);
    const workflowId = requiredText(fields.workflowId, "workflowId");
    try {
        registry.get(workflowId);
    } catch (error) {
        throw new HttpError(400, "WORKFLOW_INVALID", safeMessage(error, `Unknown workflow: ${workflowId}`), false);
    }
    const prompt = requiredText(fields.prompt, "prompt");
    const shotId = requiredText(fields.shotId, "shotId");
    const frame = integerField(fields.frame, "frame", { min: 0 });
    const width = integerField(fields.width, "width", { min: 1, max: 16_384 });
    const height = integerField(fields.height, "height", { min: 1, max: 16_384 });
    const seed = fields.seed === undefined || fields.seed === "" ? undefined : integerField(fields.seed, "seed", { min: 0 });
    const files = normalizeFiles(parsed);
    const pose = validateImagePart(files.pose, "pose");
    const depth = validateImagePart(files.depth, "depth");
    const reference = files.reference ? validateImagePart(files.reference, "reference") : undefined;
    if (pose.width !== width || pose.height !== height) throw new HttpError(400, "INPUT_DIMENSIONS_MISMATCH", `pose image dimensions ${pose.width}x${pose.height} must match requested ${width}x${height}`, false);
    if (depth.width !== width || depth.height !== height) throw new HttpError(400, "INPUT_DIMENSIONS_MISMATCH", `depth image dimensions ${depth.width}x${depth.height} must match requested ${width}x${height}`, false);
    const imageBytes = pose.bytes.length + depth.bytes.length + (reference?.bytes.length ?? 0);
    if (imageBytes > maxBytes) throw new HttpError(413, "REQUEST_TOO_LARGE", "Multipart request exceeds the byte limit", false);
    return {
        workflowId,
        prompt,
        negativePrompt: fields.negativePrompt === undefined ? undefined : String(fields.negativePrompt),
        seed,
        shotId,
        frame,
        width,
        height,
        pose,
        depth,
        reference,
        idempotencyKey: typeof fields.idempotencyKey === "string" ? fields.idempotencyKey : undefined,
        outputNode: registry.get(workflowId).manifest?.outputNode || "21",
    };
}

function normalizeFields(parsed) {
    if (parsed?.fields instanceof Map) return Object.fromEntries(parsed.fields);
    if (parsed?.fields && typeof parsed.fields === "object") return parsed.fields;
    if (parsed instanceof Map) return Object.fromEntries(parsed);
    if (parsed && typeof parsed === "object") return parsed;
    throw new HttpError(400, "MULTIPART_INVALID", "Multipart fields are required", false);
}

function normalizeFiles(parsed) {
    const source = parsed?.files && typeof parsed.files === "object" ? parsed.files : parsed;
    if (!source || typeof source !== "object") return {};
    if (source instanceof Map) return Object.fromEntries(source);
    if (Array.isArray(source)) return Object.fromEntries(source.map((part) => [part?.fieldname || part?.name, part]));
    return source;
}

function validateImagePart(value, name) {
    if (!value || typeof value !== "object") throw new HttpError(400, "INPUT_INVALID", `${name} image is required`, false);
    const mimeType = String(value.mimeType ?? value.type ?? "")
        .split(";", 1)[0]
        .toLowerCase();
    if (!IMAGE_MIME_TYPES.has(mimeType)) throw new HttpError(400, "INPUT_INVALID", `${name} image must be image/png or image/webp`, false);
    const bytes = toBuffer(value.bytes ?? value.data);
    if (bytes.length === 0) throw new HttpError(400, "INPUT_INVALID", `${name} image must not be empty`, false);
    const dimensions = imageDimensions(bytes, mimeType);
    if (!dimensions || !Number.isInteger(dimensions.width) || dimensions.width < 1 || !Number.isInteger(dimensions.height) || dimensions.height < 1) throw new HttpError(400, "INPUT_INVALID", `${name} image has an invalid or unsupported header`, false);
    if ((value.width !== undefined && value.width !== dimensions.width) || (value.height !== undefined && value.height !== dimensions.height)) throw new HttpError(400, "INPUT_INVALID", `${name} image dimensions do not match its header`, false);
    if (dimensions.width > MAX_SOURCE_IMAGE_DIMENSION || dimensions.height > MAX_SOURCE_IMAGE_DIMENSION || dimensions.width * dimensions.height > MAX_SOURCE_IMAGE_PIXELS)
        throw new HttpError(400, "INPUT_INVALID", `${name} image dimensions exceed the ${MAX_SOURCE_IMAGE_DIMENSION}px source limit`, false);
    return { filename: safeFilename(value.filename ?? value.name, `${name}.png`), mimeType, bytes, width: dimensions.width, height: dimensions.height };
}

function imageDimensions(bytes, mimeType) {
    if (mimeType === "image/png" && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) && bytes.subarray(12, 16).toString("ascii") === "IHDR") {
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (mimeType !== "image/webp" || bytes.length < 16 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") return undefined;
    let cursor = 12;
    while (cursor + 8 <= bytes.length) {
        const chunk = bytes.subarray(cursor, cursor + 4).toString("ascii");
        const length = bytes.readUInt32LE(cursor + 4);
        const data = cursor + 8;
        if (chunk === "VP8X" && length >= 10 && data + 10 <= bytes.length) return { width: 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16), height: 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16) };
        if (chunk === "VP8 " && length >= 10 && data + 10 <= bytes.length && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a)
            return { width: bytes.readUInt16LE(data + 6) & 0x3fff, height: bytes.readUInt16LE(data + 8) & 0x3fff };
        if (chunk === "VP8L" && length >= 5 && data + 5 <= bytes.length && bytes[data] === 0x2f)
            return { width: 1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8), height: 1 + ((bytes[data + 2] >> 6) | (bytes[data + 3] << 2) | ((bytes[data + 4] & 0xf) << 10)) };
        cursor = data + length + (length % 2);
    }
    return undefined;
}

function publicTask(task) {
    if (!task) return undefined;
    const value = { taskId: task.taskId, status: task.status, workflowId: task.workflowId };
    if (task.promptId) value.promptId = task.promptId;
    if (task.progress) value.progress = task.progress;
    if (task.output) value.output = { mimeType: task.output.mimeType, width: task.output.width, height: task.output.height };
    if (task.error) value.error = task.error;
    return value;
}

function normalizePath(pathname) {
    if (pathname === "/api/comfyui") return "/";
    if (pathname.startsWith("/api/comfyui/")) return pathname.slice("/api/comfyui".length);
    if (pathname === "/comfyui") return "/";
    if (pathname.startsWith("/comfyui/")) return pathname.slice("/comfyui".length);
    return pathname;
}

function decodePathPart(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        throw new HttpError(400, "COMFYUI_TASK_INVALID", "Invalid task id", false);
    }
}

function requiredText(value, name) {
    if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "INPUT_INVALID", `${name} is required`, false);
    return value.trim();
}

function integerField(value, name, { min, max } = {}) {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(number) || number < min || (max !== undefined && number > max)) throw new HttpError(400, "INPUT_INVALID", `${name} must be an integer`, false);
    return number;
}

function safeFilename(value, fallback) {
    const name = typeof value === "string" ? value.split(/[\\/]/).pop() : "";
    return name && name !== "." && name !== ".." ? name : fallback;
}

function workflowImageReference(value) {
    const name = value?.name || value?.filename;
    if (typeof name !== "string" || !name) throw new Error("ComfyUI upload response is missing a name");
    const subfolder = typeof value.subfolder === "string" ? value.subfolder.replace(/^\/+|\/+$/g, "") : "";
    return subfolder ? `${subfolder}/${name}` : name;
}

function requestFingerprint(input) {
    const hash = createHash("sha256");
    hash.update(
        JSON.stringify({
            workflowId: input.workflowId,
            prompt: input.prompt,
            negativePrompt: input.negativePrompt ?? null,
            seed: input.seed ?? null,
            shotId: input.shotId,
            frame: input.frame,
            width: input.width,
            height: input.height,
        }),
    );
    for (const image of [input.pose, input.depth, input.reference]) {
        if (!image) {
            hash.update("<none>");
            continue;
        }
        hash.update(image.mimeType);
        hash.update(String(image.width));
        hash.update(String(image.height));
        hash.update(toBuffer(image.bytes));
    }
    return hash.digest("hex");
}

function isTerminal(status) {
    return status === "succeeded" || status === "failed" || status === "cancelled";
}

function normalizeJobFailure(error, phase = "upstream") {
    const rawCode = typeof error?.code === "string" ? error.code : "";
    const errorName = typeof error?.name === "string" ? error.name : "";
    const code = mapFailureCode(rawCode, { errorName, phase });
    const message = safeMessage(error, "ComfyUI generation failed");
    return { code, message, retryable: !["CANCELLED", "WORKFLOW_INVALID", "INPUT_INVALID"].includes(code) };
}

function mapFailureCode(code, { errorName = "", phase = "upstream" } = {}) {
    const normalizedCode = typeof code === "string" ? code : "";
    if (errorName === "TimeoutError" || normalizedCode.includes("TIMEOUT")) return phase === "output" ? "OUTPUT_FAILED" : "COMFYUI_UNAVAILABLE";
    if (normalizedCode === "COMFYUI_HTTP_ERROR" && phase === "queue") return "QUEUE_FAILED";
    if (normalizedCode === "COMFYUI_HTTP_ERROR" && phase === "upload") return "UPLOAD_FAILED";
    if (normalizedCode === "COMFYUI_UPLOAD_FAILED" || normalizedCode.includes("UPLOAD")) return "UPLOAD_FAILED";
    if (normalizedCode === "COMFYUI_QUEUE_FAILED" || normalizedCode.includes("QUEUE")) return "QUEUE_FAILED";
    if (normalizedCode.includes("OUTPUT") || phase === "output") return "OUTPUT_FAILED";
    if (normalizedCode === "COMFYUI_EXECUTION_FAILED") return "GENERATION_FAILED";
    if (normalizedCode.includes("WORKFLOW")) return "WORKFLOW_INVALID";
    if (normalizedCode === "CANCELLED") return "CANCELLED";
    if (normalizedCode === "COMFYUI_UNAVAILABLE") return "COMFYUI_UNAVAILABLE";
    return "COMFYUI_UNAVAILABLE";
}

function normalizeError(error) {
    if (error instanceof HttpError) return error;
    if (error instanceof ComfyUiTaskStoreError) {
        const status = error.code === "TASK_NOT_FOUND" ? 404 : ["TASK_KEY_INVALID", "TASK_FINGERPRINT_INVALID"].includes(error.code) ? 400 : 409;
        return new HttpError(status, error.code, error.message, false);
    }
    return new HttpError(500, "COMFYUI_API_ERROR", safeMessage(error, "ComfyUI API request failed"), false);
}

function safeMessage(error, fallback) {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    return message ? message.replace(/[\r\n]/g, " ").slice(0, 500) : fallback;
}

function sendError(response, status, code, message, retryable) {
    sendJson(response, status, { error: { code, message, retryable } });
}

function sendJson(response, status, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": bytes.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(bytes);
}

function toBuffer(value) {
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    throw new HttpError(400, "INPUT_INVALID", "Image bytes are required", false);
}

function abortError() {
    const error = new Error("ComfyUI generation was cancelled");
    error.name = "AbortError";
    error.code = "CANCELLED";
    return error;
}

function isAbortError(error) {
    return error?.name === "AbortError" || error?.code === "CANCELLED";
}

function delay(ms, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason || abortError());
    return new Promise((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(signal.reason || abortError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", abort, { once: true });
    });
}

class HttpError extends Error {
    constructor(status, code, message, retryable = false) {
        super(message);
        this.name = "HttpError";
        this.status = status;
        this.code = code;
        this.retryable = retryable;
    }
}
