export type StateEntry = { key: string; value: string | null; revision: number };
export type SyncSnapshot = { ready: boolean; pending: number; saving: boolean; error: string | null; conflict: boolean };
type Write = (userId: string, key: string, value: string | null, expectedRevision: number) => Promise<{ revision: number }>;

/** Serialized, account-scoped compare-and-swap writes; failed drafts remain queued. */
export function createSaveQueue({ write, debounceMs = 400 }: { write: Write; debounceMs?: number }) {
    let account: string | null = null,
        epoch = 0,
        enabled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flight: Promise<void> | null = null,
        activeKey: string | null = null;
    let activeValue: string | null = null;
    const changedAccount = () => Object.assign(new Error("保存期间账号状态已变化；未保存草稿保留在本标签页，请重新登录原账号。"), { code: "ACCOUNT_CHANGED" });
    let error: Error | null = null,
        conflict = false,
        retryCount = 0;
    const values = new Map<string, { value: string | null; revision: number }>();
    const pending = new Map<string, string | null>();
    const conflictedRevisions = new Map<string, number>();
    const listeners = new Set<() => void>();
    let snapshot: SyncSnapshot = { ready: false, pending: 0, saving: false, error: null, conflict: false };
    function notify() {
        snapshot = { ready: enabled, pending: pending.size + (activeKey && !pending.has(activeKey) ? 1 : 0), saving: Boolean(activeKey), error: error?.message || null, conflict };
        listeners.forEach((listener) => listener());
    }
    function schedule(delay = debounceMs) {
        clearTimeout(timer);
        if (!enabled || conflict) return;
        timer = setTimeout(() => {
            timer = undefined;
            void flush().catch(() => {});
        }, delay);
    }
    function clear() {
        epoch++;
        clearTimeout(timer);
        timer = undefined;
        account = null;
        enabled = false;
        flight = null;
        activeKey = null;
        activeValue = null;
        error = null;
        conflict = false;
        retryCount = 0;
        values.clear();
        pending.clear();
        conflictedRevisions.clear();
        notify();
    }
    function start(userId: string, entries: StateEntry[]) {
        clear();
        account = userId;
        entries.forEach(({ key, value, revision }) => values.set(key, { value, revision }));
    }
    function setItem(key: string, value: string | null) {
        if (!enabled || !account) return;
        if (activeKey !== key && !pending.has(key) && (values.get(key)?.value ?? null) === value) return;
        pending.set(key, value);
        notify();
        schedule();
    }
    async function drain(userId: string, version: number) {
        while (version === epoch && pending.size) {
            const [key, value] = pending.entries().next().value!;
            pending.delete(key);
            activeKey = key;
            activeValue = value;
            notify();
            const revision = values.get(key)?.revision ?? 0;
            try {
                const result = await write(userId, key, value, revision);
                if (version !== epoch) throw changedAccount();
                if (result.revision !== revision + 1) throw new Error("服务器返回了无效版本号，数据尚未确认保存。");
                values.set(key, { value, revision: result.revision });
                error = null;
                retryCount = 0;
            } catch (cause) {
                if (version !== epoch) throw changedAccount();
                if (!pending.has(key)) pending.set(key, value);
                error = cause instanceof Error ? cause : new Error("保存失败，请重试。");
                const code = (cause as { code?: string })?.code;
                conflict = code === "CONFLICT" || code === "ACCOUNT_CHANGED";
                if (!conflict && code !== "UNAUTHENTICATED" && (!(cause as { status?: number })?.status || (cause as { status: number }).status >= 500 || (cause as { status: number }).status === 429))
                    schedule(Math.min(30000, 2000 * 2 ** Math.min(retryCount++, 4)));
                throw error;
            } finally {
                if (version === epoch) {
                    activeKey = null;
                    activeValue = null;
                    notify();
                }
            }
        }
    }
    function flush(): Promise<void> {
        clearTimeout(timer);
        timer = undefined;
        if (!enabled || !account) return Promise.resolve();
        if (conflict) return Promise.reject(error || new Error("保存冲突，请先导出未保存内容再刷新。"));
        if (flight) return flight;
        const version = epoch;
        flight = drain(account, version).finally(() => {
            if (epoch === version) {
                flight = null;
                notify();
            }
        });
        return flight;
    }
    function getDrafts(): StateEntry[] {
        const drafts = new Map<string, string | null>();
        if (activeKey) drafts.set(activeKey, activeValue);
        for (const [key, value] of pending) drafts.set(key, value);
        return [...drafts].map(([key, value]) => ({ key, value, revision: conflictedRevisions.get(key) ?? values.get(key)?.revision ?? 0 }));
    }
    function restoreDrafts(drafts: StateEntry[]) {
        for (const draft of drafts) {
            const stored = values.get(draft.key) || { value: null, revision: 0 };
            if (stored.value === draft.value) continue;
            pending.set(draft.key, draft.value);
            if (stored.revision !== draft.revision) {
                conflictedRevisions.set(draft.key, draft.revision);
                conflict = true;
                error = Object.assign(new Error("已恢复本页草稿，但服务器在会话中断期间有新版本。请先导出草稿再刷新，不会自动覆盖。"), { code: "CONFLICT" });
            }
        }
        notify();
    }
    return {
        start,
        clear,
        setItem,
        flush,
        getDrafts,
        restoreDrafts,
        activate: () => {
            enabled = true;
            notify();
            if (pending.size && !conflict) schedule();
        },
        getItem: (key: string) => (pending.has(key) ? pending.get(key)! : (values.get(key)?.value ?? null)),
        removeItem: (key: string) => setItem(key, null),
        retry: () => flush(),
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,
    };
}
