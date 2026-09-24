import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import { subagentCardPath } from "@/components/chat/segments/subagent-display";
import {
  chatFindSubagentChatResultUnitId,
  chatFindSubagentChatTaskUnitId,
} from "@/components/chat/chat-find";
import {
  OpenSubagentAsChatContext,
  type SubagentDrillIn,
} from "@/components/chat/segments/subagent-open-as-chat";
import { SubagentChatView } from "@/components/chat/subagent-chat-view";
import type {
  ChatMessage as ChatMessageModel,
  SubagentChildSegment,
  SubagentSegment,
} from "@/stores/composer/chat-store";

function card(
  id: string,
  name: string,
  children: ReadonlyArray<SubagentChildSegment>,
): SubagentSegment {
  return {
    id,
    kind: "subagent",
    name,
    agentType: null,
    task: `${name} task`,
    progressUpdates: [],
    result: null,
    isStreaming: false,
    endState: null,
    stopped: false,
    startedAt: null,
    durationMs: null,
    spawnToolCallId: null,
    parentId: null,
    workflowMeta: null,
    children,
  };
}

function messagesWithNestedCards(): ReadonlyArray<ChatMessageModel> {
  const leaf = card("leaf", "leaf-agent", [
    {
      id: "leaf-text",
      kind: "text",
      markdown: "leaf words",
      isStreaming: false,
      parentId: "leaf",
    },
  ]);
  const root = card("root", "root-agent", [
    {
      id: "root-text",
      kind: "text",
      markdown: "root words",
      isStreaming: false,
      parentId: "root",
    },
    leaf,
  ]);
  return [{ ...makeMessage(1, "assistant"), segments: [root] }];
}

function renderView(openId: string | null, handlers: SubagentDrillIn) {
  return render(
    <ChatExpansionTestProviders tileInstanceId="subagent-chat-view-tile">
      <SubagentChatView
        drillIn={{ ...handlers, openId }}
        messages={messagesWithNestedCards()}
        bottomInset={0}
        scrollRef={createRef<HTMLDivElement>()}
        transcriptRef={createRef<HTMLElement>()}
      />
    </ChatExpansionTestProviders>,
  );
}

interface ViewFixture {
  readonly handlers: SubagentDrillIn;
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly transcriptRef: RefObject<HTMLElement | null>;
}

function viewElement(openId: string | null, fixture: ViewFixture) {
  return (
    <ChatExpansionTestProviders tileInstanceId="subagent-chat-view-tile">
      <OpenSubagentAsChatContext.Provider value={fixture.handlers.open}>
        <SubagentChatView
          drillIn={{ ...fixture.handlers, openId }}
          messages={fixture.messages}
          bottomInset={0}
          scrollRef={fixture.scrollRef}
          transcriptRef={fixture.transcriptRef}
        />
      </OpenSubagentAsChatContext.Provider>
    </ChatExpansionTestProviders>
  );
}

function makeFixture(transcript: HTMLElement | null): ViewFixture {
  return {
    handlers: { openId: null, open: vi.fn(), close: vi.fn() },
    messages: messagesWithNestedCards(),
    scrollRef: createRef<HTMLDivElement>(),
    transcriptRef: { current: transcript },
  };
}

function transcriptWithControls(
  ids: ReadonlyArray<string>,
): HTMLElement {
  const container = document.createElement("div");
  for (const id of ids) {
    const button = document.createElement("button");
    button.dataset.subagentOpenAsChat = id;
    container.appendChild(button);
  }
  document.body.appendChild(container);
  return container;
}

function controlIn(root: HTMLElement, id: string): HTMLElement {
  const found = Array.from(
    root.querySelectorAll<HTMLElement>("[data-subagent-open-as-chat]"),
  ).find((element) => element.dataset.subagentOpenAsChat === id);
  if (found === undefined) throw new Error(`no control for ${id}`);
  return found;
}

describe("subagentCardPath", () => {
  it("returns the ancestor chain for a nested card and null for an unknown id", () => {
    const messages = messagesWithNestedCards();
    expect(subagentCardPath(messages, "leaf")?.map((c) => c.id)).toEqual([
      "root",
      "leaf",
    ]);
    expect(subagentCardPath(messages, "root")?.map((c) => c.id)).toEqual([
      "root",
    ]);
    expect(subagentCardPath(messages, "missing")).toBeNull();
  });
});

