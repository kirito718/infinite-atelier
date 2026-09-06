import type { ComfyUiJobCreate, ComfyUiJobStatus } from "@/types/comfyui";
import { cancelComfyUiJob, ComfyUiApiError, createComfyUiJob, getComfyUiJob, getComfyUiOutput } from "./comfyui-director";
import { deleteStoredImages, uploadImage } from "./image-storage";

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

/** A complete task, including IndexedDB storage, with no late success after cancellation. */
export async function generateDirectorImage(input: ComfyUiJobCreate, options: GenerationOptions) {
    options.signal.throwIfAborted();
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new DOMException("Generation timed out", "TimeoutError")), options.timeoutMs ?? 15 * 60_000);
    const signal = AbortSignal.any([options.signal, deadline.signal]);
    let taskId: string | undefined;
    let cancellation: Promise<void> | undefined;
    const cancelRemote = () => {
        if (taskId) cancellation ??= cancelComfyUiJob(taskId);
        return cancellation;
    };
    const onAbort = () => {
        void cancelRemote()?.catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
        // Do not abort POST on user cancellation: retain its bounded response so
        // a just-created server task can still be cancelled by its returned ID.
        let task = await createComfyUiJob(input);
        taskId = task.taskId;
        signal.throwIfAborted();
        options.onStatus?.(task);
        while (!isTerminal(task)) {
            task = await getComfyUiJob(taskId, { signal });
            signal.throwIfAborted();
            options.onStatus?.(task);
            if (!isTerminal(task)) await pause(options.pollIntervalMs ?? 750, signal);
        }
        if (task.status === "cancelled") throw new DOMException("真人图生成已取消", "AbortError");
        if (task.status === "failed") {
            throw new ComfyUiApiError(task.error?.code || "GENERATION_FAILED", task.error?.message || "真人图生成失败，请检查 ComfyUI 工作流", 502, task.error?.retryable ?? false);
        }
        const blob = await getComfyUiOutput(taskId, { signal });
        signal.throwIfAborted();
        const uploaded = await uploadImage(blob);
        if (signal.aborted) {
            await deleteStoredImages([uploaded.storageKey]);
            signal.throwIfAborted();
        }
        return { uploaded, task };
    } catch (error) {
        if (signal.aborted) {
            try {
                await cancelRemote();
            } catch {
                throw new ComfyUiApiError("CANCEL_FAILED", "已停止本地接收，但无法确认上游任务已取消，请检查 ComfyUI 队列", 502, true);
            }
            if (signal.reason?.name === "TimeoutError") throw new ComfyUiApiError("GENERATION_TIMEOUT", "生成等待超时，已请求取消上游任务，请检查 ComfyUI 队列后重试", 504, true);
            throw signal.reason;
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
    }
}
