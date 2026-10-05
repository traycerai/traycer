import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_USAGE_ROW_KEYS } from "@/lib/context-usage-rows";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { visibleRailPanelIds, type RailEntry } from "@/lib/layout/rail";
import { layoutChanges, regionChangedKeys } from "@/lib/layout/layout-diff";
import { type LayoutValues } from "@/lib/layout/layout-values";
import {
  effectiveLayoutValues,
  PRESET_VALUES,
} from "@/lib/layout/layout-presets";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  getLayoutSnapshot,
  isHomeTabEnabled,
  useLayoutStore,
} from "@/stores/layout/layout-store";

const LAYOUT_KEY = persistKey(STORE_KEYS.layout);
const SETTINGS_KEY = persistKey(STORE_KEYS.settings);
const LEFT_PANEL_KEY = persistKey(STORE_KEYS.leftPanel);
/** The version this build writes (`LAYOUT_PERSIST_VERSION` in `layout-store.ts`). */
const LAYOUT_VERSION = 7;

/** The number of Styles lines on the change list - what `changeCount` used to return. */
function changeCount(snapshot: LayoutSnapshot): number {
  return layoutChanges(snapshot).styles.length;
}

/** Every panel the rail holds, hiding nothing. */
function everyRailPanelId(
  rail: ReadonlyArray<RailEntry>,
): ReadonlyArray<string> {
  return visibleRailPanelIds(rail, () => true);
}

/** The rail's stack entries only, in rail order. */
function railStacks(rail: ReadonlyArray<RailEntry>): ReadonlyArray<RailEntry> {
  return rail.filter((entry) => entry.kind === "stack");
}

function reset(): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  window.localStorage.clear();
}

function writeLayoutRecord(state: unknown): void {
  writeLayoutRecordAtVersion(state, LAYOUT_VERSION);
}

function writeLayoutRecordAtVersion(state: unknown, version: number): void {
  window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ state, version }));
}

/** The version field of whatever is currently stored under the layout key. */
function storedLayoutVersion(): unknown {
  const raw = window.localStorage.getItem(LAYOUT_KEY);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === "object" && parsed !== null && "version" in parsed
    ? parsed.version
    : null;
}

async function rehydrateFrom(state: unknown): Promise<void> {
  writeLayoutRecord(state);
  await useLayoutStore.persist.rehydrate();
}

/** The same, from a record written before the version this build writes. */
async function rehydrateFromVersion(
  state: unknown,
  version: number,
): Promise<void> {
  writeLayoutRecordAtVersion(state, version);
  await useLayoutStore.persist.rehydrate();
}

function writeSettingsRecord(state: unknown): void {
  window.localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ state, version: 1 }),
  );
}

/**
 * An OLDER version than the sidebar store's current one, which is what a
 * machine updating from before this migration has - and what makes zustand
 * rewrite the record through the CURRENT `partialize` the moment the sidebar
 * store is created (`legacy-layout-records.ts`'s reason to capture at load).
 */
function writeLeftPanelRecord(state: unknown): void {
  window.localStorage.setItem(
    LEFT_PANEL_KEY,
    JSON.stringify({ state, version: 2 }),
  );
}

/**
 * A second launch of the store, module load and all - the only way to observe
 * a migration, which runs before the store exists.
 */
async function relaunchStore(): Promise<{
  readonly state: () => LayoutSnapshot;
}> {
  vi.resetModules();
  const module = await import("@/stores/layout/layout-store");
  return {
    state: () => ({
      basePreset: module.useLayoutStore.getState().basePreset,
      overrides: module.useLayoutStore.getState().overrides,
      arrangement: module.useLayoutStore.getState().arrangement,
    }),
  };
}

