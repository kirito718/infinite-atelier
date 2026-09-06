import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => values.get(key) || null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        },
    });
});

import { routeImageGeneration } from "./image-generation-router";

const reference = { id: "reference", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" };

describe("image generation routing", () => {
    it("uses Codex for a selected Codex image model", async () => {
        const codex = vi.fn().mockResolvedValue({ dataUrl: "data:image/png;base64,AA==" });
        const provider = vi.fn();
        await routeImageGeneration({ model: "codex-subscription::gpt-image-2", prompt: "studio product photo", references: [], codex, provider });
        expect(codex).toHaveBeenCalledWith(expect.objectContaining({ prompt: "studio product photo", operation: "generate" }));
        expect(provider).not.toHaveBeenCalled();
    });

    it("uses edit mode for Codex references", async () => {
        const codex = vi.fn().mockResolvedValue({ dataUrl: "data:image/png;base64,AA==" });
        await routeImageGeneration({ model: "codex-subscription::gpt-image-2", prompt: "edit this", references: [reference], codex, provider: vi.fn() });
        expect(codex).toHaveBeenCalledWith(expect.objectContaining({ operation: "edit", references: [reference] }));
    });

    it("uses the existing provider for a normal image model", async () => {
        const codex = vi.fn();
        const provider = vi.fn().mockResolvedValue({ dataUrl: "data:image/png;base64,AA==" });
        await routeImageGeneration({ model: "default::gpt-image-2", prompt: "studio product photo", references: [], codex, provider });
        expect(provider).toHaveBeenCalled();
        expect(codex).not.toHaveBeenCalled();
    });
});
