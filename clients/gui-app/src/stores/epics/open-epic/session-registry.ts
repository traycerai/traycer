import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { appLogger } from "@/lib/logger";
import { useSyncExternalStore } from "react";
import { AGENT_WORKING_AWARENESS_FIELD } from "@traycer/protocol/host/epic/subscribe";

/**
 * MRU registry for live Epic sessions. Keeps up to 5 open in the background
 * so tab-switching is instant; evicts the oldest **clean / synced / inactive**
 * handle once the cap is exceeded.
 *
 * Soft-cap rule: if every entry is dirty (unsynced edits pending, or still
 * reconnecting with unflushed writes) or has active agent work, the registry
 * temporarily stays above the cap until at least one entry becomes clean and
 * inactive, at which point it prunes down to the cap. Closing an Epic tab
 * forcibly disposes that session regardless of the cap.
 */
export const DEFAULT_MAX_LIVE_EPICS = 5;
const loggedLiveTitleReadFailures = new Set<string>();

export interface OpenEpicSessionRegistryOptions {
  readonly maxLive: number;
}

interface RegistryEntry {
  readonly epicId: string;
  readonly handle: OpenEpicStoreHandle;
  lastUsedAt: number;
  mountedRefs: number;
  /**
   * Unsubscribe from the handle's unsynced-queue signal. Reaped on
   * release / disposeAll so we don't leak a zustand subscription after
   * the underlying session is gone.
   */
  unsubscribe: (() => void) | null;
  unsubscribeAwareness: (() => void) | null;
  /**
   * Last-seen value of the only four store fields that affect prune
   * eligibility or the unsynced-edits projection. The zustand
   * subscription fires on every `projection.revision` bump (i.e. every
   * keystroke); gating prune/emit on this cache key keeps Y-update bursts
   * from re-running the MRU walk and re-emitting to every React
   * subscriber per character.
   */
  lastEligibilityKey: string;
}

function eligibilityKeyFor(handle: OpenEpicStoreHandle): string {
  const state = handle.store.getState();
  const metaTitle = state.snapshotMeta?.epicLight?.title ?? "";
  return `${handle.isClean() ? 1 : 0}:${hasActiveAgentWork(handle) ? 1 : 0}:${state.isDirty ? 1 : 0}:${state.unsyncedQueueSize}:${metaTitle}`;
}

/**
 * Per-Epic unsynced-edits summary, aggregated across every live session
 * in the registry. T8 (desktop app-quit intercept) subscribes to this so
 * it can render the "these tabs have unsynced edits" confirmation sheet
 * without knowing which browser hooks live in which provider.
 */
export interface UnsyncedEditsEntry {
  readonly epicId: string;
  readonly title: string;
  readonly queueSize: number;
  readonly isDirty: boolean;
}

/**
 * Registry lifecycle:
 *   - `acquire(epicId, factory)` returns the existing handle or constructs a
 *     new one via `factory(epicId)`; recency is bumped on every call so the
 *     most-recently-interacted Epic stays alive.
 *   - `release(epicId)` disposes that entry unconditionally (tab closed).
 *   - `prune()` is run after every acquire; it disposes the least-recently
 *     used clean/inactive entries until size <= maxLive, skipping dirty or
 *     active entries.
 */
