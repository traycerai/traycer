import { describe, expect, it } from "vitest";
import {
  memoryRailOver,
  type BotMemoryFocus,
  type BotOpenThread,
  type BotRail,
} from "@/stores/bots/bot-open-thread-store";

const THREAD: BotOpenThread = {
  anchorMessageId: "post-1",
  announcement: false,
  anchorKind: null,
  sent: null,
};

const FOCUS: BotMemoryFocus = {
  memory: "shared",
  entryIds: ["entry-1", "entry-2"],
};

describe("memoryRailOver with a focus", () => {
  it("keeps the focus on the memory it opens over nothing", () => {
    expect(memoryRailOver(null, FOCUS)).toEqual({
      kind: "memory",
      back: null,
      focus: FOCUS,
    });
  });

  it("keeps the thread it opens over as back, beside the focus", () => {
    const thread: BotRail = { kind: "thread", ...THREAD };

    expect(memoryRailOver(thread, FOCUS)).toEqual({
      kind: "memory",
      back: THREAD,
      focus: FOCUS,
    });
  });

  it("replaces the focus of a memory already open, keeping its back", () => {
    const open = memoryRailOver({ kind: "thread", ...THREAD }, FOCUS);
    const other: BotMemoryFocus = { memory: "own", entryIds: ["entry-9"] };

    expect(memoryRailOver(open, other)).toEqual({
      kind: "memory",
      back: THREAD,
      focus: other,
    });
  });

  it("opens with no focus when given null", () => {
    expect(memoryRailOver(null, null)).toEqual({
      kind: "memory",
      back: null,
      focus: null,
    });
  });
});