describe("useLayoutStore", () => {
  beforeEach(reset);
  afterEach(reset);

  /**
   * The delta is what a person PICKED, and "changed" is measured against
   * whichever base is current (L-133). The two were the same thing while the
   * store re-minimized on every write - and keeping them the same cost a
   * preset click every pick the incoming preset happened to agree with.
   */
  describe("the delta is the user's picks", () => {
    it("writes only the key the caller named", () => {
      useLayoutStore.getState().setRegionValues("model", { style: "bars" });

      expect(getLayoutSnapshot().overrides).toEqual({
        model: { style: "bars" },
      });
      expect(
        effectiveLayoutValues("default", getLayoutSnapshot().overrides).model,
      ).toEqual({
        style: "bars",
        reasoningControl: "slider",
        toolbarStyle: "flat",
      });
    });

    it("keeps a key set back to the base's own value, and stops counting it", () => {
      const store = useLayoutStore.getState();
      store.setRegionValues("model", { style: "bars" });
      store.setRegionValues("model", { style: "text" });

      // The pick is on record - Compact draws this region as bars, so it is
      // the user's answer again the moment they switch density.
      expect(getLayoutSnapshot().overrides).toEqual({
        model: { style: "text" },
      });
      // ... and it is NOT a change, because nothing about the picture differs
      // from the base. That is the half the header, the dot and the revert
      // read, and it is measured rather than stored.
      expect(regionChangedKeys(getLayoutSnapshot(), "model")).toEqual([]);
      expect(changeCount(getLayoutSnapshot())).toBe(0);
    });

    it("counts a pinned-field list by its rows, not by its identity", () => {
      const store = useLayoutStore.getState();
      store.setRegionValues("contextUsage", {
        pinnedFields: [...CONTEXT_USAGE_ROW_KEYS],
      });

      // A fresh array with the same rows in the same order is not a change.
      expect(changeCount(getLayoutSnapshot())).toBe(0);

      store.setRegionValues("contextUsage", { pinnedFields: ["used"] });

      expect(getLayoutSnapshot().overrides).toEqual({
        contextUsage: { pinnedFields: ["used"] },
      });
      expect(changeCount(getLayoutSnapshot())).toBe(1);
    });
  });

  describe("applying a preset (L-133 overturned)", () => {
    it("replaces every value with the preset's, clears the delta, and leaves the arrangement alone", () => {
      const store = useLayoutStore.getState();
      // Placement, order, reading width and a hidden provider all moved from
      // what shipped: none of them is a value, so the apply must keep them all.
      store.setArrangement({
        ...DEFAULT_ARRANGEMENT,
        minimapSide: "left",
        tabStripPlacement: "left",
        sidebarSide: "right",
        usageHost: "header",
        usageSide: "left",
        dock: [...DEFAULT_ARRANGEMENT.dock].reverse(),
        rail: [...DEFAULT_ARRANGEMENT.rail].reverse(),
        hiddenProviders: [DEFAULT_ARRANGEMENT.usageProviders[0]],
        readingWidth: "wide",
      });
      const arrangementBefore = getLayoutSnapshot().arrangement;
      store.setRegionValues("mic", { shown: "hidden" });
      store.setRegionValues("homeTab", { shown: "shown" });

      useLayoutStore.getState().applyPreset("compact");

      expect(getLayoutSnapshot().basePreset).toBe("compact");
      // Applying is total, not a merge: the delta a person had built up under
      // the old base is gone, not re-minimized against the new one.
      expect(getLayoutSnapshot().overrides).toEqual({});
      expect(getLayoutSnapshot().arrangement).toEqual(arrangementBefore);
      expect(
        effectiveLayoutValues("compact", getLayoutSnapshot().overrides),
      ).toEqual(PRESET_VALUES.compact);
    });
  });

  describe("applying a preset that changes nothing", () => {
    it("neither notifies subscribers nor writes storage when the current preset is applied over no overrides", () => {
      const listener = vi.fn();
      const unsubscribe = useLayoutStore.subscribe(listener);
      window.localStorage.clear();

      useLayoutStore.getState().applyPreset(getLayoutSnapshot().basePreset);
      unsubscribe();

      expect(listener).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(LAYOUT_KEY)).toBeNull();
    });

    it("still notifies for a different preset", () => {
      const listener = vi.fn();
      const unsubscribe = useLayoutStore.subscribe(listener);

      useLayoutStore.getState().applyPreset("compact");
      unsubscribe();

      expect(listener).toHaveBeenCalled();
    });

    it("still notifies for the current preset when overrides are present", () => {
      useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
      const listener = vi.fn();
      const unsubscribe = useLayoutStore.subscribe(listener);

      useLayoutStore.getState().applyPreset(getLayoutSnapshot().basePreset);
      unsubscribe();

      expect(listener).toHaveBeenCalled();
      expect(getLayoutSnapshot().overrides).toEqual({});
      expect(getLayoutSnapshot().basePreset).toBe("default");
    });
  });

  describe("the arrangement", () => {
    it("repairs a drag that lands impossibly", () => {
      useLayoutStore.getState().setArrangement({
        ...DEFAULT_ARRANGEMENT,
        toolbarLeft: ["model", "attachImage"],
        toolbarRight: [],
      });

      const { arrangement } = getLayoutSnapshot();

      expect(arrangement.toolbarLeft).toEqual(["attachImage", "access"]);
      expect(arrangement.toolbarRight).toEqual(["model", "mic"]);
    });
  });

  describe("counting", () => {
    it("counts VALUES only, never the arrangement (L-57)", () => {
      const store = useLayoutStore.getState();
      store.setRegionValues("model", { style: "bars" });
      store.setRegionValues("usageLimits", {
        density: "compact",
        reset: false,
      });
      store.setArrangement({
        ...DEFAULT_ARRANGEMENT,
        dock: ["background", "changedFiles", "runningAgents"],
        hiddenProviders: ["codex"],
      });

      // Three values. The reorder and the hidden provider are POSITION, which
      // the header's count deliberately leaves to the per-row dots.
      expect(changeCount(getLayoutSnapshot())).toBe(3);
    });

    it("marks the changed region and leaves the others alone", () => {
      useLayoutStore
        .getState()
        .setRegionValues("usageLimits", { density: "compact" });
      const snapshot = getLayoutSnapshot();

      expect(regionChangedKeys(snapshot, "usageLimits")).toEqual(["density"]);
      expect(regionChangedKeys(snapshot, "model")).toEqual([]);
    });
  });

  describe("the write path parses like a rehydrate (G1-08)", () => {
    it("refuses a value this build has no case for", () => {
      // The registry's control seam writes by a dynamic key, so a typo reaches
      // the store as a real patch. It has to die here rather than render from
      // a default branch for a session and vanish on the next launch.
      const patch: Partial<LayoutValues["mic"]> = {};
      Reflect.set(patch, "shown", "sideways");
      useLayoutStore.getState().setRegionValues("mic", patch);

      expect(getLayoutSnapshot().overrides).toEqual({});
    });
  });

  describe("rehydration", () => {
    it("drops a value this build has no case for and a region it does not know, and keeps a pick the base already makes", async () => {
      await rehydrateFrom({
        basePreset: "compact",
        overrides: {
          // Compact's own model style. Kept, because it is still a pick -
          // and it costs nothing, since nothing measures presence (L-133).
          model: { style: "bars" },
          mic: { shown: "sideways" },
          nowhere: { shown: "hidden" },
          homeTab: { shown: "shown" },
        },
        arrangement: DEFAULT_ARRANGEMENT,
      });

      expect(getLayoutSnapshot().basePreset).toBe("compact");
      expect(getLayoutSnapshot().overrides).toEqual({
        model: { style: "bars" },
        homeTab: { shown: "shown" },
      });
      expect(changeCount(getLayoutSnapshot())).toBe(1);
    });

    it("reads a saved bar checkbox against the record's own preset", async () => {
      // The same stored key means opposite things on two presets: bar off on
      // Default leaves the percent, and bar on on Compact adds a bar beside
      // the percent Compact always had.
      await rehydrateFrom({
        basePreset: "default",
        overrides: { usageLimits: { bar: false } },
        arrangement: DEFAULT_ARRANGEMENT,
      });
      expect(getLayoutSnapshot().overrides).toEqual({
        usageLimits: { readingStyle: "percent" },
      });

      await rehydrateFrom({
        basePreset: "compact",
        overrides: { usageLimits: { bar: true } },
        arrangement: DEFAULT_ARRANGEMENT,
      });
      expect(getLayoutSnapshot().overrides).toEqual({
        usageLimits: { readingStyle: "both" },
      });
    });

    /**
     * The whole of L-142's durability story, end to end through the real
     * persist path: a record written before Todo was a dock member carries a
     * three-entry dock and no value bag for it, and this build has to reach
     * four members with Todo leading the frame - where `ChatLowerDock`
     * already draws it - on its preset's own defaults. No migration, no
     * version bump, nothing to revert (P5).
     *
     * The Hidden-with-a-size half is the part a `shown`-only read would lose:
     * a member switched off keeps the size it would come back at, so turning
     * it on again returns the layout the user left rather than a full row
     * they never asked for.
     *
     * G1-G2 rides the same record: the Message queue was a dock region for a
     * while and stopped being one, so a record from that window carries a
     * `queue` value bag and a `queue` dock entry. This build reads neither
     * back - `resolvePersistedOverrides` has no `queue` key to fill, and
     * `mergeOrder` drops an id the canonical dock order does not name.
     */
    it("materialises the new dock members a stored record predates, sizes intact, and drops a stale queue", async () => {
      await rehydrateFrom({
        basePreset: "default",
        overrides: {
          todo: { shown: "hidden", size: "chip" },
          queue: { shown: "hidden", size: "chip" },
        },
        arrangement: {
          ...DEFAULT_ARRANGEMENT,
          dock: ["queue", "changedFiles", "runningAgents", "background"],
        },
      });

      const snapshot = getLayoutSnapshot();
      expect(snapshot.overrides).not.toHaveProperty("queue");
      expect(snapshot.arrangement.dock).toEqual([
        "todo",
        "changedFiles",
        "runningAgents",
        "background",
      ]);
      const values = effectiveLayoutValues(
        snapshot.basePreset,
        snapshot.overrides,
      );
      expect(values.todo).toEqual({ shown: "hidden", size: "chip" });
    });

    it("falls back to the defaults on a record it cannot read", async () => {
      await rehydrateFrom("not a layout record");

      expect(getLayoutSnapshot()).toEqual(DEFAULT_LAYOUT_SNAPSHOT);
    });

    it("keeps a current-version record's own taskTabLayout regardless of the legacy settings record", async () => {
      // Tab overflow shipped on the settings store before it moved into the
      // arrangement (carried once, on a version-0 or version-1 launch); a
      // record already at this build's version answers for itself, and
      // `migrate` never runs to consult the settings record at all.
      writeSettingsRecord({ taskTabLayout: "shrink" });
      await rehydrateFrom({
        basePreset: "default",
        overrides: {},
        arrangement: { ...DEFAULT_ARRANGEMENT, taskTabLayout: "scroll" },
      });

      expect(getLayoutSnapshot().arrangement.taskTabLayout).toBe("scroll");
    });

    it("takes another window's write through the storage event", async () => {
      writeLayoutRecord({
        basePreset: "detailed",
        overrides: { homeTab: { shown: "shown" } },
        arrangement: DEFAULT_ARRANGEMENT,
      });

      window.dispatchEvent(new StorageEvent("storage", { key: LAYOUT_KEY }));
      await Promise.resolve();

      expect(getLayoutSnapshot().basePreset).toBe("detailed");
      expect(isHomeTabEnabled()).toBe(true);
    });
  });
});

