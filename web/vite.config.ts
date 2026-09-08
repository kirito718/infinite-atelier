import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, normalizePath, type Plugin } from "vite";
import { createAccountApi } from "./server/account-api.mjs";
import { resolveAccountDataDir } from "./server/account-paths.mjs";

const webDir = dirname(fileURLToPath(import.meta.url));

// Keep this exported name for existing integrations; the factory now owns ALL
// authenticated APIs, so there is no unguarded proxy or shared Codex endpoint.
export function codexSubscriptionApiPlugin({ createApi = createAccountApi } = {}): Plugin {
    let api: ReturnType<typeof createAccountApi> | undefined;
    const middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
        const pathname = new URL(request.url || "/", "http://localhost").pathname;
        if (!/^\/api\/(account|codex-subscription|comfyui)(\/|$)/.test(pathname) && pathname !== "/api-proxy") {
            next();
            return;
        }
        try {
            api ??= createApi();
            void api.handle(request, response);
        } catch {
            response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
            response.end(JSON.stringify({ code: "STORAGE_UNAVAILABLE", error: "服务端存储不可用，请检查数据目录、权限和加密密钥。" }));
        }
    };
    const attach = (server: any) => {
        server.middlewares.use(middleware);
        server.httpServer?.once("close", () => void api?.close());
    };
    return { name: "infinite-atelier-account-api", configureServer: attach, configurePreviewServer: attach };
}

export default defineConfig(({ mode }) => {
    // Server-only configuration is never exposed as VITE_* browser variables.
    const env = loadEnv(mode, webDir, ["ATELIER_", "COMFYUI_"]);
    for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;
    const configuredDataDir = normalizePath(resolve(process.env.ATELIER_DATA_DIR || resolve(webDir, "data")));
    const dataDir = normalizePath(resolveAccountDataDir());
    const host = process.env.ATELIER_PUBLIC_URL ? new URL(process.env.ATELIER_PUBLIC_URL).hostname : undefined;
    return {
        base: process.env.VITE_BASE || "/",
        server: {
            allowedHosts: ["siyuan.kirito.work", ...(host ? [host] : [])],
            // Vite serves source files in dev. Never let /data or /@fs expose the
            // SQLite database, encryption key, user uploads or Codex credentials.
            fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", `${dataDir}/**`, `${configuredDataDir}/**`, "**/encryption.key", "**/atelier.sqlite*"] },
        },
        plugins: [react(), codexSubscriptionApiPlugin()],
        resolve: { alias: { "@": resolve(webDir, "src") } },
    };
});
