export class ComfyUiClientError extends Error {
    constructor(code, message, cause) {
        super(message, cause ? { cause } : undefined);
        this.name = "ComfyUiClientError";
        this.code = code;
    }
}

export class ComfyUiWebSocketError extends ComfyUiClientError {
    constructor(code, message, cause) {
        super(code, message, cause);
        this.name = "ComfyUiWebSocketError";
    }
}

export function createComfyUiClient({ baseUrl, apiPrefix = "", fetchImpl = globalThis.fetch, websocketFactory, timeoutMs = 120_000 } = {}) {
    const requestBaseUrl = normalizeBaseUrl(baseUrl);
    const prefix = normalizeApiPrefix(apiPrefix);
    const resolvedWebsocketFactory = websocketFactory ?? createDefaultWebSocketFactory;
    if (typeof fetchImpl !== "function") {
        throw new ComfyUiClientError("COMFYUI_FETCH_UNAVAILABLE", "A fetch implementation is required");
    }
    if (typeof resolvedWebsocketFactory !== "function") {
        throw new ComfyUiClientError("COMFYUI_WEBSOCKET_UNAVAILABLE", "A WebSocket factory is required");
    }

    const request = async (path, init = {}) => {
        let response;
        const composed = composeRequestSignal(init.signal, timeoutMs);
        try {
            response = await fetchImpl(buildHttpUrl(requestBaseUrl, prefix, path), {
                ...init,
                signal: composed.signal,
            });
        } catch (error) {
            throw new ComfyUiClientError("COMFYUI_UNAVAILABLE", `ComfyUI request failed: ${error instanceof Error ? error.message : String(error)}`, error);
        } finally {
            composed.cleanup();
        }
        if (!response?.ok) {
            const error = new ComfyUiClientError("COMFYUI_HTTP_ERROR", `ComfyUI request failed with status ${response?.status ?? "unknown"}: ${await responseErrorMessage(response)}`);
            error.status = response?.status;
            throw error;
        }
        return response;
    };

    return {
        async uploadImage({ bytes, filename, mimeType, subfolder, signal } = {}) {
            if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) {
                throw new ComfyUiClientError("COMFYUI_UPLOAD_INVALID", "Image bytes must be a Uint8Array or ArrayBuffer");
            }
            if (typeof filename !== "string" || !filename) {
                throw new ComfyUiClientError("COMFYUI_UPLOAD_INVALID", "Image filename is required");
            }
            if (typeof mimeType !== "string" || !mimeType.startsWith("image/")) {
                throw new ComfyUiClientError("COMFYUI_UPLOAD_INVALID", "Image mimeType must be an image type");
            }

            const form = new FormData();
            const content = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            form.append("image", new Blob([content], { type: mimeType }), filename);
            form.append("type", "input");
            if (typeof subfolder === "string" && subfolder) form.append("subfolder", subfolder);

            const response = await request("/upload/image", { method: "POST", body: form, signal });
            const uploaded = await parseJson(response, "COMFYUI_UPLOAD_FAILED");
            if (!isRecord(uploaded) || typeof uploaded.name !== "string" || !uploaded.name) {
                throw new ComfyUiClientError("COMFYUI_UPLOAD_FAILED", "ComfyUI upload response is missing a name");
            }
            return {
                name: uploaded.name,
                subfolder: typeof uploaded.subfolder === "string" ? uploaded.subfolder : "",
                type: typeof uploaded.type === "string" ? uploaded.type : "input",
            };
        },

        async queuePrompt({ prompt, clientId, promptId } = {}) {
            if (!isRecord(prompt) || typeof clientId !== "string" || !clientId || typeof promptId !== "string" || !promptId) {
                throw new ComfyUiClientError("COMFYUI_PROMPT_INVALID", "Prompt, clientId, and promptId are required");
            }
            const response = await request("/prompt", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ prompt, client_id: clientId, prompt_id: promptId }),
            });
            const queued = await parseJson(response, "COMFYUI_QUEUE_FAILED");
            if (!isRecord(queued) || typeof queued.prompt_id !== "string") {
                throw new ComfyUiClientError("COMFYUI_QUEUE_FAILED", "ComfyUI queue response is missing prompt_id");
            }
            return {
                prompt_id: queued.prompt_id,
                number: typeof queued.number === "number" ? queued.number : undefined,
                node_errors: isRecord(queued.node_errors) ? queued.node_errors : {},
            };
        },

        waitForCompletion({ clientId, promptId, onProgress, signal } = {}) {
            if (typeof clientId !== "string" || !clientId || typeof promptId !== "string" || !promptId) {
                return Promise.reject(new ComfyUiWebSocketError("COMFYUI_WEBSOCKET_INVALID", "clientId and promptId are required"));
            }
            return waitForCompletion({
                websocketFactory: resolvedWebsocketFactory,
                websocketUrl: buildWebSocketUrl(requestBaseUrl, prefix, clientId),
                promptId,
                onProgress,
                signal,
                timeoutMs,
            });
        },

        async getHistory(promptId) {
            if (typeof promptId !== "string" || !promptId) {
                throw new ComfyUiClientError("COMFYUI_HISTORY_INVALID", "promptId is required");
            }
            const response = await request(`/history/${encodeURIComponent(promptId)}`);
            return parseJson(response, "COMFYUI_HISTORY_FAILED");
        },

        async getOutput(fileRef) {
            const filename = fileRef?.filename ?? fileRef?.name;
            if (typeof filename !== "string" || !filename) {
                throw new ComfyUiClientError("COMFYUI_OUTPUT_INVALID", "Output filename is required");
            }
            const params = new URLSearchParams({ filename });
            if (typeof fileRef?.subfolder === "string" && fileRef.subfolder) params.set("subfolder", fileRef.subfolder);
            params.set("type", typeof fileRef?.type === "string" ? fileRef.type : "output");
            const response = await request(`/view?${params.toString()}`);
            const mimeType = response.headers.get("content-type")?.split(";", 1)[0] || "application/octet-stream";
            return { bytes: Buffer.from(await response.arrayBuffer()), mimeType };
        },

        async interrupt(promptId) {
            if (typeof promptId !== "string" || !promptId) {
                throw new ComfyUiClientError("COMFYUI_INTERRUPT_INVALID", "promptId is required");
            }
            try {
                await request(`/jobs/${encodeURIComponent(promptId)}/cancel`, { method: "POST" });
            } catch (error) {
                if (error instanceof ComfyUiClientError && [404, 405, 501].includes(error.status)) {
                    throw new ComfyUiClientError("COMFYUI_TARGETED_CANCEL_UNSUPPORTED", "Configured ComfyUI endpoint does not support job-scoped cancellation", error);
                }
                throw error;
            }
        },
    };
}

