import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = resolve(webDir, "node_modules/vite/bin/vite.js");
const preview = process.argv.includes("--preview");

await access(viteBin, constants.X_OK);

const vite = spawn(process.execPath, [viteBin, ...(preview ? ["preview"] : []), "--host", "127.0.0.1", "--port", "3000"], {
    cwd: webDir,
    env: process.env,
    stdio: "inherit",
});

let shuttingDown = false;
function stopChild(child) {
    if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
}

async function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    stopChild(vite);
    process.exitCode = exitCode;
}

vite.once("error", () => void shutdown(1));
vite.once("exit", (code) => {
    if (!shuttingDown) void shutdown(code || 0);
});
process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
