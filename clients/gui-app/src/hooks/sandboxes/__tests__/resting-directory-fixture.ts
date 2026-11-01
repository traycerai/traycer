import { vi, type Mock } from "vitest";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type { TraycerModelsFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  createFakeSandboxBinding,
  type FakeSandboxBinding,
} from "./sandbox-binding-fixture";

/**
 * The person's host directory as the context-free registry reads it, for a
 * suite that mocks `readHostDirectoryEntry` and `subscribeHostRowChanged` with
 * `restingDirectory.read` and `restingDirectory.subscribe`.
 */
const rows = new Map<string, HostDirectoryEntry>();
const listeners = new Map<string, Set<() => void>>();

function notify(hostId: string): void {
  for (const listener of [...(listeners.get(hostId) ?? [])]) listener();
}

export const restingDirectory = {
  read: (hostId: string): HostDirectoryEntry | null => rows.get(hostId) ?? null,
  subscribe: (hostId: string, listener: () => void): (() => void) => {
    const set = listeners.get(hostId) ?? new Set<() => void>();
    set.add(listener);
    listeners.set(hostId, set);
    return () => {
      set.delete(listener);
    };
  },
  /** Lists a sandbox host in the directory in `state`, and wakes its readers. */
  setSandbox: (
    hostId: string,
    name: string,
    state: NonNullable<HostListItem["sandboxState"]>,
  ): void => {
    rows.set(hostId, sandboxEntry(hostId, name, state));
    notify(hostId);
  },
  clear: (): void => {
    rows.clear();
    listeners.clear();
  },
};

function sandboxEntry(
  hostId: string,
  name: string,
  state: NonNullable<HostListItem["sandboxState"]>,
): RemoteHostDirectoryEntry {
  return hostListItemToDirectoryEntry(
    {
      hostId,
      displayName: name,
      platform: "linux",
      kind: "sandbox",
      publicKey: "pk",
      createdAt: "2026-10-01T00:00:00.000Z",
      status: {
        connectivity: "connectable",
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.5.0",
        lastSeenAt: null,
      },
      updatePolicy: "manual",
      sandboxState: state,
      sandboxFrozen: false,
      profile: "agent",
    },
    "wss://relay.example.test",
  );
}

type GetTraycerModels = () => Promise<TraycerModelsFetchResult>;

export interface RestingBinding extends FakeSandboxBinding {
  readonly directory: FakeSandboxBinding["directory"] & {
    readonly onChange: Mock<(listener: () => void) => { dispose: () => void }>;
  };
  readonly auth: FakeSandboxBinding["auth"] & {
    readonly getTraycerModels: Mock<GetTraycerModels>;
  };
}

/**
 * The window's `AuthService` boundary for a resting sandbox's surfaces: the
 * sandbox list, the cloud's Traycer list and the lifecycle verb.
 */
export function createRestingBinding(
  models: ReadonlyArray<GuiAgentModelOption>,
): RestingBinding {
  const binding = createFakeSandboxBinding();
  binding.directory.findById.mockImplementation(restingDirectory.read);
  return {
    ...binding,
    directory: {
      ...binding.directory,
      onChange: vi.fn<(listener: () => void) => { dispose: () => void }>(
        () => ({
          dispose: () => undefined,
        }),
      ),
    },
    auth: {
      ...binding.auth,
      getTraycerModels: vi.fn<GetTraycerModels>(() =>
        Promise.resolve({ kind: "ok", models }),
      ),
    },
  };
}