export function selectComfyUiOutput(history, { promptId, outputNode } = {}) {
    if (!isRecord(history) || typeof promptId !== "string" || !promptId || typeof outputNode !== "string" || !outputNode) {
        throw new ComfyUiClientError("COMFYUI_HISTORY_INVALID", "History, promptId, and outputNode are required");
    }
    const promptHistory = history[promptId];
    const images = promptHistory?.outputs?.[outputNode]?.images;
    const image = Array.isArray(images) ? images[0] : undefined;
    if (!isRecord(image) || typeof image.filename !== "string" || !image.filename) {
        throw new ComfyUiClientError("COMFYUI_OUTPUT_NOT_FOUND", `No image output found for node ${outputNode}`);
    }
    return {
        filename: image.filename,
        subfolder: typeof image.subfolder === "string" ? image.subfolder : "",
        type: typeof image.type === "string" ? image.type : "output",
    };
}

function waitForCompletion({ websocketFactory, websocketUrl, promptId, onProgress, signal, timeoutMs }) {
    return new Promise((resolvePromise, rejectPromise) => {
        let socket;
        let settled = false;
        const cleanups = [];
        const timeout = setTimeout(() => {
            settle(new ComfyUiWebSocketError("COMFYUI_WEBSOCKET_TIMEOUT", `ComfyUI prompt ${promptId} timed out`));
        }, timeoutMs);

        const settle = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            for (const cleanup of cleanups) cleanup();
            try {
                socket?.close?.();
            } catch {
                // Closing an already closed socket is harmless.
            }
            if (error) rejectPromise(error);
            else resolvePromise();
        };

        const abort = () => settle(createAbortError());
        if (signal?.aborted) {
            abort();
            return;
        }
        if (signal) {
            signal.addEventListener("abort", abort, { once: true });
            cleanups.push(() => signal.removeEventListener("abort", abort));
        }

        try {
            socket = websocketFactory(websocketUrl);
        } catch (error) {
            settle(error instanceof ComfyUiWebSocketError ? error : new ComfyUiWebSocketError("COMFYUI_WEBSOCKET_DISCONNECTED", "Could not connect to ComfyUI WebSocket", error));
            return;
        }

        cleanups.push(
            addSocketListener(socket, "message", (event) => {
                const message = parseSocketMessage(event);
                if (!message || message.data?.prompt_id !== promptId) return;
                if (message.type === "progress" && typeof onProgress === "function") {
                    const value = Number(message.data.value);
                    const max = Number(message.data.max);
                    onProgress({
                        nodeId: typeof message.data.node === "string" ? message.data.node : undefined,
                        step: Number.isFinite(value) ? value : undefined,
                        max: Number.isFinite(max) ? max : undefined,
                        percent: Number.isFinite(value) && Number.isFinite(max) && max > 0 ? (value / max) * 100 : undefined,
                    });
                }
                if (message.type === "executing" && message.data.node === null) settle();
            }),
            addSocketListener(socket, "error", (event) => {
                settle(new ComfyUiWebSocketError("COMFYUI_WEBSOCKET_DISCONNECTED", "ComfyUI WebSocket error", event));
            }),
            addSocketListener(socket, "close", () => {
                settle(new ComfyUiWebSocketError("COMFYUI_WEBSOCKET_DISCONNECTED", "ComfyUI WebSocket disconnected"));
            }),
        );
    });
}