/**
 * A launch that finds no layout record at all (`seedMissingLayoutRecord`
 * writes one at version 0), so `migrateLayoutPersistedState` takes the
 * MISSING/SHIPPED branch and reads whatever the legacy settings and
 * left-panel records hold.
 */
describe("migrating a version-0 launch (no layout record) off the legacy settings and left-panel records", () => {
  beforeEach(reset);
  afterEach(reset);

  it("carries every mapped value whichever store module the entry path loads first", async () => {
    // The order dependence this pins is not hypothetical: a zustand store
    // rewrites its own record through the CURRENT `partialize` on its first
    // write, and both legacy record owners have since dropped the fields the
    // migration reads. They reach that write differently, and this exercises
    // both.
    for (const order of ["layout-first", "owners-first"] as const) {
      reset();
      writeSettingsRecord({
        homeTabEnabled: true,
        contextIndicatorStyle: "ring",
        taskTabLayout: "shrink",
        pinContextUsageBreakdown: true,
        pinnedContextBreakdownFields: ["output", "used"],
        chatTurnMinimapSide: "left",
        showGlobalResourceMonitor: false,
        navigatorResourceMetrics: [],
      });
      writeLeftPanelRecord({
        panelGroups: [
          { panelIds: ["comments", "chats"] },
          { panelIds: ["artifacts", "terminals"] },
          { panelIds: ["browsers"] },
          { panelIds: ["git-diff"] },
          { panelIds: ["pull-requests"] },
          { panelIds: ["file-tree"] },
          { panelIds: ["sharing"] },
        ],
        panelVisibilityOverrideById: {
          comments: false,
          "pull-requests": true,
          "git-diff": "yes",
        },
      });
      vi.resetModules();
      if (order === "owners-first") {
        const settings = await import("@/stores/settings/settings-store");
        settings.useSettingsStore.setState({});
        await import("@/stores/epics/left-panel-store");
      }
      const module = await import("@/stores/layout/layout-store");
      const state = module.useLayoutStore.getState();

      expect(state.overrides, order).toEqual({
        homeTab: { shown: "shown" },
        contextUsage: {
          style: "ring",
          pinBreakdown: true,
          pinnedFields: ["used", "output"],
        },
        resourceMonitor: { shown: "hidden" },
        railComments: { shown: "hidden" },
        railPullRequests: { shown: "shown" },
      });
      expect(state.arrangement.minimapSide, order).toBe("left");
      expect(state.arrangement.taskTabLayout, order).toBe("shrink");
      expect(everyRailPanelId(state.arrangement.rail), order).toEqual([
        "comments",
        "chats",
        "artifacts",
        "terminals",
        "browsers",
        "git-diff",
        "pull-requests",
        "file-tree",
        "sharing",
      ]);
      expect(railStacks(state.arrangement.rail), order).toEqual([
        { kind: "stack", id: "stack:railComments+railAgents" },
        { kind: "stack", id: "stack:railArtifacts+railTerminals" },
      ]);
    }
  });

  it("carries a hidden minimap as hidden, on the default side", async () => {
    writeSettingsRecord({ chatTurnMinimapSide: "hide" });

    const { state } = await relaunchStore();

    expect(state().overrides).toEqual({ minimap: { shown: "hidden" } });
    expect(state().arrangement.minimapSide).toBe(
      DEFAULT_ARRANGEMENT.minimapSide,
    );
  });

  it("carries a legacy group of three panels as one stack naming all three (L-181)", async () => {
    writeLeftPanelRecord({
      panelGroups: [
        { panelIds: ["chats", "artifacts", "terminals"] },
        { panelIds: ["browsers"] },
        { panelIds: ["git-diff"] },
        { panelIds: ["pull-requests"] },
        { panelIds: ["file-tree"] },
        { panelIds: ["sharing"] },
        { panelIds: ["comments"] },
      ],
    });

    const { state } = await relaunchStore();

    expect(everyRailPanelId(state().arrangement.rail)).toEqual([
      "chats",
      "artifacts",
      "terminals",
      "browsers",
      "git-diff",
      "pull-requests",
      "file-tree",
      "sharing",
      "comments",
    ]);
    expect(railStacks(state().arrangement.rail)).toEqual([
      { kind: "stack", id: "stack:railAgents+railArtifacts+railTerminals" },
    ]);
  });

  it("carries nothing from legacy records sitting on the shipped defaults", async () => {
    // Every user hits this migration on the first launch after it lands, not
    // only users who changed something. A value equal to the shipped Default
    // must not be recorded: it would win over an apply's cleared delta and
    // read as "Detailed - Modified" on a layout nobody touched.
    writeSettingsRecord({
      chatTurnMinimapSide: DEFAULT_ARRANGEMENT.minimapSide,
      taskTabLayout: DEFAULT_ARRANGEMENT.taskTabLayout,
      homeTabEnabled: false,
      contextIndicatorStyle: "text",
      pinContextUsageBreakdown: PRESET_VALUES.default.contextUsage.pinBreakdown,
      pinnedContextBreakdownFields: [...CONTEXT_USAGE_ROW_KEYS],
      showGlobalResourceMonitor: true,
    });

    const relaunched = await relaunchStore();

    expect(relaunched.state().overrides).toEqual({});
  });

  it.each([
    {
      // Off is the shipped default, so nothing is recorded.
      name: "a valid empty list turns the agent rows off, which is the default",
      state: { navigatorResourceMetrics: [] },
      monitor: null,
    },
    {
      // The rows' own default is OFF (`SHIPPED_DEFAULT_VALUES.resourceMonitor.agentRows`),
      // so a nonempty list turns them on and that differs from the default -
      // it is recorded alongside the metrics that differ from the shipped set.
      name: "a nonempty list sets each metric from membership, under a hidden monitor",
      state: {
        showGlobalResourceMonitor: false,
        navigatorResourceMetrics: ["memory"],
      },
      monitor: {
        shown: "hidden",
        cpu: false,
        memory: true,
        processes: false,
        agentRows: true,
      },
    },
    {
      // The metrics and the switch equal the shipped Default; only the rows
      // differ (a nonempty list means rows on, the default is off).
      name: "a nonempty list matching the shipped metrics carries only the rows",
      state: {
        showGlobalResourceMonitor: true,
        navigatorResourceMetrics: ["cpu", "processes"],
      },
      monitor: { agentRows: true },
    },
    {
      name: "an invalid list carries no row or metric preference",
      state: {
        showGlobalResourceMonitor: false,
        navigatorResourceMetrics: "cpu",
      },
      monitor: { shown: "hidden" },
    },
  ])(
    "carries the legacy navigator metrics: $name",
    async ({ state, monitor }) => {
      writeSettingsRecord(state);

      const { state: carried } = await relaunchStore();

      expect(carried().overrides).toEqual(
        monitor === null ? {} : { resourceMonitor: monitor },
      );
    },
  );

  it("carries only the context-usage key that differs", async () => {
    writeSettingsRecord({
      pinContextUsageBreakdown: true,
      // Equal to the Default's own list, so this half is not an answer.
      pinnedContextBreakdownFields: [...CONTEXT_USAGE_ROW_KEYS],
    });

    const { state } = await relaunchStore();

    expect(state().overrides).toEqual({ contextUsage: { pinBreakdown: true } });
  });

  it("carries nothing from a record it cannot read", async () => {
    window.localStorage.setItem(SETTINGS_KEY, "{ broken");
    window.localStorage.setItem(LEFT_PANEL_KEY, "[]");

    const relaunched = await relaunchStore();

    expect(relaunched.state()).toEqual(DEFAULT_LAYOUT_SNAPSHOT);
  });
});

