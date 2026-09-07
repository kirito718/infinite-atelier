import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { Asset } from "@/stores/use-asset-store";
import type { AiConfig } from "@/stores/use-config-store";

export type BackupFile = {
    app: "infinite-canvas";
    version: 1 | 2;
    exportedAt?: string;
    projects: CanvasProject[];
    assets: Asset[];
    config: AiConfig;
    files: Array<{ storageKey: string; path: string; mimeType: string }>;
    entries?: Array<{ key: string; value: string | null }>;
};
export function validateBackup(value: unknown): BackupFile {
    const data = value as BackupFile;
    if (!data || data.app !== "infinite-canvas" || ![1, 2].includes(data.version) || !Array.isArray(data.projects) || !Array.isArray(data.assets) || !data.config || typeof data.config !== "object" || !Array.isArray(data.files))
        throw new Error("无效的应用备份文件。");
    const keys = new Set();
    for (const file of data.files) {
        if (
            !file ||
            typeof file.storageKey !== "string" ||
            !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}:[a-zA-Z0-9_-]{1,128}$/.test(file.storageKey) ||
            typeof file.path !== "string" ||
            !file.path.startsWith("files/") ||
            typeof file.mimeType !== "string" ||
            keys.has(file.storageKey)
        )
            throw new Error("备份媒体清单无效或重复。");
        keys.add(file.storageKey);
    }
    if (data.version === 2 && (!Array.isArray(data.entries) || data.entries.some((entry) => !entry || typeof entry.key !== "string" || (entry.value !== null && typeof entry.value !== "string")))) throw new Error("备份数据清单无效。");
    return data;
}
export function remapBackupReferences(value: unknown, mapping: Map<string, string>, userId: string): unknown {
    if (typeof value === "string") {
        if (mapping.has(value)) return mapping.get(value)!;
        const file = /^(?:https?:\/\/[^/]+)?\/api\/account\/files\/([^?]+)(?:\?.*)?$/.exec(value);
        if (file) {
            try {
                const key = mapping.get(decodeURIComponent(file[1]));
                if (key) return `/api/account/files/${encodeURIComponent(key)}?account=${encodeURIComponent(userId)}`;
            } catch {
                /* Not a server file URL. */
            }
        }
        return value;
    }
    if (Array.isArray(value)) return value.map((item) => remapBackupReferences(item, mapping, userId));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapBackupReferences(item, mapping, userId)]));
    return value;
}
