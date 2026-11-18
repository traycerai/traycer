import { describe, expect, it } from "vitest";
import {
  repairLayout,
  tabItemId,
  withoutSampleWorkspace,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import { isRegisteredTabKind } from "@/stores/tabs/tab-kind-policy";
import type { TabRef } from "@/stores/tabs/types";

/**
 * The `sampleReturnItemId` capture on the sample-workspace strip item, and
 * what `withoutSampleWorkspace` / `repairLayout` do with it.
 *
 * The CAPTURE side - stamping the field when the editor's door opens the
 * sample tab - lives in that door (`lib/layout/editor-session.ts`) and is
 * covered there, so this file covers only the pure reducers: a hand-built
 * layout carrying (or lacking) the field in, and what comes out.
 */

const SAMPLE_REF: TabRef = { kind: "sample-workspace", id: "sample-workspace" };
const SAMPLE_ITEM_ID = tabItemId(SAMPLE_REF);
const HISTORY_REF: TabRef = { kind: "history", id: "history" };
const HISTORY_ITEM_ID = tabItemId(HISTORY_REF);

describe("S1 - the capture rides on the sample strip item", () => {
  function layoutWith(
    capture: string | null | undefined,
  ): PersistedTabStripLayout {
    return {
      version: 2,
      items: [
        { kind: "tab", id: HISTORY_ITEM_ID, ref: HISTORY_REF },
        capture === undefined
          ? { kind: "tab", id: SAMPLE_ITEM_ID, ref: SAMPLE_REF }
          : {
              kind: "tab",
              id: SAMPLE_ITEM_ID,
              ref: SAMPLE_REF,
              sampleReturnItemId: capture,
            },
      ],
      activeItemId: SAMPLE_ITEM_ID,
      systemTabs: {
        history: {
          id: "history",
          kind: "history",
          name: "History",
          lastPath: null,
        },
        settings: null,
      },
      activationHistory: [],
    };
  }

  it("removing the active sample restores Home when the capture is null", () => {
    expect(
      withoutSampleWorkspace(layoutWith(null), true).activeItemId,
    ).toBeNull();
  });

  it("removing the active sample restores the captured item id", () => {
    expect(
      withoutSampleWorkspace(layoutWith(HISTORY_ITEM_ID), true).activeItemId,
    ).toBe(HISTORY_ITEM_ID);
  });

  it("with no capture (legacy/hand-written) it falls back to ordinary neighbour selection without throwing", () => {
    const stripped = withoutSampleWorkspace(layoutWith(undefined), true);
    expect(stripped.items.map((item) => item.id)).toEqual([HISTORY_ITEM_ID]);
    expect(stripped.activeItemId).toBe(HISTORY_ITEM_ID);
  });

  it("does not disturb the selection when the sample is not the active item", () => {
    const layout = { ...layoutWith(null), activeItemId: HISTORY_ITEM_ID };
    expect(withoutSampleWorkspace(layout, true).activeItemId).toBe(
      HISTORY_ITEM_ID,
    );
  });

  it("repairLayout preserves the capture, including null", () => {
    for (const capture of [null, HISTORY_ITEM_ID]) {
      const repaired = repairLayout(layoutWith(capture), isRegisteredTabKind);
      const sample = repaired.items.find((item) => item.id === SAMPLE_ITEM_ID);
      expect(
        sample?.kind === "tab" ? sample.sampleReturnItemId : "missing",
      ).toBe(capture);
    }
  });
});

describe("S1 round 2 - pure reducer, Home unavailable", () => {
  function layoutFor(capture: string | null): PersistedTabStripLayout {
    return {
      version: 2,
      items: [
        { kind: "tab", id: HISTORY_ITEM_ID, ref: HISTORY_REF },
        {
          kind: "tab",
          id: SAMPLE_ITEM_ID,
          ref: SAMPLE_REF,
          sampleReturnItemId: capture,
        },
      ],
      activeItemId: SAMPLE_ITEM_ID,
      systemTabs: {
        history: {
          id: "history",
          kind: "history",
          name: "History",
          lastPath: null,
        },
        settings: null,
      },
      activationHistory: [],
    };
  }

  it("a Home capture with Home disabled falls back to the retained tab, not a dangling null", () => {
    const stripped = withoutSampleWorkspace(layoutFor(null), false);

    expect(stripped.items.map((item) => item.id)).toEqual([HISTORY_ITEM_ID]);
    expect(stripped.activeItemId).toBe(HISTORY_ITEM_ID);
  });

  it("a Home capture with Home enabled still restores Home", () => {
    expect(
      withoutSampleWorkspace(layoutFor(null), true).activeItemId,
    ).toBeNull();
  });

  it("a real-tab capture is honoured whether or not Home is enabled", () => {
    for (const homeEnabled of [true, false]) {
      expect(
        withoutSampleWorkspace(layoutFor(HISTORY_ITEM_ID), homeEnabled)
          .activeItemId,
      ).toBe(HISTORY_ITEM_ID);
    }
  });

  it("with nothing retained and Home disabled it leaves an empty, unselected window", () => {
    const onlySample: PersistedTabStripLayout = {
      ...layoutFor(null),
      items: [
        {
          kind: "tab",
          id: SAMPLE_ITEM_ID,
          ref: SAMPLE_REF,
          sampleReturnItemId: null,
        },
      ],
      systemTabs: { history: null, settings: null },
    };

    const stripped = withoutSampleWorkspace(onlySample, false);

    expect(stripped.items).toEqual([]);
    expect(stripped.activeItemId).toBeNull();
  });
});
