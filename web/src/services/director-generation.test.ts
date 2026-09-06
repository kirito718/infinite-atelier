import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComfyUiJobCreate } from "@/types/comfyui";
import { generateDirectorImage } from "./director-generation";
import { uploadImage, deleteStoredImages } from "./image-storage";

// IndexedDB/image decoding is the browser boundary; the HTTP client and orchestration stay real.
vi.mock("./image-storage", () => ({ uploadImage: vi.fn(), deleteStoredImages: vi.fn().mockResolvedValue(undefined) }));
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
const uploaded = { url: "blob:result", storageKey: "image:result", width: 1024, height: 1024, bytes: 3, mimeType: "image/png" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const queued = { taskId: "task-1", status: "queued", workflowId: "portrait-pose-depth" };
const succeeded = { ...queued, status: "succeeded", promptId: "prompt-1" };
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe("Director generation orchestration", () => {
    it("creates, polls, downloads and stores the output with the terminal task provenance", async () => {
        const requests: string[] = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
            requests.push(`${init?.method || "GET"} ${url}`);
            if (init?.method === "POST") return json(queued, 202);
            if (String(url).endsWith("/output")) return new Response(blob, { headers: { "content-type": "image/png" } });
            return json(succeeded);
        });
        vi.mocked(uploadImage).mockResolvedValue(uploaded);
        const states: string[] = [];
        const result = await generateDirectorImage(input, { signal: new AbortController().signal, onStatus: (task) => states.push(task.status) });
        expect(result).toEqual({ uploaded, task: succeeded });
        expect(states).toEqual(["queued", "succeeded"]);
        expect(requests).toEqual(["POST /api/comfyui/jobs", "GET /api/comfyui/jobs/task-1", "GET /api/comfyui/jobs/task-1/output"]);
        expect(await (vi.mocked(uploadImage).mock.calls[0][0] as Blob).text()).toBe("png");
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
        expect(uploadImage).not.toHaveBeenCalled();
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
        expect(uploadImage).not.toHaveBeenCalled();
    });
    it("removes an image stored after cancellation instead of publishing a late canvas success", async () => {
        const storage = deferred<typeof uploaded>();
        const started = deferred<void>();
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
            if (init?.method === "POST") return json(succeeded, 202);
            if (init?.method === "DELETE") return new Response(null, { status: 204 });
            return new Response(blob, { headers: { "content-type": "image/png" } });
        });
        vi.mocked(uploadImage).mockImplementation(async () => {
            started.resolve();
            return storage.promise;
        });
        const controller = new AbortController();
        const result = generateDirectorImage(input, { signal: controller.signal });
        const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
        await started.promise;
        controller.abort();
        storage.resolve(uploaded);
        await rejected;
        expect(deleteStoredImages).toHaveBeenCalledWith(["image:result"]);
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
        expect(uploadImage).not.toHaveBeenCalled();
    });
});
