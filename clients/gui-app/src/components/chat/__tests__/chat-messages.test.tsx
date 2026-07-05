import "../../../../__tests__/test-browser-apis";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { VirtuosoMessageListTestingContext } from "@virtuoso.dev/message-list";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@/hooks/editor/use-editor-open-mutation", () => ({
  useEditorOpen: () => ({ mutate: () => undefined }),
}));
vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: (artifactId: string | null) =>
    artifactId === "agent-sender-1"
      ? {
          id: "agent-sender-1",
          parentId: null,
          title: "Review Agent",
          hostId: "host-1",
        }
      : null,
  useOpenEpicId: () => "epic-1",
}));
import {
  ChatMessages,
  type ChatMessageScrollRequest,
} from "@/components/chat/chat-messages";
import {
  chatFindA2AReceivedBodyUnitId,
  chatFindActivityGroupChildHeaderUnitId,
  chatFindSegmentUnitId,
  chatFindSubagentBodyUnitId,
  chatFindSubagentHeaderUnitId,
} from "@/components/chat/chat-find";
import {
  deriveActivityGroupRenderId,
  derivePromotedSubagentRenderId,
} from "@/components/chat/chat-collapsible-key";
import {
  TileFindContext,
  type TileFindContextValue,
} from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { ChatUserMessageMinimap } from "@/components/chat/chat-user-message-minimap";
import {
  chatMinimapClipRegionProps,
  type ChatUserMinimapItem,
} from "@/components/chat/chat-user-message-minimap-items";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { useTileFindStore, type TileFindAdapter } from "@/stores/tile-find";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";

import {
  makeAssistantMessage,
  makeMessage,
  makeMessages,
} from "./chat-message-fixtures";

const MESSAGE_ROW_SELECTOR = "[data-message-id]";
const VIRTUOSO_TEST_CONTEXT = {
  itemHeight: 100,
  viewportHeight: 500,
};
const TILE_FIND_TEST_INSTANCE_ID = "test-instance";
const TILE_FIND_CONTEXT_VALUE: TileFindContextValue = {
  tileInstanceId: TILE_FIND_TEST_INSTANCE_ID,
  registerAdapter: (adapter: TileFindAdapter) =>
    useTileFindStore.getState().registerTarget({
      tileInstanceId: TILE_FIND_TEST_INSTANCE_ID,
      contentId: "chat-1",
      viewTabId: "view-tab-1",
      tileId: "tile-1",
      epicId: "epic-1",
      tileKind: "chat",
      isEligible: true,
      adapter,
    }),
};
let scrollStateKeySequence = 0;
let restoreHighlights: (() => void) | null = null;

class TestHighlight {
  readonly ranges: ReadonlyArray<Range>;

  constructor(...ranges: ReadonlyArray<Range>) {
    this.ranges = ranges;
  }
}

function minimapItemsFor(
  messages: ReadonlyArray<ChatMessageModel>,
): ReadonlyArray<ChatUserMinimapItem> {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => ({
      id: message.id,
      content: message.content,
      structuredContent: message.structuredContent,
      attachments: message.attachments,
    }));
}

function chatMessagesJsx(
  messages: ReadonlyArray<ChatMessageModel>,
  opts: {
    backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
    minimapItems: ReadonlyArray<ChatUserMinimapItem>;
    scrollStateKey: string;
    visible: boolean;
    scrollRequest: ChatMessageScrollRequest | null;
  },
): ReactNode {
  return (
    <VirtuosoMessageListTestingContext.Provider value={VIRTUOSO_TEST_CONTEXT}>
      <ChatMessages
        taskTitle="Transcript"
        taskId="test-task"
        messages={messages}
        backgroundItems={opts.backgroundItems}
        minimapItems={opts.minimapItems}
        scrollStateKey={opts.scrollStateKey}
        getMessageActions={() => null}
        nextStepActions={null}
        instanceId={TILE_FIND_TEST_INSTANCE_ID}
        visible={opts.visible}
        scrollRequest={opts.scrollRequest}
      />
    </VirtuosoMessageListTestingContext.Provider>
  );
}

function renderChatMessages(
  messages: ReadonlyArray<ChatMessageModel>,
  opts: {
    backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
    minimapItems: ReadonlyArray<ChatUserMinimapItem>;
    scrollStateKey: string;
    visible: boolean;
    scrollRequest: ChatMessageScrollRequest | null;
  },
) {
  return render(chatMessagesJsx(messages, opts));
}

function renderChatMessagesWithTileFind(
  messages: ReadonlyArray<ChatMessageModel>,
  opts: {
    minimapItems: ReadonlyArray<ChatUserMinimapItem>;
    scrollStateKey: string;
    visible: boolean;
  },
) {
  return render(chatMessagesWithTileFindJsx(messages, opts));
}

function chatMessagesWithTileFindJsx(
  messages: ReadonlyArray<ChatMessageModel>,
  opts: {
    minimapItems: ReadonlyArray<ChatUserMinimapItem>;
    scrollStateKey: string;
    visible: boolean;
  },
): ReactNode {
  return (
    <TileFindContext.Provider value={TILE_FIND_CONTEXT_VALUE}>
      {chatMessagesJsx(messages, {
        ...opts,
        backgroundItems: undefined,
        scrollRequest: null,
      })}
    </TileFindContext.Provider>
  );
}

function makeDefaultOpts(
  overrides: Partial<{
    backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
    minimapItems: ReadonlyArray<ChatUserMinimapItem>;
    scrollStateKey: string;
    visible: boolean;
    scrollRequest: ChatMessageScrollRequest | null;
  }>,
) {
  return {
    backgroundItems: overrides.backgroundItems,
    minimapItems: overrides.minimapItems ?? [],
    scrollStateKey:
      overrides.scrollStateKey ??
      `chat-scroll-test-key-${scrollStateKeySequence++}`,
    visible: overrides.visible ?? true,
    scrollRequest: overrides.scrollRequest ?? null,
  };
}

