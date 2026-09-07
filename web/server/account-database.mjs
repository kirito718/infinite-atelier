import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError, validateFileKey, validateStateKey, validateStateValue } from "./account-http.mjs";

export function openAccountDatabase(dataDir, configuredKey = process.env.ATELIER_ENCRYPTION_KEY) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, "atelier.sqlite");
    const keyPath = join(dataDir, "encryption.key");
    if (!configuredKey && !existsSync(keyPath)) {
        if (existsSync(path)) throw new Error("Persistent encryption.key is missing. Restore the original key before starting.");
        try {
            writeFileSync(keyPath, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
    }
    const hex = configuredKey || readFileSync(keyPath, "utf8").trim();
    if (!/^[a-fA-F0-9]{64}$/.test(hex)) throw new Error("ATELIER_ENCRYPTION_KEY must be a 64-character hex key.");
    const key = Buffer.from(hex, "hex");
    const db = new Database(path);
    try {
        chmodSync(path, 0o600);
        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");
        db.pragma("busy_timeout = 5000");
        if (db.pragma("user_version", { simple: true }) > 1) throw new Error("This data directory requires a newer application version.");
        db.exec(`
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
            CREATE TABLE IF NOT EXISTS documents (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT, revision INTEGER NOT NULL, PRIMARY KEY(user_id,key));
            CREATE TABLE IF NOT EXISTS files (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, storage_key TEXT NOT NULL, path TEXT NOT NULL, mime_type TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(user_id,storage_key));
            CREATE TABLE IF NOT EXISTS imports (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, migration_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,migration_id));
            PRAGMA user_version = 1;
        `);
        const fingerprint = createHash("sha256").update(key).digest("hex");
        const stored = db.prepare("SELECT value FROM metadata WHERE key='key_fingerprint'").get();
        if (stored && stored.value !== fingerprint) throw new Error("Encryption key does not match this database. Restore the original key.");
        db.prepare("INSERT OR IGNORE INTO metadata (key,value) VALUES ('key_fingerprint',?)").run(fingerprint);
    } catch (error) {
        db.close();
        throw error;
    }

    function seal(userId, name, value) {
        if (value === null) return null;
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(Buffer.from(userId + "\0" + name));
        const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return `v1:${nonce.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
    }
    function unseal(userId, name, value) {
        if (value === null) return null;
        const [version, nonce, tag, data] = value.split(":");
        if (version !== "v1") throw new Error("Unsupported encrypted document");
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"));
        decipher.setAAD(Buffer.from(userId + "\0" + name));
        decipher.setAuthTag(Buffer.from(tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    }
    function readState(userId, name) {
        const row = db.prepare("SELECT value,revision FROM documents WHERE user_id=? AND key=?").get(userId, name);
        return row ? { value: unseal(userId, name, row.value), revision: row.revision } : { value: null, revision: 0 };
    }
    function listStates(userId) {
        return db
            .prepare("SELECT key,value,revision FROM documents WHERE user_id=?")
            .all(userId)
            .map((row) => ({ ...row, value: unseal(userId, row.key, row.value) }));
    }
    const writeState = db.transaction((userId, name, value, expectedRevision) => {
        validateStateKey(name);
        validateStateValue(value);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new HttpError(400, "INVALID_REVISION", "缺少有效的数据版本号。");
        const current = db.prepare("SELECT revision,length(value) AS bytes FROM documents WHERE user_id=? AND key=?").get(userId, name);
        if ((current?.revision || 0) !== expectedRevision) throw new HttpError(409, "CONFLICT", "数据已在另一页面更新。请先导出未保存内容，再刷新加载新版本。");
        const encrypted = seal(userId, name, value);
        const usage = db.prepare("SELECT count(*) AS count,coalesce(sum(length(value)),0) AS bytes FROM documents WHERE user_id=?").get(userId);
        if ((!current && usage.count >= 256) || usage.bytes - (current?.bytes || 0) + (encrypted?.length || 0) > 128 * 1024 * 1024) throw new HttpError(413, "STATE_QUOTA", "账号文档存储已达到上限。");
        const revision = expectedRevision + 1;
        db.prepare("INSERT INTO documents (user_id,key,value,revision) VALUES (?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,revision=excluded.revision").run(userId, name, encrypted, revision);
        return { revision };
    });
    function requireReferencedFiles(userId, entries) {
        const referenced = new Set();
        for (const { value } of entries) {
            const stack = [value === null ? null : JSON.parse(value)];
            while (stack.length) {
                const item = stack.pop();
                if (!item || typeof item !== "object") continue;
                if (typeof item.storageKey === "string" && item.storageKey.length > 0) {
                    validateFileKey(item.storageKey);
                    referenced.add(item.storageKey);
                }
                for (const child of Object.values(item)) if (child && typeof child === "object") stack.push(child);
            }
        }
        for (const fileKey of referenced) if (!db.prepare("SELECT 1 FROM files WHERE user_id=? AND storage_key=?").get(userId, fileKey)) throw new HttpError(400, "MISSING_FILE", "迁移引用的媒体文件尚未上传。原有数据不会被删除。");
    }
    const restoreStates = db.transaction((userId, entries) => {
        requireReferencedFiles(userId, entries);
        const revisions = entries.map(({ key, value, expectedRevision }) => ({ key, ...writeState(userId, key, value, expectedRevision) }));
        return { restored: true, revisions };
    });
    const importStates = db.transaction((userId, migrationId, entries) => {
        if (db.prepare("SELECT 1 FROM imports WHERE user_id=? AND migration_id=?").get(userId, migrationId)) return { imported: true, alreadyImported: true };
        if (db.prepare("SELECT 1 FROM documents WHERE user_id=? AND value IS NOT NULL LIMIT 1").get(userId)) throw new HttpError(409, "IMPORT_NOT_EMPTY", "当前账号已有数据，导入不会覆盖它。请使用空账号迁移。");
        requireReferencedFiles(userId, entries);
        for (const { key: name, value } of entries) writeState(userId, name, value, readState(userId, name).revision);
        db.prepare("INSERT INTO imports (user_id,migration_id,created_at) VALUES (?,?,?)").run(userId, migrationId, Date.now());
        return { imported: true, alreadyImported: false };
    });
    return { db, readState, listStates, writeState, importStates, restoreStates, close: () => db.close() };
}
