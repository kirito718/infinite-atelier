import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { cleanupProject, composeArgs, gatedFetch, parseOptions, runProcess, safeDiagnostic, testEnvironment, verifyCompose, verifyContainerEnvironment, verifyResource } from "./verify-container.mjs";

const project = "atelier-acceptance-unit-0123456789abcdef";
const paths = { root: "/project with spaces", project, envFile: "/test dir/acceptance.env" };
const fixture = () => ({
    name: project,
    services: {
        atelier: {
            image: `${project}-image:acceptance`,
            pull_policy: "build",
            ports: [{ target: 3000, published: "0", host_ip: "127.0.0.1", protocol: "tcp" }],
            volumes: [{ type: "volume", source: "atelier-data", target: "/data" }],
            networks: { default: null },
            environment: {
                ATELIER_DATA_DIR: "/data",
                ATELIER_PUBLIC_URL: "",
                ATELIER_ALLOW_REGISTRATION: "false",
                ATELIER_SECURE_COOKIES: "false",
                ATELIER_ALLOW_PRIVATE_UPSTREAMS: "false",
                ATELIER_MAX_UPLOAD_BYTES: "65536",
                ATELIER_USER_QUOTA_BYTES: "262144",
                COMFYUI_BASE_URL: "http://127.0.0.1:9",
                COMFYUI_API_PREFIX: "/api",
                COMFYUI_WS_ENABLED: "false",
                COMFYUI_TASK_TTL_MS: "1000",
                COMFYUI_REQUEST_TIMEOUT_MS: "1000",
                COMFYUI_MAX_BYTES: "65536",
                COMFYUI_WORKFLOW_DIR: "/app/web/server/workflows",
            },
        },
    },
    volumes: { "atelier-data": { name: `${project}_atelier-data` } },
    networks: { default: { name: `${project}_default` } },
});

test("CLI accepts only explicit bounded modes and local image references", () => {
    assert.deepEqual(parseOptions([]), { image: null, keep: false, keepFailed: false, help: false });
    assert.deepEqual(parseOptions(["--keep", "--keep-failed", "--image", "localhost:5000/team/atelier:test"]), {
        image: "localhost:5000/team/atelier:test",
        keep: true,
        keepFailed: true,
        help: false,
    });
    assert.equal(parseOptions(["--image", `atelier@sha256:${"a".repeat(64)}`]).image, `atelier@sha256:${"a".repeat(64)}`);
    assert.equal(parseOptions(["--help"]).help, true);
});

test("CLI rejects ambiguous, duplicate and option/shell-injecting arguments", () => {
    for (const args of [
        ["--unknown"],
        ["extra"],
        ["--image"],
        ["--image", ""],
        ["--image", "--keep-failed"],
        ["--image", "a b"],
        ["--image", "a;touch-x"],
        ["--image", "$(id)"],
        ["--image", "a\nb"],
        ["--image", "good", "--image", "other"],
        ["--keep-failed", "--keep-failed"],
        ["--keep", "--keep"],
    ])
        assert.throws(() => parseOptions(args));
});

test("environment removes inherited Atelier/Compose/build overrides but preserves Docker routing", () => {
    const env = testEnvironment({
        PATH: "/bin",
        DOCKER_BIN: "/bin/docker",
        DOCKER_HOST: "unix:///vm/docker.sock",
        DOCKER_CONFIG: "/custom docker/config",
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: "/tls",
        ATELIER_ENCRYPTION_KEY: "do-not-inherit",
        ATELIER_PORT: "1234",
        ATELIER_NEW_SETTING: "unknown",
        COMPOSE_FILE: "/user/compose.yaml",
        COMPOSE_PROJECT_NAME: "user",
        COMPOSE_ENV_FILES: "/user/.env",
        CODEX_CLI_VERSION: "unapproved",
        COMFYUI_BASE_URL: "https://production-gpu.example",
        COMFYUI_WORKFLOW_DIR: "/user/workflows",
        IMAGE_TAG: "production",
        PULL_POLICY: "always",
        OTHER: "retained",
    });
    assert.deepEqual(env, { PATH: "/bin", DOCKER_BIN: "/bin/docker", DOCKER_HOST: "unix:///vm/docker.sock", DOCKER_CONFIG: "/custom docker/config", DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "/tls", OTHER: "retained" });
});