function rerenderChatMessages(
  rerender: (ui: ReactNode) => void,
  messages: ReadonlyArray<ChatMessageModel>,
  opts: {
    backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
    minimapItems: ReadonlyArray<ChatUserMinimapItem>;
    scrollStateKey: string;
    visible: boolean;
    scrollRequest: ChatMessageScrollRequest | null;
  },
): void {
  rerender(chatMessagesJsx(messages, opts));
}

function rerenderChatMessagesWithTileFind(
  rerender: (ui: ReactNode) => void,
  messages: ReadonlyArray<ChatMessageModel>,
  opts: {
    minimapItems: ReadonlyArray<ChatUserMinimapItem>;
    scrollStateKey: string;
    visible: boolean;
  },
): void {
  rerender(chatMessagesWithTileFindJsx(messages, opts));
}

describe("ChatMessages Virtuoso renderer", () => {
  afterEach(() => {
    useTileFindStore.getState().resetForTests();
    restoreHighlights?.();
    restoreHighlights = null;
    vi.restoreAllMocks();
    cleanup();
  });

  it("retains the empty state", () => {
    const { container } = renderChatMessages([], makeDefaultOpts({}));

    const title = screen.getByText("Start the conversation");
    const description = screen.getByText("Send a message to get started.");

    expect(title.className).toContain("text-muted-foreground/60");
    expect(description.className).toContain("text-muted-foreground/50");
    expect(container.querySelector(".lucide-message-square")).not.toBeNull();
  });

  it("keeps only the bottom chat scroll fade", () => {
    const { container } = renderChatMessages([], makeDefaultOpts({}));

    expect(container.querySelector(".bg-linear-to-b")).toBeNull();
    expect(container.querySelector(".bg-linear-to-t")).not.toBeNull();
  });

  it("hides completed steer labels on user bubbles", async () => {
    const steered: ChatMessageModel = {
      ...makeMessage(1, "user"),
      content: "can you see this message?",
      steerBadge: { status: "steered", mode: "safe_point" },
    };
    const requested: ChatMessageModel = {
      ...makeMessage(2, "user"),
      content: "waiting for a safe point",
      steerBadge: { status: "requested", mode: "safe_point" },
    };
    const messages = [steered, requested];

    renderChatMessages(
      messages,
      makeDefaultOpts({ minimapItems: minimapItemsFor(messages) }),
    );

    await waitFor(() => {
      expect(screen.getByText("can you see this message?")).not.toBeNull();
      expect(screen.getByText("waiting for a safe point")).not.toBeNull();
    });
    expect(screen.queryByText("Steered")).toBeNull();
    expect(screen.getByText("Steer requested")).not.toBeNull();
  });

  it("renders a bounded long-chat DOM, not every message", async () => {
    const messages = makeMessages(1_000);
    const { container } = renderChatMessages(
      messages,
      makeDefaultOpts({ minimapItems: minimapItemsFor(messages) }),
    );

    await waitFor(() => {
      const ids = rowIds(container);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.length).toBeLessThan(80);
      expect(ids.length).toBeLessThan(1_000);
    });
  });

  it("renders the tail of the initial non-empty history", async () => {
    const messages = makeMessages(100);
    const { container } = renderChatMessages(
      messages,
      makeDefaultOpts({ minimapItems: minimapItemsFor(messages) }),
    );

    await waitFor(() => {
      const ids = rowIds(container);
      expect(ids).toContain("message-99");
      expect(ids).not.toContain("message-0");
    });
  });

  it("searches a virtualized row and paints after the target mounts", async () => {
    const registry = installMockHighlights();
    const messages = makeMessages(100);
    const { container } = renderChatMessagesWithTileFind(
      messages,
      makeDefaultOpts({ minimapItems: minimapItemsFor(messages) }),
    );

    await waitFor(() => {
      expect(rowIds(container)).toContain("message-99");
      expect(rowIds(container)).not.toContain("message-0");
    });
    await waitFor(() => {
      expect(
        useTileFindStore.getState().targetsByTileInstanceId[
          TILE_FIND_TEST_INSTANCE_ID
        ]?.adapter.tileKind,
      ).toBe("chat");
    });

    act(() => {
      const store = useTileFindStore.getState();
      store.setQuery(TILE_FIND_TEST_INSTANCE_ID, "User message 0");
      store.search(TILE_FIND_TEST_INSTANCE_ID);
    });

    expect(
      useTileFindStore.getState().uiByTileInstanceId[TILE_FIND_TEST_INSTANCE_ID]
        ?.lastSnapshot,
    ).toMatchObject({
      total: 1,
      activeUnitId: "message:message-0:content",
      exactHighlight: "pending",
    });

    await waitFor(() => {
      expect(rowIds(container)).toContain("message-0");
    });
    await waitFor(() => {
      expect(
        useTileFindStore.getState().uiByTileInstanceId[
          TILE_FIND_TEST_INSTANCE_ID
        ]?.lastSnapshot.exactHighlight,
      ).toBe("painted");
    });

    const activeEntry = Array.from(registry.values.entries()).find(([name]) =>
      name.includes("active"),
    );
    const activeRange = activeEntry?.[1].ranges[0];
    const activeRow =
      activeRange?.startContainer.parentElement?.closest(MESSAGE_ROW_SELECTOR);
    expect(activeRow?.getAttribute("data-message-id")).toBe("message-0");
  });

  it("paints activity-group header matches inside content-bearing trigger buttons", async () => {
    const registry = installMockHighlights();
    const messages = [makeAssistantMessage("assistant-1", "activity-1")];
    renderChatMessagesWithTileFind(
      messages,
      makeDefaultOpts({ minimapItems: [] }),
    );

    await waitFor(() => {
      expect(
        useTileFindStore.getState().targetsByTileInstanceId[
          TILE_FIND_TEST_INSTANCE_ID
        ]?.adapter.tileKind,
      ).toBe("chat");
    });

    act(() => {
      const store = useTileFindStore.getState();
      store.setQuery(TILE_FIND_TEST_INSTANCE_ID, "Ran 1 command");
      store.search(TILE_FIND_TEST_INSTANCE_ID);
    });

    await waitFor(() => {
      expect(
        useTileFindStore.getState().uiByTileInstanceId[
          TILE_FIND_TEST_INSTANCE_ID
        ]?.lastSnapshot.exactHighlight,
      ).toBe("painted");
    });

    const activeEntry = Array.from(registry.values.entries()).find(([name]) =>
      name.includes("active"),
    );
    const activeButton =
      activeEntry?.[1].ranges[0]?.startContainer.parentElement?.closest(
        "button",
      );
    expect(activeButton?.getAttribute("data-find-include")).toBe("true");
  });

  it("reveals a collapsed subagent body match before scrolling and painting the body unit", async () => {
    const registry = installMockHighlights();
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const subagentId = "subagent-hidden-needle";
    const messages = [makeSubagentMessage("assistant-subagent", subagentId)];
    renderChatMessagesWithTileFind(
      messages,
      makeDefaultOpts({ minimapItems: [] }),
    );

    await waitForChatFindAdapter();
    searchChat("needle");

    await waitFor(() => {
      expect(lastChatFindSnapshot()?.exactHighlight).toBe("painted");
    });

    const unitId = chatFindSubagentBodyUnitId(
      derivePromotedSubagentRenderId(subagentId),
    );
    const range = activeHighlightRange(registry);
    const unitRoot = activeHighlightUnitRoot(range);
    expect(unitRoot?.dataset.chatFindUnit).toBe(unitId);
    expect(range?.startContainer.parentElement?.closest("button")).toBeNull();
    expect(unitRoot?.closest("[hidden]")).toBeNull();
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("paints a subagent name match inside the always-visible header unit", async () => {
    const registry = installMockHighlights();
    const subagentId = "subagent-header-name";
    const messages = [
      makeSubagentMessage("assistant-subagent-header", subagentId),
    ];
    renderChatMessagesWithTileFind(
      messages,
      makeDefaultOpts({ minimapItems: [] }),
    );

    await waitForChatFindAdapter();
    // "Researcher" is the subagent's name - rendered only in the always-visible
    // header (not the collapsed body), so it must paint in the header unit.
    searchChat("Researcher");

    await waitFor(() => {
      expect(lastChatFindSnapshot()?.exactHighlight).toBe("painted");
    });

    expect(lastChatFindSnapshot()?.total).toBe(1);
    const range = activeHighlightRange(registry);
    const unitRoot = activeHighlightUnitRoot(range);
    expect(unitRoot?.dataset.chatFindUnit).toBe(
      chatFindSubagentHeaderUnitId(derivePromotedSubagentRenderId(subagentId)),
    );
    // The header is a content-bearing trigger button (always visible, never
    // collapsed away).
    expect(
      range?.startContainer.parentElement?.closest("button"),
    ).not.toBeNull();
    expect(unitRoot?.closest("[hidden]")).toBeNull();
    expect(unitRoot?.textContent).toContain("Researcher");
  });

  it("does not over-paint the streaming subagent header summary mirror", async () => {
    const registry = installMockHighlights();
    const subagentId = "subagent-header-mirror";
    const messages = [
      makeStreamingSubagentMirrorMessage("assistant-header-mirror", subagentId),
    ];
    renderChatMessagesWithTileFind(
      messages,
      makeDefaultOpts({ minimapItems: [] }),
    );

    await waitForChatFindAdapter();
    // The agent is named "Scanner" and its latest progress line is "Scanner
    // online", which the streaming header trigger mirrors. The painter scopes to
    // the active match's unit; the active match here is the name in the header
    // unit, so the trigger DOM is the paint root. The projection indexes only
    // name + type for the header, so the mirror occurrence in that same trigger
    // must be data-find-skip'd or it paints a phantom second highlight.
    searchChat("Scanner");

    await waitFor(() => {
      expect(lastChatFindSnapshot()?.exactHighlight).toBe("painted");
    });

    // Two projected matches: the header name and the body progress line. The
    // header summary mirror is NOT indexed.
    expect(lastChatFindSnapshot()?.total).toBe(2);
    expect(lastChatFindSnapshot()?.activeUnitId).toBe(
      chatFindSubagentHeaderUnitId(derivePromotedSubagentRenderId(subagentId)),
    );
    // Only the header unit is painted (the active match). With the mirror
    // skipped, that unit highlights the single projected occurrence (the name) -
    // before the fix the mirror added a phantom second highlight, so this was 2.
    expect(totalPaintedRanges(registry)).toBe(1);
    for (const range of allPaintedRanges(registry)) {
      expect(
        range.startContainer.parentElement?.closest("[data-find-skip]"),
      ).toBeNull();
    }
    // The painted occurrence is the name in the always-visible header trigger.
    const active = activeHighlightRange(registry);
    expect(
      active?.startContainer.parentElement?.closest("button"),
    ).not.toBeNull();
    expect(active?.startContainer.textContent).toContain("Scanner");
  });

  it("does not re-center the unit when navigating between consecutive matches in the same section", async () => {
    installMockHighlights();
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const subagentId = "subagent-consecutive";
    const messages = [
      makeSubagentMessageWithResult(
        "assistant-consecutive",
        subagentId,
        "First needle here. Second needle there.",
      ),
    ];
    renderChatMessagesWithTileFind(
      messages,
      makeDefaultOpts({ minimapItems: [] }),
    );

    await waitForChatFindAdapter();
    searchChat("needle");
    await waitFor(() => {
      expect(lastChatFindSnapshot()?.exactHighlight).toBe("painted");
    });
    expect(lastChatFindSnapshot()?.total).toBe(2);
    // The first reveal force-opens the collapsed card and centers the unit.
    expect(
      scrollIntoView.mock.calls.some((call) => {
        const arg = call[0];
        return typeof arg === "object" && arg.block === "center";
      }),
    ).toBe(true);

    scrollIntoView.mockClear();
    act(() => {
      useTileFindStore.getState().next(TILE_FIND_TEST_INSTANCE_ID);
    });
    await waitFor(() => {
      expect(lastChatFindSnapshot()?.current).toBe(2);
      expect(lastChatFindSnapshot()?.exactHighlight).toBe("painted");
    });

    // Same already-open unit: no unit re-center (would flicker); only the
    // active-match scroll within the inner scroll container.
    const blocks = scrollIntoView.mock.calls.map((call) => {
      const arg = call[0];
      return typeof arg === "object" ? arg.block : undefined;
    });
    expect(blocks).not.toContain("center");
    expect(blocks).toContain("nearest");
  });

  it("paints an always-visible file-change group match inside its unit anchor", async () => {
    const registry = installMockHighlights();
    const groupId = "file-change-group-anchor";
    const messages = [
      makeFileChangeGroupMessage("assistant-file-group", groupId),
    ];
    renderChatMessagesWithTileFind(
      messages,
      makeDefaultOpts({ minimapItems: [] }),
    );

    await waitForChatFindAdapter();
    searchChat("Changes");

    await waitFor(() => {
      expect(lastChatFindSnapshot()?.exactHighlight).toBe("painted");
    });

    const range = activeHighlightRange(registry);
    const unitRoot = activeHighlightUnitRoot(range);
    expect(unitRoot?.dataset.chatFindUnit).toBe(chatFindSegmentUnitId(groupId));
    expect(unitRoot?.textContent).toContain("Changes");
  });

  it("paints a subagent body occurrence instead of a skipped section label", async () => {
    const registry = installMockHighlights();
    const subagentId = "subagent-result-label";
    const messages = [
      makeSubagentMessageWithResult(
        "assistant-subagent-result",
        subagentId,
        "Result body target.",
      ),
    ];
    renderChatMessagesWithTileFind(
      messages,
      makeDefaultOpts({ minimapItems: [] }),
    );

    await waitForChatFindAdapter();
    searchChat("Result");

    await waitFor(() => {
      expect(lastChatFindSnapshot()?.exactHighlight).toBe("painted");
    });

    const range = activeHighlightRange(registry);
    const unitRoot = activeHighlightUnitRoot(range);
    expect(unitRoot?.dataset.chatFindUnit).toBe(
      chatFindSubagentBodyUnitId(derivePromotedSubagentRenderId(subagentId)),
    );
    expect(
      range?.startContainer.parentElement?.closest("[data-find-skip]"),
    ).toBeNull();
    expect(range?.startContainer.textContent).toContain("Result body target.");
  });

  it("reveals a collapsed activity group child header match and paints that header unit", async () => {
    const registry = installMockHighlights();
    const messages = [makeAssistantMessage("assistant-activity", "activity-2")];
    renderChatMessagesWithTileFind(
      messages,
      makeDefaultOpts({ minimapItems: [] }),
    );

    await waitForChatFindAdapter();
    searchChat("echo hi");

    await waitFor(() => {
      expect(lastChatFindSnapshot()?.exactHighlight).toBe("painted");
    });

    const childSegmentId = "activity-2:command";
    const unitId = chatFindActivityGroupChildHeaderUnitId(
      deriveActivityGroupRenderId(childSegmentId),
      childSegmentId,
    );
    const range = activeHighlightRange(registry);
    const unitRoot = activeHighlightUnitRoot(range);
    expect(unitRoot?.dataset.chatFindUnit).toBe(unitId);
    expect(unitRoot?.closest("button")?.textContent).toContain("echo hi");
    expect(unitRoot?.closest("[hidden]")).toBeNull();
  });

  it("reveals a collapsed received A2A body match and paints inside the message body", async () => {
    const registry = installMockHighlights();
    const message = makeAgentUserMessage("agent-message-1", "received needle");
    renderChatMessagesWithTileFind(
      [message],
      makeDefaultOpts({ minimapItems: minimapItemsFor([message]) }),
    );

    await waitForChatFindAdapter();
    searchChat("needle");

    await waitFor(() => {
      expect(lastChatFindSnapshot()?.exactHighlight).toBe("painted");
    });

    const range = activeHighlightRange(registry);
    const unitRoot = activeHighlightUnitRoot(range);
    expect(unitRoot?.dataset.chatFindUnit).toBe(
      chatFindA2AReceivedBodyUnitId(message.id),
    );
    expect(
      screen.getByRole("button", { name: "Open sending agent" }),
    ).not.toBeNull();
    expect(range?.startContainer.parentElement?.closest("button")).toBeNull();
  });

  it("manual collapse clears the active subagent highlight and next navigation re-reveals it", async () => {
    installMockHighlights();
    const subagentId = "subagent-manual-collapse";
    const messages = [makeSubagentMessage("assistant-collapse", subagentId)];
    renderChatMessagesWithTileFind(
      messages,
      makeDefaultOpts({ minimapItems: [] }),
    );

    await waitForChatFindAdapter();
    searchChat("needle");
    await waitFor(() => {
      expect(lastChatFindSnapshot()?.exactHighlight).toBe("painted");
    });

    fireEvent.click(screen.getByRole("button", { name: "Subagent" }));

    await waitFor(() => {
      expect(lastChatFindSnapshot()?.exactHighlight).toBe("pending");
    });

    act(() => {
      useTileFindStore.getState().next(TILE_FIND_TEST_INSTANCE_ID);
    });

    await waitFor(() => {
      expect(lastChatFindSnapshot()?.exactHighlight).toBe("painted");
    });
  });

  it("rescans reapply the active chain without explicit navigation when the active unit moves", async () => {
    installMockHighlights();
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const opts = makeDefaultOpts({ minimapItems: [] });
    const initialMessages = [
      makeCommandMessageWithCommand(
        "assistant-rescan-reapply",
        "activity-rescan-reapply",
        "needle",
      ),
    ];
    const { container, rerender } = renderChatMessagesWithTileFind(
      initialMessages,
      opts,
    );

    await waitForChatFindAdapter();
    searchChat("needle");
    await waitFor(() => {
      expect(lastChatFindSnapshot()?.exactHighlight).toBe("painted");
    });
    const initialScrollCallCount = scrollIntoView.mock.calls.length;

    const subagentId = "subagent-rescan-reapply";
    const nextMessages = [
      makeSubagentMessageWithResult(
        "assistant-rescan-reapply",
        subagentId,
        "Body needle target.",
      ),
    ];
    const unitId = chatFindSubagentBodyUnitId(
      derivePromotedSubagentRenderId(subagentId),
    );
    rerenderChatMessagesWithTileFind(rerender, nextMessages, opts);

    await waitFor(() => {
      expect(lastChatFindSnapshot()).toMatchObject({
        total: 1,
        activeUnitId: unitId,
        exactHighlight: "painted",
      });
    });
    expect(findChatFindUnitRoot(container, unitId)?.closest("[hidden]")).toBe(
      null,
    );
    expect(scrollIntoView.mock.calls.length).toBe(initialScrollCallCount);
  });

  it("releases find-forced cards when the active match disappears on rescan", async () => {
    installMockHighlights();
    const subagentId = "subagent-rescan-release";
    const unitId = chatFindSubagentBodyUnitId(
      derivePromotedSubagentRenderId(subagentId),
    );
    const opts = makeDefaultOpts({ minimapItems: [] });
    const initialMessages = [
      makeSubagentMessageWithResult(
        "assistant-rescan-release",
        subagentId,
        "Needle is present.",
      ),
    ];
    const { container, rerender } = renderChatMessagesWithTileFind(
      initialMessages,
      opts,
    );

    await waitForChatFindAdapter();
    searchChat("needle");
    await waitFor(() => {
      expect(lastChatFindSnapshot()?.exactHighlight).toBe("painted");
    });
    expect(findChatFindUnitRoot(container, unitId)?.closest("[hidden]")).toBe(
      null,
    );

    rerenderChatMessagesWithTileFind(
      rerender,
      [
        makeSubagentMessageWithResult(
          "assistant-rescan-release",
          subagentId,
          "The streamed result changed.",
        ),
      ],
      opts,
    );

    await waitFor(() => {
      expect(lastChatFindSnapshot()).toMatchObject({
        total: 0,
        activeUnitId: null,
        exactHighlight: "none",
      });
    });
    await waitFor(() => {
      expect(
        findChatFindUnitRoot(container, unitId)?.closest("[hidden]"),
      ).not.toBeNull();
    });
  });

  it("samples the minimap rail for long chats", async () => {
    const messages = makeMessages(500);
    renderChatMessages(
      messages,
      makeDefaultOpts({ minimapItems: minimapItemsFor(messages) }),
    );

    await waitFor(() => {
      expect(
        within(
          screen.getByTestId("chat-user-message-minimap-rail"),
        ).getAllByRole("button").length,
      ).toBeLessThanOrEqual(120);
    });
  });

  it("keeps activity-group user overrides in list-local state", async () => {
    const messages = [makeAssistantMessage("assistant-1", "activity-1")];
    const opts = makeDefaultOpts({ minimapItems: [] });
    const { rerender } = renderChatMessages(messages, opts);

    fireEvent.click(getButtonContainingText("Ran 1 command"));

    await waitFor(() => {
      expect(screen.getByText("echo hi")).not.toBeNull();
    });

    rerenderChatMessages(
      rerender,
      [makeAssistantMessage("assistant-1", "activity-1")],
      opts,
    );

    expect(screen.getByText("echo hi")).not.toBeNull();
  });

  it("consumes background scroll requests once across background item refreshes", async () => {
    const messages = [makeAssistantMessage("assistant-1", "activity-1")];
    const scrollRequest = {
      messageId: "assistant-1",
      blockId: "activity-1:command",
      requestId: 1,
    };
    const opts = makeDefaultOpts({ minimapItems: [], scrollRequest });
    const { rerender } = renderChatMessages(messages, opts);

    await waitFor(() => {
      expect(screen.getByText("echo hi")).not.toBeNull();
    });

    screen.getByTestId("virtuoso-list").style.visibility = "visible";
    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/i }));
    expect(screen.queryByText("echo hi")).toBeNull();

    rerenderChatMessages(rerender, messages, {
      ...opts,
      backgroundItems: [
        {
          taskId: "task-bg",
          kind: "command",
          title: "sleep 60",
          blockId: "unrelated-tool",
          parentTaskId: null,
          scheduledFor: null,
        },
      ],
    });

    expect(screen.queryByText("echo hi")).toBeNull();
  });

  it("renders a host-reported background command as a live standalone card", async () => {
    const assistant: ChatMessageModel = {
      ...makeMessage(1, "assistant"),
      segments: [
        {
          id: "tool-bg",
          kind: "tool",
          toolName: "Bash",
          inputSummary: "sleep 60",
          inputDetail: { kind: "command", command: "sleep 60" },
          taskTodoItems: null,
          error: null,
          agentMessageSend: null,
          isStreaming: false,
          endState: null,
          stopped: false,
          progress: null,
          backgroundOutput: null,
          backgroundTask: false,
          startedAt: Date.now(),
          durationMs: null,
          parentId: null,
        },
      ],
    };

    renderChatMessages(
      [assistant],
      makeDefaultOpts({
        backgroundItems: [
          {
            taskId: "task-bg",
            kind: "command",
            title: "sleep 60",
            blockId: "tool-bg",
            parentTaskId: null,
            scheduledFor: null,
          },
        ],
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Ran 1 command")).toBeNull();
      expect(screen.getByText("Bash")).not.toBeNull();
      expect(screen.getByLabelText("Tool running")).not.toBeNull();
    });
  });

  it("uses sticky opaque headers for expanded accumulated rows", () => {
    const messages = [makeAssistantMessage("assistant-1", "activity-1")];
    renderChatMessages(messages, makeDefaultOpts({ minimapItems: [] }));

    fireEvent.click(getButtonContainingText("Ran 1 command"));
    const commandButton = getButtonContainingText("echo hi");
    fireEvent.click(commandButton);

    expect(commandButton.className).toContain("sticky");
    expect(commandButton.className).toContain("bg-background");
    expect(commandButton.className).not.toContain("backdrop-blur");
  });

  it("clicking a minimap target scrolls without crashing and keeps the overlay usable", async () => {
    const messages = [makeMessage(0, "user"), makeMessage(1, "user")];
    renderChatMessages(
      messages,
      makeDefaultOpts({ minimapItems: minimapItemsFor(messages) }),
    );

    const minimap = screen.getByTestId("chat-user-message-minimap");
    fireEvent.pointerEnter(minimap);

    await waitFor(() => {
      expect(screen.getByRole("listbox")).not.toBeNull();
    });

    const overlay = screen.getByRole("listbox");
    const firstOption = within(overlay).getAllByRole("option").at(0);
    if (firstOption === undefined) throw new Error("Expected minimap options");
    fireEvent.click(firstOption);
  });

  it("renders structured image references in the expanded minimap", async () => {
    const structuredContent: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "slashCommand",
              attrs: { commandName: "thermo-nuclear-code-quality-review" },
            },
            { type: "text", text: " can you see this " },
            {
              type: "imageAttachment",
              attrs: {
                id: "img-1",
                fileName: "first.png",
                b64content: "img-1",
                mimeType: "image/png",
                size: 5,
              },
            },
            { type: "text", text: " and this " },
            {
              type: "imageAttachment",
              attrs: {
                id: "img-2",
                fileName: "second.png",
                b64content: "img-2",
                mimeType: "image/png",
                size: 5,
              },
            },
          ],
        },
      ],
    };
    const message: ChatMessageModel = {
      ...makeMessage(0, "user"),
      content: "/thermo-nuclear-code-quality-review can you see this and this",
      structuredContent,
    };
    renderChatMessages(
      [message],
      makeDefaultOpts({ minimapItems: minimapItemsFor([message]) }),
    );

    fireEvent.pointerEnter(screen.getByTestId("chat-user-message-minimap"));

    await waitFor(() => {
      const overlay = screen.getByRole("listbox");
      expect(within(overlay).getByText("Image#1")).not.toBeNull();
      expect(within(overlay).getByText("Image#2")).not.toBeNull();
      expect(
        within(overlay).getByLabelText("Attached Image#1: first.png"),
      ).not.toBeNull();
      expect(
        within(overlay).getByLabelText("Attached Image#2: second.png"),
      ).not.toBeNull();
    });
  });

  it("reveals the active minimap option when the long overlay mounts", async () => {
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const messages = makeMessages(200);
    renderChatMessages(
      messages,
      makeDefaultOpts({ minimapItems: minimapItemsFor(messages) }),
    );

    fireEvent.pointerEnter(screen.getByTestId("chat-user-message-minimap"));

    await waitFor(() => {
      const selected = within(screen.getByRole("listbox")).getByRole("option", {
        selected: true,
      });
      expect(selected.textContent).toContain("User message 199");
      expect(selected.className).toContain("h-[3.25rem]");
      expect(selected.className).toContain("shrink-0");
      expect(selected.className).not.toContain("content-visibility");
      expect(selected.className).not.toContain("contain-intrinsic-size");
      const content = selected.querySelector("span");
      expect(content?.className).toContain("[content-visibility:auto]");
      expect(content?.className).toContain("[contain-intrinsic-size:2.5rem]");
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not recenter an open minimap when the items array reference refreshes", async () => {
    const messages = makeMessages(200);
    // Reuse the SAME opts (and thus the same scrollStateKey) across the
    // rerender; only the minimap items array reference is refreshed, so this
    // test isolates exactly that change instead of also varying the key.
    const opts = makeDefaultOpts({ minimapItems: minimapItemsFor(messages) });
    const { rerender } = renderChatMessages(messages, opts);

    fireEvent.pointerEnter(screen.getByTestId("chat-user-message-minimap"));

    await waitFor(() => {
      expect(screen.getByRole("listbox")).not.toBeNull();
    });
    const overlay = screen.getByRole("listbox");
    overlay.scrollTop = 37;

    rerenderChatMessages(rerender, messages, {
      ...opts,
      minimapItems: minimapItemsFor(messages),
    });

    expect(screen.getByRole("listbox").scrollTop).toBe(37);
  });

  it("restores a minimap-navigated position after the chat tile remounts", async () => {
    const messages = makeMessages(200);
    const opts = makeDefaultOpts({
      minimapItems: minimapItemsFor(messages),
      scrollStateKey: "remount-restore-test",
    });
    const { unmount } = renderChatMessages(messages, opts);

    fireEvent.pointerEnter(screen.getByTestId("chat-user-message-minimap"));

    await waitFor(() => {
      expect(screen.getByRole("listbox")).not.toBeNull();
    });
    const target = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .find((option) => option.textContent.includes("User message 100"));
    if (target === undefined) throw new Error("Expected target option");
    fireEvent.click(target);

    // Fire the hover ONCE before `waitFor`: `waitFor` retries its callback, so
    // a `fireEvent` inside it dispatches repeatedly and invites flakiness.
    fireEvent.pointerEnter(screen.getByTestId("chat-user-message-minimap"));
    await waitFor(() => {
      expect(
        within(screen.getByRole("listbox")).getByRole("option", {
          selected: true,
        }).textContent,
      ).toContain("User message 100");
    });

    unmount();
    const remounted = renderChatMessages(messages, opts);

    fireEvent.pointerEnter(screen.getByTestId("chat-user-message-minimap"));
    await waitFor(() => {
      expect(
        within(screen.getByRole("listbox")).getByRole("option", {
          selected: true,
        }).textContent,
      ).toContain("User message 100");
      expect(rowIds(remounted.container)).not.toHaveLength(0);
    });
  });

  it("scrolls only the minimap overlay when revealing the active option", async () => {
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.getAttribute("role") === "listbox" ? 100 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.getAttribute("role") === "listbox" ? 20 * 52 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.getAttribute("role") === "option" ? 52 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(
      function (this: HTMLElement) {
        if (this.getAttribute("role") !== "option") return 0;
        if (this.parentElement === null) return 0;
        return Array.from(this.parentElement.children).indexOf(this) * 52;
      },
    );
    const items: ReadonlyArray<ChatUserMinimapItem> = Array.from(
      { length: 20 },
      (_unused, index) => ({
        id: `item-${index}`,
        content: `User message ${index}`,
        structuredContent: null,
        attachments: [],
      }),
    );
    render(
      <div data-testid="ancestor">
        <ChatUserMessageMinimap
          items={items}
          activeMessageId="item-15"
          onItemClick={() => undefined}
        />
      </div>,
    );
    const ancestor = screen.getByTestId("ancestor");
    ancestor.scrollTop = 123;

    fireEvent.pointerEnter(screen.getByTestId("chat-user-message-minimap"));

    await waitFor(() => {
      expect(screen.getByRole("listbox").scrollTop).toBe(756);
    });
    expect(ancestor.scrollTop).toBe(123);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("sizes the expanded minimap to the clipped chat message region", async () => {
    const items: ReadonlyArray<ChatUserMinimapItem> = Array.from(
      { length: 20 },
      (_unused, index) => ({
        id: `item-${index}`,
        content: `User message ${index}`,
        structuredContent: null,
        attachments: [],
      }),
    );
    render(
      <div data-testid="chat-message-region" {...chatMinimapClipRegionProps}>
        <ChatUserMessageMinimap
          items={items}
          activeMessageId="item-15"
          onItemClick={() => undefined}
        />
      </div>,
    );
    const chatRegion = screen.getByTestId("chat-message-region");
    const minimap = screen.getByTestId("chat-user-message-minimap");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this === chatRegion) {
          return testDomRect({
            left: 100,
            top: 40,
            width: 320,
            height: 260,
          });
        }
        if (this === minimap) {
          return testDomRect({
            left: 400,
            top: 52,
            width: 8,
            height: 20,
          });
        }
        return testDomRect({
          left: 0,
          top: 0,
          width: 0,
          height: 0,
        });
      },
    );

    fireEvent.pointerEnter(minimap);

    await waitFor(() => {
      const overlay = screen.getByRole("listbox");
      // The var carries only the measured ceiling; the design caps live in the
      // overlay's static className.
      expect(
        overlay.style.getPropertyValue("--chat-minimap-overlay-max-height"),
      ).toBe("236px");
      expect(
        overlay.style.getPropertyValue("--chat-minimap-overlay-width"),
      ).toBe("296px");
    });
  });

  it("renders the new tail after the transcript shrinks far (branch edit / suffix removal)", async () => {
    // Behavioural cover for the shrink path that, in the browser, makes
    // message-list hand `computeItemKey` / `itemIdentity` a transient undefined
    // item (its totalCount lags one step behind the shortened data). The
    // deterministic guard is unit-tested on `chatComputeItemKey` /
    // `chatItemIdentity`; here we just confirm a deep shrink keeps rendering.
    const longHistory = makeMessages(200);
    const opts = makeDefaultOpts({
      minimapItems: minimapItemsFor(longHistory),
    });
    const { container, rerender } = renderChatMessages(longHistory, opts);

    await waitFor(() => {
      expect(rowIds(container).length).toBeGreaterThan(0);
    });

    const shortHistory = longHistory.slice(0, 2);
    rerenderChatMessages(rerender, shortHistory, {
      ...opts,
      minimapItems: minimapItemsFor(shortHistory),
    });

    await waitFor(() => {
      const ids = rowIds(container);
      expect(ids).toContain("message-1");
      expect(ids).not.toContain("message-199");
    });
  });
});

