import { afterEach, beforeEach, expect, it, vi } from "vitest";

let stop: (() => void) | undefined;
let cleanup: (() => void) | undefined;
beforeEach(() => {
    vi.resetModules();
    const values = new Map<string, string>();
    const local = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { origin: "http://localhost" }, localStorage: local }));
});
afterEach(() => {
    stop?.();
    cleanup?.();
    vi.unstubAllGlobals();
});

it("401 rejects the pending flush, retains only account-scoped recovery, and restores it after reauthentication", async () => {
    const users = { alice: { id: "alice", username: "alice", displayName: "Alice", avatarUrl: "" }, bobby: { id: "bobby", username: "bobby", displayName: "Bob", avatarUrl: "" } };
    let session: typeof users.alice | null = null;
    let expire = true;
    const saved = new Map<string, string>();
    vi.stubGlobal("fetch", async (path: string, options: RequestInit = {}) => {
        if (path === "/api/account/login") {
            session = users[JSON.parse(options.body as string).username as keyof typeof users];
            return Response.json({ user: session });
        }
        if (path === "/api/account/session") return Response.json({ user: session, registrationAllowed: true });
        if (path === "/api/account/logout") {
            session = null;
            return new Response(null, { status: 204 });
        }
        if (path === "/api/account/state") return Response.json({ entries: [] });
        if (options.method === "PUT") {
            if (expire) {
                session = null;
                return Response.json({ code: "UNAUTHENTICATED", error: "expired" }, { status: 401 });
            }
            const body = JSON.parse(options.body as string);
            saved.set(new Headers(options.headers).get("X-Atelier-User")!, body.value);
            return Response.json({ revision: body.expectedRevision + 1 });
        }
        throw new Error("Unexpected " + path);
    });
    const { useUserStore, listenForAccountChanges } = await import("@/stores/use-user-store");
    const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
    const storage = await import("./server-storage");
    stop = listenForAccountChanges();
    cleanup = storage.clearServerStorage;
    await useUserStore.getState().signIn({ username: "alice", password: "long password for tests" });
    useCanvasStore.getState().createProject("unsaved Alice canvas");
    expect(storage.getSyncSnapshot().pending).toBe(1);
    await expect(storage.flushServerChanges()).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    await vi.waitFor(() => expect(useUserStore.getState().status).toBe("anonymous"));
    expect(useCanvasStore.getState().projects).toHaveLength(0);
    expect(storage.hasRecoverableDrafts()).toBe(true);
    expire = false;
    await useUserStore.getState().signIn({ username: "bobby", password: "long password for tests" });
    expect(useCanvasStore.getState().projects).toHaveLength(0);
    expect(saved.has("bobby")).toBe(false);
    await useUserStore.getState().signOut();
    await useUserStore.getState().signIn({ username: "alice", password: "long password for tests" });
    expect(useCanvasStore.getState().projects.map((p) => p.title)).toEqual(["unsaved Alice canvas"]);
    await storage.flushServerChanges();
    expect(JSON.parse(saved.get("alice")!).state.projects[0].title).toBe("unsaved Alice canvas");
    expect(saved.has("bobby")).toBe(false);
});
