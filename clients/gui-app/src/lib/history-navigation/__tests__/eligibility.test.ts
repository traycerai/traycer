import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findEligibleOffset,
  isHistoryEntryEligible,
  type HistoryEligibilityState,
} from "@/lib/history-navigation/eligibility";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import type { EpicViewTab } from "@/stores/epics/canvas/types";

function tab(tabId: string, epicId: string): EpicViewTab {
  return { tabId, epicId, name: "Epic" };
}

function state(
  tabsById: HistoryEligibilityState["tabsById"],
  openTabOrder: ReadonlyArray<string>,
): HistoryEligibilityState {
  return {
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
    tabsById,
    openTabOrder,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("isHistoryEntryEligible", () => {
  it("treats non-epic-tab routes as always eligible", () => {
    const canvas = state({ t1: tab("t1", "e1") }, []);
    expect(isHistoryEntryEligible("/draft/d1", canvas)).toBe(true);
    expect(isHistoryEntryEligible("/", canvas)).toBe(true);
    expect(isHistoryEntryEligible("/settings/general", canvas)).toBe(true);
  });

  it("treats an unknown tabId as eligible when its fallback tab is open", () => {
    const canvas = state({ t1: tab("t1", "e1") }, ["t1"]);
    expect(isHistoryEntryEligible("/epics/e1/unknown-tab", canvas)).toBe(true);
  });

  it("treats an unknown nested target as ineligible despite an open fallback", () => {
    const canvas = state({ t1: tab("t1", "e1") }, ["t1"]);
    expect(
      isHistoryEntryEligible(
        "/epics/e1/unknown-tab?focusPaneId=p1&focusTileInstanceId=i1",
        canvas,
      ),
    ).toBe(false);
  });

  it("treats an unknown tabId as ineligible when its fallback tab is closed", () => {
    const canvas = {
      ...state({ t1: tab("t1", "e1") }, []),
      mostRecentTabIdByEpicId: { e1: "t1" },
    };
    expect(isHistoryEntryEligible("/epics/e1/unknown-tab", canvas)).toBe(false);
  });

  it("treats open Tasks (in openTabOrder) as eligible", () => {
    const canvas = state({ t1: tab("t1", "e1") }, ["t1"]);
    expect(isHistoryEntryEligible("/epics/e1/t1", canvas)).toBe(true);
    expect(
      isHistoryEntryEligible(
        "/epics/e1/t1?focusPaneId=p1&focusTileInstanceId=i1",
        canvas,
      ),
    ).toBe(true);
  });

  it("treats closed Tasks (in tabsById, not in openTabOrder) as ineligible", () => {
    const canvas = state({ t1: tab("t1", "e1") }, []);
    expect(isHistoryEntryEligible("/epics/e1/t1", canvas)).toBe(false);
    expect(
      isHistoryEntryEligible(
        "/epics/e1/t1?focusPaneId=p1&focusTileInstanceId=i1",
        canvas,
      ),
    ).toBe(false);
  });
});

describe("findEligibleOffset", () => {
  const entries = [
    "/epics/e1/open",
    "/epics/e1/closed-a",
    "/epics/e1/closed-b",
    "/epics/e1/current",
  ];

  // Only "open" and "current" are eligible; both closed-* are skipped.
  const isEligible = (href: string) =>
    href.includes("/open") || href.includes("/current");

  it("returns null at the back boundary when no eligible entry exists behind", () => {
    expect(findEligibleOffset(entries, 0, -1, isEligible)).toBeNull();
  });

  it("returns null at the forward boundary when no eligible entry exists ahead", () => {
    expect(findEligibleOffset(entries, 3, 1, isEligible)).toBeNull();
  });

  it("skips one closed-task entry when walking back", () => {
    // current -> closed-b (skip) -> closed-a (skip) -> open
    // But with only closed-b between current and a single closed, use a shorter stack.
    const short = ["/epics/e1/open", "/epics/e1/closed-a", "/epics/e1/current"];
    expect(findEligibleOffset(short, 2, -1, isEligible)).toBe(-2);
  });

  it("skips multiple closed-task entries when walking back", () => {
    expect(findEligibleOffset(entries, 3, -1, isEligible)).toBe(-3);
  });

  it("skips one closed-task entry when walking forward", () => {
    const short = ["/epics/e1/current", "/epics/e1/closed-a", "/epics/e1/open"];
    expect(findEligibleOffset(short, 0, 1, isEligible)).toBe(2);
  });

  it("skips multiple closed-task entries when walking forward", () => {
    expect(findEligibleOffset(entries, 0, 1, isEligible)).toBe(3);
  });

  it("returns null when only closed-task entries remain in a direction", () => {
    const onlyClosedBehind = [
      "/epics/e1/closed-a",
      "/epics/e1/closed-b",
      "/epics/e1/current",
    ];
    expect(
      findEligibleOffset(onlyClosedBehind, 2, -1, (href) =>
        href.includes("/current"),
      ),
    ).toBeNull();
  });

  it("lands on the nearest eligible entry even when farther ones exist", () => {
    // Two open entries behind; pick the nearest (closed-b is not eligible).
    const mixed = [
      "/epics/e1/open",
      "/epics/e1/also-open",
      "/epics/e1/closed-a",
      "/epics/e1/current",
    ];
    expect(
      findEligibleOffset(
        mixed,
        3,
        -1,
        (href) => href.includes("open") || href.includes("current"),
      ),
    ).toBe(-2);
  });
});

describe("isHistoryEntryEligible — a bot shown gone", () => {
  beforeEach(() => {
    useTracySurfaceStore.setState({ goneBotIds: [] });
  });
  afterEach(() => {
    useTracySurfaceStore.setState({ goneBotIds: [] });
  });

  it("skips the channel of a bot shown gone, and takes it again once it is not", () => {
    const canvas = state({}, []);
    const href = "/bot/bot-gone?view=activity";
    expect(isHistoryEntryEligible(href, canvas)).toBe(true);

    useTracySurfaceStore.setState({ goneBotIds: ["bot-gone"] });
    expect(isHistoryEntryEligible(href, canvas)).toBe(false);
    expect(isHistoryEntryEligible("/bot/bot-gone", canvas)).toBe(false);

    useTracySurfaceStore.setState({ goneBotIds: [] });
    expect(isHistoryEntryEligible(href, canvas)).toBe(true);
  });

  it("lands past a gone bot's entries on the nearest eligible one", () => {
    useTracySurfaceStore.setState({ goneBotIds: ["bot-gone"] });
    const canvas = state({}, []);
    const entries = [
      "/bot/bot-live?view=messages",
      "/bot/bot-gone?view=messages",
      "/bot/bot-gone?view=activity",
      "/bot/bot-live?view=activity",
    ];
    expect(
      findEligibleOffset(entries, 3, -1, (href) =>
        isHistoryEntryEligible(href, canvas),
      ),
    ).toBe(-3);
  });

  it("answers every other route kind as it did before, whoever is gone", () => {
    const canvas = state({ t1: tab("t1", "e1"), closed: tab("closed", "e1") }, [
      "t1",
    ]);
    const answers: ReadonlyArray<readonly [string, boolean]> = [
      ["/", true],
      ["/home", true],
      ["/epics", true],
      ["/epics/e1/t1", true],
      ["/epics/e1/closed", false],
      ["/draft/d1", true],
      ["/draft/new", true],
      ["/settings/general", true],
      ["/bot", true],
      ["/bot/bot-live", true],
      ["not a route at all", true],
    ];
    const eligibleNow = () =>
      answers.map(([href]) => isHistoryEntryEligible(href, canvas));
    expect(eligibleNow()).toEqual(answers.map(([, eligible]) => eligible));

    useTracySurfaceStore.setState({ goneBotIds: ["bot-gone", "bot-other"] });

    expect(eligibleNow()).toEqual(answers.map(([, eligible]) => eligible));
  });
});