describe("<SubagentChatView />", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the breadcrumb, the task and the conversation for an open card", () => {
    const open = vi.fn();
    const close = vi.fn();
    renderView("root", { openId: "root", open, close });

    expect(screen.getByTestId("subagent-chat-back")).toBeTruthy();
    expect(screen.getAllByText("root-agent").length).toBeGreaterThan(0);
    expect(screen.getByText("root-agent task")).toBeTruthy();
    expect(screen.getByText("root words")).toBeTruthy();
  });

  it("calls close from the back button", () => {
    const open = vi.fn();
    const close = vi.fn();
    renderView("root", { openId: "root", open, close });

    fireEvent.click(screen.getByTestId("subagent-chat-back"));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("opens the ancestor when its crumb is clicked", () => {
    const open = vi.fn();
    const close = vi.fn();
    renderView("leaf", { openId: "leaf", open, close });

    expect(screen.getByText("leaf words")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "root-agent" }));
    expect(open).toHaveBeenCalledWith("root");
  });

  it("says the subagent left the loaded transcript for an unknown id", () => {
    const open = vi.fn();
    const close = vi.fn();
    renderView("missing", { openId: "missing", open, close });

    expect(
      screen.getByText("This subagent is no longer in the loaded transcript."),
    ).toBeTruthy();
  });

  describe("Escape", () => {
    it("steps back to the parent from a nested card and closes at the top", () => {
      const fixture = makeFixture(null);
      const first = render(viewElement("leaf", fixture));
      fireEvent.keyDown(
        screen.getByRole("heading", { name: "leaf-agent" }),
        { key: "Escape" },
      );
      expect(fixture.handlers.open).toHaveBeenCalledWith("root");
      expect(fixture.handlers.close).not.toHaveBeenCalled();
      first.unmount();

      const second = makeFixture(null);
      render(viewElement("root", second));
      fireEvent.keyDown(
        screen.getByRole("heading", { name: "root-agent" }),
        { key: "Escape" },
      );
      expect(second.handlers.close).toHaveBeenCalledTimes(1);
      expect(second.handlers.open).not.toHaveBeenCalled();
    });

    it("ignores an Escape a document capture layer already handled", () => {
      const fixture = makeFixture(null);
      render(viewElement("root", fixture));
      const onCapture = (event: globalThis.KeyboardEvent): void => {
        event.preventDefault();
      };
      document.addEventListener("keydown", onCapture, true);
      try {
        fireEvent.keyDown(
          screen.getByRole("heading", { name: "root-agent" }),
          { key: "Escape" },
        );
      } finally {
        document.removeEventListener("keydown", onCapture, true);
      }
      expect(fixture.handlers.open).not.toHaveBeenCalled();
      expect(fixture.handlers.close).not.toHaveBeenCalled();
    });

    it("ignores an Escape from outside the view", () => {
      const fixture = makeFixture(null);
      render(
        <>
          <button type="button">outside</button>
          {viewElement("root", fixture)}
        </>,
      );
      fireEvent.keyDown(screen.getByRole("button", { name: "outside" }), {
        key: "Escape",
      });
      expect(fixture.handlers.open).not.toHaveBeenCalled();
      expect(fixture.handlers.close).not.toHaveBeenCalled();
    });
  });

  describe("focus", () => {
    it("focuses the card heading on opening", () => {
      const fixture = makeFixture(null);
      render(viewElement("root", fixture));
      const heading = screen.getByRole("heading", { name: "root-agent" });
      expect(heading.tagName).toBe("H2");
      expect(document.activeElement).toBe(heading);
    });

    it("returns focus to the entry control on close, else the top card's", () => {
      const transcript = transcriptWithControls(["root", "leaf"]);
      const fixture = makeFixture(transcript);
      const view = render(viewElement("leaf", fixture));
      view.rerender(viewElement("root", fixture));
      const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
      try {
        view.rerender(viewElement(null, fixture));
        expect(focusSpy).toHaveBeenCalledTimes(1);
        expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true });
      } finally {
        focusSpy.mockRestore();
      }
      expect(document.activeElement).toBe(controlIn(transcript, "leaf"));
      view.unmount();
      transcript.remove();

      const partial = transcriptWithControls(["root"]);
      const second = makeFixture(partial);
      const again = render(viewElement("leaf", second));
      again.rerender(viewElement("root", second));
      again.rerender(viewElement(null, second));
      expect(document.activeElement).toBe(controlIn(partial, "root"));
      partial.remove();
    });

    it("focuses the left card's control inside the view when stepping back", () => {
      const fixture = makeFixture(null);
      const view = render(viewElement("leaf", fixture));
      view.rerender(viewElement("root", fixture));
      const section = screen.getByTestId("subagent-chat-view");
      const active = document.activeElement;
      expect(active).not.toBeNull();
      expect(section.contains(active)).toBe(true);
      expect(active instanceof HTMLElement).toBe(true);
      expect(
        active instanceof HTMLElement
          ? active.dataset.subagentOpenAsChat
          : null,
      ).toBe("leaf");
    });
  });

  describe("find anchors", () => {
    it("puts the task unit on the task bubble and marks the scroll area", () => {
      const fixture = makeFixture(null);
      render(viewElement("root", fixture));
      const task = screen.getByText("root-agent task");
      expect(task.getAttribute("data-chat-find-unit")).toBe(
        chatFindSubagentChatTaskUnitId("root"),
      );
      const scroll = fixture.scrollRef.current;
      expect(scroll).not.toBeNull();
      expect(scroll?.hasAttribute("data-selection-root")).toBe(true);
    });

    it("wraps a shown Result panel in the result unit", () => {
      const fixture: ViewFixture = {
        ...makeFixture(null),
        messages: [
          {
            ...makeMessage(1, "assistant"),
            segments: [{ ...card("root", "root-agent", []), result: "Final answer" }],
          },
        ],
      };
      render(viewElement("root", fixture));
      const wrapper = screen
        .getByTestId("subagent-chat-view")
        .querySelector(
          `[data-chat-find-unit="${chatFindSubagentChatResultUnitId("root")}"]`,
        );
      expect(wrapper).not.toBeNull();
      expect(wrapper?.textContent).toContain("Final answer");
    });
  });
});
