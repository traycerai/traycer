/**
 * A terminal-agent tile whose record is not coming: `epic.listTuiAgents` keeps
 * failing, or it answered without an agent bound to another host. Nothing may
 * call that agent deleted, so the tile stays open; this pins what it shows. The
 * real sync hook, a real `QueryClient`, a real `HostClient` and a real open-epic
 * store feed the real tile, because the state in question is that chain's
 * settled end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicSyncTuiAgentRecords } from "@/hooks/chats/use-epic-tui-agent-records";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  __getOpenEpicRegistryForTests,
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { newEmptyEpicSession } from "@/stores/epics/open-epic/test-support/empty-epic-session";
import type { OpenedStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";

const EPIC_ID = "epic-list-failure";
const VIEWER_ID = "viewer-1";
const HOST_ID = mockLocalHostEntry.hostId;
const OTHER_HOST_ID = "other-host";

const runtime: { client: HostClient<HostRpcRegistry> | null } = vi.hoisted(
  () => ({ client: null }),
);

const canvas = vi.hoisted(() => ({
  setPendingCreate: (_ids: ReadonlySet<string>): void => undefined,
  prepareCloseCanvasTabFocusTarget:
    vi.fn<(tabId: string, paneId: string, instanceId: string) => void>(),
}));

vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => runtime.client,
  useHostRuntimeClient: () => runtime.client,
  useHostBinding: () =>
    runtime.client === null
      ? null
      : { hostClient: runtime.client, hostId: null, directory: null },
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () =>
    runtime.client === null
      ? null
      : { hostClient: runtime.client, hostId: null, directory: null },
  useHostClient: () => runtime.client,
  useHostRuntimeClient: () => runtime.client,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({
    hostId: "mock-local-host",
    label: "Test host",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:1/rpc",
    version: null,
    transportDialability: "dialable",
  }),
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => runtime.client,
}));

vi.mock("@/hooks/drafts/use-tab-draft-mirror", () => ({
  TabDraftMirrorMount: () => null,
}));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => null,
    ActiveHostWorkspaceControls: () => null,
  }),
);

vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({ self: null, descendants: [] }),
}));

vi.mock("@/hooks/agent/use-prepare-tui-launch-mutation", () => ({
  useAgentStartTerminalSession: () => ({
    isError: false,
    isPending: false,
    isIdle: true,
    error: null,
    reset: () => undefined,
    mutateAsync: () => new Promise(() => {}),
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-kill-for-mutation", () => ({
  useTerminalKillFor: () => ({ mutate: () => undefined }),
}));

vi.mock("@/stores/epics/canvas/store", async () => {
  const { create } = await import("zustand");
  const useEpicCanvasStore = create(() => ({
    pendingCreateArtifactIds: new Set<string>() as ReadonlySet<string>,
    prepareCloseCanvasTabFocusTarget: canvas.prepareCloseCanvasTabFocusTarget,
    tabsById: {},
  }));
  canvas.setPendingCreate = (ids) => {
    useEpicCanvasStore.setState({ pendingCreateArtifactIds: ids });
  };
  return { useEpicCanvasStore };
});

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => () => undefined,
}));

// A setup is in flight, so the notice renders its card: the surface a failing
// list must not take away.
vi.mock("@/stores/chats/tui-agent-setup-card-model", () => ({
  buildTuiAgentSetupCardModel: () => ({}),
}));

vi.mock("@/components/chat/segments/setup-card-segment", () => ({
  SetupCardSegment: () => <span>Setup card</span>,
}));

vi.mock("@/hooks/worktree/use-worktree-get-binding-query", () => ({
  useWorktreeGetBinding: () => ({
    data: { binding: null },
    isSuccess: true,
  }),
}));

vi.mock("@/hooks/worktree/use-worktree-set-local-mutation", () => ({
  useWorktreeSetLocal: () => ({ mutate: () => undefined, isPending: false }),
}));

vi.mock("@/hooks/agent/use-tui-fork-profile-support", () => ({
  useTuiForkProfileSupported: () => true,
}));

vi.mock(
  "@/hooks/agent/use-terminal-tile-bootstrap",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/agent/use-terminal-tile-bootstrap")
    >()),
    useTerminalTileBootstrap: () => ({
      hostHasSession: null,
      hostSessionSettled: null,
      hostSessionExited: false,
      handle: null,
      createIsError: false,
      createIsPending: false,
      createRetryIsPending: false,
      createIsSuccess: false,
      createError: null,
      createRetryError: null,
      retry: () => undefined,
      reportMeasuredGrid: () => undefined,
    }),
  }),
);

vi.mock("../terminal-loading-skeleton", () => ({
  TerminalLoadingSkeleton: () => <span>Starting terminal</span>,
}));

vi.mock("../terminal-grid-measure-probe", () => ({
  TerminalGridMeasureProbe: () => null,
}));

vi.mock("../terminal-agent-fork-dialog", () => ({
  TerminalAgentForkDialog: () => null,
}));

import { TuiAgentTile } from "../tui-agent-tile";
import { TabHostProvider } from "../../tab-host-provider";

function SyncRecords(): null {
  useEpicSyncTuiAgentRecords(EPIC_ID);
  return null;
}

const SKELETON = "Starting terminal";
const SETUP_CARD = "Setup card";
const BANNER_TEST_ID = "terminal-agent-tile-record-unavailable-tile-1";

/** What the fake host does with the next `epic.listTuiAgents`. */
type ListBehaviour = "reject" | "hang" | "answer-empty";

