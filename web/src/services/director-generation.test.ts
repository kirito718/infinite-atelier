import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComfyUiJobCreate } from "@/types/comfyui";
import { setAccountIdentity } from "./account-client";
import { generateDirectorImage } from "./director-generation";

// Keep orchestration, account transport and persistence real; only browser decoding
// and random IDs are controlled so assertions can cover the actual storage writes.
vi.mock("@/lib/image-utils", () => ({ readImageMeta: vi.fn().mockResolvedValue({ width: 1024, height: 1024, mimeType: "image/png" }) }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("nanoid", () => ({ nanoid: () => "result" }));
const blob = new Blob(["png"], { type: "image/png" });
const input: ComfyUiJobCreate = {
    workflowId: "portrait-pose-depth",
    prompt: "portrait",
    shotId: "shot-2",
    frame: 48,
    width: 1024,
    height: 1024,
    pose: { blob, mimeType: "image/png", width: 1024, height: 1024 },
    depth: { blob, mimeType: "image/png", width: 1024, height: 1024 },
};
const storageUrl = "/api/account/files/image%3Aresult?account=alice";
const stored = { storageKey: "image:result", bytes: 3, mimeType: "image/png" };
const uploaded = { ...stored, url: storageUrl, width: 1024, height: 1024 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const queued = { taskId: "task-1", status: "queued", workflowId: "portrait-pose-depth" };
const succeeded = { ...queued, status: "succeeded", promptId: "prompt-1" };
const uploads = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "PUT");
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

beforeEach(() => setAccountIdentity("alice"));
afterEach(() => {
    setAccountIdentity(null);
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe("Director generation orchestration", () => {
    it("creates, polls, downloads and stores the output with the terminal task provenance", async () => {
        const requests: string[] = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
            requests.push(`${init?.method || "GET"} ${url}`);
            if (init?.method === "POST") return json(queued, 202);
            if (init?.method === "PUT") return json(stored);
            if (String(url).endsWith("/output")) return new Response(blob, { headers: { "content-type": "image/png" } });
            return json(succeeded);
        });
        const states: string[] = [];
        const result = await generateDirectorImage(input, { signal: new AbortController().signal, onStatus: (task) => states.push(task.status) });
        expect(result).toEqual({ uploaded, task: succeeded });
        expect(states).toEqual(["queued", "succeeded"]);
        expect(requests).toEqual(["POST /api/comfyui/jobs", "GET /api/comfyui/jobs/task-1", "GET /api/comfyui/jobs/task-1/output", `PUT ${storageUrl}`]);
        expect(uploads()).toHaveLength(1);
        expect(await (uploads()[0][1]?.body as Blob).text()).toBe("png");
        expect(new Headers(uploads()[0][1]?.headers).get("X-Atelier-User")).toBe("alice");
    });
    it("cancels the task even if cancellation precedes receipt of the create response", async () => {
        const creation = deferred<Response>();
        const started = deferred<void>();
        const requests: string[] = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
            requests.push(`${init?.method || "GET"} ${url}`);
            if (init?.method === "POST") {
                started.resolve();
                return creation.promise;
            }
            return new Response(null, { status: 204 });
        });
        const controller = new AbortController();
        const result = generateDirectorImage(input, { signal: controller.signal });
        const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
        await started.promise;
        controller.abort();
        creation.resolve(json(queued, 202));
        await rejected;
        expect(requests).toEqual(["POST /api/comfyui/jobs", "DELETE /api/comfyui/jobs/task-1"]);
        expect(uploads()).toEqual([]);
    });
    it("ignores a late successful status after cancellation and never downloads or stores it", async () => {
        const polling = deferred<Response>();
        const started = deferred<void>();
        const statuses: string[] = [];
        const requests: string[] = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
            requests.push(`${init?.method || "GET"} ${url}`);
            if (init?.method === "POST") return json(queued, 202);
            if (init?.method === "DELETE") return new Response(null, { status: 204 });
            started.resolve();
            return polling.promise;
        });
        const controller = new AbortController();
        const result = generateDirectorImage(input, { signal: controller.signal, onStatus: (task) => statuses.push(task.status) });
        const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
        await started.promise;
        controller.abort();
        polling.resolve(json(succeeded));
        await rejected;
        expect(statuses).toEqual(["queued"]);
        expect(requests.filter((request) => request.startsWith("DELETE"))).toHaveLength(1);
        expect(requests.some((request) => request.endsWith("/output"))).toBe(false);
        expect(uploads()).toEqual([]);
    });
    it("removes an image stored after cancellation instead of publishing a late canvas success", async () => {
        const storage = deferred<Response>();
        const started = deferred<void>();
        const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
            if (init?.method === "POST") return json(succeeded, 202);
            if (init?.method === "PUT") {
                started.resolve();
                return storage.promise;
            }
            if (init?.method === "DELETE") return new Response(null, { status: 204 });
            return new Response(blob, { headers: { "content-type": "image/png" } });
        });
        const controller = new AbortController();
        const result = generateDirectorImage(input, { signal: controller.signal });
        const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
        await started.promise;
        controller.abort();
        storage.resolve(json(stored));
        await rejected;
        expect(uploads()).toHaveLength(1);
        expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => url)).toEqual(["/api/comfyui/jobs/task-1", storageUrl]);
        const cleanup = fetchMock.mock.calls.find(([url, init]) => url === storageUrl && init?.method === "DELETE");
        expect(new Headers(cleanup?.[1]?.headers).get("X-Atelier-User")).toBe("alice");
    });
    it("reports provider failures and cancellation failures honestly", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ ...queued, status: "failed", error: { code: "WORKFLOW_INVALID", message: "Missing ControlNet model", retryable: false } }, 202));
        await expect(generateDirectorImage(input, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "WORKFLOW_INVALID", message: "Missing ControlNet model" });
        const controller = new AbortController();
        vi.mocked(fetch).mockImplementation(async (_url, init) => {
            if (init?.method === "POST") {
                controller.abort();
                return json(queued, 202);
            }
            return json({ error: { code: "CANCEL_UNAVAILABLE", message: "upstream does not support scoped cancellation", retryable: false } }, 502);
        });
        await expect(generateDirectorImage(input, { signal: controller.signal })).rejects.toMatchObject({ code: "CANCEL_FAILED" });
        expect(uploads()).toEqual([]);
    });
});

it("does not claim upstream cancellation if the create response was lost before its task id arrived", async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        controller.abort();
        throw new TypeError("connection lost after POST");
    });
    await expect(generateDirectorImage(input, { signal: controller.signal })).rejects.toMatchObject({ code: "CANCEL_FAILED" });
    expect(uploads()).toEqual([]);
});
