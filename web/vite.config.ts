import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createCodexSubscriptionApi } from "./server/codex-subscription-api.mjs";
import { createConfiguredComfyUiApi } from "./server/comfyui-gateway.mjs";
import { defineConfig, type Plugin } from "vite";

const webDir = dirname(fileURLToPath(import.meta.url));

// Dev-server forward proxy for CORS-blocked API targets (relay/中转 API providers usually
// do not send CORS headers). Frontend calls /api-proxy?target=<full api url>; this middleware
// forwards the request server-side and streams the response back, bypassing browser CORS.
function apiProxyPlugin(): Plugin {
    return {
        name: "canvas-api-proxy",
        apply: "serve",
        configureServer(server) {
            server.middlewares.use("/api-proxy", (req, res, next) => {
                void (async () => {
                    try {
                        const url = new URL(req.url || "", "http://localhost");
                        const target = url.searchParams.get("target");
                        if (!target) {
                            res.statusCode = 400;
                            res.end("missing target");
                            return;
                        }
                        const targetUrl = new URL(target);
                        const headers: Record<string, string> = {};
                        for (const [key, value] of Object.entries(req.headers)) {
                            if (!value || ["host", "connection", "content-length", "transfer-encoding"].includes(key)) continue;
                            headers[key] = Array.isArray(value) ? value.join(", ") : value;
                        }
                        headers.host = targetUrl.host;
                        const body = ["POST", "PUT", "PATCH"].includes(req.method || "") ? await readRequestBody(req) : undefined;
                        const upstream = await fetch(targetUrl, {
                            method: req.method,
                            headers,
                            body: body ? new Uint8Array(body) : undefined,
                            signal: AbortSignal.timeout(300_000),
                        });
                        res.statusCode = upstream.status;
                        upstream.headers.forEach((value, key) => {
                            if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)) res.setHeader(key, value);
                        });
                        if (upstream.body) {
                            const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
                            stream.pipe(res);
                        } else {
                            res.end();
                        }
                    } catch (error) {
                        res.statusCode = 502;
                        res.end(`proxy error: ${error instanceof Error ? error.message : String(error)}`);
                    }
                })();
            });
        },
    };
}

function readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
    return new Promise((resolveBody) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolveBody(chunks.length ? Buffer.concat(chunks) : undefined));
        req.on("error", () => resolveBody(undefined));
    });
}

export function codexSubscriptionApiPlugin({ createApi = createCodexSubscriptionApi } = {}): Plugin {
    let api: ReturnType<typeof createCodexSubscriptionApi> | undefined;

    const getApi = () => {
        api ??= createApi();
        return api;
    };

    const middleware = (request: IncomingMessage, response: import("node:http").ServerResponse, next: () => void) => {
        if (!(request.url || "").startsWith("/api/codex-subscription")) {
            next();
            return;
        }
        void getApi()
            .handle(request, response)
            .catch((error) => {
                if (response.headersSent) return;
                response.statusCode = 500;
                response.end(error instanceof Error ? error.message : String(error));
            });
    };

    const attach = (server: any) => {
        server.middlewares.use(middleware);
        server.httpServer?.once("close", () => void api?.close());
    };

    return {
        name: "infinite-atelier-codex-subscription-api",
        configureServer: attach,
        configurePreviewServer: attach,
    };
}

export function comfyuiApiPlugin({ createApi = createConfiguredComfyUiApi }: { createApi?: typeof createConfiguredComfyUiApi } = {}): Plugin {
    let api: ReturnType<typeof createConfiguredComfyUiApi> | undefined;
    let initializationError: Error | undefined;

    const getApi = () => {
        if (api || initializationError) return api;
        try {
            api = createApi();
            return api;
        } catch (error) {
            initializationError = error instanceof Error ? error : new Error(String(error));
            return undefined;
        }
    };

    const middleware = (request: IncomingMessage, response: import("node:http").ServerResponse, next: () => void) => {
        if (!isComfyUiRoute(request.url)) {
            next();
            return;
        }
        const resolvedApi = getApi();
        if (!resolvedApi) {
            sendComfyUiUnavailable(response, initializationError);
            return;
        }
        void resolvedApi.handle(request, response).catch(() => {
            if (response.headersSent) return;
            response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
            response.end(JSON.stringify({ error: { code: "COMFYUI_INTERNAL_ERROR", message: "ComfyUI 网关处理失败，请检查服务端日志", retryable: true } }));
        });
    };

    const attach = (server: any) => {
        server.middlewares.use(middleware);
        server.httpServer?.once("close", () => void api?.close());
    };

    return {
        name: "infinite-atelier-comfyui-api",
        configureServer: attach,
        configurePreviewServer: attach,
    };
}

function isComfyUiRoute(url: string | undefined) {
    return /^\/api\/comfyui(?:\/|$)/.test(url || "");
}

function sendComfyUiUnavailable(response: import("node:http").ServerResponse, cause?: Error) {
    const message = cause?.message === "COMFYUI_BASE_URL is not configured" ? "ComfyUI 尚未配置，请在服务器设置 COMFYUI_BASE_URL" : "ComfyUI 网关配置不可用，请检查服务端配置与工作流";
    const payload = Buffer.from(JSON.stringify({ error: { code: "COMFYUI_UNAVAILABLE", message, retryable: true } }));
    response.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
        "content-length": payload.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
    });
    response.end(payload);
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), apiProxyPlugin(), codexSubscriptionApiPlugin(), comfyuiApiPlugin()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
});
