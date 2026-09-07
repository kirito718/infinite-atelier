import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { LoaderCircle, LockKeyhole } from "lucide-react";

import { ACCOUNT_PASSWORD_MAX_LENGTH, ACCOUNT_PASSWORD_MIN_LENGTH, ACCOUNT_USERNAME_PATTERN, listenForAccountChanges, useUserStore, type UserStore } from "@/stores/use-user-store";

type AccountMode = "signIn" | "signUp";
const inputClass =
    "w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-950 outline-none transition focus:border-stone-600 focus:ring-2 focus:ring-stone-300 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:ring-stone-600";
const primaryButtonClass =
    "inline-flex w-full items-center justify-center gap-2 rounded-lg bg-stone-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-stone-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-600 disabled:cursor-wait disabled:opacity-60 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-white";

/** Mount outside all app routes so no business store consumers render before hydration. */
export function AccountGate({ children }: { children: ReactNode }) {
    const session = useUserStore();
    const refreshSession = session.refreshSession;

    useEffect(() => {
        const stopListening = listenForAccountChanges();
        void refreshSession();
        return stopListening;
    }, [refreshSession]);

    return <AccountGateContent session={session}>{children}</AccountGateContent>;
}

export function AccountGateContent({ children, session }: { children: ReactNode; session: UserStore }) {
    const [mode, setMode] = useState<AccountMode>("signIn");
    useEffect(() => {
        if (session.status === "authenticated" || !session.registrationAllowed) setMode("signIn");
    }, [session.status, session.registrationAllowed]);
    if (session.status === "authenticated" && session.user) return <>{children}</>;
    const submitting = session.pending === "signIn" || session.pending === "signUp";

    return (
        <main lang="zh-CN" className="flex min-h-dvh items-center justify-center bg-stone-50 px-4 py-10 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <section className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8 dark:border-stone-800 dark:bg-stone-900">
                <div className="mb-7 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-stone-500 dark:text-stone-400">
                    <LockKeyhole className="size-4" aria-hidden="true" />
                    INFINITE ATELIER
                </div>
                {session.status === "error" ? (
                    <div className="space-y-4">
                        <h1 className="text-xl font-semibold">无法恢复账号</h1>
                        <p className="text-sm text-stone-600 dark:text-stone-400">暂时无法确认会话或加载账号数据。重试成功后再进入工作区。</p>
                        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
                            {session.error || "账号服务暂时不可用，请重试。"}
                        </p>
                        <button type="button" className={primaryButtonClass} onClick={() => void session.refreshSession()}>
                            重试
                        </button>
                    </div>
                ) : session.status === "loading" && !submitting ? (
                    <div role="status" aria-live="polite" className="flex items-center gap-3 py-6 text-sm text-stone-600 dark:text-stone-300">
                        <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        正在恢复会话并加载账号数据…
                    </div>
                ) : (
                    <AccountCredentialsForm mode={mode} session={session} onModeChange={setMode} />
                )}
            </section>
        </main>
    );
}

