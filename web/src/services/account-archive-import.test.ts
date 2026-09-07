import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createZip } from "@/lib/zip";
import { readAssetPackage } from "@/pages/assets/asset-transfer";
import { setAccountIdentity } from "./account-client";
import { readCanvasPackage } from "./account-archive-import";

// The ZIP/media code is real; only browser locale initialization is irrelevant here.
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
};

const originalKey = "image:shared";
const originalUrl = "/api/account/files/image%3Ashared?account=old-owner";
const asset = {
    id: "asset-1",
    kind: "image",
    title: "Imported image",
    coverUrl: originalUrl,
    tags: [],
    createdAt: "2026-09-08",
    updatedAt: "2026-09-08",
    data: { storageKey: originalKey, dataUrl: originalUrl, width: 1, height: 1, bytes: 7, mimeType: "image/png" },
};
const fileEntry = { storageKey: originalKey, path: "files/shared.png", mimeType: "image/png", bytes: 7 };
async function assetZip(files = [fileEntry], includeMedia = true) {
    const zip = await createZip([{ name: "assets.json", data: JSON.stringify({ app: "infinite-canvas", version: 1, assets: [asset], files }) }, ...(includeMedia ? [{ name: fileEntry.path, data: "A image" }] : [])]);
    return new File([zip], "assets.zip", { type: "application/zip" });
}

type Upload = { userId: string | null; storageKey: string; body: string; mimeType: string };
let uploads: Upload[];
beforeEach(() => {
    setAccountIdentity("alice");
    uploads = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
        const url = new URL(input, "http://localhost");
        const body = init.body as Blob;
        const storageKey = decodeURIComponent(url.pathname.split("/").at(-1)!);
        const userId = new Headers(init.headers).get("X-Atelier-User");
        uploads.push({ userId, storageKey, body: await body.text(), mimeType: body.type });
        return Response.json({ storageKey, mimeType: body.type, bytes: body.size });
    });
});
afterEach(() => {
    setAccountIdentity(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("account-bound ZIP import", () => {
    it.each(["different account", "same account, new session"])("never uploads an old archive after %s replaces its originating session", async (transition) => {
        const file = await assetZip();
        const bytes = await file.arrayBuffer();
        const reading = deferred<ArrayBuffer>();
        vi.spyOn(file, "arrayBuffer").mockReturnValueOnce(reading.promise);
        const importing = readAssetPackage(file);
        const rejected = expect(importing).rejects.toThrow();
        setAccountIdentity(null);
        setAccountIdentity(transition === "different account" ? "bobby" : "alice");
        reading.resolve(bytes);
        await rejected;
        expect(uploads).toEqual([]);
    });

    it("uploads to fresh keys and remaps both storage keys and account-qualified media URLs", async () => {
        const [imported] = await readAssetPackage(await assetZip());
        expect(uploads).toHaveLength(1);
        expect(uploads[0]).toMatchObject({ userId: "alice", body: "A image", mimeType: "image/png" });
        expect(uploads[0].storageKey).toMatch(/^image:[A-Za-z0-9_-]+$/);
        expect(uploads[0].storageKey).not.toBe(originalKey);
        expect(imported.data).toMatchObject({ storageKey: uploads[0].storageKey });
        const url = new URL(imported.coverUrl, "http://localhost");
        expect(decodeURIComponent(url.pathname.split("/").at(-1)!)).toBe(uploads[0].storageKey);
        expect(url.searchParams.get("account")).toBe("alice");
        expect(imported.data).toMatchObject({ dataUrl: imported.coverUrl });
    });

    it("rejects an incomplete archive before uploading any media", async () => {
        const missing = { storageKey: "video:missing", path: "files/missing.mp4", mimeType: "video/mp4", bytes: 7 };
        await expect(readAssetPackage(await assetZip([fileEntry, missing]))).rejects.toThrow();
        expect(uploads).toEqual([]);
    });
});

async function canvasZip() {
    const project = (id: string) => ({
        id,
        title: id,
        createdAt: "2026-09-08",
        updatedAt: "2026-09-08",
        nodes: [{ id: `node-${id}`, type: "image", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { storageKey: originalKey, content: originalUrl } }],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
    });
    const firstPath = "projects/first/files/shared.png";
    const secondPath = "projects/second/files/shared.png";
    const zip = await createZip([
        {
            name: "projects.json",
            data: JSON.stringify({
                app: "infinite-canvas",
                version: 3,
                projects: [
                    { project: project("first"), files: [{ ...fileEntry, path: firstPath }] },
                    { project: project("second"), files: [{ ...fileEntry, path: secondPath }] },
                ],
            }),
        },
        { name: firstPath, data: "A image" },
        { name: secondPath, data: "A image" },
    ]);
    return new File([zip], "canvases.zip", { type: "application/zip" });
}

describe("canvas ZIP importer", () => {
    it.each(["different account", "same account, new session"])("cancels before uploads after %s replaces the ZIP reader session", async (transition) => {
        const file = await canvasZip();
        const bytes = await file.arrayBuffer();
        const reading = deferred<ArrayBuffer>();
        vi.spyOn(file, "arrayBuffer").mockReturnValueOnce(reading.promise);
        const importing = readCanvasPackage(file);
        const rejected = expect(importing).rejects.toThrow();
        setAccountIdentity(null);
        setAccountIdentity(transition === "different account" ? "bobby" : "alice");
        reading.resolve(bytes);
        await rejected;
        expect(uploads).toEqual([]);
    });

    it("uploads a shared canvas media key once without overwriting it, remapping every project", async () => {
        const projects = await readCanvasPackage(await canvasZip());
        expect(uploads).toHaveLength(1);
        expect(uploads[0].storageKey).not.toBe(originalKey);
        expect(projects).toHaveLength(2);
        for (const project of projects) {
            expect(project.nodes[0].metadata?.storageKey).toBe(uploads[0].storageKey);
            const url = new URL(String(project.nodes[0].metadata?.content), "http://localhost");
            expect(url.searchParams.get("account")).toBe("alice");
            expect(decodeURIComponent(url.pathname.split("/").at(-1)!)).toBe(uploads[0].storageKey);
        }
    });
});

it("invalidates a same-user re-login during an upload before any remaining media can be written", async () => {
    const secondFile = { storageKey: "video:second", path: "files/second.mp4", mimeType: "video/mp4", bytes: 7 };
    const zip = await createZip([
        { name: "assets.json", data: JSON.stringify({ app: "infinite-canvas", version: 1, assets: [asset], files: [fileEntry, secondFile] }) },
        { name: fileEntry.path, data: "A image" },
        { name: secondFile.path, data: "A video" },
    ]);
    const started = deferred<void>();
    const response = deferred<Response>();
    const sent: RequestInit[] = [];
    // Deliberately delay an already-started response without honoring aborts,
    // so only the import's captured signal can prevent its next upload.
    vi.stubGlobal("fetch", async (_input: string, init: RequestInit) => {
        sent.push(init);
        started.resolve();
        return response.promise;
    });
    const importing = readAssetPackage(new File([zip], "two-files.zip"));
    const rejected = expect(importing).rejects.toThrow();
    await started.promise;
    setAccountIdentity(null);
    setAccountIdentity("alice");
    response.resolve(Response.json({ storageKey: "image:returned", mimeType: "image/png", bytes: 7 }));
    await rejected;
    expect(sent).toHaveLength(1);
    expect(new Headers(sent[0].headers).get("X-Atelier-User")).toBe("alice");
});
