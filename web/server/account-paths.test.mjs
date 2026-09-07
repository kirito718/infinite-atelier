import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { resolveAccountDataDir } from "./account-paths.mjs";
const linkType = process.platform === "win32" ? "junction" : "dir";

function withRoot(run) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "atelier-static-root-")));
    mkdirSync(join(root, "public"));
    mkdirSync(join(root, "dist"));
    try {
        run({ root, check: (value) => resolveAccountDataDir(value, { appRoot: root }) });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test("rejects data directories inside public/build roots before any HTTP listener starts", () =>
    withRoot(({ root, check }) => {
        for (const directory of [join(root, "public", "data"), join(root, "dist", "data"), root, dirname(root)]) assert.throws(() => check(directory), /data directory/i);
        assert.equal(check(join(root, "data", "private")), resolve(root, "data", "private"));
    }));
test("canonicalizes symlinked ancestors so an indirect public directory is still rejected", () =>
    withRoot(({ root, check }) => {
        const dir = mkdtempSync(join(tmpdir(), "atelier-paths-"));
        try {
            symlinkSync(join(root, "public"), join(dir, "alias"), linkType);
            assert.throws(() => check(join(dir, "alias", "private-data")), /data directory/i);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }));
test("rejects outward public symlinks and exposed aliases of an otherwise private data directory", () =>
    withRoot(({ root, check }) => {
        const dir = mkdtempSync(join(tmpdir(), "atelier-outward-"));
        const alias = join(root, "public", "data");
        try {
            symlinkSync(dir, alias, linkType);
            assert.throws(() => check(alias), /data directory/i);
            assert.throws(() => check(dir), /data directory/i);
        } finally {
            unlinkSync(alias);
            rmSync(dir, { recursive: true, force: true });
        }
    }));
test("rejects a dangling static alias before creating its private target", () =>
    withRoot(({ root, check }) => {
        const parent = mkdtempSync(join(tmpdir(), "atelier-dangling-"));
        const target = join(parent, "not-yet-created");
        const alias = join(root, "public", "data");
        try {
            symlinkSync(target, alias, linkType);
            assert.throws(() => check(target), /data directory/i);
            assert.equal(existsSync(target), false);
        } finally {
            unlinkSync(alias);
            rmSync(parent, { recursive: true, force: true });
        }
    }));
