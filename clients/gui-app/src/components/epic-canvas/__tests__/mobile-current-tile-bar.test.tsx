import "../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
import { LINK_DOWN_ESCALATION_MS } from "@/lib/link-down-escalation";

// The live tile icon is covered by the tab-strip tests; stub it here so this
// test targets the bar's own composition (the title it reads).
vi.mock("@/components/epic-canvas/canvas/tab-strip", () => ({
  TabIcon: () => <span data-testid="tab-icon" />,
  TabStrip: () => null,
}));

vi.mock("@/components/epic-canvas/canvas/browser-tab-presentation", () => ({
  useBrowserTabPresentation: () => null,
}));

// `useEpicTabDisplayTitle` passes through real; its unrelated external
// sub-readers are mocked below instead.
vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useEpicLiveArtifactTitleGenerating: () => false,
}));
// The title hook's cloud-list arm (a TanStack query) - this suite mounts no
// QueryClient, and no tile here is a chat the projection lacks a record for.
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatList: () => ({ data: undefined }),
}));

/**
 * The host client the bar resolves for a terminal's bound host, and what the
 * legacy title read (`terminal.list`) was handed: `null` means no legacy read
 * was made at all.
 */
const terminalLegacy = vi.hoisted(() => ({
  client: { tag: "terminal-host-client" },
  titleReadClients: [] as Array<unknown>,
}));

vi.mock("@/hooks/terminal/use-terminal-display-title", () => ({
  useTerminalDisplayTitle: (input: { readonly client: unknown }) => {
    terminalLegacy.titleReadClients.push(input.client);
    return null;
  },
}));

interface TerminalAuthorityTestState {
  capability: "unknown" | "legacy" | "capable";
  displayTitle: string | null;
  readonly tabHostIds: Array<string>;
}

const terminalAuthority = vi.hoisted((): TerminalAuthorityTestState => ({
  capability: "legacy",
  displayTitle: null,
  /** The tab-scoped host each authority read resolved against. */
  tabHostIds: [] as Array<string>,
}));

// The authority's one dependency on the bar is the tab-scoped host binding
// (`useTabPlainTerminalAuthority` → `useTabHostId`), which throws outside a
// `<TabHostProvider>`. The mock keeps that read REAL so the bar must bind the
// terminal's host itself: it renders outside every tile's provider, and a
// throw here lands above the tile error boundary.
vi.mock("@/hooks/terminal/use-epic-terminal-authority", async () => {
  const { useTabHostId } =
    await import("@/components/epic-canvas/hooks/use-tab-host-id");
  return {
    useEpicTerminalAuthority: () => {
      terminalAuthority.tabHostIds.push(useTabHostId());
      return terminalAuthorityResult();
    },
  };
});

function terminalAuthorityResult() {
  return {
    capability: terminalAuthority.capability,
    projection: terminalAuthority.capability === "capable" ? {} : undefined,
    viewModel:
      terminalAuthority.displayTitle === null
        ? null
        : {
            displayTitle: terminalAuthority.displayTitle,
            manualTitle: null,
            activeProcessName: null,
            liveCwd: null,
          },
    canMutate: false,
    migrationPending: false,
    migrationError: null,
    retryMigration: () => undefined,
    ensureRunning: {},
    rename: { mutate: () => undefined },
    close: { isPending: false, mutateAsync: () => Promise.resolve() },
  };
}

vi.mock("@/stores/managed-commands/managed-commands-for-chat", () => ({
  useManagedCommandOnHost: () => null,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : terminalLegacy.client,
}));

const mocks = vi.hoisted(() => ({
  handle: { current: null as OpenedStoreForTest | null },
}));

// The display title's live-artifact read resolves through the open session.
vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => mocks.handle.current,
  useOpenEpicHandle: () => {
    if (mocks.handle.current === null) throw new Error("no handle seeded");
    return mocks.handle.current;
  },
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

