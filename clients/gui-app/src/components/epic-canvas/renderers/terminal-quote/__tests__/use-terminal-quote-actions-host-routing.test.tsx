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
import { ACTIVE_TILE_PLACEMENT } from "@/lib/canvas/conversation-tile-placement";
import type { ReactNode } from "react";

// The whole point of this suite is that the create mutation is REAL: the bug
// it guards lives in which client the mutation resolves, so a stubbed
// `createChat` cannot see it. Only the host transport below is faked.
//
// The control no longer creates the chat itself - it opens the New
// Conversation modal, which creates on send. The routing therefore has two
// halves, and both are pinned below: the control publishes the tab's host on
// the open request, and the modal's create hooks issue to whatever host that
// request pins.
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
  // The SPINE and the app-wide client are separate exports since redesign
  // P2.1; this stub stands in for both, which is what `useHostClientFor` and
  // `useHostClientForHostId` each reach for.
  useHostRuntimeClient: () => {
    if (globalClientRef.value === null) {
      throw new Error("test global client not configured");
    }
    return globalClientRef.value;
  },
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
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => DEFAULT_HOST.hostId,
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

import { useEpicCreateChatForHostClient } from "@/hooks/epic/use-epic-chat-mutations";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";

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
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger,
    findHostById: (requestedHostId) =>
      directoryRef.entries.find((entry) => entry.hostId === requestedHostId) ??
      null,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  // Pinned to the DEFAULT host: a create that resolves the app-wide active
  // host issues its RPC straight off this requester.
  return spine.createRequester(DEFAULT_HOST);
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
    useNewConversationModalOpenStore.getState().close();
    useNewConversationModalStore.getState().resetForTests();
  });

  /**
   * The tile is bound to its tab's host for life and the terminal it quotes
   * only exists there, so the chat has to be created on that host. The two
   * hosts are made to differ here on purpose: with them equal (the common
   * case) the bug is invisible.
   */
  it("pins the modal to the tab's host and prefills it with the quote", () => {
    globalClientRef.value = buildGlobalClient();
    directoryRef.entries = [DEFAULT_HOST, TAB_HOST];

    const { result } = renderActions();
    act(() => {
      result.current.quoteToNewChat("total 0\ndrwxr-xr-x  4 me  staff");
    });

    // Nothing was created: the modal is composer-first, so no chat exists
    // until the user sends - which is what stopped this control from leaving
    // an empty chat behind on every dismissed quote.
    expect(messengerRef.value?.calls).toHaveLength(0);
    expect(useNewConversationModalOpenStore.getState().request).toEqual({
      epicId: EPIC_ID,
      tabId: TAB_ID,
      placement: ACTIVE_TILE_PLACEMENT,
      parentId: null,
      hostId: TAB_HOST.hostId,
    });
    // The draft is written BEFORE the open request, because the modal body
    // seeds its composer from this store as it mounts.
    const draft =
      useNewConversationModalStore.getState().draftPatchesByEpicId[EPIC_ID];
    expect(JSON.stringify(draft?.content)).toContain("drwxr-xr-x");
    expect(JSON.stringify(draft?.content)).toContain("sourcedQuote");
    // No remembered caret to drop the user above the quote they just took.
    expect(draft?.selection).toBeNull();
  });

  /**
   * The other half: the modal creates on the host its open request pinned,
   * not the app-wide active one. This is the composition the modal body makes
   * (`useHostClientForHostId` -> `useEpicCreateChatForHostClient`), driven
   * against the same real transport, so a regression that sends this request
   * on the app-wide active host fails here.
   */
  it("creates on the host the open request pinned, never the active one", async () => {
    globalClientRef.value = buildGlobalClient();
    directoryRef.entries = [DEFAULT_HOST, TAB_HOST];

    const handle = createOpenEpicStore({
      epicId: EPIC_ID,
      streamClientFactory: noopStreamClientFactory,
      userId: null,
      onAuthError: null,
    });
    epicHandle = handle;
    const { result } = renderHook(
      () =>
        useEpicCreateChatForHostClient(useHostClientForHostId(TAB_HOST.hostId)),
      {
        wrapper: wrapperFor(
          new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
          handle,
        ),
      },
    );

    act(() => {
      result.current.mutate({
        epicId: EPIC_ID,
        hostId: TAB_HOST.hostId,
        parentId: null,
        title: "",
        chatId: "chat-1",
        settings: null,
        workspaceMode: undefined,
        worktreeIntent: null,
        initialMessage: null,
      });
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
    // ...and which host the chat record itself is stamped for.
    const request = createChatRequestSchema.parse(call?.params);
    expect(request.hostId).toBe(TAB_HOST.hostId);
    expect(request.epicId).toBe(EPIC_ID);
  });
});
