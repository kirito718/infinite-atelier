import { useSyncExternalStore, type ReactNode } from "react";
import { getAccountEpoch, subscribeAccountEpoch } from "@/services/account-client";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { NavigationSaveGuard } from "@/components/account/navigation-save-guard";

export default function UserLayout({ children }: { children: ReactNode }) {
    const epoch = useSyncExternalStore(subscribeAccountEpoch, getAccountEpoch, getAccountEpoch);
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <NavigationSaveGuard />
            <div key={epoch} className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
        </div>
    );
}
