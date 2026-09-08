import { getAccountEpoch, getAccountSignal } from "./account-client";
import type { CodexLogin, CodexStatus } from "./codex-image";

type Options = { signal?: AbortSignal };
export type CodexLoginTransport = {
    getStatus: (options?: Options) => Promise<CodexStatus>;
    beginLogin: (options?: Options) => Promise<CodexLogin>;
    cancelLogin: (loginId: string, options?: Options) => Promise<void>;
    logout: (options?: Options) => Promise<void>;
};
export type CodexLoginState = {
    status: CodexStatus | null;
    login: CodexLogin | null;
    busy: "starting" | "cancelling" | "disconnecting" | null;
    copyStatus: "idle" | "copying" | "copied" | "failed";
    error: { kind: "start" | "cancel" | "status" | "logout" | "expired" | "unavailable"; message?: string } | null;
};

const initialState = (): CodexLoginState => ({ status: null, login: null, busy: null, copyStatus: "idle", error: null });
const POLL_INTERVAL_MS = 1500;

/** One mounted panel/session owns this state; verification codes never enter a store. */
export function createCodexLoginController(transport: CodexLoginTransport, writeClipboard: (code: string) => Promise<boolean>) {
    const accountEpoch = getAccountEpoch();
    const accountSignal = getAccountSignal();
    const listeners = new Set<() => void>();
    let snapshot = initialState();
    let active = false;
    let revision = 0;
    let clipboardRevision = 0;
    let requestController: AbortController | null = null;
    let flight: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const sameAccount = () => !accountSignal.aborted && accountEpoch === getAccountEpoch() && accountSignal === getAccountSignal();
    const live = () => active && sameAccount();
    const current = (request: number) => live() && request === revision;
    const publish = (next: CodexLoginState) => {
        if (next.login !== snapshot.login) {
            ++clipboardRevision;
            next = { ...next, copyStatus: "idle" };
        }
        snapshot = next;
        listeners.forEach((listener) => listener());
    };
    const invalidate = () => {
        ++revision;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        requestController?.abort();
        requestController = null;
        flight = null;
    };
    const schedule = () => {
        if (!live()) return;
        // Schedule after settling, not on an interval: slow polls cannot overlap.
        timer = setTimeout(() => {
            timer = null;
            void refresh();
        }, POLL_INTERVAL_MS);
    };
    const beginRequest = () => {
        invalidate();
        requestController = new AbortController();
        return { request: revision, options: { signal: requestController.signal } };
    };
    const finish = (request: number) => {
        if (!current(request)) return;
        flight = null;
        requestController = null;
        schedule();
    };
    // Keep transport errors in the panel without turning a rejected action into success.
    const diagnostic = (cause: unknown) => (cause instanceof Error ? cause.message : undefined);
    const invoke = <T>(action: () => Promise<T>): Promise<T> => {
        try {
            return action();
        } catch (cause) {
            return Promise.reject(cause);
        }
    };

    function refresh(): Promise<void> {
        if (!live() || snapshot.busy) return Promise.resolve();
        if (flight) return flight;
        const { request, options } = beginRequest();
        flight = invoke(() => transport.getStatus(options))
            .then((status) => {
                if (!current(request)) return;
                let error = snapshot.error;
                if (status === "connected") error = null;
                else if (status === "unavailable") error = error && error.kind !== "status" ? error : { kind: "unavailable" };
                else if (status === "disconnected" && (snapshot.login || snapshot.status === "connecting")) error = { kind: "expired" };
                else if (error?.kind === "status" || error?.kind === "unavailable") error = null;
                publish({ ...snapshot, status, login: status === "connecting" ? snapshot.login : null, error });
            })
            .catch((cause: unknown) => {
                if (current(request)) publish({ ...snapshot, error: { kind: "status", message: diagnostic(cause) } });
            })
            .finally(() => finish(request));
        return flight;
    }

    function mutate(busy: NonNullable<CodexLoginState["busy"]>, kind: "start" | "cancel" | "logout", action: (options: Options) => Promise<Pick<CodexLoginState, "status" | "login">>): Promise<void> {
        if (!live()) return Promise.resolve();
        if (snapshot.busy) return snapshot.busy === busy && flight ? flight : Promise.resolve();
        const before = snapshot;
        // Invalidate even an in-flight status response before starting a mutation.
        const { request, options } = beginRequest();
        publish({ ...snapshot, ...(busy === "starting" ? { status: "connecting", login: null } : {}), busy, error: null });
        flight = invoke(() => action(options))
            .then((result) => {
                if (current(request)) publish({ ...snapshot, ...result, busy: null, error: null });
            })
            .catch((cause: unknown) => {
                if (current(request)) publish({ ...snapshot, status: before.status, login: before.login, busy: null, error: { kind, message: diagnostic(cause) } });
            })
            .finally(() => finish(request));
        return flight;
    }

    function close() {
        active = false;
        invalidate();
        accountSignal.removeEventListener("abort", close);
        publish(initialState());
        // Closing only abandons local work. The user may still authorize on OpenAI's page.
    }

    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        open() {
            if (active || !sameAccount()) return;
            active = true;
            accountSignal.addEventListener("abort", close, { once: true });
            void refresh();
        },
        close,
        refresh,
        copyCode(): Promise<void> {
            const login = snapshot.login;
            if (!live() || !login || snapshot.busy || snapshot.copyStatus === "copying") return Promise.resolve();
            const request = ++clipboardRevision;
            const currentCopy = () => live() && request === clipboardRevision && snapshot.login === login;
            publish({ ...snapshot, copyStatus: "copying" });
            return invoke(() => writeClipboard(login.userCode))
                .then((copied) => {
                    if (currentCopy()) publish({ ...snapshot, copyStatus: copied ? "copied" : "failed" });
                })
                .catch(() => {
                    if (currentCopy()) publish({ ...snapshot, copyStatus: "failed" });
                });
        },
        start: () => mutate("starting", "start", async (options) => ({ status: "connecting", login: await transport.beginLogin(options) })),
        cancel() {
            const loginId = snapshot.login?.loginId;
            if (!loginId) return Promise.resolve();
            return mutate("cancelling", "cancel", async (options) => {
                await transport.cancelLogin(loginId, options);
                return { status: "disconnected", login: null };
            });
        },
        disconnect: () =>
            mutate("disconnecting", "logout", async (options) => {
                await transport.logout(options);
                return { status: "disconnected", login: null };
            }),
    };
}
