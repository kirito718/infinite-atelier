import { useRef } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { readCanvasPackage } from "@/services/account-archive-import";
import { useAccountAction } from "@/hooks/use-account-action";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export function useCanvasArchiveImport() {
    const inputRef = useRef<HTMLInputElement>(null);
    const { message } = App.useApp();
    const { t } = useTranslation();
    const importProject = useAccountAction(useCanvasStore((state) => state.importProject));

    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const importedProjects = await readCanvasPackage(file);
            importedProjects.forEach((project) => importProject(project));
            message.success(t("canvas.imported", { count: importedProjects.length }));
        } catch {
            message.error(t("canvas.importFailed"));
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    return {
        inputRef,
        openImport: () => inputRef.current?.click(),
        importCanvas,
    };
}
