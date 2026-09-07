import { randomUUID } from "node:crypto";

const STATES = new Set(["queued", "uploading", "submitted", "running", "succeeded", "failed", "cancelled"]);
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);
const TRANSITIONS = {
    queued: new Set(["uploading", "cancelled"]),
    uploading: new Set(["submitted", "failed", "cancelled"]),
    submitted: new Set(["running", "failed", "cancelled"]),
    running: new Set(["succeeded", "failed", "cancelled"]),
    succeeded: new Set(),
    failed: new Set(),
    cancelled: new Set(),
};

export class ComfyUiTaskStoreError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "ComfyUiTaskStoreError";
        this.code = code;
    }
}

export function createComfyUiTaskStore({ ttlMs = 10 * 60 * 1000, clock = Date.now } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new ComfyUiTaskStoreError("TASK_TTL_INVALID", "Task TTL must be a positive number");
    }
    const now = normalizeClock(clock);
    const tasks = new Map();
    const requestKeys = new Map();
    let closed = false;

    const sweep = () => {
        const timestamp = now();
        for (const [taskId, task] of tasks) {
            if (task.expiresAt !== undefined && task.expiresAt <= timestamp) {
                tasks.delete(taskId);
                if (task.requestKey && requestKeys.get(task.requestKey) === taskId) requestKeys.delete(task.requestKey);
            }
        }
    };

    const timer = setInterval(sweep, Math.min(ttlMs, 60_000));
    timer.unref?.();

    return {
        create(input = {}) {
            assertOpen();
            sweep();
            const requestKey = normalizeRequestKey(input.requestKey ?? input.idempotencyKey ?? input.requestId ?? input.key);
            const requestFingerprint = normalizeRequestFingerprint(input.requestFingerprint);
            if (requestKey) {
                const existingId = requestKeys.get(requestKey);
                const existing = existingId ? tasks.get(existingId) : undefined;
                if (existing) {
                    if ((existing.requestFingerprint || requestFingerprint) && existing.requestFingerprint !== requestFingerprint) {
                        throw new ComfyUiTaskStoreError("TASK_IDEMPOTENCY_CONFLICT", `Idempotency key is already bound to a different request: ${requestKey}`);
                    }
                    return snapshot(existing);
                }
                requestKeys.delete(requestKey);
            }

            const taskId = typeof input.taskId === "string" && input.taskId ? input.taskId : `task_${randomUUID()}`;
            if (tasks.has(taskId)) throw new ComfyUiTaskStoreError("TASK_ID_CONFLICT", `Task already exists: ${taskId}`);
            const task = {
                taskId,
                requestKey,
                requestFingerprint,
                workflowId: typeof input.workflowId === "string" ? input.workflowId : undefined,
                status: "queued",
                promptId: undefined,
                progress: undefined,
                output: undefined,
                error: undefined,
                expiresAt: undefined,
                context: input.context,
                timer: undefined,
            };
            tasks.set(taskId, task);
            if (requestKey) requestKeys.set(requestKey, taskId);
            return snapshot(task);
        },

        get(taskId) {
            assertOpen();
            sweep();
            const task = tasks.get(taskId);
            return task ? snapshot(task) : undefined;
        },

        update(taskId, patch = {}) {
            assertOpen();
            sweep();
            const task = requireTask(taskId);
            if (typeof patch === "string") patch = { status: patch };
            const nextStatus = patch.status ?? task.status;
            const nextOutput = patch.output !== undefined ? normalizeOutput(patch.output) : task.output;
            const nextProgress = patch.progress !== undefined ? cloneValue(patch.progress) : task.progress;
            const nextError = patch.error !== undefined ? cloneValue(patch.error) : task.error;
            if (task.status === "cancelled") {
                throw new ComfyUiTaskStoreError("TASK_CANCELLED", `Task ${taskId} is cancelled and cannot be updated`);
            }
            if (TERMINAL_STATES.has(task.status)) {
                throw new ComfyUiTaskStoreError("TASK_TERMINAL", `Task ${taskId} is already ${task.status} and cannot be updated`);
            }
            if (patch.status !== undefined) {
                if (!STATES.has(nextStatus) || !TRANSITIONS[task.status].has(nextStatus)) {
                    throw new ComfyUiTaskStoreError("TASK_TRANSITION_INVALID", `Invalid task transition: ${task.status} -> ${nextStatus}`);
                }
            }
            if (nextStatus === "succeeded" && !nextOutput) throw new ComfyUiTaskStoreError("TASK_OUTPUT_INVALID", "A succeeded task must retain output bytes");
            task.status = nextStatus;
            if (patch.workflowId !== undefined) task.workflowId = patch.workflowId;
            if (patch.promptId !== undefined) task.promptId = patch.promptId;
            task.progress = nextProgress;
            task.error = nextError;
            task.output = nextOutput;
            if (nextStatus === "cancelled") {
                task.output = undefined;
                task.error = { code: "CANCELLED", message: "ComfyUI generation was cancelled", retryable: false };
            }
            if (TERMINAL_STATES.has(task.status)) armExpiry(task);
            return snapshot(task);
        },

        cancel(taskId) {
            assertOpen();
            sweep();
            const task = requireTask(taskId);
            if (TERMINAL_STATES.has(task.status)) return snapshot(task);
            task.status = "cancelled";
            task.output = undefined;
            task.error = { code: "CANCELLED", message: "ComfyUI generation was cancelled", retryable: false };
            armExpiry(task);
            return snapshot(task);
        },

        close() {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            for (const task of tasks.values()) clearTimeout(task.timer);
            tasks.clear();
            requestKeys.clear();
        },
    };

    function assertOpen() {
        if (closed) throw new ComfyUiTaskStoreError("TASK_STORE_CLOSED", "Task store is closed");
    }

    function requireTask(taskId) {
        if (typeof taskId !== "string" || !taskId) throw new ComfyUiTaskStoreError("TASK_NOT_FOUND", "Task not found");
        const task = tasks.get(taskId);
        if (!task) throw new ComfyUiTaskStoreError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
        return task;
    }

    function armExpiry(task) {
        clearTimeout(task.timer);
        task.expiresAt = now() + ttlMs;
        task.timer = setTimeout(() => {
            if (task.expiresAt !== undefined && task.expiresAt <= now()) {
                tasks.delete(task.taskId);
                if (task.requestKey && requestKeys.get(task.requestKey) === task.taskId) requestKeys.delete(task.requestKey);
            }
        }, ttlMs);
        task.timer.unref?.();
    }
}

