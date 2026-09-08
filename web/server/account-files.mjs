import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { HttpError, sendJson, validateFileKey } from "./account-http.mjs";

const SAFE_TYPES = /^(image\/(png|jpeg|webp|gif|bmp|avif|tiff)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp3|wav|wave|x-wav|webm|ogg|mp4|aac|flac|x-flac)|application\/octet-stream)$/;
export function createFileStorage({ db, dataDir, maxUploadBytes, quotaBytes }) {
    const locks = new Map();
    let queued = 0;
    async function withLock(userId, operation) {
        if (queued >= 16) throw new HttpError(429, "UPLOAD_BUSY", "上传请求较多，请稍后重试。");
        queued++;
        const previous = locks.get(userId) || Promise.resolve();
        const task = previous.catch(() => {}).then(operation);
        locks.set(userId, task);
        try {
            return await task;
        } finally {
            queued--;
            if (locks.get(userId) === task) locks.delete(userId);
        }
    }
    const find = (userId, key) => db.prepare("SELECT * FROM files WHERE user_id=? AND storage_key=?").get(userId, key);
    const filePath = (userId, name) => join(dataDir, "uploads", userId, name);
    const list = (userId) => db.prepare("SELECT storage_key AS storageKey,mime_type AS mimeType,bytes FROM files WHERE user_id=?").all(userId);
    async function upload(req, res, userId, key) {
        validateFileKey(key);
        const mimeType = (req.headers["content-type"] || "application/octet-stream").split(";")[0].toLowerCase();
        if (!SAFE_TYPES.test(mimeType)) throw new HttpError(415, "UNSAFE_MEDIA_TYPE", "不支持此文件类型。HTML 和 SVG 等可执行内容不能作为媒体上传。");
        return withLock(userId, async () => {
            const old = find(userId, key);
            const used = db.prepare("SELECT coalesce(sum(bytes),0) AS bytes FROM files WHERE user_id=?").get(userId).bytes;
            const limit = Math.min(maxUploadBytes, quotaBytes - used + (old?.bytes || 0));
            const declared = Number(req.headers["content-length"]);
            if (Number.isFinite(declared) && declared > limit) {
                req.resume();
                throw new HttpError(413, "FILE_QUOTA", "文件超过上传限制或账号存储配额。");
            }
            const directory = join(dataDir, "uploads", userId);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const name = randomUUID();
            const temporary = join(directory, name + ".part");
            const destination = join(directory, name);
            const handle = await open(temporary, "wx", 0o600);
            let bytes = 0;
            try {
                for await (const chunk of req.iterator({ destroyOnReturn: false })) {
                    bytes += chunk.length;
                    if (bytes > limit) {
                        req.resume();
                        throw new HttpError(413, "FILE_QUOTA", "文件超过上传限制或账号存储配额。");
                    }
                    await handle.writeFile(chunk);
                }
                await handle.sync();
                await handle.close();
                await rename(temporary, destination);
                db.prepare("INSERT INTO files (user_id,storage_key,path,mime_type,bytes) VALUES (?,?,?,?,?) ON CONFLICT(user_id,storage_key) DO UPDATE SET path=excluded.path,mime_type=excluded.mime_type,bytes=excluded.bytes").run(
                    userId,
                    key,
                    name,
                    mimeType,
                    bytes,
                );
            } catch (error) {
                await handle.close().catch(() => {});
                await rm(temporary, { force: true }).catch(() => {});
                await rm(destination, { force: true }).catch(() => {});
                throw error;
            }
            if (old) await rm(filePath(userId, old.path), { force: true }).catch(() => {});
            sendJson(res, 200, { storageKey: key, mimeType, bytes });
        });
    }
    async function download(req, res, userId, key) {
        const file = find(userId, key);
        if (!file) throw new HttpError(404, "FILE_NOT_FOUND", "文件不存在。");
        const path = filePath(userId, file.path);
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) throw new HttpError(404, "FILE_NOT_FOUND", "文件不存在，请检查服务器数据卷。");
        let start = 0,
            end = info.size - 1,
            status = 200;
        const range = req.headers.range;
        if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!match || (!match[1] && !match[2])) throw new HttpError(416, "INVALID_RANGE", "无效的文件范围。");
            start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
            end = match[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
                res.setHeader("content-range", `bytes */${info.size}`);
                throw new HttpError(416, "INVALID_RANGE", "无效的文件范围。");
            }
            status = 206;
        }
        res.writeHead(status, {
            "content-type": file.mime_type,
            "content-length": Math.max(0, end - start + 1),
            "accept-ranges": "bytes",
            ...(status === 206 && { "content-range": `bytes ${start}-${end}/${info.size}` }),
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            "content-disposition": `${file.mime_type === "application/octet-stream" ? "attachment" : "inline"}; filename="${file.path}"`,
        });
        if (req.method === "HEAD" || info.size === 0) {
            res.end();
            return;
        }
        await pipeline(createReadStream(path, { start, end }), res);
    }
    async function remove(userId, key) {
        return withLock(userId, async () => {
            const file = find(userId, key);
            if (!file) return;
            db.prepare("DELETE FROM files WHERE user_id=? AND storage_key=?").run(userId, key);
            await rm(filePath(userId, file.path), { force: true });
        });
    }
    return { list, upload, download, remove, settled: () => Promise.allSettled([...locks.values()]) };
}
