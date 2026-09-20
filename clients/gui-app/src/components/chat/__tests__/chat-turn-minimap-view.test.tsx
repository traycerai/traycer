import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTurnMinimapView } from "@/components/chat/chat-turn-minimap";
import type { ChatTurnMinimapItem } from "@/components/chat/chat-turn-minimap-logic";

afterEach(cleanup);

function items(count: number): ReadonlyArray<ChatTurnMinimapItem> {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `turn-${index}`,
    messageId: `turn-${index}`,
    rowIndex: index,
    endRowIndex: index,
    level: 1,
    label: `Question ${index}`,
  }));
}

function renderView(
  overrides: Partial<Parameters<typeof ChatTurnMinimapView>[0]>,
) {
  const handlers = {
    onOpen: vi.fn(),
    onFocus: vi.fn(),
    onKeyDown: vi.fn(),
    onCursorIndexChange: vi.fn(),
    onSelect: vi.fn(),
  };
  const regionRef = createRef<HTMLDivElement>();
  const hitStripRef = createRef<HTMLButtonElement>();
  render(
    <ChatTurnMinimapView
      items={items(12)}
      currentIndex={0}
      cursorIndex={0}
      maxVisibleItems={5}
      bottomInset={0}
      hitStripWidth={24}
      side="right"
      open={false}
      ref={regionRef}
      hitStripRef={hitStripRef}
      {...handlers}
      {...overrides}
    />,
  );
  return { handlers, regionRef, hitStripRef };
}

describe("ChatTurnMinimapView", () => {
  it("draws at most maxVisibleItems ticks, windowed around the current turn", () => {
    renderView({ currentIndex: 6, maxVisibleItems: 5 });

    const ticks = screen.getAllByTestId("chat-turn-minimap-tick");
    expect(ticks).toHaveLength(5);
    expect(ticks.map((tick) => tick.getAttribute("data-message-id"))).toEqual([
      "turn-4",
      "turn-5",
      "turn-6",
      "turn-7",
      "turn-8",
    ]);
  });

  it("draws every tick when everything fits", () => {
    renderView({ items: items(3), maxVisibleItems: 10 });

    expect(screen.getAllByTestId("chat-turn-minimap-tick")).toHaveLength(3);
  });

  it("draws no ticks for an empty item list", () => {
    renderView({ items: [] });

    expect(screen.queryAllByTestId("chat-turn-minimap-tick")).toHaveLength(0);
  });

  it("puts the rail on the requested side", () => {
    renderView({ side: "left" });

    expect(
      screen.getByTestId("chat-turn-minimap").getAttribute("data-side"),
    ).toBe("left");
  });

  it("reserves the bottom inset, rounded up and never negative", () => {
    renderView({ bottomInset: 10.2 });
    expect(screen.getByTestId("chat-turn-minimap").style.bottom).toBe("11px");

    cleanup();
    renderView({ bottomInset: -4 });
    expect(screen.getByTestId("chat-turn-minimap").style.bottom).toBe("0px");
  });

  it("sizes the hit strip from hitStripWidth", () => {
    renderView({ hitStripWidth: 32 });

    expect(screen.getByTestId("chat-turn-minimap-hit-strip").style.width).toBe(
      "32px",
    );
  });

  it("attaches the ref and hit-strip ref to the group and the strip", () => {
    const { regionRef, hitStripRef } = renderView({});

    expect(regionRef.current?.getAttribute("role")).toBe("group");
    expect(hitStripRef.current).toBe(
      screen.getByTestId("chat-turn-minimap-hit-strip"),
    );
  });

  it("accepts a null hit-strip ref and a callback ref", () => {
    const regionRef = vi.fn();
    renderView({ ref: regionRef, hitStripRef: null });

    expect(regionRef).toHaveBeenCalledWith(
      screen.getByRole("group", { name: "Message minimap controls" }),
    );
  });

  it("has no card while closed and reports aria-expanded=false", () => {
    renderView({ open: false });

    expect(screen.queryByTestId("chat-turn-minimap-card")).toBeNull();
    expect(
      screen
        .getByTestId("chat-turn-minimap-hit-strip")
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("clicking the strip and focusing it call the open handlers, nothing else", () => {
    const { handlers } = renderView({});
    const strip = screen.getByTestId("chat-turn-minimap-hit-strip");

    fireEvent.click(strip);
    fireEvent.focus(strip);

    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    expect(handlers.onFocus).toHaveBeenCalledTimes(1);
    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  it("forwards strip key events to onKeyDown", () => {
    const { handlers } = renderView({});

    fireEvent.keyDown(screen.getByTestId("chat-turn-minimap-hit-strip"), {
      key: "ArrowDown",
    });

    expect(handlers.onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("when open, shows the card with every item and selecting a row reports its INDEX", () => {
    const { handlers } = renderView({ open: true, items: items(4) });

    const card = screen.getByTestId("chat-turn-minimap-card");
    expect(card).not.toBeNull();
    expect(
      screen
        .getByTestId("chat-turn-minimap-hit-strip")
        .getAttribute("aria-expanded"),
    ).toBe("true");

    fireEvent.click(screen.getByText("Question 2"));

    expect(handlers.onSelect).toHaveBeenCalledWith(2);
  });
});
