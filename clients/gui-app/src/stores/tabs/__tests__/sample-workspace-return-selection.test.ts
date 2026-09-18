import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enterCustomize,
  ensureSampleWorkspaceTab,
  exitCustomize,
} from "@/lib/customize/enter-exit";
import type {
  DesktopPerWindowSnapshot,
  DesktopPerWindowStatePatch,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  clearDesktopTabsPersistence,
  configureBrowserTabsPersistence,
  consumeDesktopRestoredRoute,
  flushDesktopTabsPersistence,
  hydrateDesktopTabs,
  installDesktopTabsPersistence,
  updateDesktopTabsActiveRoute,
} from "@/stores/tabs/desktop-tabs-persistence";
import {
  emptyTabStripLayout,
  repairLayout,
  tabItemId,
  withoutSampleWorkspace,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import { isRegisteredTabKind } from "@/stores/tabs/registry";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";

const CAPABILITIES = {
  schemaVersion: 2,
  features: ["tab-strip-layout-v2", "active-route-v1"],
} as const;

const SAMPLE_REF: TabRef = { kind: "sample-workspace", id: "sample-workspace" };
const SAMPLE_ITEM_ID = tabItemId(SAMPLE_REF);
const HISTORY_REF: TabRef = { kind: "history", id: "history" };
const HISTORY_ITEM_ID = tabItemId(HISTORY_REF);

function emptySnapshot(): DesktopPerWindowSnapshot {
  return {
    epicTabs: [],
    activeTabId: null,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
    tabStripLayout: null,
    activeRoute: null,
  };
}

function recordingBridge(
  updates: DesktopPerWindowStatePatch[],
): Pick<DesktopWindowsBridge, "perWindowState"> {
  let revision = 0;
  return {
    perWindowState: {
      get: () => Promise.resolve(emptySnapshot()),
      capabilities: () => Promise.resolve(CAPABILITIES),
      update: (patch) => {
        updates.push(patch);
        return Promise.resolve({
          capabilities: CAPABILITIES,
          revision: (revision += 1),
        });
      },
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

function sampleItemCount(): number {
  return useTabsStore
    .getState()
    .items.filter(
      (item) => item.kind === "tab" && item.ref.kind === "sample-workspace",
    ).length;
}

/** A window with only a retained History tab; `activeItemId` is what the test says. */
function seedHistoryStrip(activeItemId: string | null): void {
  useTabsStore.setState({
    ...emptyTabStripLayout(),
    items: [{ kind: "tab", id: HISTORY_ITEM_ID, ref: HISTORY_REF }],
    activeItemId,
    stripOrder: [HISTORY_REF],
    systemTabs: {
      history: {
        id: "history",
        kind: "history",
        name: "History",
        lastPath: null,
      },
      settings: null,
    },
  });
}

function seedEmptyStrip(): void {
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
}

/** What the user does: open the sample tab, select it, start its session. */
function openSample(): void {
  ensureSampleWorkspaceTab({ kind: "none" });
  useTabsStore.setState({ activeItemId: SAMPLE_ITEM_ID });
  expect(
    enterCustomize({ scene: "sample", opener: { kind: "none" }, target: null }),
  ).toBe(true);
  expect(useCustomizeStore.getState().session?.scene).toBe("sample");
}

async function projectedPatch(): Promise<DesktopPerWindowStatePatch> {
  const updates: DesktopPerWindowStatePatch[] = [];
  installDesktopTabsPersistence(recordingBridge(updates), 0);
  updateDesktopTabsActiveRoute("/sample-workspace");
  await flushDesktopTabsPersistence();
  const last = updates.at(-1);
  if (last === undefined) throw new Error("nothing was projected");
  expect(JSON.stringify(last)).not.toContain("sample-workspace");
  return last;
}

function resetStores(): void {
  if (useCustomizeStore.getState().session) exitCustomize("done");
  clearDesktopTabsPersistence();
  configureBrowserTabsPersistence();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  useSettingsStore.setState({
    visualLayoutEditorEnabled: true,
    homeTabEnabled: false,
  });
  tabCommandCoordinator.resetReconciliationForTesting();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetStores();
});

afterEach(() => {
  resetStores();
  vi.useRealTimers();
  localStorage.clear();
});

describe("S1 - Home with a retained tab", () => {
  beforeEach(() => {
    useSettingsStore.setState({ homeTabEnabled: true });
    seedHistoryStrip(null);
  });

  it("persists Home (not the retained tab) as the selection while the sample is open", async () => {
    openSample();

    const patch = await projectedPatch();

    expect(patch).toMatchObject({
      tabStripLayout: { activeItemId: null },
      activeRoute: "/home",
    });
    // The retained tab itself is still persisted.
    expect(JSON.stringify(patch.tabStripLayout)).toContain("history");
  });

  it("the browser persist writer also keeps Home selected", () => {
    openSample();

    const persisted = useTabsStore.persist
      .getOptions()
      .partialize?.(useTabsStore.getState());

    expect(persisted).toMatchObject({ activeItemId: null });
    expect(JSON.stringify(persisted)).not.toContain("sample-workspace");
  });

  it.each(["done", "escape"] as const)(
    "%s returns to Home, not the retained tab",
    (reason) => {
      openSample();

      exitCustomize(reason);

      expect(sampleItemCount()).toBe(0);
      expect(useTabsStore.getState().activeItemId).toBeNull();
      // The retained tab is untouched.
      expect(useTabsStore.getState().items.map((item) => item.id)).toEqual([
        HISTORY_ITEM_ID,
      ]);
    },
  );

  it("a saved desktop projection restores Home after a restart", async () => {
    openSample();
    const patch = await projectedPatch();

    // "Restart": nothing survives but what was written.
    exitCustomize("studio-closed");
    clearDesktopTabsPersistence();
    useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
    hydrateDesktopTabs(
      {
        ...emptySnapshot(),
        revision: 9,
        tabStripLayout: patch.tabStripLayout ?? null,
        activeRoute: patch.activeRoute ?? null,
      },
      true,
      null,
    );

    expect(useTabsStore.getState().activeItemId).toBeNull();
    expect(sampleItemCount()).toBe(0);
    expect(useTabsStore.getState().items.map((item) => item.id)).toEqual([
      HISTORY_ITEM_ID,
    ]);
    expect(consumeDesktopRestoredRoute()).toBe("/home");
  });
});

describe("S1 - Home with nothing else open", () => {
  it("persists Home and Done returns to Home", async () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    seedEmptyStrip();
    openSample();

    const patch = await projectedPatch();
    expect(patch).toMatchObject({
      tabStripLayout: { activeItemId: null },
      activeRoute: "/home",
    });

    exitCustomize("done");

    expect(sampleItemCount()).toBe(0);
    expect(useTabsStore.getState().activeItemId).toBeNull();
    expect(useTabsStore.getState().items).toEqual([]);
  });
});

describe("S1 - sample is the only tab and Home is off", () => {
  it("projects an empty window, never the sample route, and Done leaves it empty", async () => {
    seedEmptyStrip();
    openSample();

    const patch = await projectedPatch();

    expect(patch).toMatchObject({
      tabStripLayout: { items: [], activeItemId: null },
    });
    expect(patch.activeRoute).not.toBe("/sample-workspace");

    exitCustomize("escape");

    expect(useTabsStore.getState().items).toEqual([]);
    expect(useTabsStore.getState().activeItemId).toBeNull();
  });

  it("a restart from that projection restores no sample and no stale route", async () => {
    seedEmptyStrip();
    openSample();
    const patch = await projectedPatch();

    exitCustomize("studio-closed");
    clearDesktopTabsPersistence();
    hydrateDesktopTabs(
      {
        ...emptySnapshot(),
        revision: 4,
        tabStripLayout: patch.tabStripLayout ?? null,
        activeRoute: patch.activeRoute ?? null,
      },
      true,
      null,
    );

    expect(sampleItemCount()).toBe(0);
    expect(consumeDesktopRestoredRoute()).not.toBe("/sample-workspace");
  });
});

describe("S1 - a task tab was selected", () => {
  function seedTaskActive(): { readonly ref: TabRef; readonly route: string } {
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTabWithId("tab-a", "epic-a", "Alpha");
    const ref: TabRef = { kind: "epic", id: tabId };
    useTabsStore.setState({
      ...emptyTabStripLayout(),
      items: [{ kind: "tab", id: tabItemId(ref), ref }],
      activeItemId: tabItemId(ref),
      stripOrder: [ref],
    });
    return { ref, route: "/epics/epic-a/tab-a" };
  }

  it("still persists the task as selected, with the task's own route", async () => {
    const task = seedTaskActive();
    openSample();

    const patch = await projectedPatch();

    expect(patch).toMatchObject({
      tabStripLayout: { activeItemId: tabItemId(task.ref) },
      activeRoute: task.route,
    });
  });

  it.each(["done", "escape"] as const)("%s returns to the task", (reason) => {
    const task = seedTaskActive();
    openSample();

    exitCustomize(reason);

    expect(sampleItemCount()).toBe(0);
    expect(useTabsStore.getState().activeItemId).toBe(tabItemId(task.ref));
  });
});

describe("S1 - the item-level capture never leaks into persisted state", () => {
  it("neither writer serializes the return-selection metadata", async () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    seedHistoryStrip(null);
    openSample();

    const persisted = useTabsStore.persist
      .getOptions()
      .partialize?.(useTabsStore.getState());
    const patch = await projectedPatch();

    expect(JSON.stringify(persisted)).not.toContain("sampleReturn");
    expect(JSON.stringify(patch)).not.toContain("sampleReturn");
  });
});

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
    expect(withoutSampleWorkspace(layoutWith(null)).activeItemId).toBeNull();
  });

  it("removing the active sample restores the captured item id", () => {
    expect(
      withoutSampleWorkspace(layoutWith(HISTORY_ITEM_ID)).activeItemId,
    ).toBe(HISTORY_ITEM_ID);
  });

  it("with no capture (legacy/hand-written) it falls back to ordinary neighbour selection without throwing", () => {
    const stripped = withoutSampleWorkspace(layoutWith(undefined));
    expect(stripped.items.map((item) => item.id)).toEqual([HISTORY_ITEM_ID]);
    expect(stripped.activeItemId).toBe(HISTORY_ITEM_ID);
  });

  it("does not disturb the selection when the sample is not the active item", () => {
    const layout = { ...layoutWith(null), activeItemId: HISTORY_ITEM_ID };
    expect(withoutSampleWorkspace(layout).activeItemId).toBe(HISTORY_ITEM_ID);
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

  it("ensure captures the selection only when it FIRST creates the sample", () => {
    useSettingsStore.setState({ homeTabEnabled: true });
    seedHistoryStrip(null);
    const captured = (): string | null | undefined => {
      const item = useTabsStore
        .getState()
        .items.find((entry) => entry.id === SAMPLE_ITEM_ID);
      return item?.kind === "tab" ? item.sampleReturnItemId : undefined;
    };

    ensureSampleWorkspaceTab({ kind: "none" });
    expect(captured()).toBeNull();

    // The user moves to History, then asks for the sample again.
    useTabsStore.setState({ activeItemId: HISTORY_ITEM_ID });
    ensureSampleWorkspaceTab({ kind: "none" });

    expect(captured()).toBeNull();
  });

  it("ensure captures a real tab's item id, not null, when that tab is selected", () => {
    seedHistoryStrip(HISTORY_ITEM_ID);

    ensureSampleWorkspaceTab({ kind: "none" });

    const item = useTabsStore
      .getState()
      .items.find((entry) => entry.id === SAMPLE_ITEM_ID);
    expect(item?.kind === "tab" ? item.sampleReturnItemId : "missing").toBe(
      HISTORY_ITEM_ID,
    );
  });
});
