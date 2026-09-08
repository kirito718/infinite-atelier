import { saveAs } from "file-saver";
import { nanoid } from "nanoid";
import { createZip, readZip } from "@/lib/zip";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useGenerationHistoryStore } from "@/stores/canvas/use-generation-history-store";
import { usePromptLibraryStore } from "@/stores/use-prompt-library-store";
import { accountJson, assertAccountIdentity, getAccountIdentity } from "./account-client";

import { flushServerChanges } from "./server-storage";
import { getServerFileBlob, listServerFiles, putServerFile } from "./server-files";
import { remapBackupReferences, validateBackup, type BackupFile } from "./backup-format";
import type { StateEntry } from "./save-queue";

const envelope = (state: unknown) => JSON.stringify({ state, version: 0 });
const stateEntry = (key: string, state: unknown) => ({ key: `infinite-canvas:${key}`, value: envelope(state) });

// Includes current main-app drafts, even during a save conflict, plus the last
// saved director documents and every server media file. No browser DB enumeration.
export async function exportAppBackup() {
    const userId = getAccountIdentity();
    assertAccountIdentity(userId);
    const { projects } = useCanvasStore.getState();
    const { assets } = useAssetStore.getState();
    const { config } = useConfigStore.getState();
    const snapshot = await accountJson<{ entries: StateEntry[] }>("/api/account/state");
    const entries = new Map(snapshot.entries.map(({ key, value }) => [key, value]));
    for (const entry of [
        stateEntry("canvas_store", { projects }),
        stateEntry("asset_store", { assets }),
        stateEntry("ai_config_store", { config }),
        stateEntry("generation_history", { records: useGenerationHistoryStore.getState().records }),
        stateEntry("prompt_library_store", { builtInCovers: usePromptLibraryStore.getState().builtInCovers }),
    ])
        entries.set(entry.key, entry.value);
    const files: BackupFile["files"] = [];
    const archive: Array<{ name: string; data: BlobPart }> = [];
    for (const item of await listServerFiles()) {
        assertAccountIdentity(userId);
        const blob = await getServerFileBlob(item.storageKey);
        if (!blob) throw new Error("备份期间有媒体文件被删除，请重试。");
        const path = `files/${files.length}-${item.storageKey.replace(":", "_")}.bin`;
        files.push({ storageKey: item.storageKey, path, mimeType: item.mimeType });
        archive.push({ name: path, data: blob });
    }
    const data: BackupFile = { app: "infinite-canvas", version: 2, exportedAt: new Date().toISOString(), projects, assets, config, files, entries: [...entries].map(([key, value]) => ({ key, value })) };
    archive.push({ name: "backup.json", data: JSON.stringify(data) });
    const zip = await createZip(archive);
    assertAccountIdentity(userId);
    saveAs(zip, `infinite-canvas-backup-${new Date().toISOString().slice(0, 10)}.zip`);
}

// Explicitly confirmed in the settings UI. Fresh storage keys keep the old
// account files intact; CAS + a single SQLite transaction prevents partial restore.
export async function importAppBackup(file: File) {
    const userId = getAccountIdentity();
    assertAccountIdentity(userId);
    await flushServerChanges();
    const zip = await readZip(file);
    const manifest = zip.get("backup.json");
    if (!manifest) throw new Error("备份中缺少 backup.json。");
    const data = validateBackup(JSON.parse(await manifest.text()));
    for (const item of data.files) if (!zip.has(item.path)) throw new Error(`备份缺少媒体文件：${item.path}`);
    const mapping = new Map(data.files.map((item) => [item.storageKey, `${item.storageKey.split(":")[0]}:${nanoid()}`]));
    const sourceEntries = data.version === 2 ? data.entries! : [stateEntry("canvas_store", { projects: data.projects }), stateEntry("asset_store", { assets: data.assets }), stateEntry("ai_config_store", { config: data.config })];
    // Parse every document before uploading anything.
    const prepared = sourceEntries.map(({ key, value }) => ({ key, value: value === null ? null : JSON.stringify(remapBackupReferences(JSON.parse(value), mapping, userId!)) }));
    const snapshot = await accountJson<{ entries: StateEntry[] }>("/api/account/state");
    const revisions = new Map(snapshot.entries.map((entry) => [entry.key, entry.revision]));
    for (const item of data.files) {
        assertAccountIdentity(userId);
        const blob = zip.get(item.path)!;
        await putServerFile(mapping.get(item.storageKey)!, blob.slice(0, blob.size, item.mimeType || "application/octet-stream"));
    }
    assertAccountIdentity(userId);
    const result = await accountJson<{ restored: boolean }>("/api/account/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Atelier-User": userId! },
        body: JSON.stringify({ entries: prepared.map((entry) => ({ ...entry, expectedRevision: revisions.get(entry.key) || 0 })) }),
    });
    if (!result.restored) throw new Error("服务器未确认恢复完成。");
    assertAccountIdentity(userId);
    const { reloadAccountData } = await import("@/stores/use-user-store");
    await reloadAccountData(userId!);
}
