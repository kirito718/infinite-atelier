import { useMemo, useSyncExternalStore } from "react";
import { getAccountEpoch, subscribeAccountEpoch } from "@/services/account-client";
import { bindAccountAction, bindAccountAsyncAction } from "@/services/account-bound-action";

export function useAccountAction<Args extends unknown[], Result>(action: (...args: Args) => Result) {
    const epoch = useSyncExternalStore(subscribeAccountEpoch, getAccountEpoch, getAccountEpoch);
    return useMemo(() => bindAccountAction(action), [action, epoch]);
}

export function useAccountAsyncAction<Args extends unknown[], Result>(action: (...args: Args) => Promise<Result>) {
    const epoch = useSyncExternalStore(subscribeAccountEpoch, getAccountEpoch, getAccountEpoch);
    return useMemo(() => bindAccountAsyncAction(action), [action, epoch]);
}
