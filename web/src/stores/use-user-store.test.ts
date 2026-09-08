import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
    getAccountSession: vi.fn(),
    loginAccount: vi.fn(),
    registerAccount: vi.fn(),
    logoutAccount: vi.fn(),
    changeAccountPassword: vi.fn(),
    hydrateUserData: vi.fn(),
    clearUserData: vi.fn(),
    flushServerChanges: vi.fn(),
}));

vi.mock("@/services/account-client", () => ({
    getAccountSession: boundary.getAccountSession,
    loginAccount: boundary.loginAccount,
    registerAccount: boundary.registerAccount,
    logoutAccount: boundary.logoutAccount,
    changeAccountPassword: boundary.changeAccountPassword,
}));
vi.mock("@/services/account-session", () => ({
    hydrateUserData: boundary.hydrateUserData,
    clearUserData: boundary.clearUserData,
}));
vi.mock("@/services/server-storage", () => ({ flushServerChanges: boundary.flushServerChanges, hasRecoverableDrafts: () => false }));

const alice = { id: "alice-id", username: "alice", displayName: "Alice", avatarUrl: "" };
const bob = { id: "bob-id", username: "bob", displayName: "Bob", avatarUrl: "" };
const credentials = { username: "alice", password: "a long password" };

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

let useUserStore: typeof import("./use-user-store").useUserStore;
let listenForAccountChanges: typeof import("./use-user-store").listenForAccountChanges;
let stopListening: (() => void) | undefined;
let stored: Map<string, string>;
let storageWrites: Array<[string, string]>;

beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    stored = new Map();
    storageWrites = [];
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => {
            stored.set(key, value);
            storageWrites.push([key, value]);
        },
        removeItem: (key: string) => stored.delete(key),
    });
    boundary.getAccountSession.mockResolvedValue({ user: null, registrationAllowed: false });
    boundary.loginAccount.mockResolvedValue({ user: alice });
    boundary.registerAccount.mockResolvedValue({ user: alice });
    boundary.logoutAccount.mockResolvedValue(undefined);
    boundary.changeAccountPassword.mockResolvedValue({ user: alice });
    boundary.hydrateUserData.mockResolvedValue(undefined);
    boundary.flushServerChanges.mockResolvedValue(undefined);
    ({ useUserStore, listenForAccountChanges } = await import("./use-user-store"));
});

afterEach(() => {
    stopListening?.();
    stopListening = undefined;
    vi.unstubAllGlobals();
});

async function restoreAlice() {
    boundary.getAccountSession.mockResolvedValueOnce({ user: alice, registrationAllowed: false });
    await useUserStore.getState().refreshSession();
}

