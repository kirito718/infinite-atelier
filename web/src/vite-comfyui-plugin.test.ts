import { afterEach, describe, expect, it, vi } from "vitest";
import { codexSubscriptionApiPlugin as comfyuiApiPlugin } from "../vite.config";

const mount = (plugin: ReturnType<typeof comfyuiApiPlugin>, preview = false) => {
    const handlers: any[] = [];
    const server = { middlewares: { use: (fn: any) => handlers.push(fn) }, httpServer: { once: vi.fn() } };
    const hook = preview ? plugin.configurePreviewServer : plugin.configureServer;
    if (typeof hook === "function") hook.call({} as any, server as any);
    return handlers[0];
};
function response() {
    return { headersSent: false, statusCode: 0, writeHead: vi.fn(), end: vi.fn() };
}
afterEach(() => vi.unstubAllEnvs());

describe("authenticated ComfyUI dev/preview gateway", () => {
    it.each([false, true])("mounts the job route without intercepting frontend pages (preview=%s)", async (preview) => {
        vi.stubEnv("COMFYUI_BASE_URL", "http://comfyui:8188");
        const handle = vi.fn(async () => {});
        const middleware = mount(comfyuiApiPlugin({ createApi: () => ({ handle, close: async () => {} }) }), preview);
        const next = vi.fn();
        middleware({ url: "/canvas" }, response(), next);
        middleware({ url: "/api/comfyui/jobs/task-1" }, response(), next);
        await Promise.resolve();
        expect(next).toHaveBeenCalledTimes(1);
        expect(handle).toHaveBeenCalledTimes(1);
    });
    it("fails closed when account storage initialization fails without exposing paths or secrets", () => {
        vi.stubEnv("COMFYUI_BASE_URL", "http://comfyui:8188");
        const middleware = mount(
            comfyuiApiPlugin({
                createApi: () => {
                    throw new Error("secret-value /private/workflow/path");
                },
            }),
        );
        const res = response();
        middleware({ url: "/api/comfyui/jobs" }, res, vi.fn());
        expect(res.writeHead.mock.calls[0][0]).toBe(503);
        const body = res.end.mock.calls[0][0].toString();
        expect(JSON.parse(body)).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
        expect(body).not.toMatch(/secret-value|private\/workflow/);
    });
});
