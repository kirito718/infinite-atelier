type CloseSnapshot = { saving: boolean; error: string | null; confirmingDiscard: boolean };

/** A failed flush is not permission to close: discarding needs a separate confirmation. */
export function createDirectorCloseGuard(flush: () => Promise<void>, onClose: () => void) {
    let snapshot: CloseSnapshot = { saving: false, error: null, confirmingDiscard: false };
    let flight: Promise<boolean> | null = null;
    let epoch = 0;
    let closed = false;
    const listeners = new Set<() => void>();
    const publish = (next: CloseSnapshot) => {
        snapshot = next;
        listeners.forEach((listener) => listener());
    };
    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        requestClose(): Promise<boolean> {
            if (closed || snapshot.confirmingDiscard) return Promise.resolve(false);
            if (flight) return flight;
            const request = ++epoch;
            publish({ saving: true, error: null, confirmingDiscard: false });
            flight = Promise.resolve()
                .then(() => (request === epoch ? flush() : undefined))
                .then(
                    () => {
                        if (request !== epoch) return false;
                        closed = true;
                        publish({ saving: false, error: null, confirmingDiscard: false });
                        onClose();
                        return true;
                    },
                    (cause) => {
                        if (request !== epoch) return false;
                        publish({ saving: false, error: cause instanceof Error ? cause.message : "导演台保存失败，请重试或导出工程。", confirmingDiscard: false });
                        return false;
                    },
                )
                .finally(() => {
                    if (request === epoch) flight = null;
                });
            return flight;
        },
        requestDiscard() {
            if (!closed && snapshot.error && !snapshot.saving) publish({ ...snapshot, confirmingDiscard: true });
        },
        cancelDiscard() {
            publish({ ...snapshot, confirmingDiscard: false });
        },
        confirmDiscard() {
            if (closed || !snapshot.confirmingDiscard || !snapshot.error || snapshot.saving) return;
            closed = true;
            ++epoch;
            onClose();
        },
        // Ignore late acknowledgements after unmount, including StrictMode cleanup.
        cancelPending() {
            ++epoch;
            flight = null;
            closed = false;
            publish({ saving: false, error: null, confirmingDiscard: false });
        },
    };
}
