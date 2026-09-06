import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createComfyUiApi } from "./comfyui-api.mjs";
import { createComfyUiClient } from "./comfyui-client.mjs";
import { createComfyUiTaskStore } from "./comfyui-task-store.mjs";
import { createWorkflowRegistry, DEFAULT_WORKFLOW_MANIFESTS } from "./comfyui-workflows.mjs";

class ComfyUiConfigError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "ComfyUiConfigError";
        this.code = code;
    }
}
const invalid = (name) => new ComfyUiConfigError("COMFYUI_CONFIG_INVALID", `Invalid ${name}`);

export function readComfyUiConfig(env = process.env) {
    const configuredUrl = env.COMFYUI_BASE_URL?.trim();
    if (!configuredUrl) throw new ComfyUiConfigError("COMFYUI_NOT_CONFIGURED", "COMFYUI_BASE_URL is not configured");
    let url;
    try {
        url = new URL(configuredUrl);
    } catch {
        throw invalid("COMFYUI_BASE_URL");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid("COMFYUI_BASE_URL");
    const apiPrefix = (env.COMFYUI_API_PREFIX ?? "/api").trim().replace(/^\/+|\/+$/g, "");
    if (apiPrefix && !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(apiPrefix)) throw invalid("COMFYUI_API_PREFIX");
    const websocket = (env.COMFYUI_WS_ENABLED ?? "true").trim().toLowerCase();
    if (!["true", "false"].includes(websocket)) throw invalid("COMFYUI_WS_ENABLED");
    const positive = (name, fallback) => {
        const raw = env[name]?.trim();
        if (!raw) return fallback;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value <= 0) throw invalid(name);
        return value;
    };
    return {
        baseUrl: url.href.replace(/\/+$/, ""),
        apiPrefix: apiPrefix ? `/${apiPrefix}` : "",
        websocketEnabled: websocket === "true",
        ttlMs: positive("COMFYUI_TASK_TTL_MS", 3_600_000),
        timeoutMs: positive("COMFYUI_REQUEST_TIMEOUT_MS", 120_000),
        maxBytes: positive("COMFYUI_MAX_BYTES", 25 * 1024 * 1024),
        workflowDirectory: env.COMFYUI_WORKFLOW_DIR?.trim() || resolve(dirname(fileURLToPath(import.meta.url)), "workflows"),
    };
}

/** The only configuration source is the server environment, never a browser request. */
export function createConfiguredComfyUiApi({ env = process.env } = {}) {
    const config = readComfyUiConfig(env);
    const registry = createWorkflowRegistry({ directory: config.workflowDirectory, manifests: DEFAULT_WORKFLOW_MANIFESTS });
    const client = createComfyUiClient(config);
    const store = createComfyUiTaskStore({ ttlMs: config.ttlMs });
    return createComfyUiApi({ registry, client, store, maxBytes: config.maxBytes });
}
