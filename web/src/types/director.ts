export const DIRECTOR_PROTOCOL = "atelier-monoform" as const;
export const DIRECTOR_PROTOCOL_VERSION = 1 as const;

export type DirectorSource = "atelier" | "monoform";
export type DirectorControlPassKind = "pose" | "depth";
export type DirectorMessageType = "ready" | "monoform:ready" | "control.capture" | "control.result" | "monoform:control-result" | "error" | "monoform:error";

export interface DirectorCameraMetadata {
    position: [number, number, number];
    rotation: [number, number, number];
    focalLength: number;
    aspectRatio: string;
}

export interface DirectorControlPass {
    blob: Blob;
    mimeType: string;
    width: number;
    height: number;
}

export interface DirectorCaptureRequestPayload {
    /** Omit selection to capture the active shot/frame atomically inside MONOFORM. */
    shotId?: string;
    frame?: number;
    passes: DirectorControlPassKind[];
    width: number;
    height: number;
}

export interface DirectorCaptureRequest {
    protocol: typeof DIRECTOR_PROTOCOL;
    version: typeof DIRECTOR_PROTOCOL_VERSION;
    source: "atelier";
    type: "control.capture";
    requestId: string;
    payload: DirectorCaptureRequestPayload;
}

export interface DirectorCaptureResult {
    protocol: typeof DIRECTOR_PROTOCOL;
    version: typeof DIRECTOR_PROTOCOL_VERSION;
    source: "monoform";
    type: "control.result" | "monoform:control-result";
    requestId: string;
    payload: {
        shotId: string;
        frame: number;
        pose: DirectorControlPass;
        depth: DirectorControlPass;
        camera?: DirectorCameraMetadata;
    };
}

export interface DirectorReadyMessage {
    protocol: typeof DIRECTOR_PROTOCOL;
    version: typeof DIRECTOR_PROTOCOL_VERSION;
    source: "monoform";
    type: "ready" | "monoform:ready";
    payload?: {
        capabilities?: Array<"capture-image" | "capture-pose" | "capture-depth">;
        projectKey?: string;
    };
}

export interface DirectorErrorMessage {
    protocol: typeof DIRECTOR_PROTOCOL;
    version: typeof DIRECTOR_PROTOCOL_VERSION;
    source: "monoform";
    type: "error" | "monoform:error";
    requestId?: string;
    payload: {
        code: "CAPTURE_FAILED" | "UNSUPPORTED_CAPABILITY" | "INVALID_REQUEST" | string;
        message: string;
    };
}

export type DirectorMessage = DirectorReadyMessage | DirectorCaptureRequest | DirectorCaptureResult | DirectorErrorMessage;
