#!/usr/bin/env node
// Real Docker acceptance, not a Docker emulator. Requires Node >=22.12, Compose v2, and a POSIX host (macOS/Linux/WSL).
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const check = (condition, label) => {
    if (!condition) throw new Error(label);
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
const LABEL = "com.docker.compose.";
const CONTAINER_ENV = {
    ATELIER_DATA_DIR: "/data",
    ATELIER_PUBLIC_URL: "",
    ATELIER_ALLOW_REGISTRATION: "false",
    ATELIER_SECURE_COOKIES: "false",
    ATELIER_ALLOW_PRIVATE_UPSTREAMS: "false",
    ATELIER_MAX_UPLOAD_BYTES: "65536",
    ATELIER_USER_QUOTA_BYTES: "262144",
};
export function parseOptions(argv) {
    const options = { image: null, keep: false, keepFailed: false, help: false },
        seen = new Set();
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        check(!seen.has(flag), "Duplicate option");
        seen.add(flag);
        if (flag === "--image") {
            const image = argv[++i];
            check(typeof image === "string" && image.length <= 512 && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*(?:@sha256:[a-f0-9]{64})?$/.test(image), "Invalid --image reference");
            options.image = image;
        } else if (flag === "--keep") options.keep = true;
        else if (flag === "--keep-failed") options.keepFailed = true;
        else if (flag === "--help") options.help = true;
        else throw new Error("Unknown argument (use --help)");
    }
    return options;
}
export const testEnvironment = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !/^(ATELIER_|COMPOSE_)/.test(key) && key !== "CODEX_CLI_VERSION"));
export function composeArgs({ root, project, envFile, override }, tail) {
    return ["compose", "--ansi", "never", "--project-directory", root, "--project-name", project, "--env-file", envFile, "-f", join(root, "compose.yaml"), ...(override ? ["-f", override] : []), ...tail];
}
export function verifyCompose(c, project) {
    const s = c.services?.atelier,
        v = s?.volumes,
        p = s?.ports;
    check(c.name === project && Object.keys(c.services || {}).join() === "atelier", "Unexpected Compose project/services");
    check(!s.container_name && !s.network_mode && !s.privileged && !s.devices && !s.volumes_from && !s.pid && !s.ipc && !s.uts && !s.configs && !s.secrets && !s.external_links, "Unsafe Compose service isolation");
    check(p?.length === 1 && p[0].target === 3000 && String(p[0].published) === "0" && p[0].host_ip === "127.0.0.1" && p[0].protocol === "tcp", "Expected ephemeral localhost port");
    check(v?.length === 1 && v[0].type === "volume" && v[0].source === "atelier-data" && v[0].target === "/data" && !v[0].read_only, "Expected original writable data volume");
    for (const [kind, name] of [
        ["volumes", "atelier-data"],
        ["networks", "default"],
    ]) {
        check(Object.keys(c[kind] || {}).join() === name && !c[kind][name].external && !c[kind][name].driver_opts && c[kind][name].name === `${project}_${name}`, "Unsafe Compose resource name");
    }
    check(Object.keys(s.networks || {}).join() === "default", "Unexpected Compose networks");
    check(
        Object.keys(s.environment || {})
            .sort()
            .join() === Object.keys(CONTAINER_ENV).sort().join() && Object.entries(CONTAINER_ENV).every(([key, value]) => (key === "ATELIER_ALLOW_REGISTRATION" ? ["false", "true"].includes(s.environment[key]) : s.environment[key] === value)),
        "Unexpected Compose test environment",
    );
}
export function verifyResource(item, kind, project) {
    const labels = kind === "container" ? item.Config?.Labels : item.Labels;
    check(labels?.[LABEL + "project"] === project, "Refusing resource without exact project ownership");
    if (kind === "container") check(labels[LABEL + "service"] === "atelier" && /^[a-f0-9]{64}$/.test(item.Id), "Refusing unexpected container");
    else {
        const name = kind === "volume" ? "atelier-data" : "default";
        check(item.Name === `${project}_${name}` && labels[LABEL + kind] === name, "Refusing unexpected named resource");
    }
}
export function safeDiagnostic(text, secrets = []) {
    for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
    return text
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
        .split("\n")
        .map((line) =>
            /password|cookie|authorization|bearer|api.?key|encryption.?key|token|credential|secret/i.test(line)
                ? "[sensitive diagnostic omitted]"
                : line.replace(/\b([a-z][a-z0-9+.-]{0,15}:\/\/)[^\s/@]+@/gi, "$1[redacted]@").replace(/\b[a-fA-F0-9]{32,}\b/g, "[digest omitted]"),
        )
        .join("\n")
        .slice(-16000);
}
const PROCESS_STOP_MS = 2000;
const groupExists = (pid) => {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
    }
};
// Only PID/group/state are read, never command lines or environments. A killed
// orphan can remain a zombie until init reaps it; it cannot perform more work.
// On Linux include threads: a zombie thread leader alone is not sufficient.
const groupMembers = (pid, timeout) =>
    new Promise((resolvePromise) => {
        execFile("/bin/ps", ["-A", ...(process.platform === "linux" ? ["-L"] : []), "-o", "pid=,pgid=,stat="], { timeout, maxBuffer: 1024 * 1024, shell: false, killSignal: "SIGKILL" }, (error, stdout) => {
            if (error) return resolvePromise(null);
            const rows = stdout
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line));
            if (rows.some((row) => !row)) return resolvePromise(null);
            resolvePromise(rows.filter((row) => Number(row[2]) === pid).map((row) => ({ pid: Number(row[1]), zombie: /^[ZX]/.test(row[3]) })));
        });
    });
