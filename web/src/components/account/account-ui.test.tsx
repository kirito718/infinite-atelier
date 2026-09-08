import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
    getAccountSession: vi.fn(),
    loginAccount: vi.fn(),
    registerAccount: vi.fn(),
    logoutAccount: vi.fn(),
    changeAccountPassword: vi.fn(),
    hydrateUserData: vi.fn(),
    clearUserData: vi.fn(),
    flushServerChanges: vi.fn(),
}));
vi.mock("@/services/account-client", () => ({
    getAccountSession: boundary.getAccountSession,
    loginAccount: boundary.loginAccount,
    registerAccount: boundary.registerAccount,
    logoutAccount: boundary.logoutAccount,
    changeAccountPassword: boundary.changeAccountPassword,
}));
vi.mock("@/services/account-session", () => ({ hydrateUserData: boundary.hydrateUserData, clearUserData: boundary.clearUserData }));
vi.mock("@/services/server-storage", () => ({ flushServerChanges: boundary.flushServerChanges, hasRecoverableDrafts: () => false }));

const alice = { id: "alice-id", username: "alice", displayName: "Alice", avatarUrl: "" };
let useUserStore: typeof import("@/stores/use-user-store").useUserStore;
let gate: typeof import("./account-gate");
let actions: typeof import("./account-actions");

beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    boundary.getAccountSession.mockResolvedValue({ user: null, registrationAllowed: false });
    boundary.loginAccount.mockResolvedValue({ user: alice });
    boundary.registerAccount.mockResolvedValue({ user: alice });
    boundary.hydrateUserData.mockResolvedValue(undefined);
    boundary.flushServerChanges.mockResolvedValue(undefined);
    ({ useUserStore } = await import("@/stores/use-user-store"));
    gate = await import("./account-gate");
    actions = await import("./account-actions");
});

function gateMarkup() {
    // Render the real view against a snapshot produced by the real store's lifecycle.
    // Zustand's SSR hook intentionally uses its initial snapshot, so view tests pass
    // the live snapshot explicitly instead of mocking hooks/getInitialState.
    const { AccountGateContent } = gate;
    return renderToStaticMarkup(
        <AccountGateContent session={useUserStore.getState()}>
            <div>private-canvas-content</div>
        </AccountGateContent>,
    );
}

async function authenticate() {
    boundary.getAccountSession.mockResolvedValueOnce({ user: alice, registrationAllowed: false });
    await useUserStore.getState().refreshSession();
}

describe("account gate rendering", () => {
    it("initially blocks all app children with an accessible restoration status", () => {
        const { AccountGate } = gate;
        const html = renderToStaticMarkup(
            <AccountGate>
                <div>private-canvas-content</div>
            </AccountGate>,
        );
        expect(html).toContain('role="status"');
        expect(html).toMatch(/恢复|验证/);
        expect(html).not.toContain("private-canvas-content");
        expect(html).not.toContain("<form");
    });

    it("shows a Chinese login form for an anonymous session and hides closed registration", async () => {
        await useUserStore.getState().refreshSession();
        const html = gateMarkup();
        expect(html).toContain('lang="zh-CN"');
        expect(html).toContain("用户名");
        expect(html).toContain("密码");
        expect(html).toContain('autoComplete="username"');
        expect(html).toContain('autoComplete="current-password"');
        expect(html).toContain('minLength="3"');
        expect(html).toContain('maxLength="40"');
        expect(html).toContain('minLength="10"');
        expect(html).toContain('maxLength="128"');
        expect(html).toMatch(/<label[^>]+for="[^"]+"/);
        expect(html).toContain('type="submit"');
        expect(html).not.toContain("private-canvas-content");
        expect(html).not.toMatch(/>注册账号</);
        expect(html).toMatch(/关闭注册|注册已关闭/);
    });

    it("offers registration only when the server permits it and bounds the display name", async () => {
        boundary.getAccountSession.mockResolvedValueOnce({ user: null, registrationAllowed: true });
        await useUserStore.getState().refreshSession();
        expect(gateMarkup()).toMatch(/>注册账号</);
        const { AccountCredentialsForm } = gate;
        const html = renderToStaticMarkup(<AccountCredentialsForm mode="signUp" session={useUserStore.getState()} onModeChange={() => {}} />);
        expect(html).toContain("显示名称");
        expect(html).toContain('maxLength="60"');
        expect(html).toContain('autoComplete="new-password"');
        expect(html).toMatch(/创建账号/);
        expect(html).not.toContain("private-canvas-content");
    });

    it("does not leave a register form usable after the server closes registration", async () => {
        await useUserStore.getState().refreshSession();
        const { AccountCredentialsForm } = gate;
        const html = renderToStaticMarkup(<AccountCredentialsForm mode="signUp" session={useUserStore.getState()} onModeChange={() => {}} />);
        expect(html).not.toContain('name="displayName"');
        expect(html).toContain('autoComplete="current-password"');
        expect(html).not.toMatch(/>创建账号</);
    });

    it("exposes bootstrap failure and a retry control, never an empty or anonymous app", async () => {
        boundary.getAccountSession.mockRejectedValueOnce(new Error("会话服务暂时不可用"));
        await useUserStore.getState().refreshSession();
        const html = gateMarkup();
        expect(html).toContain('role="alert"');
        expect(html).toContain("会话服务暂时不可用");
        expect(html).toMatch(/<button[^>]*>[^<]*重试/);
        expect(html).not.toContain("private-canvas-content");
        expect(html).not.toContain('name="username"');
        await authenticate();
        expect(gateMarkup()).toBe("<div>private-canvas-content</div>");
    });

    it("keeps form submission disabled while sign-in and hydration are pending", async () => {
        await useUserStore.getState().refreshSession();
        let finish!: (value: { user: typeof alice }) => void;
        boundary.loginAccount.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const signingIn = useUserStore.getState().signIn({ username: "alice", password: "a long password" });
        const html = gateMarkup();
        expect(html).toContain('aria-busy="true"');
        expect(html).toMatch(/<fieldset[^>]*disabled/);
        expect(html).toContain('role="status"');
        expect(html).not.toContain("private-canvas-content");
        finish({ user: alice });
        await signingIn;
        expect(gateMarkup()).toBe("<div>private-canvas-content</div>");
    });

    it("renders a rejected login as an accessible error without revealing app content", async () => {
        boundary.loginAccount.mockRejectedValueOnce(new Error("用户名或密码错误"));
        await useUserStore.getState().signIn({ username: "alice", password: "a long password" });
        const html = gateMarkup();
        expect(html).toContain('role="alert"');
        expect(html).toContain("用户名或密码错误");
        expect(html).not.toContain("private-canvas-content");
    });

    it("keeps the same authenticated children visible throughout a background refresh", async () => {
        await authenticate();
        let finish!: (value: { user: typeof alice; registrationAllowed: boolean }) => void;
        boundary.getAccountSession.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const refreshing = useUserStore.getState().refreshSession();
        expect(gateMarkup()).toBe("<div>private-canvas-content</div>");
        finish({ user: alice, registrationAllowed: false });
        await refreshing;
        expect(gateMarkup()).toBe("<div>private-canvas-content</div>");
    });
});

