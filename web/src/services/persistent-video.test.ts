import { expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => {
    Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, configurable: true });
    return { upload: vi.fn() };
});
vi.mock("@/services/file-storage", () => ({ uploadMediaFile: boundary.upload }));
import { storeGeneratedVideo } from "./api/video";
it("does not report a temporary provider URL as persisted when the server upload failed", async () => {
    boundary.upload.mockRejectedValue(new Error("storage unavailable"));
    await expect(storeGeneratedVideo({ url: "https://provider.test/temporary.mp4" })).rejects.toThrow("storage unavailable");
});
