import { nanoid } from "nanoid";
import { readZip } from "@/lib/zip";
import type { CanvasExportFile } from "@/types/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { assertAccountIdentity, getAccountIdentity, getAccountSignal } from "./account-client";
import { remapBackupReferences } from "./backup-format";
import { putServerFile } from "./server-files";

type ArchiveMedia = { storageKey: string; path: string; mimeType: string };
type ArchiveContents<T> = { documents: T; files: ArchiveMedia[] };

/** Capture before reading the ZIP, not when its asynchronous media uploads begin. */
export async function importAccountArchive<T>(file: Blob, manifestName: string, select: (manifest: unknown) => ArchiveContents<T>): Promise<T> {
    const userId = getAccountIdentity();
    const signal = getAccountSignal();
    const assertCurrentSession = () => {
        assertAccountIdentity(userId);
        // The same user logging back in is still a different import session.
        if (signal.aborted || signal !== getAccountSignal()) throw new Error("账号会话已变更，已取消旧文件导入。请在当前账号重新选择文件。");
    };
    assertCurrentSession();
    const zip = await readZip(file);
    assertCurrentSession();
    const manifest = zip.get(manifestName);
    if (!manifest) throw new Error(`文件包中缺少 ${manifestName}。`);
    const data: unknown = JSON.parse(await manifest.text());
    assertCurrentSession();
    const { documents, files } = select(data);
    const mapping = new Map<string, string>();
    const uploads: Array<{ storageKey: string; blob: Blob }> = [];

    // Validate the complete manifest before the first write. Multiple canvas
    // projects can share a storage key; upload it once and remap every reference.
    for (const item of files) {
        if (!item || typeof item.storageKey !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}:[a-zA-Z0-9_-]{1,128}$/.test(item.storageKey) || typeof item.path !== "string" || typeof item.mimeType !== "string") {
            throw new Error("文件包的媒体清单无效。");
        }
        const blob = zip.get(item.path);
        if (!blob) throw new Error(`文件包缺少媒体：${item.path}`);
        if (mapping.has(item.storageKey)) continue;
        const storageKey = `${item.storageKey.split(":")[0]}:${nanoid()}`;
        mapping.set(item.storageKey, storageKey);
        uploads.push({ storageKey, blob: blob.slice(0, blob.size, item.mimeType || "application/octet-stream") });
    }

    for (const { storageKey, blob } of uploads) {
        assertCurrentSession();
        await putServerFile(storageKey, blob);
        assertCurrentSession();
    }
    assertCurrentSession();
    return remapBackupReferences(documents, mapping, userId!) as T;
}

export function readCanvasPackage(file: Blob): Promise<CanvasProject[]> {
    return importAccountArchive(file, "projects.json", (manifest) => {
        const data = manifest as CanvasExportFile;
        if (!data || data.app !== "infinite-canvas" || data.version !== 3 || !Array.isArray(data.projects) || data.projects.some((item) => !item?.project || !Array.isArray(item.files))) {
            throw new Error("无效的画布文件包。");
        }
        return { documents: data.projects.map((item) => item.project), files: data.projects.flatMap((item) => item.files) };
    });
}
