import { describe, expect, it } from "vitest";
import {
  CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
  compactChatTurnMinimapPreview,
  resolveChatTurnMinimapCurrentIndex,
  resolveChatTurnMinimapHitStripWidth,
  resolveChatTurnMinimapTopStyle,
} from "@/components/chat/chat-turn-minimap-logic";
import { MINIMAP_TRACK_END_HIT_PADDING } from "@/components/minimap/minimap-track-geometry";

const TURNS = [
  { rowIndex: 0, endRowIndex: 1 },
  { rowIndex: 2, endRowIndex: 3 },
  { rowIndex: 4, endRowIndex: 5 },
] as const;
const POSITIONS = [0, 100, 300, 400, 700, 800] as const;

function currentAt(scroll: number, scrollLength: number): number | null {
  return resolveChatTurnMinimapCurrentIndex(
    {
      scroll,
      scrollLength,
      positionAtIndex: (index) => POSITIONS[index],
      sizeAtIndex: () => 100,
    },
    TURNS,
  );
}

describe("chat turn minimap logic", () => {
  it("uses the user query whose full turn occupies most of the viewport", () => {
    expect(currentAt(330, 300)).toBe(1);
    expect(currentAt(720, 70)).toBe(2);
  });

  it("highlights a visible user query over the previous reply", () => {
    expect(currentAt(500, 250)).toBe(2);
  });

  it("keeps the earlier query on an equal visibility tie", () => {
    expect(currentAt(0, 400)).toBe(0);
  });

  it("falls back to the nearest user query when no turn intersects", () => {
    expect(currentAt(-200, 50)).toBe(0);
  });

  it("uses transcript padding for a compact rail in tiled panes", () => {
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: 15,
        viewportWidth: 720,
      }),
    ).toBe(11);
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: 15,
        viewportWidth: 1200,
      }),
    ).toBe(CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH);
  });

  it("keeps endpoint markers inside the hit target", () => {
    expect(resolveChatTurnMinimapTopStyle(0, 3)).toBe(
      `calc(0% + ${MINIMAP_TRACK_END_HIT_PADDING}px)`,
    );
    expect(resolveChatTurnMinimapTopStyle(2, 3)).toBe(
      `calc(100% - ${MINIMAP_TRACK_END_HIT_PADDING}px)`,
    );
  });

  it("uses a short, whitespace-collapsed query label", () => {
    expect(compactChatTurnMinimapPreview("  A\n\n useful   query ")).toBe(
      "A useful query",
    );
  });
});