describe("account actions rendering and password confirmation", () => {
    it("renders an accessible named account-menu trigger with canvas-compatible styling", async () => {
        await authenticate();
        const { AccountActionsContent } = actions;
        const html = renderToStaticMarkup(<AccountActionsContent session={useUserStore.getState()} className="canvas-account-trigger" style={{ color: "rgb(1, 2, 3)" }} />);
        expect(html).toContain('aria-label="账号菜单：alice"');
        expect(html).toContain('aria-haspopup="menu"');
        expect(html).toContain("canvas-account-trigger");
        expect(html).toContain("color:rgb(1, 2, 3)");
    });

    it("does not offer actions for an unverified or anonymous account", async () => {
        const { AccountActionsContent } = actions;
        expect(renderToStaticMarkup(<AccountActionsContent session={useUserStore.getState()} />)).toBe("");
        await useUserStore.getState().refreshSession();
        expect(renderToStaticMarkup(<AccountActionsContent session={useUserStore.getState()} />)).toBe("");
    });

    it("keeps logout/save failure visible while the original account remains usable", async () => {
        await authenticate();
        boundary.flushServerChanges.mockRejectedValueOnce(new Error("无法保存，请稍后重试退出"));
        await useUserStore.getState().signOut();
        const { AccountActionsContent } = actions;
        const html = renderToStaticMarkup(<AccountActionsContent session={useUserStore.getState()} />);
        expect(html).toContain('role="alert"');
        expect(html).toContain("无法保存，请稍后重试退出");
        expect(html).toContain('aria-label="账号菜单：alice"');
        expect(gateMarkup()).toContain("private-canvas-content");
    });

    it("provides labeled current, new and confirmation password inputs with correct autocomplete", async () => {
        await authenticate();
        const { AccountPasswordForm } = actions;
        const html = renderToStaticMarkup(<AccountPasswordForm session={useUserStore.getState()} onDone={() => {}} onCancel={() => {}} />);
        expect(html).toContain("当前密码");
        expect(html).toContain("新密码");
        expect(html).toContain("确认新密码");
        expect(html.match(/type="password"/g)).toHaveLength(3);
        expect(html.match(/autoComplete="current-password"/g)).toHaveLength(1);
        expect(html.match(/autoComplete="new-password"/g)).toHaveLength(2);
        expect(html.match(/maxLength="128"/g)).toHaveLength(3);
        expect(html.match(/<label[^>]+for="[^"]+"/g)).toHaveLength(3);
        expect(html).not.toContain('value="a long password"');
    });

    it.each([
        { currentPassword: "", newPassword: "new long password", confirmPassword: "new long password" },
        { currentPassword: "old long password", newPassword: "short", confirmPassword: "short" },
        { currentPassword: "old long password", newPassword: "x".repeat(129), confirmPassword: "x".repeat(129) },
        { currentPassword: "old long password", newPassword: "new long password", confirmPassword: "different password" },
        { currentPassword: "old long password", newPassword: "new long password ", confirmPassword: "new long password" },
    ])("rejects missing, oversized, or mismatching password confirmation without normalizing passwords", (input) => {
        expect(actions.validatePasswordChange(input)).toBeTruthy();
    });

    it("accepts identical valid confirmation, including intentional spaces", () => {
        expect(actions.validatePasswordChange({ currentPassword: "old long password", newPassword: " new long password ", confirmPassword: " new long password " })).toBeNull();
    });
});
