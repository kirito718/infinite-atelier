import axios from "axios";

export type AccountUser = { id: string; username: string; displayName: string; avatarUrl: string };
export class AccountApiError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
    ) {
        super(message);
        this.name = "AccountApiError";
    }
}
let identity: string | null = null;
let identityEpoch = 0;
const identityListeners = new Set<() => void>();
export const getAccountEpoch = () => identityEpoch;
export const subscribeAccountEpoch = (listener: () => void) => {
    identityListeners.add(listener);
    return () => {
        identityListeners.delete(listener);
    };
};
let sessionController = new AbortController();
export const getAccountIdentity = () => identity;
export function setAccountIdentity(userId: string | null) {
    if (identity === userId) return;
    sessionController.abort();
    sessionController = new AbortController();
    identity = userId;
    identityEpoch++;
    identityListeners.forEach((listener) => listener());
}
export function assertAccountIdentity(userId: string | null) {
    if (!userId || identity !== userId) throw new AccountApiError(409, "ACCOUNT_CHANGED", "账号已切换，请重新加载后继续。");
}
export const getAccountSignal = () => sessionController.signal;
export function accountRequestOptions(options?: { signal?: AbortSignal }) {
    return { ...options, signal: options?.signal ? AbortSignal.any([options.signal, sessionController.signal]) : sessionController.signal };
}

function protectedUrl(input: string | URL | Request) {
    const text = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    try {
        const url = new URL(text, origin);
        return url.origin === origin && (url.pathname.startsWith("/api/account/") || url.pathname.startsWith("/api/codex-subscription/") || url.pathname.startsWith("/api/comfyui/") || url.pathname === "/api-proxy");
    } catch {
        return false;
    }
}
function signalIdentityError(code: string) {
    if (typeof window === "undefined") return;
    if (code === "UNAUTHENTICATED") window.dispatchEvent(new Event("atelier:session-expired"));
    if (code === "ACCOUNT_CHANGED") window.dispatchEvent(new Event("atelier:account-changed"));
}
export function accountHeaders(extra?: HeadersInit, userId = identity): Headers {
    const headers = new Headers(extra);
    headers.set("X-Atelier-Request", "1");
    if (userId) headers.set("X-Atelier-User", userId);
    return headers;
}

export async function authenticatedFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    if (!protectedUrl(input)) return globalThis.fetch(input, init);
    const userId = identity;
    const accountSignal = sessionController.signal;
    const headers = accountHeaders(init.headers);
    // Callers such as the save queue can pin a prior request to its captured account.
    const supplied = new Headers(init.headers).get("X-Atelier-User");
    if (supplied) headers.set("X-Atelier-User", supplied);
    const response = await globalThis.fetch(input, {
        ...init,
        credentials: "same-origin",
        headers,
        signal: init.signal ? AbortSignal.any([init.signal, accountSignal]) : accountSignal,
    });
    if (identity !== userId || accountSignal.aborted) throw new AccountApiError(409, "ACCOUNT_CHANGED", "账号已切换。");
    if (response.status === 401 || response.status === 409) {
        const body = await response
            .clone()
            .json()
            .catch(() => ({}));
        // A delayed error body must not expire a replacement session (even for the same user).
        if (identity !== userId || accountSignal.aborted) throw new AccountApiError(409, "ACCOUNT_CHANGED", "账号已切换。");
        signalIdentityError(body.code);
    }
    return response;
}

async function parseResponse<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;
    let data;
    try {
        data = await response.json();
    } catch {
        throw new AccountApiError(response.status, "INVALID_RESPONSE", "服务器未返回有效数据，请检查服务是否已启动。");
    }
    if (!response.ok) throw new AccountApiError(response.status, data.code || "REQUEST_FAILED", data.error || "请求失败，请重试。");
    return data as T;
}
export async function accountJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    return parseResponse<T>(await authenticatedFetch(path, init));
}
async function authRequest<T>(path: string, body?: unknown) {
    // Auth/session endpoints intentionally ignore the previous account identity and its abort signal.
    return parseResponse<T>(
        await globalThis.fetch(`/api/account/${path}`, {
            method: body === undefined ? "GET" : "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-Atelier-Request": "1" },
            ...(body !== undefined && { body: JSON.stringify(body) }),
        }),
    );
}
export const getAccountSession = () => authRequest<{ user: AccountUser | null; registrationAllowed: boolean }>("session");
export const loginAccount = (input: { username: string; password: string }) => authRequest<{ user: AccountUser }>("login", input);
export const registerAccount = (input: { username: string; password: string; displayName: string }) => authRequest<{ user: AccountUser }>("register", input);
export const logoutAccount = () => accountJson<void>("/api/account/logout", { method: "POST" });
export const changeAccountPassword = (input: { currentPassword: string; newPassword: string }) =>
    accountJson<{ user: AccountUser }>("/api/account/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });

let interceptorsInstalled = false;
export function installAccountHttpInterceptors() {
    if (interceptorsInstalled) return;
    interceptorsInstalled = true;
    axios.interceptors.request.use((config) => {
        if (config.url && protectedUrl(config.url)) {
            config.headers.set("X-Atelier-Request", "1");
            if (identity) config.headers.set("X-Atelier-User", identity);
            const signal = sessionController.signal;
            config.signal = config.signal instanceof AbortSignal ? AbortSignal.any([config.signal, signal]) : signal;
        }
        return config;
    });
    axios.interceptors.response.use(
        (response) => {
            if (response.config.url && protectedUrl(response.config.url)) {
                const userId = response.config.headers.get("X-Atelier-User");
                if (userId && userId !== identity) throw new AccountApiError(409, "ACCOUNT_CHANGED", "账号已切换。");
            }
            return response;
        },
        (error) => {
            if (error.config?.url && protectedUrl(error.config.url)) signalIdentityError(error.response?.data?.code);
            return Promise.reject(error);
        },
    );
}
