import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { createChatRequestSchema } from "@traycer/protocol/host/epic/unary-schemas";
import type { ReactNode } from "react";

// The whole point of this suite is that the create mutation is REAL: the bug
// it guards lives in which client the mutation resolves, so a stubbed
// `createChat` cannot see it. Only the host transport below is faked.
const globalClientRef = vi.hoisted(() => ({
  value: null as HostClient<HostRpcRegistry> | null,
}));
const directoryRef = vi.hoisted(() => ({
  entries: [] as HostDirectoryEntry[],
}));
const messengerRef = vi.hoisted(() => ({
  value: null as MockHostMessenger<HostRpcRegistry> | null,
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => {
    if (globalClientRef.value === null) {
      throw new Error("test global client not configured");
    }
    return globalClientRef.value;
  },
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: directoryRef.entries }),
}));
// What the app-wide active host resolves to. The tab is bound elsewhere, so
// anything reading this instead of the tab's binding lands on the wrong host -
// which is exactly the failure this suite reproduces.
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => DEFAULT_HOST.hostId,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ authnBaseUrl: "https://authn.test" }),
}));

import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

import { useTerminalQuoteActions } from "../use-terminal-quote-actions";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";

const DEFAULT_HOST: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "default-host",
  websocketUrl: "ws://127.0.0.1:59997/stream",
};
const TAB_HOST: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "tab-host",
  websocketUrl: "ws://127.0.0.1:59998/stream",
};

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let epicHandle: OpenEpicStoreHandle | null = null;

function buildGlobalClient(): HostClient<HostRpcRegistry> {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "create-chat-request",
    handlers: {
      "epic.createChat": (request) => ({ chatId: request.chatId }),
    },
  });
  messengerRef.value = messenger;
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger,
    findHostById: (requestedHostId) =>
      directoryRef.entries.find((entry) => entry.hostId === requestedHostId) ??
      null,
  });
  // Bound to the DEFAULT host: a create that resolves the app-wide active
  // host issues its RPC straight off this binding.
  client.bind(DEFAULT_HOST);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return client;
}

function wrapperFor(queryClient: QueryClient, handle: OpenEpicStoreHandle) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <EpicSessionContext.Provider value={handle}>
          <TabHostProvider hostId={TAB_HOST.hostId}>{children}</TabHostProvider>
        </EpicSessionContext.Provider>
      </QueryClientProvider>
    );
  };
}

function renderActions() {
  const handle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  epicHandle = handle;
  return renderHook(
    () =>
      useTerminalQuoteActions({
        epicId: EPIC_ID,
        viewTabId: TAB_ID,
        terminalId: "term-1",
        terminalTitle: "zsh",
        terminalCwd: "/repo",
      }),
    {
      wrapper: wrapperFor(
        new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
        handle,
      ),
    },
  );
}

describe("useTerminalQuoteActions host routing", () => {
  afterEach(() => {
    cleanup();
    epicHandle?.dispose();
    epicHandle = null;
    globalClientRef.value = null;
    directoryRef.entries = [];
    messengerRef.value = null;
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  /**
   * The tile is bound to its tab's host for life and the open intent waits on
   * THAT host's epic projection, so a chat created on the app-wide active host
   * is one the watcher never sees - the tile just never opens, 30 seconds
   * later. The two hosts are made to differ here on purpose: with them equal
   * (the common case, and what the earlier suites exercised) the bug is
   * invisible.
   */
  it("creates the new chat on the tab's host, never the active one", async () => {
    globalClientRef.value = buildGlobalClient();
    directoryRef.entries = [DEFAULT_HOST, TAB_HOST];

    const { result } = renderActions();
    act(() => {
      result.current.quoteToNewChat("total 0\ndrwxr-xr-x  4 me  staff");
    });

    await waitFor(() => {
      expect(messengerRef.value?.calls).toHaveLength(1);
    });
    const call = messengerRef.value?.calls[0];
    expect(call?.method).toBe("epic.createChat");
    // Where the request was addressed...
    expect(call?.authority.endpoint).toEqual({
      hostId: TAB_HOST.hostId,
      websocketUrl: TAB_HOST.websocketUrl,
    });
    // ...and which host the chat record itself is stamped for. Both come from
    // the tab's client; resolving the active host would put "default-host" in
    // each.
    const request = createChatRequestSchema.parse(call?.params);
    expect(request.hostId).toBe(TAB_HOST.hostId);
    expect(request.epicId).toBe(EPIC_ID);
  });
});