describe("account lifecycle", () => {
    it("starts gated while the cookie session is unknown", () => {
        expect(useUserStore.getState()).toMatchObject({ status: "loading", user: null, registrationAllowed: false, error: null });
    });

    it("treats HTTP 200 with user=null as anonymous and honors registrationAllowed", async () => {
        boundary.getAccountSession.mockResolvedValueOnce({ user: null, registrationAllowed: true });
        await useUserStore.getState().refreshSession();
        expect(useUserStore.getState()).toMatchObject({ status: "anonymous", user: null, registrationAllowed: true, error: null });
        expect(boundary.hydrateUserData).not.toHaveBeenCalled();
    });

    it("does not authenticate or expose the user until their data finishes hydrating", async () => {
        const hydration = deferred<void>();
        boundary.getAccountSession.mockResolvedValueOnce({ user: alice, registrationAllowed: false });
        boundary.hydrateUserData.mockReturnValueOnce(hydration.promise);
        const restoring = useUserStore.getState().refreshSession();
        await vi.waitFor(() => expect(boundary.hydrateUserData).toHaveBeenCalledWith("alice-id"));
        expect(useUserStore.getState()).toMatchObject({ status: "loading", user: null });
        hydration.resolve();
        await restoring;
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, error: null });
    });

    it("exposes a retryable error rather than anonymous content when the session fetch fails", async () => {
        boundary.getAccountSession.mockRejectedValueOnce(new Error("无法连接账号服务器"));
        await useUserStore.getState().refreshSession();
        expect(useUserStore.getState()).toMatchObject({ status: "error", user: null, error: "无法连接账号服务器" });
        await restoreAlice();
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, error: null });
    });

    it("clears partial hydration on failure and retries hydration before authenticating", async () => {
        boundary.getAccountSession.mockResolvedValue({ user: alice, registrationAllowed: false });
        boundary.hydrateUserData.mockRejectedValueOnce(new Error("账号数据读取失败"));
        await useUserStore.getState().refreshSession();
        expect(useUserStore.getState()).toMatchObject({ status: "error", user: null, error: "账号数据读取失败" });
        expect(boundary.clearUserData.mock.invocationCallOrder.at(-1)).toBeGreaterThan(boundary.hydrateUserData.mock.invocationCallOrder[0]);
        await useUserStore.getState().refreshSession();
        expect(boundary.hydrateUserData).toHaveBeenCalledTimes(2);
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice });
    });

    it("clears the previous account before hydrating a switched identity", async () => {
        await restoreAlice();
        const hydration = deferred<void>();
        const order: string[] = [];
        boundary.clearUserData.mockImplementation(() => {
            order.push("clear");
        });
        boundary.hydrateUserData.mockImplementation((id: string) => {
            order.push(`hydrate:${id}`);
            return hydration.promise;
        });
        boundary.getAccountSession.mockResolvedValueOnce({ user: bob, registrationAllowed: false });
        const switching = useUserStore.getState().refreshSession();
        await vi.waitFor(() => expect(order).toEqual(["clear", "hydrate:bob-id"]));
        expect(useUserStore.getState()).toMatchObject({ status: "loading", user: null });
        hydration.resolve();
        await switching;
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: bob });
    });

    it("does not discard unsaved data or rehydrate when a refresh confirms the same account", async () => {
        await restoreAlice();
        const clears = boundary.clearUserData.mock.calls.length;
        boundary.getAccountSession.mockResolvedValueOnce({ user: { ...alice, displayName: "Updated Alice" }, registrationAllowed: true });
        await useUserStore.getState().refreshSession();
        expect(boundary.clearUserData).toHaveBeenCalledTimes(clears);
        expect(boundary.hydrateUserData).toHaveBeenCalledTimes(1);
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: { ...alice, displayName: "Updated Alice" } });
    });

    it("clears the previous account when the server reports an anonymous session", async () => {
        await restoreAlice();
        const clears = boundary.clearUserData.mock.calls.length;
        await useUserStore.getState().refreshSession();
        expect(boundary.clearUserData).toHaveBeenCalledTimes(clears + 1);
        expect(useUserStore.getState()).toMatchObject({ status: "anonymous", user: null });
    });

    it("waits for saving and logout, then clears data and checks current registration policy", async () => {
        await restoreAlice();
        const saving = deferred<void>();
        const logout = deferred<void>();
        boundary.flushServerChanges.mockReturnValueOnce(saving.promise);
        boundary.logoutAccount.mockReturnValueOnce(logout.promise);
        boundary.getAccountSession.mockResolvedValueOnce({ user: null, registrationAllowed: true });
        const signingOut = useUserStore.getState().signOut();
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, pending: "signOut" });
        expect(boundary.logoutAccount).not.toHaveBeenCalled();
        saving.resolve();
        await vi.waitFor(() => expect(boundary.logoutAccount).toHaveBeenCalledOnce());
        expect(useUserStore.getState().user).toEqual(alice);
        logout.resolve();
        await signingOut;
        expect(useUserStore.getState()).toMatchObject({ status: "anonymous", user: null, registrationAllowed: true, error: null, pending: null });
        expect(storageWrites.map(([key]) => key)).toEqual(["atelier:account-changed"]);
    });

    it.each(["saving", "logout"])("preserves the old session and data if %s fails", async (failure) => {
        await restoreAlice();
        const clears = boundary.clearUserData.mock.calls.length;
        const message = failure === "saving" ? "数据尚未保存，请重试" : "退出失败，请重试";
        (failure === "saving" ? boundary.flushServerChanges : boundary.logoutAccount).mockRejectedValueOnce(new Error(message));
        await useUserStore.getState().signOut();
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, error: message, pending: null });
        expect(boundary.clearUserData).toHaveBeenCalledTimes(clears);
        expect(storageWrites).toEqual([]);
        if (failure === "saving") expect(boundary.logoutAccount).not.toHaveBeenCalled();
    });

    it("does not let a late bootstrap response replace a newer sign-in", async () => {
        const session = deferred<{ user: typeof alice; registrationAllowed: boolean }>();
        boundary.getAccountSession.mockReturnValueOnce(session.promise);
        const restoring = useUserStore.getState().refreshSession();
        boundary.loginAccount.mockResolvedValueOnce({ user: bob });
        await useUserStore.getState().signIn({ username: "bob", password: "bob's password" });
        session.resolve({ user: alice, registrationAllowed: true });
        await restoring;
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: bob });
        expect(boundary.hydrateUserData.mock.calls).toEqual([["bob-id"]]);
    });

    it("invalidates a pending sign-in when clearSession is called", async () => {
        const login = deferred<{ user: typeof alice }>();
        boundary.loginAccount.mockReturnValueOnce(login.promise);
        const signingIn = useUserStore.getState().signIn(credentials);
        useUserStore.getState().clearSession();
        login.resolve({ user: alice });
        await signingIn;
        expect(useUserStore.getState()).toMatchObject({ status: "anonymous", user: null });
        expect(boundary.hydrateUserData).not.toHaveBeenCalled();
    });

    it("invalidates an in-flight hydration before accepting a newer account", async () => {
        const hydration = deferred<void>();
        boundary.getAccountSession.mockResolvedValueOnce({ user: alice, registrationAllowed: false });
        boundary.hydrateUserData.mockReturnValueOnce(hydration.promise);
        const restoring = useUserStore.getState().refreshSession();
        await vi.waitFor(() => expect(boundary.hydrateUserData).toHaveBeenCalledWith("alice-id"));
        const clears = boundary.clearUserData.mock.calls.length;
        boundary.loginAccount.mockResolvedValueOnce({ user: bob });
        await useUserStore.getState().signIn({ username: "bob", password: "bob's password" });
        expect(boundary.clearUserData.mock.calls.length).toBeGreaterThan(clears);
        const latestClears = boundary.clearUserData.mock.calls.length;
        hydration.resolve();
        await restoring;
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: bob });
        expect(boundary.clearUserData).toHaveBeenCalledTimes(latestClears);
    });
});

