import { Button, Input } from "antd";
import copy from "copy-to-clipboard";
import { Copy, ExternalLink, LogIn, LogOut, X } from "lucide-react";
import { useEffect, useId, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { getAccountEpoch, subscribeAccountEpoch } from "@/services/account-client";
import { beginCodexLogin, cancelCodexLogin, getCodexStatus, logoutCodex, type CodexLogin } from "@/services/codex-image";
import { createCodexLoginController, type CodexLoginState } from "@/services/codex-login-controller";

const transport = { getStatus: getCodexStatus, beginLogin: beginCodexLogin, cancelLogin: cancelCodexLogin, logout: logoutCodex };
type Props = { state: CodexLoginState; onCopy: () => void; onStart: () => void; onCancel: () => void; onRefresh: () => void; onDisconnect: () => void };

export function CodexLoginPanel() {
    const epoch = useSyncExternalStore(subscribeAccountEpoch, getAccountEpoch, getAccountEpoch);
    const controller = useMemo(() => createCodexLoginController(transport, (code) => copy(code, { format: "text/plain" })), [epoch]);
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    useEffect(() => {
        controller.open();
        return controller.close;
    }, [controller]);
    return <CodexLoginPanelContent state={state} onCopy={controller.copyCode} onStart={controller.start} onCancel={controller.cancel} onRefresh={controller.refresh} onDisconnect={controller.disconnect} />;
}

export function CodexLoginPanelContent({ state, onCopy, onStart, onCancel, onRefresh, onDisconnect }: Props) {
    const { t } = useTranslation();
    const login = state.status === "connecting" ? state.login : null;
    const busy = state.busy !== null;
    const startLabel = state.busy === "starting" ? "requestingCode" : state.status === "connecting" ? "resumeLogin" : state.error ? "retry" : "connect";

    return (
        <div className="space-y-4 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
            <div>
                <div className="text-base font-semibold">{t("config.codex.title")}</div>
                <div className="mt-1 text-sm text-stone-500">{t("config.codex.description")}</div>
            </div>
            <p className="rounded-md bg-stone-100 p-3 text-sm text-stone-600 dark:bg-stone-900 dark:text-stone-300">{t("config.codex.optInHelp")}</p>
            <div className="flex flex-wrap items-center gap-3">
                <span role="status" className="rounded-full border border-stone-200 px-3 py-1 text-sm dark:border-stone-700">
                    {state.status ? t(`config.codex.status.${state.status}`) : t("config.codex.checking")}
                </span>
                {state.status === "connected" ? (
                    <Button icon={<LogOut className="size-4" />} onClick={onDisconnect} loading={state.busy === "disconnecting"} disabled={busy}>
                        {t("config.codex.disconnect")}
                    </Button>
                ) : login ? (
                    <Button icon={<X className="size-4" />} onClick={onCancel} loading={state.busy === "cancelling"} disabled={busy}>
                        {t("config.codex.cancelLogin")}
                    </Button>
                ) : (
                    <Button type="primary" icon={<LogIn className="size-4" />} onClick={onStart} loading={state.busy === "starting"} disabled={busy}>
                        {t(`config.codex.${startLabel}`)}
                    </Button>
                )}
            </div>
            {login ? (
                <CodexDeviceCode key={login.loginId} login={login} copyStatus={state.copyStatus} onCopy={onCopy} disabled={busy} />
            ) : state.status === "connecting" && !busy ? (
                <p className="text-sm text-stone-500">{t("config.codex.pendingHelp")}</p>
            ) : null}
            {state.error ? (
                <div role="alert" className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                    <div className="font-medium">{t(`config.codex.errors.${state.error.kind}`)}</div>
                    {state.error.message ? <p className="break-words">{state.error.message}</p> : null}
                    <p>{t("config.codex.retryHelp")}</p>
                    {state.error.kind === "status" || state.error.kind === "unavailable" ? (
                        <Button size="small" onClick={onRefresh} disabled={busy}>
                            {t("config.codex.checkAgain")}
                        </Button>
                    ) : null}
                </div>
            ) : null}
            <div className="text-xs text-stone-500">{t("config.codex.imageOnly")}</div>
        </div>
    );
}

function CodexDeviceCode({ login, copyStatus, onCopy, disabled }: { login: CodexLogin; copyStatus: CodexLoginState["copyStatus"]; onCopy: () => void; disabled: boolean }) {
    const { t } = useTranslation();
    const codeId = useId();
    return (
        <div className="space-y-3 rounded-md border border-stone-200 p-3 dark:border-stone-700">
            <p className="text-sm text-stone-500">{t("config.codex.codeHelp")}</p>
            <label className="block text-sm font-medium" htmlFor={codeId}>
                {t("config.codex.codeLabel")}
            </label>
            <div className="flex flex-wrap gap-2">
                <Input
                    id={codeId}
                    aria-label={t("config.codex.codeLabel")}
                    className="min-w-0 flex-1 select-text font-mono tracking-widest"
                    readOnly
                    autoComplete="off"
                    spellCheck={false}
                    value={login.userCode}
                    onFocus={(event) => event.currentTarget.select()}
                />
                <Button icon={<Copy className="size-4" />} onClick={onCopy} loading={copyStatus === "copying"} disabled={disabled || copyStatus === "copying"}>
                    {t(copyStatus === "copied" ? "config.codex.copied" : "config.codex.copyCode")}
                </Button>
            </div>
            {copyStatus === "failed" ? (
                <p role="status" className="text-sm text-stone-500">
                    {t("config.codex.copyFailed")}
                </p>
            ) : null}
            <a href={login.verificationUrl} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-start gap-2 text-sm text-blue-600 underline underline-offset-2 dark:text-blue-400">
                <ExternalLink className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                    {t("config.codex.openVerification")}
                    <span className="mt-1 block break-all text-xs">{login.verificationUrl}</span>
                </span>
            </a>
            <p role="status" className="text-sm text-stone-600 dark:text-stone-300">
                {t("config.codex.waiting")}
            </p>
            <p className="text-xs text-stone-500">{t("config.codex.closeHelp")}</p>
        </div>
    );
}