test("Compose paths and project are separate argv entries with an explicit env file", () => {
    assert.deepEqual(composeArgs(paths, ["up", "-d", "--build", "atelier"]), [
        "compose",
        "--ansi",
        "never",
        "--project-directory",
        "/project with spaces",
        "--project-name",
        project,
        "--env-file",
        "/test dir/acceptance.env",
        "-f",
        "/project with spaces/compose.yaml",
        "up",
        "-d",
        "--build",
        "atelier",
    ]);
    assert.deepEqual(composeArgs({ ...paths, override: "/test dir/image.json" }, ["up", "--no-build", "--pull", "never", "atelier"]).slice(-7), ["-f", "/test dir/image.json", "up", "--no-build", "--pull", "never", "atelier"]);
});

test("resolved Compose cannot bind user directories, fixed ports, global names or external resources", () => {
    assert.doesNotThrow(() => verifyCompose(fixture(), project));
    for (const mutate of [
        (c) => {
            c.services.atelier.image = "ghcr.io/user/production:latest";
        },
        (c) => {
            c.services.atelier.environment.COMFYUI_BASE_URL = "https://production-gpu.example";
        },
        (c) => {
            c.name = "other";
        },
        (c) => {
            c.services.atelier.ports[0].host_ip = "0.0.0.0";
        },
        (c) => {
            c.services.atelier.ports[0].published = "3000";
        },
        (c) => {
            c.services.atelier.volumes[0].type = "bind";
        },
        (c) => {
            c.services.atelier.volumes[0].source = "/user/data";
        },
        (c) => {
            c.volumes["atelier-data"].external = true;
        },
        (c) => {
            c.volumes["atelier-data"].name = "user-data";
        },
        (c) => {
            c.networks.default.external = true;
        },
        (c) => {
            c.networks.default.name = "user-network";
        },
        (c) => {
            c.services.atelier.network_mode = "host";
        },
        (c) => {
            c.services.atelier.container_name = "user-container";
        },
        (c) => {
            c.services.extra = {};
        },
        (c) => {
            c.services.atelier.environment.ATELIER_ENCRYPTION_KEY = "inherited";
        },
        (c) => {
            c.services.atelier.environment.ATELIER_DATA_DIR = "/user/data";
        },
        (c) => {
            c.volumes["atelier-data"].driver_opts = { type: "none", o: "bind", device: "/user/data" };
        },
        (c) => {
            c.services.atelier.volumes_from = ["unrelated-container"];
        },
        (c) => {
            c.services.atelier.pid = "host";
        },
    ]) {
        const c = fixture();
        mutate(c);
        assert.throws(() => verifyCompose(c, project));
    }
});

test("resource ownership requires exact project and service/volume/network labels", () => {
    const labels = { "com.docker.compose.project": project, "com.docker.compose.service": "atelier" };
    assert.doesNotThrow(() => verifyResource({ Id: "a".repeat(64), Config: { Labels: labels } }, "container", project));
    assert.throws(() => verifyResource({ Config: { Labels: { ...labels, "com.docker.compose.project": project + "-other" } } }, "container", project));
    assert.throws(() => verifyResource({ Config: { Labels: { ...labels, "com.docker.compose.service": "other" } } }, "container", project));
    for (const [kind, name, key] of [
        ["volume", "atelier-data", "volume"],
        ["network", "default", "network"],
    ]) {
        const item = { Name: `${project}_${name}`, Labels: { "com.docker.compose.project": project, [`com.docker.compose.${key}`]: name } };
        assert.doesNotThrow(() => verifyResource(item, kind, project));
        assert.throws(() => verifyResource({ ...item, Name: "unrelated" }, kind, project));
        assert.throws(() => verifyResource({ ...item, Labels: {} }, kind, project));
    }
});

