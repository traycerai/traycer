import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageGenerationResult } from "@traycer/protocol/persistence/epic/content-blocks";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import { subagentCardPath } from "@/components/chat/segments/subagent-display";
import {
  buildSubagentChatFindRows,
  chatFindSubagentChatResultUnitId,
  chatFindSubagentChatTaskUnitId,
} from "@/components/chat/chat-find";
import { ChatFindHighlighter } from "@/components/chat/chat-find-highlighter";
import { findTextMatches } from "@/lib/find-engine/find-text";
import {
  OpenSubagentAsChatContext,
  type SubagentDrillIn,
} from "@/components/chat/segments/subagent-open-as-chat";
import { SubagentContinueAsChatContext } from "@/components/chat/segments/subagent-continue-as-chat";
import { SubagentChatView } from "@/components/chat/subagent-chat-view";
import type {
  ChatMessage as ChatMessageModel,
  SubagentChildSegment,
  SubagentSegment,
} from "@/stores/composer/chat-store";

const blobStates = vi.hoisted(() => ({
  byHash: {} as Record<
    string,
    {
      status: "loading" | "ready" | "unavailable";
      src: string | null;
      mediaType: string;
    }
  >,
}));

vi.mock(
  "@/lib/attachments/use-attachment-blob-src",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/attachments/use-attachment-blob-src")
    >()),
    useChatAttachmentBlobSrc: (hash: string) =>
      blobStates.byHash[hash] ?? {
        status: "ready",
        src: "blob:http://localhost/a",
        mediaType: "image/png",
      },
  }),
);

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
    toolImageResults: [],
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

