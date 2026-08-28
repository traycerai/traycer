import type { LegendListRef } from "@legendapp/list/react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTurnMinimap } from "@/components/chat/chat-turn-minimap";
import { shouldMountChatTurnMinimap } from "@/components/chat/chat-turn-minimap-logic";
import { TileMinimapScope } from "@/components/epic-canvas/tile-minimap/tile-minimap-scope";
import {
  useTileMinimapStore,
  type TileMinimapAdapter,
} from "@/stores/tile-minimap";
import { transcriptListRows } from "@/stores/chats/transcript-list-rows";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  DEFAULT_UI_FONT_SIZE,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import { makeMessage } from "./chat-message-fixtures";

function user(index: number, content: string): ChatMessageModel {
  return { ...makeMessage(index, "user"), content };
}

function assistant(index: number, content: string): ChatMessageModel {
  return { ...makeMessage(index, "assistant"), content };
}

function makeTranscript(turnCount: number): ChatMessageModel[] {
  return Array.from({ length: turnCount }, (_unused, index) => [
    user(index * 2, `Question ${index}`),
    assistant(index * 2 + 1, `Reply ${index}`),
  ]).flat();
}

function makeListRef(input: {
  readonly scroll: number;
  readonly scrollLength: number;
}): RefObject<LegendListRef | null> {
  const list: Pick<LegendListRef, "getState"> = {
    getState: () =>
      ({
        scroll: input.scroll,
        scrollLength: input.scrollLength,
        positionAtIndex: (index: number) => index * 100,
        sizeAtIndex: () => 100,
      }) as never,
  };
  return { current: list as LegendListRef };
}

async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

function renderMinimap(
  input:
    | {
        readonly messages?: ReadonlyArray<ChatMessageModel>;
        readonly scroll?: number;
        readonly viewportHeight?: number;
        readonly viewportWidth?: number;
        readonly side?: "left" | "right";
      }
    | undefined,
) {
  const options = input ?? {};
  const messages = options.messages ?? makeTranscript(12);
  const viewport = document.createElement("div");
  const width = options.viewportWidth ?? 1200;
  const height = options.viewportHeight ?? 600;
  viewport.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  });
  document.body.append(viewport);
  const refreshRef: RefObject<() => void> = { current: () => undefined };
  const onSelect = vi.fn<(messageId: string) => void>();
  render(
    <ChatTurnMinimap
      bottomInset={0}
      inViewRefreshRef={refreshRef}
      listRef={makeListRef({
        scroll: options.scroll ?? 1050,
        scrollLength: 160,
      })}
      rows={transcriptListRows({ window: null, rendered: messages })}
      transcriptWindow={null}
      onSelect={onSelect}
      side={options.side ?? "right"}
      topOffsetAdjustmentRef={{ current: 0 }}
      viewportRef={{ current: viewport }}
    />,
  );
  return { onSelect, refreshRef };
}

function renderRegisteredMinimap(input: {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly side: "hide" | "left" | "right";
}) {
  const viewport = document.createElement("div");
  const measureRect = vi.fn(
    () => ({ width: 1200, height: 600, top: 0, left: 0 }) as DOMRect,
  );
  viewport.getBoundingClientRect = measureRect;
  document.body.append(viewport);
  const onSelect = vi.fn<(messageId: string) => void>();
  const tree = (messages: ReadonlyArray<ChatMessageModel>) => (
    <TileMinimapScope tileInstanceId="tile-1">
      <ChatTurnMinimap
        bottomInset={0}
        inViewRefreshRef={{ current: () => undefined }}
        listRef={makeListRef({ scroll: 0, scrollLength: 160 })}
        rows={transcriptListRows({ window: null, rendered: messages })}
        transcriptWindow={null}
        onSelect={onSelect}
        side={input.side}
        topOffsetAdjustmentRef={{ current: 0 }}
        viewportRef={{ current: viewport }}
      />
    </TileMinimapScope>
  );
  const view = render(tree(input.messages));
  return {
    measureRect,
    onSelect,
    rerender: (messages: ReadonlyArray<ChatMessageModel>): void => {
      act(() => {
        view.rerender(tree(messages));
      });
    },
  };
}

function registeredAdapter(): TileMinimapAdapter {
  const adapter =
    useTileMinimapStore.getState().targetsByTileInstanceId["tile-1"]?.adapter;
  if (adapter === undefined) throw new Error("no minimap adapter registered");
  return adapter;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  useSettingsStore.setState({ uiFontSize: DEFAULT_UI_FONT_SIZE });
  useTileMinimapStore.setState({ targetsByTileInstanceId: {} });
});