async function stopProcessTree(child, isClosed) {
    const pid = child.pid,
        started = performance.now(),
        deadline = started + PROCESS_STOP_MS;
    const evidence = { pid: pid || null, strategy: process.platform === "win32" ? "taskkill-owned-tree" : "posix-process-group", confirmed: false };
    if (!pid) return { ...evidence, confirmed: true, state: "not-started" };
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return { ...evidence, state: "invalid-owned-pid" };
    if (process.platform === "win32") {
        // Never kill by image/name, and never target a root already observed to
        // exit (its PID could be reused). Native Node has no Windows Job handle:
        // /T is a scoped best effort, NOT proof that every descendant has exited.
        if (child.exitCode === null && child.signalCode === null) {
            const binary = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
            evidence.taskkill = await new Promise((resolvePromise) => {
                execFile(binary, ["/PID", String(pid), "/T", "/F"], { timeout: PROCESS_STOP_MS, maxBuffer: 4096, shell: false, windowsHide: true, killSignal: "SIGKILL" }, (error) => {
                    resolvePromise(error ? String(error.code || error.signal || "failed") : "completed");
                });
            });
        }
        evidence.state = "windows-tree-unverified";
    } else {
        // detached:true below creates a new session/group whose leader is this
        // exact child. Signal that owned group ONCE; never enumerate PIDs to kill.
        try {
            process.kill(-pid, "SIGKILL");
        } catch (error) {
            if (error.code !== "ESRCH") evidence.signalError = error.code || "unknown";
        }
    }
    do {
        if (process.platform !== "win32")
            try {
                if (!groupExists(pid)) {
                    if (isClosed()) {
                        evidence.confirmed = true;
                        evidence.state = "gone";
                        break;
                    }
                } else if (isClosed()) {
                    const members = await groupMembers(pid, Math.max(1, Math.min(250, Math.ceil(deadline - performance.now()))));
                    if (members) {
                        evidence.livePids = [...new Set(members.filter((member) => !member.zombie).map((member) => member.pid))].slice(0, 32);
                        evidence.zombies = members.filter((member) => member.zombie).length;
                        if (members.length && members.every((member) => member.zombie)) {
                            evidence.confirmed = true;
                            evidence.state = "zombies-only";
                            break;
                        }
                    } else evidence.checkError = "process-table-unavailable";
                }
            } catch (error) {
                evidence.checkError = error.code || "group-check-failed";
            }
        if (process.platform === "win32" && isClosed()) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    } while (performance.now() < deadline);
    evidence.closed = isClosed();
    evidence.elapsedMs = Math.ceil(performance.now() - started);
    evidence.state ||= "termination-unconfirmed";
    return evidence;
}
// Supervise the foreground CLI process group. This is not a sandbox for
// executables that intentionally daemonize or detach into a different session.
export function runProcess(binary, args, { input = "", timeout = 30000, maxBuffer = 2 * 1024 * 1024, env, cwd, signal } = {}) {
    return new Promise((resolvePromise, reject) => {
        const output = { stdout: { parts: [], bytes: 0 }, stderr: { parts: [], bytes: 0 } };
        const text = (name) => Buffer.concat(output[name].parts, output[name].bytes).toString("utf8");
        const failure = (code, termination) => {
            const error = new Error(`Command failed (${code})${termination.confirmed ? "" : "; process tree termination unconfirmed"}`);
            error.diagnostic = text("stdout") + "\n" + text("stderr");
            error.termination = termination;
            return error;
        };
        if (signal?.aborted) return reject(failure("ABORT_ERR", { confirmed: true, state: "not-started", pid: null }));
        check(Number.isSafeInteger(timeout) && timeout > 0 && Number.isSafeInteger(maxBuffer) && maxBuffer >= 0, "Invalid process bounds");
        let child;
        try {
            child = spawn(binary, args, { env, cwd, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        } catch (error) {
            return reject(failure(error.code || "spawn-failed", { confirmed: true, state: "not-started", pid: null }));
        }
        let closed = false,
            stopping = false,
            settled = false,
            quiescent = false,
            timer;
        const dispose = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
        };
        const stop = async (code) => {
            if (stopping || settled) return;
            stopping = true;
            dispose();
            child.stdin?.destroy();
            let termination;
            try {
                termination = quiescent ? { pid: child.pid, strategy: "posix-process-group", confirmed: true, state: "gone" } : await stopProcessTree(child, () => closed);
            } catch (error) {
                termination = { pid: child.pid || null, confirmed: false, state: "shutdown-check-failed", checkError: error.code || "unknown" };
            }
            // An unkillable/unknown child must not hold the runner open forever.
            // The evidence blocks project cleanup rather than falsely certifying it.
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
            settled = true;
            reject(failure(code, termination));
        };
        const abort = () => {
            void stop("ABORT_ERR");
        };
        for (const name of ["stdout", "stderr"])
            child[name]?.on("data", (chunk) => {
                const remaining = maxBuffer - output[name].bytes,
                    count = Math.min(remaining, chunk.length);
                if (count) {
                    output[name].parts.push(chunk.subarray(0, count));
                    output[name].bytes += count;
                }
                if (chunk.length > remaining) void stop("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
            });
        child.on("error", (error) => {
            void stop(error.code || "spawn-failed");
        });
        child.on("exit", (code, killedBy) => {
            if (stopping || settled) return;
            if (process.platform !== "win32")
                try {
                    quiescent = !groupExists(child.pid);
                } catch {
                    return void stop(code || killedBy || "ERR_PROCESS_GROUP_STATUS");
                }
            if (code !== 0) return void stop(code || killedBy || "unknown");
            // Without a Windows Job handle, direct-child exit is not proof of
            // tree quiescence either. Fail closed; use WSL for verified runs.
            if (process.platform === "win32") return void stop("ERR_WINDOWS_TREE_UNVERIFIED");
            // A wrapper exiting successfully is not permission to leave a plugin
            // behind. A group with descendants still running is a failed command.
            if (!quiescent) void stop("ERR_PROCESS_DESCENDANTS");
        });
        child.on("close", (code, killedBy) => {
            closed = true;
            if (stopping || settled) return;
            if (code !== 0) return void stop(code || killedBy || "unknown");
            if (!quiescent) return void stop("ERR_PROCESS_GROUP_STATUS");
            dispose();
            settled = true;
            resolvePromise({ stdout: text("stdout"), stderr: text("stderr") });
        });
        timer = setTimeout(() => {
            void stop("ETIMEDOUT");
        }, timeout);
        signal?.addEventListener("abort", abort, { once: true });
        child.stdin?.on("error", () => {});
        child.stdin?.end(input);
        if (signal?.aborted) abort();
    });
}
async function fetchBytes(url, options = {}, signal) {
    const response = await fetch(url, { ...options, redirect: "error", cache: "no-store", signal: AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]) });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
        size += chunk.length;
        check(size <= 256 * 1024, "HTTP response exceeded acceptance bound");
        chunks.push(chunk);
    }
    return { status: response.status, headers: response.headers, bytes: Buffer.concat(chunks) };
}
export async function gatedFetch(base, probe, path, options = {}, signal) {
    check(probe?.path && probe.nonce, "Missing container probe");
    check(/^http:\/\/127\.0\.0\.1:\d+$/.test(base) && path.startsWith("/") && !path.startsWith("//") && new URL(path, base).origin === base, "Unsafe HTTP destination");
    const proof = await fetchBytes(base + probe.path, {}, signal);
    check(proof.status === 200 && proof.bytes.toString() === probe.nonce, "Container probe mismatch: no credentials or writes sent");
    return fetchBytes(base + path, options, signal);
}

