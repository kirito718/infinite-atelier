import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readImageMeta } from "@/lib/image-utils";
import type { ComfyUiJobCreate } from "@/types/comfyui";
import { getAccountIdentity, setAccountIdentity } from "./account-client";
import { generateDirectorImage } from "./director-generation";

vi.mock("@/lib/image-utils", () => ({ readImageMeta: vi.fn() }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("nanoid", () => ({ nanoid: () => "result" }));
const blob = new Blob(["old-account-image"], { type: "image/png" });
const input: ComfyUiJobCreate = {
    workflowId: "portrait-pose-depth",
    prompt: "portrait",
    shotId: "shot-1",
    frame: 0,
    width: 640,
    height: 768,
    pose: { blob, mimeType: "image/png", width: 640, height: 768 },
    depth: { blob, mimeType: "image/png", width: 640, height: 768 },
};
const queued = { taskId: "task-1", status: "queued", workflowId: "portrait-pose-depth" };
const succeeded = { ...queued, status: "succeeded", promptId: "prompt-1" };
const stored = { storageKey: "image:result", mimeType: "image/png", bytes: blob.size };
const meta = { width: 640, height: 768, mimeType: "image/png" };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const output = () => new Response(blob, { headers: { "content-type": "image/png" } });
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}
function replaceSession(nextUser: string) {
    setAccountIdentity(null);
    setAccountIdentity(nextUser);
}
type Sent = { method: string; url: string; identity: string | null; signal?: AbortSignal | null };
let sent: Sent[];
function mockHttp(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation((url, init = {}) => {
        sent.push({ method: init.method || "GET", url: String(url), identity: getAccountIdentity(), signal: init.signal });
        return Promise.resolve(handler(String(url), init));
    });
}
function defaultResponse(url: string, init: RequestInit) {
    if (init.method === "POST") return json(queued, 202);
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (init.method === "PUT") return json(stored);
    return url.endsWith("/output") ? output() : json(succeeded);
}

beforeEach(() => {
    setAccountIdentity("alice");
    sent = [];
    vi.mocked(readImageMeta).mockResolvedValue(meta);
});
afterEach(() => {
    setAccountIdentity(null);
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useRealTimers();
});

describe("account-bound ComfyUI generation", () => {
    it("rejects a missing identity before starting a server task", async () => {
        setAccountIdentity(null);
        mockHttp(defaultResponse);
        await expect(generateDirectorImage(input, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
        expect(sent).toEqual([]);
    });

    it.each(["bobby", "alice"])("discards a late POST when the originating session is replaced by %s", async (nextUser) => {
        const creation = deferred<Response>();
        const started = deferred<void>();
        mockHttp((url, init) => {
            if (init.method === "POST") {
                started.resolve();
                return creation.promise;
            }
            return defaultResponse(url, init);
        });
        const statuses: string[] = [];
        const result = generateDirectorImage(input, { signal: new AbortController().signal, onStatus: (task) => statuses.push(task.status) });
        const rejected = expect(result).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
        await started.promise;
        replaceSession(nextUser);
        creation.resolve(json(queued, 202));
        await rejected;
        expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual(["POST /api/comfyui/jobs"]);
        expect(sent[0].signal?.aborted).toBe(true);
        expect(statuses).toEqual([]);
    });

    it("does not cancel a late POST with the next account's cookie after user cancellation", async () => {
        const creation = deferred<Response>();
        const started = deferred<void>();
        mockHttp((url, init) => {
            if (init.method === "POST") {
                started.resolve();
                return creation.promise;
            }
            return defaultResponse(url, init);
        });
        const controller = new AbortController();
        const result = generateDirectorImage(input, { signal: controller.signal });
        const rejected = expect(result).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
        await started.promise;
        controller.abort();
        replaceSession("bobby");
        creation.resolve(json(queued, 202));
        await rejected;
        expect(sent.map(({ method }) => method)).toEqual(["POST"]);
    });

    it("checks session changes made inside onStatus before issuing the first poll", async () => {
        mockHttp(defaultResponse);
        await expect(
            generateDirectorImage(input, {
                signal: new AbortController().signal,
                onStatus: () => setAccountIdentity("bobby"),
            }),
        ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
        expect(sent.map(({ method }) => method)).toEqual(["POST"]);
    });

    it("stops the polling pause on account change without cancelling under the next identity", async () => {
        vi.useFakeTimers();
        const running = deferred<void>();
        let polls = 0;
        mockHttp((url, init) => {
            if (url === "/api/comfyui/jobs/task-1" && !init.method && polls++ === 0) return json({ ...queued, status: "running" });
            return defaultResponse(url, init);
        });
        const result = generateDirectorImage(input, {
            signal: new AbortController().signal,
            pollIntervalMs: 750,
            onStatus: (task) => {
                if (task.status === "running") running.resolve();
            },
        });
        const rejected = expect(result).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
        await running.promise;
        setAccountIdentity("bobby");
        await vi.advanceTimersByTimeAsync(750);
        await rejected;
        expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual(["POST /api/comfyui/jobs", "GET /api/comfyui/jobs/task-1"]);
    });

    it("does not dispatch an already-scheduled DELETE after the session changes", async () => {
        const polling = deferred<Response>();
        const started = deferred<void>();
        mockHttp((url, init) => {
            if (url === "/api/comfyui/jobs/task-1" && !init.method) {
                started.resolve();
                return polling.promise;
            }
            return defaultResponse(url, init);
        });
        const controller = new AbortController();
        const result = generateDirectorImage(input, { signal: controller.signal });
        const rejected = expect(result).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
        await started.promise;
        controller.abort();
        setAccountIdentity("bobby");
        polling.resolve(json(succeeded));
        await rejected;
        expect(sent.map(({ method }) => method)).toEqual(["POST", "GET"]);
    });

    it.each(["poll", "output"])("does not publish or persist a late %s body under the next account", async (stage) => {
        const body = deferred<unknown>();
        const started = deferred<void>();
        mockHttp((url, init) => {
            const response = defaultResponse(url, init);
            if (init.method) return response;
            if (stage === "poll" && url === "/api/comfyui/jobs/task-1") {
                vi.spyOn(response, "json").mockImplementation(() => {
                    started.resolve();
                    return body.promise;
                });
            }
            if (stage === "output" && url.endsWith("/output")) {
                vi.spyOn(response, "blob").mockImplementation(() => {
                    started.resolve();
                    return body.promise as Promise<Blob>;
                });
            }
            return response;
        });
        const statuses: string[] = [];
        const result = generateDirectorImage(input, { signal: new AbortController().signal, onStatus: (task) => statuses.push(task.status) });
        const rejected = expect(result).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
        await started.promise;
        setAccountIdentity("bobby");
        body.resolve(stage === "poll" ? succeeded : blob);
        await rejected;
        expect(sent.every(({ identity }) => identity === "alice")).toBe(true);
        expect(sent.filter(({ method }) => method === "PUT" || method === "DELETE")).toEqual([]);
        expect(statuses).toEqual(stage === "poll" ? ["queued"] : ["queued", "succeeded"]);
    });

    it.each(["bobby", "alice"])("does not upload after image decoding outlives its session (%s)", async (nextUser) => {
        const decoding = deferred<typeof meta>();
        const started = deferred<void>();
        vi.mocked(readImageMeta).mockImplementation(() => {
            started.resolve();
            return decoding.promise;
        });
        mockHttp(defaultResponse);
        const result = generateDirectorImage(input, { signal: new AbortController().signal });
        const rejected = expect(result).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
        await started.promise;
        replaceSession(nextUser);
        decoding.resolve(meta);
        await rejected;
        expect(sent.filter(({ method }) => method === "PUT" || method === "DELETE")).toEqual([]);
    });

    it.each([
        ["bobby", false],
        ["alice", false],
        ["bobby", true],
        ["alice", true],
    ])("does not publish or clean up an old upload in session %s (user cancelled: %s)", async (nextUser, cancel) => {
        const body = deferred<typeof stored>();
        const started = deferred<void>();
        mockHttp((url, init) => {
            if (init.method === "PUT") {
                const response = json(stored);
                vi.spyOn(response, "json").mockImplementation(() => {
                    started.resolve();
                    return body.promise;
                });
                return response;
            }
            return defaultResponse(url, init);
        });
        const controller = new AbortController();
        const result = generateDirectorImage(input, { signal: controller.signal });
        const rejected = expect(result).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
        await started.promise;
        replaceSession(String(nextUser));
        if (cancel) controller.abort();
        body.resolve(stored);
        await rejected;
        expect(sent.filter(({ method }) => method === "PUT")).toHaveLength(1);
        expect(sent.every(({ identity }) => identity === "alice")).toBe(true);
        expect(sent.filter(({ method }) => method === "DELETE")).toEqual([]);
    });
});

describe("same-session bounded cancellation", () => {
    it("retains a late POST body long enough to cancel exactly its returned task", async () => {
        const body = deferred<typeof queued>();
        const started = deferred<void>();
        const fetchMock = mockHttp((url, init) => {
            if (init.method === "POST") {
                const response = json(queued, 202);
                vi.spyOn(response, "json").mockImplementation(() => {
                    started.resolve();
                    return body.promise;
                });
                return response;
            }
            return defaultResponse(url, init);
        });
        const controller = new AbortController();
        const result = generateDirectorImage(input, { signal: controller.signal });
        const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
        await started.promise;
        controller.abort();
        body.resolve(queued);
        await rejected;
        expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual(["POST /api/comfyui/jobs", "DELETE /api/comfyui/jobs/task-1"]);
        const cancellation = fetchMock.mock.calls[1][1];
        expect(cancellation?.credentials).toBe("same-origin");
        expect(new Headers(cancellation?.headers).get("X-Atelier-User")).toBe("alice");
        expect(new Headers(cancellation?.headers).get("X-Atelier-Request")).toBe("1");
    });

    it("bounds the retained POST body wait and reports an unknown upstream task honestly", async () => {
        vi.useFakeTimers();
        const started = deferred<void>();
        mockHttp(() => {
            const response = json(queued, 202);
            vi.spyOn(response, "json").mockImplementation(() => {
                started.resolve();
                return new Promise(() => {});
            });
            return response;
        });
        const controller = new AbortController();
        const result = generateDirectorImage(input, { signal: controller.signal });
        const rejected = expect(result).rejects.toMatchObject({ code: "CANCEL_FAILED" });
        await started.promise;
        controller.abort();
        await vi.advanceTimersByTimeAsync(60_000);
        await rejected;
        expect(sent.map(({ method }) => method)).toEqual(["POST"]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("scoped-cancels a known task when the generation deadline interrupts a stalled poll body", async () => {
        vi.useFakeTimers();
        const started = deferred<void>();
        mockHttp((url, init) => {
            const response = defaultResponse(url, init);
            if (url === "/api/comfyui/jobs/task-1" && !init.method) {
                vi.spyOn(response, "json").mockImplementation(() => {
                    started.resolve();
                    return new Promise(() => {});
                });
            }
            return response;
        });
        const statuses: string[] = [];
        const result = generateDirectorImage(input, { signal: new AbortController().signal, timeoutMs: 10, onStatus: (task) => statuses.push(task.status) });
        const rejected = expect(result).rejects.toMatchObject({ code: "GENERATION_TIMEOUT" });
        await started.promise;
        await vi.advanceTimersByTimeAsync(10);
        await rejected;
        expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual(["POST /api/comfyui/jobs", "GET /api/comfyui/jobs/task-1", "DELETE /api/comfyui/jobs/task-1"]);
        expect(statuses).toEqual(["queued"]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("abandons an in-flight cancellation rather than retrying it in the next session", async () => {
        const polling = deferred<Response>();
        const pollStarted = deferred<void>();
        const cancellation = deferred<Response>();
        const cancelStarted = deferred<void>();
        mockHttp((url, init) => {
            if (init.method === "DELETE") {
                cancelStarted.resolve();
                return cancellation.promise;
            }
            if (url === "/api/comfyui/jobs/task-1" && !init.method) {
                pollStarted.resolve();
                return polling.promise;
            }
            return defaultResponse(url, init);
        });
        const controller = new AbortController();
        const result = generateDirectorImage(input, { signal: controller.signal });
        const rejected = expect(result).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
        await pollStarted.promise;
        controller.abort();
        await cancelStarted.promise;
        setAccountIdentity("bobby");
        cancellation.resolve(new Response(null, { status: 204 }));
        polling.resolve(json(succeeded));
        await rejected;
        expect(sent.map(({ method, identity }) => [method, identity])).toEqual([
            ["POST", "alice"],
            ["GET", "alice"],
            ["DELETE", "alice"],
        ]);
        expect(sent[2].signal?.aborted).toBe(true);
    });
});