describe("account forms' store boundary", () => {
    it.each([
        { username: "ab", password: "a long password" },
        { username: "a".repeat(41), password: "a long password" },
        { username: "用户alice", password: "a long password" },
        { username: "alice smith", password: "a long password" },
        { username: "alice", password: "x".repeat(9) },
        { username: "alice", password: "x".repeat(129) },
    ])("rejects invalid credentials before sending them ($username / password length)", async (input) => {
        await useUserStore.getState().signIn(input);
        expect(boundary.loginAccount).not.toHaveBeenCalled();
        expect(useUserStore.getState()).toMatchObject({ status: "anonymous", user: null, pending: null });
        expect(useUserStore.getState().error).toBeTruthy();
    });

    it.each([10, 128])("accepts a %i-character password without trimming it", async (length) => {
        const password = ` ${"x".repeat(length - 2)} `;
        await useUserStore.getState().signIn({ username: "  a_1.-  ", password });
        expect(boundary.loginAccount).toHaveBeenCalledWith({ username: "a_1.-", password });
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, error: null });
    });

    it("shows a rejected login without falsely authenticating", async () => {
        boundary.loginAccount.mockRejectedValueOnce(new Error("用户名或密码错误"));
        const success = await useUserStore.getState().signIn(credentials);
        expect(success).toBe(false);
        expect(useUserStore.getState()).toMatchObject({ status: "anonymous", user: null, error: "用户名或密码错误", pending: null });
        expect(boundary.hydrateUserData).not.toHaveBeenCalled();
    });

    it("does not switch accounts if the previous account's edits cannot be saved", async () => {
        await restoreAlice();
        boundary.flushServerChanges.mockRejectedValueOnce(new Error("请先保存当前账号的数据"));
        await useUserStore.getState().signIn({ username: "bob", password: "bob's password" });
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, error: "请先保存当前账号的数据" });
        expect(boundary.loginAccount).not.toHaveBeenCalled();
    });

    it("does not submit registration unless the server has allowed it", async () => {
        await useUserStore.getState().refreshSession();
        await useUserStore.getState().signUp({ ...credentials, displayName: "Alice" });
        expect(boundary.registerAccount).not.toHaveBeenCalled();
        expect(useUserStore.getState()).toMatchObject({ status: "anonymous", user: null });
        expect(useUserStore.getState().error).toMatch(/注册/);
    });

    it("registers and hydrates the first account, then closes registration conservatively", async () => {
        boundary.getAccountSession.mockResolvedValueOnce({ user: null, registrationAllowed: true });
        await useUserStore.getState().refreshSession();
        await useUserStore.getState().signUp({ username: "  alice  ", password: credentials.password, displayName: "  Alice  " });
        expect(boundary.registerAccount).toHaveBeenCalledWith({ ...credentials, displayName: "Alice" });
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, registrationAllowed: false, error: null });
        expect(boundary.hydrateUserData).toHaveBeenCalledWith("alice-id");
    });

    it("uses the username as the optional display name and accepts the 60-character bound", async () => {
        boundary.getAccountSession.mockResolvedValue({ user: null, registrationAllowed: true });
        await useUserStore.getState().refreshSession();
        await useUserStore.getState().signUp({ ...credentials, displayName: "   " });
        expect(boundary.registerAccount).toHaveBeenLastCalledWith({ ...credentials, displayName: "alice" });
        await useUserStore.getState().refreshSession();
        await useUserStore.getState().signUp({ ...credentials, displayName: "名".repeat(60) });
        expect(boundary.registerAccount).toHaveBeenLastCalledWith({ ...credentials, displayName: "名".repeat(60) });
        expect(useUserStore.getState().error).toBeNull();
    });

    it("rejects an oversized display name without silently truncating it", async () => {
        boundary.getAccountSession.mockResolvedValueOnce({ user: null, registrationAllowed: true });
        await useUserStore.getState().refreshSession();
        await useUserStore.getState().signUp({ ...credentials, displayName: "名".repeat(61) });
        expect(boundary.registerAccount).not.toHaveBeenCalled();
        expect(useUserStore.getState().error).toMatch(/60/);
    });

    it("broadcasts only fresh random invalidation values, never credentials or account identities", async () => {
        await useUserStore.getState().signIn(credentials);
        await useUserStore.getState().signOut();
        expect(storageWrites).toHaveLength(2);
        expect(new Set(storageWrites.map(([, value]) => value)).size).toBe(2);
        for (const [key, value] of storageWrites) {
            expect(key).toBe("atelier:account-changed");
            expect(value).toBeTruthy();
            for (const secret of [alice.id, alice.username, credentials.password]) expect(value).not.toContain(secret);
        }
        expect([...stored.keys()]).toEqual(["atelier:account-changed"]);
    });

    it("does not fail a successful sign-in when localStorage is unavailable", async () => {
        vi.stubGlobal("localStorage", {
            setItem: () => {
                throw new Error("Storage disabled");
            },
        });
        await useUserStore.getState().signIn(credentials);
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, error: null });
    });

    it("keeps the live account during password changes and broadcasts only after success", async () => {
        await restoreAlice();
        const password = deferred<{ user: typeof alice }>();
        boundary.changeAccountPassword.mockReturnValueOnce(password.promise);
        const changing = useUserStore.getState().changePassword({ currentPassword: credentials.password, newPassword: "a newer password" });
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, pending: "changePassword" });
        expect(storageWrites).toEqual([]);
        password.resolve({ user: alice });
        expect(await changing).toBe(true);
        expect(boundary.changeAccountPassword).toHaveBeenCalledWith({ currentPassword: credentials.password, newPassword: "a newer password" });
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, error: null, pending: null });
        expect(boundary.hydrateUserData).toHaveBeenCalledTimes(1);
        expect(storageWrites.map(([key]) => key)).toEqual(["atelier:account-changed"]);
    });

    it("leaves the current account signed in if changing its password fails", async () => {
        await restoreAlice();
        boundary.changeAccountPassword.mockRejectedValueOnce(new Error("当前密码错误"));
        expect(await useUserStore.getState().changePassword({ currentPassword: "wrong password", newPassword: "a newer password" })).toBe(false);
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, error: "当前密码错误", pending: null });
        expect(storageWrites).toEqual([]);
    });
});

