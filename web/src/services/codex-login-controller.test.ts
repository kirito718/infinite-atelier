import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAccountIdentity } from "./account-client";
import type { CodexLogin, CodexStatus } from "./codex-image";
import { createCodexLoginController } from "./codex-login-controller";

type Options = { signal?: AbortSignal };
const login: CodexLogin = { type: "chatgptDeviceCode", loginId: "attempt-a", verificationUrl: "https://auth.openai.com/codex/device", userCode: "AAAA-BBBB" };
const nextLogin: CodexLogin = { ...login, loginId: "attempt-b", userCode: "CCCC-DDDD" };
const controllers: Array<ReturnType<typeof createCodexLoginController>> = [];

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function harness() {
    const transport = {
        getStatus: vi.fn<(options?: Options) => Promise<CodexStatus>>().mockResolvedValue("disconnected"),
        beginLogin: vi.fn<(options?: Options) => Promise<CodexLogin>>().mockResolvedValue(login),
        cancelLogin: vi.fn<(loginId: string, options?: Options) => Promise<void>>().mockResolvedValue(undefined),
        logout: vi.fn<(options?: Options) => Promise<void>>().mockResolvedValue(undefined),
    };
    const writeClipboard = vi.fn<(code: string) => Promise<boolean>>().mockResolvedValue(true);
    const controller = createCodexLoginController(transport, writeClipboard);
    controllers.push(controller);
    return { controller, transport, writeClipboard };
}

async function opened() {
    const result = harness();
    result.controller.open();
    await result.controller.refresh();
    return result;
}

beforeEach(() => {
    vi.useFakeTimers();
    setAccountIdentity("alice");
});
afterEach(() => {
    controllers.splice(0).forEach((controller) => controller.close());
    setAccountIdentity(null);
    vi.useRealTimers();
});

