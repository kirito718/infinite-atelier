import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountApiError, authenticatedFetch, setAccountIdentity } from "./account-client";
import { getComfyUiJob, getComfyUiOutput } from "./comfyui-director";

const json = (value: unknown, status = 200) => Response.json(value, { status });
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}

beforeEach(() => setAccountIdentity("alice"));
afterEach(() => {
    setAccountIdentity(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("ComfyUI account transport", () => {
    it.each([
        ["POST", "/api/comfyui/jobs"],
        ["DELETE", new URL("http://localhost/api/comfyui/jobs/task-1")],
        ["GET", new Request("http://localhost/api/comfyui/jobs/task-1/output")],
    ])("authenticates same-origin %s %s", async (method, url) => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
        await authenticatedFetch(url, { method: String(method) });
        const init = fetchMock.mock.calls[0][1];
        expect(init?.credentials).toBe("same-origin");
        expect(new Headers(init?.headers).get("X-Atelier-Request")).toBe("1");
        expect(new Headers(init?.headers).get("X-Atelier-User")).toBe("alice");
    });

    it.each(["https://other.example/api/comfyui/jobs", "/api/comfyui-other/jobs"])("does not leak identity headers to %s", async (url) => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
        await authenticatedFetch(url, { method: "POST" });
        const init = fetchMock.mock.calls[0][1];
        expect(new Headers(init?.headers).has("X-Atelier-User")).toBe(false);
        expect(new Headers(init?.headers).has("X-Atelier-Request")).toBe(false);
        expect(init?.credentials).toBeUndefined();
    });

    it.each([
        [401, "UNAUTHENTICATED", "会话已过期", "atelier:session-expired"],
        [409, "ACCOUNT_CHANGED", "当前账户不是任务所有者", "atelier:account-changed"],
    ])("preserves the top-level %s account error instead of a ComfyUI business error", async (status, code, message, event) => {
        const target = Object.assign(new EventTarget(), { location: { origin: "http://localhost" } });
        vi.stubGlobal("window", target);
        const events: string[] = [];
        target.addEventListener(String(event), (value) => events.push(value.type));
        vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ code, error: message }, Number(status)));
        await expect(getComfyUiJob("task-1")).rejects.toSatisfy((error: unknown) => {
            expect(error).toBeInstanceOf(AccountApiError);
            expect(error).toMatchObject({ code, status, message });
            return true;
        });
        expect(events).toEqual([event]);
    });

    it.each(["bobby", "alice"])("does not apply a late unauthorized body to the replacement %s session", async (nextUser) => {
        const target = Object.assign(new EventTarget(), { location: { origin: "http://localhost" } });
        vi.stubGlobal("window", target);
        const events: string[] = [];
        target.addEventListener("atelier:session-expired", (event) => events.push(event.type));
        const body = deferred<unknown>();
        const started = deferred<void>();
        const response = json({ code: "UNAUTHENTICATED", error: "expired" }, 401);
        const clone = response.clone();
        vi.spyOn(response, "clone").mockReturnValue(clone);
        vi.spyOn(clone, "json").mockImplementation(() => {
            started.resolve();
            return body.promise;
        });
        vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
        const result = authenticatedFetch("/api/account/session");
        const rejected = expect(result).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
        await started.promise;
        setAccountIdentity(null);
        setAccountIdentity(nextUser);
        body.resolve({ code: "UNAUTHENTICATED", error: "expired" });
        await rejected;
        expect(events).toEqual([]);
    });
});

describe("ComfyUI body reads remain bound to the originating session", () => {
    it.each(["json", "blob"] as const)("aborts a late %s body after an account switch", async (kind) => {
        const body = deferred<unknown>();
        const started = deferred<void>();
        const response = kind === "json" ? json({ taskId: "task-1", status: "succeeded" }) : new Response("png", { headers: { "content-type": "image/png" } });
        vi.spyOn(response, kind).mockImplementation(() => {
            started.resolve();
            return body.promise as Promise<Blob>;
        });
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
        const result = kind === "json" ? getComfyUiJob("task-1") : getComfyUiOutput("task-1");
        const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
        await started.promise;
        setAccountIdentity("bobby");
        body.resolve(kind === "json" ? { taskId: "task-1", status: "succeeded" } : new Blob(["png"], { type: "image/png" }));
        await rejected;
        expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    });

    it("does not start a deferred request under a replacement account", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ taskId: "task-1", status: "running" }));
        const result = getComfyUiJob("task-1");
        const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
        setAccountIdentity("bobby");
        await rejected;
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps the timeout active while authenticatedFetch inspects an error body", async () => {
        const response = json({ code: "UNAUTHENTICATED", error: "expired" }, 401);
        const clone = response.clone();
        vi.spyOn(response, "clone").mockReturnValue(clone);
        vi.spyOn(clone, "json").mockReturnValue(new Promise(() => {}));
        vi.spyOn(response, "json").mockReturnValue(new Promise(() => {}));
        vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
        await expect(getComfyUiJob("task-1", { timeoutMs: 10 })).rejects.toMatchObject({ code: "COMFYUI_TIMEOUT", retryable: true });
    });
});