describe("overlapping lifecycle operations", () => {
    it("ignores an old sign-in failure after a newer sign-in succeeds", async () => {
        const oldLogin = deferred<{ user: typeof alice }>();
        boundary.loginAccount.mockReturnValueOnce(oldLogin.promise).mockResolvedValueOnce({ user: bob });
        const oldRequest = useUserStore.getState().signIn(credentials);
        await useUserStore.getState().signIn({ username: "bob", password: "bob's password" });
        oldLogin.reject(new Error("旧请求失败"));
        await oldRequest;
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: bob, error: null });
    });

    it("does not send a superseded logout after an old flush finally finishes", async () => {
        await restoreAlice();
        const saving = deferred<void>();
        boundary.flushServerChanges.mockReturnValueOnce(saving.promise);
        const signingOut = useUserStore.getState().signOut();
        boundary.loginAccount.mockResolvedValueOnce({ user: bob });
        await useUserStore.getState().signIn({ username: "bob", password: "bob's password" });
        saving.resolve();
        await signingOut;
        expect(boundary.logoutAccount).not.toHaveBeenCalled();
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: bob });
    });

    it("does not restore an old account from a late password-change response", async () => {
        await restoreAlice();
        const password = deferred<{ user: typeof alice }>();
        boundary.changeAccountPassword.mockReturnValueOnce(password.promise);
        const changing = useUserStore.getState().changePassword({ currentPassword: credentials.password, newPassword: "a newer password" });
        useUserStore.getState().clearSession();
        boundary.loginAccount.mockResolvedValueOnce({ user: bob });
        await useUserStore.getState().signIn({ username: "bob", password: "bob's password" });
        password.resolve({ user: alice });
        expect(await changing).toBe(false);
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: bob });
    });
});

