import "../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { MobileCurrentTileBar } from "@/components/epic-canvas/mobile/mobile-current-tile-bar";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import type { ChatStreamSyncState } from "@/hooks/chats/use-chat-stream-sync-state";
import {
  SURFACE_SYNC_RANK,
  useSurfaceSyncStore,
  type SurfaceSyncEntry,
} from "@/stores/sync/surface-sync-store";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { resolveChatWriteRoute } from "@/hooks/epic/use-chat-write-route";
import type { ChatProjection } from "@/stores/epics/open-epic/types";
import { useEpicCanvas, useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { selectMobileTile } from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { LINK_DOWN_ESCALATION_MS } from "@/lib/link-down-escalation";

// The live tile icon is covered by the tab-strip tests; stub it here so this
// test targets the bar's own composition (title, rename gating).
vi.mock("@/components/epic-canvas/canvas/tab-strip", () => ({
  TabIcon: () => <span data-testid="tab-icon" />,
  TabStrip: () => null,
}));

vi.mock("@/components/epic-canvas/canvas/browser-tab-presentation", () => ({
  useBrowserTabPresentation: () => null,
}));

const holder = vi.hoisted(() => ({ role: "owner" }));

// `useEpicNodeHostId` / `useEpicTabDisplayTitle` pass through real; their
// unrelated external sub-readers are mocked below instead.
vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useEpicLiveArtifactTitleGenerating: () => false,
  useEpicPermissionRole: () => holder.role,
}));

vi.mock("@/hooks/terminal/use-terminal-display-title", () => ({
  useTerminalDisplayTitle: () => null,
}));

vi.mock("@/stores/managed-commands/managed-commands-for-chat", () => ({
  useManagedCommandOnHost: () => null,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

const mocks = vi.hoisted(() => ({
  handle: { current: null as OpenedStoreForTest | null },
}));

const mutateSpies = vi.hoisted(() => ({
  renameChat: vi.fn(),
  renameTuiAgent: vi.fn(),
  renameArtifact: vi.fn(),
  renameTerminal: vi.fn(),
}));

// Held open by the deferred-ACK persistence tests below; every other test
// leaves it `null`, which resolves immediately as before.
const renameChatHold = vi.hoisted((): { value: Promise<void> | null } => ({
  value: null,
}));

function makeMutateAsync<TVariables>(
  spy: (variables: TVariables) => void,
  hold: { readonly value: Promise<void> | null } | null,
): (variables: TVariables) => Promise<void> {
  return (variables: TVariables) => {
    spy(variables);
    return hold?.value ?? Promise.resolve();
  };
}

// `useRenameCanvasTab` reads a REAL session handle for the optimistic overlay
// (`beginRenameMutation` / `retirePendingMutation`); the mutation hooks stay
// mocked, exercising the real kind -> mutation mapping in
// `use-rename-canvas-tab.ts`. `useMaybeOpenEpicHandle` and `useOpenEpicHandle`
// return the SAME handle: `useEpicNodeHostId` and `useChatWriteRoute` must see
// one session for the cross-host gate comparison to mean anything.
vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => mocks.handle.current,
  useOpenEpicHandle: () => {
    if (mocks.handle.current === null) throw new Error("no handle seeded");
    return mocks.handle.current;
  },
}));
// Defaults to `null` (no session context, matching every existing test);
// the cross-host write-route suite below overrides it.
const sessionHostIdMock = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => sessionHostIdMock.value,
}));
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicRenameChat: () => ({
    mutateAsync: makeMutateAsync(mutateSpies.renameChat, renameChatHold),
    isPending: false,
  }),
}));
vi.mock("@/hooks/epic/use-epic-tui-agent-mutations", () => ({
  useEpicRenameTuiAgent: () => ({
    mutateAsync: makeMutateAsync(mutateSpies.renameTuiAgent, null),
    isPending: false,
  }),
}));
vi.mock("@/hooks/epic/use-epic-node-mutations", () => ({
  useEpicRenameArtifact: () => ({
    mutateAsync: makeMutateAsync(mutateSpies.renameArtifact, null),
    isPending: false,
  }),
}));
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));
vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({
    mutate: mutateSpies.renameTerminal,
    isPending: false,
  }),
}));

