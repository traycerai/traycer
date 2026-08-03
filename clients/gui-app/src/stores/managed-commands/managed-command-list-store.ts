import { create, type StoreApi, type UseBoundStore } from "zustand";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  ManagedCommandListStreamCallbacks,
  ManagedCommandListStreamClient,
} from "@traycer-clients/shared/host-transport/managed-command-list-stream-client";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";

/**
 * The renderer side of `managedCommand.subscribeList@1.0`: one store per open
 * epic mirroring every managed command in it, whichever chat created it. The
 * list is a live view and nothing more - there is no client-side persistence,
 * so `commands === null` means "the host has not answered yet", which is not
 * the same as an epic with no monitors.
 *
 * The order (`UI.md` §9: running first, then most recent activity) is applied
 * on write, so every reader shares one ordering rather than each sorting its
 * own copy. Every frame rebuilds the array; nothing here promises identity
 * stability, and no reader needs it - an epic's list is a handful of rows.
 */

export type ManagedCommandListStreamClientHandle = Pick<
  ManagedCommandListStreamClient,
  "close"
>;

export type ManagedCommandListStreamClientFactory = (
  epicId: string,
  callbacks: ManagedCommandListStreamCallbacks,
) => ManagedCommandListStreamClientHandle;

export interface ManagedCommandListState {
  readonly epicId: string;
  readonly connectionStatus: StreamConnectionStatus;
  /** `null` until the first snapshot lands. */
  readonly commands: readonly ManagedCommand[] | null;
  readonly dispose: () => void;
}

export interface ManagedCommandListStoreOptions {
  readonly epicId: string;
  readonly streamClientFactory: ManagedCommandListStreamClientFactory;
}

export interface ManagedCommandListStoreHandle {
  readonly epicId: string;
  readonly store: UseBoundStore<StoreApi<ManagedCommandListState>>;
  readonly dispose: () => void;
}

/**
 * Running first, then most recent activity. A command that is doing something
 * now outranks one that finished a second ago, which is what a human scanning
 * for "what is live in this epic" is looking for.
 */
function compareManagedCommands(a: ManagedCommand, b: ManagedCommand): number {
  const aRunning = a.status.state === "running";
  const bRunning = b.status.state === "running";
  if (aRunning !== bRunning) return aRunning ? -1 : 1;
  return b.updatedAtMs - a.updatedAtMs;
}

function ordered(
  commands: readonly ManagedCommand[],
): readonly ManagedCommand[] {
  return [...commands].sort(compareManagedCommands);
}

function upsert(
  previous: readonly ManagedCommand[] | null,
  command: ManagedCommand,
): readonly ManagedCommand[] {
  const rest = (previous ?? []).filter((entry) => entry.id !== command.id);
  return ordered([...rest, command]);
}

export function createManagedCommandListStore(
  options: ManagedCommandListStoreOptions,
): ManagedCommandListStoreHandle {
  let disposed = false;
  let streamClient: ManagedCommandListStreamClientHandle | null = null;

  const store = create<ManagedCommandListState>()((set) => {
    const callbacks: ManagedCommandListStreamCallbacks = {
      onSnapshot: (commands) => {
        if (disposed) return;
        set({ commands: ordered(commands) });
      },
      onChanged: (command) => {
        if (disposed) return;
        set((state) => ({ commands: upsert(state.commands, command) }));
      },
      onRemoved: (commandId) => {
        if (disposed) return;
        set((state) => ({
          commands:
            state.commands === null
              ? null
              : state.commands.filter((entry) => entry.id !== commandId),
        }));
      },
      onConnectionStatus: (
        status: StreamConnectionStatus,
        _reason: StreamCloseReason | null,
      ) => {
        if (disposed) return;
        set({ connectionStatus: status });
      },
    };

    streamClient = options.streamClientFactory(options.epicId, callbacks);

    return {
      epicId: options.epicId,
      connectionStatus: "connecting",
      commands: null,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (streamClient === null) return;
        const client = streamClient;
        streamClient = null;
        client.close();
      },
    };
  });

  return {
    epicId: options.epicId,
    store,
    dispose: () => {
      store.getState().dispose();
    },
  };
}
