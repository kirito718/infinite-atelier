import { describe, expect, it } from "vitest";

import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

import { getProjectNodeSummary, getRecentProjects } from "./workspace-entry-model";

const project = (id: string, updatedAt: string, nodes = 0, connections = 0): CanvasProject => ({
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    nodes: Array.from({ length: nodes }, (_, index) => ({ id: `${id}-node-${index}` }) as CanvasProject["nodes"][number]),
    connections: Array.from({ length: connections }, (_, index) => ({ id: `${id}-connection-${index}` }) as CanvasProject["connections"][number]),
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "lines",
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
});

describe("getRecentProjects", () => {
    it("sorts newest first, limits to three, and preserves input order", () => {
        const source = [project("old", "2026-06-10T00:00:00.000Z"), project("newest", "2026-06-19T00:00:00.000Z"), project("middle", "2026-06-15T00:00:00.000Z"), project("fourth", "2026-06-12T00:00:00.000Z")];

        expect(getRecentProjects(source).map(({ id }) => id)).toEqual(["newest", "middle", "fourth"]);
        expect(source.map(({ id }) => id)).toEqual(["old", "newest", "middle", "fourth"]);
    });
});

describe("getProjectNodeSummary", () => {
    it("returns the node and connection counts used by the entry card", () => {
        expect(getProjectNodeSummary(project("design", "2026-06-19T00:00:00.000Z", 4, 2))).toEqual({ nodes: 4, connections: 2 });
    });
});