function rowIds(container: HTMLElement): ReadonlyArray<string> {
  return Array.from(
    container.querySelectorAll<HTMLElement>(MESSAGE_ROW_SELECTOR),
  )
    .map((element) => element.getAttribute("data-message-id"))
    .filter((id): id is string => id !== null);
}

async function waitForChatFindAdapter(): Promise<void> {
  await waitFor(() => {
    expect(
      useTileFindStore.getState().targetsByTileInstanceId[
        TILE_FIND_TEST_INSTANCE_ID
      ]?.adapter.tileKind,
    ).toBe("chat");
  });
}

function searchChat(query: string): void {
  act(() => {
    const store = useTileFindStore.getState();
    store.setQuery(TILE_FIND_TEST_INSTANCE_ID, query);
    store.search(TILE_FIND_TEST_INSTANCE_ID);
  });
}

function lastChatFindSnapshot() {
  return useTileFindStore.getState().uiByTileInstanceId[
    TILE_FIND_TEST_INSTANCE_ID
  ]?.lastSnapshot;
}

function activeHighlightRange(registry: {
  readonly values: ReadonlyMap<string, TestHighlight>;
}): Range | undefined {
  return Array.from(registry.values.entries()).find(([name]) =>
    name.includes("active"),
  )?.[1].ranges[0];
}

