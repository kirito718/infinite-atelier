import type { StateStorage } from "zustand/middleware";
import { flushEmbeddedEditors } from "./embedded-editors";
import { accountJson, getAccountIdentity, setAccountIdentity } from "./account-client";
import { createSaveQueue, type StateEntry } from "./save-queue";

let loadEpoch = 0;
// Recovery stays in this tab's memory, never browser disk or another account.
const recovery = new Map<string, StateEntry[]>();
export const hasRecoverableDrafts = () => recovery.size > 0;
export function installDraftRecoveryGuard() {
    if (typeof window === "undefined") return;
    window.addEventListener("beforeunload", (event) => {
        if (!recovery.size && !queue.getSnapshot().pending) return;
        event.preventDefault();
        event.returnValue = "";
    });
}
const queue = createSaveQueue({
    write: (userId, key, value, expectedRevision) =>
        accountJson(`/api/account/state/${encodeURIComponent(key)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "X-Atelier-User": userId },
            body: JSON.stringify({ value, expectedRevision }),
        }),
});
export const serverStorage: StateStorage = {
    getItem: (name) => queue.getItem(name),
    setItem: (name, value) => queue.setItem(name, value),
    removeItem: (name) => queue.removeItem(name),
};
export const getActiveUserId = getAccountIdentity;
export async function flushServerChanges() {
    await queue.flush();
    await flushEmbeddedEditors();
    await queue.flush();
}
export const retryServerChanges = queue.retry;
export const subscribeSyncStatus = queue.subscribe;
export const getSyncSnapshot = queue.getSnapshot;
export function clearServerStorage() {
    const userId = getAccountIdentity();
    const drafts = queue.getDrafts();
    if (userId && drafts.length) recovery.set(userId, drafts);
    loadEpoch++;
    queue.clear();
    setAccountIdentity(null);
}
export async function loadServerStorage(userId: string) {
    const epoch = ++loadEpoch;
    queue.clear();
    setAccountIdentity(userId);
    const { entries } = await accountJson<{ entries: StateEntry[] }>("/api/account/state");
    if (getAccountIdentity() !== userId || epoch !== loadEpoch) throw new Error("账号已切换，取消加载。");
    queue.start(userId, entries);
    queue.restoreDrafts(recovery.get(userId) || []);
    recovery.delete(userId);
}
export const activateServerStorage = queue.activate;
