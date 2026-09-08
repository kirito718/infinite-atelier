import { nanoid } from "nanoid";
import { readImageMeta } from "@/lib/image-utils";
import type { ComfyUiJobCreate, ComfyUiJobStatus } from "@/types/comfyui";
import { AccountApiError, getAccountIdentity, getAccountSignal } from "./account-client";
import { cancelComfyUiJob, ComfyUiApiError, createComfyUiJob, getComfyUiJob, getComfyUiOutput, withAbort } from "./comfyui-director";
import { deleteStoredImages, type UploadedImage } from "./image-storage";
import { getServerFileUrl, putServerFile } from "./server-files";

const isTerminal = (task: ComfyUiJobStatus) => ["succeeded", "failed", "cancelled"].includes(task.status);

type GenerationOptions = {
    signal: AbortSignal;
    onStatus?: (task: ComfyUiJobStatus) => void;
    pollIntervalMs?: number;
    timeoutMs?: number;
};

function pause(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/** A complete account-bound task, including persistence, with no late success after cancellation. */
export async function generateDirectorImage(input: ComfyUiJobCreate, options: GenerationOptions) {
    options.signal.throwIfAborted();
    const userId = getAccountIdentity();
    const accountSignal = getAccountSignal();
    const isCurrentAccount = () => Boolean(userId) && !accountSignal.aborted && userId === getAccountIdentity();
    const assertCurrentAccount = () => {
        if (!isCurrentAccount()) throw new AccountApiError(409, "ACCOUNT_CHANGED", "账号会话已切换，已停止接收原账号的生成结果。请检查原账号的 ComfyUI 队列。");
    };
    assertCurrentAccount();
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new DOMException("Generation timed out", "TimeoutError")), options.timeoutMs ?? 15 * 60_000);
    const signal = AbortSignal.any([options.signal, deadline.signal, accountSignal]);
    let taskId: string | undefined;
    let cancellation: Promise<void> | undefined;
    const cancelRemote = () => {
        // Identity changes abort accountSignal before publishing the new user ID.
        // Never send an old task DELETE with a replacement cookie/session.
        if (taskId && isCurrentAccount()) cancellation ??= cancelComfyUiJob(taskId, { signal: accountSignal });
        return cancellation;
    };
    const onAbort = () => {
        void cancelRemote()?.catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
        // User cancellation retains the bounded POST response for scoped cancellation.
        // An account change, unlike a user cancel, must abandon the old POST.
        let task = await createComfyUiJob(input, { signal: accountSignal });
        taskId = task.taskId;
        signal.throwIfAborted();
        options.onStatus?.(task);
        while (!isTerminal(task)) {
            signal.throwIfAborted();
            task = await getComfyUiJob(taskId, { signal });
            signal.throwIfAborted();
            options.onStatus?.(task);
            if (!isTerminal(task)) await pause(options.pollIntervalMs ?? 750, signal);
        }
        signal.throwIfAborted();
        if (task.status === "cancelled") throw new DOMException("真人图生成已取消", "AbortError");
        if (task.status === "failed") {
            throw new ComfyUiApiError(task.error?.code || "GENERATION_FAILED", task.error?.message || "真人图生成失败，请检查 ComfyUI 工作流", 502, task.error?.retryable ?? false);
        }
        const blob = await getComfyUiOutput(taskId, { signal });
        signal.throwIfAborted();
        // The generic uploadImage only captures a user ID. Check the original
        // session across decoding as well, including logout/login as the same user.
        const temporary = URL.createObjectURL(blob);
        let uploaded: UploadedImage;
        try {
            const meta = await withAbort(() => readImageMeta(temporary), signal);
            signal.throwIfAborted();
            const storageKey = `image:${nanoid()}`;
            // Keep a same-session upload's response on user cancellation so its
            // stored file can be removed, but never wait into a replacement session.
            const stored = await withAbort(() => putServerFile(storageKey, blob), accountSignal);
            assertCurrentAccount();
            uploaded = { ...stored, url: getServerFileUrl(storageKey), width: meta.width, height: meta.height };
        } finally {
            URL.revokeObjectURL(temporary);
        }
        assertCurrentAccount();
        if (signal.aborted) {
            await deleteStoredImages([uploaded.storageKey]);
            assertCurrentAccount();
            signal.throwIfAborted();
        }
        return { uploaded, task };
    } catch (error) {
        if (error instanceof AccountApiError) throw error;
        assertCurrentAccount();
        if (signal.aborted) {
            // A lost POST response is ambiguous: it may have created a GPU job.
            // A definite 4xx rejection is safe, but never report unknown work as stopped.
            if (!taskId && !(error instanceof ComfyUiApiError && error.status >= 400 && error.status < 500)) {
                throw new ComfyUiApiError("CANCEL_FAILED", "已停止本地等待，但创建响应丢失，无法确认上游任务状态；请检查 ComfyUI 队列", 502, true);
            }
            try {
                await cancelRemote();
            } catch (cancelError) {
                if (cancelError instanceof AccountApiError) throw cancelError;
                assertCurrentAccount();
                throw new ComfyUiApiError("CANCEL_FAILED", "已停止本地接收，但无法确认上游任务已取消，请检查 ComfyUI 队列", 502, true);
            }
            assertCurrentAccount();
            if (signal.reason?.name === "TimeoutError") throw new ComfyUiApiError("GENERATION_TIMEOUT", "生成等待超时，已请求取消上游任务，请检查 ComfyUI 队列后重试", 504, true);
            throw signal.reason;
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
    }
}
