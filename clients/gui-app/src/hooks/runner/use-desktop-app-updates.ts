import { use, useCallback, useSyncExternalStore } from "react";
import { resolveDesktopAppUpdatesBridge } from "@/lib/windows/desktop-capabilities";
import type {
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
} from "@/lib/windows/types";
import { appLogger } from "@/lib/logger";
import { RunnerHostContext } from "@/providers/runner-host-context";

const DESKTOP_APP_UPDATE_IDLE_SNAPSHOT: DesktopAppUpdateSnapshot = {
  sequence: 0,
  status: "idle",
  currentVersion: "",
  allowPrerelease: false,
  latestVersion: null,
  downloadProgress: null,
  installBlockedReason: null,
  installGuidance: null,
  errorMessage: null,
  lastCheckedAt: null,
  lastCheckIntent: null,
};

export interface DesktopAppUpdatesState {
  readonly bridge: DesktopAppUpdatesBridge | null;
  readonly snapshot: DesktopAppUpdateSnapshot;
}

type AppUpdateStoreListener = () => void;

const stores = new WeakMap<DesktopAppUpdatesBridge, DesktopAppUpdateStore>();

export function useDesktopAppUpdates(): DesktopAppUpdatesState {
  const runnerHost = use(RunnerHostContext);
  const bridge =
    runnerHost === null ? null : resolveDesktopAppUpdatesBridge(runnerHost);
  const store = bridge === null ? null : getDesktopAppUpdateStore(bridge);
  const subscribe = useCallback(
    (listener: AppUpdateStoreListener) => {
      if (store === null) return () => undefined;
      return store.subscribe(listener);
    },
    [store],
  );
  const getSnapshot = useCallback(
    () =>
      store === null ? DESKTOP_APP_UPDATE_IDLE_SNAPSHOT : store.getSnapshot(),
    [store],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { bridge, snapshot };
}

/**
 * The active release channel, as pushed from the Electron main process to
 * every window. This is the single per-window source of truth for the channel:
 * host-registry query identity, the Settings → Host available-versions filter,
 * and the RC toggle all read it, so they can never disagree within a window.
 *
 * `false` (stable only) in shells without the desktop update bridge.
 */
export function useAllowPrereleaseUpdates(): boolean {
  return useDesktopAppUpdates().snapshot.allowPrerelease;
}

function getDesktopAppUpdateStore(
  bridge: DesktopAppUpdatesBridge,
): DesktopAppUpdateStore {
  const existing = stores.get(bridge);
  if (existing !== undefined) {
    return existing;
  }
  const store = new DesktopAppUpdateStore(bridge);
  stores.set(bridge, store);
  return store;
}

class DesktopAppUpdateStore {
  private snapshot = DESKTOP_APP_UPDATE_IDLE_SNAPSHOT;
  private readonly listeners = new Set<AppUpdateStoreListener>();
  private subscription: { dispose(): void } | null = null;
  private snapshotLoadInFlight = false;

  constructor(private readonly bridge: DesktopAppUpdatesBridge) {}

  getSnapshot(): DesktopAppUpdateSnapshot {
    return this.snapshot;
  }

  subscribe(listener: AppUpdateStoreListener): () => void {
    this.listeners.add(listener);
    this.activate();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.deactivate();
      }
    };
  }

  private activate(): void {
    if (this.subscription === null) {
      this.subscription = this.bridge.onChange((next) => {
        this.accept(next);
      });
    }
    if (this.snapshotLoadInFlight) {
      return;
    }
    this.snapshotLoadInFlight = true;
    void this.bridge
      .getSnapshot()
      .then((next) => {
        this.accept(next);
      })
      .catch((error: unknown) => {
        appLogger.error("[app-update] snapshot load failed", {}, error);
      })
      .finally(() => {
        this.snapshotLoadInFlight = false;
      });
  }

  private deactivate(): void {
    this.subscription?.dispose();
    this.subscription = null;
  }

  private accept(next: DesktopAppUpdateSnapshot): void {
    if (next.sequence < this.snapshot.sequence) {
      return;
    }
    if (
      next.sequence === this.snapshot.sequence &&
      sameSnapshot(next, this.snapshot)
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function sameSnapshot(
  left: DesktopAppUpdateSnapshot,
  right: DesktopAppUpdateSnapshot,
): boolean {
  return (
    left.sequence === right.sequence &&
    left.status === right.status &&
    left.currentVersion === right.currentVersion &&
    left.allowPrerelease === right.allowPrerelease &&
    left.latestVersion === right.latestVersion &&
    left.downloadProgress === right.downloadProgress &&
    left.installBlockedReason === right.installBlockedReason &&
    sameInstallGuidance(left.installGuidance, right.installGuidance) &&
    left.errorMessage === right.errorMessage &&
    left.lastCheckedAt === right.lastCheckedAt &&
    left.lastCheckIntent === right.lastCheckIntent
  );
}

// `installGuidance` is the one non-primitive snapshot field, so it can't rely
// on `===` like its siblings - every IPC send structurally clones the object,
// so a reference comparison would report "changed" on every emit even when
// the content is identical (spurious re-renders). `command` + `summary` are
// deterministic given (packageType, downloadedFile, version) in
// `buildLinuxUpdateGuidance`, so they're a sufficient proxy for full content
// equality without a recursive deep-equal for the `steps` array.
function sameInstallGuidance(
  left: DesktopAppUpdateSnapshot["installGuidance"],
  right: DesktopAppUpdateSnapshot["installGuidance"],
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.command === right.command && left.summary === right.summary;
}
