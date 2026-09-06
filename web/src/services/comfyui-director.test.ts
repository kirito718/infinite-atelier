import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComfyUiJobCreate } from "@/types/comfyui";
import { cancelComfyUiJob, createComfyUiJob, getComfyUiJob, getComfyUiOutput, ComfyUiApiError } from "./comfyui-director";

const PNG = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

const input: ComfyUiJobCreate = {
    workflowId: "portrait-pose-depth",
    prompt: "portrait",
    negativePrompt: "blurry",
    seed: 42,
    shotId: "shot-1",
    frame: 12,
    width: 640,
    height: 768,
    pose: { blob: PNG, mimeType: "image/png", width: 640, height: 768 },
    depth: { blob: PNG, mimeType: "image/png", width: 640, height: 768 },
    reference: new Blob([new Uint8Array([4, 5])], { type: "image/webp" }),
    camera: {
        position: [1, 2, 3],
        rotation: [0, 0.5, 1],
        focalLength: 50,
        aspectRatio: "16:9",
    },
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe("same-origin ComfyUI director client", () => {
    it("posts the server field names in multipart form data and accepts 202", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ taskId: "task-1", status: "queued", workflowId: "portrait-pose-depth" }), {
                status: 202,
                headers: { "content-type": "application/json" },
            }),
        );

        const task = await createComfyUiJob(input);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("/api/comfyui/jobs");
        expect(url).not.toMatch(/^https?:\/\//);
        expect(init.method).toBe("POST");
        expect(init.body).toBeInstanceOf(FormData);

        const form = init.body as FormData;
        expect(Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string"))).toMatchObject({
            workflowId: "portrait-pose-depth",
            prompt: "portrait",
            negativePrompt: "blurry",
            seed: "42",
            shotId: "shot-1",
            frame: "12",
            width: "640",
            height: "768",
            camera: JSON.stringify(input.camera),
        });

        for (const field of ["pose", "depth", "reference"]) {
            const part = form.get(field);
            expect(part).toBeInstanceOf(Blob);
            expect((part as Blob).type).toMatch(/^image\/(png|webp)$/);
        }
        expect(task).toEqual({ taskId: "task-1", status: "queued", workflowId: "portrait-pose-depth" });
    });

    it("uses relative status, output, and cancellation routes", async () => {
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response(JSON.stringify({ taskId: "task/a", status: "running" }), { status: 200 }))
            .mockResolvedValueOnce(new Response(new Uint8Array([8, 9]), { status: 200, headers: { "content-type": "image/webp" } }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));

        await expect(getComfyUiJob("task/a")).resolves.toEqual({ taskId: "task/a", status: "running" });
        const output = await getComfyUiOutput("task/a");
        await expect(cancelComfyUiJob("task/a")).resolves.toBeUndefined();

        expect(output.type).toBe("image/webp");
        expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method || "GET"])).toEqual([
            ["/api/comfyui/jobs/task%2Fa", "GET"],
            ["/api/comfyui/jobs/task%2Fa/output", "GET"],
            ["/api/comfyui/jobs/task%2Fa", "DELETE"],
        ]);
    });

    it("normalizes the server error envelope into a typed error", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(JSON.stringify({ error: { code: "WORKFLOW_INVALID", message: "unknown workflow", retryable: false } }), {
                status: 400,
                headers: { "content-type": "application/json" },
            }),
        );

        await expect(getComfyUiJob("missing")).rejects.toSatisfy((error: unknown) => {
            expect(error).toBeInstanceOf(ComfyUiApiError);
            expect(error).toMatchObject({ code: "WORKFLOW_INVALID", status: 400, retryable: false, message: "unknown workflow" });
            return true;
        });
    });
});

describe("ComfyUI client cancellation and output boundaries", () => {
    it("preserves AbortError and forwards the signal rather than reporting cancellation as an outage", async () => {
        const controller = new AbortController();
        const failure = new DOMException("cancelled", "AbortError");
        const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);
        await expect(getComfyUiJob("task-1", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    });
    it("wraps output-body failures in an actionable typed error", async () => {
        const response = new Response("png", { headers: { "content-type": "image/png" } });
        vi.spyOn(response, "blob").mockRejectedValue(new TypeError("stream disconnected"));
        vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
        await expect(getComfyUiOutput("task-1")).rejects.toMatchObject({ code: "OUTPUT_FAILED", retryable: true });
    });
    it("rejects successful HTML and empty-image responses before storing them on the canvas", async () => {
        vi.spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(new Response("<html>login</html>", { headers: { "content-type": "text/html" } }))
            .mockResolvedValueOnce(new Response(null, { headers: { "content-type": "image/png" } }));
        await expect(getComfyUiOutput("task-1")).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
        await expect(getComfyUiOutput("task-1")).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
    });
    it("times out even when response headers arrived but the body never finishes", async () => {
        const response = new Response("png", { headers: { "content-type": "image/png" } });
        vi.spyOn(response, "blob").mockReturnValue(new Promise(() => {}));
        vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
        await expect(getComfyUiOutput("task-1", { timeoutMs: 10 })).rejects.toMatchObject({ code: "COMFYUI_TIMEOUT", retryable: true });
    });
});
