import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Modal } from "antd";
import { useTranslation } from "react-i18next";
import { createDirectorCaptureClient } from "@/lib/director-capture-client";
import type { DirectorCaptureResult } from "@/types/director";

export type DirectorGenerationStatus = {
    directorNodeId?: string;
    state: "idle" | "queued" | "running" | "saving" | "cancelling" | "succeeded" | "failed" | "cancelled";
    progress?: number;
    message?: string;
};

type DirectorPanelProps = {
    nodeId: string;
    open: boolean;
    onClose: () => void;
    onExport: (kind: "image" | "video", blob: Blob) => void;
    onGenerateComfy: (input: DirectorCaptureResult) => void;
    onGenerationCancel: () => void;
    generationStatus?: DirectorGenerationStatus;
    prompt: string;
    onPromptChange: (prompt: string) => void;
    busy?: boolean;
};

// Each iframe stores its scene under ?key=<nodeId>; exports and captures share the same origin boundary.
export function DirectorPanel({ nodeId, open, onClose, onExport, onGenerateComfy, onGenerationCancel, generationStatus, prompt, onPromptChange, busy = false }: DirectorPanelProps) {
    const { t } = useTranslation();
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const clientRef = useRef<ReturnType<typeof createDirectorCaptureClient> | null>(null);
    const callbacksRef = useRef({ onExport, onGenerateComfy });
    callbacksRef.current = { onExport, onGenerateComfy };
    const capturingRef = useRef(false);
    const [ready, setReady] = useState(false);
    const [capturing, setCapturing] = useState(false);
    const [captureError, setCaptureError] = useState<string | null>(null);
    const iframeSrc = `${import.meta.env.BASE_URL}monoform/index.html?key=${encodeURIComponent(nodeId)}`;
    const expectedOrigin = useMemo(() => new URL(iframeSrc, window.location.href).origin, [iframeSrc]);
    const generationActive = Boolean(generationStatus && ["queued", "running", "saving", "cancelling"].includes(generationStatus.state));
    const active = capturing || generationActive;

    useEffect(() => {
        if (!open) return;
        setReady(false);
        setCaptureError(null);
        setCapturing(false);
        capturingRef.current = false;
        const client = createDirectorCaptureClient({
            nodeId,
            getFrameWindow: () => iframeRef.current?.contentWindow || null,
            origin: expectedOrigin,
            onReady: setReady,
            onExport: (kind, blob) => callbacksRef.current.onExport(kind, blob),
        });
        clientRef.current = client;
        window.addEventListener("message", client.handleMessage);
        return () => {
            window.removeEventListener("message", client.handleMessage);
            client.dispose();
            if (clientRef.current === client) clientRef.current = null;
        };
    }, [expectedOrigin, nodeId, open]);

    const handleGenerate = async () => {
        const client = clientRef.current;
        if (!client || !ready || capturingRef.current || generationActive || busy) return;
        capturingRef.current = true;
        setCapturing(true);
        setCaptureError(null);
        try {
            const result = await client.capture();
            if (clientRef.current === client) callbacksRef.current.onGenerateComfy(result);
        } catch (error) {
            if (clientRef.current === client) setCaptureError(error instanceof Error ? error.message : "控制图捕获失败，请重试");
        } finally {
            if (clientRef.current === client) {
                capturingRef.current = false;
                setCapturing(false);
            }
        }
    };
    const handleCancel = () => {
        clientRef.current?.cancel();
        onGenerationCancel();
    };
    const statusMessage = capturing ? "正在捕获当前镜头 / 当前帧的 Pose 与 Depth…" : captureError || generationStatus?.message || "使用当前镜头与当前帧生成，结果将保存到画布";
    const statusProgress = !capturing && generationActive ? generationStatus?.progress : undefined;

    return (
        <Modal
            open={open}
            onCancel={onClose}
            footer={null}
            width="min(96vw, 1280px)"
            centered
            destroyOnHidden
            title={t("canvas.director.title")}
            styles={{ body: { height: "min(84vh, 820px)", padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" } }}
        >
            <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 px-4 py-2">
                <Input aria-label="真人图提示词" placeholder="真人图提示词：服装、光线、场景…" value={prompt} onChange={(event) => onPromptChange(event.target.value)} maxLength={8000} disabled={active} className="min-w-48 flex-1" />
                <Button type="primary" onClick={() => void handleGenerate()} disabled={!ready || active || busy}>
                    {generationStatus?.state === "failed" || captureError ? "重试生成真人图" : "生成真人图"}
                </Button>
                {active ? (
                    <Button onClick={handleCancel} disabled={generationStatus?.state === "cancelling"}>
                        取消生成
                    </Button>
                ) : null}
                <span className="w-full text-xs opacity-70" role="status" aria-live="polite">
                    {busy ? "另一导演节点正在生成，请等待完成" : !ready && !captureError ? "正在连接 MONOFORM…" : statusMessage}
                    {typeof statusProgress === "number" ? ` ${Math.round(statusProgress)}%` : ""}
                </span>
            </div>
            <iframe ref={iframeRef} src={iframeSrc} title="MONOFORM" className="min-h-0 w-full flex-1 border-0" allow="camera; microphone; clipboard-write; fullscreen" />
        </Modal>
    );
}
