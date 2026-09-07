import { expect, it } from "vitest";
import { remapBackupReferences, validateBackup } from "./backup-format";
it("remaps storage keys and saved account file URLs without editing unrelated text", () => {
    const source = { storageKey: "image:old", coverUrl: "/api/account/files/image%3Aold?account=previous", nested: ["image:old", { text: "a note about image:old" }] };
    const result = remapBackupReferences(source, new Map([["image:old", "image:new"]]), "alice");
    expect(result).toEqual({ storageKey: "image:new", coverUrl: "/api/account/files/image%3Anew?account=alice", nested: ["image:new", { text: "a note about image:old" }] });
    expect(source.storageKey).toBe("image:old");
});
it("accepts an original v1 backup but rejects duplicated file keys before any upload", () => {
    const source = { app: "infinite-canvas", version: 1, projects: [], assets: [], config: { channels: [] }, files: [] };
    expect(validateBackup(source).version).toBe(1);
    expect(() =>
        validateBackup({
            ...source,
            files: [
                { storageKey: "image:a", path: "files/a.png", mimeType: "image/png" },
                { storageKey: "image:a", path: "files/a2.png", mimeType: "image/png" },
            ],
        }),
    ).toThrow();
    expect(() => validateBackup({ ...source, config: null })).toThrow();
});
