import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import type { SplitStripItem } from "@/stores/tabs/layout";
import {
  configureTabRecoveryHistory,
  flushTabRecoveryHistory,
  recordClosedHeaderTab,
  resetTabRecoveryHistory,
  useTabRecoveryHistory,
  type ClosedHeaderTab,
} from "../history";

const ACCOUNT = "header-placement-account";
const WINDOW = "header-placement-window";

function setWindow(windowId: string): void {
  Reflect.set(globalThis, "runnerHost", { windows: { windowId } });
}

function emptyCanvas() {
  return {
    root: null,
    activePaneId: null,
    tilesByInstanceId: {},
    sizesByGroupId: {},
  } as const;
}

function placementSplit(): SplitStripItem {
  return {
    kind: "split",
    id: "placement-split",
    left: { kind: "tab", ref: { kind: "epic", id: "placement-epic" } },
    right: { kind: "empty" },
    focusedSide: "left",
    routeBackingSide: "left",
    leftRatio: 0.63,
  };
}

beforeEach(async () => {
  installFreshIndexedDb();
  setWindow(WINDOW);
  await resetTabRecoveryHistory();
  await configureTabRecoveryHistory(null);
  await configureTabRecoveryHistory(ACCOUNT);
  useTabRecoveryHistory.setState({ entries: [], ready: true });
});

afterEach(async () => {
  await resetTabRecoveryHistory();
});

describe("closed header placement history", () => {
  it("leaves ordinary tab entries free of placement metadata", () => {
    const item: ClosedHeaderTab = {
      kind: "epic",
      tab: { epicId: "plain-epic", tabId: "plain-tab", name: "Plain" },
      canvas: emptyCanvas(),
      index: 2,
    };

    recordClosedHeaderTab(item);

    const entry = useTabRecoveryHistory.getState().entries.at(0);
    if (entry === undefined || entry.kind !== "header") {
      throw new Error("expected a plain header recovery entry");
    }
    expect(entry.items).toEqual([item]);
    expect(entry.items[0]).not.toHaveProperty("placement");
  });

  it("round-trips split, customization, and group placement through hydration", async () => {
    const ref = { kind: "epic" as const, id: "placement-epic" };
    const placement = {
      split: placementSplit(),
      customization: {
        color: "#f28b82",
        icon: "★",
        groupId: "placement-group",
      },
      group: {
        name: "Placement group",
        color: "#8ab4f8",
        collapsed: true,
      },
    };
    const item: ClosedHeaderTab = {
      kind: "epic",
      tab: { epicId: ref.id, tabId: ref.id, name: "Placement" },
      canvas: emptyCanvas(),
      index: 1,
      placement,
    };

    recordClosedHeaderTab(item);
    await flushTabRecoveryHistory();

    // Resetting the in-memory history models a reload; the persisted envelope
    // is parsed back into the same optional placement shape.
    await resetTabRecoveryHistory();
    setWindow(WINDOW);
    await configureTabRecoveryHistory(ACCOUNT);

    const entry = useTabRecoveryHistory.getState().entries.at(0);
    if (entry === undefined || entry.kind !== "header") {
      throw new Error("expected the hydrated placement entry");
    }
    expect(entry.items).toEqual([item]);
    expect(entry.items[0]).toMatchObject({
      placement: {
        split: placement.split,
        customization: placement.customization,
        group: placement.group,
      },
    });
  });
});
