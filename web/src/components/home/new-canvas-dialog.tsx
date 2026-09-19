import { FilePlus2, FolderOpen, Sparkles } from "lucide-react";
import { Modal } from "antd";
import { useTranslation } from "react-i18next";

type NewCanvasDialogProps = {
    open: boolean;
    onClose: () => void;
    onCreateBlank: () => void;
    onImportReference: () => void;
    onStartFromPrompt: () => void;
};

const options = [
    { key: "blank", icon: FilePlus2 },
    { key: "import", icon: FolderOpen },
    { key: "prompt", icon: Sparkles },
] as const;

export function NewCanvasDialog({ open, onClose, onCreateBlank, onImportReference, onStartFromPrompt }: NewCanvasDialogProps) {
    const { t } = useTranslation();
    const handlers = { blank: onCreateBlank, import: onImportReference, prompt: onStartFromPrompt };

    return (
        <Modal
            open={open}
            centered
            width={680}
            footer={null}
            destroyOnHidden
            onCancel={onClose}
            title={
                <div>
                    <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#e5543f]">{t("home.newCanvasDialog.eyebrow")}</div>
                    <div className="mt-2 text-xl font-bold">{t("home.newCanvasDialog.title")}</div>
                </div>
            }
        >
            <p className="mb-5 text-sm leading-6 text-stone-500">{t("home.newCanvasDialog.description")}</p>
            <div className="space-y-2">
                {options.map(({ key, icon: Icon }, index) => (
                    <button
                        key={key}
                        type="button"
                        onClick={handlers[key]}
                        className={`group flex w-full items-center gap-4 rounded-xl border px-4 py-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e5543f]/30 ${index === 0 ? "border-[#e5543f]/50 bg-[#f4d8d2] hover:border-[#e5543f] dark:bg-[#5a2c25]" : "border-stone-200 bg-[#f3f1ec] hover:border-stone-300 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-700"}`}
                    >
                        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white text-[#e5543f] shadow-sm dark:bg-stone-950"><Icon className="size-5" /></span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-bold text-stone-900 dark:text-stone-100">{t(`home.newCanvasDialog.options.${key}.title`)}</span>
                            <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">{t(`home.newCanvasDialog.options.${key}.description`)}</span>
                        </span>
                        <span className="text-xs font-semibold text-stone-400 transition group-hover:translate-x-0.5">↗</span>
                    </button>
                ))}
            </div>
            <p className="mt-5 text-xs text-stone-400">{t("home.newCanvasDialog.footer")}</p>
        </Modal>
    );
}