function dispatchStorageChange(key = "atelier:account-changed", newValue: string | null = "random-notice", oldValue: string | null = "old-notice") {
    const event = new Event("storage");
    Object.assign(event, { key, newValue, oldValue });
    window.dispatchEvent(event);
}

describe("account invalidation listeners", () => {
    beforeEach(() => {
        vi.stubGlobal("window", new EventTarget());
        vi.stubGlobal("document", new EventTarget());
    });

    it("reconciles other tabs' account-change notifications without broadcasting them again", async () => {
        await restoreAlice();
        stopListening = listenForAccountChanges();
        boundary.getAccountSession.mockResolvedValueOnce({ user: bob, registrationAllowed: false });
        dispatchStorageChange();
        await vi.waitFor(() => expect(useUserStore.getState().user).toEqual(bob));
        expect(useUserStore.getState().status).toBe("authenticated");
        expect(boundary.hydrateUserData.mock.calls).toEqual([["alice-id"], ["bob-id"]]);
        expect(storageWrites).toEqual([]);
    });

    it("ignores unrelated, deleted, or unchanged localStorage entries", async () => {
        await restoreAlice();
        stopListening = listenForAccountChanges();
        dispatchStorageChange("theme");
        dispatchStorageChange("atelier:account-changed", null);
        dispatchStorageChange("atelier:account-changed", "same", "same");
        expect(useUserStore.getState().user).toEqual(alice);
        expect(boundary.getAccountSession).toHaveBeenCalledOnce();
    });

    it.each(["document", "window"] as const)("clears expired data immediately and revalidates API events on %s", async (target) => {
        await restoreAlice();
        const session = deferred<{ user: null; registrationAllowed: boolean }>();
        boundary.getAccountSession.mockReturnValueOnce(session.promise);
        stopListening = listenForAccountChanges();
        globalThis[target].dispatchEvent(new CustomEvent("atelier:session-expired"));
        expect(useUserStore.getState().user).toBeNull();
        expect(useUserStore.getState().status).not.toBe("authenticated");
        session.resolve({ user: null, registrationAllowed: false });
        await vi.waitFor(() => expect(useUserStore.getState().status).toBe("anonymous"));
        expect(storageWrites).toEqual([]);
    });

    it("revalidates stale-account API events and deduplicates a bubbling document event", async () => {
        await restoreAlice();
        boundary.getAccountSession.mockResolvedValueOnce({ user: bob, registrationAllowed: false });
        stopListening = listenForAccountChanges();
        const event = new CustomEvent("atelier:account-changed");
        document.dispatchEvent(event);
        window.dispatchEvent(event);
        await vi.waitFor(() => expect(useUserStore.getState().user).toEqual(bob));
        expect(boundary.getAccountSession).toHaveBeenCalledTimes(2);
        expect(storageWrites).toEqual([]);
    });

    it("fails closed with a retry instead of recursively refreshing on session API errors", async () => {
        await restoreAlice();
        stopListening = listenForAccountChanges();
        boundary.getAccountSession.mockImplementationOnce(async () => {
            document.dispatchEvent(new CustomEvent("atelier:session-expired"));
            throw new Error("会话不可用");
        });
        window.dispatchEvent(new CustomEvent("atelier:account-changed"));
        await vi.waitFor(() => expect(useUserStore.getState().status).toBe("error"));
        expect(useUserStore.getState().user).toBeNull();
        expect(useUserStore.getState().error).toBeTruthy();
        expect(boundary.getAccountSession).toHaveBeenCalledTimes(2);
        await useUserStore.getState().refreshSession();
        expect(useUserStore.getState().status).toBe("anonymous");
    });

    it("removes all listeners when the account gate unmounts", async () => {
        await restoreAlice();
        stopListening = listenForAccountChanges();
        stopListening();
        dispatchStorageChange();
        document.dispatchEvent(new CustomEvent("atelier:session-expired"));
        window.dispatchEvent(new CustomEvent("atelier:account-changed"));
        expect(boundary.getAccountSession).toHaveBeenCalledOnce();
        expect(useUserStore.getState().user).toEqual(alice);
    });
});

