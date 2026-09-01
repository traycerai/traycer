import { useCallback, useSyncExternalStore } from "react";
import { create, useStore } from "zustand";
import type { ResourceOwnerKindWireV14 } from "@traycer/protocol/host/resources/subscribe";
import type { ResourcesScopeSupport } from "@traycer-clients/shared/host-transport/resources-stream-client";
import {
  resourceOwnerKey,
  type AppResourceUsage,
  type EpicResourceUsage,
  type HostTreeResourceUsage,
  type OtherResourceUsage,
  type OwnerResourceUsage,
  type ResourcesState,
  type ResourcesStoreHandle,
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
  /**
   * The host whose transport this entry's stream is open against, taken by its
   * mount from the stream binding itself (`StreamRuntimeBinding.hostId`), or
   * `null` when that binding could not name one.
   *
   * It exists because this projection is a module singleton that outlives any
   * one transport, so a reader printing a host's name above this data needs to
   * PROVE the data came from that machine rather than assume it. Three ways it
   * would otherwise be wrong: a scoped surface reading a global entry that is
   * still the previous host's (a swap in flight), the per-epic fallback on a
   * host too old for a global stream, and — the one that has nothing to do with
   * the picker — an ambient host swap, where every other reader's idea of "the
   * active host" moves a commit before the transport does.
   */
  hostId: string | null;
  leases: number;
  unsubscribeStore: () => void;
}

export interface GlobalResourceEpicEntry {
  readonly epicId: string;
  readonly sampledAt: number | null;
  readonly app: AppResourceUsage | null;
  readonly hostTree: HostTreeResourceUsage | null;
  readonly other: OtherResourceUsage | null;
  readonly owners: readonly OwnerResourceUsage[];
  readonly epic: EpicResourceUsage | null;
}

export interface GlobalResourceProjection {
  /**
   * The host this snapshot came from, or `null` when it came from the per-epic
   * fallback (pre-v1.1 hosts, which have no global stream) or from no stream at
   * all. A surface that names a host must check this before rendering — see
   * `RegistryEntry.hostId`.
   */
  readonly hostId: string | null;
  readonly sampledAt: number | null;
  readonly app: AppResourceUsage | null;
  readonly hostTree: HostTreeResourceUsage | null;
  readonly other: OtherResourceUsage | null;
  readonly owners: readonly OwnerResourceUsage[];
  readonly entries: readonly GlobalResourceEpicEntry[];
}

/** Nothing tracked, from nowhere — a stand-in when no stream may be read. */
export const EMPTY_GLOBAL_RESOURCE_PROJECTION: GlobalResourceProjection = {
  hostId: null,
  sampledAt: null,
  app: null,
  hostTree: null,
  other: null,
  owners: [],
  entries: [],
};

class ResourcesRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private globalEntry: RegistryEntry | null = null;
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
    const globalEntry = this.usableGlobalEntry();
    if (globalEntry !== null) {
      const projection = this.getGlobalProjectionFromGlobalEntry(globalEntry);
      this.globalProjectionCache = {
        version: this.globalVersion,
        projection,
      };
      return projection;
    }
    const attribution = hostAttribution([...this.entries.values()]);
    if (attribution.kind === "mixed") {
      // Entries opened against different machines. Summing them would produce
      // totals no computer ever had, so the fallback publishes nothing at all
      // rather than a blend that merely declines to name itself.
      this.globalProjectionCache = {
        version: this.globalVersion,
        projection: EMPTY_GLOBAL_RESOURCE_PROJECTION,
      };
      return EMPTY_GLOBAL_RESOURCE_PROJECTION;
    }
    const entries = [...this.entries.values()].map((entry) => {
      const state = entry.handle.store.getState();
      const epicId =
        entry.handle.scope.kind === "epic" ? entry.handle.scope.epicId : "";
      return {
        epicId,
        sampledAt: state.sampledAt,
        app: state.app,
        hostTree: state.hostTree,
        other: state.other,
        owners: [...state.owners.values()],
        epic: state.epic,
      };
    });
    const owners = entries.flatMap((entry) => entry.owners);
    const app = latestAppSnapshot(entries);
    const hostTree = latestHostTreeSnapshot(entries);
    const other = latestOtherSnapshot(entries);
    const sampledAt = Math.max(
      app?.sampledAt ?? 0,
      ...entries.map((entry) => entry.sampledAt ?? 0),
    );
    const projection = {
      // The fallback aggregates entries opened by the epic panes, which all ride
      // one transport and so agree on a host. A disagreeing set never reaches
      // here — it returned empty above.
      hostId: attribution.hostId,
      sampledAt: sampledAt > 0 ? sampledAt : null,
      app,
      hostTree,
      other,
      owners,
      entries,
    };
    this.globalProjectionCache = {
      version: this.globalVersion,
      projection,
    };
    return projection;
  }

  /**
   * The global entry, or `null` when its own stream has reported that this host
   * cannot serve a global subscribe.
   *
   * An `@1.0` host accepts the downgraded global probe and answers with one
   * empty projection for an epic named `__global__` that does not exist. That
   * entry outranks the per-epic fallback below purely by existing, so without
   * this the surface publishes emptiness from a stream that will never carry
   * anything, while the per-epic streams on the very same transport are holding
   * that host's real numbers. Following the active host — where nothing on
   * screen names a machine and so no incompatible notice is shown — that read
   * as "Waiting for resource data." forever.
   *
   * Only `"unsupported"` disqualifies it. `"unknown"` is the ordinary state
   * before a negotiation settles, and treating it as a verdict would drop every
   * global projection for the whole handshake window.
   */
  private usableGlobalEntry(): RegistryEntry | null {
    const entry = this.globalEntry;
    if (entry === null) return null;
    return entry.handle.store.getState().scopeSupport === "unsupported"
      ? null
      : entry;
  }

  private getGlobalProjectionFromGlobalEntry(
    entry: RegistryEntry,
  ): GlobalResourceProjection {
    const state = entry.handle.store.getState();
    const owners = [...state.owners.values()];
    const epics = [...state.epics.values()];
    const epicIds = [
      ...new Set([
        ...owners.map((owner) => owner.owner.epicId),
        ...epics.map((epic) => epic.epicId),
      ]),
    ];
    const entries = epicIds.map((epicId) => {
      const scopedOwners = owners.filter(
        (owner) => owner.owner.epicId === epicId,
      );
      const epic = state.epics.get(epicId) ?? null;
      const sampledAt = Math.max(
        epic?.sampledAt ?? 0,
        scopedOwners.reduce((max, owner) => Math.max(max, owner.sampledAt), 0),
      );
      return {
        epicId,
        sampledAt: sampledAt > 0 ? sampledAt : null,
        app: state.app,
        hostTree: state.hostTree,
        other: state.other,
        owners: scopedOwners,
        epic,
      };
    });
    return {
      hostId: entry.hostId,
      sampledAt: state.sampledAt,
      app: state.app,
      hostTree: state.hostTree,
      other: state.other,
      owners,
      entries,
    };
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

  getGlobal(): ResourcesStoreHandle | null {
    return this.globalEntry?.handle ?? null;
  }

  /**
   * The live global stream's verdict on whether it can serve a global subscribe
   * — but only when that stream was opened against `claimedHostId`, the machine
   * the asking surface is NAMING.
   *
   * The attribution is not optional, and it is the strict, positive-proof kind
   * (`hostId` must be non-null and must match), for the same reason
   * `attributedProjection` demands it of the data: this entry is a module
   * singleton that outlives any one transport, so it routinely describes a
   * machine the current reading was not opened against — a host swap in flight,
   * where the entry is named at acquire time, one commit before the replacement
   * binding reaches context. Unchecked, picking an up-to-date host while the
   * previous (old) one's entry is still live would print "cannot report its
   * processes" under the NEW host's name. A verdict is an accusation about a
   * specific machine; it may only be repeated for the machine it was made about.
   *
   * No entry — and any mismatch — reads as `"unknown"`, never `"unsupported"`.
   * The mount declines to acquire for a host the client-wide pre-check already
   * convicted, so that absence is the pre-check's answer being acted on, not a
   * second independent one; reporting it as a verdict here would make every
   * pre-mount frame, the whole hydration gap, claim the host is too old.
   */
  getGlobalScopeSupport(claimedHostId: string | null): ResourcesScopeSupport {
    const entry = this.globalEntry;
    if (entry === null) return "unknown";
    if (entry.hostId === null || entry.hostId !== claimedHostId) {
      return "unknown";
    }
    return entry.handle.store.getState().scopeSupport;
  }

  acquire(
    epicId: string,
    clientToken: unknown,
    hostId: string | null,
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
      existing.hostId = hostId;
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
      hostId,
      leases: 1,
      unsubscribeStore: this.subscribeEntry(handle),
    });
    this.notify();
    this.notifyGlobal();
    return handle;
  }

  /**
   * `hostId` is the host the caller opened `clientToken` against — the claim
   * the projection republishes so a host-scoped reader can verify it. A caller
   * that cannot name one passes `null`, which reads as "do not attribute this
   * to any host" rather than as the active one.
   *
   * It is NOT part of the entry's identity: two lease holders sharing a
   * transport are by construction describing one machine, so a second acquire
   * keeps the name the first declared. A caller whose OWN host id changes must
   * release and re-acquire — which is what re-running an effect that names it
   * does.
   */
  acquireGlobal(
    clientToken: unknown,
    hostId: string | null,
    factory: () => ResourcesStoreHandle,
  ): ResourcesStoreHandle {
    if (this.globalEntry !== null) {
      if (this.globalEntry.clientToken === clientToken) {
        this.globalEntry.leases += 1;
        return this.globalEntry.handle;
      }
      this.globalEntry.unsubscribeStore();
      this.globalEntry.handle.dispose();
      const handle = factory();
      const unsubscribeStore = this.subscribeEntry(handle);
      this.globalEntry.handle = handle;
      this.globalEntry.clientToken = clientToken;
      this.globalEntry.hostId = hostId;
      this.globalEntry.unsubscribeStore = unsubscribeStore;
      this.globalEntry.leases += 1;
      this.notifyGlobal();
      return handle;
    }
    const handle = factory();
    this.globalEntry = {
      handle,
      clientToken,
      hostId,
      leases: 1,
      unsubscribeStore: this.subscribeEntry(handle),
    };
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

  releaseGlobal(): void {
    if (this.globalEntry === null) return;
    this.globalEntry.leases -= 1;
    if (this.globalEntry.leases > 0) return;
    const entry = this.globalEntry;
    this.globalEntry = null;
    entry.unsubscribeStore();
    entry.handle.dispose();
    this.notifyGlobal();
  }

  disposeAll(): void {
    if (this.entries.size === 0 && this.globalEntry === null) return;
    for (const entry of this.entries.values()) {
      entry.unsubscribeStore();
      entry.handle.dispose();
    }
    this.entries.clear();
    if (this.globalEntry !== null) {
      this.globalEntry.unsubscribeStore();
      this.globalEntry.handle.dispose();
      this.globalEntry = null;
    }
    this.notify();
    this.notifyGlobal();
  }
}

