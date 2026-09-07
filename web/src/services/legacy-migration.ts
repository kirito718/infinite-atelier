import localforage from "localforage";
import { nanoid } from "nanoid";
import { accountJson, assertAccountIdentity } from "./account-client";
import { getServerFileBlob, listServerFiles, putServerFile } from "./server-files";
import { flushServerChanges } from "./server-storage";

const appState = localforage.createInstance({ name: "infinite-canvas", storeName: "app_state" });
const oldImages = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const oldMedia = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const STATE_KEYS = ["canvas_store", "asset_store", "ai_config_store", "generation_history", "prompt_library_store"].map((key) => `infinite-canvas:${key}`);
export type LegacySummary = { hasData: boolean; projects: number; assets: number; files: number; bytes: number; director: number };
type LegacyEntry = { key: string; value: string };
type LegacyFile = { storageKey: string; blob: Blob };

function browserStorage() {
    return globalThis.localStorage;
}
function checkedValue(key: string, value: unknown): string | null {
    if (value === null || value === undefined) return null;
    try {
        if (typeof value !== "string") throw new Error();
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object") throw new Error();
        return value;
    } catch {
        throw new Error(`浏览器旧数据（${key}）格式无效，已停止迁移，原数据未修改。`);
    }
}
async function readLegacySnapshot() {
    const entries: LegacyEntry[] = [];
    for (const key of STATE_KEYS) {
        let raw: unknown = null;
        if (key.endsWith("ai_config_store")) raw = browserStorage().getItem(key);
        else {
            try {
                raw = await appState.getItem(key);
            } catch {
                raw = browserStorage().getItem(key);
            }
            if (raw === null) raw = browserStorage().getItem(key);
        }
        const value = checkedValue(key, raw);
        if (value !== null) entries.push({ key, value });
    }
    const local = browserStorage();
    for (let i = 0; i < local.length; i++) {
        const key = local.key(i);
        if (!key || !/^monoform-(project|custom-poses)(?:-[a-zA-Z0-9_-]{1,128})?$/.test(key)) continue;
        const value = checkedValue(key, local.getItem(key));
        if (value !== null) entries.push({ key, value });
    }
    if (!entries.some((entry) => entry.key === "monoform-project")) {
        const value = checkedValue("stageframe-project", local.getItem("stageframe-project"));
        if (value !== null) entries.push({ key: "monoform-project", value });
    }
    const files: LegacyFile[] = [];
    for (const store of [oldImages, oldMedia])
        await store.iterate((value, key) => {
            if (value instanceof Blob) files.push({ storageKey: key, blob: value });
        });
    return { entries, files };
}
export async function inspectLegacyData(): Promise<LegacySummary> {
    const { entries, files } = await readLegacySnapshot();
    const state = (suffix: string) => JSON.parse(entries.find((item) => item.key.endsWith(suffix))?.value || "{}").state || {};
    return {
        hasData: entries.length > 0 || files.length > 0,
        projects: state("canvas_store").projects?.length || 0,
        assets: state("asset_store").assets?.length || 0,
        files: files.length,
        bytes: files.reduce((sum, file) => sum + file.blob.size, 0),
        director: entries.filter((entry) => entry.key.startsWith("monoform-project")).length,
    };
}
const markerKey = (userId: string) => `atelier:legacy-imported:${userId}`;
export function isLegacyImported(userId: string) {
    return browserStorage().getItem(markerKey(userId)) === "1";
}
function sourceId() {
    const key = "atelier:legacy-source-id";
    let id = browserStorage().getItem(key);
    if (!id || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) {
        id = nanoid();
        browserStorage().setItem(key, id);
    }
    return id;
}
async function equalBlob(a: Blob, b: Blob) {
    if (a.size !== b.size) return false;
    const [first, second] = await Promise.all([a, b].map(async (blob) => new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))));
    return first.every((value, index) => value === second[index]);
}

export async function migrateLegacyData(userId: string, onProgress: (label: string) => void = () => {}) {
    assertAccountIdentity(userId);
    await flushServerChanges();
    const migrationId = sourceId();
    const status = await accountJson<{ imported: boolean; canImport: boolean }>(`/api/account/import/${encodeURIComponent(migrationId)}`);
    if (!status.canImport) throw new Error("当前账号已有数据。为了避免覆盖，请使用空账号迁移，或使用备份导入功能。");
    if (!status.imported) {
        const { entries, files } = await readLegacySnapshot();
        if (!entries.length && !files.length) throw new Error("当前浏览器未发现可迁移的旧数据。");
        // A media-only legacy library still needs a transactional migration marker.
        if (!entries.length) entries.push({ key: "infinite-canvas:asset_store", value: '{"state":{"assets":[]},"version":0}' });
        const remoteFiles = await listServerFiles();
        for (let index = 0; index < files.length; index++) {
            assertAccountIdentity(userId);
            const { storageKey, blob } = files[index];
            onProgress(`正在上传媒体 ${index + 1} / ${files.length}`);
            if (remoteFiles.some((file) => file.storageKey === storageKey)) {
                const existing = await getServerFileBlob(storageKey);
                if (!existing || !(await equalBlob(existing, blob))) throw new Error("服务端存在同名但内容不同的媒体文件，已停止迁移，未覆盖原文件。");
            } else await putServerFile(storageKey, blob);
        }
        assertAccountIdentity(userId);
        onProgress("正在提交画布、配置和导演台数据…");
        const result = await accountJson<{ imported: boolean }>("/api/account/import", { method: "POST", headers: { "Content-Type": "application/json", "X-Atelier-User": userId }, body: JSON.stringify({ migrationId, entries }) });
        if (result.imported !== true) throw new Error("服务器未确认迁移完成，请重试。");
    }
    assertAccountIdentity(userId);
    // Mark ONLY after the server confirms its transaction. Never delete legacy databases.
    try {
        browserStorage().setItem(markerKey(userId), "1");
    } catch {
        /* Server-side migration id remains authoritative. */
    }
}