async function resources(docker, project) {
    const found = {};
    for (const kind of ["container", "network", "volume"]) {
        const listed = await docker([kind, "ls", "--quiet", ...(kind === "container" ? ["--all", "--no-trunc"] : []), "--filter", `label=${LABEL}project=${project}`]);
        const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
        check(ids.length <= 8 && ids.every((id) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)), "Unexpected resource inventory");
        found[kind] = ids.length ? JSON.parse((await docker([kind, "inspect", ...ids])).stdout) : [];
        found[kind].forEach((item) => verifyResource(item, kind, project));
    }
    return found;
}
// Also used by the exact cleanup command in report.json; re-check ownership before deleting anything.
export async function cleanupProject(paths, docker = (args, options) => runProcess(process.env.DOCKER_BIN || "docker", args, { env: testEnvironment(process.env), ...options })) {
    const assertStopped = () => check(!paths.processTerminationIssues?.some((issue) => !issue.confirmed), "Cleanup blocked: command-tree termination is unconfirmed");
    assertStopped();
    check(/^atelier-acceptance-[a-z0-9-]+$/.test(paths.project), "Refusing non-acceptance project");
    verifyCompose(JSON.parse((await docker(composeArgs(paths, ["config", "--format", "json"]))).stdout), paths.project);
    const owned = await resources(docker, paths.project);
    if (owned.container.length || owned.network.length) {
        check(owned.network.length === 1, "Refusing down without a positively identified project network");
        assertStopped();
        await docker(composeArgs(paths, ["down", "--timeout", "10"]), { timeout: 60000 }); // Intentionally never -v.
    }
    for (const volume of owned.volume) {
        verifyResource(JSON.parse((await docker(["volume", "inspect", volume.Name])).stdout)[0], "volume", paths.project);
        assertStopped();
        await docker(["volume", "rm", volume.Name]);
    }
    const remaining = await resources(docker, paths.project);
    assertStopped();
    check(
        Object.values(remaining).every((items) => !items.length),
        "Owned resources remain after cleanup",
    );
}
const WEB = `const fs = await import('node:fs'), path = await import('node:path'), crypto = await import('node:crypto');
const p = JSON.parse(fs.readFileSync(0, 'utf8'));
const web = [process.cwd(), path.join(process.cwd(), 'web')].find(dir => fs.existsSync(path.join(dir, 'dist/index.html')));
if (!web) throw new Error('Container dist directory not found');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');`;
const AUDIT =
    WEB +
    `
const { createRequire } = await import('node:module');
const Database = createRequire(path.join(web, 'package.json'))('better-sqlite3');
const db = new Database('/data/atelier.sqlite', { readonly: true });
const key = fs.readFileSync('/data/encryption.key', 'utf8').trim(), fingerprint = hash(Buffer.from(key, 'hex'));
const marker = '/data/' + p.marker;
if (p.seedKey) fs.writeFileSync(marker, fingerprint, { flag: 'wx', mode: 0o600 });
const result = { uid1000: process.getuid() === 1000 && /^Uid:\\s+1000\\s+1000\\s/m.test(fs.readFileSync('/proc/1/status', 'utf8')),
    nativeSqlite: Boolean(db.prepare('SELECT sqlite_version() AS v').get().v),
    keySurvived: /^[a-f0-9]{64}$/.test(key) && fs.readFileSync(marker, 'utf8') === fingerprint && db.prepare("SELECT value FROM metadata WHERE key='key_fingerprint'").get().value === fingerprint,
    privateStorage: ['/data', '/data/encryption.key', '/data/atelier.sqlite'].every(file => fs.statSync(file).uid === 1000) && (fs.statSync('/data/encryption.key').mode & 0o777) === 0o600 };
const ids = p.accounts.map(a => a.id), users = db.prepare('SELECT * FROM users').all(), sessions = db.prepare('SELECT * FROM sessions').all();
result.exactUsers = users.length === ids.length && users.every(user => ids.includes(user.id));
result.passwordDigests = p.accounts.every(a => {
    const stored = users.find(u => u.id === a.id)?.password_hash || '', [, salt, digest] = stored.split(':');
    return /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored) && !stored.includes(a.password) && crypto.scryptSync(a.password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 67108864 }).toString('hex') === digest;
});
const tokens = p.accounts.flatMap(a => a.tokens);
result.sessionDigests = sessions.length === tokens.length && sessions.every(s => /^[a-f0-9]{64}$/.test(s.token_hash) && !tokens.includes(s.token_hash)) &&
    p.accounts.every(a => a.tokens.every(token => sessions.some(s => s.user_id === a.id && s.token_hash === hash(token) && s.expires_at > Date.now())));
const sealed = db.prepare('SELECT value FROM documents WHERE user_id=? AND key=?').get(p.accounts[0].id, p.configKey)?.value || '';
result.configEncrypted = sealed.startsWith('v1:') && !sealed.includes(p.configValue) && !sealed.includes(p.configSecret);
try { const [, nonce, tag, data] = sealed.split(':'), decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(nonce, 'base64'));
    decipher.setAAD(Buffer.from(p.accounts[0].id + '\\0' + p.configKey)); decipher.setAuthTag(Buffer.from(tag, 'base64'));
    result.configDecrypts = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString() === p.configValue;
} catch { result.configDecrypts = false; }
const homes = p.accounts.map(a => '/data/codex/' + a.id);
result.distinctCodexHomes = new Set(homes.map(home => fs.realpathSync(home))).size === homes.length && homes.every(home => fs.realpathSync(home) === home && fs.statSync(home).uid === 1000);
result.codexSentinels = p.accounts.every(a => { const file = '/data/codex/' + a.id + '/' + p.marker;
    if (p.seedHomes.includes(a.id)) fs.writeFileSync(file, a.sentinel, { flag: 'wx', mode: 0o600 });
    return fs.readFileSync(file, 'utf8') === a.sentinel; });
result.fileOwners = db.prepare('SELECT * FROM files').all().every(f => ids.includes(f.user_id) && !f.path.includes('/') && fs.statSync('/data/uploads/' + f.user_id + '/' + f.path).uid === 1000);
db.close(); console.log(JSON.stringify(result));`;

