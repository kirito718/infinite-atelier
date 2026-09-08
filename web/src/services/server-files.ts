import { accountJson, assertAccountIdentity, authenticatedFetch, getAccountIdentity } from "./account-client";

export type ServerFile = { storageKey: string; mimeType: string; bytes: number };
export function getServerFileUrl(storageKey: string) {
    const userId = getAccountIdentity();
    assertAccountIdentity(userId);
    return `/api/account/files/${encodeURIComponent(storageKey)}?account=${encodeURIComponent(userId!)}`;
}
export async function listServerFiles() {
    return (await accountJson<{ files: ServerFile[] }>("/api/account/files")).files;
}
export async function putServerFile(storageKey: string, blob: Blob): Promise<ServerFile> {
    const userId = getAccountIdentity();
    assertAccountIdentity(userId);
    return accountJson<ServerFile>(getServerFileUrl(storageKey), { method: "PUT", headers: { "Content-Type": blob.type || "application/octet-stream", "X-Atelier-User": userId! }, body: blob });
}
export async function getServerFileBlob(storageKey: string): Promise<Blob | null> {
    const response = await authenticatedFetch(getServerFileUrl(storageKey));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("媒体文件读取失败，请确认登录状态和服务器存储。");
    return response.blob();
}
export async function deleteServerFiles(keys: Iterable<string>) {
    const userId = getAccountIdentity();
    assertAccountIdentity(userId);
    for (const key of new Set(keys)) {
        assertAccountIdentity(userId);
        await accountJson<void>(getServerFileUrl(key), { method: "DELETE", headers: { "X-Atelier-User": userId! } });
    }
}
