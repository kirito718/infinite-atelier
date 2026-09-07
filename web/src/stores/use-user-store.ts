import { create } from "zustand";

import { changeAccountPassword, getAccountSession, loginAccount, logoutAccount, registerAccount, type AccountUser } from "@/services/account-client";
import { clearUserData, hydrateUserData } from "@/services/account-session";
import { flushServerChanges, hasRecoverableDrafts } from "@/services/server-storage";

// Keep the original exported name for existing consumers.
export type LocalUser = AccountUser;
export type AccountStatus = "loading" | "authenticated" | "anonymous" | "error";
export type AccountPending = "refresh" | "signIn" | "signUp" | "signOut" | "changePassword" | null;
type Credentials = { username: string; password: string };
type Registration = Credentials & { displayName: string };
type PasswordChange = { currentPassword: string; newPassword: string };

export const ACCOUNT_USERNAME_PATTERN = "[A-Za-z0-9_.\\-]{3,40}";
export const ACCOUNT_PASSWORD_MIN_LENGTH = 10;
export const ACCOUNT_PASSWORD_MAX_LENGTH = 128;

export function getAccountPasswordError(password: string, label = "密码"): string | null {
    return password.length < ACCOUNT_PASSWORD_MIN_LENGTH || password.length > ACCOUNT_PASSWORD_MAX_LENGTH ? `${label}须为 10–128 个字符。` : null;
}

function credentialsError({ username, password }: Credentials): string | null {
    if (!new RegExp(`^${ACCOUNT_USERNAME_PATTERN}$`).test(username)) return "用户名须为 3–40 位英文字母、数字、_、. 或 -。";
    return getAccountPasswordError(password);
}

export type UserStore = {
    status: AccountStatus;
    user: AccountUser | null;
    registrationAllowed: boolean;
    error: string | null;
    pending: AccountPending;
    clearSession: () => void;
    refreshSession: () => Promise<void>;
    signIn: (credentials: Credentials) => Promise<boolean>;
    signUp: (registration: Registration) => Promise<boolean>;
    signOut: () => Promise<boolean>;
    changePassword: (passwords: PasswordChange) => Promise<boolean>;
};

function accountError(error: unknown, fallback: string): string {
    if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return "无法连接服务器，请检查网络后重试。";
    return error instanceof Error && error.message ? error.message : fallback;
}

function broadcastAccountChange() {
    // This is only an invalidation signal. Never persist identities or credentials.
    try {
        const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem("atelier:account-changed", value);
    } catch {
        // Disabled browser storage must not turn a successful account action into a failure.
    }
}