describe("background session validation", () => {
    it("keeps the authenticated app mounted while checking the same identity", async () => {
        await restoreAlice();
        const session = deferred<{ user: typeof alice; registrationAllowed: boolean }>();
        boundary.getAccountSession.mockReturnValueOnce(session.promise);
        const refresh = useUserStore.getState().refreshSession();
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, pending: "refresh" });
        session.resolve({ user: alice, registrationAllowed: false });
        await refresh;
        expect(boundary.hydrateUserData).toHaveBeenCalledTimes(1);
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, pending: null });
    });

    it("preserves a hydrated account and exposes an error on a background network failure", async () => {
        await restoreAlice();
        const clears = boundary.clearUserData.mock.calls.length;
        boundary.getAccountSession.mockRejectedValueOnce(new Error("暂时无法验证会话，请重试"));
        await useUserStore.getState().refreshSession();
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, error: "暂时无法验证会话，请重试", pending: null });
        expect(boundary.clearUserData).toHaveBeenCalledTimes(clears);
    });

    it("refreshes on focus without replacing same-account data", async () => {
        vi.stubGlobal("window", new EventTarget());
        vi.stubGlobal("document", new EventTarget());
        await restoreAlice();
        const clears = boundary.clearUserData.mock.calls.length;
        boundary.getAccountSession.mockResolvedValueOnce({ user: alice, registrationAllowed: false });
        stopListening = listenForAccountChanges();
        window.dispatchEvent(new Event("focus"));
        await vi.waitFor(() => expect(boundary.getAccountSession).toHaveBeenCalledTimes(2));
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice });
        expect(boundary.clearUserData).toHaveBeenCalledTimes(clears);
        expect(boundary.hydrateUserData).toHaveBeenCalledTimes(1);
    });
});

