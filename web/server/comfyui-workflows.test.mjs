import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DEFAULT_WORKFLOW_MANIFESTS, WorkflowRegistryError, createWorkflowRegistry } from "./comfyui-workflows.mjs";

const workflowDirectory = fileURLToPath(new URL("./workflows/", import.meta.url));

test("loads the portrait-pose-depth API workflow with its declared output node", () => {
    const registry = createWorkflowRegistry({ directory: workflowDirectory, manifests: DEFAULT_WORKFLOW_MANIFESTS });

    const entry = registry.get("portrait-pose-depth");

    assert.equal(entry.manifest.id, "portrait-pose-depth");
    assert.equal(entry.manifest.outputNode, "21");
    assert.equal(entry.workflow["12"].class_type, "LoadImage");
    assert.equal(entry.workflow["13"].class_type, "LoadImage");
});

test("patches only declared logical workflow inputs without mutating the cached workflow", () => {
    const registry = createWorkflowRegistry({ directory: workflowDirectory, manifests: DEFAULT_WORKFLOW_MANIFESTS });

    const patched = registry.patch("portrait-pose-depth", {
        pose: "controls/pose.png",
        depth: "controls/depth.png",
        positivePrompt: "cinematic portrait",
        negativePrompt: "cartoon",
        seed: 42,
        width: 768,
        height: 1024,
    });

    assert.equal(patched.workflow["12"].inputs.image, "controls/pose.png");
    assert.equal(patched.workflow["13"].inputs.image, "controls/depth.png");
    assert.equal(patched.workflow["6"].inputs.text, "cinematic portrait");
    assert.equal(patched.workflow["7"].inputs.text, "cartoon");
    assert.equal(patched.workflow["18"].inputs.seed, 42);
    assert.equal(patched.workflow["8"].inputs.width, 768);
    assert.equal(patched.workflow["8"].inputs.height, 1024);
    assert.equal(patched.workflow["3"].inputs.ckpt_name, "realisticVisionV60B1_v51VAE.safetensors");

    patched.workflow["12"].inputs.image = "mutated.png";
    assert.equal(registry.get("portrait-pose-depth").workflow["12"].inputs.image, "pose.png");

    assert.throws(
        () => registry.patch("portrait-pose-depth", { checkpoint: "untrusted.safetensors" }),
        (error) => error instanceof WorkflowRegistryError && error.code === "WORKFLOW_INPUT_UNKNOWN",
    );
});

test("rejects unknown workflow ids", () => {
    const registry = createWorkflowRegistry({ directory: workflowDirectory, manifests: DEFAULT_WORKFLOW_MANIFESTS });

    assert.throws(
        () => registry.get("unknown-workflow"),
        (error) => error instanceof WorkflowRegistryError && error.code === "WORKFLOW_NOT_FOUND",
    );
});

test("rejects a manifest that targets a missing workflow node", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atelier-comfy-workflow-"));
    await writeFile(join(directory, "invalid.json"), JSON.stringify({ 1: { class_type: "LoadImage", inputs: { image: "pose.png" } } }));

    assert.throws(
        () =>
            createWorkflowRegistry({
                directory,
                manifests: [
                    {
                        id: "invalid",
                        file: "invalid.json",
                        inputNodes: { pose: { nodeId: "99", input: "image" } },
                        outputNode: "1",
                    },
                ],
            }),
        (error) => error instanceof WorkflowRegistryError && error.code === "WORKFLOW_MANIFEST_INVALID",
    );
});
