import { use, useCallback, useSyncExternalStore } from "react";
import { resolveDesktopGlobalShortcutsBridge } from "@/lib/windows/desktop-capabilities";
import type {
  DesktopGlobalShortcutsBridge,
  DesktopGlobalShortcutsSnapshot,
  GlobalShortcutStatus,
} from "@/lib/windows/types";
import { appLogger } from "@/lib/logger";
import { RunnerHostContext } from "@/providers/runner-host-context";

export interface SummonHotkeyState {
  readonly bridge: DesktopGlobalShortcutsBridge | null;
  // `null` until the bridge's first snapshot resolves, or permanently on a
  // shell without the desktop global-shortcuts bridge (`bridge === null`
  // too, in that case).
  readonly status: GlobalShortcutStatus | null;
}

type StoreListener = () => void;

const stores = new WeakMap<
  DesktopGlobalShortcutsBridge,
  GlobalShortcutsStore
>();

/**
 * Reactive view of the desktop's `summon` global shortcut, pushed from the
 * Electron main process. `null` bridge/status on any shell without the
 * desktop global-shortcuts bridge (browser tab, pre-registry builds).
 */
export function useSummonHotkey(): SummonHotkeyState {
  const runnerHost = use(RunnerHostContext);
  const bridge =
    runnerHost === null
      ? null
      : resolveDesktopGlobalShortcutsBridge(runnerHost);
  const store = bridge === null ? null : getGlobalShortcutsStore(bridge);
  const subscribe = useCallback(
    (listener: StoreListener) => {
      if (store === null) return () => undefined;
      return store.subscribe(listener);
    },
    [store],
  );
  const getSnapshot = useCallback(
    () => (store === null ? null : store.getStatus()),
    [store],
  );
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { bridge, status };
}

function getGlobalShortcutsStore(
  bridge: DesktopGlobalShortcutsBridge,
): GlobalShortcutsStore {
  const existing = stores.get(bridge);
  if (existing !== undefined) {
    return existing;
  }
  const store = new GlobalShortcutsStore(bridge);
  stores.set(bridge, store);
  return store;
}

class GlobalShortcutsStore {
  private snapshot: DesktopGlobalShortcutsSnapshot | null = null;
  private readonly listeners = new Set<StoreListener>();
  private subscription: { dispose(): void } | null = null;
  private snapshotLoadInFlight = false;

  constructor(private readonly bridge: DesktopGlobalShortcutsBridge) {}

  getStatus(): GlobalShortcutStatus | null {
    return this.snapshot?.statuses.summon ?? null;
  }

  subscribe(listener: StoreListener): () => void {
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
        appLogger.error("[global-shortcuts] snapshot load failed", {}, error);
      })
      .finally(() => {
        this.snapshotLoadInFlight = false;
      });
  }

  private deactivate(): void {
    this.subscription?.dispose();
    this.subscription = null;
  }

  private accept(next: DesktopGlobalShortcutsSnapshot): void {
    if (this.snapshot !== null && next.sequence < this.snapshot.sequence) {
      return;
    }
    if (
      this.snapshot !== null &&
      next.sequence === this.snapshot.sequence &&
      sameStatus(next.statuses.summon, this.snapshot.statuses.summon)
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function sameStatus(
  left: GlobalShortcutStatus,
  right: GlobalShortcutStatus,
): boolean {
  return (
    left.status === right.status &&
    left.effectiveChord === right.effectiveChord &&
    left.intent.enabled === right.intent.enabled &&
    left.intent.chord === right.intent.chord
  );
}
