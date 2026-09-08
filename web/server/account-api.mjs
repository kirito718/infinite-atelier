import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAppServerClient } from "../local-bridge/app-server-client.mjs";
import { createCodexSubscriptionApi } from "./codex-subscription-api.mjs";
import { createConfiguredComfyUiApi } from "./comfyui-gateway.mjs";
import { openAccountDatabase } from "./account-database.mjs";
import { resolveAccountDataDir } from "./account-paths.mjs";
import { clearCookie, createRateLimiter, getSessionToken, getSessionUser, hashPassword, issueSession, publicUser, tokenHash, validatePassword, validateUsername, verifyPassword } from "./account-auth.mjs";
import { createFileStorage } from "./account-files.mjs";
import { HttpError, decodeKey, readJson, requireSameOrigin, sendError, sendJson, validateFileKey, validateStateKey, validateStateValue } from "./account-http.mjs";
import { proxyAccountRequest } from "./account-proxy.mjs";

const DEFAULT_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../data");
const byteSetting = (value, fallback) => {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};
const writeMethod = (method) => !["GET", "HEAD", "OPTIONS"].includes(method);

function defaultCodexFactory({ codexHome, tempRoot }) {
    const codex = createCodexAppServerClient({
        generatedImagesDir: join(codexHome, "generated_images"),
        spawnProcess: (command, args, options) => spawn(command, args, { ...options, env: { ...process.env, CODEX_HOME: codexHome } }),
    });
    return createCodexSubscriptionApi({ codex, tempRoot });
}

