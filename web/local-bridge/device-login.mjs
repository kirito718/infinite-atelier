const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

export function isLoginId(value) {
    return text(value, 200);
}

// Verification data is short-lived UI state, not an OAuth token or an app URL.
// Keep the allowlist tied to the managed device flow in pinned Codex 0.153.4.
export function publicDeviceLogin(result) {
    let url;
    try {
        url = new URL(result?.verificationUrl);
    } catch {
        /* reject below */
    }
    if (
        result?.type !== "chatgptDeviceCode" ||
        !isLoginId(result.loginId) ||
        !text(result.userCode, 128) ||
        !text(result.verificationUrl, 2048) ||
        !url ||
        url.origin !== "https://auth.openai.com" ||
        url.pathname.replace(/\/$/, "") !== "/codex/device" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    ) {
        throw new Error("Codex 未返回有效的官方设备码登录信息，请检查 CLI 版本及设备码登录设置。");
    }
    return { type: "chatgptDeviceCode", loginId: result.loginId, verificationUrl: url.href, userCode: result.userCode };
}
