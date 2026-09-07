import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { HttpError } from "./account-http.mjs";

const scrypt = promisify(scryptCallback);
const OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE = "atelier_session";
let activeHashes = 0;

async function derive(password, salt) {
    if (activeHashes >= 4) throw new HttpError(429, "AUTH_BUSY", "登录请求较多，请稍后重试。");
    activeHashes++;
    try {
        return await scrypt(password, salt, 64, OPTIONS);
    } finally {
        activeHashes--;
    }
}
export function validatePassword(value) {
    if (typeof value !== "string" || value.length < 10 || value.length > 128) throw new HttpError(400, "INVALID_PASSWORD", "密码长度须为 10–128 个字符。");
}
export function validateUsername(value) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_.-]{3,40}$/.test(value.trim())) throw new HttpError(400, "INVALID_USERNAME", "用户名须为 3–40 位字母、数字、下划线、点或短横线。");
    return value.trim().toLowerCase();
}
export async function hashPassword(password) {
    validatePassword(password);
    const salt = randomBytes(16).toString("hex");
    return `scrypt:${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password, hash) {
    if (typeof password !== "string" || password.length > 128) return false;
    const [, salt, stored] = (hash || "").split(":");
    const actual = await derive(password, salt || "00000000000000000000000000000000");
    const expected = Buffer.from(stored || "00".repeat(64), "hex");
    return Boolean(hash) && expected.length === actual.length && timingSafeEqual(actual, expected);
}
export const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
export function getSessionToken(req) {
    const pair = (req.headers.cookie || "")
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith(COOKIE + "="));
    const token = pair?.slice(COOKIE.length + 1);
    return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export function publicUser(user) {
    return { id: user.id, username: user.username, displayName: user.display_name, avatarUrl: "" };
}
export function issueSession(database, res, userId, secure) {
    const token = randomBytes(32).toString("hex");
    database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    database.prepare("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)").run(tokenHash(token), userId, Date.now() + SESSION_MS);
    res.setHeader("set-cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? "; Secure" : ""}`);
}
export function clearCookie(res, secure) {
    res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`);
}
export function getSessionUser(database, req) {
    const token = getSessionToken(req);
    if (!token) return null;
    return database.prepare("SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?").get(tokenHash(token), Date.now()) || null;
}

export function createRateLimiter() {
    const entries = new Map();
    return (key, limit = 15, windowMs = 15 * 60 * 1000) => {
        const now = Date.now();
        for (const [id, entry] of entries) if (entry.until <= now) entries.delete(id);
        const entry = entries.get(key) || { count: 0, until: now + windowMs };
        if (entries.size > 10000 || ++entry.count > limit) throw new HttpError(429, "RATE_LIMITED", "尝试次数过多，请稍后再试。");
        entries.set(key, entry);
    };
}
