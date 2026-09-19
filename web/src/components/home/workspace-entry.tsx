import { useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, ChevronRight, Clock3, FilePlus2, FolderOpen, MoreHorizontal, Search, Sparkles, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { getProjectNodeSummary } from "@/pages/home/workspace-entry-model";

type WorkspaceEntryProps = {
    hydrated: boolean;
    recentProjects: CanvasProject[];
    onOpenNewCanvas: () => void;
    onCreateCanvas: () => void;
    onOpenProject: (id: string) => void;
    onOpenCanvasLibrary: () => void;
    onImportReference: () => void;
    onStartFromPrompt: () => void;
};

const quickStartItems = [
    { key: "blank", icon: FilePlus2 },
    { key: "import", icon: FolderOpen },
    { key: "prompt", icon: Sparkles },
] as const;

export function WorkspaceEntry({ hydrated, recentProjects, onOpenNewCanvas, onCreateCanvas, onOpenProject, onOpenCanvasLibrary, onImportReference, onStartFromPrompt }: WorkspaceEntryProps) {
    const { i18n, t } = useTranslation();
    const [query, setQuery] = useState("");
    const filteredProjects = useMemo(() => {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        return normalizedQuery ? recentProjects.filter((project) => project.title.toLocaleLowerCase().includes(normalizedQuery)) : recentProjects;
    }, [query, recentProjects]);
    const featuredProject = filteredProjects[0];

    if (!hydrated) {
        return (
            <main className="h-full overflow-y-auto bg-[#f3f1ec] text-stone-950 dark:bg-stone-950 dark:text-stone-100">
                <div className="mx-auto flex min-h-full w-full max-w-[1480px] items-center justify-center px-6 py-10 lg:px-10">
                    <p role="status" className="text-sm text-stone-500 dark:text-stone-400">{t("home.loading")}</p>
                </div>
            </main>
        );
    }

    return (
        <main className="h-full overflow-y-auto bg-[#f3f1ec] text-stone-950 dark:bg-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
                <header className="flex flex-col gap-5 border-b border-stone-200 pb-6 dark:border-stone-800 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#e5543f]">{t("home.workspaceEntry")}</p>
                        <h1 className="mt-2 text-3xl font-bold tracking-tight text-stone-950 dark:text-stone-100">{t("home.continueCreating")}</h1>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <label className="flex h-9 min-w-[220px] items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 text-sm text-stone-500 shadow-sm shadow-stone-200/40 focus-within:border-[#e5543f] focus-within:ring-2 focus-within:ring-[#e5543f]/15 dark:border-stone-800 dark:bg-stone-900 dark:shadow-none">
                            <Search className="size-4 shrink-0" aria-hidden="true" />
                            <span className="sr-only">{t("home.searchProjects")}</span>
                            <input
                                type="search"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={t("home.searchProjects")}
                                className="min-w-0 flex-1 bg-transparent text-sm text-stone-900 outline-none placeholder:text-stone-400 dark:text-stone-100"
                            />
                            {query ? (
                                <button type="button" onClick={() => setQuery("")} className="rounded p-0.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100" aria-label={t("home.clearSearch")}>
                                    <X className="size-3.5" />
                                </button>
                            ) : null}
                        </label>
                        <button type="button" onClick={onImportReference} className="inline-flex h-9 items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 text-sm font-semibold text-stone-700 transition hover:border-stone-300 hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e5543f]/30 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800">
                            <Upload className="size-4" />
                            {t("home.importReference")}
                        </button>
                        <button type="button" onClick={onOpenNewCanvas} className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#e5543f] px-3 text-sm font-semibold text-white transition hover:bg-[#cf4937] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e5543f]/40 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-stone-950">
                            <span className="text-lg leading-none" aria-hidden="true">+</span>
                            {t("topNav.createCanvas")}
                        </button>
                    </div>
                </header>

                <section className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(300px,1fr)]" aria-labelledby="continue-section-title">
                    {featuredProject ? <FeaturedProject project={featuredProject} onOpenProject={onOpenProject} locale={i18n.resolvedLanguage} t={t} /> : <EmptyProject onOpenNewCanvas={onOpenNewCanvas} t={t} />}
                    <QuickStartPanel onCreateCanvas={onCreateCanvas} onImportReference={onImportReference} onStartFromPrompt={onStartFromPrompt} t={t} />
                </section>

                <section aria-labelledby="recent-canvases-title">
                    <div className="mb-3 flex items-center justify-between gap-4">
                        <h2 id="recent-canvases-title" className="flex items-center gap-2 text-lg font-bold text-stone-950 dark:text-stone-100">
                            <Clock3 className="size-4 text-[#e5543f]" />
                            {t("home.recentCanvases")}
                        </h2>
                        <button type="button" onClick={onOpenCanvasLibrary} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-semibold text-stone-500 transition hover:bg-stone-100 hover:text-stone-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 dark:text-stone-400 dark:hover:bg-stone-900 dark:hover:text-stone-100">
                            {t("home.viewAll")}
                            <ArrowRight className="size-4" />
                        </button>
                    </div>
                    {filteredProjects.length ? (
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                            {filteredProjects.map((project, index) => <ProjectCard key={project.id} project={project} index={index} onOpenProject={onOpenProject} locale={i18n.resolvedLanguage} t={t} />)}
                        </div>
                    ) : (
                        <div className="rounded-xl border border-dashed border-stone-300 bg-white/50 px-5 py-10 text-center dark:border-stone-700 dark:bg-stone-900/40">
                            <p className="text-sm font-semibold text-stone-700 dark:text-stone-200">{t("home.noSearchResults")}</p>
                            <button type="button" onClick={() => setQuery("")} className="mt-3 text-sm font-semibold text-[#e5543f] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e5543f]/30">{t("home.clearSearch")}</button>
                        </div>
                    )}
                </section>
            </div>
        </main>
    );
}

