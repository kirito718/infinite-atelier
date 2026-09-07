import { useId, useState, type CSSProperties, type FormEvent } from "react";
import { Dropdown, Modal } from "antd";
import { KeyRound, LoaderCircle, LogOut, UserRound } from "lucide-react";

import { ACCOUNT_PASSWORD_MAX_LENGTH, ACCOUNT_PASSWORD_MIN_LENGTH, getAccountPasswordError, useUserStore, type UserStore } from "@/stores/use-user-store";

type AccountActionsProps = { className?: string; style?: CSSProperties };
type PasswordFields = { currentPassword: string; newPassword: string; confirmPassword: string };
const triggerClass =
    "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-wait dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white";
const inputClass =
    "w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-950 outline-none focus:border-stone-600 focus:ring-2 focus:ring-stone-300 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:ring-stone-600";

export function AccountActions(props: AccountActionsProps) {
    const session = useUserStore();
    return <AccountActionsContent {...props} session={session} />;
}

export function AccountActionsContent({ session, ...props }: AccountActionsProps & { session: UserStore }) {
    if (session.status !== "authenticated" || !session.user) return null;
    // A new identity must not inherit another account's password dialog or input values.
    return <AccountMenu key={session.user.id} {...props} session={session} />;
}

function AccountMenu({ session, className, style }: AccountActionsProps & { session: UserStore }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [passwordOpen, setPasswordOpen] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const user = session.user!;
    const busy = session.pending !== null;
    const closePassword = () => {
        if (!busy) setPasswordOpen(false);
    };

    return (
        <>
            <Dropdown
                trigger={["click"]}
                placement="bottomRight"
                autoFocus
                open={menuOpen}
                onOpenChange={setMenuOpen}
                menu={{
                    items: [
                        {
                            key: "identity",
                            disabled: true,
                            label: (
                                <div lang="zh-CN" className="max-w-64 py-1">
                                    <div className="truncate font-medium">{user.displayName || user.username}</div>
                                    <div className="truncate text-xs">用户名：{user.username}</div>
                                </div>
                            ),
                        },
                        { type: "divider" },
                        {
                            key: "password",
                            label: "修改密码",
                            icon: <KeyRound className="size-4" aria-hidden="true" />,
                            disabled: busy,
                            onClick: () => {
                                setMenuOpen(false);
                                setNotice(null);
                                setPasswordOpen(true);
                            },
                        },
                        {
                            key: "migration",
                            label: "浏览器旧数据迁移",
                            disabled: busy,
                            onClick: () => {
                                setMenuOpen(false);
                                window.dispatchEvent(new Event("atelier:open-migration"));
                            },
                        },
                        {
                            key: "logout",
                            label: "退出登录",
                            icon: <LogOut className="size-4" aria-hidden="true" />,
                            disabled: busy,
                            onClick: () => {
                                setMenuOpen(false);
                                setNotice(null);
                                void session.signOut();
                            },
                        },
                    ],
                }}
            >
                <button
                    type="button"
                    className={className || triggerClass}
                    style={style}
                    aria-label={`账号菜单：${user.username}`}
                    title={`${user.displayName || user.username}（${user.username}）`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-busy={busy}
                    disabled={busy}
                >
                    {busy ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <UserRound className="size-4" aria-hidden="true" />}
                </button>
            </Dropdown>
            <Modal title={<span lang="zh-CN">修改密码</span>} open={passwordOpen} onCancel={closePassword} footer={null} centered destroyOnHidden closable={!busy} keyboard={!busy} maskClosable={!busy} width={440}>
                <AccountPasswordForm
                    session={session}
                    onCancel={closePassword}
                    onDone={() => {
                        setPasswordOpen(false);
                        setNotice("密码已修改，其他会话已退出。");
                    }}
                />
            </Modal>
            {!passwordOpen && (session.error || notice || session.pending === "signOut") ? (
                <div lang="zh-CN" className="fixed inset-x-4 bottom-4 z-[1200] max-w-sm rounded-xl border border-stone-200 bg-white p-4 text-sm text-stone-900 shadow-lg sm:left-auto dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100">
                    {session.error ? (
                        <div role="alert" className="space-y-2">
                            <p className="text-red-700 dark:text-red-300">{session.error}</p>
                            <p className="text-xs text-stone-500 dark:text-stone-400">当前账号仍保留；可在账号菜单中重试。</p>
                            <button type="button" className="rounded underline underline-offset-4 focus-visible:outline-2" disabled={busy} onClick={() => void session.refreshSession()}>
                                重新验证会话
                            </button>
                        </div>
                    ) : (
                        <p role="status" aria-live="polite">
                            {session.pending === "signOut" ? "正在保存数据并退出…" : notice}
                        </p>
                    )}
                </div>
            ) : null}
        </>
    );
}

export function validatePasswordChange({ currentPassword, newPassword, confirmPassword }: PasswordFields): string | null {
    return getAccountPasswordError(currentPassword, "当前密码") || getAccountPasswordError(newPassword, "新密码") || (newPassword !== confirmPassword ? "两次输入的新密码不一致。" : null);
}

export function AccountPasswordForm({ session, onDone, onCancel }: { session: UserStore; onDone: () => void; onCancel: () => void }) {
    const id = useId();
    const [passwords, setPasswords] = useState<PasswordFields>({ currentPassword: "", newPassword: "", confirmPassword: "" });
    const [validationError, setValidationError] = useState<string | null>(null);
    const [submitted, setSubmitted] = useState(false);
    const busy = session.pending !== null;
    const error = validationError || (submitted ? session.error : null);

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (busy) return;
        const validation = validatePasswordChange(passwords);
        setValidationError(validation);
        if (validation) return;
        setSubmitted(true);
        const success = await session.changePassword({ currentPassword: passwords.currentPassword, newPassword: passwords.newPassword });
        if (success) {
            setPasswords({ currentPassword: "", newPassword: "", confirmPassword: "" });
            onDone();
        } else {
            setPasswords((current) => ({ ...current, currentPassword: "" }));
        }
    };

    return (
        <form lang="zh-CN" aria-label="修改密码" aria-busy={busy} onSubmit={submit} className="space-y-4 pt-2">
            <p id={`${id}-help`} className="text-sm leading-relaxed text-stone-600 dark:text-stone-400">
                密码须为 10–128 个字符。修改成功后，其他会话将退出。
            </p>
            {error ? (
                <p id={`${id}-error`} role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
                    {error}
                </p>
            ) : null}
            <fieldset disabled={busy} className="min-w-0 space-y-4">
                <legend className="sr-only">密码验证信息</legend>
                {(
                    [
                        ["currentPassword", "当前密码", "current-password"],
                        ["newPassword", "新密码", "new-password"],
                        ["confirmPassword", "确认新密码", "new-password"],
                    ] as const
                ).map(([name, label, autoComplete]) => (
                    <div key={name} className="space-y-1.5">
                        <label htmlFor={`${id}-${name}`} className="block text-sm font-medium">
                            {label}
                        </label>
                        <input
                            id={`${id}-${name}`}
                            name={name}
                            type="password"
                            value={passwords[name]}
                            onChange={(event) => setPasswords((current) => ({ ...current, [name]: event.target.value }))}
                            autoComplete={autoComplete}
                            autoFocus={name === "currentPassword"}
                            required
                            minLength={ACCOUNT_PASSWORD_MIN_LENGTH}
                            maxLength={ACCOUNT_PASSWORD_MAX_LENGTH}
                            aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
                            className={inputClass}
                        />
                    </div>
                ))}
                <div className="flex justify-end gap-2 pt-2">
                    <button type="button" onClick={onCancel} disabled={busy} className="rounded-lg border border-stone-300 px-4 py-2 text-sm focus-visible:outline-2 disabled:opacity-60 dark:border-stone-700">
                        取消
                    </button>
                    <button
                        type="submit"
                        disabled={busy}
                        className="inline-flex items-center justify-center gap-2 rounded-lg bg-stone-950 px-4 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-60 dark:bg-stone-100 dark:text-stone-950"
                    >
                        {busy ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
                        {busy ? "正在修改…" : "修改密码"}
                    </button>
                </div>
            </fieldset>
            {busy ? (
                <p role="status" aria-live="polite" className="text-sm text-stone-500">
                    正在修改密码，请稍候…
                </p>
            ) : null}
        </form>
    );
}
