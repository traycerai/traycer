import "../../../../__tests__/test-browser-apis";
import {
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

vi.mock("@/lib/epic-selectors", () => ({
  useEpicTabDisplayTitle: (node: { readonly name: string }) => node.name,
  useEpicLiveArtifactTitleGenerating: () => false,
  useEpicPermissionRole: () => holder.role,
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

function makeMutateAsync<TVariables>(
  spy: (variables: TVariables) => void,
): (variables: TVariables) => Promise<void> {
  return (variables: TVariables) => {
    spy(variables);
    return Promise.resolve();
  };
}

// `useSwitcherRename` (the hook this bar's title delegates rename commits to)
// now reads a REAL session handle for the optimistic overlay
// (`beginRenameMutation` / `retirePendingMutation`), so it is backed by a real
// `createOpenEpicStore` session rather than a fake shape. The mutation hooks
// stay mocked (rather than the `useSwitcherRename` mapping itself), which
// exercises the real kind -> mutation mapping in `use-switcher-rename.ts`.
vi.mock("@/providers/use-open-epic-handle", () => ({
  // The chat write-routing gate reads the session through the
  // NON-throwing accessor. `null` is the honest double here: this suite
  // mounts no epic store, and no session means no epic write path to gate.
  useMaybeOpenEpicHandle: () => null,
  useOpenEpicHandle: () => {
    if (mocks.handle.current === null) throw new Error("no handle seeded");
    return mocks.handle.current;
  },
}));
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicRenameChat: () => ({
    mutateAsync: makeMutateAsync(mutateSpies.renameChat),
    isPending: false,
  }),
}));
vi.mock("@/hooks/epic/use-epic-tui-agent-mutations", () => ({
  useEpicRenameTuiAgent: () => ({
    mutateAsync: makeMutateAsync(mutateSpies.renameTuiAgent),
    isPending: false,
  }),
}));
vi.mock("@/hooks/epic/use-epic-node-mutations", () => ({
  useEpicRenameArtifact: () => ({
    mutateAsync: makeMutateAsync(mutateSpies.renameArtifact),
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
 * assert on the RPC call args, and `useSwitcherRename` fires the RPC
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

describe("<MobileCurrentTileBar />", () => {
  beforeEach(() => {
    holder.role = "owner";
    mutateSpies.renameChat.mockClear();
    mutateSpies.renameTuiAgent.mockClear();
    mutateSpies.renameArtifact.mockClear();
    mutateSpies.renameTerminal.mockClear();
    mocks.handle.current = newSession();
  });
  afterEach(() => {
    cleanup();
    mocks.handle.current?.dispose();
    mocks.handle.current = null;
  });

  it("shows the current tile title and icon", () => {
    render(<MobileCurrentTileBar epicId="epic-1" tile={SPEC_TILE} />);
    const bar = screen.getByTestId("mobile-current-tile-bar");
    expect(bar.textContent).toContain("Life Philosophy");
    expect(screen.getByTestId("tab-icon")).not.toBeNull();
  });

  it("renders the title as an editable control for a renameable kind and an editor role", () => {
    render(<MobileCurrentTileBar epicId="epic-1" tile={CHAT_TILE} />);
    expect(screen.getByTestId("mobile-current-tile-title").tagName).toBe(
      "BUTTON",
    );
  });

  it("commits an edited title through the rename mutation, keyed to the tile kind", async () => {
    render(<MobileCurrentTileBar epicId="epic-1" tile={CHAT_TILE} />);
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
    });
    expect(mutateSpies.renameTuiAgent).not.toHaveBeenCalled();
    expect(mutateSpies.renameArtifact).not.toHaveBeenCalled();
    expect(mutateSpies.renameTerminal).not.toHaveBeenCalled();
  });

  it("Escape restores the previous title and does not commit", () => {
    render(<MobileCurrentTileBar epicId="epic-1" tile={CHAT_TILE} />);
    const input = openEdit();
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mutateSpies.renameChat).not.toHaveBeenCalled();
    expect(screen.getByTestId("mobile-current-tile-title").textContent).toBe(
      "Chat title",
    );
  });

  it("empty/whitespace commit does not call the mutation and keeps the previous title", () => {
    render(<MobileCurrentTileBar epicId="epic-1" tile={CHAT_TILE} />);
    const input = openEdit();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(mutateSpies.renameChat).not.toHaveBeenCalled();
    expect(screen.getByTestId("mobile-current-tile-title").textContent).toBe(
      "Chat title",
    );
  });

  it("renders plain text with no editable control for a non-renameable tile kind", () => {
    render(<MobileCurrentTileBar epicId="epic-1" tile={FILE_TILE} />);
    const title = screen.getByTestId("mobile-current-tile-title");
    expect(title.tagName).toBe("SPAN");
    expect(screen.queryByTestId("mobile-current-tile-title-input")).toBeNull();
  });

  it("renders plain text for a viewer role even on a renameable kind", () => {
    holder.role = "viewer";
    render(<MobileCurrentTileBar epicId="epic-1" tile={CHAT_TILE} />);
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
      render(<MobileCurrentTileBar epicId="epic-1" tile={input.tile} />);
    }

    function published(): SurfaceSyncEntry | undefined {
      const { entries } = useSurfaceSyncStore.getState();
      const key = `chat:${CHAT_TILE.id}`;
      return Object.hasOwn(entries, key) ? entries[key] : undefined;
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
      const { entries } = useSurfaceSyncStore.getState();
      expect(entries[`chat:${SPEC_TILE.id}`].spell.syncing).toBe(false);
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
        <MobileCurrentTileBar epicId="epic-1" tile={CHAT_TILE} />,
      );
      expect(published()).toBeDefined();
      view.unmount();
      expect(published()).toBeUndefined();
    });
  });
});
