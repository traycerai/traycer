import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  createRef,
  useEffect,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import type {
  ChatMessageActions,
  ChatMessageUserActions,
} from "@/components/chat/chat-message";
import { ChatTimeline } from "@/components/chat/chat-timeline";
import type { NextStepActionHandler } from "@/components/chat/segments/next-steps-action-group";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { makeMessage, makeMessages } from "./chat-message-fixtures";
import {
  installLegendListViewportMetrics,
  settleLegendList,
} from "./legend-list-test-environment";

const MESSAGE_ROW_SELECTOR = "[data-message-id]";
const LARGE_MESSAGE_COUNT = 400;

const renderCounts = new Map<string, number>();

vi.mock("@/components/chat/chat-message", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/chat/chat-message")>();

  function ChatMessageWithRenderProbe(
    props: Parameters<typeof actual.ChatMessage>[0],
  ): ReactElement {
    useEffect(() => {
      const id = props.message.id;
      renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    });
    return <actual.ChatMessage {...props} />;
  }

  return {
    ...actual,
    ChatMessage: ChatMessageWithRenderProbe,
  };
});

const VIEWPORT_HEIGHT_PX = 700;
const VIEWPORT_WIDTH_PX = 800;

function mountedMessageRows(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll(MESSAGE_ROW_SELECTOR);
}

function rowIds(container: HTMLElement): ReadonlyArray<string> {
  return Array.from(mountedMessageRows(container)).map(
    (row) => row.getAttribute("data-message-id") ?? "",
  );
}

function makeUserActions(): ChatMessageUserActions {
  return {
    type: "user",
    enabled: true,
    confirmingDelete: false,
    editing: null,
    onEdit: () => undefined,
    onDeleteRequest: () => undefined,
    onDeleteConfirm: () => undefined,
    onDeleteCancel: () => undefined,
  };
}

interface RenderTimelineOptions {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly taskTitle?: string;
  readonly backgroundToolBlockIds?: ReadonlySet<string>;
  readonly getMessageActions?: (
    message: ChatMessageModel,
  ) => ChatMessageActions | null;
  readonly nextStepActions?: NextStepActionHandler | null;
  readonly listRef?: RefObject<LegendListRef | null>;
  readonly className?: string;
  readonly "data-testid"?: string;
  readonly topFadeEnabled?: boolean;
  readonly followEnabled?: boolean;
}

function renderTimeline(options: RenderTimelineOptions) {
  const listRef = options.listRef ?? createRef<LegendListRef | null>();
  const getMessageActions =
    options.getMessageActions ?? ((_message: ChatMessageModel) => null);
  const nextStepActions = options.nextStepActions ?? null;
  const backgroundToolBlockIds =
    options.backgroundToolBlockIds ?? new Set<string>();

  const jsx = (messages: ReadonlyArray<ChatMessageModel>): ReactNode => (
    <div
      style={{
        height: VIEWPORT_HEIGHT_PX,
        width: VIEWPORT_WIDTH_PX,
      }}
    >
      <ChatTimeline
        messages={messages}
        taskTitle={options.taskTitle ?? "Test transcript"}
        backgroundToolBlockIds={backgroundToolBlockIds}
        getMessageActions={getMessageActions}
        nextStepActions={nextStepActions}
        listRef={listRef}
        className={options.className ?? "h-full"}
        data-testid={options["data-testid"]}
        topFadeEnabled={options.topFadeEnabled}
        followEnabled={options.followEnabled}
      />
    </div>
  );

  const result = render(jsx(options.messages));
  return {
    ...result,
    listRef,
    rerenderMessages: (messages: ReadonlyArray<ChatMessageModel>) => {
      result.rerender(jsx(messages));
    },
  };
}