function addSocketListener(socket, type, listener) {
    if (typeof socket?.addEventListener === "function") {
        socket.addEventListener(type, listener);
        return () => socket.removeEventListener?.(type, listener);
    }
    if (typeof socket?.on === "function") {
        socket.on(type, listener);
        return () => socket.off?.(type, listener) || socket.removeListener?.(type, listener);
    }
    throw new ComfyUiWebSocketError("COMFYUI_WEBSOCKET_UNSUPPORTED", "WebSocket does not support event listeners");
}

function createDefaultWebSocketFactory(url) {
    if (typeof globalThis.WebSocket !== "function") {
        throw new ComfyUiWebSocketError("COMFYUI_WEBSOCKET_UNAVAILABLE", "A global WebSocket implementation is required; run Atelier with Node.js 22 or provide websocketFactory");
    }
    return new globalThis.WebSocket(url);
}

function parseSocketMessage(event) {
    const data = event?.data ?? event;
    try {
        const json = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : new TextDecoder().decode(data);
        const value = JSON.parse(json);
        return isRecord(value) && isRecord(value.data) ? value : null;
    } catch {
        return null;
    }
}

function normalizeBaseUrl(baseUrl) {
    if (typeof baseUrl !== "string" || !baseUrl) {
        throw new ComfyUiClientError("COMFYUI_URL_INVALID", "A ComfyUI base URL is required");
    }
    let parsed;
    try {
        parsed = new URL(baseUrl);
    } catch (error) {
        throw new ComfyUiClientError("COMFYUI_URL_INVALID", "ComfyUI base URL must be absolute", error);
    }
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.search || parsed.hash) {
        throw new ComfyUiClientError("COMFYUI_URL_INVALID", "ComfyUI base URL must use http(s) and contain no query or hash");
    }
    return parsed.href.replace(/\/+$/, "");
}

function normalizeApiPrefix(apiPrefix) {
    if (typeof apiPrefix !== "string") {
        throw new ComfyUiClientError("COMFYUI_URL_INVALID", "ComfyUI API prefix must be a string");
    }
    const trimmed = apiPrefix.trim().replace(/^\/+|\/+$/g, "");
    if (!trimmed) return "";
    if (trimmed.includes("/../") || trimmed === "..") {
        throw new ComfyUiClientError("COMFYUI_URL_INVALID", "ComfyUI API prefix cannot contain traversal");
    }
    return `/${trimmed}`;
}

function buildHttpUrl(baseUrl, apiPrefix, path) {
    return `${baseUrl}${apiPrefix}${path}`;
}

function buildWebSocketUrl(baseUrl, apiPrefix, clientId) {
    const url = new URL(buildHttpUrl(baseUrl, apiPrefix, "/ws"));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("clientId", clientId);
    return url.toString();
}

function composeRequestSignal(callerSignal, timeoutMs) {
    const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
    if (!callerSignal && !hasTimeout) return { signal: undefined, cleanup() {} };
    if (!hasTimeout) return { signal: callerSignal, cleanup() {} };

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(timeoutError()), timeoutMs);
    timeout.unref?.();

    if (!callerSignal) {
        return {
            signal: timeoutController.signal,
            cleanup() {
                clearTimeout(timeout);
            },
        };
    }

    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
        return {
            signal: AbortSignal.any([callerSignal, timeoutController.signal]),
            cleanup() {
                clearTimeout(timeout);
            },
        };
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(callerSignal.reason);
    if (callerSignal.aborted) abortFromCaller();
    else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
    const abortFromTimeout = () => controller.abort(timeoutController.signal.reason);
    timeoutController.signal.addEventListener("abort", abortFromTimeout, { once: true });
    return {
        signal: controller.signal,
        cleanup() {
            clearTimeout(timeout);
            callerSignal.removeEventListener("abort", abortFromCaller);
            timeoutController.signal.removeEventListener("abort", abortFromTimeout);
        },
    };
}

function timeoutError() {
    if (typeof DOMException === "function") return new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    return error;
}

async function parseJson(response, code) {
    try {
        return await response.json();
    } catch (error) {
        throw new ComfyUiClientError(code, "ComfyUI returned invalid JSON", error);
    }
}

async function responseErrorMessage(response) {
    try {
        return (await response?.text?.()) || "upstream error";
    } catch {
        return "upstream error";
    }
}

function createAbortError() {
    const error = new Error("ComfyUI WebSocket wait was aborted");
    error.name = "AbortError";
    return error;
}

function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
