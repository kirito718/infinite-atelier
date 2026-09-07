import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Alert, Button, Modal } from "antd";
import { useTranslation } from "react-i18next";
import { flushEmbeddedEditors } from "@/services/embedded-editors";
import { createDirectorCloseGuard } from "./director-close-guard";

type DirectorPanelProps = {
    nodeId: string;
    open: boolean;
    closeRequested?: boolean;
    onClose: () => void;
    onExport: (kind: "image" | "video", blob: Blob) => void;
};

// Embedded MONOFORM previs studio panel for a director node. The iframe scopes its project storage with ?key=<nodeId>,
// and MONOFORM posts exported PNG/MP4 blobs back to the canvas host.
export function DirectorPanel({ nodeId, open, closeRequested = false, onClose, onExport }: DirectorPanelProps) {
    const { t } = useTranslation();
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const closeGuard = useMemo(() => createDirectorCloseGuard(flushEmbeddedEditors, () => onCloseRef.current()), [nodeId]);
    const closeState = useSyncExternalStore(closeGuard.subscribe, closeGuard.getSnapshot, closeGuard.getSnapshot);
    useEffect(() => () => closeGuard.cancelPending(), [closeGuard]);
    useEffect(() => {
        if (closeRequested) void closeGuard.requestClose();
    }, [closeGuard, closeRequested]);

    const onExportRef = useRef(onExport);
    onExportRef.current = onExport;

    useEffect(() => {
        if (!open) return;
        const handler = (event: MessageEvent) => {
            const data = event.data as { source?: string; type?: string; kind?: "image" | "video"; blob?: Blob } | undefined;
            if (!data || data.source !== "monoform" || data.type !== "export") return;
            if ((data.kind === "image" || data.kind === "video") && data.blob) onExportRef.current(data.kind, data.blob);
        };
        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, [open]);

    return (
        <>
            <Modal
                open={open}
                onCancel={() => closeGuard.requestClose()}
                closable={!closeState.saving && !closeState.confirmingDiscard}
                keyboard={!closeState.saving && !closeState.confirmingDiscard}
                maskClosable={!closeState.saving && !closeState.confirmingDiscard}
                footer={null}
                width="min(96vw, 1280px)"
                centered
                destroyOnHidden
                title={t("canvas.director.title")}
                styles={{ body: { height: "min(84vh, 820px)", padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" } }}
            >
                {(closeState.saving || closeState.error) && (
                    <div className="shrink-0 p-3" role={closeState.error ? "alert" : "status"}>
                        <Alert
                            type={closeState.error ? "error" : "info"}
                            showIcon
                            title={closeState.error ? "导演台尚未保存，未关闭编辑器" : "正在保存导演台，请稍候…"}
                            description={closeState.error ? <>
                                <p>{closeState.error}</p>
                                <p>可以继续在下方编辑器检查网络、重试保存或导出工程。只有确认放弃后才会丢弃未保存内容。</p>
                                <div className="mt-2 flex gap-2">
                                    <Button size="small" onClick={() => void closeGuard.requestClose()}>重试保存并关闭</Button>
                                    <Button size="small" danger onClick={() => closeGuard.requestDiscard()}>放弃未保存内容…</Button>
                                </div>
                            </> : undefined}
                        />
                    </div>
                )}
                <iframe src={`${import.meta.env.BASE_URL}monoform/index.html?key=${nodeId}`} title="MONOFORM" inert={closeState.saving} className="min-h-0 w-full flex-1 border-0" allow="camera; microphone; clipboard-write; download; fullscreen" />
            </Modal>
            <Modal
                open={closeState.confirmingDiscard}
                title="确定放弃导演台未保存的内容？"
                okText="确认放弃并关闭"
                cancelText="留在编辑器"
                okButtonProps={{ danger: true }}
                maskClosable={false}
                onOk={() => closeGuard.confirmDiscard()}
                onCancel={() => closeGuard.cancelDiscard()}
            >
                <p>未保存的编辑可能无法恢复。建议取消并先在导演台导出工程；只有确认放弃才会关闭。</p>
            </Modal>
        </>
    );
}