export function AccountCredentialsForm({ mode, session, onModeChange }: { mode: AccountMode; session: UserStore; onModeChange: (mode: AccountMode) => void }) {
    const id = useId();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [displayName, setDisplayName] = useState("");
    const registering = (mode === "signUp" || session.pending === "signUp") && (session.registrationAllowed || session.pending === "signUp");
    const busy = session.pending !== null;

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (busy) return;
        try {
            if (registering) await session.signUp({ username, password, displayName });
            else await session.signIn({ username, password });
        } finally {
            setPassword("");
        }
    };

    const switchMode = () => {
        setPassword("");
        onModeChange(registering ? "signIn" : "signUp");
    };

    return (
        <form aria-labelledby={`${id}-title`} aria-busy={busy} onSubmit={submit} className="space-y-5">
            <div className="space-y-2">
                <h1 id={`${id}-title`} className="text-2xl font-semibold tracking-tight">
                    {registering ? "创建账号" : "登录工作区"}
                </h1>
                <p className="text-sm leading-relaxed text-stone-600 dark:text-stone-400">登录后访问此服务器上属于你的画布、素材和设置。</p>
            </div>
            {session.error ? (
                <p id={`${id}-error`} role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
                    {session.error}
                </p>
            ) : null}
            <fieldset disabled={busy} className="min-w-0 space-y-4">
                <legend className="sr-only">{registering ? "注册信息" : "登录信息"}</legend>
                <div className="space-y-1.5">
                    <label htmlFor={`${id}-username`} className="block text-sm font-medium">
                        用户名
                    </label>
                    <input
                        id={`${id}-username`}
                        name="username"
                        type="text"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        autoComplete="username"
                        autoCapitalize="none"
                        spellCheck={false}
                        autoFocus
                        required
                        minLength={3}
                        maxLength={40}
                        pattern={ACCOUNT_USERNAME_PATTERN}
                        title="3–40 位英文字母、数字、_、. 或 -"
                        aria-describedby={`${id}-username-help`}
                        className={inputClass}
                    />
                    <p id={`${id}-username-help`} className="text-xs leading-relaxed text-stone-500 dark:text-stone-400">
                        3–40 位英文字母、数字、_、. 或 -
                    </p>
                </div>
                {registering ? (
                    <div className="space-y-1.5">
                        <label htmlFor={`${id}-display-name`} className="block text-sm font-medium">
                            显示名称<span className="ml-1 font-normal text-stone-500">（可选）</span>
                        </label>
                        <input
                            id={`${id}-display-name`}
                            name="displayName"
                            type="text"
                            value={displayName}
                            onChange={(event) => setDisplayName(event.target.value)}
                            autoComplete="nickname"
                            maxLength={60}
                            aria-describedby={`${id}-display-name-help`}
                            className={inputClass}
                        />
                        <p id={`${id}-display-name-help`} className="text-xs text-stone-500 dark:text-stone-400">
                            最多 60 个字符；留空则使用用户名。
                        </p>
                    </div>
                ) : null}
                <div className="space-y-1.5">
                    <label htmlFor={`${id}-password`} className="block text-sm font-medium">
                        密码
                    </label>
                    <input
                        id={`${id}-password`}
                        name="password"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete={registering ? "new-password" : "current-password"}
                        required
                        minLength={ACCOUNT_PASSWORD_MIN_LENGTH}
                        maxLength={ACCOUNT_PASSWORD_MAX_LENGTH}
                        aria-describedby={`${id}-password-help`}
                        className={inputClass}
                    />
                    <p id={`${id}-password-help`} className="text-xs text-stone-500 dark:text-stone-400">
                        10–128 个字符。请勿与其他网站共用密码。
                    </p>
                </div>
                <button type="submit" disabled={busy} className={primaryButtonClass}>
                    {busy ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
                    {busy ? (registering ? "正在创建账号…" : "正在登录…") : registering ? "创建账号" : "登录"}
                </button>
            </fieldset>
            {busy ? (
                <p role="status" aria-live="polite" className="text-sm text-stone-600 dark:text-stone-400">
                    正在验证账号并加载数据，请稍候…
                </p>
            ) : null}
            {session.registrationAllowed || registering ? (
                <div className="space-y-2 text-center">
                    <button type="button" disabled={busy} onClick={switchMode} className="rounded text-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 disabled:opacity-50">
                        {registering ? "返回登录" : "注册账号"}
                    </button>
                    <p className="text-xs leading-relaxed text-stone-500 dark:text-stone-400">首个账号创建后默认关闭注册，后续注册需由管理员开放。</p>
                </div>
            ) : (
                <p className="text-center text-xs leading-relaxed text-stone-500 dark:text-stone-400">当前服务器已关闭注册，请使用已有账号登录。</p>
            )}
        </form>
    );
}
