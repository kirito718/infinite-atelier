import assert from "node:assert/strict";
import test from "node:test";
import { readComfyUiConfig, createConfiguredComfyUiApi } from "./comfyui-gateway.mjs";

test("gateway configuration fails closed without an upstream", () => {
    assert.throws(() => readComfyUiConfig({}), { code: "COMFYUI_NOT_CONFIGURED" });
    assert.throws(() => createConfiguredComfyUiApi({ env: {} }), { code: "COMFYUI_NOT_CONFIGURED" });
});
test("gateway accepts a private Compose host and normalizes server-only options", () => {
    const config = readComfyUiConfig({ COMFYUI_BASE_URL: " http://comfyui:8188/ ", COMFYUI_API_PREFIX: "/api/", COMFYUI_WS_ENABLED: "false", COMFYUI_TASK_TTL_MS: "3600000" });
    assert.equal(config.baseUrl, "http://comfyui:8188");
    assert.equal(config.apiPrefix, "/api");
    assert.equal(config.websocketEnabled, false);
    assert.equal(config.ttlMs, 3600000);
    assert.equal(readComfyUiConfig({ COMFYUI_BASE_URL: "http://host.docker.internal:8188" }).websocketEnabled, true);
});
test("gateway rejects ambiguous URLs, invalid flags and non-positive lifetimes", () => {
    for (const value of ["file:///tmp/comfy", "http://user:secret@host", "http://host/?target=elsewhere", "http://host/#fragment"]) {
        assert.throws(() => readComfyUiConfig({ COMFYUI_BASE_URL: value }), { code: "COMFYUI_CONFIG_INVALID" });
    }
    for (const patch of [{ COMFYUI_WS_ENABLED: "maybe" }, { COMFYUI_TASK_TTL_MS: "0" }, { COMFYUI_TASK_TTL_MS: "NaN" }, { COMFYUI_MAX_BYTES: "1.5" }, { COMFYUI_API_PREFIX: "api/.." }]) {
        assert.throws(() => readComfyUiConfig({ COMFYUI_BASE_URL: "http://comfyui:8188", ...patch }), { code: "COMFYUI_CONFIG_INVALID" });
    }
});