function allPaintedRanges(registry: {
  readonly values: ReadonlyMap<string, TestHighlight>;
}): ReadonlyArray<Range> {
  // Both the "active" and the "match" highlights together are every range the
  // painter put on screen for the current query.
  return Array.from(registry.values.values()).flatMap(
    (highlight) => highlight.ranges,
  );
}

function totalPaintedRanges(registry: {
  readonly values: ReadonlyMap<string, TestHighlight>;
}): number {
  return allPaintedRanges(registry).length;
}

function activeHighlightUnitRoot(range: Range | undefined): HTMLElement | null {
  return (
    range?.startContainer.parentElement?.closest("[data-chat-find-unit]") ??
    null
  );
}

function findChatFindUnitRoot(
  container: HTMLElement,
  unitId: string,
): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    `[data-chat-find-unit="${unitId}"]`,
  );
}

function getButtonContainingText(text: string): HTMLButtonElement {
  const button = screen.getByText(text).closest("button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${text} to be inside a button`);
  }
  return button;
}

function makeSubagentMessage(
  messageId: string,
  subagentId: string,
): ChatMessageModel {
  return makeSubagentMessageWithResult(
    messageId,
    subagentId,
    "Collapsed preview also says needle. Body needle target.",
  );
}

function makeSubagentMessageWithResult(
  messageId: string,
  subagentId: string,
  result: string,
): ChatMessageModel {
  return {
    ...makeMessage(0, "assistant"),
    id: messageId,
    segments: [
      {
        id: subagentId,
        kind: "subagent",
        name: "Researcher",
        agentType: "analysis",
        task: "Investigate the issue",
        progressUpdates: ["Checked visible state"],
        result,
        isStreaming: false,
        endState: null,
        stopped: false,
        startedAt: 1,
        durationMs: 1200,
        spawnToolCallId: null,
        children: [],
      },
    ],
  };
}

