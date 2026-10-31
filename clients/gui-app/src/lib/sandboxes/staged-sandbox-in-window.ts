import { useCallback, useSyncExternalStore } from "react";
import {
  browserTabId,
  subscribeBrowserTabId,
} from "@/lib/browser-tab-identity";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import { composerSurfaceKey } from "@/stores/host/surface-host-selection-store";

/**
 * Until the staged-sandbox store is available, nothing is staged in this window
 * and the credits step stays hidden. The glob picks up the store when it is
 * available.
 */
interface StagedSandboxStoreApi {
  readonly getState: () => {
    readonly bySurface: Readonly<Partial<Record<string, unknown>>>;
  };
  readonly subscribe: (listener: () => void) => () => void;
}

interface StagedSandboxStoreModule {
  readonly useStagedSandboxStore: StagedSandboxStoreApi;
}

const STAGED_SANDBOX_STORE_MODULES = import.meta.glob<StagedSandboxStoreModule>(
  "/src/stores/composer/staged-sandbox-store.ts",
  { eager: true },
);

function stagedSandboxStore(): StagedSandboxStoreApi | null {
  const modules = Object.values(STAGED_SANDBOX_STORE_MODULES);
  if (modules.length === 0) return null;
  return modules[0].useStagedSandboxStore;
}

const STAGED_SANDBOX_STORE = stagedSandboxStore();

function readStage(
  store: StagedSandboxStoreApi | null,
  surfaceKey: string,
): unknown {
  if (store === null) return null;
  return store.getState().bySurface[surfaceKey] ?? null;
}

/** The landing composer's staged sandbox in this window, or `null`. */
export function useStagedSandboxInThisWindow(): unknown {
  const store = STAGED_SANDBOX_STORE;
  const bridgeWindowId = useWindowsBridge()?.windowId ?? null;
  const readWindowId = useCallback(
    () => bridgeWindowId ?? browserTabId(),
    [bridgeWindowId],
  );
  const windowId = useSyncExternalStore(subscribeBrowserTabId, readWindowId);
  const surfaceKey = composerSurfaceKey(windowId);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (store === null) return () => {};
      return store.subscribe(onStoreChange);
    },
    [store],
  );
  const getSnapshot = useCallback(
    () => readStage(store, surfaceKey),
    [store, surfaceKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function sandboxIsStagedInThisWindow(staged: unknown): boolean {
  return staged !== null;
}
