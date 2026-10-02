import { beforeEach, describe, expect, it } from "vitest";
import {
  layoutModified,
  providerChanged,
  resetLayout,
  resetWouldChange,
  usageProvidersChanged,
} from "@/lib/layout/layout-diff";
import {
  AUTOMATIC_LIMIT_SELECTION,
  DEFAULT_ARRANGEMENT,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The page's safety net (L-20, P-6).
 *
 * The full-width host has no session, so it has no Undo, no Discard and no
 * Cmd+Z, and applying a preset clears the delta by construction. These
 * are the predicates a changed dot and a per-row revert read for the three
 * arrangement fields nothing measured - `hiddenProviders`, `providerLimits`
 * and `mobileFooter` - and the floor underneath all of them.
 */

const PROVIDER: RateLimitProviderId = DEFAULT_ARRANGEMENT.usageProviders[0];
const OTHER_PROVIDER: RateLimitProviderId =
  DEFAULT_ARRANGEMENT.usageProviders[1];

function snapshotWith(arrangement: LayoutArrangement): LayoutSnapshot {
  return { basePreset: "default", overrides: {}, arrangement };
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
});

describe("one provider's own state", () => {
  it("is unchanged until it is hidden or its limits are picked", () => {
    expect(providerChanged(DEFAULT_ARRANGEMENT, PROVIDER)).toBe(false);

    const hidden: LayoutArrangement = {
      ...DEFAULT_ARRANGEMENT,
      hiddenProviders: [PROVIDER],
    };
    expect(providerChanged(hidden, PROVIDER)).toBe(true);
    expect(providerChanged(hidden, OTHER_PROVIDER)).toBe(false);

    const picked: LayoutArrangement = {
      ...DEFAULT_ARRANGEMENT,
      providerLimits: { [PROVIDER]: { limitKeys: ["5h"] } },
    };
    expect(providerChanged(picked, PROVIDER)).toBe(true);
  });

  it("never reaches the store at all, so it is not a stored difference either", () => {
    // The writer deletes the key on the way back to Automatic; a map
    // rehydrated from an older write can still carry one, but every write
    // path normalizes it away (`withoutAutomaticLimits`), so a snapshot that
    // actually went through the store never holds an Automatic entry to
    // measure - not visibly (R1-03), and not as a stored-record difference
    // either.
    useLayoutStore.getState().setArrangement({
      ...DEFAULT_ARRANGEMENT,
      providerLimits: { [PROVIDER]: AUTOMATIC_LIMIT_SELECTION },
    });
    const stored = useLayoutStore.getState().arrangement;

    expect(stored.providerLimits).toEqual({});
    expect(providerChanged(stored, PROVIDER)).toBe(false);
    expect(usageProvidersChanged(stored)).toBe(false);
    expect(resetWouldChange(snapshotWith(stored))).toBe(false);
  });
});

describe("what the page can see as changed", () => {
  it("counts hidden providers and a reorder as the Profiles list changing, never picked limits", () => {
    expect(usageProvidersChanged(DEFAULT_ARRANGEMENT)).toBe(false);
    expect(
      usageProvidersChanged({
        ...DEFAULT_ARRANGEMENT,
        hiddenProviders: [PROVIDER],
      }),
    ).toBe(true);
    // Limits are edited in Settings ▸ Providers, not in the Profiles list.
    expect(
      usageProvidersChanged({
        ...DEFAULT_ARRANGEMENT,
        providerLimits: { [PROVIDER]: { limitKeys: ["5h"] } },
      }),
    ).toBe(false);
    expect(
      usageProvidersChanged({
        ...DEFAULT_ARRANGEMENT,
        usageProviders: [...DEFAULT_ARRANGEMENT.usageProviders].reverse(),
      }),
    ).toBe(true);
  });

  it("answers for the whole arrangement, field by field", () => {
    expect(layoutModified(snapshotWith(DEFAULT_ARRANGEMENT))).toBe(false);
    const eachOne: ReadonlyArray<Partial<LayoutArrangement>> = [
      { usageHost: "header" },
      { minimapSide: "left" },
      { resourceSide: "left" },
      { mobileFooter: true },
      { hiddenProviders: [PROVIDER] },
      { dock: [...DEFAULT_ARRANGEMENT.dock].reverse() },
      { tabStripPlacement: "left" },
      { sidebarSide: "right" },
      { sideStripView: "activity" },
      { taskTabLayout: "shrink" },
      { readingWidth: "wide" },
      { wideReadingWidthPx: 1600 },
    ];
    for (const patch of eachOne) {
      expect(
        layoutModified(snapshotWith({ ...DEFAULT_ARRANGEMENT, ...patch })),
        JSON.stringify(patch),
      ).toBe(true);
    }
  });
});

describe("Reset layout (L-20)", () => {
  it("puts back the preset, every value and every arrangement field", () => {
    const before: LayoutSnapshot = {
      basePreset: "compact",
      overrides: { minimap: { shown: "hidden" } },
      arrangement: {
        ...DEFAULT_ARRANGEMENT,
        usageHost: "header",
        minimapSide: "left",
        resourceSide: "left",
        mobileFooter: true,
        hiddenProviders: [PROVIDER],
        providerLimits: { [PROVIDER]: { limitKeys: ["5h"] } },
        dock: [...DEFAULT_ARRANGEMENT.dock].reverse(),
        usageProviders: [...DEFAULT_ARRANGEMENT.usageProviders].reverse(),
        // S-29: "Reset layout" restores the tab strip placement and the
        // sidebar side too.
        tabStripPlacement: "right",
        sidebarSide: "right",
        // D8: and the vertical strip's view.
        sideStripView: "activity",
        wideReadingWidthPx: 1600,
      },
    };

    const after = resetLayout(before);

    expect(after.basePreset).toBe("default");
    expect(after.overrides).toEqual({});
    expect(layoutModified(after)).toBe(false);
    expect(resetWouldChange(after)).toBe(false);
    expect(after.arrangement.tabStripPlacement).toBe("top");
    expect(after.arrangement.sidebarSide).toBe("left");
    expect(after.arrangement.sideStripView).toBe("layered");
    expect(after.arrangement.wideReadingWidthPx).toBe(
      DEFAULT_ARRANGEMENT.wideReadingWidthPx,
    );
  });

  it("never hands a divider id back out, which is the one field it keeps", () => {
    const before = snapshotWith({
      ...DEFAULT_ARRANGEMENT,
      dividerSeq: DEFAULT_ARRANGEMENT.dividerSeq + 7,
    });

    expect(resetLayout(before).arrangement.dividerSeq).toBe(
      DEFAULT_ARRANGEMENT.dividerSeq + 7,
    );
  });

  it("has nothing to do on a snapshot that is already the shipped one", () => {
    expect(resetWouldChange(snapshotWith(DEFAULT_ARRANGEMENT))).toBe(false);
    expect(
      resetWouldChange({
        ...snapshotWith(DEFAULT_ARRANGEMENT),
        basePreset: "compact",
      }),
    ).toBe(true);
  });

  it("is true for a stored choice the change list leaves out, even at Default", () => {
    // Which profiles the usage popover shows is picked where it is drawn, not
    // in the layout form - `layoutModified` never sees it - but it is still
    // part of the stored record, so a reset would still clear it.
    const withProfile = snapshotWith({
      ...DEFAULT_ARRANGEMENT,
      shownProfiles: { "host-1": { [PROVIDER]: ["profile-1"] } },
    });

    expect(layoutModified(withProfile)).toBe(false);
    expect(resetWouldChange(withProfile)).toBe(true);
  });
});