function makeStreamingSubagentMirrorMessage(
  messageId: string,
  subagentId: string,
): ChatMessageModel {
  return {
    ...makeMessage(0, "assistant"),
    id: messageId,
    segments: [
      {
        id: subagentId,
        kind: "subagent",
        // Name is a substring of the latest progress line, so a search for it
        // matches the projected header name AND the streaming header summary
        // mirror that echoes that progress line in the same trigger DOM.
        name: "Scanner",
        agentType: null,
        task: "Investigate the issue",
        progressUpdates: ["Scanner online"],
        result: null,
        isStreaming: true,
        endState: null,
        stopped: false,
        startedAt: 1,
        durationMs: null,
        spawnToolCallId: null,
        children: [],
      },
    ],
  };
}

function makeCommandMessageWithCommand(
  messageId: string,
  activityId: string,
  command: string,
): ChatMessageModel {
  return {
    ...makeMessage(0, "assistant"),
    id: messageId,
    segments: [
      {
        id: `${activityId}:command`,
        kind: "command",
        command,
        cwd: null,
        exitCode: 0,
        isStreaming: false,
        endState: null,
        progress: null,
        startedAt: 0,
        parentId: null,
      },
    ],
  };
}

function makeFileChangeGroupMessage(
  messageId: string,
  groupId: string,
): ChatMessageModel {
  return {
    ...makeMessage(0, "assistant"),
    id: messageId,
    segments: [
      {
        id: groupId,
        kind: "file_change_group",
        files: [
          {
            id: `${groupId}:file`,
            kind: "file_change",
            filePath: "src/components/chat/find-anchor.ts",
            operation: "update",
            diffSource: "snapshot",
            beforeHash: "before",
            afterHash: "after",
            additions: 3,
            deletions: 1,
            sourceBlockIds: [`${groupId}:file`],
            reason: "snapshot",
            isStreaming: false,
            endState: null,
            parentId: null,
          },
        ],
        artifacts: [],
        checkpointManifest: null,
        hasLaterOverlappingChanges: false,
      },
    ],
  };
}

