import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { useAccountAction } from "@/hooks/use-account-action";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

const workspaceSlugs: NavigationToolSlug[] = ["canvas", "director", "assets"];

export function AppSideNav() {
    const { pathname } = useLocation();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useAccountAction(useCanvasStore((state) => state.createProject));
    const [hoveredSlug, setHoveredSlug] = useState<NavigationToolSlug | null>(null);
    const hideNavigation = /^\/canvas\/[^/]+/.test(pathname);
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeToolSlug = navigationTools.some((tool) => tool.slug === slug) ? (slug as NavigationToolSlug) : undefined;

    if (hideNavigation) return null;

    const createAndEnter = () => {
        const id = createProject(t("canvas.defaultTitle", { count: projects.length + 1 }));
        navigate(`/canvas/${id}`);
    };

    const renderTool = (tool: (typeof navigationTools)[number]) => {
        const Icon = tool.icon;
        const active = tool.slug === activeToolSlug;
        const hovered = hoveredSlug === tool.slug;
        return (
            <Link
                key={tool.slug}
                to={`/${tool.slug}`}
                onMouseEnter={() => setHoveredSlug(tool.slug)}
                onMouseLeave={() => setHoveredSlug(null)}
                className={cn(
                    "group flex h-10 items-center gap-3 rounded-lg px-3 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e5543f]/50",
                    active ? "bg-[#f4d8d2] font-semibold text-stone-950 dark:bg-[#5a2c25] dark:text-stone-50" : "text-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-stone-900 dark:hover:text-stone-100",
                    hovered && !active && "translate-x-0.5",
                )}
                aria-current={active ? "page" : undefined}
            >
                <Icon className={cn("size-4 shrink-0", active ? "text-[#e5543f]" : "text-stone-400 group-hover:text-stone-700 dark:group-hover:text-stone-200")} />
                <span className="truncate">{t(`navigation.${tool.slug}`)}</span>
            </Link>
        );
    };

    return (
        <aside className="hidden h-dvh w-60 shrink-0 flex-col border-r border-stone-200 bg-[#fbfaf7] dark:border-stone-800 dark:bg-stone-950 md:flex" aria-label={t("topNav.navigation")}>
            <div className="flex h-full min-h-0 flex-col px-4 py-5">
                <Link to="/" className="flex h-9 items-center gap-2 rounded-lg px-2 text-sm font-semibold tracking-tight text-stone-950 transition hover:bg-stone-100 dark:text-stone-100 dark:hover:bg-stone-900">
                    <span className="size-5 shrink-0 rounded-[7px] bg-[#e5543f]" aria-hidden="true" />
                    <span>{t("meta.title")}</span>
                </Link>

                <button
                    type="button"
                    onClick={createAndEnter}
                    className="mt-6 flex h-11 items-center justify-center gap-2 rounded-lg bg-[#e5543f] px-4 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(229,84,63,0.18)] transition hover:bg-[#cf4937] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e5543f]/50 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-stone-950"
                    aria-label={t("topNav.createCanvas")}
                >
                    <span className="text-lg leading-none" aria-hidden="true">
                        +
                    </span>
                    <span>{t("topNav.createCanvas")}</span>
                </button>

                <nav className="mt-8 min-h-0 flex-1 overflow-y-auto" aria-label={t("topNav.navigation")}>
                    <div className="space-y-2">
                        <div className="px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-stone-400">{t("topNav.workspace")}</div>
                        <div className="space-y-1">{navigationTools.filter((tool) => workspaceSlugs.includes(tool.slug)).map(renderTool)}</div>
                    </div>
                    <div className="mt-8 space-y-2">
                        <div className="px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-stone-400">{t("topNav.system")}</div>
                        <div className="space-y-1">{navigationTools.filter((tool) => tool.slug === "config").map(renderTool)}</div>
                    </div>
                </nav>

                <div className="border-t border-stone-200 pt-4 dark:border-stone-800">
                    <div className="mb-3 flex items-center gap-2 px-2 text-[11px] text-stone-500 dark:text-stone-400">
                        <span className="size-2 rounded-full bg-[#d8b56d]" aria-hidden="true" />
                        <span>{t("topNav.accountStatus")}</span>
                    </div>
                    <UserStatusActions showConfig={false} />
                </div>
            </div>
        </aside>
    );
}
