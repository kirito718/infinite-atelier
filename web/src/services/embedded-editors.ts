import { nanoid } from "nanoid";
import { getAccountIdentity } from "./account-client";

type FrameState = { userId: string; pending: boolean };
export function createEmbeddedEditorBridge(browser: Window, identity: () => string | null) {
    const editors = new Map<Window, FrameState>();
    const requests = new Map<string, { source: Window; userId: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const listeners = new Set<() => void>();
    let snapshot = { pending: 0 };
    function liveFrames() {
        return [...browser.document.querySelectorAll<HTMLIFrameElement>("iframe")]
            .filter((frame) => {
                try {
                    const url = new URL(frame.src, browser.location.origin);
                    return url.origin === browser.location.origin && /\/monoform\/index\.html$/.test(url.pathname);
                } catch {
                    return false;
                }
            })
            .map((frame) => frame.contentWindow)
            .filter((value): value is Window => Boolean(value));
    }
    function publish() {
        const live = liveFrames();
        for (const frame of editors.keys()) if (!live.includes(frame)) editors.delete(frame);
        const pending = [...editors.values()].filter((item) => item.userId === identity() && item.pending).length;
        if (pending !== snapshot.pending) {
            snapshot = { pending };
            listeners.forEach((listener) => listener());
        }
    }
    function onMessage(event: MessageEvent) {
        if (event.origin !== browser.location.origin || !liveFrames().includes(event.source as Window)) return;
        const data = event.data;
        if (!data || data.userId !== identity()) return;
        if (data.type === "atelier:editor-status" && typeof data.pending === "boolean") {
            editors.set(event.source as Window, { userId: data.userId, pending: data.pending });
            publish();
        }
        if (data.type === "atelier:editor-flushed") {
            const request = requests.get(data.requestId);
            if (!request || request.source !== event.source || request.userId !== data.userId) return;
            clearTimeout(request.timer);
            requests.delete(data.requestId);
            if (data.ok === true) request.resolve();
            else request.reject(new Error("导演台仍有未保存内容，请在导演台重试保存或导出工程后再离开。"));
        }
    }
    browser.addEventListener("message", onMessage);
    return {
        hasPending: () => {
            publish();
            return snapshot.pending > 0;
        },
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        async flush() {
            publish();
            const userId = identity();
            await Promise.all(
                [...editors]
                    .filter(([, state]) => state.userId === userId)
                    .map(
                        ([source]) =>
                            new Promise<void>((resolve, reject) => {
                                const requestId = nanoid();
                                const timer = setTimeout(() => {
                                    requests.delete(requestId);
                                    reject(new Error("等待导演台保存超时，请返回导演台检查。"));
                                }, 15000);
                                requests.set(requestId, { source, userId: userId!, resolve, reject, timer });
                                source.postMessage({ type: "atelier:flush-editor", userId, requestId }, browser.location.origin);
                            }),
                    ),
            );
        },
        dispose() {
            browser.removeEventListener("message", onMessage);
            for (const request of requests.values()) {
                clearTimeout(request.timer);
                request.reject(new Error("编辑器已关闭，未确认保存。"));
            }
            requests.clear();
            editors.clear();
            listeners.clear();
        },
    };
}
let bridge: ReturnType<typeof createEmbeddedEditorBridge> | null = null;
export function installEmbeddedEditorBridge() {
    if (!bridge && typeof window !== "undefined") bridge = createEmbeddedEditorBridge(window, getAccountIdentity);
}
export const hasPendingEmbeddedEditors = () => bridge?.hasPending() || false;
export const flushEmbeddedEditors = async () => {
    await bridge?.flush();
};
export const subscribeEmbeddedEditors = (listener: () => void) => bridge?.subscribe(listener) || (() => {});
const empty = { pending: 0 };
export const getEmbeddedEditorsSnapshot = () => bridge?.getSnapshot() || empty;
