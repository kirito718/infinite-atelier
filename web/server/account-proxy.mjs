import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { pipeline } from "node:stream/promises";
import { HttpError, readBytes } from "./account-http.mjs";

const blocked = new BlockList();
for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
])
    blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
    ["::", 96],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
])
    blocked.addSubnet(address, prefix, "ipv6");
export function isPublicAddress(address) {
    const version = isIP(address);
    return Boolean(version) && !blocked.check(address, version === 4 ? "ipv4" : "ipv6") && (version === 4 || /^[23]/i.test(address));
}

async function resolveTarget(value, allowPrivate) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new HttpError(400, "INVALID_TARGET", "代理目标 URL 无效。");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new HttpError(400, "INVALID_TARGET", "代理仅允许不含用户名密码的 HTTP(S) 地址。");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let addresses;
    try {
        addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
    } catch {
        throw new HttpError(502, "UPSTREAM_DNS", "无法解析上游服务地址。");
    }
    if (!addresses.length || (!allowPrivate && addresses.some((item) => !isPublicAddress(item.address)))) throw new HttpError(403, "PRIVATE_UPSTREAM", "默认禁止访问内网目标；私有模型服务需管理员显式启用。");
    return { url, addresses };
}

async function upstreamRequest(target, { method, headers, body, allowPrivate, signal }, redirects = 0) {
    const { url, addresses } = await resolveTarget(target, allowPrivate);
    const response = await new Promise((resolve, reject) => {
        const upstream = (url.protocol === "https:" ? httpsRequest : httpRequest)(
            url,
            {
                method,
                headers: { ...headers, ...(body && { "content-length": String(body.length) }) },
                signal,
                // Pin the exact validated DNS answers; do not perform a second DNS lookup (rebinding).
                lookup: (_hostname, options, callback) => (options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family)),
            },
            resolve,
        );
        upstream.once("error", reject);
        upstream.end(body);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects >= 4) throw new HttpError(502, "UPSTREAM_REDIRECT", "上游重定向次数过多。");
        const next = new URL(response.headers.location, url);
        const nextHeaders = { ...headers };
        if (next.origin !== url.origin) for (const key of Object.keys(nextHeaders)) if (!["accept", "content-type", "range"].includes(key)) delete nextHeaders[key];
        const changeToGet = response.statusCode === 303 || ([301, 302].includes(response.statusCode) && method === "POST");
        return upstreamRequest(next.href, { method: changeToGet ? "GET" : method, headers: nextHeaders, body: changeToGet ? undefined : body, allowPrivate, signal }, redirects + 1);
    }
    return response;
}

export async function proxyAccountRequest(req, res, { target, allowPrivate }) {
    const method = req.method || "GET";
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new HttpError(405, "METHOD_NOT_ALLOWED", "不支持此请求方法。");
    const headers = {};
    // Preserve user-configured provider headers, but never forward browser/app
    // credentials, origin metadata, proxy credentials or hop-by-hop headers.
    const privateHeaders = new Set(["cookie", "cookie2", "host", "origin", "referer", "connection", "content-length", "transfer-encoding", "upgrade", "keep-alive", "te", "trailer", "proxy-authorization", "proxy-authenticate", "forwarded", "x-real-ip"]);
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string" && !privateHeaders.has(key) && !/^(sec-|x-atelier-|x-forwarded-|x-infinite-canvas-|x-codex-)/.test(key)) headers[key] = value;
    let targetUrl;
    try {
        targetUrl = new URL(target);
    } catch {
        throw new HttpError(400, "INVALID_TARGET", "代理目标 URL 无效。");
    }
    // Axios/plugin params are appended to the proxy URL, not its encoded target.
    for (const [key, value] of new URL(req.url, "http://localhost").searchParams) if (key !== "target") targetUrl.searchParams.append(key, value);
    const body = ["GET", "HEAD"].includes(method) ? undefined : await readBytes(req, 24 * 1024 * 1024);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300000);
    const abort = () => {
        if (!res.writableFinished) controller.abort();
    };
    res.once("close", abort);
    try {
        const upstream = await upstreamRequest(targetUrl.href, { method, headers, body, allowPrivate, signal: controller.signal });
        const responseHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
        for (const key of ["content-type", "content-range", "accept-ranges", "content-length", "content-encoding"]) if (upstream.headers[key]) responseHeaders[key] = upstream.headers[key];
        // Set-Cookie, Location and hop-by-hop headers are intentionally not forwarded.
        res.writeHead(upstream.statusCode || 502, responseHeaders);
        await pipeline(upstream, res);
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(502, "UPSTREAM_FAILED", "上游服务请求失败，请检查渠道地址和网络。");
    } finally {
        clearTimeout(timer);
        res.off("close", abort);
    }
}
