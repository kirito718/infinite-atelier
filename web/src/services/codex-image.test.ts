import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    for (const name of ["localStorage", "sessionStorage"]) {
        const values = new Map<string, string>();
        Object.defineProperty(globalThis, name, {
            configurable: true,
            value: {
                getItem: (key: string) => values.get(key) || null,
                setItem: (key: string, value: string) => values.set(key, value),
                removeItem: (key: string) => values.delete(key),
            },
        });
    }
});

import { beginCodexLogin, cancelCodexLogin, codexImageFileId, createCodexImageTask, getCodexStatus } from "./codex-image";

const deviceLogin = {
    type: "chatgptDeviceCode",
    loginId: "login-1",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Codex subscription image client", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("uses the protected same-origin API for status and a bodyless device-code login", async () => {
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(json({ status: "connected" }))
            .mockResolvedValueOnce(json(deviceLogin));

        expect(await getCodexStatus()).toBe("connected");
        expect(await beginCodexLogin()).toEqual(deviceLogin);

        expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(["/api/codex-subscription/v1/status", "/api/codex-subscription/v1/login"]);
        const loginRequest = fetchMock.mock.calls[1][1]!;
        expect(loginRequest).toMatchObject({ method: "POST", credentials: "same-origin" });
        expect(loginRequest.body).toBeUndefined();
        expect(new Headers(loginRequest.headers).get("X-Atelier-Request")).toBe("1");
    });

    it("accepts an official trailing slash and canonicalizes the displayed link", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ ...deviceLogin, verificationUrl: "https://auth.openai.com/codex/device/" }));
        expect(await beginCodexLogin()).toEqual(deviceLogin);
    });

    it("returns only verification information, without an OAuth URL or persisted browser credentials", async () => {
        const localWrite = vi.spyOn(localStorage, "setItem");
        const sessionWrite = vi.spyOn(sessionStorage, "setItem");
        vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ ...deviceLogin, authUrl: "http://localhost:1455/auth/callback", accessToken: "must-not-be-exposed" }));

        expect(await beginCodexLogin()).toEqual(deviceLogin);
        expect(localWrite).not.toHaveBeenCalled();
        expect(sessionWrite).not.toHaveBeenCalled();
    });

    it.each([
        "http://auth.openai.com/codex/device",
        "http://localhost:1455/auth/callback",
        "https://localhost/codex/device",
        "javascript:alert(1)",
        "https://auth.openai.com.evil.test/codex/device",
        "https://auth.openai.com@evil.test/codex/device",
        "https://evil.test/codex/device",
        "https://auth.openai.com/codex/device?user_code=ABCD-EFGH",
        "https://auth.openai.com/codex/device#ABCD-EFGH",
        "https://auth.openai.com/other",
        "//auth.openai.com/codex/device",
    ])("rejects a non-canonical verification URL: %s", async (verificationUrl) => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ ...deviceLogin, verificationUrl }));
        await expect(beginCodexLogin()).rejects.toThrow(/official OpenAI device authorization URL/i);
    });

    it.each([
        null,
        [],
        { authUrl: "http://localhost:1455/auth/callback" },
        { ...deviceLogin, type: "chatgpt" },
        { ...deviceLogin, loginId: "" },
        { ...deviceLogin, loginId: " " },
        { ...deviceLogin, loginId: "x".repeat(201) },
        { ...deviceLogin, userCode: undefined },
        { ...deviceLogin, userCode: 1234 },
        { ...deviceLogin, userCode: "" },
        { ...deviceLogin, userCode: "\t" },
        { ...deviceLogin, userCode: "ABCD\nEFGH" },
        { ...deviceLogin, userCode: "x".repeat(129) },
    ])("rejects incomplete or malformed device-code responses (%#)", async (body) => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(json(body));
        await expect(beginCodexLogin()).rejects.toThrow(/invalid Codex device-code login response/i);
    });

    it("gives a useful error when login returns non-JSON", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>Not the login API</html>"));
        await expect(beginCodexLogin()).rejects.toThrow(/invalid Codex device-code login response/i);
    });

    it("surfaces device-code opt-in and server failures instead of replacing them with unavailable", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "Enable device-code login in ChatGPT security settings" }, 403));
        await expect(beginCodexLogin()).rejects.toThrow("Enable device-code login in ChatGPT security settings");
    });

    it("forwards the start signal through authenticatedFetch", async () => {
        const controller = new AbortController();
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(deviceLogin));
        await beginCodexLogin({ signal: controller.signal });
        const signal = fetchMock.mock.calls[0][1]!.signal!;
        controller.abort();
        expect(signal.aborted).toBe(true);
    });

    it("cancels only the specified attempt using protected JSON and the caller signal", async () => {
        const controller = new AbortController();
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

        await expect(cancelCodexLogin("login-1", { signal: controller.signal })).resolves.toBeUndefined();

        expect(fetchMock.mock.calls[0][0]).toBe("/api/codex-subscription/v1/login/cancel");
        const request = fetchMock.mock.calls[0][1]!;
        expect(request).toMatchObject({ method: "POST", credentials: "same-origin", body: '{"loginId":"login-1"}' });
        expect(new Headers(request.headers).get("content-type")).toBe("application/json");
        expect(new Headers(request.headers).get("X-Atelier-Request")).toBe("1");
        controller.abort();
        expect(request.signal!.aborted).toBe(true);
    });

    it("surfaces cancellation errors", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "Could not cancel this attempt" }, 503));
        await expect(cancelCodexLogin("login-1")).rejects.toThrow("Could not cancel this attempt");
    });

    it.each(["unknown", undefined, 123])("rejects an invalid status rather than silently reporting unavailable: %s", async (status) => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ status }));
        await expect(getCodexStatus()).rejects.toThrow(/invalid Codex status response/i);
    });

    it("posts image tasks to the same-origin subscription API", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ taskId: "task-1" }));
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
