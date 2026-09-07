import type { ComfyUiJobCreate, ComfyUiJobError, ComfyUiJobStatus } from "@/types/comfyui";

const COMFYUI_API_PATH = "/api/comfyui";
const IMAGE_MIME_TYPES = new Set(["image/png", "image/webp"]);

export class ComfyUiApiError extends Error {
    readonly code: string;
    readonly status: number;
    readonly retryable: boolean;

    constructor(code: string, message: string, status: number, retryable = false) {
        super(message);
        this.name = "ComfyUiApiError";
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

export async function createComfyUiJob(input: ComfyUiJobCreate, options: ComfyUiRequestOptions = {}): Promise<ComfyUiJobStatus> {
    const form = new FormData();
    form.append("workflowId", input.workflowId);
    form.append("prompt", input.prompt);
    if (input.negativePrompt !== undefined) form.append("negativePrompt", input.negativePrompt);
    if (input.seed !== undefined) form.append("seed", String(input.seed));
    form.append("shotId", input.shotId);
    form.append("frame", String(input.frame));
    form.append("width", String(input.width));
    form.append("height", String(input.height));
    form.append("pose", imagePart(input.pose.blob, input.pose.mimeType, "pose"), imageFilename("pose", input.pose.mimeType));
    form.append("depth", imagePart(input.depth.blob, input.depth.mimeType, "depth"), imageFilename("depth", input.depth.mimeType));
    if (input.reference) {
        form.append("reference", imagePart(input.reference, input.reference.type, "reference"), imageFilename("reference", input.reference.type));
    }
    if (input.camera) form.append("camera", JSON.stringify(input.camera));

    return requestJson<ComfyUiJobStatus>(`${COMFYUI_API_PATH}/jobs`, { method: "POST", body: form }, options);
}

export type ComfyUiRequestOptions = { signal?: AbortSignal; timeoutMs?: number };

export function getComfyUiJob(taskId: string, options: ComfyUiRequestOptions = {}): Promise<ComfyUiJobStatus> {
    return requestJson<ComfyUiJobStatus>(jobPath(taskId), {}, options);
}

export function getComfyUiOutput(taskId: string, options: ComfyUiRequestOptions = {}): Promise<Blob> {
    return request(jobPath(taskId, "/output"), { headers: { accept: "image/png, image/webp" } }, options, async (response) => {
        const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        if (!mimeType || !IMAGE_MIME_TYPES.has(mimeType)) {
            throw new ComfyUiApiError("OUTPUT_INVALID", "ComfyUI 返回的内容不是 PNG/WebP 图片，请检查上游输出", 502);
        }
        let blob: Blob;
        try {
            blob = await response.blob();
        } catch (error) {
            if (isAbortError(error)) throw error;
            throw new ComfyUiApiError("OUTPUT_FAILED", "图片下载中断，请重试或检查 ComfyUI 连接", 502, true);
        }
        if (!blob.size) throw new ComfyUiApiError("OUTPUT_INVALID", "ComfyUI 返回了空图片，请检查工作流输出", 502);
        return blob;
    });
}

export async function cancelComfyUiJob(taskId: string, options: ComfyUiRequestOptions = {}): Promise<void> {
    await request(jobPath(taskId), { method: "DELETE" }, options, async () => undefined);
}

function jobPath(taskId: string, suffix = "") {
    return `${COMFYUI_API_PATH}/jobs/${encodeURIComponent(taskId)}${suffix}`;
}

function imagePart(blob: Blob, mimeType: string, name: string): Blob {
    if (!IMAGE_MIME_TYPES.has(mimeType)) {
        throw new ComfyUiApiError("INPUT_INVALID", `${name} image must be image/png or image/webp`, 400);
    }
    return new Blob([blob], { type: mimeType });
}

function imageFilename(name: string, mimeType: string) {
    return `${name}.${mimeType === "image/webp" ? "webp" : "png"}`;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

/** Abort also covers body consumption, not just receipt of HTTP headers. */
export function withAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve()
            .then(operation)
            .then(
                (value) => {
                    signal.removeEventListener("abort", onAbort);
                    resolve(value);
                },
                (error) => {
                    signal.removeEventListener("abort", onAbort);
                    reject(error);
                },
            );
    });
}

async function request<T>(input: string, init: RequestInit, options: ComfyUiRequestOptions, read: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("ComfyUI request timed out", "TimeoutError")), options.timeoutMs ?? 60_000);
    try {
        return await withAbort(async () => {
            const response = await fetch(input, { ...init, signal: controller.signal, headers: { accept: "application/json", ...init.headers } });
            if (!response.ok) {
                let payload: unknown;
                try {
                    payload = await response.json();
                } catch {
                    payload = undefined;
                }
                const error = normalizeError(payload, response.status);
                throw new ComfyUiApiError(error.code, error.message, response.status, error.retryable);
            }
            return read(response);
        }, controller.signal);
    } catch (error) {
        if (controller.signal.aborted) {
            if (controller.signal.reason?.name === "TimeoutError") {
                throw new ComfyUiApiError("COMFYUI_TIMEOUT", "ComfyUI 请求超时，请检查连接后重试", 504, true);
            }
            throw controller.signal.reason;
        }
        if (error instanceof ComfyUiApiError || isAbortError(error)) throw error;
        throw new ComfyUiApiError("COMFYUI_UNAVAILABLE", "无法连接 ComfyUI 网关，请检查服务配置", 503, true);
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
    }
}

function requestJson<T>(input: string, init: RequestInit = {}, options: ComfyUiRequestOptions = {}): Promise<T> {
    return request(input, init, options, async (response) => {
        try {
            return (await response.json()) as T;
        } catch (error) {
            if (isAbortError(error)) throw error;
            throw new ComfyUiApiError("COMFYUI_RESPONSE_INVALID", "ComfyUI 网关返回了无效 JSON", 502);
        }
    });
}

function normalizeError(payload: unknown, status: number): ComfyUiJobError {
    const envelope = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    return {
        code: typeof envelope?.code === "string" && envelope.code ? envelope.code : "COMFYUI_REQUEST_FAILED",
        message: typeof envelope?.message === "string" && envelope.message ? envelope.message : `ComfyUI API request failed (${status})`,
        retryable: typeof envelope?.retryable === "boolean" ? envelope.retryable : status >= 500,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
