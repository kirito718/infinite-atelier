export class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export function sendJson(res, status, value) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(value));
}

export function sendError(res, error) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    const known = error instanceof HttpError;
    sendJson(res, known ? error.status : 500, { code: known ? error.code : "INTERNAL_ERROR", error: known ? error.message : "服务端请求失败，请重试或联系管理员。" });
}

export async function readBytes(req, limit) {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
        req.resume();
        throw new HttpError(413, "TOO_LARGE", "请求内容超过大小限制。");
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > limit) {
            req.resume();
            throw new HttpError(413, "TOO_LARGE", "请求内容超过大小限制。");
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
}

export async function readJson(req, limit = 24 * 1024 * 1024) {
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) throw new HttpError(415, "CONTENT_TYPE", "请使用 JSON 请求。");
    let body;
    try {
        body = JSON.parse((await readBytes(req, limit)).toString("utf8"));
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "INVALID_JSON", "请求内容不是有效 JSON。");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "INVALID_JSON", "请求内容必须是 JSON 对象。");
    return body;
}

export function requireSameOrigin(req, publicUrl) {
    if (req.headers["x-atelier-request"] !== "1") throw new HttpError(403, "CSRF", "请求缺少同源验证标头。");
    const expected = publicUrl ? new URL(publicUrl).origin : `http://${req.headers.host}`;
    const origin = req.headers.origin;
    if ((origin && origin !== expected) || req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "CSRF", "不允许跨站修改数据。");
}

const MAIN_KEYS = new Set(["infinite-canvas:canvas_store", "infinite-canvas:asset_store", "infinite-canvas:ai_config_store", "infinite-canvas:generation_history", "infinite-canvas:prompt_library_store"]);
export function validateStateKey(key) {
    if (typeof key !== "string" || (!MAIN_KEYS.has(key) && !/^monoform-(project|custom-poses)(?:-[a-zA-Z0-9_-]{1,128})?$/.test(key))) throw new HttpError(400, "INVALID_KEY", "不支持此数据键。");
    return key;
}
export function validateFileKey(key) {
    if (typeof key !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}:[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new HttpError(400, "INVALID_KEY", "无效的文件标识。");
    return key;
}
export function decodeKey(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        throw new HttpError(400, "INVALID_KEY", "无效的数据标识。");
    }
}
export function validateStateValue(value) {
    if (value === null) return;
    if (typeof value !== "string" || Buffer.byteLength(value) > 20 * 1024 * 1024) throw new HttpError(400, "INVALID_STATE", "数据文档无效或超过 20 MB。");
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object") throw new Error();
    } catch {
        throw new HttpError(400, "INVALID_STATE", "数据文档必须是有效 JSON 对象或数组。");
    }
}
