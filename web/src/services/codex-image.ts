import { authenticatedFetch as fetch } from "@/services/account-client";
import type { ReferenceImage } from "@/types/image";
import { imageToDataUrl } from "@/services/image-storage";

const CODEX_BASE_PATH = "/api/codex-subscription/v1";
const POLL_INTERVAL_MS = 250;

export type CodexStatus = "disconnected" | "connecting" | "connected" | "unavailable";

export type CodexLogin = {
    type: "chatgptDeviceCode";
    loginId: string;
    verificationUrl: "https://auth.openai.com/codex/device";
    userCode: string;
};

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
    const payload = await response.json().catch(() => null);
    const status: unknown = payload?.status;
    if (status !== "disconnected" && status !== "connecting" && status !== "connected" && status !== "unavailable") throw new Error("Invalid Codex status response. Please retry.");
    return status;
}

export async function beginCodexLogin(options?: RequestOptions): Promise<CodexLogin> {
    const response = await request(`${CODEX_BASE_PATH}/login`, { method: "POST", signal: options?.signal });
    const payload = await response.json().catch(() => null);
    if (payload?.type !== "chatgptDeviceCode" || !isLoginString(payload.loginId, 200) || !isLoginString(payload.userCode, 128)) {
        throw new Error("Invalid Codex device-code login response. Please retry; browser OAuth is not supported here.");
    }
    // An exact allowlist also excludes credentials, query strings and code-bearing fragments.
    const verificationUrl = "https://auth.openai.com/codex/device";
    if (payload.verificationUrl !== verificationUrl && payload.verificationUrl !== `${verificationUrl}/`) {
        throw new Error("Invalid Codex login response: expected the official OpenAI device authorization URL.");
    }
    return { type: "chatgptDeviceCode", loginId: payload.loginId, verificationUrl, userCode: payload.userCode };
}

function isLoginString(value: unknown, maxLength: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

export async function cancelCodexLogin(loginId: string, options?: RequestOptions): Promise<void> {
    await request(`${CODEX_BASE_PATH}/login/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginId }),
        signal: options?.signal,
    });
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
