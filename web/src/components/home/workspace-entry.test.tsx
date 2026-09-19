import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({
        i18n: { resolvedLanguage: "zh-CN" },
        t: (key: string) =>
            ({
                "home.workspaceEntry": "画布库 / 工作区",
                "home.continueCreating": "继续创作",
                "home.searchProjects": "搜索画布",
                "home.importReference": "导入参考",
                "topNav.createCanvas": "新建画布",
                "home.quickStart": "快速开始",
                "home.quickStartCount": "3 个入口",
                "home.recentCanvases": "最近画布",
                "home.viewAll": "查看全部",
                "home.noProjects": "还没有画布项目",
                "home.emptyDescription": "从一张干净的无限画布开始。",
                "home.loading": "正在恢复你的工作区…",
                "home.noSearchResults": "没有找到匹配的画布",
                "home.clearSearch": "清除搜索",
            })[key] || key,
    }),
}));

import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

import { WorkspaceEntry } from "./workspace-entry";

const project = (title: string): CanvasProject => ({
    id: "project-1",
    title,
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:00.000Z",
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "lines",
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
});

const callbacks = {
    onOpenNewCanvas: () => {},
    onCreateCanvas: () => {},
    onOpenProject: () => {},
    onOpenCanvasLibrary: () => {},
    onImportReference: () => {},
    onStartFromPrompt: () => {},
};

describe("WorkspaceEntry", () => {
    it("renders the primary workspace and recent project state", () => {
        const html = renderToStaticMarkup(<WorkspaceEntry hydrated recentProjects={[project("品牌视觉探索")]} {...callbacks} />);

        expect(html).toContain("继续创作");
        expect(html).toContain("最近画布");
        expect(html).toContain("品牌视觉探索");
        expect(html).not.toContain("把灵感变成可以持续推演的作品");
    });

    it("renders a directed empty state", () => {
        const html = renderToStaticMarkup(<WorkspaceEntry hydrated recentProjects={[]} {...callbacks} />);

        expect(html).toContain("还没有画布项目");
        expect(html).toContain("新建画布");
        expect(html).not.toContain("把灵感变成可以持续推演的作品");
    });

    it("renders a status while the canvas store is hydrating", () => {
        const html = renderToStaticMarkup(<WorkspaceEntry hydrated={false} recentProjects={[]} {...callbacks} />);

        expect(html).toContain('role="status"');
        expect(html).toContain("正在恢复你的工作区");
    });
});
