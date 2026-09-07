import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export class WorkflowRegistryError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "WorkflowRegistryError";
        this.code = code;
    }
}

export const DEFAULT_WORKFLOW_MANIFESTS = [
    {
        id: "portrait-pose-depth",
        version: 1,
        file: "portrait-pose-depth-api.json",
        inputNodes: {
            pose: { nodeId: "12", input: "image" },
            depth: { nodeId: "13", input: "image" },
            positivePrompt: { nodeId: "6", input: "text" },
            negativePrompt: { nodeId: "7", input: "text" },
            seed: { nodeId: "18", input: "seed" },
            width: { nodeId: "8", input: "width" },
            height: { nodeId: "8", input: "height" },
        },
        outputNode: "21",
        requiredModels: ["realisticVisionV60B1_v51VAE.safetensors", "control_v11p_sd15_openpose_fp16.safetensors", "control_v11f1p_sd15_depth_fp16.safetensors"],
    },
];

export function createWorkflowRegistry({ directory, manifests }) {
    if (typeof directory !== "string" || !directory) {
        throw new WorkflowRegistryError("WORKFLOW_DIRECTORY_INVALID", "A workflow directory is required");
    }
    if (!Array.isArray(manifests)) {
        throw new WorkflowRegistryError("WORKFLOW_MANIFEST_INVALID", "Workflow manifests must be an array");
    }

    const entries = new Map();
    for (const manifest of manifests) {
        const entry = loadWorkflowEntry(directory, manifest);
        if (entries.has(entry.manifest.id)) {
            throw new WorkflowRegistryError("WORKFLOW_MANIFEST_INVALID", `Duplicate workflow id: ${entry.manifest.id}`);
        }
        entries.set(entry.manifest.id, entry);
    }

    const getEntry = (workflowId) => {
        const entry = entries.get(workflowId);
        if (!entry) {
            throw new WorkflowRegistryError("WORKFLOW_NOT_FOUND", `Unknown workflow: ${workflowId}`);
        }
        return entry;
    };

    return {
        get(workflowId) {
            const entry = getEntry(workflowId);
            return cloneEntry(entry);
        },
        patch(workflowId, inputs) {
            if (!isRecord(inputs)) {
                throw new WorkflowRegistryError("WORKFLOW_INPUT_INVALID", "Workflow inputs must be an object");
            }

            const entry = getEntry(workflowId);
            const patched = cloneEntry(entry);
            for (const [logicalName, value] of Object.entries(inputs)) {
                if (!hasOwn(patched.manifest.inputNodes, logicalName)) {
                    throw new WorkflowRegistryError("WORKFLOW_INPUT_UNKNOWN", `Unknown workflow input: ${logicalName}`);
                }
                const target = patched.manifest.inputNodes[logicalName];
                if (!hasOwn(patched.workflow, target.nodeId) || !hasOwn(patched.workflow[target.nodeId].inputs, target.input)) {
                    throw new WorkflowRegistryError("WORKFLOW_MANIFEST_INVALID", `Workflow ${workflowId} has an invalid input target for ${logicalName}`);
                }
                patched.workflow[target.nodeId].inputs[target.input] = value;
            }
            return patched;
        },
    };
}

function loadWorkflowEntry(directory, manifest) {
    validateManifestShape(manifest);
    const file = manifest.file;
    if (basename(file) !== file) {
        throw new WorkflowRegistryError("WORKFLOW_MANIFEST_INVALID", `Workflow filename must not include a path: ${file}`);
    }

    const workflowPath = resolve(directory, file);
    let workflow;
    try {
        workflow = JSON.parse(readFileSync(workflowPath, "utf8"));
    } catch (error) {
        throw new WorkflowRegistryError("WORKFLOW_LOAD_FAILED", `Could not load workflow ${manifest.id}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!isRecord(workflow)) {
        throw new WorkflowRegistryError("WORKFLOW_MANIFEST_INVALID", `Workflow ${manifest.id} must be an API-format node map`);
    }

    for (const [logicalName, target] of Object.entries(manifest.inputNodes)) {
        const node = workflow[target.nodeId];
        if (!hasOwn(workflow, target.nodeId) || !isRecord(node) || !hasOwn(node, "inputs") || !isRecord(node.inputs) || !hasOwn(node.inputs, target.input)) {
            throw new WorkflowRegistryError("WORKFLOW_MANIFEST_INVALID", `Workflow ${manifest.id} input ${logicalName} targets missing node input ${target.nodeId}.${target.input}`);
        }
    }

    if (!hasOwn(workflow, manifest.outputNode) || !isRecord(workflow[manifest.outputNode])) {
        throw new WorkflowRegistryError("WORKFLOW_MANIFEST_INVALID", `Workflow ${manifest.id} output node ${manifest.outputNode} does not exist`);
    }

    return { manifest: clone(manifest), workflow: clone(workflow) };
}

function validateManifestShape(manifest) {
    if (!isRecord(manifest) || !hasOwn(manifest, "id") || typeof manifest.id !== "string" || !manifest.id || !hasOwn(manifest, "file") || typeof manifest.file !== "string" || !manifest.file) {
        throw new WorkflowRegistryError("WORKFLOW_MANIFEST_INVALID", "Workflow manifest requires id and file");
    }
    if (!hasOwn(manifest, "inputNodes") || !isRecord(manifest.inputNodes) || !hasOwn(manifest, "outputNode") || typeof manifest.outputNode !== "string" || !manifest.outputNode) {
        throw new WorkflowRegistryError("WORKFLOW_MANIFEST_INVALID", `Workflow manifest ${manifest.id} requires inputNodes and outputNode`);
    }
    for (const [logicalName, target] of Object.entries(manifest.inputNodes)) {
        if (!isRecord(target) || !hasOwn(target, "nodeId") || typeof target.nodeId !== "string" || !target.nodeId || !hasOwn(target, "input") || typeof target.input !== "string" || !target.input) {
            throw new WorkflowRegistryError("WORKFLOW_MANIFEST_INVALID", `Workflow manifest ${manifest.id} has an invalid input target for ${logicalName}`);
        }
    }
}

function cloneEntry(entry) {
    return { manifest: clone(entry.manifest), workflow: clone(entry.workflow) };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
    return isRecord(value) && Object.hasOwn(value, key);
}
