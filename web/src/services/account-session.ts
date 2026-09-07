import { activateServerStorage, clearServerStorage, loadServerStorage } from "./server-storage";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useGenerationHistoryStore } from "@/stores/canvas/use-generation-history-store";
import { usePromptLibraryStore } from "@/stores/use-prompt-library-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";

let hydrationEpoch = 0;
function resetStores() {
    useCanvasStore.setState(useCanvasStore.getInitialState(), true);
    useAssetStore.setState(useAssetStore.getInitialState(), true);
    useConfigStore.setState(useConfigStore.getInitialState(), true);
    useGenerationHistoryStore.setState(useGenerationHistoryStore.getInitialState(), true);
    usePromptLibraryStore.setState(usePromptLibraryStore.getInitialState(), true);
    useCanvasUiStore.setState(useCanvasUiStore.getInitialState(), true);
}
export function clearUserData() {
    hydrationEpoch++;
    clearServerStorage();
    resetStores();
}
export async function hydrateUserData(userId: string) {
    clearUserData();
    const epoch = hydrationEpoch;
    await loadServerStorage(userId);
    if (epoch !== hydrationEpoch) throw new Error("账号加载已取消。");
    for (const store of [useCanvasStore, useAssetStore, useConfigStore, useGenerationHistoryStore, usePromptLibraryStore]) {
        await store.persist.rehydrate();
        if (epoch !== hydrationEpoch) throw new Error("账号加载已取消。");
        if (!store.persist.hasHydrated()) throw new Error("账号数据加载失败。不会使用空白数据覆盖服务端，请重试。");
    }
    activateServerStorage();
}
