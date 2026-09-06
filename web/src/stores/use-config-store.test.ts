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

import { defaultConfig, isAiConfigReady, isCodexSubscriptionModel, modelCapabilityOf, selectableModelsByCapability } from "./use-config-store";

describe("Codex subscription channel", () => {
    it("recognizes the built-in image model", () => {
        expect(modelCapabilityOf(defaultConfig, "codex-subscription::gpt-image-2")).toBe("image");
        expect(isCodexSubscriptionModel("codex-subscription::gpt-image-2")).toBe(true);
    });

    it("keeps the Codex model out of video selections", () => {
        expect(selectableModelsByCapability(defaultConfig, "video")).not.toContain("codex-subscription::gpt-image-2");
    });

    it("does not require an API key for Codex image generation", () => {
        expect(isAiConfigReady(defaultConfig, "codex-subscription::gpt-image-2")).toBe(true);
    });
});
