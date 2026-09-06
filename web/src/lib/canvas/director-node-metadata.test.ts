import { describe, expect, it, vi } from "vitest";
import { CanvasNodeType } from "@/types/canvas";
import { createDirectorImageNode } from "./canvas-node-factory";
import type { ComfyUiJobStatus } from "@/types/comfyui";
import { buildDirectorComfyMetadata, type DirectorComfyTask } from "./director-node-metadata";

vi.hoisted(() => vi.stubGlobal("localStorage", { getItem: () => null }));

describe("director ComfyUI canvas metadata", () => {
    it("keeps output storage and provenance without serializing control-pass blobs", () => {
        const uploaded = {
            url: "blob:http://localhost/output",
            storageKey: "image:output-1",
            width: 1024,
            height: 768,
            bytes: 321,
            mimeType: "image/png",
        };
        const task: DirectorComfyTask = {
            taskId: "task-1",
            status: "succeeded",
            workflowId: "portrait-pose-depth",
            promptId: "prompt-1",
            directorNodeId: "director-1",
            shotId: "shot-1",
            frame: 18,
            pose: { blob: new Blob(["pose"]), mimeType: "image/png", width: 1024, height: 768 },
            depth: { blob: new Blob(["depth"]), mimeType: "image/png", width: 1024, height: 768 },
        };

        const metadata = buildDirectorComfyMetadata(uploaded, task);

        expect(metadata).toMatchObject({
            source: "monoform",
            generationProvider: "comfyui",
            generationTaskId: "task-1",
            comfyPromptId: "prompt-1",
            workflowId: "portrait-pose-depth",
            directorNodeId: "director-1",
            directorShotId: "shot-1",
            directorFrame: 18,
            naturalWidth: 1024,
            naturalHeight: 768,
            mimeType: "image/png",
            storageKey: "image:output-1",
        });
        expect(metadata).not.toHaveProperty("pose");
        expect(metadata).not.toHaveProperty("depth");
        expect(Object.values(metadata).some((value) => value instanceof Blob)).toBe(false);
    });

    it("uses output dimensions and the declared workflow when optional task fields are absent", () => {
        const uploaded = {
            url: "blob:http://localhost/output",
            storageKey: "image:output-2",
            width: 640,
            height: 640,
            bytes: 123,
            mimeType: "image/webp",
        };
        const task = {
            taskId: "task-2",
            status: "succeeded",
            directorNodeId: "director-2",
            shotId: "shot-2",
            frame: 0,
            output: { mimeType: "image/webp", width: 640, height: 640 },
        } satisfies DirectorComfyTask & Partial<ComfyUiJobStatus>;

        const metadata = buildDirectorComfyMetadata(uploaded, task);

        expect(metadata).toMatchObject({
            generationProvider: "comfyui",
            generationTaskId: "task-2",
            workflowId: "portrait-pose-depth",
            directorNodeId: "director-2",
            directorShotId: "shot-2",
            directorFrame: 0,
            naturalWidth: 640,
            naturalHeight: 640,
            mimeType: "image/webp",
            storageKey: "image:output-2",
        });
    });
});

it("places the generated image beside the Director without treating its top-left as a center", () => {
    const director = { id: "director-1", type: CanvasNodeType.Director, title: "Director", position: { x: 100, y: 200 }, width: 340, height: 260, metadata: {} };
    const image = createDirectorImageNode(director, { status: "loading", generationProvider: "comfyui" });
    expect(image.position).toEqual({ x: 472, y: 200 });
    expect(image.type).toBe(CanvasNodeType.Image);
    expect(image.metadata).toMatchObject({ status: "loading", generationProvider: "comfyui" });
});
