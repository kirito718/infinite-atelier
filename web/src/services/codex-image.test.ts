import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { beginCodexLogin, codexImageFileId, createCodexImageTask, getCodexStatus } from "./codex-image";

describe("Codex subscription image client", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("uses the same-origin Codex subscription API for status and login", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ status: "connected", authUrl: "https://chatgpt.com/auth/test" }) } as Response);

        await getCodexStatus();
        await beginCodexLogin();

        expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(["/api/codex-subscription/v1/status", "/api/codex-subscription/v1/login"]);
    });

    it("posts image tasks to the same-origin subscription API", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ taskId: "task-1" }) } as Response);

        await createCodexImageTask({
            prompt: "A copper fox",
            operation: "generate",
            references: [{ id: "reference", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" }],
        });

        expect(fetchMock).toHaveBeenCalledWith("/api/codex-subscription/v1/images", expect.objectContaining({ method: "POST" }));
    });

    it("reads the fileId field returned by the Codex task API", () => {
        expect(codexImageFileId({ fileId: "file-1", mimeType: "image/png" })).toBe("file-1");
    });
});
