import type { DirectorControlPass, DirectorCameraMetadata } from "./director";

export type ComfyUiJobState =
  | "queued"
  | "uploading"
  | "submitted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ComfyUiJobCreate {
  workflowId: "portrait-pose-depth" | string;
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  shotId: string;
  frame: number;
  width: number;
  height: number;
  pose: DirectorControlPass;
  depth: DirectorControlPass;
  reference?: Blob;
  camera?: DirectorCameraMetadata;
}

export interface ComfyUiJobProgress {
  nodeId?: string;
  step?: number;
  max?: number;
  percent?: number;
}

export interface ComfyUiJobStatus {
  taskId: string;
  status: ComfyUiJobState;
  workflowId?: string;
  promptId?: string;
  progress?: ComfyUiJobProgress;
  output?: {
    mimeType: string;
    width?: number;
    height?: number;
  };
  error?: ComfyUiJobError;
}

export interface ComfyUiJobError {
  code:
    | "COMFYUI_UNAVAILABLE"
    | "WORKFLOW_INVALID"
    | "UPLOAD_FAILED"
    | "QUEUE_FAILED"
    | "OUTPUT_FAILED"
    | "CANCELLED"
    | string;
  message: string;
  retryable: boolean;
}
