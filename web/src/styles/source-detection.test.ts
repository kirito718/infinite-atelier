import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { expect, it } from "vitest";

it("scans actual UI, HTML and Streamdown sources without scanning generated bundles or private/server data", async () => {
    const stylesheet = fileURLToPath(new URL("./globals.css", import.meta.url));
    const styles = dirname(stylesheet);
    const web = resolve(styles, "../..");
    const compiled = await compile(await readFile(stylesheet, "utf8"), { base: styles, from: stylesheet, onDependency: () => {} });
    // Automatic cwd scanning changes in Docker (no repository .gitignore) and
    // pulls in generated bundles. The app must declare its real sources instead.
    expect(compiled.root).toBe("none");
    const scanner = new Scanner({ sources: compiled.sources });
    const candidates = scanner.scan();
    const normal = (path: string) => path.replaceAll("\\", "/");
    const files = scanner.files.map(normal);
    expect(files).toContain(normal(resolve(web, "index.html")));
    expect(files).toContain(normal(resolve(web, "src/components/account/account-gate.tsx")));
    expect(files.some((file) => file.startsWith(normal(resolve(web, "node_modules/streamdown/dist")) + "/"))).toBe(true);
    expect(files.every((file) => file === normal(resolve(web, "index.html")) || file.startsWith(normal(resolve(web, "src")) + "/") || file.startsWith(normal(resolve(web, "node_modules/streamdown/dist")) + "/"))).toBe(true);
    const css = compiled.build(candidates);
    expect(css).toContain(".antialiased");
    expect(css).toContain(".bg-background");
    expect(css).toContain(".text-foreground");
    expect(css).toContain(".h-dvh");
});
