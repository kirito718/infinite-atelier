import { afterEach, describe, expect, it, vi } from "vitest";
import axios from "axios";

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

import { requestEdit } from "./image";
import type { AiConfig } from "@/stores/use-config-store";

const reference = { id: "reference", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" };
const grokConfig = {
    model: "grok-imagine-image-2.0",
    baseUrl: "https://api.x.ai/v1",
    apiKey: "xai-test-key",
    apiFormat: "openai",
    channels: [{ id: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1", apiKey: "xai-test-key", apiFormat: "openai", models: [{ name: "grok-imagine-image-2.0", capability: "image" }] }],
    quality: "auto",
    size: "1:1",
    background: "",
    count: "1",
    systemPrompt: "",
} as AiConfig;

afterEach(() => vi.restoreAllMocks());

describe("image editing request formats", () => {
    it("sends Grok Imagine edits as JSON with an image URL", async () => {
        const post = vi.spyOn(axios, "post").mockResolvedValue({ data: { data: [{ url: "https://example.test/generated.png" }] } } as never);

        await requestEdit(grokConfig, "换一个样子", [reference]);

        const [url, body, options] = post.mock.calls[0] as [string, Record<string, unknown>, { headers?: Record<string, string> }];
        expect(decodeURIComponent(url)).toContain("/v1/images/edits");
        expect(options.headers).toMatchObject({ "Content-Type": "application/json", Authorization: "Bearer xai-test-key" });
        expect(body).toEqual(
            expect.objectContaining({
                model: "grok-imagine-image-2.0",
                image: { type: "image_url", url: reference.dataUrl },
            }),
        );
        expect(body).not.toBeInstanceOf(FormData);
    });
});
