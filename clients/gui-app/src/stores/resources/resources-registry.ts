import { useCallback, useSyncExternalStore } from "react";
import { create, useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { ResourceOwnerKindWire } from "@traycer/protocol/host/resources/subscribe";
import {
  deriveTaskResourceSummary,
  resourceOwnerKey,
  type AppResourceUsage,
  type EpicResourceUsage,
  type OwnerResourceUsage,
  type ResourcesState,
  type ResourcesStoreHandle,
  type TaskResourceSummary,
} from "@/stores/resources/resources-store";

/**
 * Module-scoped registry of live `resources.subscribe` stores, keyed by
 * `epicId`. The `ResourcesStreamMount` inside each epic pane acquires an entry
 * (lease-counted, so two panes on the same epic share one stream) and releases
 * it on unmount; app-level surfaces (the terminal / chat sidebars, the epic
 * status row) read the entry by `epicId` without needing to sit inside that
 * pane's React subtree.
 *
 * `clientToken` guards a host swap: the `WsStreamClient` identity is carried
 * alongside each entry, and an acquire whose token differs from the live entry
 * rebuilds the underlying store against the fresh client (keeping the lease
 * count) so a stale transport is never reused.
 */
interface RegistryEntry {
  handle: ResourcesStoreHandle;
  clientToken: unknown;
  leases: number;
  unsubscribeStore: () => void;
}

export interface GlobalResourceEpicEntry {
  readonly epicId: string;
  readonly sampledAt: number | null;
  readonly app: AppResourceUsage | null;
  readonly owners: readonly OwnerResourceUsage[];
  readonly epic: EpicResourceUsage | null;
  readonly taskSummary: TaskResourceSummary | null;
}

export interface GlobalResourceProjection {
  readonly sampledAt: number | null;
  readonly app: AppResourceUsage | null;
  readonly owners: readonly OwnerResourceUsage[];
  readonly entries: readonly GlobalResourceEpicEntry[];
  readonly summary: TaskResourceSummary | null;
}

class ResourcesRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly globalListeners = new Set<() => void>();
  private globalVersion = 0;
  private globalProjectionCache: {
    readonly version: number;
    readonly projection: GlobalResourceProjection;
  } | null = null;

  /** Membership changes (an epic entry created, rebuilt, or removed). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }

  subscribeGlobal(listener: () => void): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  private notifyGlobal(): void {
    this.globalVersion += 1;
    for (const listener of Array.from(this.globalListeners)) {
      listener();
    }
  }

  getGlobalProjection(): GlobalResourceProjection {
    if (this.globalProjectionCache?.version === this.globalVersion) {
      return this.globalProjectionCache.projection;
    }
    const entries = [...this.entries.values()].map((entry) => {
      const state = entry.handle.store.getState();
      return {
        epicId: entry.handle.epicId,
        sampledAt: state.sampledAt,
        app: state.app,
        owners: [...state.owners.values()],
        epic: state.epic,
        taskSummary: state.taskSummary,
      };
    });
    const owners = entries.flatMap((entry) => entry.owners);
    const app = latestAppSnapshot(entries);
    const sampledAt = Math.max(
      app?.sampledAt ?? 0,
      ...entries.map((entry) => entry.sampledAt ?? 0),
    );
    const projection = {
      sampledAt: sampledAt > 0 ? sampledAt : null,
      app,
      owners,
      entries,
      summary: deriveTaskResourceSummary(app, owners),
    };
    this.globalProjectionCache = {
      version: this.globalVersion,
      projection,
    };
    return projection;
  }

  private subscribeEntry(handle: ResourcesStoreHandle): () => void {
    return handle.store.subscribe(() => {
      this.notifyGlobal();
    });
  }

  get(epicId: string): ResourcesStoreHandle | null {
    const entry = this.entries.get(epicId);
    return entry === undefined ? null : entry.handle;
  }

  acquire(
    epicId: string,
    clientToken: unknown,
    factory: () => ResourcesStoreHandle,
  ): ResourcesStoreHandle {
    const existing = this.entries.get(epicId);
    if (existing !== undefined) {
      if (existing.clientToken === clientToken) {
        existing.leases += 1;
        return existing.handle;
      }
      // Host swap under the same open epic: dispose the stale-client store and
      // rebuild against the new client, preserving the outstanding lease count.
      existing.unsubscribeStore();
      existing.handle.dispose();
      const handle = factory();
      const unsubscribeStore = this.subscribeEntry(handle);
      existing.handle = handle;
      existing.clientToken = clientToken;
      existing.unsubscribeStore = unsubscribeStore;
      existing.leases += 1;
      this.notify();
      this.notifyGlobal();
      return handle;
    }
    const handle = factory();
    this.entries.set(epicId, {
      handle,
      clientToken,
      leases: 1,
      unsubscribeStore: this.subscribeEntry(handle),
    });
    this.notify();
    this.notifyGlobal();
    return handle;
  }

  release(epicId: string): void {
    const entry = this.entries.get(epicId);
    if (entry === undefined) return;
    entry.leases -= 1;
    if (entry.leases > 0) return;
    this.entries.delete(epicId);
    entry.unsubscribeStore();
    entry.handle.dispose();
    this.notify();
    this.notifyGlobal();
  }

  disposeAll(): void {
    if (this.entries.size === 0) return;
    for (const entry of this.entries.values()) {
      entry.unsubscribeStore();
      entry.handle.dispose();
    }
    this.entries.clear();
    this.notify();
    this.notifyGlobal();
  }
}

function latestAppSnapshot(
  entries: readonly GlobalResourceEpicEntry[],
): AppResourceUsage | null {
  let latest: AppResourceUsage | null = null;
  for (const entry of entries) {
    if (entry.app === null) continue;
    if (latest === null || entry.app.sampledAt > latest.sampledAt) {
      latest = entry.app;
    }
  }
  return latest;
}

export const resourcesRegistry = new ResourcesRegistry();

// Stable fallback for `useStore` when no entry exists for an epic yet: every
// selector resolves to "not tracked" (empty owners / null aggregate).
const emptyResourcesStore = create<ResourcesState>()(() => ({
  epicId: "",
  connectionStatus: "closed",
  sampledAt: null,
  owners: new Map(),
  app: null,
  epic: null,
  taskSummary: null,
  dispose: () => undefined,
}));

/**
 * Reactively resolves the live store handle for `epicId`, re-rendering when the
 * registry entry is created, rebuilt (host swap), or removed.
 */
export function useResourcesHandle(
  epicId: string,
): ResourcesStoreHandle | null {
  const getSnapshot = useCallback(
    () => resourcesRegistry.get(epicId),
    [epicId],
  );
  const subscribe = useCallback(
    (onChange: () => void) => resourcesRegistry.subscribe(onChange),
    [],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Live resource use for one owner, or `null` when no snapshot exists for it -
 * "not currently tracked", NOT zero use. Callers render nothing on `null`.
 */
export function useOwnerResourceUsage(
  epicId: string,
  kind: ResourceOwnerKindWire,
  ownerId: string,
): OwnerResourceUsage | null {
  const handle = useResourcesHandle(epicId);
  const store = handle === null ? emptyResourcesStore : handle.store;
  const key = resourceOwnerKey(kind, ownerId);
  return useStore(store, (state) => {
    const owner = state.owners.get(key);
    return owner === undefined ? null : owner;
  });
}

/** Live epic-aggregate use, or `null` when the epic has no tracked owners. */
export function useEpicResourceUsage(epicId: string): EpicResourceUsage | null {
  const handle = useResourcesHandle(epicId);
  const store = handle === null ? emptyResourcesStore : handle.store;
  return useStore(store, (state) => state.epic);
}

/** Host-app usage sampled with the task projection, or `null` before sampling. */
export function useAppResourceUsage(epicId: string): AppResourceUsage | null {
  const handle = useResourcesHandle(epicId);
  const store = handle === null ? emptyResourcesStore : handle.store;
  return useStore(store, (state) => state.app);
}

/** Live owner snapshots for this task, preserving the store's stable owner refs. */
export function useOwnerResourceUsages(
  epicId: string,
): readonly OwnerResourceUsage[] {
  const handle = useResourcesHandle(epicId);
  const store = handle === null ? emptyResourcesStore : handle.store;
  return useStore(
    store,
    useShallow((state) => [...state.owners.values()]),
  );
}

export function useGlobalResourceProjection(): GlobalResourceProjection {
  const subscribe = useCallback(
    (onChange: () => void) => resourcesRegistry.subscribeGlobal(onChange),
    [],
  );
  return useSyncExternalStore(
    subscribe,
    () => resourcesRegistry.getGlobalProjection(),
    () => resourcesRegistry.getGlobalProjection(),
  );
}

/**
 * Live task-level resource summary derived in the renderer from the current
 * owner projection. `null` means no tracked owners are present.
 */
export function useTaskResourceSummary(
  epicId: string,
): TaskResourceSummary | null {
  const handle = useResourcesHandle(epicId);
  const store = handle === null ? emptyResourcesStore : handle.store;
  return useStore(store, (state) => state.taskSummary);
}
