/**
 * `SwitcherRowActions`'s terminal-agent delete must close only the tile bound
 * to the row's OWNING host. A host-minted id is unique per host, not
 * globally, so a same-id tile can be open on another host at the same time -
 * an id-only close would tear down that unrelated tile instead of the one
 * actually deleted.
 *
 * Network mutation hooks are mocked (only `useEpicDeleteTuiAgent` is
 * exercised); the canvas store, `findOpenTileInTab` and the open-epic store
 * feeding `useEpicNodeHostId` are real, since the routing they do is exactly
 * what this suite pins.
 */
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as Y from "yjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { SwitcherRowActions } from "@/components/epic-canvas/mobile/switcher-row-actions";
import {
  EpicSessionContext,
  __getOpenEpicRegistryForTests,
} from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type { TuiAgentProjection } from "@/stores/epics/open-epic/types";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const { deleteTuiAgentMutate, deleteChatMutate, deleteArtifactMutate } =
  vi.hoisted(() => ({
    deleteTuiAgentMutate: vi.fn(
      (
        _variables: unknown,
        options: { readonly onSuccess?: () => void } | undefined,
      ) => {
        options?.onSuccess?.();
      },
    ),
    deleteChatMutate: vi.fn(),
    deleteArtifactMutate: vi.fn(),
  }));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicDeleteChat: () => ({ mutate: deleteChatMutate, isPending: false }),
  useEpicRenameChat: () => ({
    mutateAsync: vi.fn(() => new Promise(() => undefined)),
    isPending: false,
  }),
}));

// `discardDeletedTuiAgentPayloads` is passed through REAL: it is the
// close-payload cleanup this suite pins, and mocking the module wholesale
// would silently drop it - the component would call `undefined(...)`.
vi.mock(
  "@/hooks/epic/use-epic-tui-agent-mutations",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/epic/use-epic-tui-agent-mutations")
    >()),
    useEpicDeleteTuiAgent: () => ({
      mutate: deleteTuiAgentMutate,
      isPending: false,
    }),
    useEpicRenameTuiAgent: () => ({
      mutateAsync: vi.fn(() => new Promise(() => undefined)),
      isPending: false,
    }),
  }),
);

vi.mock("@/hooks/epic/use-epic-node-mutations", () => ({
  useEpicDeleteArtifact: () => ({
    mutate: deleteArtifactMutate,
    isPending: false,
  }),
  useEpicRenameArtifact: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/terminal/use-terminal-kill-for-mutation", () => ({
  useTerminalKillFor: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/epic/use-epic-record-mutation-client", () => ({
  useEpicRecordMutationClient: () => () => null,
}));

const EPIC_ID = "epic-switcher-row-actions";
const VIEWER_ID = "viewer-switcher-row-actions";
const NODE_ID = "agent-shared";
const HOST_A = "host-A";
const HOST_B = "host-B";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Switcher row actions",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: VIEWER_ID,
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

function newSession(): OpenedStoreForTest {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: VIEWER_ID,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  const seed = new Y.Doc();
  seed.getMap("epic").set("chats", new Y.Map<unknown>());
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(seed));
  return handle;
}

function tuiAgentProjection(hostId: string): TuiAgentProjection {
  return {
    id: NODE_ID,
    docResident: false,
    origin: "registry",
    harnessId: null,
    title: "Shared terminal agent",
    parentId: null,
    createdAt: 1,
    updatedAt: 2,
    userId: VIEWER_ID,
    hostId,
    workspaceFolders: [],
    workspaceMode: undefined,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    archivedAt: null,
    profileId: null,
    harnessSessionId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    sessionState: null,
    lastExit: null,
  };
}

function terminalAgentTile(hostId: string, instanceId: string): EpicNodeRef {
  return {
    id: NODE_ID,
    instanceId,
    type: "terminal-agent",
    name: "Shared terminal agent",
    hostId,
  };
}

let handle: OpenedStoreForTest;
let tabId: string;
let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const registry = __getOpenEpicRegistryForTests();
  registry.disposeAll();
  handle = newSession();
  registry.acquireMounted(EPIC_ID, () => handle);
  // The row's owning host - `agent-shared` is bound to host-B in the record
  // plane, which is what `useEpicNodeHostId` (real, under test) resolves.
  handle.store.setState({
    tuiAgents: {
      byId: { [NODE_ID]: tuiAgentProjection(HOST_B) },
      allIds: [NODE_ID],
    },
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  tabId = useEpicCanvasStore.getState().openEpicTab(EPIC_ID, "Tab");
  // Two open tiles under ONE content id, bound to different hosts - the
  // cross-host id collision this suite exists to prove is handled correctly.
  useEpicCanvasStore
    .getState()
    .openTileInTab(tabId, terminalAgentTile(HOST_A, "inst-a"));
  useEpicCanvasStore
    .getState()
    .openTileInTab(tabId, terminalAgentTile(HOST_B, "inst-b"));
});