test("process execution never interpolates argv or stdin through a shell", async () => {
    const args = ["value;exit 7", "$(printf BAD)", "two words"];
    const result = await runProcess(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...args]);
    assert.deepEqual(JSON.parse(result.stdout), args);
    const input = await runProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "nonsecret fixture" });
    assert.equal(input.stdout, "nonsecret fixture");
});

test("missing executables fail rather than skipping, with no argv/input in the error message", async () => {
    await assert.rejects(runProcess("/definitely-missing-atelier-docker", ["do-not-echo"], { input: "do-not-echo" }), (error) => error.message.includes("ENOENT") && !error.message.includes("do-not-echo"));
});

test("child duration and output are bounded", async () => {
    await assert.rejects(runProcess(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeout: 100 }));
    await assert.rejects(runProcess(process.execPath, ["-e", 'console.log("x".repeat(10000))'], { maxBuffer: 128 }));
});

// Real process hierarchy (launcher -> plugin -> worker), no Docker or filesystem writes.
// The worker cannot attempt its delayed side effect until AFTER runProcess rejects.
async function wrapperChildRegression(t, mode) {
    let release,
        armed,
        effects = 0;
    const ready = new Promise((resolve) => {
        armed = resolve;
    });
    const base = await withServer(t, (req, res) => {
        if (req.url === "/arm") {
            release = res;
            res.writeHead(200);
            res.flushHeaders();
            armed();
        } else {
            effects++;
            res.end("side effect");
        }
    });
    const worker = `
        const http = require('node:http');
        const exit = () => process.exit(0);
        setTimeout(exit, 6000).unref();
        http.get(${JSON.stringify(base + "/arm")}, response => {
            process.send('armed'); response.resume();
            response.on('end', () => setTimeout(() => {
                http.get(${JSON.stringify(base + "/effect")}, result => {
                    result.resume(); result.on('end', exit);
                }).on('error', exit);
            }, 25));
        }).on('error', exit);
    `;
    const wrapper = (code, outer = false) => `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(code)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        child.on('message', () => { ${outer && mode === "overflow" ? 'process.stdout.write("x".repeat(4096));' : outer && mode === "success-exit" ? "process.exit(0);" : 'if (process.send) process.send("armed");'} });
        child.on('exit', () => process.exit(0));
        setTimeout(() => process.exit(0), 6500).unref();
    `;
    const controller = new AbortController();
    t.after(() => controller.abort());
    const rejected = runProcess(process.execPath, ["-e", wrapper(wrapper(worker), true)], {
        timeout: mode === "timeout" ? 1200 : 5000,
        maxBuffer: mode === "overflow" ? 128 : 4096,
        signal: controller.signal,
    }).then(
        () => {
            throw new Error("Expected wrapper rejection");
        },
        (error) => error,
    );
    await Promise.race([
        ready,
        rejected.then(() => {
            throw new Error("Wrapper exited before its worker armed");
        }),
    ]);
    if (mode === "abort") controller.abort();
    const failure = await rejected;
    const expectedCode = { timeout: "ETIMEDOUT", abort: "ABORT_ERR", overflow: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "success-exit": "ERR_PROCESS_DESCENDANTS" }[mode];
    assert.ok(failure.message.includes(expectedCode), `expected ${expectedCode}, got ${failure.message}`);
    release.end("only now may the worker attempt its delayed side effect");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(effects, 0, `${mode}: descendant performed a side effect after runProcess rejected`);
    assert.equal(failure.termination?.confirmed, process.platform !== "win32", "POSIX must confirm shutdown; native Windows must remain fail-closed when unverified");
}

for (const mode of ["timeout", "abort", "overflow", "success-exit"]) {
    test(`${mode} stops real wrapper children before rejection permits a delayed side effect`, { timeout: 10000, skip: mode === "success-exit" && process.platform === "win32" }, async (t) => {
        await wrapperChildRegression(t, mode);
    });
}

