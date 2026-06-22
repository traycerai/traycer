import type { TerminalSessionStoreHandle } from "@/stores/terminals/terminal-session-store";

interface RegistryEntry {
  readonly instanceId: string;
  readonly handle: TerminalSessionStoreHandle;
  readonly unsubscribeStatus: () => void;
  leases: number;
}

/**
 * Per-renderer registry for live `terminal.subscribe` sessions, lease-counted
 * so the same tab instance can mount in more than one place (a split-reparent
 * transition, StrictMode double-mount) without each remount tearing down the
 * underlying stream client. Mirrors `ChatSessionRegistry` in shape, scoped to a
 * single window.
 *
 * Entries are keyed by the per-tab `instanceId`, not the host `sessionId`, so
 * two tab instances of the SAME PTY/TUI session each get their own handle and
 * their own `TerminalStreamClient` subscribing to the shared session. The
 * host already fans `terminal.subscribe` out to many subscribers and replays
 * scrollback to each, so a second live view costs nothing host-side.
 */
export class TerminalSessionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly listeners = new Set<() => void>();

  size(): number {
    return this.entries.size;
  }

  /**
   * Subscribe to membership changes (an instance added or removed). Mirrors
   * `ChatSessionRegistry.subscribe`. Per-session lifecycle-status changes are
   * observed by subscribing to each handle's store, not here. The
   * agent-activity monitor uses this to keep its per-store subscriptions in
   * sync as terminal tiles mount and unmount.
   */
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

  /** Live session handles, for aggregate reads (e.g. agent-activity). */
  listHandles(): TerminalSessionStoreHandle[] {
    return Array.from(this.entries.values(), (entry) => entry.handle);
  }

  /**
   * Live tab-instance ids. The xterm host registry keeps still-live
   * terminal-agent engines warm keyed by `instanceId`; it uses this to drop a
   * warm engine once its instance leaves the registry (the agent exited and its
   * lease-free handle was evicted).
   */
  listInstanceIds(): string[] {
    return Array.from(this.entries.keys());
  }

  get(instanceId: string): TerminalSessionStoreHandle | null {
    const entry = this.entries.get(instanceId);
    return entry === undefined ? null : entry.handle;
  }

  acquire(
    instanceId: string,
    factory: () => TerminalSessionStoreHandle,
  ): TerminalSessionStoreHandle {
    const existing = this.entries.get(instanceId);
    if (existing !== undefined) {
      existing.leases += 1;
      return existing.handle;
    }
    const handle = factory();
    const entry: RegistryEntry = {
      instanceId,
      handle,
      unsubscribeStatus: handle.store.subscribe((state) => {
        if (state.status !== "exited") return;
        this.evictExitedLeaseFreeEntry(instanceId);
      }),
      leases: 1,
    };
    this.entries.set(instanceId, entry);
    this.notify();
    return handle;
  }

  release(instanceId: string): void {
    const entry = this.entries.get(instanceId);
    if (entry === undefined) return;
    if (entry.leases <= 0) return;
    entry.leases -= 1;
    if (entry.leases > 0) return;
    if (shouldKeepLeaseFree(entry.handle)) return;
    this.entries.delete(instanceId);
    this.disposeEntry(entry);
    this.notify();
  }

  forceRelease(instanceId: string): void {
    const entry = this.entries.get(instanceId);
    if (entry === undefined) return;
    this.entries.delete(instanceId);
    this.disposeEntry(entry);
    this.notify();
  }

  disposeAll(): void {
    if (this.entries.size === 0) return;
    for (const entry of this.entries.values()) {
      this.disposeEntry(entry);
    }
    this.entries.clear();
    this.notify();
  }

  private evictExitedLeaseFreeEntry(instanceId: string): void {
    const entry = this.entries.get(instanceId);
    if (entry === undefined) return;
    if (entry.leases > 0) return;
    this.entries.delete(instanceId);
    this.disposeEntry(entry);
    this.notify();
  }

  private disposeEntry(entry: RegistryEntry): void {
    entry.unsubscribeStatus();
    entry.handle.dispose();
  }
}

function shouldKeepLeaseFree(handle: TerminalSessionStoreHandle): boolean {
  const state = handle.store.getState();
  return state.kind === "terminal-agent" && state.status !== "exited";
}
