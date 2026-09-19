import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-router-dom", () => ({
    Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
    useLocation: () => ({ pathname: "/" }),
    useNavigate: () => vi.fn(),
}));

vi.mock("react-i18next", () => ({
    useTranslation: () => ({
        t: (key: string) => ({
            "topNav.navigation": "导航菜单",
            "topNav.workspace": "工作区",
            "topNav.system": "系统",
            "topNav.createCanvas": "新建画布",
            "topNav.accountStatus": "本地优先",
            "meta.title": "Infinite Atelier",
            "navigation.canvas": "画布",
            "navigation.director": "导演",
            "navigation.assets": "资产",
            "navigation.config": "配置",
            "canvas.defaultTitle": "未命名画布",
        }[key] || key),
    }),
}));

vi.mock("@/hooks/use-account-action", () => ({ useAccountAction: (action: unknown) => action }));
vi.mock("@/components/layout/user-status-actions", () => ({ UserStatusActions: () => <div>status-actions</div> }));
vi.mock("@/stores/canvas/use-canvas-store", () => ({
    useCanvasStore: (selector: (state: { projects: never[]; createProject: () => string }) => unknown) => selector({ projects: [], createProject: () => "new-project" }),
}));

import { AppSideNav } from "./app-side-nav";

describe("AppSideNav", () => {
    it("renders labeled Chinese workspace navigation and the create action", () => {
        const html = renderToStaticMarkup(<AppSideNav />);

        expect(html).toContain("工作区");
        expect(html).toContain('aria-label="新建画布"');
        expect(html).toMatch(/>画布</);
        expect(html).toMatch(/>导演</);
        expect(html).toMatch(/>资产</);
        expect(html).toMatch(/>配置</);
    });
});