describe("account lifecycle edge cases", () => {
    it("still broadcasts account changes when randomUUID is unavailable on an HTTP origin", async () => {
        vi.stubGlobal("crypto", {});
        await useUserStore.getState().signIn(credentials);
        expect(storageWrites).toHaveLength(1);
        expect(storageWrites[0][0]).toBe("atelier:account-changed");
        expect(storageWrites[0][1]).toBeTruthy();
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, error: null });
    });

    it("keeps the old authenticated app mounted while saving before an explicit identity switch", async () => {
        await restoreAlice();
        const saving = deferred<void>();
        boundary.flushServerChanges.mockReturnValueOnce(saving.promise);
        const signingIn = useUserStore.getState().signIn({ username: "bob", password: "bob's password" });
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, pending: "signIn" });
        saving.reject(new Error("尚未保存"));
        await signingIn;
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice, error: "尚未保存" });
        expect(boundary.loginAccount).not.toHaveBeenCalled();
    });

    it("checks same-account cross-tab notices without clearing drafts or unmounting the app", async () => {
        vi.stubGlobal("window", new EventTarget());
        vi.stubGlobal("document", new EventTarget());
        await restoreAlice();
        const clears = boundary.clearUserData.mock.calls.length;
        const session = deferred<{ user: typeof alice; registrationAllowed: boolean }>();
        boundary.getAccountSession.mockReturnValueOnce(session.promise);
        stopListening = listenForAccountChanges();
        dispatchStorageChange();
        expect(useUserStore.getState()).toMatchObject({ status: "authenticated", user: alice });
        expect(boundary.clearUserData).toHaveBeenCalledTimes(clears);
        session.resolve({ user: alice, registrationAllowed: false });
        await vi.waitFor(() => expect(useUserStore.getState().pending).toBeNull());
        expect(boundary.hydrateUserData).toHaveBeenCalledTimes(1);
        expect(boundary.clearUserData).toHaveBeenCalledTimes(clears);
    });

    it("does not let focus interrupt an explicit password change", async () => {
        vi.stubGlobal("window", new EventTarget());
        vi.stubGlobal("document", new EventTarget());
        await restoreAlice();
        const response = deferred<{ user: typeof alice }>();
        boundary.changeAccountPassword.mockReturnValueOnce(response.promise);
        stopListening = listenForAccountChanges();
        const changing = useUserStore.getState().changePassword({ currentPassword: credentials.password, newPassword: "a newer password" });
        window.dispatchEvent(new Event("focus"));
        expect(boundary.getAccountSession).toHaveBeenCalledOnce();
        response.resolve({ user: alice });
        expect(await changing).toBe(true);
    });

    it("reports a post-logout session-fetch failure without resurrecting the logged-out account", async () => {
        await restoreAlice();
        boundary.getAccountSession.mockRejectedValueOnce(new Error("无法连接服务器"));
        await useUserStore.getState().signOut();
        expect(useUserStore.getState()).toMatchObject({ status: "error", user: null, error: "无法连接服务器" });
        expect(storageWrites).toHaveLength(1);
        await useUserStore.getState().refreshSession();
        expect(useUserStore.getState()).toMatchObject({ status: "anonymous", user: null });
    });
});

describe("explicit server data replacement", () => {
    it("forces the authenticated gate to unmount old consumers until replacement hydration completes", async () => {
        await useUserStore.getState().signIn(credentials);
        const loading = deferred<void>();
        boundary.hydrateUserData.mockImplementationOnce(() => loading.promise);
        boundary.getAccountSession.mockResolvedValue({ user: alice, registrationAllowed: false });
        const { reloadAccountData } = await import("./use-user-store");
        const reloading = reloadAccountData(alice.id);
        expect(useUserStore.getState().status).toBe("loading");
        expect(useUserStore.getState().user).toBeNull();
        await vi.waitFor(() => expect(boundary.hydrateUserData).toHaveBeenCalledTimes(2));
        loading.resolve();
        await reloading;
        expect(useUserStore.getState().status).toBe("authenticated");
        expect(useUserStore.getState().user?.id).toBe(alice.id);
    });
});