afterEach(() => {
  cleanup();
  __getOpenEpicRegistryForTests().disposeAll();
  handle.store.getState().dispose();
  vi.clearAllMocks();
});

function Wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <EpicSessionContext.Provider value={handle}>
        {props.children}
      </EpicSessionContext.Provider>
    </QueryClientProvider>
  );
}

describe("SwitcherRowActions terminal-agent delete", () => {
  it("deletes on the owning host and closes only that host's tile, leaving a same-id tile on another host open", () => {
    render(
      <SwitcherRowActions
        epicId={EPIC_ID}
        tabId={tabId}
        kind="terminal-agent"
        nodeId={NODE_ID}
        name="Shared terminal agent"
        cascadeSummary={null}
      />,
      { wrapper: Wrapper },
    );

    // Radix's DropdownMenuTrigger opens on pointerdown, not click.
    fireEvent.pointerDown(screen.getByTestId(`switcher-more-${NODE_ID}`), {
      button: 0,
    });
    fireEvent.click(screen.getByTestId(`switcher-delete-${NODE_ID}`));
    fireEvent.click(screen.getByTestId("confirm-action"));

    expect(deleteTuiAgentMutate).toHaveBeenCalledTimes(1);
    expect(deleteTuiAgentMutate.mock.calls[0][0]).toEqual({
      epicId: EPIC_ID,
      tuiAgentId: NODE_ID,
      hostId: HOST_B,
    });

    const tiles =
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId ??
      {};
    expect(tiles["inst-b"]).toBeUndefined();
    expect(tiles["inst-a"]).toEqual(terminalAgentTile(HOST_A, "inst-a"));
  });

  it("discards the freshly-captured close payload for the deleted host, leaving an already-closed same-id payload from another host and tab", () => {
    // An EARLIER, unrelated close of a same-id tile bound to host-A, in a
    // second view tab - its Back/Forward payload already exists before this
    // test's delete runs. `updateTabCanvas` captures a closed-tile payload on
    // every canvas mutation regardless of `withoutTabRecovery` (a SEPARATE
    // mechanism from the recovery-history store that guard suppresses), so
    // this is exactly how a real pre-existing payload gets there.
    const otherTabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_ID, "Tab 2");
    useEpicCanvasStore
      .getState()
      .openTileInTab(
        otherTabId,
        terminalAgentTile(HOST_A, "inst-a-closed-earlier"),
      );
    const otherCanvas = useEpicCanvasStore.getState().canvasByTabId[otherTabId];
    if (otherCanvas === undefined)
      throw new Error("expected second tab canvas");
    const otherPaneId = collectPanes(otherCanvas.root).at(0)?.id;
    if (otherPaneId === undefined) throw new Error("expected second tab pane");
    useEpicCanvasStore
      .getState()
      .closeCanvasTab(otherTabId, otherPaneId, "inst-a-closed-earlier");
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[otherTabId]?.[
        "inst-a-closed-earlier"
      ],
    ).toBeDefined();

    render(
      <SwitcherRowActions
        epicId={EPIC_ID}
        tabId={tabId}
        kind="terminal-agent"
        nodeId={NODE_ID}
        name="Shared terminal agent"
        cascadeSummary={null}
      />,
      { wrapper: Wrapper },
    );

    // Radix's DropdownMenuTrigger opens on pointerdown, not click.
    fireEvent.pointerDown(screen.getByTestId(`switcher-more-${NODE_ID}`), {
      button: 0,
    });
    fireEvent.click(screen.getByTestId(`switcher-delete-${NODE_ID}`));
    fireEvent.click(screen.getByTestId("confirm-action"));

    // The close actually happened - without this, an undiscarded payload for
    // a tile that was never closed (e.g. a wrong-host close bug that took
    // down "inst-a" instead) would read identically to a correctly-captured
    // and correctly-discarded one, and the payload assertion below would
    // pass vacuously.
    expect(
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId[
        "inst-b"
      ],
    ).toBeUndefined();
    // The close-on-delete captured a fresh payload for "inst-b" (host-B) -
    // `discardDeletedTuiAgentPayloads` must have discarded exactly that one.
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        "inst-b"
      ],
    ).toBeUndefined();
    // The already-closed host-A payload, in a DIFFERENT tab, is untouched -
    // matching id and type is not enough; only the deleted row's own host
    // clears.
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[otherTabId]?.[
        "inst-a-closed-earlier"
      ],
    ).toBeDefined();
  });
});
