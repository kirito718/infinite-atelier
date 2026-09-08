import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Button, Modal } from "antd";
import { CloudCheck, CloudUpload } from "lucide-react";
import { reloadAccountData, useUserStore } from "@/stores/use-user-store";
import { getSyncSnapshot, retryServerChanges, subscribeSyncStatus } from "@/services/server-storage";
import { getEmbeddedEditorsSnapshot, hasPendingEmbeddedEditors, subscribeEmbeddedEditors } from "@/services/embedded-editors";
import { inspectLegacyData, isLegacyImported, migrateLegacyData, type LegacySummary } from "@/services/legacy-migration";
import { exportAppBackup } from "@/services/backup-restore";

export function PersistenceNotices() {
    const user = useUserStore((state) => state.user);
    const sync = useSyncExternalStore(subscribeSyncStatus, getSyncSnapshot, getSyncSnapshot);
    const [legacy, setLegacy] = useState<LegacySummary | null>(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [exportError, setExportError] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        setLegacy(null);
        setError(null);
        setOpen(false);
        if (!user || isLegacyImported(user.id)) return;
        void inspectLegacyData().then(
            (summary) => {
                if (live && summary.hasData) {
                    setLegacy(summary);
                    setOpen(true);
                }
            },
            (cause) => {
                if (live) setError(cause instanceof Error ? cause.message : "旧数据检测失败。");
            },
        );
        return () => {
            live = false;
        };
    }, [user?.id]);
    useEffect(() => {
        const unload = (event: BeforeUnloadEvent) => {
            if (busy || getSyncSnapshot().pending || hasPendingEmbeddedEditors()) {
                event.preventDefault();
                event.returnValue = "";
            }
        };
        const online = () => {
            if (!getSyncSnapshot().conflict) void retryServerChanges().catch(() => {});
        };
        window.addEventListener("beforeunload", unload);
        window.addEventListener("online", online);
        return () => {
            window.removeEventListener("beforeunload", unload);
            window.removeEventListener("online", online);
        };
    }, [busy]);
    useEffect(() => {
        let live = true;
        const openMigration = () => {
            setOpen(true);
            setLegacy(null);
            setError(null);
            setProgress("正在检查浏览器旧数据…");
            void inspectLegacyData()
                .then(
                    (summary) => {
                        if (!live) return;
                        setLegacy(summary.hasData ? summary : null);
                        setError(summary.hasData ? null : "当前浏览器未发现可迁移的旧数据。");
                    },
                    (cause) => {
                        if (live) setError(cause instanceof Error ? cause.message : "旧数据读取失败。");
                    },
                )
                .finally(() => {
                    if (live) setProgress("");
                });
        };
        window.addEventListener("atelier:open-migration", openMigration);
        return () => {
            live = false;
            window.removeEventListener("atelier:open-migration", openMigration);
        };
    }, [user?.id]);
    async function migrate() {
        if (!user) return;
        setBusy(true);
        setError(null);
        setProgress("正在检查迁移条件…");
        try {
            await migrateLegacyData(user.id, setProgress);
            await reloadAccountData(user.id);
            setOpen(false);
            setLegacy(null);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "迁移失败，请重试。");
        } finally {
            setBusy(false);
            setProgress("");
        }
    }
    return (
        <>
            {(sync.error || exportError) && (
                <div className="fixed left-1/2 top-16 z-50 w-[min(90vw,680px)] -translate-x-1/2">
                    <Alert
                        type="error"
                        showIcon
                        title="更改尚未保存"
                        description={
                            <div>
                                <p>{sync.error || exportError}</p>
                                <div className="mt-2 flex gap-2">
                                    <Button size="small" disabled={sync.conflict} onClick={() => void retryServerChanges().catch(() => {})}>
                                        重试保存
                                    </Button>
                                    <Button size="small" onClick={() => void exportAppBackup().catch((cause) => setExportError(cause.message))}>
                                        导出主应用草稿
                                    </Button>
                                </div>
                                {sync.conflict && <p className="mt-2 text-xs">另一页面已保存新版本。请先导出本页草稿，再刷新，系统不会自动覆盖。</p>}
                            </div>
                        }
                    />
                </div>
            )}
            <Modal
                title="将浏览器旧数据迁移到账号"
                open={open}
                onCancel={() => {
                    if (!busy) setOpen(false);
                }}
                maskClosable={!busy}
                closable={!busy}
                okText={`导入到 ${user?.displayName || user?.username || "当前账号"}`}
                cancelText="暂不导入"
                onOk={() => void migrate()}
                confirmLoading={busy}
                okButtonProps={{ disabled: !legacy }}
                cancelButtonProps={{ disabled: busy }}
            >
                <p className="mb-3">
                    导入目标：<strong>{user?.username}</strong>。仅向空账号导入，不会覆盖已有服务器数据，也不会删除浏览器原件。
                </p>
                {legacy && (
                    <p className="mb-3">
                        发现 {legacy.projects} 个画布、{legacy.assets} 项素材、{legacy.files} 个媒体文件（{(legacy.bytes / 1024 / 1024).toFixed(1)} MB）、{legacy.director} 个导演台工程，以及已有配置和历史记录。
                    </p>
                )}
                <p className="text-xs text-stone-500">只能读取当前地址与浏览器的旧数据。如果以前使用不同域名或端口，请先从旧地址导出备份。API Key 会随配置加密保存到服务器。</p>
                {progress && (
                    <p className="mt-3" role="status">
                        {progress}
                    </p>
                )}
                {error && (
                    <p className="mt-3 text-red-600" role="alert">
                        {error}
                    </p>
                )}
            </Modal>
        </>
    );
}

/** In-flow header status: never cover canvas controls or asset-card actions. */
export function PersistenceStatus() {
    const sync = useSyncExternalStore(subscribeSyncStatus, getSyncSnapshot, getSyncSnapshot);
    const embedded = useSyncExternalStore(subscribeEmbeddedEditors, getEmbeddedEditorsSnapshot, getEmbeddedEditorsSnapshot);
    const pending = sync.pending > 0 || embedded.pending > 0;
    const label = sync.error ? "更改尚未保存，请查看错误提示" : pending ? "正在保存到服务器…" : "已保存到服务器";
    return (
        <span role="status" aria-live="polite" aria-label={label} title={label} className={`inline-flex shrink-0 items-center gap-1 text-xs ${sync.error ? "text-red-500" : "text-stone-500 dark:text-stone-400"}`}>
            {pending || sync.error ? <CloudUpload className="size-3.5" aria-hidden="true" /> : <CloudCheck className="size-3.5" aria-hidden="true" />}
            <span className="hidden xl:inline">{sync.error ? "未保存" : pending ? "保存中" : "已保存"}</span>
        </span>
    );
}