/**
 * The one host every entry was opened against, or `mixed` when they disagree.
 *
 * The distinction matters to the reader, which treats an unnamed projection as
 * "a single source that could not name itself" and shows it when nothing is
 * being claimed about a host. A BLEND of two machines is a different thing and
 * must not borrow that leniency, so it is reported separately rather than
 * collapsed into the same `null`.
 */
function hostAttribution(
  entries: readonly RegistryEntry[],
):
  | { readonly kind: "sole"; readonly hostId: string | null }
  | { readonly kind: "mixed" } {
  const hostIds = new Set(entries.map((entry) => entry.hostId));
  if (hostIds.size > 1) return { kind: "mixed" };
  return { kind: "sole", hostId: [...hostIds][0] ?? null };
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

// Both selectors compare the ENTRY-level `sampledAt`, not the nested
// snapshot's: identity-stable merges intentionally keep the previous nested
// object (with its old timestamp) when display values are unchanged, so the
// nested `sampledAt` can lag the frame that actually delivered it.
function latestHostTreeSnapshot(
  entries: readonly GlobalResourceEpicEntry[],
): HostTreeResourceUsage | null {
  const latest = entries
    .filter((entry) => entry.hostTree !== null)
    .reduce(
      (best: GlobalResourceEpicEntry | null, entry) =>
        best === null || (entry.sampledAt ?? 0) > (best.sampledAt ?? 0)
          ? entry
          : best,
      null,
    );
  return latest?.hostTree ?? null;
}

function latestOtherSnapshot(
  entries: readonly GlobalResourceEpicEntry[],
): OtherResourceUsage | null {
  const latest = entries
    .filter((entry) => entry.other !== null)
    .reduce(
      (best: GlobalResourceEpicEntry | null, entry) =>
        best === null || (entry.sampledAt ?? 0) > (best.sampledAt ?? 0)
          ? entry
          : best,
      null,
    );
  return latest?.other ?? null;
}

export const resourcesRegistry = new ResourcesRegistry();

// Stable fallback for `useStore` when no entry exists for an epic yet: every
// selector resolves to "not tracked" (empty owners / null aggregate).
const emptyResourcesStore = create<ResourcesState>()(() => ({
  key: "",
  connectionStatus: "closed",
  scopeSupport: "unknown",
  sampledAt: null,
  owners: new Map(),
  app: null,
  hostTree: null,
  other: null,
  epic: null,
  epics: new Map(),
  dispose: () => undefined,
}));

/**
 * Reactively resolves the live store handle for `epicId`, re-rendering when the
 * registry entry is created, rebuilt (host swap), or removed.
 */
function useResourcesHandle(epicId: string): ResourcesStoreHandle | null {
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
  kind: ResourceOwnerKindWireV14,
  ownerId: string,
  hostId: string | null,
): OwnerResourceUsage | null {
  const handle = useResourcesHandle(epicId);
  const store = handle === null ? emptyResourcesStore : handle.store;
  const key = resourceOwnerKey(kind, ownerId, hostId);
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

/**
 * Reactive `ResourcesRegistry.getGlobalScopeSupport` for the host the caller is
 * naming. Rides the same global listener set as the projection, which every
 * entry's store change already notifies, so a verdict published mid-stream
 * reaches the panel on the frame it lands rather than on whatever unrelated
 * render happens next.
 *
 * Returns a primitive rather than the projection, so a caller can watch the
 * verdict without re-rendering on every resource tick.
 */
export function useGlobalResourcesScopeSupport(
  claimedHostId: string | null,
): ResourcesScopeSupport {
  const subscribe = useCallback(
    (onChange: () => void) => resourcesRegistry.subscribeGlobal(onChange),
    [],
  );
  const getSnapshot = useCallback(
    () => resourcesRegistry.getGlobalScopeSupport(claimedHostId),
    [claimedHostId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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
