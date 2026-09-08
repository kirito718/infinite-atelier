import { getAccountIdentity, getAccountSignal } from "./account-client";

// Old component callbacks may finish after logout (file reads, model generation,
// archive parsing). Such callbacks must never mutate the next account's stores.
export function bindAccountAction<Args extends unknown[], Result>(action: (...args: Args) => Result): (...args: Args) => Result {
    const userId = getAccountIdentity();
    const signal = getAccountSignal();
    return (...args) => {
        if (!userId || signal.aborted || userId !== getAccountIdentity()) return undefined as Result;
        return action(...args);
    };
}

export function bindAccountAsyncAction<Args extends unknown[], Result>(action: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
    const userId = getAccountIdentity();
    const signal = getAccountSignal();
    const check = () => {
        if (!userId || signal.aborted || userId !== getAccountIdentity()) throw Object.assign(new Error("账号会话已切换，已取消原账号的操作。"), { code: "ACCOUNT_CHANGED" });
    };
    return async (...args) => {
        check();
        const result = await action(...args);
        check();
        return result;
    };
}
