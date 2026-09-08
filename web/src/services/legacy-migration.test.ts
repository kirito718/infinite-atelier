import "fake-indexeddb/auto";
import localforage from "localforage";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setAccountIdentity } from "./account-client";
import { inspectLegacyData, migrateLegacyData, isLegacyImported } from "./legacy-migration";

const state = localforage.createInstance({ name: "infinite-canvas", storeName: "app_state" });
const images = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const media = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const canvasKey = "infinite-canvas:canvas_store";
const legacyCanvas = JSON.stringify({ state: { projects: [{ id: "old-canvas", nodes: [{ metadata: { storageKey: "image:old" } }] }] }, version: 0 });
let browser: Storage;

beforeEach(async () => {
    const values = new Map<string, string>();
    browser = {
        get length() {
            return values.size;
        },
        key: (index) => [...values.keys()][index] || null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
            values.set(key, String(value));
        },
        removeItem: (key) => {
            values.delete(key);
        },
        clear: () => {
            values.clear();
        },
    };
    vi.stubGlobal("localStorage", browser);
    await Promise.all([state.clear(), images.clear(), media.clear()]);
    setAccountIdentity("alice");
});
afterEach(() => {
    setAccountIdentity(null);
    vi.unstubAllGlobals();
});

it("discovers all legacy stores and director fallback without mutating the source", async () => {
    await state.setItem(canvasKey, legacyCanvas);
    await images.setItem("image:old", new Blob(["old"], { type: "image/png" }));
    browser.setItem("infinite-canvas:ai_config_store", '{"state":{"config":{"apiKey":"sk-legacy"}},"version":0}');
    browser.setItem("stageframe-project", '{"objects":[]}');
    const summary = await inspectLegacyData();
    expect(summary.projects).toBe(1);
    expect(summary.files).toBe(1);
    expect(summary.hasData).toBe(true);
    expect(summary.director).toBe(1);
    expect(await state.getItem(canvasKey)).toBe(legacyCanvas);
    expect(browser.getItem("monoform-project")).toBeNull();
    expect(browser.getItem("stageframe-project")).toBe('{"objects":[]}');
});
it("uploads media before the atomic document commit and marks success only afterwards", async () => {
    await state.setItem(canvasKey, legacyCanvas);
    await images.setItem("image:old", new Blob(["old"], { type: "image/png" }));
    let failCommit = true;
    const sequence: string[] = [];
    vi.stubGlobal("fetch", async (path: string, options: RequestInit = {}) => {
        if (path.startsWith("/api/account/import/") && options.method !== "POST") return Response.json({ imported: false, canImport: true });
        if (path === "/api/account/files") return Response.json({ files: [] });
        if (options.method === "PUT") {
            sequence.push("file");
            return Response.json({ storageKey: "image:old", mimeType: "image/png", bytes: 3 });
        }
        if (path === "/api/account/import") {
            sequence.push("commit");
            expect(isLegacyImported("alice")).toBe(false);
            const payload = JSON.parse(options.body as string);
            expect(payload.entries.find((entry: { key: string }) => entry.key === canvasKey).value).toBe(legacyCanvas);
            return failCommit ? Response.json({ code: "TEMPORARY", error: "temporary failure" }, { status: 503 }) : Response.json({ imported: true });
        }
        throw new Error("unexpected request " + path);
    });
    await expect(migrateLegacyData("alice")).rejects.toThrow("temporary failure");
    expect(isLegacyImported("alice")).toBe(false);
    expect(await state.getItem(canvasKey)).toBe(legacyCanvas);
    failCommit = false;
    await migrateLegacyData("alice");
    expect(sequence).toEqual(["file", "commit", "file", "commit"]);
    expect(isLegacyImported("alice")).toBe(true);
    expect(await (await images.getItem<Blob>("image:old"))!.text()).toBe("old");
});
it("does not upload or replace anything when the target account is nonempty", async () => {
    await state.setItem(canvasKey, legacyCanvas);
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
        calls++;
        return Response.json({ imported: false, canImport: false });
    });
    await expect(migrateLegacyData("alice")).rejects.toThrow("已有数据");
    expect(calls).toBe(1);
    expect(isLegacyImported("alice")).toBe(false);
});
it("rejects malformed legacy content instead of replacing it with empty state", async () => {
    await state.setItem(canvasKey, "{bad json");
    await expect(inspectLegacyData()).rejects.toThrow("旧数据");
    expect(await state.getItem(canvasKey)).toBe("{bad json");
});