test("rejected output retains bounded stdout/stderr without exposing argv or stdin in the message", async () => {
    const failure = await runProcess(process.execPath, ["-e", 'process.stdout.write("o".repeat(128)); process.stderr.write("e".repeat(129)); setTimeout(()=>{},10000)', "private-argv"], {
        input: "private-stdin",
        maxBuffer: 128,
    }).then(
        () => {
            throw new Error("Expected overflow");
        },
        (error) => error,
    );
    assert.equal(failure.diagnostic, "o".repeat(128) + "\n" + "e".repeat(128));
    assert.ok(!failure.message.includes("private-argv") && !failure.message.includes("private-stdin"));
});

test("terminating one owned group leaves an independent process running", async () => {
    const observer = runProcess(process.execPath, ["-e", 'setTimeout(()=>console.log("independent-process-finished"),250)']);
    await assert.rejects(runProcess(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeout: 100 }));
    assert.equal((await observer).stdout.trim(), "independent-process-finished");
});

test("an already-aborted signal launches no process", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runProcess(process.execPath, ["-e", "process.exit(99)"], { signal: controller.signal }), (error) => {
        assert.equal(error.termination?.pid, null);
        assert.equal(error.termination?.state, "not-started");
        return error.message.includes("ABORT_ERR");
    });
});

test("an unconfirmed POSIX group retains observed PIDs across incomplete snapshots and cannot authorize cleanup", { timeout: 10000, skip: process.platform === "win32" }, async () => {
    // Simulate an ineffective GROUP kill in an isolated fixture process: only
    // the launcher dies. /bin/ps and the worker are real. The fixture finally
    // kills its still-owned group so this negative test leaves no live worker.
    const script = `
        import { runProcess, cleanupProject } from ${JSON.stringify(new URL("./verify-container.mjs", import.meta.url).href)};
        import childProcess from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        const originalKill = process.kill.bind(process);
        const originalExecFile = childProcess.execFile;
        let group, failure, calls = 0, blocked = false, observed = false, partialSnapshots = 0;
        // A bounded ps read may omit a still-existing group (observed on macOS).
        // Keep the first real observation, then deterministically reproduce that gap.
        childProcess.execFile = (binary, args, options, callback) => originalExecFile(binary, args, options, (error, stdout, stderr) => {
            if (binary === '/bin/ps' && !error) {
                if (observed) { partialSnapshots++; callback(null, '', stderr); return; }
                if (stdout.includes(' ' + group + ' ')) observed = true;
            }
            callback(error, stdout, stderr);
        });
        syncBuiltinESMExports();
        process.kill = (pid, signal) => {
            if (pid < 0 && signal === 'SIGKILL') { group = -pid; return originalKill(-pid, signal); }
            return originalKill(pid, signal);
        };
        const worker = 'setTimeout(()=>{},6000)';
        const launcher = 'const c=require("node:child_process").spawn(process.execPath,["-e",' + JSON.stringify(worker) + '],{stdio:"ignore"}); console.log(c.pid); setTimeout(()=>{},6500)';
        try {
            try { await runProcess(process.execPath, ['-e', launcher], { timeout: 600 }); }
            catch (error) { failure = error; }
            try { await cleanupProject({ ...${JSON.stringify(paths)}, processTerminationIssues: [failure.termination] }, async () => { calls++; throw new Error('Unexpected Docker call'); }); }
            catch (error) { blocked = /termination.*unconfirmed/i.test(error.message); }
        } finally {
            process.kill = originalKill;
            childProcess.execFile = originalExecFile;
            syncBuiltinESMExports();
            if (group) try { originalKill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        console.log(JSON.stringify({ termination: failure?.termination, worker: Number(failure?.diagnostic.trim()), calls, blocked, partialSnapshots }));
    `;
    const result = JSON.parse((await runProcess(process.execPath, ["--input-type=module", "-e", script], { timeout: 8500 })).stdout);
    assert.equal(result.termination?.confirmed, false);
    assert.ok(result.partialSnapshots > 0, "the test must exercise incomplete process-table observations");
    assert.ok(result.termination.livePids?.includes(result.worker), `unconfirmed evidence must identify the actual surviving group member: ${JSON.stringify(result)}`);
    assert.equal(result.termination.closed, true, "launcher exit alone must not count as tree termination");
    assert.equal(result.calls, 0);
    assert.equal(result.blocked, true);
    assert.ok(result.termination.elapsedMs < 4500, "failed reconciliation must remain bounded");
});

