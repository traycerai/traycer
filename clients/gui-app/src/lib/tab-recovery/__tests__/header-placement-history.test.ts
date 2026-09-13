import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import type { SplitStripItem } from "@/stores/tabs/layout";
import { closedHeaderPlacementSchema } from "../header-layout";
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

  it("has no journal shape for the pinned Home tab", () => {
    // The WRITE half of the Home rule: nothing may record one. Home is a
    // per-window pinned singleton with no close affordance, and the close path
    // only builds a recovery entry for `draft` and `epic`. `ClosedHeaderTab`
    // carrying no `home` variant is what makes that unrepresentable rather than
    // merely unused - so adding one, or giving Home a close affordance that
    // reaches the recorder, fails here first instead of silently resurrecting a
    // second Home on reopen. The READ half is `rejects a home ref` below.
    const journalledKinds = ["epic", "draft"] as const satisfies ReadonlyArray<
      ClosedHeaderTab["kind"]
    >;
    // Compile error the moment `ClosedHeaderTab` gains a variant this list does
    // not name - which is the real guard; the runtime check below only reports
    // it in the suite a reader is looking at.
    const unjournalled: Exclude<
      ClosedHeaderTab["kind"],
      (typeof journalledKinds)[number]
    > extends never
      ? true
      : false = true;

    expect(unjournalled).toBe(true);
    expect(journalledKinds).not.toContain("home");
  });

  it("rejects a home ref on either side of a persisted split", () => {
    // The READ half. A journal is untrusted input - hand-edited, truncated, or
    // written by a build where Home WAS recoverable - so the parser refuses a
    // `home` ref rather than relying on nothing having produced one. Without
    // this, `restoreSplit` would install a second Home as a split side, which
    // the per-window singleton has no way to reconcile.
    const split = (side: unknown) => ({
      split: {
        kind: "split",
        id: "s",
        left: side,
        right: { kind: "empty" },
        focusedSide: "left",
        routeBackingSide: "left",
        leftRatio: 0.5,
      },
    });

    expect(
      closedHeaderPlacementSchema.safeParse(
        split({ kind: "tab", ref: { kind: "home", id: "home" } }),
      ).success,
    ).toBe(false);
    expect(
      closedHeaderPlacementSchema.safeParse(
        split({
          kind: "unavailable",
          previousRef: { kind: "home", id: "home" },
          label: "Home",
        }),
      ).success,
    ).toBe(false);

    // Every recoverable kind still parses, so the subtraction removed exactly
    // one member and did not narrow the schema by accident.
    for (const kind of ["epic", "draft", "history", "settings"] as const) {
      expect(
        closedHeaderPlacementSchema.safeParse(
          split({ kind: "tab", ref: { kind, id: `${kind}-1` } }),
        ).success,
      ).toBe(true);
    }
  });
});
