import { describe, expect, it } from "vitest";
import type { BotMemoryChange } from "@traycer/protocol/host/bot/schemas";
import {
  memoryChangesOn,
  memoryFocusGoneNote,
  memoryLineAccessibleName,
  memoryLineCounts,
  memoryLineGroupsOf,
  memoryLineLabel,
  type BotMemoryLineGroup,
} from "@/lib/bots/bot-memory-lines";

function change(overrides: Partial<BotMemoryChange>): BotMemoryChange {
  return {
    id: "change-1",
    at: 100,
    action: "add",
    memory: "own",
    entryId: "entry-1",
    threadId: null,
    ...overrides,
  };
}

function group(overrides: Partial<BotMemoryLineGroup>): BotMemoryLineGroup {
  return {
    memory: "own",
    added: 0,
    updated: 0,
    removed: 0,
    entryIds: [],
    ...overrides,
  };
}

describe("memoryChangesOn", () => {
  it("keeps the changes made on the surface, the channel being null", () => {
    const channel = change({ id: "c", threadId: null });
    const thread = change({ id: "t", threadId: "thread-1" });
    const other = change({ id: "o", threadId: "thread-2" });

    expect(memoryChangesOn([channel, thread, other], null)).toEqual([channel]);
    expect(memoryChangesOn([channel, thread, other], "thread-1")).toEqual([
      thread,
    ]);
  });

  it("sorts oldest first, the id breaking a tie", () => {
    const late = change({ id: "a", at: 300 });
    const tiedB = change({ id: "b", at: 200 });
    const tiedA = change({ id: "a2", at: 200 });
    const early = change({ id: "z", at: 100 });

    expect(memoryChangesOn([late, tiedB, early, tiedA], null)).toEqual([
      early,
      tiedA,
      tiedB,
      late,
    ]);
  });
});

describe("memoryLineGroupsOf", () => {
  it("makes one group per memory, in the order the run first touched each", () => {
    const groups = memoryLineGroupsOf([
      change({ id: "1", memory: "shared", entryId: "s1" }),
      change({ id: "2", memory: "own", entryId: "o1" }),
      change({ id: "3", memory: "shared", entryId: "s2" }),
    ]);

    expect(groups.map((entry) => entry.memory)).toEqual(["shared", "own"]);
  });

  it("counts each record under its action", () => {
    const [only] = memoryLineGroupsOf([
      change({ id: "1", action: "add", entryId: "a" }),
      change({ id: "2", action: "update", entryId: "b" }),
      change({ id: "3", action: "update", entryId: "c" }),
      change({ id: "4", action: "remove", entryId: "d" }),
      change({ id: "5", action: "add", entryId: "e" }),
    ]);

    expect(only).toMatchObject({ added: 2, updated: 2, removed: 1 });
  });

  it("lists an entry once, in the order it was first touched", () => {
    const [only] = memoryLineGroupsOf([
      change({ id: "1", entryId: "b" }),
      change({ id: "2", entryId: "a" }),
      change({ id: "3", action: "update", entryId: "b" }),
    ]);

    expect(only.entryIds).toEqual(["b", "a"]);
    expect(only).toMatchObject({ added: 2, updated: 1 });
  });
});

describe("memoryLineCounts", () => {
  it("joins the non-zero counts as added, updated, removed", () => {
    expect(memoryLineCounts(group({ added: 1, removed: 1 }))).toBe(
      "1 added, 1 removed",
    );
    expect(memoryLineCounts(group({ added: 2, updated: 3, removed: 4 }))).toBe(
      "2 added, 3 updated, 4 removed",
    );
    expect(memoryLineCounts(group({ updated: 1 }))).toBe("1 updated");
  });
});

describe("memoryLineLabel", () => {
  it("names the bot's own memory by its title", () => {
    expect(memoryLineLabel(group({ added: 1 }), "Tracy")).toBe(
      "Tracy's memory · 1 added",
    );
  });

  it("calls the shared memory common memory, whatever the bot", () => {
    expect(
      memoryLineLabel(group({ memory: "shared", updated: 2 }), "Tracy"),
    ).toBe("Common memory · 2 updated");
  });
});

describe("memoryLineAccessibleName", () => {
  it("says what opening the line opens", () => {
    expect(
      memoryLineAccessibleName(group({ added: 1, removed: 1 }), "Tracy"),
    ).toBe("Open Tracy's memory: 1 added, 1 removed");
    expect(
      memoryLineAccessibleName(group({ memory: "shared", added: 1 }), "Tracy"),
    ).toBe("Open common memory: 1 added");
  });
});

describe("memoryFocusGoneNote", () => {
  it("is singular for one entry", () => {
    expect(memoryFocusGoneNote(1)).toBe(
      "1 entry this line names was removed and is no longer here.",
    );
  });

  it("is plural for several", () => {
    expect(memoryFocusGoneNote(3)).toBe(
      "3 entries this line names were removed and are no longer here.",
    );
  });
});
