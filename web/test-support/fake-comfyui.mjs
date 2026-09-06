/** Protocol-only HTTP fixture. It returns a synthetic PNG, never a generated photograph. */
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const head = Buffer.alloc(4),
        tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    tail.writeUInt32BE(crc32(payload));
    return Buffer.concat([head, payload, tail]);
}
export function fixturePng(width = 64, height = 64) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const pixels = Buffer.alloc(height * (width * 3 + 1));
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const i = y * (width * 3 + 1) + 1 + x * 3;
            pixels[i] = x % 256;
            pixels[i + 1] = y % 256;
            pixels[i + 2] = 128;
        }
    return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

export async function startFakeComfyUi({ autoComplete = true, rejectQueue = false, output = fixturePng() } = {}) {
    const uploads = new Map(),
        prompts = new Map();
    const state = { uploads: [], submissions: [], cancellations: [], historyRequests: 0, websocketAttempts: 0 };
    const json = (res, status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
    };
    const body = async (req) => {
        const parts = [];
        let bytes = 0;
        for await (const part of req) {
            bytes += part.length;
            if (bytes > 26 * 1024 * 1024) throw Error("Fixture request is too large");
            parts.push(part);
        }
        return Buffer.concat(parts);
    };
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://fixture");
            const path = url.pathname.replace(/^\/api(?=\/)/, "");
            if (path === "/system_stats") return json(res, 200, { system: { fixture: true }, devices: [] });
            if (path === "/upload/image" && req.method === "POST") {
                const form = await new Request("http://fixture/upload", { method: "POST", headers: req.headers, body: await body(req) }).formData();
                const image = form.get("image");
                if (!(image instanceof Blob)) return json(res, 400, { error: "Missing image" });
                const file = { name: image.name, subfolder: form.get("subfolder") || "", type: "input" };
                const bytes = Buffer.from(await image.arrayBuffer());
                uploads.set(`${file.subfolder}/${file.name}`, bytes);
                state.uploads.push({ ...file, bytes });
                return json(res, 200, file);
            }
            if (path === "/prompt" && req.method === "POST") {
                const request = JSON.parse((await body(req)).toString());
                state.submissions.push(request);
                if (rejectQueue) return json(res, 400, { error: { message: "Fixture: required checkpoint is missing" }, node_errors: { 3: { errors: ["missing checkpoint"] } } });
                if (!uploads.has(request.prompt["12"]?.inputs.image) || !uploads.has(request.prompt["13"]?.inputs.image)) return json(res, 400, { error: { message: "Control input not uploaded" } });
                prompts.set(request.prompt_id, { completed: autoComplete });
                return json(res, 200, { prompt_id: request.prompt_id, number: prompts.size, node_errors: {} });
            }
            if (path.startsWith("/history/")) {
                state.historyRequests++;
                const id = decodeURIComponent(path.slice(9));
                return json(res, 200, prompts.get(id)?.completed ? { [id]: { status: { completed: true, status_str: "success" }, outputs: { 21: { images: [{ filename: `${id}.png`, subfolder: "fixture", type: "output" }] } } } } : {});
            }
            if (path === "/view") {
                const id = url.searchParams.get("filename")?.replace(/\.png$/, "");
                if (!prompts.has(id)) return json(res, 404, { error: "Unknown output" });
                res.writeHead(200, { "content-type": "image/png", "content-length": output.length });
                return res.end(output);
            }
            const cancel = /^\/jobs\/([^/]+)\/cancel$/.exec(path);
            if (cancel && req.method === "POST") {
                state.cancellations.push(cancel[1]);
                return json(res, 200, { cancelled: true });
            }
            json(res, 404, { error: "Fixture route not found" });
        } catch (error) {
            json(res, 500, { error: error.message });
        }
    });
    server.on("upgrade", (_req, socket) => {
        state.websocketAttempts++;
        socket.destroy();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        state,
        output,
        complete(promptId) {
            const prompt = prompts.get(promptId);
            if (prompt) prompt.completed = true;
        },
        async close() {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}
