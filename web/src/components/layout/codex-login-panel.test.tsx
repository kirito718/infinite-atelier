import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
});

import enUS from "@/i18n/locales/en-US";
import zhCN from "@/i18n/locales/zh-CN";
import type { CodexLoginState } from "@/services/codex-login-controller";
import { CodexLoginPanelContent } from "./codex-login-panel";

const pending: CodexLoginState = {
    status: "connecting",
    login: { type: "chatgptDeviceCode", loginId: "attempt-1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" },
    busy: null,
    copyStatus: "idle",
    error: null,
};

function markup(state: CodexLoginState, language = "en-US") {
    const i18n = createInstance();
    void i18n.init({ resources: { "en-US": { translation: enUS }, "zh-CN": { translation: zhCN } }, lng: language, initAsync: false, interpolation: { escapeValue: false } });
    return renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
            <CodexLoginPanelContent state={state} onCopy={vi.fn()} onStart={vi.fn()} onCancel={vi.fn()} onRefresh={vi.fn()} onDisconnect={vi.fn()} />
        </I18nextProvider>,
    );
}

describe("Codex device-code login panel", () => {
    it("shows a selectable code and an explicit, isolated official link without putting the code in its URL", () => {
        const html = markup(pending);
        expect(html).toMatch(/<input[^>]+readonly=""[^>]+value="ABCD-EFGH"/i);
        expect(html).toContain('aria-label="One-time device code"');
        expect(html).toContain("Copy code");
        expect(html).toContain('href="https://auth.openai.com/codex/device"');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
        expect(html).toContain("Open OpenAI authorization page");
        expect(html.match(/href="[^"]*"/g)).toEqual(['href="https://auth.openai.com/codex/device"']);
        expect(html).toContain("Waiting for authorization");
        expect(html).toContain("Cancel authorization");
        expect(html).not.toContain("ant-btn-loading");
    });

    it.each([
        ["en-US", "ChatGPT Security settings", "workspace administrator"],
        ["zh-CN", "ChatGPT 安全设置", "工作区管理员"],
    ])("explains the required device-code opt-in in %s", (language, security, admin) => {
        const html = markup(pending, language);
        expect(html).toContain(security);
        expect(html).toContain(admin);
        expect(html).not.toMatch(/config\.codex\./);
    });

    it("offers a usable code-recovery action when reopened with a pending server attempt", () => {
        const html = markup({ ...pending, login: null });
        expect(html).toContain("Show device code");
        expect(html).not.toContain("ant-btn-loading");
        expect(html).not.toContain('disabled=""');
        expect(html).not.toContain("ABCD-EFGH");
    });

    it("only shows action loading while a request is in flight, not throughout authorization", () => {
        const html = markup({ ...pending, login: null, busy: "starting" });
        expect(html).toContain("ant-btn-loading");
        expect(html).toContain("Requesting device code");
        expect(html).not.toContain("ABCD-EFGH");
    });

    it("shows a diagnostic and a retry action after a start failure", () => {
        const html = markup({ status: "disconnected", login: null, busy: null, copyStatus: "idle", error: { kind: "start", message: "Device-code login denied by workspace policy" } });
        expect(html).toContain('role="alert"');
        expect(html).toContain("Device-code login denied by workspace policy");
        expect(html).toContain("Try again");
        expect(html).toContain("code expired");
        expect(html).toContain("ChatGPT Security settings");
    });

    it("keeps manual authorization and cancellation available after a status error", () => {
        const html = markup({ ...pending, error: { kind: "status", message: "Status service unreachable" } });
        expect(html).toContain("ABCD-EFGH");
        expect(html).toContain("Status service unreachable");
        expect(html).toContain("Check status again");
        expect(html).toContain("Cancel authorization");
    });

    it("removes verification details and explains retry when authorization ends", () => {
        const html = markup({ status: "disconnected", login: null, busy: null, copyStatus: "idle", error: { kind: "expired" } });
        expect(html).toContain("Authorization ended");
        expect(html).toContain("Try again");
        expect(html).not.toContain("ABCD-EFGH");
        expect(html).not.toContain('href="https://auth.openai.com/codex/device"');
    });

    it("shows disconnect without verification details once connected", () => {
        const html = markup({ status: "connected", login: null, busy: null, copyStatus: "idle", error: null });
        expect(html).toContain("Connected");
        expect(html).toContain("Disconnect");
        expect(html).not.toContain("Copy code");
        expect(html).not.toContain("ABCD-EFGH");
    });

    it("shows confirmed clipboard success rather than treating a pending promise as success", () => {
        const html = markup({ ...pending, copyStatus: "copied" });
        expect(html).toContain("Copied");
    });

    it("explains manual copy fallback when clipboard access fails", () => {
        const html = markup({ ...pending, copyStatus: "failed" });
        expect(html).toContain("Automatic copying failed");
        expect(html).toContain("ABCD-EFGH");
    });
});