function snapshot(task) {
    const value = {
        taskId: task.taskId,
        workflowId: task.workflowId,
        status: task.status,
        promptId: task.promptId,
        progress: task.progress ? cloneValue(task.progress) : undefined,
        output: task.output ? { ...task.output, bytes: cloneBytes(task.output.bytes) } : undefined,
        error: task.error ? cloneValue(task.error) : undefined,
    };
    Object.defineProperty(value, "id", { value: task.taskId, enumerable: false });
    Object.defineProperty(value, "requestKey", { value: task.requestKey, enumerable: false });
    Object.defineProperty(value, "requestFingerprint", { value: task.requestFingerprint, enumerable: false });
    Object.defineProperty(value, "context", { value: task.context, enumerable: false });
    return value;
}

function normalizeOutput(output) {
    if (!output || (typeof output.bytes !== "object" && !Buffer.isBuffer(output.bytes))) {
        throw new ComfyUiTaskStoreError("TASK_OUTPUT_INVALID", "Task output bytes are required");
    }
    if (typeof output.mimeType !== "string" || !output.mimeType) {
        throw new ComfyUiTaskStoreError("TASK_OUTPUT_INVALID", "Task output mimeType is required");
    }
    return {
        bytes: cloneBytes(output.bytes),
        mimeType: output.mimeType,
        width: Number.isFinite(output.width) ? output.width : undefined,
        height: Number.isFinite(output.height) ? output.height : undefined,
    };
}

function cloneBytes(bytes) {
    if (Buffer.isBuffer(bytes)) return Buffer.from(bytes);
    if (bytes instanceof Uint8Array) return Buffer.from(bytes);
    if (bytes instanceof ArrayBuffer) return Buffer.from(bytes.slice(0));
    throw new ComfyUiTaskStoreError("TASK_OUTPUT_INVALID", "Task output bytes must be binary");
}

function cloneValue(value) {
    if (value === undefined) return undefined;
    return structuredClone(value);
}

function normalizeClock(clock) {
    if (typeof clock === "function") return () => Number(clock());
    if (clock && typeof clock.now === "function") return () => Number(clock.now());
    throw new ComfyUiTaskStoreError("TASK_CLOCK_INVALID", "Task clock must be a function or object with now()");
}

function normalizeRequestKey(value) {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !value.trim()) throw new ComfyUiTaskStoreError("TASK_KEY_INVALID", "Idempotency key must be a non-empty string");
    const key = value.trim();
    if (key.length > 256) throw new ComfyUiTaskStoreError("TASK_KEY_INVALID", "Idempotency key is too long");
    return key;
}

function normalizeRequestFingerprint(value) {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || value.length > 256) throw new ComfyUiTaskStoreError("TASK_FINGERPRINT_INVALID", "Request fingerprint is invalid");
    return value;
}
