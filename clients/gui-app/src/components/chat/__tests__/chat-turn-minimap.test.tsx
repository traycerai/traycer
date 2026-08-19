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
      messages={messages}
      onSelect={onSelect}
      side={options.side ?? "right"}
      topOffsetAdjustmentRef={{ current: 0 }}
      viewportRef={{ current: viewport }}
    />,
  );
  return { onSelect, refreshRef };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  useSettingsStore.setState({ uiFontSize: DEFAULT_UI_FONT_SIZE });
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
