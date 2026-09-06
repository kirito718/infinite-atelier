import { isCodexSubscriptionModel } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type ImageGenerationRouteParams = {
    model: string;
    prompt: string;
    references: ReferenceImage[];
    signal?: AbortSignal;
    codex: (params: { prompt: string; operation: "generate" | "edit"; references: ReferenceImage[]; signal?: AbortSignal }) => Promise<{ dataUrl: string }>;
    provider: (params: { prompt: string; references: ReferenceImage[]; signal?: AbortSignal }) => Promise<{ dataUrl: string }>;
};

export function routeImageGeneration({ model, prompt, references, signal, codex, provider }: ImageGenerationRouteParams) {
    if (isCodexSubscriptionModel(model)) {
        return codex({ prompt, operation: references.length ? "edit" : "generate", references, signal });
    }
    return provider({ prompt, references, signal });
}