/**
 * The one version that ever shipped: desktop-v1.4.0-rc.1's own layout record,
 * `{ statusBar, composer }`, read alongside the same legacy settings and
 * left-panel records version 0 reads.
 */
describe("migrating a version-1 launch (the shipped desktop-v1.4.0-rc.1 record)", () => {
  beforeEach(reset);
  afterEach(reset);

  /** Every field the mapping carries, each holding a NON-default value. */
  function seedFullV1Records(): void {
    writeLayoutRecordAtVersion(
      {
        statusBar: {
          placement: "header",
          mobileFooter: true,
          rateLimits: {
            enabled: false,
            hiddenProviders: ["codex"],
            providers: {
              // Automatic set alongside explicit keys: the keys win (lossy).
              cursor: { automatic: true, limitKeys: ["5h"] },
              // Automatic with no keys: no entry at all.
              grok: { automatic: true, limitKeys: [] },
              antigravity: { automatic: false, limitKeys: ["weekly"] },
            },
            shownProfiles: { "host-1": { codex: ["profile-a", null] } },
            percentMode: "remaining",
            showTimer: false,
            showBar: false,
            showModeWord: false,
          },
          resources: {
            enabled: true,
            metrics: ["cpu", "ramShare"],
            // Never read back: the monitor always reads the host (lossy).
            scope: "desktop-app",
          },
        },
        composer: {
          filesChanged: "compact",
          activeAgents: "compact",
          background: "compact",
          access: "compact",
          attachImage: "hidden",
          mic: "hidden",
          compactButton: "hidden",
          reasoningIndicator: "bars-text",
          reasoningFooterControl: "list",
        },
      },
      1,
    );
    writeSettingsRecord({
      homeTabEnabled: true,
      contextIndicatorStyle: "ring",
      taskTabLayout: "shrink",
      pinContextUsageBreakdown: true,
      pinnedContextBreakdownFields: ["output", "used"],
      chatTurnMinimapSide: "left",
      showGlobalResourceMonitor: false,
      navigatorResourceMetrics: ["cpu"],
    });
    writeLeftPanelRecord({
      panelGroups: [
        // Five members, all carried into one stack: a stack has no cap.
        {
          panelIds: [
            "file-tree",
            "sharing",
            "comments",
            "browsers",
            "terminals",
          ],
        },
        { panelIds: ["chats"] },
        { panelIds: ["artifacts", "git-diff"] },
        { panelIds: ["pull-requests"] },
      ],
      panelVisibilityOverrideById: {
        comments: true,
        browsers: false,
        "pull-requests": true,
        chats: "not-a-boolean",
      },
    });
  }

  const EXPECTED_OVERRIDES = {
    homeTab: { shown: "shown" },
    // The bar is off, so the reading is the percent alone.
    usageLimits: { reset: false, amount: "remaining", readingStyle: "percent" },
    // Header placement: the sidebar chips (cpu) were the only metrics this
    // user saw and picked, so they win over the strip's never-drawn list.
    resourceMonitor: { shown: "hidden", processes: false, agentRows: true },
    contextUsage: {
      style: "ring",
      pinBreakdown: true,
      pinnedFields: ["used", "output"],
      compactButton: "hidden",
    },
    changedFiles: { size: "chip" },
    runningAgents: { size: "chip" },
    background: { size: "chip" },
    access: { size: "chip" },
    attachImage: { shown: "hidden" },
    mic: { shown: "hidden" },
    model: { style: "bars-text", reasoningControl: "list" },
    railComments: { shown: "shown" },
    railBrowsers: { shown: "hidden" },
    railPullRequests: { shown: "shown" },
  };

  function expectFullyCarried(state: LayoutSnapshot): void {
    expect(state.basePreset).toBe("default");
    expect(state.overrides).toEqual(EXPECTED_OVERRIDES);
    expect(state.arrangement).toMatchObject({
      usageHost: "header",
      // Resolved through the pre-L-156 legacy-header rule (L-161): one
      // `usageHost` used to mean both readings, drawn at the bar's right end.
      usageSide: "right",
      resourceHost: "header",
      hiddenProviders: ["codex"],
      providerLimits: {
        cursor: { limitKeys: ["5h"] },
        antigravity: { limitKeys: ["weekly"] },
      },
      shownProfiles: { "host-1": { codex: ["profile-a", null] } },
      minimapSide: "left",
      mobileFooter: true,
      taskTabLayout: "shrink",
    });
    expect(everyRailPanelId(state.arrangement.rail)).toEqual([
      "file-tree",
      "sharing",
      "comments",
      "browsers",
      "terminals",
      "chats",
      "artifacts",
      "git-diff",
      "pull-requests",
    ]);
    expect(railStacks(state.arrangement.rail)).toEqual([
      {
        kind: "stack",
        id: "stack:railFileTree+railSharing+railComments+railBrowsers+railTerminals",
      },
      { kind: "stack", id: "stack:railArtifacts+railGitDiff" },
    ]);
  }

  it("carries every preservable v1 field into the version-7 snapshot, one-shot", async () => {
    seedFullV1Records();

    const first = await relaunchStore();
    expectFullyCarried(first.state());
    expect(storedLayoutVersion()).toBe(7);

    // Simulate the settings store's own module load rewriting its record
    // through today's `partialize`, which no longer carries these fields
    // (`legacy-layout-records.ts`'s whole reason to capture once at load).
    writeSettingsRecord({});

    const second = await relaunchStore();
    // Version 7 now equals the current version, so zustand's `persist` skips
    // `migrate` entirely and the legacy records are never consulted again -
    // proving the carry is one-shot and its result is what persists.
    expect(second.state()).toEqual(first.state());
    expect(storedLayoutVersion()).toBe(7);
  });

  it("takes both Shown switches from the strip's own slice when the readings lived in the strip", async () => {
    writeLayoutRecordAtVersion(
      {
        statusBar: {
          placement: "status-bar",
          rateLimits: { enabled: false },
          resources: { enabled: false },
        },
        composer: {},
      },
      1,
    );
    // The header's switch never drew anything while the strip held the
    // monitor, so it must not decide the carried Shown.
    writeSettingsRecord({ showGlobalResourceMonitor: true });

    const { state } = await relaunchStore();

    expect(state().overrides.usageLimits).toEqual({ shown: "hidden" });
    expect(state().overrides.resourceMonitor).toEqual({ shown: "hidden" });
  });

  describe("the usage reading style from showBar and showModeWord", () => {
    async function readingStyleFor(
      showBar: unknown,
      showModeWord: unknown,
    ): Promise<unknown> {
      writeLayoutRecordAtVersion(
        {
          statusBar: {
            placement: "status-bar",
            rateLimits: { showBar, showModeWord },
          },
          composer: {},
        },
        1,
      );
      const { state } = await relaunchStore();
      return state().overrides.usageLimits?.readingStyle;
    }

    it("reads a bar turned off as the percent alone, whether or not the mode word was on", async () => {
      expect(await readingStyleFor(false, false)).toBe("percent");
      expect(await readingStyleFor(false, true)).toBe("percent");
    });

    it("reads the bar with the mode word off as both", async () => {
      expect(await readingStyleFor(true, false)).toBe("both");
    });

    it("carries nothing for the bar with the mode word on, the shipped reading", async () => {
      expect(await readingStyleFor(true, true)).toBeUndefined();
    });

    it("carries nothing when showBar is not a boolean", async () => {
      expect(await readingStyleFor("yes", false)).toBeUndefined();
      expect(await readingStyleFor(undefined, false)).toBeUndefined();
    });

    it("carries the style under the header placement too", async () => {
      writeLayoutRecordAtVersion(
        {
          statusBar: {
            placement: "header",
            rateLimits: { showBar: false, showModeWord: true },
          },
          composer: {},
        },
        1,
      );

      const { state } = await relaunchStore();

      expect(state().overrides.usageLimits).toEqual({
        readingStyle: "percent",
      });
    });
  });

  describe("the monitor's metrics from the strip list and the sidebar chips", () => {
    async function monitorFor(placement: string): Promise<unknown> {
      writeLayoutRecordAtVersion(
        {
          statusBar: {
            placement,
            resources: { enabled: true, metrics: ["cpu", "ramShare"] },
          },
          composer: {},
        },
        1,
      );
      writeSettingsRecord({ navigatorResourceMetrics: ["memory"] });
      const { state } = await relaunchStore();
      return state().overrides.resourceMonitor;
    }

    // Only a value that differs from the shipped Default is kept (cpu is on
    // there; memory, ramShare and agentRows are off), which is why each
    // expectation names just the metrics that moved.
    it("takes the sidebar chips under the header, where the strip list was never on screen", async () => {
      // Chips are memory alone: memory on, the shipped cpu and processes off,
      // and the strip's ramShare is not carried.
      expect(await monitorFor("header")).toEqual({
        cpu: false,
        memory: true,
        processes: false,
        agentRows: true,
      });
    });

    it("keeps the strip list under the status bar", async () => {
      // The strip list is cpu and ramShare, so the chips' memory is ignored.
      expect(await monitorFor("status-bar")).toEqual({
        processes: false,
        ramShare: true,
        agentRows: true,
      });
    });
  });

  it("produces no overrides for a v1 record already sitting on its own shipped defaults", async () => {
    writeLayoutRecordAtVersion(
      {
        statusBar: {
          placement: "status-bar",
          mobileFooter: false,
          rateLimits: {
            enabled: true,
            hiddenProviders: [],
            providers: {},
            shownProfiles: {},
            percentMode: "used",
            showTimer: true,
            showBar: true,
            showModeWord: true,
          },
          resources: { enabled: true, metrics: ["cpu", "processes"] },
        },
        composer: {
          filesChanged: "visible",
          activeAgents: "visible",
          background: "visible",
          access: "visible",
          attachImage: "visible",
          mic: "visible",
          compactButton: "visible",
          reasoningIndicator: "text",
          reasoningFooterControl: "slider",
        },
      },
      1,
    );
    writeSettingsRecord({
      homeTabEnabled: false,
      contextIndicatorStyle: "text",
      taskTabLayout: "scroll",
      pinContextUsageBreakdown: false,
      pinnedContextBreakdownFields: [...CONTEXT_USAGE_ROW_KEYS],
      chatTurnMinimapSide: "right",
      showGlobalResourceMonitor: true,
    });

    const { state } = await relaunchStore();

    expect(state().overrides).toEqual({});
  });
});