describe("ChatTimeline", () => {
  beforeEach(() => {
    renderCounts.clear();
    installLegendListViewportMetrics();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("virtualizes a large transcript so mounted DOM rows stay bounded", async () => {
    const messages = makeMessages(LARGE_MESSAGE_COUNT);
    const { container } = renderTimeline({ messages });

    await settleLegendList();
    await waitFor(
      () => {
        expect(mountedMessageRows(container).length).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );

    const mountedCount = mountedMessageRows(container).length;
    // Viewport (~700px) + draw distance + pool still has to be far below a
    // 1:1 mount of 400 messages. A loose but meaningful bound:
    expect(mountedCount).toBeGreaterThan(0);
    expect(mountedCount).toBeLessThan(LARGE_MESSAGE_COUNT / 4);
    expect(mountedCount).toBeLessThan(80);

    // Keep the concrete numbers in the assertion message for the report.
    expect(
      mountedCount,
      `virtualization evidence: ${LARGE_MESSAGE_COUNT} messages -> ${mountedCount} mounted DOM rows`,
    ).toBeLessThan(LARGE_MESSAGE_COUNT);
  });

  it("keeps earlier row DOM nodes stable when only the streaming tail content changes", async () => {
    // Keep the set small enough that every row fits the mocked viewport so
    // virtualization does not recycle early nodes out of the DOM.
    const baseMessages: ChatMessageModel[] = [
      makeMessage(0, "user"),
      makeMessage(1, "assistant"),
      makeMessage(2, "user"),
      {
        ...makeMessage(3, "assistant"),
        content: "partial",
        runState: "running",
      },
    ];

    const { container, rerenderMessages } = renderTimeline({
      messages: baseMessages,
    });

    await settleLegendList();
    await waitFor(
      () => {
        expect(mountedMessageRows(container).length).toBe(baseMessages.length);
      },
      { timeout: 5_000 },
    );

    const earlyRowBefore = container.querySelector(
      '[data-message-id="message-0"]',
    );
    const midRowBefore = container.querySelector(
      '[data-message-id="message-1"]',
    );
    const userRowBefore = container.querySelector(
      '[data-message-id="message-2"]',
    );
    expect(earlyRowBefore).not.toBeNull();
    expect(midRowBefore).not.toBeNull();
    expect(userRowBefore).not.toBeNull();

    const earlyRenderCountBefore = renderCounts.get("message-0") ?? 0;
    const midRenderCountBefore = renderCounts.get("message-1") ?? 0;
    const userRenderCountBefore = renderCounts.get("message-2") ?? 0;
    const streamingRenderCountBefore = renderCounts.get("message-3") ?? 0;

    // Simulate a store rebuild: new array, new objects; only the streaming
    // message's content differs. Structural sharing + memo should keep
    // earlier rows from remounting / re-rendering.
    const nextMessages: ReadonlyArray<ChatMessageModel> = [
      { ...baseMessages[0] },
      { ...baseMessages[1] },
      { ...baseMessages[2] },
      {
        ...baseMessages[3],
        content: "partial reply token",
      },
    ];

    rerenderMessages(nextMessages);

    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });

    const earlyRowAfter = container.querySelector(
      '[data-message-id="message-0"]',
    );
    const midRowAfter = container.querySelector(
      '[data-message-id="message-1"]',
    );
    const userRowAfter = container.querySelector(
      '[data-message-id="message-2"]',
    );

    // Same DOM node instances → React did not tear down / remount them.
    expect(earlyRowAfter).toBe(earlyRowBefore);
    expect(midRowAfter).toBe(midRowBefore);
    expect(userRowAfter).toBe(userRowBefore);

    // Render-count probe: unrelated rows should not re-render.
    expect(renderCounts.get("message-0") ?? 0).toBe(earlyRenderCountBefore);
    expect(renderCounts.get("message-1") ?? 0).toBe(midRenderCountBefore);
    expect(renderCounts.get("message-2") ?? 0).toBe(userRenderCountBefore);
    // Streaming row may re-render once for the content update.
    expect(renderCounts.get("message-3") ?? 0).toBeGreaterThanOrEqual(
      streamingRenderCountBefore,
    );
  });

  it("renders ChatEmptyState for an empty message list and does not mount LegendList rows", () => {
    const { container } = renderTimeline({
      messages: [],
      "data-testid": "chat-timeline",
    });

    expect(screen.getByText("Start the conversation")).not.toBeNull();
    expect(screen.getByText("Send a message to get started.")).not.toBeNull();
    expect(mountedMessageRows(container).length).toBe(0);
    // data-testid is spread onto LegendList only when messages exist.
    expect(screen.queryByTestId("chat-timeline")).toBeNull();
  });

  it("sets data-message-id and role-specific contain-intrinsic-size classes on row wrappers", async () => {
    const messages: ReadonlyArray<ChatMessageModel> = [
      makeMessage(0, "user"),
      makeMessage(1, "assistant"),
    ];
    const { container } = renderTimeline({ messages });

    await settleLegendList();
    await waitFor(
      () => {
        expect(rowIds(container)).toEqual(
          expect.arrayContaining(["message-0", "message-1"]),
        );
      },
      { timeout: 5_000 },
    );

    const userRow = container.querySelector('[data-message-id="message-0"]');
    const assistantRow = container.querySelector(
      '[data-message-id="message-1"]',
    );
    expect(userRow).not.toBeNull();
    expect(assistantRow).not.toBeNull();

    const userClass = userRow?.getAttribute("class") ?? "";
    const assistantClass = assistantRow?.getAttribute("class") ?? "";

    expect(userClass).toContain("[contain:layout_paint_style]");
    expect(assistantClass).toContain("[contain:layout_paint_style]");
    expect(userClass).toContain("[contain-intrinsic-size:auto_8rem]");
    expect(assistantClass).toContain("[contain-intrinsic-size:auto_14rem]");
    expect(userClass).not.toContain("[contain-intrinsic-size:auto_14rem]");
    expect(assistantClass).not.toContain("[contain-intrinsic-size:auto_8rem]");
  });

  it("forwards getMessageActions, backgroundToolBlockIds, and nextStepActions into ChatMessage", async () => {
    const user = makeMessage(0, "user");
    const assistant = makeMessage(1, "assistant");
    const userActions = makeUserActions();
    const getMessageActions = vi.fn(
      (message: ChatMessageModel): ChatMessageActions | null => {
        if (message.role === "user") return userActions;
        return null;
      },
    );
    const nextStepActions: NextStepActionHandler = {
      canSend: true,
      onSend: () => true,
    };
    const backgroundToolBlockIds = new Set(["tool-block-1"]);

    const { container } = renderTimeline({
      messages: [user, assistant],
      getMessageActions,
      nextStepActions,
      backgroundToolBlockIds,
    });

    await settleLegendList();
    await waitFor(
      () => {
        expect(mountedMessageRows(container).length).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );

    expect(getMessageActions).toHaveBeenCalled();
    const calledWithIds = getMessageActions.mock.calls.map(
      (call) => call[0].id,
    );
    expect(calledWithIds).toEqual(
      expect.arrayContaining(["message-0", "message-1"]),
    );

    // Action bar only mounts when getMessageActions returned user actions.
    expect(screen.getByLabelText("Edit message")).not.toBeNull();
  });
});