function transcriptWithControls(ids: ReadonlyArray<string>): HTMLElement {
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

  it("draws Continue as chat in the breadcrumb when the action is offered", () => {
    const run = vi.fn();
    render(
      <SubagentContinueAsChatContext.Provider value={{ run, isPending: false }}>
        <ChatExpansionTestProviders tileInstanceId="subagent-chat-view-tile">
          <SubagentChatView
            drillIn={{ openId: "root", open: vi.fn(), close: vi.fn() }}
            messages={messagesWithNestedCards()}
            bottomInset={0}
            scrollRef={createRef<HTMLDivElement>()}
            transcriptRef={createRef<HTMLElement>()}
          />
        </ChatExpansionTestProviders>
      </SubagentContinueAsChatContext.Provider>,
    );

    const button = screen.getByTestId("subagent-chat-continue");
    expect(button.closest("nav")).toBe(
      screen.getByTestId("subagent-chat-back").closest("nav"),
    );
    fireEvent.click(button);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("shows the task, the result and Continue for a card with no children", () => {
    const run = vi.fn();
    const replyOnly: SubagentSegment = {
      ...card("reply", "reply-agent", []),
      result: "the agent replied only",
    };
    render(
      <SubagentContinueAsChatContext.Provider value={{ run, isPending: false }}>
        <ChatExpansionTestProviders tileInstanceId="subagent-chat-view-tile">
          <SubagentChatView
            drillIn={{ openId: "reply", open: vi.fn(), close: vi.fn() }}
            messages={[
              { ...makeMessage(1, "assistant"), segments: [replyOnly] },
            ]}
            bottomInset={0}
            scrollRef={createRef<HTMLDivElement>()}
            transcriptRef={createRef<HTMLElement>()}
          />
        </ChatExpansionTestProviders>
      </SubagentContinueAsChatContext.Provider>,
    );

    expect(screen.getByText("reply-agent task")).toBeTruthy();
    expect(screen.getByText("the agent replied only")).toBeTruthy();
    fireEvent.click(screen.getByTestId("subagent-chat-continue"));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("draws no Continue as chat without the action", () => {
    renderView("root", { openId: "root", open: vi.fn(), close: vi.fn() });

    expect(screen.queryByTestId("subagent-chat-continue")).toBeNull();
    expect(screen.getByTestId("subagent-chat-back")).toBeTruthy();
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
      fireEvent.keyDown(screen.getByRole("heading", { name: "leaf-agent" }), {
        key: "Escape",
      });
      expect(fixture.handlers.open).toHaveBeenCalledWith("root");
      expect(fixture.handlers.close).not.toHaveBeenCalled();
      first.unmount();

      const second = makeFixture(null);
      render(viewElement("root", second));
      fireEvent.keyDown(screen.getByRole("heading", { name: "root-agent" }), {
        key: "Escape",
      });
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
        fireEvent.keyDown(screen.getByRole("heading", { name: "root-agent" }), {
          key: "Escape",
        });
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
            segments: [
              { ...card("root", "root-agent", []), result: "Final answer" },
            ],
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

const TILE_INSTANCE_ID = "subagent-chat-view-tile";

function toolImage(
  alt: string | null,
  attachmentHash: string,
): ImageGenerationResult {
  return {
    attachmentHash,
    mediaType: "image/png",
    byteLength: 256,
    width: null,
    height: null,
    alt,
    revisedPrompt: null,
    filePath: null,
  };
}

function withImages(
  base: SubagentSegment,
  toolImageResults: ReadonlyArray<ImageGenerationResult>,
): SubagentSegment {
  return { ...base, toolImageResults };
}

function renderImageView(
  openId: string,
  messages: ReadonlyArray<ChatMessageModel>,
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ChatExpansionTestProviders tileInstanceId={TILE_INSTANCE_ID}>
        <SubagentChatView
          drillIn={{ openId, open: vi.fn(), close: vi.fn() }}
          messages={messages}
          bottomInset={0}
          scrollRef={createRef<HTMLDivElement>()}
          transcriptRef={createRef<HTMLElement>()}
        />
      </ChatExpansionTestProviders>
    </QueryClientProvider>,
  );
}

function captionsIn(root: ParentNode): ReadonlyArray<string> {
  return Array.from(root.querySelectorAll("figcaption")).map(
    (node) => node.textContent,
  );
}

function rowsFor(openCard: SubagentSegment) {
  return buildSubagentChatFindRows(openCard, TILE_INSTANCE_ID)[0].units;
}

const NO_CONVERSATION = "No conversation recorded for this subagent.";

describe("<SubagentChatView /> on a parent tool that returned images", () => {
  beforeEach(() => {
    blobStates.byHash = {};
  });

  let highlighter: ChatFindHighlighter | null = null;

  afterEach(() => {
    highlighter?.dispose();
    highlighter = null;
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the ordered captioned images with the task and the result", () => {
    const parent = withImages(
      { ...card("skill", "Skill", []), result: "Skill finished" },
      [toolImage("first plot", "hash-a"), toolImage(null, "hash-a")],
    );
    const view = renderImageView("skill", [
      { ...makeMessage(1, "assistant"), segments: [parent] },
    ]);

    expect(captionsIn(view.container)).toEqual(["first plot", "Image 2"]);
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getByText("Skill task")).toBeTruthy();
    expect(screen.getByText("Skill finished")).toBeTruthy();
  });

  it("projects the caption unit that the mounted view anchors, owned by no collapsible", () => {
    const parent = withImages(card("skill", "Skill", []), [
      toolImage("first plot", "hash-a"),
      toolImage(null, "hash-a"),
    ]);
    const view = renderImageView("skill", [
      { ...makeMessage(1, "assistant"), segments: [parent] },
    ]);

    const unit = rowsFor(parent).find(
      (candidate) =>
        candidate.text.includes("first plot") &&
        candidate.text.includes("Image 2"),
    );
    if (unit === undefined) throw new Error("Expected a caption unit");
    expect(unit.owningChain).toEqual([]);
    const anchors = view.container.querySelectorAll(
      `[data-chat-find-unit="${unit.unitId}"]`,
    );
    expect(anchors).toHaveLength(1);
    expect(captionsIn(anchors[0])).toEqual(["first plot", "Image 2"]);
  });

  it("paints Find ranges on the captions only, never on a loading, missing or undecoded image", () => {
    const painted = new Map<string, { readonly ranges: readonly Range[] }>();
    vi.stubGlobal("CSS", {
      highlights: {
        set: (name: string, highlight: { readonly ranges: readonly Range[] }) =>
          painted.set(name, highlight),
        delete: (name: string) => painted.delete(name),
      },
    });
    vi.stubGlobal(
      "Highlight",
      class {
        readonly ranges: readonly Range[];
        constructor(...ranges: readonly Range[]) {
          this.ranges = ranges;
        }
      },
    );
    blobStates.byHash = {
      "hash-waiting": { status: "loading", src: null, mediaType: "image/png" },
      "hash-gone": { status: "unavailable", src: null, mediaType: "image/png" },
    };
    const parent = withImages(card("skill", "Skill", []), [
      toolImage(null, "hash-ready"),
      toolImage(null, "hash-waiting"),
      toolImage(null, "hash-gone"),
      toolImage(null, "hash-ready"),
    ]);
    const view = renderImageView("skill", [
      { ...makeMessage(1, "assistant"), segments: [parent] },
    ]);
    const unit = rowsFor(parent).find((candidate) =>
      candidate.text.includes("Image 4"),
    );
    if (unit === undefined) throw new Error("Expected a caption unit");
    const expected = findTextMatches(unit.text, "image", false).length;

    highlighter = new ChatFindHighlighter();
    expect(
      highlighter.paint({
        root: view.container,
        query: "image",
        matchCase: false,
        activeMatchIndex: 2,
        scrollActiveIntoView: false,
      }),
    ).toBe(true);

    const ranges = [...painted.entries()]
      .filter(([name]) => name.startsWith("traycer-find-"))
      .flatMap(([, highlight]) => [...highlight.ranges]);
    expect(ranges).toHaveLength(expected);
    for (const range of ranges) {
      expect(
        range.startContainer.parentElement?.closest("figcaption"),
      ).not.toBeNull();
    }
  });

  it("drops the empty-conversation placeholder for an image-only card and keeps it for an empty one", () => {
    const imageOnly = withImages(card("skill", "Skill", []), [
      toolImage("first plot", "hash-a"),
    ]);
    const empty = card("blank", "blank-agent", []);
    const messages = [
      { ...makeMessage(1, "assistant"), segments: [imageOnly, empty] },
    ];

    renderImageView("skill", messages);
    expect(screen.queryByText(NO_CONVERSATION)).toBeNull();
    expect(screen.getByText("Skill task")).toBeTruthy();
    cleanup();

    renderImageView("blank", messages);
    expect(screen.getByText(NO_CONVERSATION)).toBeTruthy();
  });
});
