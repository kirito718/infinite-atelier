import { nanoid } from "nanoid";
import { isAllowedDirectorEvent, parseDirectorMessage } from "./director-message";
import { DIRECTOR_PROTOCOL, DIRECTOR_PROTOCOL_VERSION, type DirectorCaptureRequest, type DirectorCaptureResult } from "@/types/director";

class DirectorCaptureError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "DirectorCaptureError";
    }
}

type CaptureClientOptions = {
    nodeId: string;
    getFrameWindow: () => Window | null;
    origin: string;
    onReady: (ready: boolean) => void;
    onExport: (kind: "image" | "video", blob: Blob) => void;
    timeoutMs?: number;
};

/** One correlated capture at a time. The React host owns the actual message listener. */
export function createDirectorCaptureClient(options: CaptureClientOptions) {
    let ready = false;
    let disposed = false;
    let pending: { requestId: string; resolve: (result: DirectorCaptureResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

    const rejectPending = (error: Error) => {
        if (!pending) return;
        const current = pending;
        pending = null;
        clearTimeout(current.timer);
        current.reject(error);
    };
    const cancel = () => rejectPending(new DOMException("控制图捕获已取消", "AbortError"));

    return {
        handleMessage(event: MessageEvent) {
            if (disposed || !isAllowedDirectorEvent(event, options.getFrameWindow(), options.origin)) return;
            const data = event.data;
            if (data?.source === "monoform" && data.type === "export" && (data.kind === "image" || data.kind === "video") && data.blob instanceof Blob && data.blob.size > 0) {
                options.onExport(data.kind, data.blob);
                return;
            }
            const message = parseDirectorMessage(data);
            if (!message || message.source !== "monoform") return;
            if (message.type === "ready" || message.type === "monoform:ready") {
                if (message.payload?.projectKey && message.payload.projectKey !== options.nodeId) return;
                const capabilities = message.payload?.capabilities || [];
                ready = capabilities.includes("capture-pose") && capabilities.includes("capture-depth");
                options.onReady(ready);
                return;
            }
            // Errors without a requestId may belong to a different export. Ignore them.
            if (!pending || !("requestId" in message) || message.requestId !== pending.requestId) return;
            if (message.type === "error" || message.type === "monoform:error") {
                rejectPending(new DirectorCaptureError(message.payload.code, message.payload.message));
                return;
            }
            if (message.type !== "control.result" && message.type !== "monoform:control-result") return;
            const { pose, depth } = message.payload;
            if ([pose, depth].some((pass) => pass.width !== 1024 || pass.height !== 1024 || pass.mimeType !== "image/png" || !pass.blob.size)) {
                rejectPending(new DirectorCaptureError("CAPTURE_INVALID", "控制图尺寸或格式不正确，请重新捕获"));
                return;
            }
            const current = pending;
            pending = null;
            clearTimeout(current.timer);
            current.resolve(message);
        },
        capture(): Promise<DirectorCaptureResult> {
            const frame = options.getFrameWindow();
            if (disposed || !ready || !frame || !options.origin) return Promise.reject(new DirectorCaptureError("NOT_READY", "MONOFORM 尚未就绪，请等待加载完成"));
            if (pending) return Promise.reject(new DirectorCaptureError("CAPTURE_IN_PROGRESS", "已有控制图捕获正在进行"));
            return new Promise((resolve, reject) => {
                const request: DirectorCaptureRequest = {
                    protocol: DIRECTOR_PROTOCOL,
                    version: DIRECTOR_PROTOCOL_VERSION,
                    source: "atelier",
                    type: "control.capture",
                    requestId: nanoid(),
                    // The iframe resolves its active shot/frame at the instant capture begins.
                    payload: { passes: ["pose", "depth"], width: 1024, height: 1024 },
                };
                const timer = setTimeout(() => rejectPending(new DirectorCaptureError("CAPTURE_TIMEOUT", "控制图捕获超时，请重试；若仍无响应，请重新打开导演台")), options.timeoutMs ?? 30_000);
                pending = { requestId: request.requestId, resolve, reject, timer };
                try {
                    frame.postMessage(request, options.origin);
                } catch {
                    rejectPending(new DirectorCaptureError("CAPTURE_FAILED", "无法连接 MONOFORM，请重新打开导演台"));
                }
            });
        },
        cancel,
        dispose() {
            disposed = true;
            ready = false;
            cancel();
        },
    };
}
