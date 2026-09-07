import { useEffect, useRef, useState } from "react";
import { Modal } from "antd";
import { useBlocker } from "react-router-dom";
import { flushServerChanges, getSyncSnapshot } from "@/services/server-storage";
import { hasPendingEmbeddedEditors } from "@/services/embedded-editors";

/** Keep mounted editors alive until their queued saves have actually completed. */
export function NavigationSaveGuard() {
    const blocker = useBlocker(({ currentLocation, nextLocation }) => currentLocation.pathname !== nextLocation.pathname && (getSyncSnapshot().pending > 0 || hasPendingEmbeddedEditors()));
    const [error, setError] = useState<string | null>(null);
    const running = useRef(false);
    useEffect(() => {
        if (blocker.state !== "blocked" || running.current) return;
        running.current = true;
        setError(null);
        void flushServerChanges()
            .then(
                () => blocker.proceed(),
                (cause) => setError(cause instanceof Error ? cause.message : "保存失败，请重试。"),
            )
            .finally(() => {
                running.current = false;
            });
    }, [blocker]);
    return (
        <Modal
            open={blocker.state === "blocked"}
            title={error ? "尚有未保存的内容" : "正在保存后离开…"}
            closable={Boolean(error)}
            maskClosable={false}
            cancelText="留在此页"
            okText="放弃未保存内容并离开"
            okButtonProps={{ danger: true, disabled: !error }}
            cancelButtonProps={{ disabled: !error }}
            onCancel={() => {
                setError(null);
                if (blocker.state === "blocked") blocker.reset();
            }}
            onOk={() => {
                if (blocker.state === "blocked") blocker.proceed();
            }}
        >
            <p role={error ? "alert" : "status"}>{error || "正在等待画布和导演台保存到服务器，请稍候。"}</p>
            {error && <p className="mt-2 text-sm text-stone-500">建议留在此页，导出草稿或重试保存。继续离开可能丢失未保存的更改。</p>}
        </Modal>
    );
}
