import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { NotificationNavigate } from "@/lib/notifications";
import { openChatSearchResult } from "@/lib/chat-search/open-chat-search-result";
import { hostLocatorForJumpTarget } from "@/components/epic-canvas/renderers/chat-tile-jump-logic";
import {
  chatTranscriptJumpKey,
  useChatTranscriptJumpStore,
} from "@/stores/chats/chat-transcript-jump-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  emptyTranscriptWindow,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";

/**
 * `openChatSearchResult` reuses the chat-notification route: it opens the
 * result's chat on the host that answered the search and, when that host is
 * the one the window is currently addressing, parks a `message` transcript
 * jump for the chat tile to consume. Covers the happy path (jump parked, and
 * placeable by `hostLocatorForJumpTarget` for a cold assistant row), the
 * no-anchor case (`messageId: null`), and the cross-host guard (a search
 * result answered by a host the window is not currently on must not park a
 * jump another host's same-id tile could pick up).
 */

function skeletonEntry(rowId: string, ordinal: number): RowSkeletonEntry {
  return {
    rowId,
    createdAt: 1000 + ordinal,
    role: "user",
    byteLength: 64,
    bodyDigest: `d-${rowId}`,
  };
}

function windowNaming(rowIds: readonly string[]): TranscriptWindow {
  return {
    ...emptyTranscriptWindow(),
    epoch: 1,
    rowCount: rowIds.length,
    skeleton: rowIds.map((rowId, ordinal) => skeletonEntry(rowId, ordinal)),
    skeletonComplete: true,
    skeletonStreamCoveredThrough: rowIds.length,
  };
}

describe("openChatSearchResult", () => {
  beforeEach(async () => {
    __resetTabNavigationControllerForTesting();
    __resetTabSyncCoordinatorForTesting();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
    useEpicCanvasStore.setState({
      tabsById: {},
      canvasByTabId: {},
      openTabOrder: [],
    });
    useChatTranscriptJumpStore.setState({ requestsByChatId: {} });
  });

  it("parks a `message` jump when the search host is the effective host", () => {
    const navigate: NotificationNavigate = vi.fn();

    openChatSearchResult(
      navigate,
      {
        hostId: "host-a",
        epicId: "epic-1",
        chatId: "chat-1",
        messageId: "m-turn",
      },
      { effectiveHostId: "host-a", now: 1_000 },
    );

    expect(navigate).toHaveBeenCalled();
    const key = chatTranscriptJumpKey("host-a", "chat-1");
    expect(
      useChatTranscriptJumpStore.getState().requestsByChatId[key]?.target,
    ).toEqual({
      kind: "message",
      messageId: "m-turn",
    });
  });

  it("the parked target asks the host to locate a cold assistant row", () => {
    const navigate: NotificationNavigate = vi.fn();

    openChatSearchResult(
      navigate,
      {
        hostId: "host-a",
        epicId: "epic-1",
        chatId: "chat-1",
        messageId: "m-turn",
      },
      { effectiveHostId: "host-a", now: 1_000 },
    );

    const key = chatTranscriptJumpKey("host-a", "chat-1");
    const parked = useChatTranscriptJumpStore.getState().requestsByChatId[key];
    expect(parked).toBeDefined();
    if (parked === undefined) return;

    // A cold assistant record: the skeleton names only the turn-keyed rows,
    // and nothing is hydrated, so both client reads miss and the host is
    // asked - exactly the shape `chat-tile-jump-locator.test.ts` exercises.
    const locator = hostLocatorForJumpTarget({
      target: parked.target,
      transcriptWindow: windowNaming(["m-1", "assistant:turn-1"]),
      messages: [],
      pendingInterviewBlockId: null,
    });

    expect(locator).toEqual({ kind: "message", messageId: "m-turn" });
  });

  it("navigates but parks no jump when messageId is null", () => {
    const navigate: NotificationNavigate = vi.fn();

    openChatSearchResult(
      navigate,
      {
        hostId: "host-a",
        epicId: "epic-1",
        chatId: "chat-1",
        messageId: null,
      },
      { effectiveHostId: "host-a", now: 1_000 },
    );

    expect(navigate).toHaveBeenCalled();
    expect(useChatTranscriptJumpStore.getState().requestsByChatId).toEqual({});
  });

  it("parks no jump when the search host differs from the effective host and no tile is open", () => {
    const navigate: NotificationNavigate = vi.fn();

    openChatSearchResult(
      navigate,
      {
        hostId: "host-a",
        epicId: "epic-1",
        chatId: "chat-1",
        messageId: "m-turn",
      },
      { effectiveHostId: "host-b", now: 1_000 },
    );

    expect(navigate).toHaveBeenCalled();
    // A different host's tile of the same chat id must never consume this
    // jump; the target host (host-a) is not the one the window addresses.
    expect(useChatTranscriptJumpStore.getState().requestsByChatId).toEqual({});
  });
});