interface Mounted {
  readonly handle: OpenedStoreForTest;
  readonly queryClient: QueryClient;
  readonly listCalls: { value: number };
  readonly list: { behaviour: ListBehaviour };
}

function mountTile(behaviour: ListBehaviour, tileHostId: string): Mounted {
  const listCalls = { value: 0 };
  const list = { behaviour };
  const requestSeq = { value: 0 };
  const queryClient = new QueryClient({
    // `retry` is the hook's own predicate, so the failure really does run it
    // out. Zero delay is only so that takes no wall-clock time.
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestSeq.value += 1;
        return `req-${String(requestSeq.value)}`;
      },
      handlers: {
        "epic.listTuiAgents": () => {
          listCalls.value += 1;
          if (list.behaviour === "hang") return new Promise(() => {});
          if (list.behaviour === "answer-empty") {
            return Promise.resolve({
              kind: "snapshot" as const,
              listStamp: null,
              tuiAgents: [],
            });
          }
          return Promise.reject(
            new HostRpcError({
              code: "RPC_ERROR",
              message: "terminal-agent list failed",
              requestId: `req-${String(requestSeq.value)}`,
              method: "epic.listTuiAgents",
              fatalDetails: null,
            }),
          );
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  runtime.client = client;
  const handle = newEmptyEpicSession(EPIC_ID, HOST_ID);
  const tree: ReactNode = (
    <QueryClientProvider client={queryClient}>
      <EpicSessionContext.Provider value={handle}>
        <EpicSessionHostClientContext.Provider value={client}>
          <TooltipProvider>
            <TabHostProvider hostId={tileHostId}>
              <SyncRecords />
              <TuiAgentTile
                viewTabId="tab-test"
                node={{
                  id: "agent-1",
                  instanceId: "inst-agent-1",
                  type: "terminal-agent",
                  name: "claude",
                  hostId: tileHostId,
                }}
                tileId="tile-1"
                isActive
              />
            </TabHostProvider>
          </TooltipProvider>
        </EpicSessionHostClientContext.Provider>
      </EpicSessionContext.Provider>
    </QueryClientProvider>
  );
  render(tree);
  sessions.push(handle);
  return { handle, queryClient, listCalls, list };
}

async function mountOnceFailed(): Promise<Mounted> {
  const mounted = mountTile("reject", HOST_ID);
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Close tab" })).not.toBeNull();
  });
  return mounted;
}

/** Starts the refetch a poll would; a hanging list never settles it. */
function refetchList(mounted: Mounted): void {
  act(() => {
    void mounted.queryClient.invalidateQueries({
      predicate: (query) => query.queryKey.includes("epic.listTuiAgents"),
    });
  });
}

const sessions: OpenedStoreForTest[] = [];

beforeEach(() => {
  canvas.setPendingCreate(new Set());
  canvas.prepareCloseCanvasTabFocusTarget.mockClear();
  useAuthStore.setState({
    contextMetadata: { userId: VIEWER_ID, username: VIEWER_ID },
  });
});

afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.store.getState().dispose();
  __getOpenEpicRegistryForTests().disposeAll();
  runtime.client = null;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("<TuiAgentTile /> with a record list that keeps failing", () => {
  it("shows the skeleton while the list is still being asked", async () => {
    const { handle, listCalls } = mountTile("hang", HOST_ID);

    await waitFor(() => {
      expect(listCalls.value).toBe(1);
    });

    expect(screen.queryByText(SKELETON)).not.toBeNull();
    expect(handle.store.getState().tuiAgentRecordListFailed).toBe(false);
  });

  it("stops at a banner with a way out once the retries run out, without calling the agent deleted", async () => {
    const { handle, listCalls } = await mountOnceFailed();

    expect(listCalls.value).toBe(3);
    expect(screen.queryByText(SKELETON)).toBeNull();
    // Whole, so a promise or a host name creeping back reddens this: the
    // failing list is the session host's, which need not be this tile's.
    expect(
      screen.queryByText(
        "Couldn't load this agent. Traycer keeps trying. Closing this tab only removes it from the canvas.",
      ),
    ).not.toBeNull();
    expect(screen.queryByText(SETUP_CARD)).not.toBeNull();
    expect(handle.store.getState().tuiAgentRecordListAuthoritative).toBe(false);
  });

  it("closes the tile from the banner", async () => {
    await mountOnceFailed();

    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));

    expect(canvas.prepareCloseCanvasTabFocusTarget).toHaveBeenCalledWith(
      "tab-test",
      "tile-1",
      "inst-agent-1",
    );
  });

  it("stays on the skeleton and the setup card for an agent still being created", async () => {
    canvas.setPendingCreate(new Set(["agent-1"]));
    const { handle } = mountTile("reject", HOST_ID);

    await waitFor(() => {
      expect(handle.store.getState().tuiAgentRecordListFailed).toBe(true);
    });

    expect(screen.queryByTestId(BANNER_TEST_ID)).toBeNull();
    expect(screen.queryByText(SKELETON)).not.toBeNull();
    expect(screen.queryByText(SETUP_CARD)).not.toBeNull();
  });

  it("holds the banner through the next poll, when the query drops back to pending", async () => {
    const mounted = await mountOnceFailed();
    mounted.list.behaviour = "hang";

    refetchList(mounted);
    await waitFor(() => {
      expect(mounted.listCalls.value).toBe(4);
    });
    const [query] = mounted.queryClient.getQueryCache().getAll();
    expect(query.state.status).toBe("pending");

    expect(screen.queryByText(SKELETON)).toBeNull();
    expect(screen.queryByRole("button", { name: "Close tab" })).not.toBeNull();
  });

  it("leaves the banner once the list answers", async () => {
    const mounted = await mountOnceFailed();
    mounted.list.behaviour = "answer-empty";

    refetchList(mounted);

    await waitFor(() => {
      expect(
        mounted.handle.store.getState().tuiAgentRecordListAuthoritative,
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
    });
    expect(screen.queryByText(SKELETON)).not.toBeNull();
  });
});

