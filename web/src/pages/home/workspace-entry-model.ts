import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export function getRecentProjects(projects: CanvasProject[], limit = 3): CanvasProject[] {
    return [...projects].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()).slice(0, limit);
}

export function getProjectNodeSummary(project: CanvasProject): { nodes: number; connections: number } {
    return { nodes: project.nodes.length, connections: project.connections.length };
}