describe("Codex device login controller", () => {
    it("checks status on open without starting authorization automatically", async () => {
        const { controller, transport } = await opened();
        expect(controller.getSnapshot()).toMatchObject({ status: "disconnected", login: null, busy: null, error: null });
        expect(transport.getStatus).toHaveBeenCalledTimes(1);
        expect(transport.beginLogin).not.toHaveBeenCalled();
    });

    it("retains the one-time code while polling reports pending authorization", async () => {
        const { controller, transport } = await opened();
        transport.getStatus.mockResolvedValue("connecting");
        await controller.start();
        await vi.advanceTimersByTimeAsync(1500);
        expect(controller.getSnapshot()).toMatchObject({ status: "connecting", login, busy: null, error: null });
    });

    it("does not let a pre-start status response erase a newly issued code", async () => {
        const { controller, transport } = harness();
        const oldStatus = deferred<CodexStatus>();
        transport.getStatus.mockReturnValueOnce(oldStatus.promise);
        controller.open();
        const oldRead = controller.refresh();
        const readSignal = transport.getStatus.mock.calls[0][0]!.signal!;
        await controller.start();
        oldStatus.resolve("disconnected");
        await oldRead;
        expect(readSignal.aborted).toBe(true);
        expect(controller.getSnapshot()).toMatchObject({ status: "connecting", login, busy: null });
    });

    it("deduplicates starts and suspends polls until start has settled", async () => {
        const { controller, transport } = await opened();
        const result = deferred<CodexLogin>();
        transport.beginLogin.mockReturnValueOnce(result.promise);
        const first = controller.start();
        const second = controller.start();
        await controller.refresh();
        await vi.advanceTimersByTimeAsync(6000);
        expect(controller.getSnapshot()).toMatchObject({ busy: "starting", login: null });
        expect(transport.beginLogin).toHaveBeenCalledTimes(1);
        expect(transport.getStatus).toHaveBeenCalledTimes(1);
        result.resolve(login);
        await Promise.all([first, second]);
        expect(controller.getSnapshot()).toMatchObject({ login, busy: null });
    });

    it("never overlaps slow status polls", async () => {
        const { controller, transport } = harness();
        const result = deferred<CodexStatus>();
        transport.getStatus.mockReturnValueOnce(result.promise);
        controller.open();
        const reading = controller.refresh();
        await vi.advanceTimersByTimeAsync(6000);
        expect(transport.getStatus).toHaveBeenCalledTimes(1);
        result.resolve("connecting");
        await reading;
        await vi.advanceTimersByTimeAsync(1500);
        expect(transport.getStatus).toHaveBeenCalledTimes(2);
    });

    it("cancels the displayed login ID without logging out the account", async () => {
        const { controller, transport } = await opened();
        await controller.start();
        await controller.cancel();
        expect(transport.cancelLogin).toHaveBeenCalledWith("attempt-a", { signal: expect.any(AbortSignal) });
        expect(transport.logout).not.toHaveBeenCalled();
        expect(controller.getSnapshot()).toMatchObject({ status: "disconnected", login: null, busy: null, error: null });
    });

    it("does not send a cancellation when this panel has no attempt ID", async () => {
        const { controller, transport } = await opened();
        await controller.cancel();
        expect(transport.cancelLogin).not.toHaveBeenCalled();
    });

    it("invalidates an old poll and blocks starts while cancellation is in flight", async () => {
        const { controller, transport } = await opened();
        await controller.start();
        const oldStatus = deferred<CodexStatus>();
        transport.getStatus.mockReturnValueOnce(oldStatus.promise);
        const reading = controller.refresh();
        const result = deferred<void>();
        transport.cancelLogin.mockReturnValueOnce(result.promise);
        const cancelling = controller.cancel();
        await controller.start();
        oldStatus.resolve("connected");
        await reading;
        await vi.advanceTimersByTimeAsync(6000);
        expect(controller.getSnapshot()).toMatchObject({ status: "connecting", login, busy: "cancelling" });
        expect(transport.beginLogin).toHaveBeenCalledTimes(1);
        expect(transport.getStatus).toHaveBeenCalledTimes(2);
        result.resolve(undefined);
        await cancelling;
        expect(controller.getSnapshot()).toMatchObject({ status: "disconnected", login: null, busy: null });
    });

    it("keeps cancellation failures actionable instead of claiming the attempt was cancelled", async () => {
        const { controller, transport } = await opened();
        await controller.start();
        transport.cancelLogin.mockRejectedValueOnce(new Error("Cancellation unavailable"));
        await controller.cancel();
        expect(controller.getSnapshot()).toMatchObject({ login, busy: null, error: { kind: "cancel", message: "Cancellation unavailable" } });
        await controller.cancel();
        expect(controller.getSnapshot()).toMatchObject({ login: null, error: null });
    });

    it("preserves a useful start error across background polls and allows retry", async () => {
        const { controller, transport } = await opened();
        transport.beginLogin.mockRejectedValueOnce(new Error("Enable device-code login first"));
        await controller.start();
        await vi.advanceTimersByTimeAsync(1500);
        expect(controller.getSnapshot()).toMatchObject({ login: null, busy: null, error: { kind: "start", message: "Enable device-code login first" } });
        await controller.start();
        expect(controller.getSnapshot()).toMatchObject({ status: "connecting", login, error: null });
    });

    it("keeps the code on transient status errors and can explicitly recheck", async () => {
        const { controller, transport } = await opened();
        await controller.start();
        transport.getStatus.mockRejectedValueOnce(new Error("Network offline"));
        await controller.refresh();
        expect(controller.getSnapshot()).toMatchObject({ login, busy: null, error: { kind: "status", message: "Network offline" } });
        transport.getStatus.mockResolvedValueOnce("connecting");
        await controller.refresh();
        expect(controller.getSnapshot()).toMatchObject({ login, error: null });
    });

    it.each([
        ["connected", null],
        ["disconnected", "expired"],
        ["unavailable", "unavailable"],
    ] as const)("removes the code on terminal status %s", async (status, errorKind) => {
        const { controller, transport } = await opened();
        await controller.start();
        transport.getStatus.mockResolvedValueOnce(status);
        await controller.refresh();
        expect(controller.getSnapshot()).toMatchObject({ status, login: null, busy: null });
        expect(controller.getSnapshot().error?.kind ?? null).toBe(errorKind);
    });

    it("reports logout failure without falsely showing a disconnected account", async () => {
        const { controller, transport } = await opened();
        transport.getStatus.mockResolvedValueOnce("connected");
        await controller.refresh();
        transport.logout.mockRejectedValueOnce(new Error("Logout failed"));
        await controller.disconnect();
        expect(controller.getSnapshot()).toMatchObject({ status: "connected", busy: null, error: { kind: "logout", message: "Logout failed" } });
        await controller.disconnect();
        expect(controller.getSnapshot()).toMatchObject({ status: "disconnected", login: null, error: null });
    });

    it("clears memory and aborts local reads on close without cancelling server authorization", async () => {
        const { controller, transport } = await opened();
        await controller.start();
        const read = deferred<CodexStatus>();
        transport.getStatus.mockReturnValueOnce(read.promise);
        const reading = controller.refresh();
        const signal = transport.getStatus.mock.calls.at(-1)![0]!.signal!;
        controller.close();
        expect(signal.aborted).toBe(true);
        expect(controller.getSnapshot().login).toBeNull();
        read.resolve("connected");
        await reading;
        await controller.start();
        await vi.advanceTimersByTimeAsync(6000);
        expect(controller.getSnapshot().status).toBeNull();
        expect(transport.beginLogin).toHaveBeenCalledTimes(1);
        expect(transport.cancelLogin).not.toHaveBeenCalled();
    });

    it("lets a reopened pending panel explicitly retrieve the same code rather than stay busy", async () => {
        const { controller, transport } = await opened();
        await controller.start();
        controller.close();
        transport.getStatus.mockResolvedValue("connecting");
        controller.open();
        await controller.refresh();
        expect(controller.getSnapshot()).toMatchObject({ status: "connecting", login: null, busy: null });
        await controller.start();
        expect(controller.getSnapshot()).toMatchObject({ login, busy: null });
        expect(transport.beginLogin).toHaveBeenCalledTimes(2);
    });

    it("ignores a delayed start from before close/reopen even if transport ignores abort", async () => {
        const { controller, transport } = await opened();
        const oldResult = deferred<CodexLogin>();
        transport.beginLogin.mockReturnValueOnce(oldResult.promise);
        const oldStart = controller.start();
        const oldSignal = transport.beginLogin.mock.calls[0][0]!.signal!;
        controller.close();
        transport.beginLogin.mockResolvedValueOnce(nextLogin);
        controller.open();
        await controller.start();
        oldResult.resolve(login);
        await oldStart;
        expect(oldSignal.aborted).toBe(true);
        expect(controller.getSnapshot()).toMatchObject({ login: nextLogin, busy: null, error: null });
    });

    it.each(["bobby", "alice"])("drops old callbacks and codes after switching to a new %s session", async (nextAccount) => {
        const { controller, transport } = await opened();
        const oldResult = deferred<CodexLogin>();
        transport.beginLogin.mockReturnValueOnce(oldResult.promise);
        const oldStart = controller.start();
        const signal = transport.beginLogin.mock.calls[0][0]!.signal!;
        setAccountIdentity(null);
        setAccountIdentity(nextAccount);
        const next = await opened();
        next.transport.beginLogin.mockResolvedValueOnce(nextLogin);
        await next.controller.start();
        oldResult.resolve(login);
        await oldStart;
        await controller.start();
        controller.open();
        expect(signal.aborted).toBe(true);
        expect(controller.getSnapshot().login).toBeNull();
        expect(transport.beginLogin).toHaveBeenCalledTimes(1);
        expect(next.controller.getSnapshot()).toMatchObject({ login: nextLogin, error: null });
    });

    it.each(["cancel", "disconnect"] as const)("ignores a late %s acknowledgement after reopening", async (action) => {
        const { controller, transport } = await opened();
        await controller.start();
        const result = deferred<void>();
        if (action === "cancel") transport.cancelLogin.mockReturnValueOnce(result.promise);
        else transport.logout.mockReturnValueOnce(result.promise);
        const oldAction = controller[action]();
        controller.close();
        controller.open();
        transport.beginLogin.mockResolvedValueOnce(nextLogin);
        await controller.start();
        result.resolve(undefined);
        await oldAction;
        expect(controller.getSnapshot()).toMatchObject({ login: nextLogin, busy: null, status: "connecting" });
    });

    it("awaits clipboard confirmation while leaving status polling independent", async () => {
        const { controller, transport, writeClipboard } = await opened();
        await controller.start();
        const result = deferred<boolean>();
        writeClipboard.mockReturnValueOnce(result.promise);
        const copying = controller.copyCode();
        expect(writeClipboard).toHaveBeenCalledWith("AAAA-BBBB");
        expect(controller.getSnapshot().copyStatus).toBe("copying");
        transport.getStatus.mockResolvedValueOnce("connecting");
        await controller.refresh();
        result.resolve(true);
        await copying;
        expect(controller.getSnapshot()).toMatchObject({ login, copyStatus: "copied", busy: null });
    });

    it.each([false, new Error("Clipboard permission denied")])("offers manual copying on clipboard failure (%#)", async (result) => {
        const { controller, writeClipboard } = await opened();
        await controller.start();
        if (result instanceof Error) writeClipboard.mockRejectedValueOnce(result);
        else writeClipboard.mockResolvedValueOnce(result);
        await controller.copyCode();
        expect(controller.getSnapshot()).toMatchObject({ login, copyStatus: "failed" });
    });

    it.each(["close", "account", "cancel"] as const)("drops a late clipboard result after %s", async (boundary) => {
        const { controller, writeClipboard } = await opened();
        await controller.start();
        const result = deferred<boolean>();
        writeClipboard.mockReturnValueOnce(result.promise);
        const copying = controller.copyCode();
        if (boundary === "account") setAccountIdentity("bobby");
        else if (boundary === "close") controller.close();
        else await controller.cancel();
        result.resolve(true);
        await copying;
        expect(controller.getSnapshot()).toMatchObject({ login: null, copyStatus: "idle" });
        await controller.copyCode();
        expect(writeClipboard).toHaveBeenCalledTimes(1);
    });

    it("does not roll completed clipboard feedback back to loading when cancellation fails", async () => {
        const { controller, transport, writeClipboard } = await opened();
        await controller.start();
        const clipboard = deferred<boolean>();
        const cancellation = deferred<void>();
        writeClipboard.mockReturnValueOnce(clipboard.promise);
        transport.cancelLogin.mockReturnValueOnce(cancellation.promise);
        const copying = controller.copyCode();
        const cancelling = controller.cancel();
        clipboard.resolve(true);
        await copying;
        cancellation.reject(new Error("Cancellation offline"));
        await cancelling;
        expect(controller.getSnapshot()).toMatchObject({ login, copyStatus: "copied", busy: null, error: { kind: "cancel" } });
    });
});