describe("<TuiAgentTile /> bound to another host, with a list that answered without it", () => {
  async function answerWithoutTheAgent(): Promise<Mounted> {
    const mounted = mountTile("answer-empty", OTHER_HOST_ID);
    await waitFor(() => {
      expect(
        mounted.handle.store.getState().tuiAgentRecordListAuthoritative,
      ).toBe(true);
    });
    return mounted;
  }

  it("stops at the banner, because nothing will close this tile", async () => {
    await answerWithoutTheAgent();

    await waitFor(() => {
      expect(screen.queryByTestId(BANNER_TEST_ID)).not.toBeNull();
    });
    expect(screen.queryByText(SKELETON)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));

    expect(canvas.prepareCloseCanvasTabFocusTarget).toHaveBeenCalledWith(
      "tab-test",
      "tile-1",
      "inst-agent-1",
    );
  });

  it("reaches the banner when a create on that host fails", async () => {
    canvas.setPendingCreate(new Set(["agent-1"]));
    await answerWithoutTheAgent();

    expect(screen.queryByTestId(BANNER_TEST_ID)).toBeNull();
    expect(screen.queryByText(SKELETON)).not.toBeNull();

    act(() => {
      canvas.setPendingCreate(new Set());
    });

    expect(screen.queryByTestId(BANNER_TEST_ID)).not.toBeNull();
    expect(screen.queryByText(SETUP_CARD)).not.toBeNull();
  });
});