async function withServer(t, handler) {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}`;
}

test("HTTP gate sends neither credentials nor mutations until the nonce matches exactly", async (t) => {
    let body = "wrong service",
        writes = 0;
    const base = await withServer(t, (req, res) => {
        if (req.url === "/probe.txt") {
            assert.equal(req.headers.cookie, undefined);
            res.end(body);
        } else {
            writes++;
            assert.equal(req.headers.cookie, "test-cookie");
            res.end("ok");
        }
    });
    const probe = { path: "/probe.txt", nonce: "expected nonce" };
    const options = { method: "POST", headers: { cookie: "test-cookie" }, body: "{}" };
    await assert.rejects(gatedFetch(base, probe, "/write", options), /probe/i);
    assert.equal(writes, 0);
    body = "expected nonce";
    const result = await gatedFetch(base, probe, "/write", options);
    assert.equal(result.status, 200);
    assert.equal(result.bytes.toString(), "ok");
    assert.equal(writes, 1);
    await assert.rejects(gatedFetch(base, null, "/write", options), /probe/i);
    assert.equal(writes, 1);
});

test("HTTP gate refuses redirects and off-origin paths", async (t) => {
    let otherRequests = 0;
    const base = await withServer(t, (req, res) => {
        if (req.url === "/probe.txt") res.writeHead(302, { location: "/unrelated" }).end();
        else {
            otherRequests++;
            res.end("ok");
        }
    });
    const probe = { path: "/probe.txt", nonce: "expected nonce" };
    await assert.rejects(gatedFetch(base, probe, "/write", { method: "POST" }));
    await assert.rejects(gatedFetch(base, probe, "https://example.com/write", { method: "POST" }));
    await assert.rejects(gatedFetch(base, probe, "//example.com/write", { method: "POST" }));
    assert.equal(otherRequests, 0);
});

// Diagnostics are not a substitute for live Docker evidence.
test("diagnostics omit credentials and bound output without dropping ordinary errors", () => {
    const text =
        "build failed\nCookie: atelier_session=unknown-token\npassword=unknown-password\nAuthorization: Bearer token\napiKey: unknown-key\nhttps://user:pass@registry.test/path\nssh://private:p4ss@vm.test/path\nknown-private-value\n" + "a".repeat(64);
    const safe = safeDiagnostic(text, ["known-private-value"]);
    assert.match(safe, /build failed/);
    for (const secret of ["unknown-token", "unknown-password", "Bearer token", "unknown-key", "user:pass", "private:p4ss", "known-private-value", "a".repeat(64)]) assert.ok(!safe.includes(secret));
    assert.ok(safeDiagnostic("x".repeat(50000)).length <= 16000);
});

// A command-boundary unit double: this does not emulate or certify Docker.
function cleanupBoundary({ foreignContainer = false, changedVolume = false, volumesOnly = false } = {}) {
    const calls = [];
    let stopped = volumesOnly,
        removed = false,
        volumeReads = 0;
    const docker = async (args) => {
        calls.push(args);
        const [kind, op] = args;
        if (kind === "compose") {
            if (args.includes("config")) return { stdout: JSON.stringify(fixture()) };
            assert.ok(args.includes("down"));
            assert.ok(!args.includes("-v"));
            stopped = true;
            return { stdout: "" };
        }
        assert.ok(["container", "volume", "network"].includes(kind));
        const name = kind === "volume" ? "atelier-data" : "default";
        if (op === "ls") return { stdout: (kind === "volume" ? !removed : !stopped) ? (kind === "volume" ? `${project}_atelier-data` : "a".repeat(64)) : "" };
        if (op === "inspect") {
            if (kind === "container")
                return {
                    stdout: JSON.stringify([
                        {
                            Id: "a".repeat(64),
                            Config: {
                                Labels: {
                                    "com.docker.compose.project": foreignContainer ? "not-ours" : project,
                                    "com.docker.compose.service": "atelier",
                                },
                            },
                        },
                    ]),
                };
            if (kind === "volume") volumeReads++;
            return {
                stdout: JSON.stringify([
                    {
                        Name: `${project}_${name}`,
                        Labels: {
                            "com.docker.compose.project": changedVolume && volumeReads === 2 ? "not-ours" : project,
                            [`com.docker.compose.${kind}`]: name,
                        },
                    },
                ]),
            };
        }
        assert.deepEqual(args, ["volume", "rm", `${project}_atelier-data`]);
        removed = true;
        return { stdout: "" };
    };
    return { docker, calls };
}

test("cleanup removes only verified project resources, never images or global volumes", async () => {
    const { docker, calls } = cleanupBoundary();
    await cleanupProject(paths, docker);
    assert.deepEqual(
        calls.filter((args) => args[1] === "rm"),
        [["volume", "rm", `${project}_atelier-data`]],
    );
    assert.equal(calls.filter((args) => args.includes("down")).length, 1);
});

test("cleanup refuses foreign containers before down and rechecks volume labels before rm", async () => {
    const foreign = cleanupBoundary({ foreignContainer: true });
    await assert.rejects(cleanupProject(paths, foreign.docker), /ownership/);
    assert.ok(!foreign.calls.some((args) => args.includes("down") || args.includes("rm")));
    const changed = cleanupBoundary({ changedVolume: true });
    await assert.rejects(cleanupProject(paths, changed.docker), /ownership/);
    assert.ok(!changed.calls.some((args) => args.includes("rm")));
});

test("HTTP gate bounds responses and refuses API redirects after successful proof", async (t) => {
    let redirected = 0;
    const base = await withServer(t, (req, res) => {
        if (req.url === "/probe.txt") res.end("nonce");
        else if (req.url === "/large") res.end(Buffer.alloc(262145));
        else if (req.url === "/redirect") res.writeHead(307, { location: "/must-not-receive-cookie" }).end();
        else {
            redirected++;
            res.end("unexpected");
        }
    });
    const probe = { path: "/probe.txt", nonce: "nonce" };
    await assert.rejects(gatedFetch(base, probe, "/large"), /bound/);
    await assert.rejects(gatedFetch(base, probe, "/redirect", { headers: { cookie: "test-cookie" } }));
    assert.equal(redirected, 0);
});

test("cleanup refuses a project with unconfirmed command-tree termination before any Docker call", async () => {
    const { docker, calls } = cleanupBoundary();
    await assert.rejects(cleanupProject({ ...paths, processTerminationIssues: [{ confirmed: false, pid: 123 }] }, docker), /termination.*unconfirmed/i);
    assert.equal(calls.length, 0);
});

test("volume-only cleanup never calls Compose down on unidentified containers/networks", async () => {
    const { docker, calls } = cleanupBoundary({ volumesOnly: true });
    await cleanupProject(paths, docker);
    assert.ok(!calls.some((args) => args.includes("down")));
    assert.deepEqual(
        calls.filter((args) => args[1] === "rm"),
        [["volume", "rm", `${project}_atelier-data`]],
    );
});

test("effective container environment verifies both account and ComfyUI settings without inheriting extras", () => {
    const expected = fixture().services.atelier.environment;
    const actual = ["PATH=/usr/local/bin:/usr/bin", "NODE_ENV=production", ...Object.entries(expected).map(([key, value]) => `${key}=${value}`)];
    assert.doesNotThrow(() => verifyContainerEnvironment(actual, expected));
    assert.throws(() =>
        verifyContainerEnvironment(
            actual.filter((value) => !value.startsWith("COMFYUI_BASE_URL=")),
            expected,
        ),
    );
    assert.throws(() => verifyContainerEnvironment([...actual, "COMFYUI_EXTRA=unreviewed"], expected));
    assert.throws(() =>
        verifyContainerEnvironment(
            actual.map((value) => (value.startsWith("COMFYUI_BASE_URL=") ? "COMFYUI_BASE_URL=https://production-gpu.example" : value)),
            expected,
        ),
    );
});
