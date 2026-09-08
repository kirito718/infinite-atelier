import { assertAccountIdentity, authenticatedFetch as fetch, getAccountIdentity } from "@/services/account-client";
import { deleteServerFiles, getServerFileBlob, getServerFileUrl, putServerFile } from "@/services/server-files";
import { proxyApiUrl } from "@/lib/api-proxy";
import { nanoid } from "nanoid";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const userId = getAccountIdentity();
    assertAccountIdentity(userId);
    const response = typeof input === "string" ? await fetch(proxyApiUrl(input)) : null;
    if (response && !response.ok) throw new Error("媒体下载失败，请检查来源和登录状态。");
    const blob = response ? await response.blob() : (input as Blob);
    const temporary = URL.createObjectURL(blob);
    try {
        const meta = blob.type.startsWith("video/") ? await readVideoMeta(temporary) : blob.type.startsWith("audio/") ? await readAudioMeta(temporary) : {};
        assertAccountIdentity(userId);
        const storageKey = `${prefix}:${nanoid()}`;
        const stored = await putServerFile(storageKey, blob);
        assertAccountIdentity(userId);
        return { ...stored, url: getServerFileUrl(storageKey), ...meta };
    } finally {
        URL.revokeObjectURL(temporary);
    }
}
export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    return storageKey ? getServerFileUrl(storageKey) : fallback;
}
export const getMediaBlob = getServerFileBlob;
export async function setMediaBlob(storageKey: string, blob: Blob) {
    await putServerFile(storageKey, blob);
    return getServerFileUrl(storageKey);
}
export const deleteStoredMedia = deleteServerFiles;
// See image-storage: never delete shared remote media based on one tab's snapshot.
export async function cleanupUnusedMedia(_usedData: unknown) {}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
