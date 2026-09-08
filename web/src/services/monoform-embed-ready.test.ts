import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DIRECTOR_PROTOCOL, DIRECTOR_PROTOCOL_VERSION } from "@/types/director";

// Execute the real ready effect without booting WebGL. This catches undeclared
// module state in the JSX studio, which the main application's TS check excludes.
function readyMessage(search: string) {
    const source = readFileSync(new URL("../../monoform-studio/src/App.jsx", import.meta.url), "utf8");
    const file = ts.createSourceFile("App.jsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    const declarations: string[] = [];
    let callback: ts.Expression | undefined;
    for (const statement of file.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (["EMBED_KEY", "DIRECTOR_PROTOCOL", "DIRECTOR_PROTOCOL_VERSION"].includes(declaration.name.getText(file))) declarations.push(`const ${declaration.getText(file)};`);
        }
    }
    function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && node.expression.getText(file) === "useEffect" && node.arguments[0]?.getText(file).includes("monoform:ready")) callback = node.arguments[0];
        ts.forEachChild(node, visit);
    }
    visit(file);
    if (!callback) throw new Error("MONOFORM ready effect is missing");
    const messages: unknown[] = [];
    runInNewContext(`${declarations.join("\n")}\n(${callback.getText(file)})();`, {
        window: { location: { search } },
        URLSearchParams,
        postDirectorMessage: (message: unknown) => messages.push(message),
    });
    return JSON.parse(JSON.stringify(messages));
}

describe("MONOFORM ready identity after account-storage integration", () => {
    it.each(["director-1", "director/一 ?#"])("announces its scoped project key without browser storage (%s)", (key) => {
        expect(readyMessage(`?key=${encodeURIComponent(key)}`)).toEqual([
            { protocol: DIRECTOR_PROTOCOL, version: DIRECTOR_PROTOCOL_VERSION, source: "monoform", type: "monoform:ready", payload: { capabilities: ["capture-image", "capture-pose", "capture-depth"], projectKey: key } },
        ]);
    });
    it("announces standalone capabilities without a project key", () => {
        expect(readyMessage("")).toEqual([{ protocol: DIRECTOR_PROTOCOL, version: DIRECTOR_PROTOCOL_VERSION, source: "monoform", type: "monoform:ready", payload: { capabilities: ["capture-image", "capture-pose", "capture-depth"] } }]);
    });
});
