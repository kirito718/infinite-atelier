import { authenticatedFetch as fetch } from "@/services/account-client";
import type { ReferenceImage } from "@/types/image";
import { imageToDataUrl } from "@/services/image-storage";

const CODEX_BASE_PATH = "/api/codex-subscription/v1";
const POLL_INTERVAL_MS = 250;

export type CodexStatus = "disconnected" | "connecting" | "connected" | "unavailable";

export type CodexImageTask = {
    taskId: string;
};

export type CodexImageTaskState = {
    taskId: string;
    status: "queued" | "generating" | "succeeded" | "failed" | "cancelled";
    files: Array<{ fileId: string; mimeType: string; name?: string; size?: number }>;
    error?: string;
};

type RequestOptions = { signal?: AbortSignal };

export async function getCodexStatus(options?: RequestOptions): Promise<CodexStatus> {
    const response = await request(`${CODEX_BASE_PATH}/status`, { signal: options?.signal });
    const payload = (await response.json()) as { status?: CodexStatus };
    return payload.status || "unavailable";
}

export async function beginCodexLogin(options?: RequestOptions) {
    const response = await request(`${CODEX_BASE_PATH}/login`, { method: "POST", signal: options?.signal });
    return (await response.json()) as { authUrl: string };
}

export async function logoutCodex(options?: RequestOptions) {
    await request(`${CODEX_BASE_PATH}/logout`, { method: "POST", signal: options?.signal });
}

export async function createCodexImageTask(params: { prompt: string; operation: "generate" | "edit"; references?: ReferenceImage[] }, options?: RequestOptions): Promise<CodexImageTask> {
    const references = await Promise.all((params.references || []).map(referenceToDataUrl));
    const response = await request(`${CODEX_BASE_PATH}/images`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: params.prompt, operation: params.operation, references }),
        signal: options?.signal,
    });
    return (await response.json()) as CodexImageTask;
}

export async function waitForCodexImageTask(taskId: string, options?: RequestOptions): Promise<CodexImageTaskState> {
    try {
        while (true) {
            const task = await readCodexImageTask(taskId, options);
            if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
                if (task.status !== "succeeded") throw new Error(task.error || "Codex image generation did not complete");
                return task;
            }
            await wait(POLL_INTERVAL_MS, options?.signal);
        }
    } catch (error) {
        if (options?.signal?.aborted) {
            await cancelCodexImageTask(taskId);
        }
        throw error;
    }
}

export async function readCodexImageTask(taskId: string, options?: RequestOptions): Promise<CodexImageTaskState> {
    const response = await request(`${CODEX_BASE_PATH}/images/${encodeURIComponent(taskId)}`, { signal: options?.signal });
    return (await response.json()) as CodexImageTaskState;
}

export async function cancelCodexImageTask(taskId: string) {
    await request(`${CODEX_BASE_PATH}/images/${encodeURIComponent(taskId)}`, { method: "DELETE" });
}

export async function downloadCodexImage(taskId: string, fileId: string, options?: RequestOptions): Promise<Blob> {
    const response = await request(`${CODEX_BASE_PATH}/images/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}`, { signal: options?.signal });
    return response.blob();
}

export function codexImageFileId(file: CodexImageTaskState["files"][number]) {
    return file.fileId;
}

async function request(input: string, init: RequestInit = {}) {
    let response: Response;
    try {
        response = await fetch(input, { ...init, headers: { accept: "application/json", ...init.headers } });
    } catch (error) {
        throw new Error(error instanceof Error ? error.message : "Codex subscription unavailable");
    }
    if (response.ok) return response;
    let message = `Codex subscription request failed (${response.status})`;
    try {
        const payload = (await response.json()) as { error?: string };
        if (payload.error) message = payload.error;
    } catch {
        // Keep the status-only diagnostic when the bridge did not return JSON.
    }
    throw new Error(message);
}

async function referenceToDataUrl(reference: ReferenceImage) {
    return imageToDataUrl(reference);
}

function wait(milliseconds: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"));
            return;
        }
        const timer = window.setTimeout(resolve, milliseconds);
        signal?.addEventListener(
            "abort",
            () => {
                window.clearTimeout(timer);
                reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"));
            },
            { once: true },
        );
    });
}
