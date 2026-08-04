import { useCallback, useMemo, useSyncExternalStore } from "react";
import { create, useStore } from "zustand";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type {
  ManagedCommandListState,
  ManagedCommandListStoreHandle,
} from "@/stores/managed-commands/managed-command-list-store";

/**
 * Module-scoped registry of live `managedCommand.subscribeList` stores, keyed
 * by `epicId`, mirroring the resources registry. The mount inside the epic pane
 * acquires an entry (lease-counted, so two panes on the same epic share one
 * stream) and releases it on unmount; the sidebar section, a chat tile's
 * running-work strip and an output window all read the entry by `epicId`
 * without sitting in one another's subtree.
 *
 * `clientToken` guards a host swap: an acquire whose token differs from the
 * live entry rebuilds the store against the fresh client, keeping the lease
 * count, so a stale transport is never reused.
 */
interface RegistryEntry {
  handle: ManagedCommandListStoreHandle;
  clientToken: unknown;
  leases: number;
}

class ManagedCommandListRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly listeners = new Set<() => void>();

  /** Membership changes (an entry created, rebuilt, or removed). */
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

  get(epicId: string): ManagedCommandListStoreHandle | null {
    return this.entries.get(epicId)?.handle ?? null;
  }

  acquire(
    epicId: string,
    clientToken: unknown,
    factory: () => ManagedCommandListStoreHandle,
  ): ManagedCommandListStoreHandle {
    const existing = this.entries.get(epicId);
    if (existing !== undefined) {
      if (existing.clientToken === clientToken) {
        existing.leases += 1;
        return existing.handle;
      }
      existing.handle.dispose();
      existing.handle = factory();
      existing.clientToken = clientToken;
      existing.leases += 1;
      this.notify();
      return existing.handle;
    }
    const handle = factory();
    this.entries.set(epicId, { handle, clientToken, leases: 1 });
    this.notify();
    return handle;
  }

  release(epicId: string): void {
    const entry = this.entries.get(epicId);
    if (entry === undefined) return;
    entry.leases -= 1;
    if (entry.leases > 0) return;
    this.entries.delete(epicId);
    entry.handle.dispose();
    this.notify();
  }

  disposeAll(): void {
    if (this.entries.size === 0) return;
    for (const entry of this.entries.values()) {
      entry.handle.dispose();
    }
    this.entries.clear();
    this.notify();
  }
}

export const managedCommandListRegistry = new ManagedCommandListRegistry();

// Stable fallback for `useStore` before an entry exists: reads as "not answered
// yet", the same state a freshly-opened stream is in.
const emptyManagedCommandListStore = create<ManagedCommandListState>()(() => ({
  epicId: "",
  connectionStatus: "connecting",
  commands: null,
  dispose: () => undefined,
}));

function useManagedCommandListStore(epicId: string) {
  const getSnapshot = useCallback(
    () => managedCommandListRegistry.get(epicId),
    [epicId],
  );
  const subscribe = useCallback(
    (onChange: () => void) => managedCommandListRegistry.subscribe(onChange),
    [],
  );
  const handle = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return handle === null ? emptyManagedCommandListStore : handle.store;
}

/**
 * Every managed command in the epic, running first then most recent activity.
 * `null` while the stream has yet to answer - callers must not render "no
 * monitors yet" over it.
 */
export function useManagedCommandList(
  epicId: string,
): readonly ManagedCommand[] | null {
  return useStore(
    useManagedCommandListStore(epicId),
    (state) => state.commands,
  );
}

export function useManagedCommandListConnectionStatus(
  epicId: string,
): StreamConnectionStatus {
  return useStore(
    useManagedCommandListStore(epicId),
    (state) => state.connectionStatus,
  );
}

/** One command's live record, or `null` when the epic's list has no such id. */
export function useManagedCommand(
  epicId: string,
  commandId: string,
): ManagedCommand | null {
  const commands = useManagedCommandList(epicId);
  return useMemo(
    () => commands?.find((command) => command.id === commandId) ?? null,
    [commands, commandId],
  );
}

/**
 * The running commands one chat owns - the client-side join behind that chat's
 * running-work strip rows (`UI.md` §5). The epic list already carries the
 * owning chat id, so the strip needs no wire of its own.
 */
export function useRunningManagedCommandsForChat(
  epicId: string,
  chatId: string,
): readonly ManagedCommand[] {
  const commands = useManagedCommandList(epicId);
  return useMemo(
    () =>
      (commands ?? []).filter(
        (command) =>
          command.chatId === chatId && command.status.state === "running",
      ),
    [commands, chatId],
  );
}
