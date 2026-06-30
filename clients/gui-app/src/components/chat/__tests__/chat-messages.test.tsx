import "../../../../__tests__/test-browser-apis";

import {
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
import {
  ChatMessages,
  type ChatMessageScrollRequest,
} from "@/components/chat/chat-messages";
import { ChatUserMessageMinimap } from "@/components/chat/chat-user-message-minimap";
import {
  chatMinimapClipRegionProps,
  type ChatUserMinimapItem,
} from "@/components/chat/chat-user-message-minimap-items";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
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
let scrollStateKeySequence = 0;

function minimapItemsFor(
  messages: ReadonlyArray<ChatMessageModel>,
): ReadonlyArray<ChatUserMinimapItem> {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => ({
      id: message.id,
      content: message.content,
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
        messages={messages}
        backgroundItems={opts.backgroundItems}
        minimapItems={opts.minimapItems}
        scrollStateKey={opts.scrollStateKey}
        getMessageActions={() => null}
        nextStepActions={null}
        instanceId="test-instance"
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

describe("ChatMessages Virtuoso renderer", () => {
  afterEach(() => {
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

function getButtonContainingText(text: string): HTMLButtonElement {
  const button = screen.getByText(text).closest("button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${text} to be inside a button`);
  }
  return button;
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
