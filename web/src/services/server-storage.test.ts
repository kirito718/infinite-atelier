import { describe, expect, it } from "vitest";
import { createSaveQueue } from "./save-queue";

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};

describe("account-scoped save queue", () => {
    it("does not save hydration defaults until activation", async () => {
        const writes: string[] = [];
        const queue = createSaveQueue({
            write: async (_user, _key, value) => {
                writes.push(value!);
                return { revision: 1 };
            },
            debounceMs: 100000,
        });
        queue.start("alice", [{ key: "canvas", value: '{"saved":true}', revision: 3 }]);
        queue.setItem("canvas", "{}");
        await queue.flush();
        expect(writes).toEqual([]);
        expect(queue.getItem("canvas")).toBe('{"saved":true}');
        queue.clear();
    });
    it("serializes updates made while a save is in flight with the acknowledged revision", async () => {
        const first = deferred<{ revision: number }>();
        const writes: Array<[string, string | null, number]> = [];
        const queue = createSaveQueue({
            write: async (user, _key, value, revision) => {
                writes.push([user, value, revision]);
                return writes.length === 1 ? first.promise : { revision: 2 };
            },
            debounceMs: 100000,
        });
        queue.start("alice", []);
        queue.activate();
        queue.setItem("canvas", "first");
        const saved = queue.flush();
        queue.setItem("canvas", "second");
        first.resolve({ revision: 1 });
        await saved;
        expect(writes).toEqual([
            ["alice", "first", 0],
            ["alice", "second", 1],
        ]);
        expect(queue.getSnapshot().pending).toBe(0);
        queue.clear();
    });
    it("keeps failed data pending and retries without pretending it was saved", async () => {
        let available = false;
        const saved: Array<string | null> = [];
        const queue = createSaveQueue({
            write: async (_user, _key, value) => {
                if (!available) throw new Error("offline");
                saved.push(value);
                return { revision: 1 };
            },
            debounceMs: 100000,
        });
        queue.start("alice", []);
        queue.activate();
        queue.setItem("canvas", "draft");
        await expect(queue.flush()).rejects.toThrow("offline");
        expect(queue.getSnapshot().pending).toBe(1);
        expect(queue.getSnapshot().error).toBe("offline");
        available = true;
        await queue.retry();
        expect(saved).toEqual(["draft"]);
        expect(queue.getSnapshot().error).toBeNull();
        queue.clear();
    });
    it("does not auto-overwrite a concurrent update after a 409 conflict", async () => {
        let calls = 0;
        const queue = createSaveQueue({
            write: async () => {
                calls++;
                throw Object.assign(new Error("newer state"), { code: "CONFLICT" });
            },
            debounceMs: 100000,
        });
        queue.start("alice", []);
        queue.activate();
        queue.setItem("canvas", "draft");
        await expect(queue.flush()).rejects.toThrow("newer state");
        await expect(queue.retry()).rejects.toThrow("newer state");
        expect(queue.getSnapshot().conflict).toBe(true);
        expect(calls).toBe(1);
        queue.clear();
    });
    it("late responses from the previous account cannot change the next account revision or pending state", async () => {
        const old = deferred<{ revision: number }>();
        const writes: string[] = [];
        const queue = createSaveQueue({
            write: async (user) => {
                writes.push(user);
                return user === "alice" ? old.promise : { revision: 8 };
            },
            debounceMs: 100000,
        });
        queue.start("alice", []);
        queue.activate();
        queue.setItem("canvas", "A");
        const previous = queue.flush();
        queue.start("bobby", [{ key: "canvas", value: "server B", revision: 7 }]);
        queue.activate();
        queue.setItem("canvas", "B");
        old.resolve({ revision: 1 });
        await expect(previous).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
        await queue.flush();
        expect(writes).toEqual(["alice", "bobby"]);
        expect(queue.getItem("canvas")).toBe("B");
        expect(queue.getSnapshot().pending).toBe(0);
        queue.clear();
    });
});

it("restored recovery drafts do not overwrite a server version edited during reauthentication", async () => {
    const writes: string[] = [];
    const queue = createSaveQueue({
        write: async (_user, _key, value) => {
            writes.push(value!);
            return { revision: 3 };
        },
        debounceMs: 100000,
    });
    queue.start("alice", [{ key: "canvas", value: "newer server copy", revision: 2 }]);
    queue.restoreDrafts([{ key: "canvas", value: "old unsaved draft", revision: 1 }]);
    queue.activate();
    expect(queue.getItem("canvas")).toBe("old unsaved draft");
    await expect(queue.flush()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(writes).toEqual([]);
    const recovery = queue.getDrafts();
    queue.start("alice", [{ key: "canvas", value: "newer server copy", revision: 2 }]);
    queue.restoreDrafts(recovery);
    queue.activate();
    await expect(queue.flush()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(writes).toEqual([]);
    queue.clear();
});
