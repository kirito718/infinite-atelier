import { assertAccountIdentity, authenticatedFetch as fetch, getAccountIdentity } from "@/services/account-client";
import { deleteServerFiles, getServerFileBlob, getServerFileUrl, putServerFile } from "@/services/server-files";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { readImageMeta } from "@/lib/image-utils";
import { proxyApiUrl } from "@/lib/api-proxy";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
    const userId = getAccountIdentity();
    assertAccountIdentity(userId);
    const response = typeof input === "string" ? await fetch(proxyRemoteMediaUrl(input)) : null;
    if (response && !response.ok) throw new Error("图片下载失败，请检查来源和登录状态。");
    const blob = response ? await response.blob() : (input as Blob);
    const temporary = URL.createObjectURL(blob);
    try {
        const meta = await readImageMeta(temporary);
        assertAccountIdentity(userId);
        const storageKey = `image:${nanoid()}`;
        const stored = await putServerFile(storageKey, blob.type ? blob : blob.slice(0, blob.size, meta.mimeType));
        assertAccountIdentity(userId);
        return { ...stored, url: getServerFileUrl(storageKey), width: meta.width, height: meta.height };
    } finally {
        URL.revokeObjectURL(temporary);
    }
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    return storageKey ? getServerFileUrl(storageKey) : fallback;
}
export const getImageBlob = getServerFileBlob;
export async function setImageBlob(storageKey: string, blob: Blob) {
    await putServerFile(storageKey, blob);
    return getServerFileUrl(storageKey);
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = await resolveImageUrl(image.storageKey, image.dataUrl || image.url || "");
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await (await fetch(proxyRemoteMediaUrl(url))).blob());
}

export const deleteStoredImages = deleteServerFiles;

// Browser-local reachability cannot prove that a server file is unused: another
// project, history entry, director scene or in-flight tab may still reference it.
// Keep remote media until an explicit deletion, never garbage-collect from a partial snapshot.
export async function cleanupUnusedImages(_usedData: unknown) {}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}

function proxyRemoteMediaUrl(url: string) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? proxyApiUrl(url) : url;
    } catch {
        return url;
    }
}