/**
 * Versions 2 through 6 were written only by pre-release builds of this store,
 * never shipped, and are deliberately not reused: zustand skips `migrate` when
 * the stored version equals the current one, so reusing one of them would load
 * a development record as-is. Any of them - and any future version this build
 * has never written - resets to the defaults rather than guessing at a shape
 * it never defined.
 */
describe("migrating an unrecognized version resets to the defaults", () => {
  beforeEach(reset);
  afterEach(reset);

  it.each([
    {
      version: 2,
      state: {
        basePreset: "default",
        overrides: {},
        arrangement: {
          ...DEFAULT_ARRANGEMENT,
          rail: [
            { kind: "panel", id: "railAgents" },
            { kind: "divider", id: "divider:1" },
            ...DEFAULT_ARRANGEMENT.rail.slice(1),
          ],
          dividerSeq: 1,
        },
      },
    },
    {
      version: 4,
      state: {
        basePreset: "compact",
        overrides: { resourceMonitor: { shown: "hidden" } },
        arrangement: DEFAULT_ARRANGEMENT,
      },
    },
    {
      version: 5,
      state: {
        basePreset: "default",
        overrides: { resourceMonitor: { shown: "hidden", agentRows: true } },
        arrangement: DEFAULT_ARRANGEMENT,
      },
    },
    {
      version: 6,
      state: {
        basePreset: "detailed",
        overrides: { model: { style: "bars" } },
        arrangement: { ...DEFAULT_ARRANGEMENT, taskTabLayout: "shrink" },
      },
    },
    {
      version: 99,
      state: {
        basePreset: "compact",
        overrides: { model: { style: "bars" } },
        arrangement: { ...DEFAULT_ARRANGEMENT, minimapSide: "left" },
      },
    },
  ])(
    "resets a version-$version record to the defaults without throwing, and rewrites it at version 7",
    async ({ version, state }) => {
      await rehydrateFromVersion(state, version);

      expect(getLayoutSnapshot()).toEqual(DEFAULT_LAYOUT_SNAPSHOT);
      expect(storedLayoutVersion()).toBe(7);
    },
  );
});