function makeAgentUserMessage(id: string, content: string): ChatMessageModel {
  return {
    ...makeMessage(0, "user"),
    id,
    content,
    persistentMessageId: id,
    senderLabel: "Review Agent",
    agentSenderInfo: {
      agentId: "agent-sender-1",
      senderTitle: "Review Agent",
      expectReply: true,
      responseId: "response-1",
    },
    agentMessage: {
      kind: "agent",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: content }],
          },
        ],
      },
      fromAgentId: "agent-sender-1",
      senderTitle: "Review Agent",
      senderHarnessId: "codex",
      reply: { expectsReply: true, responseId: "response-1" },
    },
  };
}

function testDomRect(input: {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}): DOMRect {
  return {
    x: input.left,
    y: input.top,
    width: input.width,
    height: input.height,
    top: input.top,
    right: input.left + input.width,
    bottom: input.top + input.height,
    left: input.left,
    toJSON: () => ({}),
  };
}

function installMockHighlights(): {
  readonly values: ReadonlyMap<string, TestHighlight>;
} {
  const globalWithHighlights: {
    readonly CSS?: typeof CSS;
    readonly Highlight?: typeof Highlight;
  } = globalThis;
  const previousCss = globalWithHighlights.CSS;
  const previousHighlight = globalWithHighlights.Highlight;
  const values = new Map<string, TestHighlight>();
  Object.defineProperty(globalThis, "Highlight", {
    configurable: true,
    writable: true,
    value: TestHighlight,
  });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: {
      highlights: {
        set: (name: string, highlight: TestHighlight) => {
          values.set(name, highlight);
        },
        delete: (name: string) => {
          values.delete(name);
        },
      },
    },
  });
  restoreHighlights = () => {
    if (previousCss === undefined) Reflect.deleteProperty(globalThis, "CSS");
    else {
      Object.defineProperty(globalThis, "CSS", {
        configurable: true,
        writable: true,
        value: previousCss,
      });
    }
    if (previousHighlight === undefined) {
      Reflect.deleteProperty(globalThis, "Highlight");
      return;
    }
    Object.defineProperty(globalThis, "Highlight", {
      configurable: true,
      writable: true,
      value: previousHighlight,
    });
  };
  return { values };
}