const TERMINAL_TILE: EpicCanvasTileRef = {
  id: "terminal-1",
  instanceId: "inst-4",
  type: "terminal",
  name: "Local presentation",
  titleSource: "manual",
  hostId: "host-A",
  cwd: "/ws",
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

/** A live session for "epic-1" with no nodes seeded. */
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

describe("<MobileCurrentTileBar />", () => {
  beforeEach(() => {
    mocks.handle.current = newSession();
  });
  afterEach(() => {
    cleanup();
    mocks.handle.current?.dispose();
    mocks.handle.current = null;
  });

  it("shows the current tile title and icon", () => {
    render(
      <MobileCurrentTileBar epicId="epic-1" tile={SPEC_TILE} level2="bar" />,
    );
    const bar = screen.getByTestId("mobile-current-tile-bar");
    expect(bar.textContent).toContain("Life Philosophy");
    expect(screen.getByTestId("tab-icon")).not.toBeNull();
  });

  it("renders the title as a plain label that a tap never turns into an editor", () => {
    render(
      <MobileCurrentTileBar epicId="epic-1" tile={CHAT_TILE} level2="bar" />,
    );
    const title = screen.getByTestId("mobile-current-tile-title");
    expect(title.tagName).toBe("SPAN");
    fireEvent.click(title);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  describe("a terminal tile", () => {
    beforeEach(() => {
      terminalAuthority.capability = "legacy";
      terminalAuthority.displayTitle = null;
      terminalAuthority.tabHostIds.length = 0;
      terminalLegacy.titleReadClients.length = 0;
    });

    it("binds the terminal's own host for the authority read it mounts outside any tile", () => {
      // Regression: the bar rendered the terminal control outside a
      // `<TabHostProvider>`, so selecting a terminal tile on a phone threw
      // above the tile's error boundary - and kept throwing on every reload,
      // since the same tile was re-selected.
      render(
        <MobileCurrentTileBar
          epicId="epic-1"
          tile={TERMINAL_TILE}
          level2="bar"
        />,
      );
      expect(terminalAuthority.tabHostIds.length).toBeGreaterThan(0);
      expect(
        terminalAuthority.tabHostIds.every((hostId) => hostId === "host-A"),
      ).toBe(true);
    });

    it("on a capable host shows the authority's title and makes no legacy terminal.list read", () => {
      terminalAuthority.capability = "capable";
      terminalAuthority.displayTitle = "Authority title";
      render(
        <MobileCurrentTileBar
          epicId="epic-1"
          tile={TERMINAL_TILE}
          level2="bar"
        />,
      );
      expect(screen.getByTestId("mobile-current-tile-title").textContent).toBe(
        "Authority title",
      );
      expect(terminalLegacy.titleReadClients.length).toBeGreaterThan(0);
      expect(
        terminalLegacy.titleReadClients.every((client) => client === null),
      ).toBe(true);
    });

    it("on a legacy host keeps the legacy title read", () => {
      terminalAuthority.capability = "legacy";
      render(
        <MobileCurrentTileBar
          epicId="epic-1"
          tile={TERMINAL_TILE}
          level2="bar"
        />,
      );
      expect(screen.getByTestId("mobile-current-tile-title").textContent).toBe(
        "Local presentation",
      );
      expect(terminalLegacy.titleReadClients).toContain(terminalLegacy.client);
    });

    it("while the capability is still unknown shows the authority's title and makes no legacy read", () => {
      terminalAuthority.capability = "unknown";
      terminalAuthority.displayTitle = "Deciding";
      render(
        <MobileCurrentTileBar
          epicId="epic-1"
          tile={TERMINAL_TILE}
          level2="bar"
        />,
      );
      expect(terminalLegacy.titleReadClients.length).toBeGreaterThan(0);
      expect(
        terminalLegacy.titleReadClients.every((client) => client === null),
      ).toBe(true);
      expect(screen.getByTestId("mobile-current-tile-title").textContent).toBe(
        "Deciding",
      );
    });
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

          tile={input.tile}
          level2="bar"
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
        <MobileCurrentTileBar epicId="epic-1" tile={CHAT_TILE} level2="bar" />,
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
          <MobileCurrentTileBar epicId="epic-1" tile={aTile} level2="bar" />,
        );
        act(() => {
          vi.advanceTimersByTime(LINK_DOWN_ESCALATION_MS);
        });
        expect(
          publishedFor(`chat:host-A:${CHAT_TILE.id}`)?.spell.escalated,
        ).toBe(true);

        view.rerender(
          <MobileCurrentTileBar epicId="epic-1" tile={bTile} level2="bar" />,
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
});
