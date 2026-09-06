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

export async function createComfyUiJob(input: ComfyUiJobCreate): Promise<ComfyUiJobStatus> {
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

    return requestJson<ComfyUiJobStatus>(`${COMFYUI_API_PATH}/jobs`, { method: "POST", body: form });
}

export function getComfyUiJob(taskId: string): Promise<ComfyUiJobStatus> {
    return requestJson<ComfyUiJobStatus>(jobPath(taskId));
}

export async function getComfyUiOutput(taskId: string): Promise<Blob> {
    const response = await request(jobPath(taskId, "/output"), { headers: { accept: "*/*" } });
    return response.blob();
}

export async function cancelComfyUiJob(taskId: string): Promise<void> {
    await request(jobPath(taskId), { method: "DELETE" });
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

async function request(input: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
        response = await fetch(input, { ...init, headers: { accept: "application/json", ...init.headers } });
    } catch (error) {
        throw new ComfyUiApiError("COMFYUI_UNAVAILABLE", error instanceof Error ? error.message : "ComfyUI API is unavailable", 503, true);
    }
    if (response.ok) return response;

    let payload: unknown;
    try {
        const jsonResponse = typeof response.clone === "function" ? response.clone() : response;
        payload = await jsonResponse.json();
    } catch {
        payload = undefined;
    }
    const error = normalizeError(payload, response.status);
    throw new ComfyUiApiError(error.code, error.message, response.status, error.retryable);
}

async function requestJson<T>(input: string, init: RequestInit = {}): Promise<T> {
    const response = await request(input, init);
    try {
        return (await response.json()) as T;
    } catch (error) {
        throw new ComfyUiApiError("COMFYUI_RESPONSE_INVALID", error instanceof Error ? error.message : "ComfyUI API returned invalid JSON", response.status, false);
    }
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
