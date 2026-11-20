/**
 * The external boundaries the shell output modal suites replace, and the state
 * a case sets on them. A suite registers each replacement with a `vi.mock`
 * that loads the factory from here: this file imports nothing the session view
 * imports, so a factory can load it while the view is still being imported.
 */
import { vi } from "vitest";
import { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { StreamMethodSupport } from "@traycer/protocol/host-transport/stream-session";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostReachability } from "@/hooks/agent/use-host-reachability";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

export const mocks = {
  reachable: true,
  unreachableHosts: new Set<string>(),
  onTransportOpen: null as (() => void) | null,
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  navigateToTabIntent: vi.fn<(...args: unknown[]) => void>(),
};

export const namedHostDirectory = {
  findById: (hostId: string): HostDirectoryEntry => ({
    hostId,
    label: hostId,
    kind: "remote",
    websocketUrl: `wss://${hostId}.example/rpc`,
    version: null,
    transportDialability: "dialable",
  }),
  onChange: () => ({ dispose: () => undefined }),
};

export const transportOpens: string[] = [];

class SupportScriptedClient extends FakeStreamClient {
  support: StreamMethodSupport = "unknown";

  override getMethodSupport(): StreamMethodSupport {
    return this.support;
  }
}

export let hostClient = new SupportScriptedClient(true);

export function renewHostClient(): void {
  hostClient = new SupportScriptedClient(true);
}

export function routerMock(actual: object): object {
  return { ...actual, useNavigate: () => vi.fn() };
}

export function tabNavigationMock(actual: object): object {
  return { ...actual, navigateToTabIntent: mocks.navigateToTabIntent };
}

export function hostReachabilityMock(actual: object): object {
  return {
    ...actual,
    useHostReachability: (hostId: string): HostReachability => ({
      status:
        mocks.reachable && !mocks.unreachableHosts.has(hostId)
          ? "reachable"
          : "unreachable",
      hostLabel: hostId,
      unavailability: null,
      basis: "directory",
      hostKind: "remote",
    }),
  };
}

export function durableStreamTransportMock(): object {
  return {
    useDurableStreamTransportFactory:
      () =>
      (hostId: string): DurableStreamTransport => {
        transportOpens.push(hostId);
        mocks.onTransportOpen?.();
        return { wsStreamClient: hostClient, close: () => undefined };
      },
  };
}

/**
 * The output session reads the host directory itself (it waits for the bound
 * host's entry before it creates the stream), so the directory is a fixture:
 * every host is named, and nothing changes.
 */
export function hostRuntimeMock(actual: object): object {
  return { ...actual, useHostDirectory: () => namedHostDirectory };
}

export function hostDirectoryEntryMock(): object {
  return {
    useHostDirectoryEntry: (
      hostId: string | null,
    ): HostDirectoryEntry | null =>
      hostId === null
        ? null
        : {
            hostId,
            label: hostId,
            kind: "remote",
            websocketUrl: `wss://${hostId}.example/rpc`,
            version: null,
            transportDialability: "dialable",
          },
  };
}

export function chatSessionRegistryMock(actual: object): object {
  return {
    ...actual,
    useChatSessionHandleForContainer: (
      _botId: string,
      chatId: string,
    ): ChatSessionStoreHandle | null =>
      Object.hasOwn(mocks.sessions, chatId) ? mocks.sessions[chatId] : null,
  };
}

export function hostClientForHostIdMock(): object {
  return { useHostClientForHostId: () => null };
}

export function tabHostClientMock(): object {
  return { useTabHostClient: () => null };
}

export function guiHarnessCatalogMock(): object {
  return {
    useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
    useGuiHarnessesQueryForClient: () => ({
      data: undefined,
      isPending: false,
    }),
  };
}

export function botTurnLocateQueryMock(): object {
  return { useBotTurnLocateQuery: () => ({ data: undefined }) };
}

export function chatLocateRowMock(): object {
  return {
    useChatLocateRow: () => null,
    useChatLocateRowAnswer: () => ({ status: "waiting" }),
  };
}

/**
 * The one faked boundary the background listing needs beyond the session
 * registry: the host RPCs behind the managed-command rows (same fake
 * `chat-background-items-panel.test.tsx` uses - this suite is about the
 * bot session's status surfaces, not managed-command lifecycle RPCs).
 */
export function managedCommandMutationsMock(): object {
  return {
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAll: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandConfigureIsPending: () => false,
    useManagedCommandRelaunchOnHostRestart: (
      _target: unknown,
      streamed: { relaunchOnHostRestart: boolean },
    ) => streamed.relaunchOnHostRestart,
    useManagedCommandConfigure: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeld: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeldIsPending: () => false,
  };
}

export function hostDirectoryListMock(): object {
  return { useHostDirectoryList: () => ({ data: [] }) };
}

export function openLinkMock(): object {
  return { useOpenLink: () => vi.fn() };
}