describe("ChatTurnMinimap", () => {
  it("shows one item for a new chat with only a user message", async () => {
    renderMinimap({ messages: [user(0, "New chat")], scroll: 0 });
    await flushFrame();

    expect(screen.getAllByTestId("chat-turn-minimap-tick")).toHaveLength(1);
  });

  it("uses up to half the tile height around the current query", async () => {
    renderMinimap({ messages: makeTranscript(50), scroll: 5000 });
    await flushFrame();

    expect(screen.getAllByTestId("chat-turn-minimap-tick")).toHaveLength(35);
    expect(
      screen
        .getAllByTestId("chat-turn-minimap-tick")[0]
        .hasAttribute("data-minimap-rail-tick"),
    ).toBe(true);
    expect(
      screen.getByTestId("chat-turn-minimap-hit-strip").className,
    ).toContain("mask-image");
    expect(
      screen
        .getAllByTestId("chat-turn-minimap-tick")
        .filter((tick) =>
          tick.matches('[data-active="true"][data-message-id="message-50"]'),
        ),
    ).toHaveLength(1);
  });

  it("shows fewer bars when the tile height shrinks", async () => {
    renderMinimap({
      messages: makeTranscript(50),
      scroll: 5000,
      viewportHeight: 400,
    });
    await flushFrame();

    expect(screen.getAllByTestId("chat-turn-minimap-tick")).toHaveLength(23);
  });

  it("opens the full list at the current user query with one active row", async () => {
    renderMinimap(undefined);
    await flushFrame();
    fireEvent.mouseEnter(
      screen.getByRole("group", { name: "Message minimap controls" }),
    );

    const card = screen.getByTestId("chat-turn-minimap-card");
    expect(screen.getAllByTestId("chat-turn-minimap-tick")).toHaveLength(12);
    expect(card.querySelectorAll("[data-minimap-list-row]")).toHaveLength(12);
    expect(
      card.querySelector<HTMLElement>("[data-minimap-list-card]")?.className,
    ).toContain("motion-safe:animate-in");
    const active = card.querySelectorAll('[aria-current="location"]');
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain("Question 5");
  });

  it("keeps the viewport query current when the pointer crosses the list", async () => {
    renderMinimap(undefined);
    await flushFrame();
    fireEvent.mouseEnter(
      screen.getByRole("group", { name: "Message minimap controls" }),
    );
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Question 9" }));

    const active = screen
      .getByTestId("chat-turn-minimap-card")
      .querySelectorAll('[aria-current="location"]');
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain("Question 5");
  });

  it("uses the same arrow then Enter behavior and keeps the list open", async () => {
    const { onSelect } = renderMinimap(undefined);
    await flushFrame();
    const hitStrip = screen.getByRole("button", { name: "Message minimap" });
    fireEvent.focus(hitStrip);
    fireEvent.keyDown(hitStrip, { key: "ArrowDown" });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(hitStrip, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("message-12");
    expect(screen.getByTestId("chat-turn-minimap-card")).toBeTruthy();
    expect(
      screen
        .getByTestId("chat-turn-minimap-card")
        .querySelectorAll('[aria-current="location"]')[0].textContent,
    ).toContain("Question 5");
  });

  it("does not close after selecting a destination", async () => {
    const { onSelect } = renderMinimap(undefined);
    await flushFrame();
    fireEvent.mouseEnter(
      screen.getByRole("group", { name: "Message minimap controls" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Question 8" }));

    expect(onSelect).toHaveBeenCalledWith("message-16");
    expect(screen.getByTestId("chat-turn-minimap-card")).toBeTruthy();
  });

  it("closes from a focused row with Escape", async () => {
    renderMinimap(undefined);
    await flushFrame();
    fireEvent.mouseEnter(
      screen.getByRole("group", { name: "Message minimap controls" }),
    );
    const currentRow = screen.getByRole("button", { name: "Question 5" });
    fireEvent.focus(currentRow);
    fireEvent.keyDown(currentRow, { key: "Escape" });

    expect(screen.queryByTestId("chat-turn-minimap-card")).toBeNull();
  });

  it("keeps a compact equal-width rail in a tiled pane", async () => {
    renderMinimap({ viewportWidth: 720 });
    await flushFrame();
    await waitFor(() => {
      expect(screen.getByTestId("chat-turn-minimap")).toBeTruthy();
    });
    const widths = screen
      .getAllByTestId("chat-turn-minimap-tick")
      .map((tick) => tick.style.width);
    expect(new Set(widths).size).toBe(1);
  });

  it("ignores agent-to-agent user rows as turn boundaries", async () => {
    const a2a = {
      ...user(2, "Agent traffic"),
      agentSenderInfo: {
        agentId: "agent-2",
        senderTitle: "Agent 2",
        expectReply: false,
        responseId: null,
      },
    };
    renderMinimap({
      messages: [
        user(0, "First question"),
        assistant(1, "Reply"),
        a2a,
        assistant(3, "More reply"),
        user(4, "Second question"),
      ],
      scroll: 0,
    });
    await flushFrame();
    fireEvent.mouseEnter(
      screen.getByRole("group", { name: "Message minimap controls" }),
    );

    const rows = screen
      .getByTestId("chat-turn-minimap-card")
      .querySelectorAll("[data-minimap-list-row]");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("First question");
    expect(rows[1].textContent).toContain("Second question");
  });
});

describe("ChatTurnMinimap publication under a hidden rail", () => {
  it("still registers a navigable outline the phone tile bar can open", async () => {
    const viewport = document.createElement("div");
    viewport.getBoundingClientRect = () =>
      ({ width: 400, height: 600, top: 0, left: 0 }) as DOMRect;
    document.body.append(viewport);
    const onSelect = vi.fn<(messageId: string) => void>();
    render(
      <TileMinimapScope tileInstanceId="tile-1">
        <ChatTurnMinimap
          bottomInset={0}
          inViewRefreshRef={{ current: () => undefined }}
          listRef={makeListRef({ scroll: 0, scrollLength: 160 })}
          rows={transcriptListRows({
            window: null,
            rendered: makeTranscript(3),
          })}
          transcriptWindow={null}
          onSelect={onSelect}
          side="hide"
          topOffsetAdjustmentRef={{ current: 0 }}
          viewportRef={{ current: viewport }}
        />
      </TileMinimapScope>,
    );
    await flushFrame();

    // The rail itself obeys `hide`.
    expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();

    const adapter =
      useTileMinimapStore.getState().targetsByTileInstanceId["tile-1"]?.adapter;
    expect(adapter?.title).toBe("Messages");
    const items = adapter?.getSnapshot().items ?? [];
    expect(items.map((item) => item.label)).toEqual([
      "Question 0",
      "Question 1",
      "Question 2",
    ]);

    adapter?.select(1);
    expect(onSelect).toHaveBeenCalledWith("message-2");
  });

  it("stays quiet while a reply streams into the same turns", async () => {
    const question = user(0, "Question 0");
    const { rerender } = renderRegisteredMinimap({
      messages: [question, assistant(1, "Rep")],
      side: "right",
    });
    await flushFrame();
    const adapter = registeredAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    const published = adapter.getSnapshot().items;

    for (const token of ["Reply", "Reply so", "Reply so far"]) {
      rerender([question, assistant(1, token)]);
    }

    // A token gives the transcript a new array and the same outline. The bar
    // is subscribed while closed, so a notify here would re-render it - and
    // whatever it reads - once per token.
    expect(listener).not.toHaveBeenCalled();
    expect(adapter.getSnapshot().items).toBe(published);
    unsubscribe();
  });

  it("notifies once when a new human turn lands", async () => {
    const messages = [user(0, "Question 0"), assistant(1, "Reply 0")];
    const { rerender } = renderRegisteredMinimap({
      messages,
      side: "right",
    });
    await flushFrame();
    const adapter = registeredAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);

    rerender([...messages, user(2, "Question 1")]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(adapter.getSnapshot().items.map((item) => item.label)).toEqual([
      "Question 0",
      "Question 1",
    ]);
    unsubscribe();
  });

  it("publishes on a phone without measuring the rail's geometry", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
      writable: true,
    });
    try {
      const { measureRect } = renderRegisteredMinimap({
        messages: makeTranscript(3),
        // The default placement: the rail is a viewport and pointer question,
        // not a settings one.
        side: "right",
      });
      await flushFrame();

      expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
      // The forced layout that lands mid-measure for the transcript's rows.
      expect(measureRect).not.toHaveBeenCalled();
      expect(
        registeredAdapter()
          .getSnapshot()
          .items.map((item) => item.label),
      ).toEqual(["Question 0", "Question 1", "Question 2"]);
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
        writable: true,
      });
    }
  });

  it("only keeps that publication alive on a phone viewport", () => {
    // Desktop under `hide` unmounts exactly as it did before the button
    // existed: nothing there reads the outline.
    expect(
      shouldMountChatTurnMinimap({
        hasContent: true,
        side: "hide",
        mobileViewport: false,
      }),
    ).toBe(false);
    expect(
      shouldMountChatTurnMinimap({
        hasContent: true,
        side: "hide",
        mobileViewport: true,
      }),
    ).toBe(true);
    expect(
      shouldMountChatTurnMinimap({
        hasContent: false,
        side: "right",
        mobileViewport: true,
      }),
    ).toBe(false);
  });
});