export class OpenEpicSessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly maxLive: number;
  private nextTick: number = 0;
  private readonly listeners = new Set<() => void>();
  private releaseListener: ((epicId: string) => void) | null = null;
  /**
   * Cached snapshot of the last-computed `getUnsyncedEdits()` result. We
   * keep it keyed by a structural cache key so `useSyncExternalStore`
   * returns a stable reference across polls where nothing changed -
   * otherwise React tears every frame.
   */
  private cachedUnsynced: ReadonlyArray<UnsyncedEditsEntry> = [];
  private cachedKey: string = "";

  constructor(options: OpenEpicSessionRegistryOptions) {
    this.maxLive = options.maxLive;
  }

  size(): number {
    return this.entries.size;
  }

  setReleaseListener(listener: ((epicId: string) => void) | null): void {
    this.releaseListener = listener;
  }

  get(epicId: string): OpenEpicStoreHandle | null {
    const entry = this.entries.get(epicId);
    if (entry === undefined) return null;
    entry.lastUsedAt = this.tick();
    return entry.handle;
  }

  /**
   * Read a live session handle without changing MRU ordering.
   *
   * Passive projections, such as the global header tab strip reading a live
   * generated epic title, must not make the epic count as recently used just
   * because React rendered or subscribed to the registry. Use `get()` only
   * when the caller is actively opening/interacting with the session.
   */
  peek(epicId: string): OpenEpicStoreHandle | null {
    return this.entries.get(epicId)?.handle ?? null;
  }

  acquire(
    epicId: string,
    factory: (epicId: string) => OpenEpicStoreHandle,
  ): OpenEpicStoreHandle {
    return this.acquireWithMountRefs(epicId, factory, 0);
  }

  acquireMounted(
    epicId: string,
    factory: (epicId: string) => OpenEpicStoreHandle,
  ): OpenEpicStoreHandle {
    return this.acquireWithMountRefs(epicId, factory, 1);
  }

  releaseMounted(epicId: string): void {
    const entry = this.entries.get(epicId);
    if (entry === undefined) return;
    if (entry.mountedRefs > 0) {
      entry.mountedRefs -= 1;
    }
    this.prune();
    this.emit();
  }

  private acquireWithMountRefs(
    epicId: string,
    factory: (epicId: string) => OpenEpicStoreHandle,
    mountedRefs: number,
  ): OpenEpicStoreHandle {
    const existing = this.entries.get(epicId);
    if (existing !== undefined) {
      existing.lastUsedAt = this.tick();
      existing.mountedRefs += mountedRefs;
      return existing.handle;
    }
    const handle = factory(epicId);
    const entry: RegistryEntry = {
      epicId,
      handle,
      lastUsedAt: this.tick(),
      mountedRefs,
      unsubscribe: null,
      unsubscribeAwareness: null,
      lastEligibilityKey: eligibilityKeyFor(handle),
    };
    const handleEligibilityChange = (): void => {
      const nextKey = eligibilityKeyFor(handle);
      if (nextKey === entry.lastEligibilityKey) return;
      entry.lastEligibilityKey = nextKey;
      this.prune();
      this.emit();
    };
    // Subscribe to the underlying store so prune-relevant changes trigger a
    // registry-level emit. Per-keystroke `projection.revision` bumps fire
    // the subscription too; gate on an "eligibility key" so the
    // steady-typing hot path doesn't re-run the MRU prune walk or re-emit
    // the unsynced-edits snapshot to every React subscriber per character.
    // Test fakes don't always hand back a full zustand store, so guard on
    // the method existing before calling.
    const maybeSubscribe = handle.store.subscribe;
    entry.unsubscribe =
      typeof maybeSubscribe === "function"
        ? maybeSubscribe.call(handle.store, handleEligibilityChange)
        : null;
    entry.unsubscribeAwareness =
      typeof handle.awareness.on === "function" &&
      typeof handle.awareness.off === "function"
        ? () => {
            handle.awareness.off("change", handleEligibilityChange);
          }
        : null;
    if (entry.unsubscribeAwareness !== null) {
      handle.awareness.on("change", handleEligibilityChange);
    }
    this.entries.set(epicId, entry);
    this.prune();
    this.emit();
    return handle;
  }

  release(epicId: string): void {
    const entry = this.entries.get(epicId);
    if (entry === undefined) return;
    this.entries.delete(epicId);
    this.disposeEntry(entry);
    this.emit();
  }

  requestFreshSnapshot(epicId: string): void {
    const entry = this.entries.get(epicId);
    if (entry === undefined) return;
    entry.handle.requestFreshSnapshot();
    this.emit();
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) {
      this.disposeEntry(entry);
    }
    this.entries.clear();
    this.emit();
  }

  /**
   * Snapshot of every live session that currently has unsynced edits.
   * Keyed by epicId; value carries the best-available title (live Y.Doc
   * title, falling back to snapshot-meta epicLight). Empty array means
   * every tab is either fully synced or has no unresolved local dirty state.
   */
  getUnsyncedEdits(): ReadonlyArray<UnsyncedEditsEntry> {
    const out: UnsyncedEditsEntry[] = [];
    for (const entry of this.entries.values()) {
      const state = entry.handle.store.getState();
      if (!state.isDirty) continue;
      const title = resolveUnsyncedTitle(
        readLiveTitle(entry.handle, entry.epicId),
        state.snapshotMeta?.epicLight?.title ?? "",
        entry.epicId,
      );
      out.push({
        epicId: entry.epicId,
        title,
        queueSize: state.unsyncedQueueSize,
        isDirty: state.isDirty,
      });
    }
    const cacheKey = out
      .map((e) => `${e.epicId}:${e.queueSize}:${e.isDirty}:${e.title}`)
      .join("|");
    if (cacheKey === this.cachedKey) {
      return this.cachedUnsynced;
    }
    this.cachedKey = cacheKey;
    this.cachedUnsynced = out;
    return out;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * Evict least-recently-used clean and inactive entries until size <= maxLive.
   * If every entry above the cap is dirty or active, we stop (soft cap) - the
   * next time a dirty entry flushes or an active entry goes idle, subsequent
   * `prune()` calls will finish the job.
   */
  prune(): void {
    if (this.entries.size <= this.maxLive) return;
    const ordered = Array.from(this.entries.values()).sort(
      (a, b) => a.lastUsedAt - b.lastUsedAt,
    );
    for (const entry of ordered) {
      if (this.entries.size <= this.maxLive) return;
      if (entry.mountedRefs > 0) continue;
      if (!entry.handle.isClean()) continue;
      if (hasActiveAgentWork(entry.handle)) continue;
      this.entries.delete(entry.epicId);
      this.disposeEntry(entry);
    }
  }

  private disposeEntry(entry: RegistryEntry): void {
    if (entry.unsubscribe !== null) entry.unsubscribe();
    if (entry.unsubscribeAwareness !== null) entry.unsubscribeAwareness();
    entry.handle.dispose();
    this.releaseListener?.(entry.epicId);
  }

  private tick(): number {
    this.nextTick += 1;
    return this.nextTick;
  }
}

