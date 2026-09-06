import { DIRECTOR_PROTOCOL, DIRECTOR_PROTOCOL_VERSION, type DirectorCaptureResult, type DirectorControlPass, type DirectorMessage } from "../types/director";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isBlob = (value: unknown): value is Blob => typeof Blob !== "undefined" && value instanceof Blob;

const isPass = (value: unknown): value is DirectorControlPass => {
    if (!isRecord(value)) return false;
    if (!hasOnlyKeys(value, ["blob", "mimeType", "width", "height"])) return false;
    return typeof value.mimeType === "string" && isFiniteNumber(value.width) && value.width > 0 && isFiniteNumber(value.height) && value.height > 0 && isBlob(value.blob);
};

const hasEnvelope = (value: unknown): value is Record<string, unknown> => {
    if (!isRecord(value)) return false;
    return value.protocol === DIRECTOR_PROTOCOL && value.version === DIRECTOR_PROTOCOL_VERSION && (value.source === "atelier" || value.source === "monoform") && typeof value.type === "string";
};

export const isDirectorCaptureResult = (value: unknown): value is DirectorCaptureResult => {
    if (!hasEnvelope(value) || value.source !== "monoform") return false;
    if (value.type !== "control.result" && value.type !== "monoform:control-result") return false;
    if (!hasOnlyKeys(value, ["protocol", "version", "source", "type", "requestId", "payload"])) return false;
    if (typeof value.requestId !== "string" || !isRecord(value.payload)) return false;
    const payload = value.payload;
    if (!hasOnlyKeys(payload, ["shotId", "frame", "pose", "depth", "camera"])) return false;
    if (payload.camera !== undefined && !isCameraMetadata(payload.camera)) return false;
    return typeof payload.shotId === "string" && isFiniteNumber(payload.frame) && isPass(payload.pose) && isPass(payload.depth);
};

const isCameraMetadata = (value: unknown): boolean => {
    if (!isRecord(value) || !hasOnlyKeys(value, ["position", "rotation", "focalLength", "aspectRatio"])) return false;
    return (
        Array.isArray(value.position) &&
        value.position.length === 3 &&
        value.position.every(isFiniteNumber) &&
        Array.isArray(value.rotation) &&
        value.rotation.length === 3 &&
        value.rotation.every(isFiniteNumber) &&
        isFiniteNumber(value.focalLength) &&
        typeof value.aspectRatio === "string"
    );
};

export const parseDirectorMessage = (value: unknown): DirectorMessage | null => {
    if (!hasEnvelope(value)) return null;

    if (value.source === "monoform" && (value.type === "ready" || value.type === "monoform:ready")) {
        if (!hasOnlyKeys(value, ["protocol", "version", "source", "type", "payload"])) return null;
        if (value.payload !== undefined) {
            if (!isRecord(value.payload) || !hasOnlyKeys(value.payload, ["capabilities", "projectKey"])) return null;
            if (value.payload.projectKey !== undefined && typeof value.payload.projectKey !== "string") return null;
            if (value.payload.capabilities !== undefined && (!Array.isArray(value.payload.capabilities) || value.payload.capabilities.some((capability) => capability !== "capture-image" && capability !== "capture-pose" && capability !== "capture-depth")))
                return null;
        }
        return value as unknown as DirectorMessage;
    }

    if (value.source === "atelier" && value.type === "control.capture") {
        if (!hasOnlyKeys(value, ["protocol", "version", "source", "type", "requestId", "payload"])) return null;
        if (typeof value.requestId !== "string" || !isRecord(value.payload)) return null;
        const payload = value.payload;
        if (!hasOnlyKeys(payload, ["shotId", "frame", "passes", "width", "height"])) return null;
        if (
            (payload.shotId !== undefined && (typeof payload.shotId !== "string" || !payload.shotId)) ||
            (payload.frame !== undefined && (!Number.isInteger(payload.frame) || (payload.frame as number) < 0)) ||
            !Number.isInteger(payload.width) ||
            (payload.width as number) <= 0 ||
            (payload.width as number) > 4096 ||
            !Number.isInteger(payload.height) ||
            (payload.height as number) <= 0 ||
            (payload.height as number) > 4096 ||
            !Array.isArray(payload.passes) ||
            payload.passes.length === 0 ||
            payload.passes.some((pass) => pass !== "pose" && pass !== "depth")
        ) {
            return null;
        }
        return value as unknown as DirectorMessage;
    }

    if (isDirectorCaptureResult(value)) return value;

    if (value.source === "monoform" && (value.type === "error" || value.type === "monoform:error")) {
        if (!hasOnlyKeys(value, ["protocol", "version", "source", "type", "requestId", "payload"])) return null;
        if (value.requestId !== undefined && typeof value.requestId !== "string") return null;
        if (!isRecord(value.payload) || !hasOnlyKeys(value.payload, ["code", "message"]) || typeof value.payload.code !== "string" || typeof value.payload.message !== "string") {
            return null;
        }
        return value as unknown as DirectorMessage;
    }

    return null;
};

export const isAllowedDirectorEvent = (event: MessageEvent, iframeWindow: Window | null, expectedOrigin: string): boolean => iframeWindow !== null && event.source === iframeWindow && event.origin === expectedOrigin;
