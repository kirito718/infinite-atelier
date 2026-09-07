import { existsSync, realpathSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function canonicalPath(value) {
    let parent = resolve(value);
    const missing = [];
    while (!existsSync(parent)) {
        missing.unshift(basename(parent));
        const next = dirname(parent);
        if (next === parent) throw new Error("Cannot resolve data directory.");
        parent = next;
    }
    return resolve(realpathSync(parent), ...missing);
}
function contains(parent, child) {
    const path = relative(parent, child);
    return path === "" || (!path.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) && path !== ".." && !isAbsolute(path));
}

// publicDir and preview static serving intentionally bypass Vite fs.deny. Reject
// unsafe layouts before starting Vite, including paths through symlink ancestors.
export function resolveAccountDataDir(value = process.env.ATELIER_DATA_DIR, { appRoot = webDir } = {}) {
    value ||= join(appRoot, "data");
    const original = resolve(value);
    const directory = canonicalPath(value);
    const app = canonicalPath(appRoot);
    const publicDir = canonicalPath(join(appRoot, "public"));
    const buildDir = canonicalPath(join(appRoot, "dist"));
    if (contains(resolve(appRoot, "public"), original) || contains(resolve(appRoot, "dist"), original) || contains(original, resolve(appRoot)) || contains(publicDir, directory) || contains(buildDir, directory) || contains(directory, app)) {
        throw new Error("Unsafe data directory: use a private directory outside public/dist and do not contain the application root.");
    }
    // An outward public symlink can expose even a correctly configured external
    // directory. Inspect static-tree aliases without traversing external targets.
    const pending = [join(appRoot, "public"), join(appRoot, "dist")];
    while (pending.length) {
        const path = pending.pop();
        if (!existsSync(path)) continue;
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const child = join(path, entry.name);
            if (entry.isSymbolicLink()) {
                let target;
                try {
                    target = realpathSync(child);
                } catch {
                    throw new Error("Unsafe data directory: repair or remove unresolved symbolic links in public/build directories before starting.");
                }
                if (contains(directory, target) || contains(target, directory)) throw new Error("Unsafe data directory: a public/build symlink exposes private storage.");
            } else if (entry.isDirectory()) pending.push(child);
        }
    }
    return directory;
}