function FeaturedProject({ project, onOpenProject, locale, t }: { project: CanvasProject; onOpenProject: (id: string) => void; locale: string | undefined; t: (key: string, options?: Record<string, unknown>) => string }) {
    const summary = getProjectNodeSummary(project);
    return (
        <article className="min-h-[285px] rounded-2xl bg-[#171514] p-6 text-stone-50 shadow-[0_18px_40px_rgba(23,21,20,0.12)] dark:bg-[#24201e]">
            <div className="flex items-center justify-between gap-4 text-[10px] font-bold uppercase tracking-[0.16em] text-[#bbafa4]">
                <span>{t("home.lastOpened", { date: formatDate(project.updatedAt, locale) })}</span>
                <button type="button" className="rounded-md p-1 text-[#bbafa4] transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60" aria-label={t("home.projectMenu", { name: project.title })} title={t("home.projectMenu", { name: project.title })}>
                    <MoreHorizontal className="size-4" />
                </button>
            </div>
            <h2 id="continue-section-title" className="mt-5 text-2xl font-bold tracking-tight">{project.title}</h2>
            <ProjectPreview variant="featured" />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-[#bbafa4]">
                <span>{t("canvas.project.stats", summary)}</span>
                <button type="button" onClick={() => onOpenProject(project.id)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-semibold text-white transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
                    {t("home.openProject")}
                    <ArrowUpRight className="size-4 text-[#e5543f]" />
                </button>
            </div>
        </article>
    );
}

function EmptyProject({ onOpenNewCanvas, t }: { onOpenNewCanvas: () => void; t: (key: string) => string }) {
    return (
        <article className="flex min-h-[285px] flex-col justify-center rounded-2xl border border-dashed border-stone-300 bg-white/70 p-6 dark:border-stone-700 dark:bg-stone-900/60">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#e5543f]">{t("home.workspaceEntry")}</p>
            <h2 id="continue-section-title" className="mt-3 text-2xl font-bold tracking-tight text-stone-950 dark:text-stone-100">{t("home.noProjects")}</h2>
            <p className="mt-3 max-w-md text-sm leading-6 text-stone-500 dark:text-stone-400">{t("home.emptyDescription")}</p>
            <button type="button" onClick={onOpenNewCanvas} className="mt-6 inline-flex h-10 w-fit items-center gap-2 rounded-lg bg-[#e5543f] px-4 text-sm font-semibold text-white transition hover:bg-[#cf4937] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e5543f]/40 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-stone-950">
                <span className="text-lg leading-none" aria-hidden="true">+</span>
                {t("topNav.createCanvas")}
            </button>
        </article>
    );
}

function QuickStartPanel({ onCreateCanvas, onImportReference, onStartFromPrompt, t }: { onCreateCanvas: () => void; onImportReference: () => void; onStartFromPrompt: () => void; t: (key: string, options?: Record<string, unknown>) => string }) {
    const handlers = { blank: onCreateCanvas, import: onImportReference, prompt: onStartFromPrompt };
    return (
        <section className="rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900" aria-labelledby="quick-start-title">
            <div className="flex items-center justify-between gap-4">
                <h2 id="quick-start-title" className="text-lg font-bold text-stone-950 dark:text-stone-100">{t("home.quickStart")}</h2>
                <span className="text-xs text-stone-400">{t("home.quickStartCount", { count: quickStartItems.length })}</span>
            </div>
            <div className="mt-4 space-y-2">
                {quickStartItems.map(({ key, icon: Icon }) => (
                    <button key={key} type="button" onClick={handlers[key]} className="group flex w-full items-center gap-3 rounded-xl bg-[#f3f1ec] px-3 py-3 text-left transition hover:bg-[#f4d8d2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e5543f]/30 dark:bg-stone-800 dark:hover:bg-[#5a2c25]">
                        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white text-[#e5543f] shadow-sm dark:bg-stone-900"><Icon className="size-4" /></span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-stone-800 dark:text-stone-100">{t(`home.quickActions.${key}.title`)}</span>
                            <span className="mt-0.5 block truncate text-xs text-stone-500 dark:text-stone-400">{t(`home.quickActions.${key}.description`)}</span>
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-stone-400 transition group-hover:translate-x-0.5" />
                    </button>
                ))}
            </div>
        </section>
    );
}

function ProjectCard({ project, index, onOpenProject, locale, t }: { project: CanvasProject; index: number; onOpenProject: (id: string) => void; locale: string | undefined; t: (key: string, options?: Record<string, unknown>) => string }) {
    const summary = getProjectNodeSummary(project);
    return (
        <article className="group flex min-h-[260px] flex-col rounded-2xl border border-stone-200 bg-white p-3 transition hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-[0_12px_28px_rgba(28,25,23,0.08)] dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-700">
            <ProjectPreview variant={index === 0 ? "coral" : index === 1 ? "gold" : "ink"} />
            <div className="flex items-start justify-between gap-3 px-1 pt-4">
                <button type="button" onClick={() => onOpenProject(project.id)} className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e5543f]/30">
                    <h3 className="truncate text-sm font-bold text-stone-900 dark:text-stone-100">{project.title}</h3>
                    <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{t("canvas.project.stats", summary)}</p>
                </button>
                <button type="button" className="rounded-md p-1 text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-200" aria-label={t("home.projectMenu", { name: project.title })} title={t("home.projectMenu", { name: project.title })}>
                    <MoreHorizontal className="size-4" />
                </button>
            </div>
            <div className="mt-auto flex items-center justify-between gap-3 px-1 pt-4 text-[11px] text-stone-400">
                <span>{formatDate(project.updatedAt, locale)}</span>
                <button type="button" onClick={() => onOpenProject(project.id)} className="inline-flex items-center gap-1 font-semibold text-[#e5543f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e5543f]/30">
                    {t(index === 0 ? "home.continueEditing" : "home.saved")}
                    <ArrowUpRight className="size-3.5" />
                </button>
            </div>
        </article>
    );
}

function ProjectPreview({ variant }: { variant: "featured" | "coral" | "gold" | "ink" }) {
    const palette = variant === "featured" ? ["#41352e", "#e5543f", "#d8b56d"] : variant === "coral" ? ["#e5543f", "#d8b56d", "#251a18"] : variant === "gold" ? ["#d8b56d", "#ffffff", "#e8e0d4"] : ["#171514", "#e6e9e4", "#ffffff"];
    return (
        <div className={`relative overflow-hidden rounded-xl ${variant === "featured" ? "h-28 bg-[#24201e]" : "h-36 bg-stone-100 dark:bg-stone-800"}`} aria-hidden="true">
            <span className="absolute left-[8%] top-[22%] h-[52%] w-[26%] rounded-md" style={{ background: palette[0] }} />
            <span className="absolute left-[34%] top-[34%] h-[42%] w-[32%] rounded-md" style={{ background: palette[1] }} />
            <span className="absolute right-[8%] top-[24%] h-[50%] w-[22%] rounded-md" style={{ background: palette[2] }} />
            <span className="absolute left-[20%] top-[12%] h-[78%] w-[54%] rounded-[50%] border border-stone-900/20 dark:border-white/20" />
        </div>
    );
}

function formatDate(value: string, locale: string | undefined) {
    return new Date(value).toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
