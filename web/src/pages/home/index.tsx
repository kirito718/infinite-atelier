import { useAccountAction } from "@/hooks/use-account-action";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { NewCanvasDialog } from "@/components/home/new-canvas-dialog";
import { PromptLibrarySection } from "@/components/home/prompt-library-section";
import { WorkspaceEntry } from "@/components/home/workspace-entry";
import { useCanvasArchiveImport } from "@/hooks/use-canvas-archive-import";
import { getRecentProjects } from "./workspace-entry-model";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export default function IndexPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const projects = useCanvasStore((state) => state.projects);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useAccountAction(useCanvasStore((state) => state.createProject));
    const { inputRef, openImport, importCanvas } = useCanvasArchiveImport();
    const [newCanvasOpen, setNewCanvasOpen] = useState(false);
    const recentProjects = getRecentProjects(projects);
    const createAndEnter = () => navigate(`/canvas/${createProject(t("canvas.defaultTitle", { count: projects.length + 1 }))}`);
    const scrollToPromptLibrary = () => document.getElementById("prompt-library")?.scrollIntoView({ behavior: "smooth", block: "start" });

    return (
        <>
            <WorkspaceEntry
                hydrated={hydrated}
                recentProjects={recentProjects}
                onOpenNewCanvas={() => setNewCanvasOpen(true)}
                onCreateCanvas={createAndEnter}
                onOpenProject={(id) => navigate(`/canvas/${id}`)}
                onOpenCanvasLibrary={() => navigate("/canvas")}
                onImportReference={openImport}
                onStartFromPrompt={scrollToPromptLibrary}
            />
            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <section id="prompt-library">
                <PromptLibrarySection />
            </section>
            <NewCanvasDialog
                open={newCanvasOpen}
                onClose={() => setNewCanvasOpen(false)}
                onCreateBlank={() => {
                    setNewCanvasOpen(false);
                    createAndEnter();
                }}
                onImportReference={() => {
                    setNewCanvasOpen(false);
                    openImport();
                }}
                onStartFromPrompt={() => {
                    setNewCanvasOpen(false);
                    scrollToPromptLibrary();
                }}
            />
        </>
    );
}
