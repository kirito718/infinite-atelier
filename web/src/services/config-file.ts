import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { flushServerChanges } from "@/services/server-storage";
import { assertAccountIdentity, getAccountIdentity } from "@/services/account-client";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
};

export function exportAppConfig() {
    const { config } = useConfigStore.getState();
    const data: AppConfigFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config };
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

export async function importAppConfig(file: File) {
    const userId = getAccountIdentity();
    assertAccountIdentity(userId);
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    if (data.app !== "infinite-canvas" || data.version !== 1 || !data.config) throw new Error(i18n.t("config.invalidFile"));
    assertAccountIdentity(userId);
    useConfigStore.setState({ config: data.config });
    await flushServerChanges();
}
