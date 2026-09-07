import { afterEach, expect, it, vi } from "vitest";
import { setAccountIdentity } from "./account-client";
import { getServerFileUrl, putServerFile, getServerFileBlob } from "./server-files";

afterEach(() => {
    setAccountIdentity(null);
    vi.unstubAllGlobals();
});
it("pins persistent media URLs and uploads to the current account, not browser blob URLs", async () => {
    setAccountIdentity("alice");
    expect(getServerFileUrl("image:test")).toBe("/api/account/files/image%3Atest?account=alice");
    let sent: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        sent = init;
        return new Response(JSON.stringify({ storageKey: "image:test", mimeType: "image/png", bytes: 3 }));
    });
    const result = await putServerFile("image:test", new Blob(["png"], { type: "image/png" }));
    expect(result.bytes).toBe(3);
    expect(new Headers(sent?.headers).get("X-Atelier-User")).toBe("alice");
    expect(new Headers(sent?.headers).get("X-Atelier-Request")).toBe("1");
});
it("treats missing server media as missing and does not silently read another browser database", async () => {
    setAccountIdentity("alice");
    vi.stubGlobal("fetch", async () => new Response('{"error":"missing","code":"FILE_NOT_FOUND"}', { status: 404 }));
    expect(await getServerFileBlob("image:missing")).toBeNull();
});
it("rejects a completed old-account upload after the browser changes identity", async () => {
    setAccountIdentity("alice");
    let finish!: (response: Response) => void;
    vi.stubGlobal(
        "fetch",
        () =>
            new Promise<Response>((resolve) => {
                finish = resolve;
            }),
    );
    const upload = putServerFile("image:test", new Blob(["png"], { type: "image/png" }));
    setAccountIdentity("bobby");
    finish(new Response('{"storageKey":"image:test","mimeType":"image/png","bytes":3}'));
    await expect(upload).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
});
