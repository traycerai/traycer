import type { DesktopPerWindowStatePatch } from "@/lib/windows/types";

export const DESKTOP_PER_WINDOW_PROJECTION_DEBOUNCE_MS = 100;

export interface DesktopPerWindowProjectionBridge {
  update(patch: DesktopPerWindowStatePatch): Promise<void>;
  flush(): Promise<void>;
  dispose(): void;
}

interface DesktopPerWindowProjectionTarget {
  update(patch: DesktopPerWindowStatePatch): Promise<void>;
}

let activeProjectionBridge: DesktopPerWindowProjectionBridge | null = null;

export function createDebouncedDesktopPerWindowProjectionBridge(
  target: DesktopPerWindowProjectionTarget,
  debounceMs: number,
): DesktopPerWindowProjectionBridge {
  let pendingPatch: DesktopPerWindowStatePatch | null = null;
  let timer: Parameters<typeof clearTimeout>[0] | null = null;
  let disposed = false;
  let writeChain: Promise<void> = Promise.resolve();

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const flush = (): Promise<void> => {
    clearTimer();
    const patch = pendingPatch;
    pendingPatch = null;
    if (patch === null) return writeChain;
    writeChain = writeChain.then(() => target.update(patch));
    return writeChain;
  };

  const schedule = (): void => {
    clearTimer();
    timer = setTimeout(() => {
      void flush();
    }, debounceMs);
  };

  return {
    update: (patch) => {
      if (disposed) return Promise.resolve();
      pendingPatch =
        pendingPatch === null
          ? patch
          : mergePerWindowPatches(pendingPatch, patch);
      schedule();
      return Promise.resolve();
    },
    flush,
    dispose: () => {
      disposed = true;
      clearTimer();
    },
  };
}

export function setActiveDesktopPerWindowProjectionBridge(
  bridge: DesktopPerWindowProjectionBridge | null,
): void {
  activeProjectionBridge = bridge;
}

export function flushActiveDesktopPerWindowProjection(): Promise<void> {
  return activeProjectionBridge?.flush() ?? Promise.resolve();
}

const SCALAR_PATCH_KEYS = [
  "epicTabs",
  "activeTabId",
  "landingDrafts",
  "activeLandingDraftId",
] as const satisfies ReadonlyArray<keyof DesktopPerWindowStatePatch>;

function mergeScalarKey<K extends keyof DesktopPerWindowStatePatch>(
  merged: DesktopPerWindowStatePatch,
  current: DesktopPerWindowStatePatch,
  next: DesktopPerWindowStatePatch,
  key: K,
): void {
  if (!(key in current) && !(key in next)) return;
  Object.assign(merged, {
    [key]: key in next ? next[key] : current[key],
  });
}

function mergePerWindowPatches(
  current: DesktopPerWindowStatePatch,
  next: DesktopPerWindowStatePatch,
): DesktopPerWindowStatePatch {
  const merged: DesktopPerWindowStatePatch = {};
  for (const key of SCALAR_PATCH_KEYS) {
    mergeScalarKey(merged, current, next, key);
  }
  if ("canvasByTabId" in current || "canvasByTabId" in next) {
    Object.assign(merged, {
      canvasByTabId: {
        ...("canvasByTabId" in current ? current.canvasByTabId : {}),
        ...("canvasByTabId" in next ? next.canvasByTabId : {}),
      },
    });
  }
  return merged;
}
