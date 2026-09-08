import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { DirectorPanel } from "./director-panel";
import { createDirectorCloseGuard } from "./director-close-guard";

const fixture = vi.hoisted(() => ({ flush: vi.fn(), modals: [] as Array<{ open?: boolean; onCancel?: () => unknown; children?: unknown }> }));
vi.mock("@/services/embedded-editors", () => ({ flushEmbeddedEditors: fixture.flush }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("antd", () => ({
    Modal: (props: { children?: ReactNode }) => {
        fixture.modals.push(props);
        return <div>{props.children}</div>;
    },
    Alert: () => null,
    Input: ({ value }: { value?: string }) => <input value={value} readOnly />,
    Button: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
}));
const deferred = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
function mountPanel(onClose: () => void) {
    renderToStaticMarkup(<DirectorPanel nodeId="director-1" open onClose={onClose} onExport={() => {}} onGenerateComfy={() => {}} onGenerationCancel={() => {}} prompt="" onPromptChange={() => {}} />);
    return fixture.modals.find((modal) => modal.open)!;
}
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
    vi.stubGlobal("window", { location: { href: "http://localhost:3000/canvas" } });
    fixture.flush.mockReset();
    fixture.modals.length = 0;
});

describe("director modal close boundary", () => {
    it("does not unmount the iframe until its flush acknowledgement succeeds", async () => {
        const saving = deferred();
        fixture.flush.mockReturnValue(saving.promise);
        const closed = vi.fn();
        const modal = mountPanel(closed);
        const closing = modal.onCancel!();
        expect(closed).not.toHaveBeenCalled();
        saving.resolve();
        await closing;
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it("keeps the editor mounted when saving fails", async () => {
        fixture.flush.mockImplementation(async () => {
            throw new Error("offline");
        });
        const closed = vi.fn();
        const modal = mountPanel(closed);
        await modal.onCancel!();
        expect(closed).not.toHaveBeenCalled();
    });
});

describe("director close/discard state machine", () => {
    it("coalesces repeated close requests and does not permit discarding during a save", async () => {
        const saving = deferred();
        const closed = vi.fn();
        const flush = vi.fn(() => saving.promise);
        const guard = createDirectorCloseGuard(flush, closed);
        const first = guard.requestClose();
        const second = guard.requestClose();
        expect(first).toBe(second);
        guard.requestDiscard();
        guard.confirmDiscard();
        expect(guard.getSnapshot()).toMatchObject({ saving: true, confirmingDiscard: false });
        expect(closed).not.toHaveBeenCalled();
        saving.resolve();
        await first;
        expect(flush).toHaveBeenCalledTimes(1);
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it("requires an explicit confirmation after a failure; cancelling confirmation leaves the editor open", async () => {
        const closed = vi.fn();
        const guard = createDirectorCloseGuard(async () => {
            throw new Error("offline");
        }, closed);
        await guard.requestClose();
        expect(guard.getSnapshot()).toMatchObject({ saving: false, error: "offline" });
        guard.confirmDiscard();
        expect(closed).not.toHaveBeenCalled();
        guard.requestDiscard();
        expect(guard.getSnapshot().confirmingDiscard).toBe(true);
        expect(closed).not.toHaveBeenCalled();
        guard.cancelDiscard();
        guard.confirmDiscard();
        expect(closed).not.toHaveBeenCalled();
        guard.requestDiscard();
        guard.confirmDiscard();
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it("can retry a failed save without discarding the editor", async () => {
        const closed = vi.fn();
        const flush = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
        const guard = createDirectorCloseGuard(flush, closed);
        expect(await guard.requestClose()).toBe(false);
        expect(closed).not.toHaveBeenCalled();
        expect(await guard.requestClose()).toBe(true);
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it("ignores a late acknowledgement after cleanup and still works after a StrictMode remount", async () => {
        const saving = deferred();
        const closed = vi.fn();
        const flush = vi.fn().mockReturnValueOnce(saving.promise).mockResolvedValueOnce(undefined);
        const guard = createDirectorCloseGuard(flush, closed);
        const closing = guard.requestClose();
        await Promise.resolve();
        guard.cancelPending();
        saving.resolve();
        expect(await closing).toBe(false);
        expect(closed).not.toHaveBeenCalled();
        expect(await guard.requestClose()).toBe(true);
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it("does not dispatch a queued flush after the panel was already unmounted", async () => {
        const closed = vi.fn();
        const flush = vi.fn(async () => {});
        const guard = createDirectorCloseGuard(flush, closed);
        const closing = guard.requestClose();
        guard.cancelPending();
        expect(await closing).toBe(false);
        expect(flush).not.toHaveBeenCalled();
        expect(closed).not.toHaveBeenCalled();
    });
});