export function createAccountApi({
    dataDir = process.env.ATELIER_DATA_DIR || DEFAULT_DATA_DIR,
    allowRegistration = process.env.ATELIER_ALLOW_REGISTRATION === "true",
    publicUrl = process.env.ATELIER_PUBLIC_URL,
    secureCookies = process.env.ATELIER_SECURE_COOKIES === "true" || Boolean(publicUrl?.startsWith("https://")),
    maxUploadBytes = byteSetting(process.env.ATELIER_MAX_UPLOAD_BYTES, 100 * 1024 * 1024),
    quotaBytes = byteSetting(process.env.ATELIER_USER_QUOTA_BYTES, 2 * 1024 * 1024 * 1024),
    allowPrivateUpstreams = process.env.ATELIER_ALLOW_PRIVATE_UPSTREAMS === "true",
    codexFactory = defaultCodexFactory,
    comfyuiFactory = createConfiguredComfyUiApi,
} = {}) {
    dataDir = resolveAccountDataDir(dataDir);
    const storage = openAccountDatabase(dataDir);
    const { db } = storage;
    const files = createFileStorage({ db, dataDir, maxUploadBytes, quotaBytes });
    const rateLimit = createRateLimiter();
    const codexRuntimes = new Map();
    const comfyuiRuntimes = new Map();
    let closed = false;
    const registrationAllowed = () => allowRegistration || db.prepare("SELECT count(*) AS count FROM users").get().count === 0;
    const revokeCurrent = (req) => {
        const token = getSessionToken(req);
        if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(token));
    };

    async function handleAuth(req, res, pathname) {
        if (req.method === "GET" && pathname === "/api/account/session") {
            const user = getSessionUser(db, req);
            sendJson(res, 200, { user: user ? publicUser(user) : null, registrationAllowed: registrationAllowed() });
            return true;
        }
        if (req.method !== "POST" || !["/api/account/register", "/api/account/login"].includes(pathname)) return false;
        const body = await readJson(req, 8192);
        const username = validateUsername(body.username);
        validatePassword(body.password);
        rateLimit(`auth:${req.socket.remoteAddress}`, 40);
        rateLimit(`auth-user:${username}`, 12);
        let user;
        if (pathname.endsWith("/register")) {
            if (!registrationAllowed()) throw new HttpError(403, "REGISTRATION_CLOSED", "当前未开放注册，请联系管理员。");
            const displayName = typeof body.displayName === "string" ? body.displayName.trim() : username;
            if (displayName.length > 60) throw new HttpError(400, "INVALID_NAME", "显示名称不能超过 60 个字符。");
            const passwordHash = await hashPassword(body.password);
            user = db.transaction(() => {
                // Re-check after asynchronous hashing so concurrent first registrations cannot bypass closed signup.
                if (!registrationAllowed()) throw new HttpError(403, "REGISTRATION_CLOSED", "当前未开放注册，请联系管理员。");
                if (db.prepare("SELECT 1 FROM users WHERE username=?").get(username)) throw new HttpError(409, "USERNAME_EXISTS", "该用户名已被使用。");
                const id = randomUUID();
                db.prepare("INSERT INTO users (id,username,display_name,password_hash,created_at) VALUES (?,?,?,?,?)").run(id, username, displayName || username, passwordHash, Date.now());
                return db.prepare("SELECT * FROM users WHERE id=?").get(id);
            })();
        } else {
            user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
            if (!(await verifyPassword(body.password, user?.password_hash))) throw new HttpError(401, "INVALID_CREDENTIALS", "用户名或密码不正确。");
        }
        revokeCurrent(req);
        issueSession(db, res, user.id, secureCookies);
        sendJson(res, pathname.endsWith("/register") ? 201 : 200, { user: publicUser(user) });
        return true;
    }

    async function route(req, res) {
        if (closed) throw new HttpError(503, "SHUTTING_DOWN", "服务正在重启，请稍后重试。");
        const url = new URL(req.url || "/", "http://localhost");
        const { pathname } = url;
        if (req.method === "GET" && pathname === "/api/account/health") {
            sendJson(res, 200, { ok: true });
            return;
        }
        if (writeMethod(req.method)) requireSameOrigin(req, publicUrl);
        if (await handleAuth(req, res, pathname)) return;
        const user = getSessionUser(db, req);
        if (!user) throw new HttpError(401, "UNAUTHENTICATED", "请先登录。");
        const headerUser = req.headers["x-atelier-user"];
        const queryUser = pathname.startsWith("/api/account/files/") ? url.searchParams.get("account") : null;
        if ((writeMethod(req.method) && !headerUser) || (headerUser && headerUser !== user.id) || (queryUser && queryUser !== user.id)) throw new HttpError(409, "ACCOUNT_CHANGED", "账号已在其他页面切换，请重新加载后继续。");

        if (pathname === "/api/account/logout" && req.method === "POST") {
            revokeCurrent(req);
            clearCookie(res, secureCookies);
            res.writeHead(204).end();
            return;
        }
        if (pathname === "/api/account/password" && req.method === "POST") {
            rateLimit(`password:${user.id}`, 8);
            const body = await readJson(req, 8192);
            validatePassword(body.newPassword);
            if (!(await verifyPassword(body.currentPassword, user.password_hash))) throw new HttpError(401, "INVALID_CREDENTIALS", "当前密码不正确。");
            const hash = await hashPassword(body.newPassword);
            db.transaction(() => {
                const changed = db.prepare("UPDATE users SET password_hash=? WHERE id=? AND password_hash=?").run(hash, user.id, user.password_hash);
                if (!changed.changes) throw new HttpError(409, "PASSWORD_CHANGED", "密码已修改，请重新登录。");
                db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
            })();
            issueSession(db, res, user.id, secureCookies);
            sendJson(res, 200, { user: publicUser(user) });
            return;
        }
        if (pathname === "/api/account/state" && req.method === "GET") {
            sendJson(res, 200, { entries: storage.listStates(user.id) });
            return;
        }
        const stateMatch = /^\/api\/account\/state\/(.+)$/.exec(pathname);
        if (stateMatch) {
            const key = validateStateKey(decodeKey(stateMatch[1]));
            if (req.method === "GET") {
                sendJson(res, 200, storage.readState(user.id, key));
                return;
            }
            if (req.method === "PUT") {
                const body = await readJson(req);
                sendJson(res, 200, storage.writeState(user.id, key, body.value, body.expectedRevision));
                return;
            }
        }
        const importMatch = /^\/api\/account\/import\/([a-zA-Z0-9_-]{8,100})$/.exec(pathname);
        if (importMatch && req.method === "GET") {
            const imported = Boolean(db.prepare("SELECT 1 FROM imports WHERE user_id=? AND migration_id=?").get(user.id, importMatch[1]));
            const nonempty = Boolean(db.prepare("SELECT 1 FROM documents WHERE user_id=? AND value IS NOT NULL LIMIT 1").get(user.id));
            sendJson(res, 200, { imported, canImport: imported || !nonempty });
            return;
        }
        if (pathname === "/api/account/import" && req.method === "POST") {
            const body = await readJson(req);
            if (typeof body.migrationId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.migrationId) || !Array.isArray(body.entries) || !body.entries.length || body.entries.length > 256) throw new HttpError(400, "INVALID_IMPORT", "迁移数据无效。");
            const keys = new Set();
            for (const item of body.entries) {
                if (!item || typeof item !== "object") throw new HttpError(400, "INVALID_IMPORT", "迁移文档无效。");
                validateStateKey(item.key);
                validateStateValue(item.value);
                if (item.value === null || keys.has(item.key)) throw new HttpError(400, "INVALID_IMPORT", "迁移文档重复或为空。");
                keys.add(item.key);
            }
            sendJson(res, 200, storage.importStates(user.id, body.migrationId, body.entries));
            return;
        }
        if (pathname === "/api/account/restore" && req.method === "POST") {
            const body = await readJson(req);
            if (!Array.isArray(body.entries) || !body.entries.length || body.entries.length > 256) throw new HttpError(400, "INVALID_BACKUP", "备份文档无效。");
            const keys = new Set();
            for (const item of body.entries) {
                if (!item || typeof item !== "object") throw new HttpError(400, "INVALID_BACKUP", "备份文档无效。");
                validateStateKey(item.key);
                validateStateValue(item.value);
                if (keys.has(item.key)) throw new HttpError(400, "INVALID_BACKUP", "备份文档重复。");
                keys.add(item.key);
            }
            sendJson(res, 200, storage.restoreStates(user.id, body.entries));
            return;
        }
        if (pathname === "/api/account/files" && req.method === "GET") {
            sendJson(res, 200, { files: files.list(user.id) });
            return;
        }
        if (pathname === "/api/account/usage" && req.method === "GET") {
            const media = files.list(user.id);
            const docs = db.prepare("SELECT count(*) AS records,coalesce(sum(length(value)),0) AS bytes FROM documents WHERE user_id=?").get(user.id);
            sendJson(res, 200, { mediaBytes: media.reduce((sum, file) => sum + file.bytes, 0), mediaCount: media.length, documentBytes: docs.bytes, documentCount: docs.records, quotaBytes, maxUploadBytes });
            return;
        }
        const fileMatch = /^\/api\/account\/files\/(.+)$/.exec(pathname);
        if (fileMatch) {
            const key = validateFileKey(decodeKey(fileMatch[1]));
            if (req.method === "PUT") {
                await files.upload(req, res, user.id, key);
                return;
            }
            if (req.method === "GET" || req.method === "HEAD") {
                await files.download(req, res, user.id, key);
                return;
            }
            if (req.method === "DELETE") {
                await files.remove(user.id, key);
                res.writeHead(204).end();
                return;
            }
        }
        if (pathname === "/api-proxy") {
            rateLimit(`proxy:${user.id}`, 120, 60000);
            await proxyAccountRequest(req, res, { target: url.searchParams.get("target"), allowPrivate: allowPrivateUpstreams });
            return;
        }
        if (pathname === "/api/comfyui" || pathname.startsWith("/api/comfyui/")) {
            let runtime = comfyuiRuntimes.get(user.id);
            if (!runtime) {
                if (comfyuiRuntimes.size >= 16) throw new HttpError(503, "COMFYUI_CAPACITY", "当前服务的 ComfyUI 用户连接已达上限，请联系管理员。");
                try {
                    // Each runtime owns its own job/idempotency/output store. The
                    // private GPU endpoint is shared, but task access never is.
                    runtime = comfyuiFactory({ userId: user.id });
                } catch (error) {
                    const message = error?.code === "COMFYUI_NOT_CONFIGURED" ? "ComfyUI 尚未配置，请在服务器设置 COMFYUI_BASE_URL。" : "ComfyUI 网关配置不可用，请检查服务端配置与工作流。";
                    throw new HttpError(503, "COMFYUI_UNAVAILABLE", message);
                }
                comfyuiRuntimes.set(user.id, runtime);
            }
            await runtime.handle(req, res);
            return;
        }
        if (pathname === "/api/codex-subscription" || pathname.startsWith("/api/codex-subscription/")) {
            let runtime = codexRuntimes.get(user.id);
            if (!runtime) {
                if (codexRuntimes.size >= 16) throw new HttpError(503, "CODEX_CAPACITY", "当前服务的 Codex 连接已达上限，请联系管理员。");
                const codexHome = join(dataDir, "codex", user.id);
                const tempRoot = join(codexHome, "tmp");
                mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
                runtime = codexFactory({ userId: user.id, codexHome, tempRoot });
                codexRuntimes.set(user.id, runtime);
            }
            await runtime.handle(req, res);
            return;
        }
        throw new HttpError(404, "NOT_FOUND", "接口不存在。");
    }

    return {
        async handle(req, res) {
            res.setHeader("cache-control", "no-store");
            try {
                await route(req, res);
            } catch (error) {
                sendError(res, error);
            }
        },
        async close() {
            if (closed) return;
            closed = true;
            await files.settled();
            await Promise.allSettled([...codexRuntimes.values(), ...comfyuiRuntimes.values()].map((runtime) => runtime.close?.()));
            storage.close();
        },
    };
}