// The chat SESSION is the external boundary here - this suite opens no chat
// stream - so the hook that reads one is the seam. Everything downstream of it
// (the gate, the suppression, the strip itself) stays real. The recorded args
// are asserted too: reading a chat's stream off the wrong tile kind, or off a
// tile with no host, is the failure that would make the strip describe a
// different machine's chat.
/** The surface's own wake, spied so a test can prove the button reaches it. */
const chatWakeSpy = vi.hoisted(() => vi.fn());

const chatSyncMock = vi.hoisted(() => {
  const current: { value: ChatStreamSyncState } = {
    value: { status: "closed", hasContent: false, wake: chatWakeSpy },
  };
  const calls: Array<readonly [string, string, string | null]> = [];
  return { current, calls };
});

vi.mock("@/hooks/chats/use-chat-stream-sync-state", () => ({
  useChatStreamSyncState: (
    epicId: string,
    chatId: string,
    hostId: string | null,
  ) => {
    chatSyncMock.calls.push([epicId, chatId, hostId]);
    return chatSyncMock.current.value;
  },
}));

const SPEC_TILE: EpicCanvasTileRef = {
  id: "spec-1",
  instanceId: "inst-1",
  type: "spec",
  name: "Life Philosophy",
  hostId: "host-A",
};

const CHAT_TILE: EpicCanvasTileRef = {
  id: "chat-1",
  instanceId: "inst-2",
  type: "chat",
  name: "Chat title",
  hostId: "host-A",
};

const FILE_TILE: EpicCanvasTileRef = {
  id: "file-1",
  instanceId: "inst-3",
  type: "workspace-file",
  name: "index.ts",
  hostId: "host-A",
  workspacePath: "/ws",
  filePath: "index.ts",
};

/** A `ChatProjection` literal with every field populated explicitly. */
function chatRow(
  id: string,
  hostId: string,
  docResident: boolean | null,
): ChatProjection {
  return {
    id,
    title: id,
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    hostId,
    isTitleEditedByUser: false,
    docResident,
    settings: null,
    archivedAt: null,
  };
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-1",
      title: "Epic test",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
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

/** A live session for "epic-1" - no nodes seeded, since these tests only
 * assert on the RPC call args, and `useRenameCanvasTab` fires the RPC
 * regardless of whether `beginRenameMutation` finds a row to overlay. */
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
    epicId: "epic-1",
    userId: null,
    // The factories go to the COMPOSITION now, not the store:
    // `createOpenEpicStore` stopped constructing a runtime, so a
    // suite that used to hand it a `streamClientFactory` has nothing
    // to hand it. `handle.doc` still resolves because this harness
    // builds the runtime in THIS thread.
    factories: {
      streamClientFactory: factory,
      laneSelection: null,
    },
    // Explicit: `null` means this suite never writes, so a write in
    // one that said so fails rather than resolving quietly.
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  return handle;
}

function openEdit(): HTMLElement {
  fireEvent.click(screen.getByTestId("mobile-current-tile-title"));
  return screen.getByTestId("mobile-current-tile-title-input");
}

/** Reads the current tile off the real canvas store, like `MobileEpicTileView` does. */
function MountedCurrentTileBar(props: {
  readonly epicId: string;
  readonly tabId: string;
}): ReactNode {
  const canvas = useEpicCanvas(props.tabId);
  const selection = selectMobileTile(canvas);
  if (selection === null) return null;
  return (
    <MobileCurrentTileBar
      epicId={props.epicId}
      tabId={props.tabId}
      tile={selection.ref}
    />
  );
}

let tabId: string;

