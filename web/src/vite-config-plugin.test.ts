import { describe, expect, it, vi } from "vitest";

import { codexSubscriptionApiPlugin } from "../vite.config";

describe("codex subscription Vite API plugin", () => {
    it("mounts the same API middleware in dev and preview including protected account and upstream endpoints", async () => {
        const mounted: Array<(request: { url?: string }, response: unknown, next: () => void) => void> = [];
        const closeHandlers: Array<() => void> = [];
        const api = { handle: vi.fn(() => Promise.resolve()), close: vi.fn(async () => {}) };
        const plugin = codexSubscriptionApiPlugin({ createApi: () => api });
        const server = {
            middlewares: { use: (handler: (request: { url?: string }, response: unknown, next: () => void) => void) => mounted.push(handler) },
            httpServer: { once: (_event: string, handler: () => void) => closeHandlers.push(handler) },
        };

        invokeHook(plugin.configureServer, server);
        invokeHook(plugin.configurePreviewServer, server);

        expect(mounted).toHaveLength(2);
        expect(closeHandlers).toHaveLength(2);

        const next = vi.fn();
        await mounted[0]({ url: "/api/codex-subscription/v1/status" }, {}, next);
        await mounted[0]({ url: "/api/account/session" }, {}, next);
        await mounted[0]({ url: "/api-proxy?target=https%3A%2F%2Fexample.com" }, {}, next);
        await mounted[0]({ url: "/api/comfyui/jobs" }, {}, next);
        await mounted[0]({ url: "/api/comfyui/jobs/task-1/output" }, {}, next);
        await mounted[0]({ url: "/other" }, {}, next);

        expect(api.handle).toHaveBeenCalledTimes(5);
        expect(next).toHaveBeenCalledTimes(1);
    });
});

function invokeHook(hook: unknown, server: unknown) {
    if (typeof hook === "function") {
        hook(server);
        return;
    }
    if (hook && typeof hook === "object" && "handler" in hook && typeof hook.handler === "function") {
        hook.handler(server);
    }
}