export const useUserStore = create<UserStore>()((set, get) => {
    let epoch = 0;
    let hydratedUserId: string | null = null;
    let hydratingEpoch: number | null = null;

    const clearData = () => {
        hydratedUserId = null;
        hydratingEpoch = null;
        // The persistence boundary also invalidates its own in-flight hydration/writes.
        clearUserData();
    };

    const begin = (pending: AccountPending, keepSession = false) => {
        const request = ++epoch;
        if (hydratingEpoch !== null) {
            clearData();
            set({ user: null });
        }
        set({ pending, error: null, ...(!keepSession ? { status: "loading" as const } : {}) });
        return request;
    };

    const fail = (request: number, error: unknown, fallback: string, retrySession = false) => {
        if (request !== epoch) return false;
        if (hydratingEpoch === request) {
            clearData();
            set({ user: null });
        }
        const hasSession = get().user !== null && get().user?.id === hydratedUserId;
        set({
            status: retrySession ? "error" : hasSession ? "authenticated" : "anonymous",
            error: accountError(error, fallback),
            pending: null,
        });
        return false;
    };

    const acceptUser = async (user: AccountUser | null, request: number) => {
        if (request !== epoch) return false;
        if (user === null) {
            clearData();
            set({ status: "anonymous", user: null, error: hasRecoverableDrafts() ? "未保存草稿保留在本标签页。请重新登录原账号恢复，不要刷新或关闭页面。" : null, pending: null });
            return true;
        }
        // Re-validating the same cookie must not replace unsaved in-memory edits.
        if (hydratedUserId !== user.id) {
            clearData();
            set({ status: "loading", user: null });
            hydratingEpoch = request;
            await hydrateUserData(user.id);
            if (request !== epoch) return false;
            hydratingEpoch = null;
            hydratedUserId = user.id;
        }
        set({ status: "authenticated", user, error: null, pending: null });
        return true;
    };

    const readSession = async (request: number) => {
        const session = await getAccountSession();
        if (request !== epoch) return false;
        set({ registrationAllowed: session.registrationAllowed });
        return acceptUser(session.user, request);
    };

    return {
        status: "loading",
        user: null,
        registrationAllowed: false,
        error: null,
        pending: null,

        clearSession: () => {
            ++epoch;
            clearData();
            set({ status: "anonymous", user: null, registrationAllowed: false, error: null, pending: null });
        },

        refreshSession: async () => {
            const background = get().status === "authenticated" && get().user?.id === hydratedUserId;
            const request = begin("refresh", background);
            try {
                await readSession(request);
            } catch (error) {
                fail(request, error, "无法恢复账号会话，请重试。", !background || hydratingEpoch === request);
            }
        },

        signIn: async (input) => {
            const request = begin("signIn", get().status === "authenticated");
            const credentials = { username: input.username.trim(), password: input.password };
            const validation = credentialsError(credentials);
            if (validation) return fail(request, new Error(validation), validation);
            let cookieChanged = false;
            try {
                if (hydratedUserId !== null) {
                    await flushServerChanges();
                    if (request !== epoch) return false;
                }
                const { user } = await loginAccount(credentials);
                if (request !== epoch) return false;
                cookieChanged = true;
                broadcastAccountChange();
                return await acceptUser(user, request);
            } catch (error) {
                return fail(request, error, "登录失败，请重试。", cookieChanged);
            }
        },

        signUp: async (input) => {
            const allowed = get().registrationAllowed;
            const request = begin("signUp", get().status === "authenticated");
            const registration = { ...input, username: input.username.trim(), displayName: input.displayName.trim() || input.username.trim() };
            const validation = !allowed ? "当前服务器已关闭注册，请使用已有账号登录。" : credentialsError(registration) || (registration.displayName.length > 60 ? "显示名称最多 60 个字符。" : null);
            if (validation) return fail(request, new Error(validation), validation);
            let cookieChanged = false;
            try {
                if (hydratedUserId !== null) {
                    await flushServerChanges();
                    if (request !== epoch) return false;
                }
                const { user } = await registerAccount(registration);
                if (request !== epoch) return false;
                cookieChanged = true;
                // The next session read will obtain the exact server policy (including opt-in open registration).
                set({ registrationAllowed: false });
                broadcastAccountChange();
                return await acceptUser(user, request);
            } catch (error) {
                return fail(request, error, "注册失败，请重试。", cookieChanged);
            }
        },

        changePassword: async (passwords) => {
            const request = begin("changePassword", true);
            const validation = !get().user || get().user?.id !== hydratedUserId ? "请先登录。" : getAccountPasswordError(passwords.currentPassword, "当前密码") || getAccountPasswordError(passwords.newPassword, "新密码");
            if (validation) return fail(request, new Error(validation), validation);
            let cookieChanged = false;
            try {
                const { user } = await changeAccountPassword(passwords);
                if (request !== epoch) return false;
                cookieChanged = true;
                broadcastAccountChange();
                return await acceptUser(user, request);
            } catch (error) {
                return fail(request, error, "修改密码失败，请重试。", cookieChanged);
            }
        },

        signOut: async () => {
            // Keep the existing app/session mounted until both saving and logout succeed.
            const request = begin("signOut", true);
            let loggedOut = false;
            try {
                await flushServerChanges();
                if (request !== epoch) return false;
                await logoutAccount();
                if (request !== epoch) return false;
                loggedOut = true;
                clearData();
                set({ status: "loading", user: null, registrationAllowed: false, pending: "refresh" });
                broadcastAccountChange();
                // Registration policy may have changed since this account was created.
                return await readSession(request);
            } catch (error) {
                return fail(request, error, loggedOut ? "已退出，但无法获取账号状态，请重试。" : "无法保存或退出账号，请重试。", loggedOut);
            }
        },
    };
});

/** Register once at the app gate; cleanup handles StrictMode and unmounts. */
export function listenForAccountChanges(): () => void {
    if (typeof window === "undefined") return () => {};
    const seen = new WeakSet<Event>();
    const targets: EventTarget[] = typeof document === "undefined" ? [window] : [window, document];

    const onStorage = (event: StorageEvent) => {
        if (event.key !== "atelier:account-changed" || !event.newValue || event.newValue === event.oldValue) return;
        // A notice is not evidence of a different identity. Check first, preserving same-account drafts.
        void useUserStore.getState().refreshSession();
    };
    const onFocus = () => {
        // Focusing a password dialog or a window must not supersede an explicit account action.
        if (useUserStore.getState().pending === null) void useUserStore.getState().refreshSession();
    };
    const onApiEvent = (event: Event) => {
        if (seen.has(event)) return;
        seen.add(event);
        const alreadyRefreshing = useUserStore.getState().pending === "refresh";
        useUserStore.getState().clearSession();
        if (alreadyRefreshing) {
            // If the session read itself emits an API error, do not recursively fetch forever.
            useUserStore.setState({ status: "error", error: event.type === "atelier:session-expired" ? "会话已过期，请重试后重新登录。" : "账号状态已变更，请重试。" });
            return;
        }
        void useUserStore.getState().refreshSession();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    for (const target of targets) {
        target.addEventListener("atelier:session-expired", onApiEvent);
        target.addEventListener("atelier:account-changed", onApiEvent);
    }
    return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener("focus", onFocus);
        for (const target of targets) {
            target.removeEventListener("atelier:session-expired", onApiEvent);
            target.removeEventListener("atelier:account-changed", onApiEvent);
        }
    };
}

/** Explicit server data replacement must leave the old component lifetime. */
export async function reloadAccountData(expectedUserId: string) {
    if (useUserStore.getState().user?.id !== expectedUserId) throw new Error("账号已切换，取消重新加载。");
    useUserStore.getState().clearSession();
    await useUserStore.getState().refreshSession();
    if (useUserStore.getState().status !== "authenticated" || useUserStore.getState().user?.id !== expectedUserId) throw new Error("服务端数据已提交，但重新加载失败，请重试登录。");
}