async function main(options) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const run = new Date().toISOString().replace(/[-:.]/g, "").toLowerCase() + "-" + randomBytes(8).toString("hex");
    const project = "atelier-acceptance-" + run,
        directory = join(root, "web/output/container-acceptance", run);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const paths = { root, project, processTerminationIssues: [], envFile: join(directory, "acceptance.env"), ...(options.image ? { override: join(directory, "image.compose.json") } : {}) };
    const reportFile = join(directory, "report.json"),
        env = testEnvironment(process.env),
        binary = process.env.DOCKER_BIN || "docker";
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    const cleanupCommand = "node --input-type=module -e " + quote(`import { cleanupProject } from ${JSON.stringify(import.meta.url)}; await cleanupProject(${JSON.stringify(paths)});`);
    const report = {
        schema: 1,
        status: "running",
        startedAt: new Date().toISOString(),
        project,
        compose: join(root, "compose.yaml"),
        envFile: paths.envFile,
        override: paths.override || null,
        mode: options.image ? "local-image" : "compose-build",
        cleanupCommand,
        cleanupEnvironment: "Reuse the same DOCKER_BIN/DOCKER_HOST/DOCKER_CONFIG or context; values are intentionally not recorded.",
        processTerminationIssues: paths.processTerminationIssues,
        limits: { totalMs: 1200000, finalizeMs: 120000, buildMs: 600000, httpMs: 45000, responseBytes: 262144, processStopMs: PROCESS_STOP_MS },
        checks: [],
        commands: [],
        http: [],
        containers: [],
        probes: [],
        audits: [],
        codex: [],
    };
    const secrets = [],
        controller = new AbortController();
    const interrupt = () => controller.abort(),
        timer = setTimeout(interrupt, report.limits.totalMs);
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    let ownsProject = false,
        finalizing = false,
        finalSignal,
        container,
        base,
        probe,
        expectedImage;
    const finalize = () => {
        if (!finalizing) {
            finalizing = true;
            finalSignal = AbortSignal.timeout(report.limits.finalizeMs);
        }
    };
    const save = () => writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    const docker = async (args, settings = {}) => {
        const started = Date.now(),
            event = { command: args.slice(0, 2).join(" ") };
        try {
            const result = await runProcess(binary, args, { env, cwd: root, signal: finalizing ? finalSignal : controller.signal, ...settings });
            event.ok = true;
            return result;
        } catch (error) {
            event.ok = false;
            event.error = safeDiagnostic(error.message, secrets);
            event.diagnostic = safeDiagnostic(error.diagnostic || "", secrets);
            if (error.termination) event.termination = error.termination;
            if (error.termination?.confirmed === false) paths.processTerminationIssues.push(error.termination);
            throw error;
        } finally {
            event.ms = Date.now() - started;
            report.commands.push(event);
        }
    };
    const compose = (args, settings) => docker(composeArgs(paths, args), settings);
    const step = async (label, action) => {
        report.currentStep = label;
        console.log("[container-acceptance] " + label);
        await save();
        await action();
        report.checks.push(label);
        await save();
    };
    const settings = { ATELIER_BIND_ADDRESS: "127.0.0.1", ATELIER_PORT: "0", ...CONTAINER_ENV };
    const writeEnv = () =>
        writeFile(
            paths.envFile,
            Object.entries(settings)
                .map(([key, value]) => `${key}=${value}`)
                .join("\n") + "\n",
            { mode: 0o600 },
        );
    const execNode = async (code, input) =>
        JSON.parse(
            (await docker(["exec", "-i", container.Id, "node", "--input-type=module", "-e", `try { ${code} } catch { console.error('Container inspection failed'); process.exitCode = 1; }`], { input: JSON.stringify(input), timeout: 45000 })).stdout,
        );
    const identity = (c) => ({
        id: c.Id,
        name: c.Name,
        image: c.Image,
        status: c.State.Status,
        running: c.State.Running,
        exitCode: c.State.ExitCode,
        oomKilled: c.State.OOMKilled,
        startedAt: c.State.StartedAt,
        finishedAt: c.State.FinishedAt,
        restarts: c.RestartCount,
        error: safeDiagnostic(c.State.Error || "", secrets),
        project: c.Config.Labels[LABEL + "project"],
        service: c.Config.Labels[LABEL + "service"],
    });
    async function start(first = false) {
        probe = null;
        const configuration = JSON.parse((await compose(["config", "--format", "json"])).stdout);
        verifyCompose(configuration, project);
        if (first && !options.image) check(configuration.services.atelier.build?.context === root, "Default build must use actual root context");
        await compose(["up", "-d", "--force-recreate", "--no-deps", ...(first && !options.image ? ["--build"] : ["--no-build", "--pull", "never"]), "atelier"], { timeout: first ? 600000 : 90000 });
        const owned = await resources(docker, project);
        check(owned.container.length === 1 && owned.volume.length === 1 && owned.network.length === 1, "Expected one owned container/network/volume");
        container = owned.container[0];
        report.containers.push(identity(container));
        check(container.State.Running, "Container is not running");
        check(
            JSON.stringify(container.Config.Env.filter((value) => value.startsWith("ATELIER_")).sort()) ===
                JSON.stringify(
                    Object.entries(configuration.services.atelier.environment)
                        .map(([key, value]) => `${key}=${value}`)
                        .sort(),
                ),
            "Unexpected effective Atelier environment",
        );
        check(container.Mounts.length === 1 && container.Mounts[0].Type === "volume" && container.Mounts[0].Name === `${project}_atelier-data` && container.Mounts[0].Destination === "/data" && container.Mounts[0].RW, "Unexpected container mounts");
        check(Object.keys(container.NetworkSettings.Networks).join() === `${project}_default`, "Unexpected container network");
        const binding = container.NetworkSettings.Ports["3000/tcp"];
        check(binding?.length === 1 && binding[0].HostIp === "127.0.0.1" && /^[0-9]+$/.test(binding[0].HostPort) && Number(binding[0].HostPort) > 0 && Number(binding[0].HostPort) <= 65535, "Expected mapped localhost port");
        if (expectedImage) check(container.Image === expectedImage, "Container image changed on recreation");
        expectedImage = container.Image;
        base = report.baseUrl = `http://127.0.0.1:${binding[0].HostPort}`;
        report.volume = owned.volume[0].Name;
        report.network = { name: owned.network[0].Name, id: owned.network[0].Id };
        report.testLimits = { maxUploadBytes: 65536, userQuotaBytes: 262144, registrationAllowed: settings.ATELIER_ALLOW_REGISTRATION === "true" };
        const image = JSON.parse((await docker(["image", "inspect", container.Image])).stdout)[0];
        report.image = { id: image.Id, os: image.Os, architecture: image.Architecture, repoDigests: image.RepoDigests || [] };
        probe = { path: "/acceptance-probe-" + randomBytes(16).toString("hex") + ".txt", nonce: randomBytes(24).toString("hex") };
        const entries = await execNode(
            WEB +
                `fs.writeFileSync(path.join(web, 'dist', p.path.slice(1)), p.nonce, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ node: process.version, main: hash(fs.readFileSync(path.join(web, 'dist/index.html'))), monoform: hash(fs.readFileSync(path.join(web, 'dist/monoform/index.html'))) }));`,
            probe,
        );
        const ready = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
        while (true) {
            let response;
            try {
                response = await fetchBytes(base + probe.path, {}, ready);
            } catch (error) {
                if (ready.aborted) throw error;
                await new Promise((r) => setTimeout(r, 500));
                continue;
            }
            check(response.status === 200 && response.bytes.toString() === probe.nonce, "Container probe mismatch; refusing host HTTP traffic");
            break;
        }
        report.probes.push({ containerId: container.Id, url: base + probe.path, nonce: probe.nonce, verifiedAt: new Date().toISOString() });
        report.nodeVersion = entries.node;
        for (const [path, digest] of [
            ["/", entries.main],
            ["/monoform/index.html", entries.monoform],
        ]) {
            const response = await api(path);
            report.frontends = [...(report.frontends || []), { containerId: container.Id, path, sha256: sha(response.bytes) }];
            check(response.headers.get("content-type")?.includes("text/html") && sha(response.bytes) === digest, "Frontend entrypoint does not match container dist");
        }
        check((await api("/api/account/health")).json.ok === true, "Account health failed");
        const version = (await docker(["exec", container.Id, "codex", "--version"])).stdout.trim();
        check(/^codex-cli \d+\.\d+\.\d+[-+.\w]*$/.test(version), "Installed Codex binary did not return its version");
        report.codexCliVersion = version;
    }
    async function api(path, { method = "GET", as, body, raw, headers = {} } = {}, expected = 200) {
        const response = await gatedFetch(
            base,
            probe,
            path,
            {
                method,
                headers: { origin: base, "x-atelier-request": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(as ? { cookie: as.cookie, "x-atelier-user": as.id } : {}), ...headers },
                body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
            },
            controller.signal,
        );
        const json = response.headers.get("content-type")?.includes("application/json") ? JSON.parse(response.bytes.toString()) : null;
        report.http.push({ method, path, status: response.status, ...(typeof json?.code === "string" && /^[A-Z_]+$/.test(json.code) ? { code: json.code } : {}) });
        check(response.status === expected, `HTTP ${method} ${path}: expected ${expected}, received ${response.status}`);
        return { ...response, json };
    }
    const accounts = [],
        configSecret = randomBytes(24).toString("hex");
    secrets.push(configSecret);
    const STATE = "infinite-canvas:canvas_store",
        CONFIG = "infinite-canvas:ai_config_store",
        MONO = "monoform-project",
        POSES = "monoform-custom-poses";
    const statePath = (key) => "/api/account/state/" + encodeURIComponent(key),
        FILE = "image:container-acceptance",
        filePath = "/api/account/files/" + encodeURIComponent(FILE);
    const payload = Buffer.from(Array.from({ length: 32768 }, (_, i) => (i * 31 + 17) % 256)),
        otherPayload = Buffer.from(payload.map((byte) => byte ^ 0xa5));
    const configValue = JSON.stringify({ state: { config: { channels: [{ apiKey: configSecret }] } }, version: 0 });
    let a,
        b,
        document = JSON.stringify({ state: { projects: [{ id: "acceptance-a", nodes: [{ storageKey: FILE }] }] }, version: 0 }),
        revision = 1;
    async function register(username) {
        const password = "acceptance-" + randomBytes(24).toString("hex");
        secrets.push(password);
        const created = await api("/api/account/register", { method: "POST", body: { username, password, displayName: username } }, 201);
        check(/^[a-f0-9-]{36}$/.test(created.json?.user?.id || "") && created.json.user.username === username, "Invalid registered identity");
        const account = { id: created.json.user.id, username, password, tokens: [], sentinel: randomBytes(24).toString("hex") };
        for (const response of [created, await api("/api/account/login", { method: "POST", body: { username, password } })]) {
            const header = response.headers.get("set-cookie") || "",
                cookie = header.split(";")[0],
                token = cookie.split("=")[1];
            secrets.push(header, cookie, token);
            check(/^atelier_session=[a-f0-9]{64}$/.test(cookie) && /; HttpOnly/i.test(header) && /; SameSite=Lax/i.test(header), "Missing protected session cookie");
            check(response.json.user.id === account.id, "Login changed account ownership");
            account.cookie = cookie;
            account.tokens.push(token);
        }
        accounts.push(account);
        return account;
    }
    async function codexStatus(account) {
        const status = (await api("/api/codex-subscription/v1/status", { as: account })).json?.status;
        report.codex.push({ userId: account.id, containerId: container.Id, status: ["disconnected", "connecting", "connected", "unavailable"].includes(status) ? status : "invalid" });
        check(status === "disconnected", "Real Codex app-server status must be disconnected (not unavailable)");
    }
    async function audit(seedKey = false, seedHomes = []) {
        const result = await execNode(AUDIT, { accounts, configKey: CONFIG, configValue, configSecret, marker: "acceptance-" + run, seedKey, seedHomes });
        check(Object.keys(result).length === 12 && Object.values(result).every((value) => typeof value === "boolean"), "Unexpected audit output; not stored");
        report.audits.push({ containerId: container.Id, ...result });
        check(Object.values(result).every(Boolean), "Container storage/identity/Codex-home audit failed; see boolean evidence");
    }
    async function readState(account, key, value, expectedRevision) {
        const data = (await api(statePath(key), { as: account })).json;
        check(data.value === value && data.revision === expectedRevision, "Document value/revision mismatch");
    }
    async function media(account, bytes) {
        const full = await api(filePath + "?account=" + account.id, { as: account });
        check(sha(full.bytes) === sha(bytes), "Private media checksum mismatch");
        const range = await api(filePath, { as: account, headers: { range: "bytes=17-4096" } }, 206);
        check(range.headers.get("content-range") === `bytes 17-4096/${bytes.length}` && sha(range.bytes) === sha(bytes.subarray(17, 4097)), "Private media range mismatch");
        const head = await api(filePath, { method: "HEAD", as: account });
        check(head.headers.get("content-length") === String(bytes.length) && head.bytes.length === 0, "Media HEAD mismatch");
        report.media = [...(report.media || []), { userId: account.id, bytes: full.bytes.length, sha256: sha(full.bytes), rangeSha256: sha(range.bytes) }];
    }
    async function persisted() {
        for (const account of accounts)
            for (const token of account.tokens) {
                check((await api("/api/account/session", { as: { ...account, cookie: "atelier_session=" + token } })).json.user?.id === account.id, "Old session did not survive");
            }
        await readState(a, STATE, document, revision);
        await readState(a, CONFIG, configValue, 1);
        await media(a, payload);
    }
    async function recreate() {
        probe = null;
        const live = await resources(docker, project);
        check(live.container.length === 1 && live.network.length === 1 && live.volume.length === 1, "Refusing recreate without identified project resources");
        await compose(["down", "--timeout", "10"], { timeout: 60000 }); // Keep the same named volume.
        const stopped = await resources(docker, project);
        check(!stopped.container.length && !stopped.network.length && stopped.volume.length === 1, "Down did not preserve only the owned volume");
        settings.ATELIER_ALLOW_REGISTRATION = "true";
        await writeEnv();
        await start();
    }
    async function failureEvidence() {
        finalize();
        if (ownsProject)
            try {
                const live = await resources(docker, project);
                report.failureContainers = live.container.map(identity);
                report.failureLogs = [];
                for (const c of live.container) {
                    const logs = await docker(["logs", "--tail", "100", c.Id]);
                    report.failureLogs.push({ containerId: c.Id, text: safeDiagnostic(logs.stdout + logs.stderr, secrets) });
                }
            } catch (error) {
                report.diagnosticError = safeDiagnostic(error.message, secrets);
            }
    }
    try {
        await writeEnv();
        await save();
        await step("Docker and source evidence; isolated Compose preflight", async () => {
            const version = JSON.parse((await docker(["version", "--format", "{{json .}}"])).stdout);
            report.dockerVersion = Object.fromEntries(["Client", "Server"].map((key) => [key, { version: version[key]?.Version, api: version[key]?.ApiVersion, os: version[key]?.Os, arch: version[key]?.Arch }]));
            check(version.Server?.Version, "Docker daemon unavailable");
            report.composeVersion = safeDiagnostic((await docker(["compose", "version", "--short"])).stdout.trim());
            const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
            report.source = {
                head: (await runProcess("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, env: gitEnv, signal: controller.signal })).stdout.trim(),
                role: options.image ? "Checkout only; local image provenance is its pinned image ID" : "Build checkout",
                composeSha256: sha(await readFile(join(root, "compose.yaml"))),
                dockerfileSha256: sha(await readFile(join(root, "Dockerfile"))),
            };
            if (options.image) {
                const image = JSON.parse((await docker(["image", "inspect", options.image])).stdout)[0];
                expectedImage = image.Id;
                await writeFile(paths.override, JSON.stringify({ services: { atelier: { image: image.Id, pull_policy: "never" } } }, null, 2) + "\n", { mode: 0o600 });
            }
            verifyCompose(JSON.parse((await compose(["config", "--format", "json"])).stdout), project);
            const existing = await resources(docker, project);
            check(
                Object.values(existing).every((items) => !items.length),
                "Generated project already exists; refusing to adopt it",
            );
            for (const [kind, name] of [
                ["container", project],
                ["network", `${project}_default`],
                ["volume", `${project}_atelier-data`],
            ]) {
                const named = await docker([kind, "ls", "--quiet", ...(kind === "container" ? ["--all"] : []), "--filter", `name=${name}`]);
                check(!named.stdout.trim(), "Generated resource name is already occupied; refusing to adopt it");
            }
            ownsProject = true;
        });
        await step("Build/start actual Compose service and prove mapped HTTP identity", () => start(true));
        await step("Anonymous protection, first signup/login and closed later registration", async () => {
            for (const path of ["/api/account/state", "/api/account/files", filePath, "/api/account/usage", "/api/codex-subscription/v1/status", "/api-proxy?target=https%3A%2F%2Fexample.com"]) await api(path, {}, 401);
            const session = (await api("/api/account/session")).json;
            check(session.user === null && session.registrationAllowed === true, "Volume is not a fresh account store");
            a = await register("acceptance_a");
            check((await api("/api/account/session")).json.registrationAllowed === false, "Registration did not close");
            check((await api("/api/account/register", { method: "POST", body: { username: "acceptance_closed", password: a.password } }, 403)).json.code === "REGISTRATION_CLOSED", "Wrong registration rejection");
            for (const headers of [{ origin: "https://wrong-origin.invalid" }, { "x-atelier-request": "" }]) await api(statePath(STATE), { method: "PUT", as: a, body: { value: "{}", expectedRevision: 0 }, headers }, 403);
            await api(statePath(STATE), { method: "PUT", as: a, body: { value: "{}", expectedRevision: 0 }, headers: { "x-atelier-user": "" } }, 409);
        });
        await step("Atomic legacy import, missing media, idempotency and bounded binary uploads", async () => {
            const body = {
                migrationId: "container-legacy-001",
                entries: [
                    { key: MONO, value: '{"objects":[]}' },
                    { key: STATE, value: document },
                ],
            };
            check((await api("/api/account/import", { method: "POST", as: a, body }, 400)).json.code === "MISSING_FILE", "Import must reject missing media");
            check((await api("/api/account/state", { as: a })).json.entries.length === 0, "Failed import partially committed");
            check((await api("/api/account/import/container-legacy-001", { as: a })).json.imported === false, "Failed import marked complete");
            const uploaded = (await api(filePath, { method: "PUT", as: a, raw: payload, headers: { "content-type": "application/octet-stream" } })).json;
            check(uploaded.storageKey === FILE && uploaded.bytes === payload.length && uploaded.mimeType === "application/octet-stream", "Upload metadata mismatch");
            await api(filePath, { method: "PUT", as: a, raw: Buffer.alloc(65537), headers: { "content-type": "application/octet-stream" } }, 413);
            check((await api("/api/account/import", { method: "POST", as: a, body })).json.alreadyImported === false, "First import not committed");
            check((await api("/api/account/import", { method: "POST", as: a, body })).json.alreadyImported === true, "Import is not idempotent");
            await readState(a, STATE, document, 1);
            await readState(a, MONO, '{"objects":[]}', 1);
            await api("/api/account/import", { method: "POST", as: a, body: { ...body, migrationId: "different-legacy-002" } }, 409);
            await media(a, payload);
        });
        await step("Revision CAS, encrypted configuration and restore conflict rollback", async () => {
            document = JSON.stringify({ state: { projects: [{ id: "acceptance-a-saved", nodes: [{ storageKey: FILE }] }] }, version: 0 });
            revision = (await api(statePath(STATE), { method: "PUT", as: a, body: { value: document, expectedRevision: 1 } })).json.revision;
            check(revision === 2, "Save did not advance revision");
            check((await api(statePath(STATE), { method: "PUT", as: a, body: { value: "{}", expectedRevision: 1 } }, 409)).json.code === "CONFLICT", "Stale write was not rejected");
            await api(statePath(CONFIG), { method: "PUT", as: a, body: { value: configValue, expectedRevision: 0 } });
            const entries = [
                { key: POSES, value: "[]", expectedRevision: 0 },
                { key: STATE, value: document, expectedRevision: 1 },
            ];
            await api("/api/account/restore", { method: "POST", as: a, body: { entries } }, 409);
            await readState(a, POSES, null, 0);
            await readState(a, STATE, document, revision);
            entries[1].expectedRevision = revision;
            check((await api("/api/account/restore", { method: "POST", as: a, body: { entries } })).json.restored === true, "Valid restore failed");
            revision++;
            await readState(a, POSES, "[]", 1);
            await codexStatus(a);
            await audit(true, [a.id]);
        });
        await step("Recreate with original volume; old A sessions/documents/media/key/Codex home survive", async () => {
            await recreate();
            await persisted();
            await codexStatus(a);
            await audit();
            check((await api("/api/account/session")).json.registrationAllowed === true, "Test registration was not enabled");
        });
        await step("B signup/login, exact owner isolation and real per-user Codex status", async () => {
            b = await register("acceptance_b");
            check((await api("/api/account/state", { as: b })).json.entries.length === 0, "B can list A documents");
            for (const key of [STATE, CONFIG, MONO, POSES]) await readState(b, key, null, 0);
            check((await api("/api/account/files", { as: b })).json.files.length === 0, "B can list A files");
            await api(filePath, { as: b }, 404);
            await api(filePath + "?account=" + a.id, { as: b }, 409);
            await api(statePath(STATE), { method: "PUT", as: b, body: { value: "{}", expectedRevision: 0 }, headers: { "x-atelier-user": a.id } }, 409);
            await api(filePath, { method: "PUT", as: b, raw: otherPayload, headers: { "content-type": "application/octet-stream" } });
            await api(statePath(STATE), { method: "PUT", as: b, body: { value: '{"state":{"projects":[]},"version":0}', expectedRevision: 0 } });
            await media(b, otherPayload);
            await persisted();
            await codexStatus(a);
            await codexStatus(b);
            await audit(false, [b.id]);
        });
        await step("Recreate again; both old sessions, distinct homes/sentinels and same-name private files survive", async () => {
            await recreate();
            await persisted();
            await readState(b, STATE, '{"state":{"projects":[]},"version":0}', 1);
            await readState(b, CONFIG, null, 0);
            await media(b, otherPayload);
            await codexStatus(a);
            await codexStatus(b);
            await audit();
        });
        report.status = "passed";
    } catch (error) {
        if (error.termination?.confirmed === false && !paths.processTerminationIssues.includes(error.termination)) paths.processTerminationIssues.push(error.termination);
        report.status = "failed";
        report.error = safeDiagnostic(error.message || "Acceptance interrupted", secrets);
        await failureEvidence();
    } finally {
        finalize();
        clearTimeout(timer);
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
        report.retained = ownsProject && (report.status === "passed" ? options.keep : options.keepFailed);
        if (ownsProject && !report.retained)
            try {
                await cleanupProject(paths, docker);
                report.cleaned = true;
            } catch (error) {
                report.status = "failed";
                report.cleanupError = safeDiagnostic(error.message, secrets);
                await failureEvidence();
            }
        if (paths.processTerminationIssues.length) {
            report.status = "failed";
            report.cleaned = false;
            report.cleanupCommand = null;
            report.cleanupError ||= "Cleanup blocked: command-tree termination is unconfirmed; reconcile the recorded process evidence first";
        }
        report.finishedAt = new Date().toISOString();
        await save();
        console.log(`[container-acceptance] ${report.status}; report: ${reportFile}`);
        if (report.retained) console.log(`[container-acceptance] retained ${project}; base URL: ${base || "not established"}; cleanup command in report.json`);
    }
    return report.status === "passed" ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = parseOptions(process.argv.slice(2));
        if (options.help)
            console.log(
                "Usage: node web/scripts/verify-container.mjs [--image LOCAL_IMAGE] [--keep] [--keep-failed]\nDefault: build root Compose atelier; clean only the generated project. --image pins a local image with --no-build/--pull never.\nDOCKER_BIN, DOCKER_HOST and DOCKER_CONFIG are honored. Verified foreground process-group supervision requires macOS/Linux or WSL; native Windows fails closed. DOCKER_BIN must be the Docker CLI or a foreground-exec wrapper, never a daemonizing/detached wrapper. Bounds: 20 minutes plus 2 minute finalization, 10 minute build, 45 second HTTP/exec; up to 2 seconds to reconcile stopped command groups. Native Windows tree shutdown is fail-closed; use WSL for verified acceptance.\n--keep retains successful runs with registration enabled for browser QA. --keep-failed retains failed runs. Neither exports credentials.",
            );
        else process.exitCode = await main(options);
    } catch {
        console.error("[container-acceptance] Invalid arguments or report initialization failure (use --help).");
        process.exitCode = 1;
    }
}