describe("<MobileCurrentTileBar />", () => {
  beforeEach(() => {
    holder.role = "owner";
    mutateSpies.renameChat.mockClear();
    mutateSpies.renameTuiAgent.mockClear();
    mutateSpies.renameArtifact.mockClear();
    mutateSpies.renameTerminal.mockClear();
    renameChatHold.value = null;
    mocks.handle.current = newSession();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Tab");
  });
  afterEach(() => {
    cleanup();
    mocks.handle.current?.dispose();
    mocks.handle.current = null;
  });

  it("shows the current tile title and icon", () => {
    render(
      <MobileCurrentTileBar epicId="epic-1" tabId={tabId} tile={SPEC_TILE} />,
    );
    const bar = screen.getByTestId("mobile-current-tile-bar");
    expect(bar.textContent).toContain("Life Philosophy");
    expect(screen.getByTestId("tab-icon")).not.toBeNull();
  });

  it("renders the title as an editable control for a renameable kind and an editor role", () => {
    render(
      <MobileCurrentTileBar epicId="epic-1" tabId={tabId} tile={CHAT_TILE} />,
    );
    expect(screen.getByTestId("mobile-current-tile-title").tagName).toBe(
      "BUTTON",
    );
  });

  it("commits an edited title through the rename mutation, keyed to the tile kind", async () => {
    render(
      <MobileCurrentTileBar epicId="epic-1" tabId={tabId} tile={CHAT_TILE} />,
    );
    const input = openEdit();
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.blur(input);
    // AWAITED: the commit stamps the overlay through the worker's queue first,
    // so the mutation fires a round trip after the blur rather than inside it.
    await waitFor(() =>
      expect(mutateSpies.renameChat).toHaveBeenCalledTimes(1),
    );
    expect(mutateSpies.renameChat).toHaveBeenCalledWith({
      epicId: "epic-1",
      chatId: "chat-1",
      title: "New title",
      // The current-tile bar supplies the TILE's own host, not the ambient
      // session's - `CHAT_TILE.hostId` above.
      hostId: "host-A",
    });
    expect(mutateSpies.renameTuiAgent).not.toHaveBeenCalled();
    expect(mutateSpies.renameArtifact).not.toHaveBeenCalled();
    expect(mutateSpies.renameTerminal).not.toHaveBeenCalled();
  });

  it("Escape restores the previous title and does not commit", () => {
    render(
      <MobileCurrentTileBar epicId="epic-1" tabId={tabId} tile={CHAT_TILE} />,
    );
    const input = openEdit();
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mutateSpies.renameChat).not.toHaveBeenCalled();
    expect(screen.getByTestId("mobile-current-tile-title").textContent).toBe(
      "Chat title",
    );
  });

  it("empty/whitespace commit does not call the mutation and keeps the previous title", () => {
    render(
      <MobileCurrentTileBar epicId="epic-1" tabId={tabId} tile={CHAT_TILE} />,
    );
    const input = openEdit();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(mutateSpies.renameChat).not.toHaveBeenCalled();
    expect(screen.getByTestId("mobile-current-tile-title").textContent).toBe(
      "Chat title",
    );
  });

  it("renders plain text with no editable control for a non-renameable tile kind", () => {
    render(
      <MobileCurrentTileBar epicId="epic-1" tabId={tabId} tile={FILE_TILE} />,
    );
    const title = screen.getByTestId("mobile-current-tile-title");
    expect(title.tagName).toBe("SPAN");
    expect(screen.queryByTestId("mobile-current-tile-title-input")).toBeNull();
  });

  it("renders plain text for a viewer role even on a renameable kind", () => {
    holder.role = "viewer";
    render(
      <MobileCurrentTileBar epicId="epic-1" tabId={tabId} tile={CHAT_TILE} />,
    );
    const title = screen.getByTestId("mobile-current-tile-title");
    expect(title.tagName).toBe("SPAN");
    expect(screen.queryByTestId("mobile-current-tile-title-input")).toBeNull();
  });

  describe("stream-syncing report", () => {
    beforeEach(() => {
      chatSyncMock.current.value = {
        status: "closed",
        hasContent: false,
        wake: chatWakeSpy,
      };
      chatSyncMock.calls.length = 0;
      chatWakeSpy.mockClear();
      useSurfaceSyncStore.setState({ entries: {} });
    });

    function renderChatBar(input: {
      readonly chat: ChatStreamSyncState;
      readonly tile: EpicCanvasTileRef;
    }): void {
      chatSyncMock.current.value = input.chat;
      render(
        <MobileCurrentTileBar
          epicId="epic-1"
          tabId={tabId}
          tile={input.tile}
        />,
      );
    }

    // Entries are keyed by PUBLISHER token, not by surface, so a lookup finds
    // the one whose `key` names this surface.
    function publishedFor(surfaceKey: string): SurfaceSyncEntry | undefined {
      return Object.values(useSurfaceSyncStore.getState().entries).find(
        (entry) => entry.key === surfaceKey,
      );
    }

    function published(): SurfaceSyncEntry | undefined {
      return publishedFor(`chat:host-A:${CHAT_TILE.id}`);
    }

    it("renders no bar of its own - it reports instead", () => {
      // The one element lives in the app shell, so a hand-off changes what the
      // indicator says rather than which element is saying it.
      renderChatBar({
        tile: CHAT_TILE,
        chat: { status: "reconnecting", hasContent: true, wake: chatWakeSpy },
      });
      expect(screen.queryByTestId("chat-stream-syncing-bar")).toBeNull();
      expect(screen.queryByTestId("session-connectivity-strip-bar")).toBeNull();
    });

    it("reports a running spell while its own stream is away with content up", () => {
      renderChatBar({
        tile: CHAT_TILE,
        chat: { status: "reconnecting", hasContent: true, wake: chatWakeSpy },
      });
      expect(published()?.spell.syncing).toBe(true);
      expect(published()?.label).toBe("Chat");
      expect(published()?.rank).toBe(SURFACE_SYNC_RANK.chat);
    });

    it("reports nothing running while the stream is healthy", () => {
      renderChatBar({
        tile: CHAT_TILE,
        chat: { status: "open", hasContent: true, wake: chatWakeSpy },
      });
      expect(published()?.spell.syncing).toBe(false);
    });

    it("reports nothing running on a cold chat with nothing on screen", () => {
      renderChatBar({
        tile: CHAT_TILE,
        chat: { status: "connecting", hasContent: false, wake: chatWakeSpy },
      });
      expect(published()?.spell.syncing).toBe(false);
    });

    it("carries the chat's OWN wake, so Retry reaches this chat's socket", () => {
      renderChatBar({
        tile: CHAT_TILE,
        chat: { status: "reconnecting", hasContent: true, wake: chatWakeSpy },
      });
      published()?.wake?.();
      expect(chatWakeSpy).toHaveBeenCalledTimes(1);
    });

    it("never reports a running spell for a tile that is not a chat", () => {
      // Its stream is either covered by the Epic's report or already narrated
      // by the tile itself.
      renderChatBar({
        tile: SPEC_TILE,
        chat: { status: "reconnecting", hasContent: true, wake: chatWakeSpy },
      });
      expect(publishedFor(`chat:host-A:${SPEC_TILE.id}`)?.spell.syncing).toBe(
        false,
      );
      expect(chatSyncMock.calls.every((call) => call[2] === null)).toBe(true);
    });

    it("reads the chat stream on the tile's OWN host, not the app's", () => {
      renderChatBar({
        tile: CHAT_TILE,
        chat: { status: "open", hasContent: true, wake: chatWakeSpy },
      });
      expect(chatSyncMock.calls).toContainEqual([
        "epic-1",
        CHAT_TILE.id,
        "host-A",
      ]);
    });

    it("withdraws its report when the tile goes away", () => {
      // A closed surface is no longer a claim about anything; leaving the entry
      // behind would hold the indicator open over a stream nobody is watching.
      const view = render(
        <MobileCurrentTileBar epicId="epic-1" tabId={tabId} tile={CHAT_TILE} />,
      );
      expect(published()).toBeDefined();
      view.unmount();
      expect(published()).toBeUndefined();
    });

    it("does not inherit a prior chat's escalation when the same content id is shown on another host", () => {
      vi.useFakeTimers();
      try {
        const aTile: EpicCanvasTileRef = { ...CHAT_TILE, hostId: "host-A" };
        const bTile: EpicCanvasTileRef = {
          ...CHAT_TILE,
          instanceId: "inst-2-host-b",
          hostId: "host-B",
        };
        chatSyncMock.current.value = {
          status: "reconnecting",
          hasContent: true,
          wake: chatWakeSpy,
        };
        const view = render(
          <MobileCurrentTileBar epicId="epic-1" tabId={tabId} tile={aTile} />,
        );
        act(() => {
          vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
        });
        expect(
          publishedFor(`chat:host-A:${CHAT_TILE.id}`)?.spell.escalated,
        ).toBe(true);

        view.rerender(
          <MobileCurrentTileBar epicId="epic-1" tabId={tabId} tile={bTile} />,
        );
        expect(publishedFor(`chat:host-A:${CHAT_TILE.id}`)).toBeUndefined();
        const bEntry = publishedFor(`chat:host-B:${CHAT_TILE.id}`);
        expect(bEntry?.spell.syncing).toBe(true);
        expect(bEntry?.spell.escalated).toBe(false);

        act(() => {
          vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
        });
        expect(
          publishedFor(`chat:host-B:${CHAT_TILE.id}`)?.spell.escalated,
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("cross-host write-route gate", () => {
    afterEach(() => {
      sessionHostIdMock.value = null;
      resetNegotiatedManifests();
    });

    function seedChatRow(row: ChatProjection): void {
      const handle = mocks.handle.current;
      if (handle === null) throw new Error("expected a seeded session handle");
      handle.store.setState({
        chats: { byId: { [row.id]: row }, allIds: [row.id] },
      });
    }

    it("stays editable, and commits to its OWN host, when a same-id row projected from another host is unadopted", async () => {
      // host-A must actually serve a chat record plane, or its row resolves
      // "registry-rpc" on its own and the test can't tell the gate apart.
      recordNegotiatedHostMethods("host-A", ["epic.listChatRecords"]);
      const projectedRowOnA = chatRow("chat-shared", "host-A", true);
      seedChatRow(projectedRowOnA);
      expect(
        resolveChatWriteRoute({
          chatsById: { "chat-shared": projectedRowOnA },
          isChatRow: true,
          nodeId: "chat-shared",
          sessionHostId: "host-A",
        }),
      ).toBe("unavailable");
      sessionHostIdMock.value = "host-A";
      const tile: EpicCanvasTileRef = {
        id: "chat-shared",
        instanceId: "inst-cross",
        type: "chat",
        name: "Cross-host chat",
        hostId: "host-B",
      };

      render(
        <MobileCurrentTileBar epicId="epic-1" tabId={tabId} tile={tile} />,
      );
      expect(screen.getByTestId("mobile-current-tile-title").tagName).toBe(
        "BUTTON",
      );

      const input = openEdit();
      fireEvent.change(input, { target: { value: "Renamed on B" } });
      fireEvent.blur(input);

      await waitFor(() =>
        expect(mutateSpies.renameChat).toHaveBeenCalledTimes(1),
      );
      expect(mutateSpies.renameChat).toHaveBeenCalledWith({
        epicId: "epic-1",
        chatId: "chat-shared",
        title: "Renamed on B",
        hostId: "host-B",
      });
    });

    it("stays disabled for a row unadopted on its OWN (matching) host", () => {
      sessionHostIdMock.value = "host-B";
      recordNegotiatedHostMethods("host-B", ["epic.listChatRecords"]);
      seedChatRow(chatRow("chat-same", "host-B", true));
      const tile: EpicCanvasTileRef = {
        id: "chat-same",
        instanceId: "inst-same",
        type: "chat",
        name: "Same-host chat",
        hostId: "host-B",
      };

      render(
        <MobileCurrentTileBar epicId="epic-1" tabId={tabId} tile={tile} />,
      );

      const title = screen.getByTestId("mobile-current-tile-title");
      expect(title.tagName).toBe("SPAN");
      expect(
        screen.queryByTestId("mobile-current-tile-title-input"),
      ).toBeNull();
    });
  });

  describe("cross-host rename persistence", () => {
    afterEach(() => {
      sessionHostIdMock.value = null;
      resetNegotiatedManifests();
      renameChatHold.value = null;
    });

    /** Same-id A (projected row's host) / B (viewed tile's host) live tiles. */
    function seedCrossHostTiles(): void {
      const handle = mocks.handle.current;
      if (handle === null) throw new Error("expected a seeded session handle");
      recordNegotiatedHostMethods("host-A", ["epic.listChatRecords"]);
      handle.store.setState({
        chats: {
          byId: { "chat-shared": chatRow("chat-shared", "host-A", true) },
          allIds: ["chat-shared"],
        },
      });
      useEpicCanvasStore.getState().openTileInTab(tabId, {
        id: "chat-shared",
        instanceId: "inst-a-live",
        type: "chat",
        name: "A original",
        hostId: "host-A",
      });
      // Opened last, so `selectMobileTile` shows this one - the header is
      // "viewing B".
      useEpicCanvasStore.getState().openTileInTab(tabId, {
        id: "chat-shared",
        instanceId: "inst-b-live",
        type: "chat",
        name: "B original",
        hostId: "host-B",
      });
    }

    function bTileName(): string | undefined {
      return useEpicCanvasStore.getState().canvasByTabId[tabId]
        ?.tilesByInstanceId["inst-b-live"]?.name;
    }

    function aTileName(): string | undefined {
      return useEpicCanvasStore.getState().canvasByTabId[tabId]
        ?.tilesByInstanceId["inst-a-live"]?.name;
    }

    it("persists a cross-host rename on ACK, keeps the peer host untouched, and keeps a stale earlier submission from overwriting a later one", async () => {
      seedCrossHostTiles();
      render(<MountedCurrentTileBar epicId="epic-1" tabId={tabId} />);
      expect(screen.getByTestId("mobile-current-tile-title").textContent).toBe(
        "B original",
      );

      let resolveFirst: () => void = () => {
        throw new Error("first resolver unavailable");
      };
      renameChatHold.value = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      fireEvent.change(openEdit(), { target: { value: "First title" } });
      fireEvent.blur(screen.getByTestId("mobile-current-tile-title-input"));
      await waitFor(() =>
        expect(mutateSpies.renameChat).toHaveBeenCalledTimes(1),
      );

      // Before the ACK: the display and the canvas snapshot are unchanged.
      expect(screen.getByTestId("mobile-current-tile-title").textContent).toBe(
        "B original",
      );
      expect(bTileName()).toBe("B original");

      // A second, LATER submission - resolves before the first.
      let resolveSecond: () => void = () => {
        throw new Error("second resolver unavailable");
      };
      renameChatHold.value = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
      fireEvent.change(openEdit(), { target: { value: "Second title" } });
      fireEvent.blur(screen.getByTestId("mobile-current-tile-title-input"));
      await waitFor(() =>
        expect(mutateSpies.renameChat).toHaveBeenCalledTimes(2),
      );

      await act(async () => {
        resolveSecond();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId("mobile-current-tile-title").textContent).toBe(
        "Second title",
      );
      expect(bTileName()).toBe("Second title");

      // The stale first submission lands late - it must not overwrite the
      // newer title that already landed.
      await act(async () => {
        resolveFirst();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId("mobile-current-tile-title").textContent).toBe(
        "Second title",
      );
      expect(bTileName()).toBe("Second title");

      // The peer host's row and tile were never touched by either submission.
      expect(aTileName()).toBe("A original");
      expect(
        mocks.handle.current?.store.getState().chats.byId["chat-shared"]?.title,
      ).toBe("chat-shared");
    });

    it("leaves the display and canvas snapshot unchanged when the RPC rejects", async () => {
      seedCrossHostTiles();
      render(<MountedCurrentTileBar epicId="epic-1" tabId={tabId} />);

      renameChatHold.value = Promise.reject(new Error("rejected"));
      fireEvent.change(openEdit(), { target: { value: "Rejected title" } });
      fireEvent.blur(screen.getByTestId("mobile-current-tile-title-input"));
      await waitFor(() =>
        expect(mutateSpies.renameChat).toHaveBeenCalledTimes(1),
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId("mobile-current-tile-title").textContent).toBe(
        "B original",
      );
      expect(bTileName()).toBe("B original");
      expect(aTileName()).toBe("A original");
    });
  });
});