function hasActiveAgentWork(handle: OpenEpicStoreHandle): boolean {
  if (typeof handle.awareness.getStates !== "function") return false;
  return Array.from(handle.awareness.getStates().values()).some((state) => {
    const working: unknown = state[AGENT_WORKING_AWARENESS_FIELD];
    return (
      Array.isArray(working) && working.some((id) => typeof id === "string")
    );
  });
}

function resolveUnsyncedTitle(
  liveTitle: string,
  metaTitle: string,
  epicId: string,
): string {
  if (liveTitle.length > 0) return liveTitle;
  if (metaTitle.length > 0) return metaTitle;
  return epicId;
}

function readLiveTitle(handle: OpenEpicStoreHandle, epicId: string): string {
  try {
    const epicMap = handle.doc.getMap("epic");
    const title = epicMap.get("title");
    return typeof title === "string" ? title : "";
  } catch (error) {
    if (!loggedLiveTitleReadFailures.has(epicId)) {
      loggedLiveTitleReadFailures.add(epicId);
      appLogger.error(
        "[open-epic-session-registry] failed to read live title",
        { epicId },
        error,
      );
    }
    return "";
  }
}

/**
 * React-side hook that returns the current aggregated unsynced-edits map
 * from a registry. The snapshot reference is cached - if nothing has
 * changed (same entries and queue sizes), the prior reference is returned
 * so consumers subscribed via `useSyncExternalStore` do not re-render.
 */
export function useRegistryUnsyncedEdits(
  registry: OpenEpicSessionRegistry,
): ReadonlyArray<UnsyncedEditsEntry> {
  return useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.getUnsyncedEdits(),
    () => EMPTY_UNSYNCED,
  );
}

const EMPTY_UNSYNCED: ReadonlyArray<UnsyncedEditsEntry> = [];
