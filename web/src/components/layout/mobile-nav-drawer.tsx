import { Drawer } from "antd";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
};

export function MobileNavDrawer({ open, activeToolSlug, onClose }: MobileNavDrawerProps) {
    const { t } = useTranslation();
    const workspaceTools = navigationTools.filter((tool) => tool.slug !== "config");
    const systemTools = navigationTools.filter((tool) => tool.slug === "config");

    const renderTool = (tool: (typeof navigationTools)[number]) => {
        const Icon = tool.icon;
        const active = tool.slug === activeToolSlug;
        return (
            <Link
                key={tool.slug}
                to={`/${tool.slug}`}
                onClick={onClose}
                className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-3 text-base transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400",
                    active ? "bg-stone-100 font-medium text-stone-950 dark:bg-stone-800 dark:text-stone-100" : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100",
                )}
                aria-current={active ? "page" : undefined}
            >
                <Icon className="size-5" />
                <span>{t(`navigation.${tool.slug}`)}</span>
            </Link>
        );
    };

    return (
        <Drawer title={t("topNav.navigation")} placement="left" size={280} open={open} onClose={onClose} className="md:hidden">
            <div className="space-y-6">
                <section aria-labelledby="mobile-workspace-nav">
                    <h2 id="mobile-workspace-nav" className="mb-2 px-3 text-xs font-semibold uppercase tracking-[0.16em] text-stone-400">
                        {t("topNav.workspace")}
                    </h2>
                    <div className="space-y-1">{workspaceTools.map(renderTool)}</div>
                </section>
                <section aria-labelledby="mobile-system-nav">
                    <h2 id="mobile-system-nav" className="mb-2 px-3 text-xs font-semibold uppercase tracking-[0.16em] text-stone-400">
                        {t("topNav.system")}
                    </h2>
                    <div className="space-y-1">{systemTools.map(renderTool)}</div>
                </section>
            </div>
        </Drawer>
    );
}
