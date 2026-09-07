import { afterEach, expect, it } from "vitest";
import { setAccountIdentity } from "./account-client";
import { bindAccountAction } from "./account-bound-action";
afterEach(() => setAccountIdentity(null));
it("drops late UI mutations after switching accounts, including logout/login to the same username", () => {
    const values: string[] = [];
    setAccountIdentity("alice");
    const mutate = bindAccountAction((value: string) => values.push(value));
    mutate("saved for A");
    setAccountIdentity("bobby");
    mutate("stale A");
    setAccountIdentity("alice");
    mutate("stale old session");
    expect(values).toEqual(["saved for A"]);
});

it("prevents late async media uploads from starting under the next account", async () => {
    const { bindAccountAsyncAction } = await import("./account-bound-action");
    const uploaded: string[] = [];
    setAccountIdentity("alice");
    const upload = bindAccountAsyncAction(async (value: string) => {
        uploaded.push(value);
        return value;
    });
    expect(await upload("first")).toBe("first");
    setAccountIdentity("bobby");
    await expect(upload("result of an old crop/decoder")).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(uploaded).toEqual(["first"]);
});
