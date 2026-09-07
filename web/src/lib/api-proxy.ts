// All remote model/media requests use the authenticated same-origin server in
// development AND production. Session cookies are never forwarded upstream.
export function proxyApiUrl(directUrl: string): string {
    try {
        const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
        const target = new URL(directUrl, origin);
        if (!['http:', 'https:'].includes(target.protocol) || target.origin === origin) return directUrl;
        return `/api-proxy?target=${encodeURIComponent(target.href)}`;
    } catch { return directUrl; }
}
