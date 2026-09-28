import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ARRANGEMENT,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import {
  layoutChanges,
  layoutModified,
  revertLayoutChange,
  type ArrangementChange,
} from "@/lib/layout/layout-diff";
import { PRESET_VALUES } from "@/lib/layout/layout-presets";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  getLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The change list (`layout-diff.ts`) read through the real store: what counts
 * as modified once a preset is applied, the baseline a value line measures
 * against, how arrangement lines group, and what each kind of revert puts
 * back. `applyPreset` itself is owned by `layout-store.test.ts`.
 */

function reset(): void {
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  window.localStorage.clear();
}

beforeEach(reset);
afterEach(reset);

const PROVIDER = DEFAULT_ARRANGEMENT.usageProviders[0];

describe("layoutModified", () => {
  it("tracks a value pick, an arrangement move and an apply, each independently", () => {
    expect(layoutModified(getLayoutSnapshot())).toBe(false);

    useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
    expect(layoutModified(getLayoutSnapshot())).toBe(true);

    // Set back to the preset's own value: no longer a change.
    useLayoutStore.getState().setRegionValues("mic", { shown: "shown" });
    expect(layoutModified(getLayoutSnapshot())).toBe(false);

    useLayoutStore
      .getState()
      .setArrangement({ ...DEFAULT_ARRANGEMENT, sidebarSide: "right" });
    expect(layoutModified(getLayoutSnapshot())).toBe(true);

    useLayoutStore.getState().setArrangement(DEFAULT_ARRANGEMENT);
    expect(layoutModified(getLayoutSnapshot())).toBe(false);

    // Applying Compact with nothing else changed: unmodified under its own
    // preset, which is a different fact from `anythingChanged` (basePreset
    // itself moved away from Default).
    useLayoutStore.getState().applyPreset("compact");
    expect(layoutModified(getLayoutSnapshot())).toBe(false);
    expect(getLayoutSnapshot().basePreset).toBe("compact");
  });
});

describe("the change list", () => {
  it("a style line's baseline is the last-applied preset's own value", () => {
    useLayoutStore.getState().applyPreset("compact");
    useLayoutStore.getState().setRegionValues("model", { style: "text" });

    const changes = layoutChanges(getLayoutSnapshot());

    expect(changes.styles).toEqual([
      {
        kind: "value",
        region: "model",
        key: "style",
        current: "text",
        baseline: PRESET_VALUES.compact.model.style,
      },
    ]);
  });

  it("groups arrangement lines by field, order and provider", () => {
    useLayoutStore.getState().setArrangement({
      ...DEFAULT_ARRANGEMENT,
      sidebarSide: "right",
      dock: [...DEFAULT_ARRANGEMENT.dock].reverse(),
      hiddenProviders: [PROVIDER],
    });

    const changes = layoutChanges(getLayoutSnapshot());

    expect(changes.arrangement).toEqual([
      {
        kind: "field",
        field: "sidebarSide",
        current: "right",
        baseline: "left",
      },
      { kind: "order", group: "dock" },
      { kind: "provider", providerId: PROVIDER },
    ]);
  });

  it("revertLayoutChange on a value line puts back only that key", () => {
    useLayoutStore.getState().setRegionValues("mic", { shown: "hidden" });
    useLayoutStore.getState().setRegionValues("homeTab", { shown: "shown" });

    const change = layoutChanges(getLayoutSnapshot()).styles.find(
      (candidate) => candidate.region === "mic",
    );
    if (change === undefined) throw new Error("expected a mic change");

    useLayoutStore
      .getState()
      .replaceAll(revertLayoutChange(getLayoutSnapshot(), change));

    expect(getLayoutSnapshot().overrides).toEqual({
      homeTab: { shown: "shown" },
    });
  });

  const revertCases: ReadonlyArray<{
    readonly kind: ArrangementChange["kind"];
    readonly arrangement: LayoutArrangement;
    readonly remaining: ReadonlyArray<ArrangementChange["kind"]>;
  }> = [
    {
      kind: "field",
      arrangement: {
        ...DEFAULT_ARRANGEMENT,
        sidebarSide: "right",
        dock: [...DEFAULT_ARRANGEMENT.dock].reverse(),
        hiddenProviders: [PROVIDER],
      },
      remaining: ["order", "provider"],
    },
    {
      kind: "order",
      arrangement: {
        ...DEFAULT_ARRANGEMENT,
        dock: [...DEFAULT_ARRANGEMENT.dock].reverse(),
        hiddenProviders: [PROVIDER],
      },
      remaining: ["provider"],
    },
    {
      kind: "provider",
      arrangement: { ...DEFAULT_ARRANGEMENT, hiddenProviders: [PROVIDER] },
      remaining: [],
    },
  ];

  it.each(revertCases)(
    "revertLayoutChange on a $kind line puts back only that line",
    ({ kind, arrangement, remaining }) => {
      useLayoutStore.getState().setArrangement(arrangement);
      const change = layoutChanges(getLayoutSnapshot()).arrangement.find(
        (candidate) => candidate.kind === kind,
      );
      if (change === undefined) throw new Error(`expected a ${kind} change`);

      useLayoutStore
        .getState()
        .replaceAll(revertLayoutChange(getLayoutSnapshot(), change));

      expect(
        layoutChanges(getLayoutSnapshot()).arrangement.map(
          (candidate) => candidate.kind,
        ),
      ).toEqual(remaining);
    },
  );
});
