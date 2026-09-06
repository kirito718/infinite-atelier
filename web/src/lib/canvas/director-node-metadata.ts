import { imageMetadata } from "./canvas-node-factory";
import type { UploadedImage } from "@/services/image-storage";
import type { ComfyUiJobStatus } from "@/types/comfyui";
import type { DirectorControlPass } from "@/types/director";
import type { CanvasNodeMetadata } from "@/types/canvas";

/**
 * The task context needed to make a Director result auditable. Control passes
 * are accepted here only so callers can keep the request context strongly
 * typed; they are deliberately not copied into the returned canvas metadata.
 */
export type DirectorComfyTask = ComfyUiJobStatus & {
    directorNodeId: string;
    shotId: string;
    frame: number;
    pose?: DirectorControlPass;
    depth?: DirectorControlPass;
};

export function buildDirectorComfyMetadata(uploaded: UploadedImage, task: DirectorComfyTask): CanvasNodeMetadata {
    return {
        ...imageMetadata(uploaded),
        source: "monoform",
        generationProvider: "comfyui",
        generationTaskId: task.taskId,
        ...(task.promptId ? { comfyPromptId: task.promptId } : {}),
        workflowId: task.workflowId || "portrait-pose-depth",
        directorNodeId: task.directorNodeId,
        directorShotId: task.shotId,
        directorFrame: task.frame,
        dimensions: { width: uploaded.width, height: uploaded.height },
    };
}
