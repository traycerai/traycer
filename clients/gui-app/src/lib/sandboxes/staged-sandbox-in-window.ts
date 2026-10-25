import { useCallback, useSyncExternalStore } from "react";
import {
  browserTabId,
  subscribeBrowserTabId,
} from "@/lib/browser-tab-identity";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import { composerSurfaceKey } from "@/stores/host/surface-host-selection-store";

/**
 * G1 owns `stores/composer/staged-sandbox-store.ts`. Until that module
 * lands, nothing is staged in this window: the credits step stays hidden
 * and the Credits panel quotes the default shape. The glob is empty on
 * this branch and picks the store up the moment G1 merges.
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

export interface StagedNewShape {
  readonly os: string;
  readonly region: string;
  readonly cpus: number;
  readonly memoryMb: number;
  /** `null`: the provider's default disk. */
  readonly diskMb: number | null;
}

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

export function stagedNewShape(staged: unknown): StagedNewShape | null {
  if (!isRecord(staged)) return null;
  const target = staged.target;
  if (!isRecord(target) || target.kind !== "new") return null;
  const shape = target.shape;
  if (!isRecord(shape)) return null;
  if (typeof shape.os !== "string" || typeof shape.region !== "string") {
    return null;
  }
  if (typeof shape.cpus !== "number" || typeof shape.memoryMb !== "number") {
    return null;
  }
  return {
    os: shape.os,
    region: shape.region,
    cpus: shape.cpus,
    memoryMb: shape.memoryMb,
    diskMb: typeof shape.diskMb === "number" ? shape.diskMb : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
