import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusBarRateLimitWindow } from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import {
  AUTOMATIC_LIMIT_SELECTION,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import { providerChanged, resetWouldChange } from "@/lib/layout/layout-diff";
import { USAGE_PROVIDER_LEVEL } from "@/components/layout-editor/regions/usage-provider-level";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  getLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The one boundary: what the host has READ for this provider. The pick is
 * forbidden a query of its own (L-96), so the windows arrive through the
 * reader's own passive read - mocked here to the two shapes that matter, a
 * provider with limits and a provider nobody has read yet.
 *
 * Mocked at `ProviderLimitWindowsReader` rather than at the `useProviderLimitWindows`
 * hook it used to be: the reader's OWN routing (credit-only bypass, an
 * unusable explicit pick) is proved for real against its real dependencies in
 * `provider-limit-windows.test.tsx` / `provider-limit-windows-scoped-cache.test.tsx` -
 * this mock always calls through to `children`, which is what lets the tests
 * below prove `provider-limits.tsx`'s OWN independent guard (the credit-only
 * `isWindowedRateLimitProvider` check inside `ProviderLimitsPick`) holds even
 * when fed live windows, rather than only because the reader withheld them.
 */
const live = vi.hoisted(() => ({
  windows: [] as ReadonlyArray<StatusBarRateLimitWindow>,
  drawnKeys: [] as ReadonlyArray<string>,
}));
vi.mock("@/components/layout-editor/inspector/provider-limit-windows", () => ({
  ProviderLimitWindowsReader: (props: {
    readonly providerId: RateLimitProviderId;
    readonly children: (limits: typeof live) => ReactNode;
  }) => props.children(live),
}));

const navigation = vi.hoisted(() => ({
  navigateToLayoutRegion: vi.fn(),
  navigateToLayoutRegionRow: vi.fn(),
}));
vi.mock("@/lib/settings-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings-navigation")>()),
  navigateToLayoutRegion: navigation.navigateToLayoutRegion,
  navigateToLayoutRegionRow: navigation.navigateToLayoutRegionRow,
}));

import { ProviderLimitsControl } from "@/components/layout-editor/inspector/provider-limits";
import { LayoutFormHostContext } from "@/components/layout-editor/inspector/layout-form-host";

const PROVIDER: RateLimitProviderId = "claude-code";
const CREDIT_PROVIDER: RateLimitProviderId = "kilocode";

function limitWindow(
  windowKey: string,
  label: string,
): StatusBarRateLimitWindow {
  return {
    windowKey,
    label,
    labelIsDuration: true,
    kind: "session",
    usedPercent: 40,
    resetsAt: null,
    severity: "healthy",
  };
}

function arrangement(): LayoutArrangement {
  return useLayoutStore.getState().arrangement;
}

function selection() {
  return arrangement().providerLimits[PROVIDER] ?? AUTOMATIC_LIMIT_SELECTION;
}

function limitsMode(): string | null {
  const group = screen.getByRole("radiogroup", { name: "Limits" });
  const on = [...group.querySelectorAll('[role="radio"]')].find(
    (option) => option.getAttribute("aria-checked") === "true",
  );
  return on?.textContent ?? null;
}

beforeEach(() => {
  live.windows = [limitWindow("5h", "5h"), limitWindow("week", "Weekly")];
  live.drawnKeys = ["5h"];
  window.localStorage.clear();
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.setState({
    instances: new Map(),
    dockMode: "right",
    lockedBy: "none",
  });
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

describe('the provider row\'s "Choose..." checklist (L-96, I-14)', () => {
  it("opens the provider's own live windows and draws the one it was showing", () => {
    render(<ProviderLimitsControl providerId={PROVIDER} />);

    // Automatic is the default, and it offers no list at all.
    expect(limitsMode()).toBe("Automatic (recommended)");
    expect(screen.queryByRole("group", { name: "Limits to draw" })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Choose..." }));

    const list = screen.getByRole("group", { name: "Limits to draw" });
    expect(
      [...list.querySelectorAll("label")].map((row) => row.textContent),
    ).toEqual(["5h", "Weekly"]);
    // Seeded from what the strip was already drawing, so taking control of
    // the pick does not change the picture in the same gesture.
    expect(selection()).toEqual({ limitKeys: ["5h"] });
  });

  it("ticks a second limit into the selection, in catalog order", () => {
    render(<ProviderLimitsControl providerId={PROVIDER} />);
    fireEvent.click(screen.getByRole("radio", { name: "Choose..." }));

    fireEvent.click(screen.getByRole("checkbox", { name: "Weekly" }));
    expect(selection().limitKeys).toEqual(["5h", "week"]);

    // Order comes from the catalog, never from the order they were ticked.
    fireEvent.click(screen.getByRole("checkbox", { name: "5h" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "5h" }));
    expect(selection().limitKeys).toEqual(["5h", "week"]);
  });

  it("keeps at least one limit ticked", () => {
    render(<ProviderLimitsControl providerId={PROVIDER} />);
    fireEvent.click(screen.getByRole("radio", { name: "Choose..." }));

    const only = screen.getByRole("checkbox", { name: "5h" });
    expect(only.hasAttribute("disabled")).toBe(true);
    fireEvent.click(only);
    expect(selection().limitKeys).toEqual(["5h"]);
  });

  it("leaves NOTHING changed on the way back to Automatic (R1-03)", () => {
    render(<ProviderLimitsControl providerId={PROVIDER} />);
    fireEvent.click(screen.getByRole("radio", { name: "Choose..." }));
    expect(providerChanged(arrangement(), PROVIDER)).toBe(true);

    fireEvent.click(
      screen.getByRole("radio", { name: "Automatic (recommended)" }),
    );

    // Byte-identical to the shipped layout, so there is nothing to revert, no
    // dot to draw on the provider, and no "Reset
    // layout..." - a confirmed, irreversible action - to offer.
    expect(arrangement().providerLimits).toEqual({});
    expect(providerChanged(arrangement(), PROVIDER)).toBe(false);
    expect(resetWouldChange(getLayoutSnapshot())).toBe(false);
    // And the checklist goes with the picks.
    expect(screen.queryByRole("group", { name: "Limits to draw" })).toBeNull();
  });

  it("keeps a pick the host no longer reports when another is ticked (R1-16)", () => {
    // A stored selection naming a window this reading does not carry - a 7d
    // limit the user picked on a reading they have since moved past.
    useLayoutStore.getState().setArrangement({
      ...useLayoutStore.getState().arrangement,
      providerLimits: {
        [PROVIDER]: { limitKeys: ["5h", "7d"] },
      },
    });
    render(<ProviderLimitsControl providerId={PROVIDER} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Weekly" }));

    // The live ones in catalog order, then the pick nobody can see - never a
    // silent prune of what the user chose.
    expect(selection().limitKeys).toEqual(["5h", "week", "7d"]);
  });

  it("is one undoable gesture per tick", () => {
    render(<ProviderLimitsControl providerId={PROVIDER} />);
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });

    fireEvent.click(screen.getByRole("radio", { name: "Choose..." }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Weekly" }));
    expect(selection().limitKeys).toEqual(["5h", "week"]);

    useLayoutEditorStore.getState().undo();
    expect(selection().limitKeys).toEqual(["5h"]);
    useLayoutEditorStore.getState().undo();
    expect(selection()).toEqual(AUTOMATIC_LIMIT_SELECTION);
  });

  it("disables Choose... with a reason while empty, and the reason names an element aria-describedby actually points at", () => {
    live.windows = [];
    live.drawnKeys = [];
    render(<ProviderLimitsControl providerId={PROVIDER} />);

    const choose = screen.getByRole("radio", { name: "Choose..." });
    expect(choose.hasAttribute("disabled")).toBe(true);
    const describedById = choose.getAttribute("aria-describedby");
    expect(describedById).not.toBeNull();
    const reason = document.getElementById(describedById as string);
    expect(reason?.textContent).toBe(USAGE_PROVIDER_LEVEL.limitsEmpty);

    // Functionally inert, not just visually: a disabled radio must not flip
    // the mode on a click, which is the difference `aria-disabled` alone
    // would not have guaranteed.
    fireEvent.click(choose);
    expect(limitsMode()).toBe("Automatic (recommended)");
    expect(selection()).toEqual(AUTOMATIC_LIMIT_SELECTION);
    expect(screen.queryByRole("group", { name: "Limits to draw" })).toBeNull();
  });

  it("shows Automatic over a STALE stored pick while the reading is empty, and re-activates it once the host warms back up", () => {
    // The bug this guards: the segmented value used to key off
    // `selection.limitKeys.length > 0` alone, ignoring `windows.length` - so
    // a provider that had a stored pick and then reported nothing showed
    // "Choose..." checked with no checklist under it, a broken half-state.
    useLayoutStore.getState().setArrangement({
      ...useLayoutStore.getState().arrangement,
      providerLimits: { [PROVIDER]: { limitKeys: ["5h", "week"] } },
    });
    live.windows = [];
    live.drawnKeys = [];
    const { rerender } = render(
      <ProviderLimitsControl providerId={PROVIDER} />,
    );
    expect(limitsMode()).toBe("Automatic (recommended)");
    expect(screen.queryByRole("group", { name: "Limits to draw" })).toBeNull();
    // Untouched: an empty reading must not rewrite or clear the arrangement,
    // only change what is DRAWN from it.
    expect(selection()).toEqual({ limitKeys: ["5h", "week"] });

    live.windows = [limitWindow("5h", "5h"), limitWindow("week", "Weekly")];
    live.drawnKeys = ["5h"];
    rerender(<ProviderLimitsControl providerId={PROVIDER} />);

    expect(limitsMode()).toBe("Choose...");
    const list = screen.getByRole("group", { name: "Limits to draw" });
    expect(
      [...list.querySelectorAll("label")].map((row) => row.textContent),
    ).toEqual(["5h", "Weekly"]);
    expect(selection()).toEqual({ limitKeys: ["5h", "week"] });
  });
});

describe("credit-only providers (isWindowedRateLimitProvider: false) never get a Limits pick", () => {
  it("draws nothing at all, even when fed live windows and a stale stored pick", () => {
    // The mocked reader (top of file) always calls through to `children` with
    // whatever `live` holds - non-empty by `beforeEach` - so this proves
    // `provider-limits.tsx`'s OWN `isWindowedRateLimitProvider` guard, not the
    // reader's bypass (that half is `provider-limit-windows.test.tsx`'s). The
    // stored pick is left over from when this id was (or is later) a
    // windowed provider: migrated state the UI cannot write today, which must
    // never surface as a checklist.
    useLayoutStore.getState().setArrangement({
      ...useLayoutStore.getState().arrangement,
      providerLimits: { [CREDIT_PROVIDER]: { limitKeys: ["5h"] } },
    });
    const { container } = render(
      <ProviderLimitsControl providerId={CREDIT_PROVIDER} />,
    );

    expect(screen.queryByRole("radiogroup", { name: "Limits" })).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});

describe("what a hidden provider's limits look like (L-08)", () => {
  function hideProvider(): void {
    const arrangement = useLayoutStore.getState().arrangement;
    useLayoutStore.setState({
      arrangement: { ...arrangement, hiddenProviders: [PROVIDER] },
    });
  }

  function hideUsageLimits(): void {
    useLayoutStore.getState().setRegionValues("usageLimits", {
      shown: "hidden",
    });
  }

  const CASES: ReadonlyArray<{
    readonly name: string;
    readonly hide: () => void;
    readonly reason: string;
  }> = [
    {
      name: "the provider is hidden in Layout > Usage limits > Profiles",
      hide: hideProvider,
      reason: "Hidden in Layout > Usage limits > Profiles.",
    },
    {
      name: "the usage readings are hidden as a whole",
      hide: hideUsageLimits,
      reason: "Usage limits are hidden in Layout.",
    },
  ];

  it.each(CASES)(
    "greys the limits in place, with the reason and a link to Layout, when $name",
    ({ hide, reason }) => {
      hide();
      render(<ProviderLimitsControl providerId={PROVIDER} />);

      // Still readable. A disabled `fieldset` turns off every control under it
      // without hiding any of them, so a screen-reader user who turned a
      // provider off can still read what its greyed limits say (L-08's "greyed
      // in place", rather than `inert`'s "gone from the tree") - and the group
      // is described by the reason, so it is heard on the control it explains.
      const mode = screen.getByRole("radiogroup", { name: "Limits" });
      const group = mode.closest("fieldset");
      expect(group?.disabled).toBe(true);
      const line = screen.getByText(reason);
      expect(line.getAttribute("data-row-availability")).toBe("disabled");
      expect(group?.getAttribute("aria-describedby")).toBe(line.id);
      expect(
        within(line).getByRole("button", { name: "Open Layout" }),
      ).toBeTruthy();
    },
  );

  describe("the link lands on the switch that decides it (U5)", () => {
    // Settings > Providers draws this control in the page host.
    function renderOnProvidersPage(): void {
      render(
        <LayoutFormHostContext value="page">
          <ProviderLimitsControl providerId={PROVIDER} />
        </LayoutFormHostContext>,
      );
    }

    beforeEach(() => {
      navigation.navigateToLayoutRegion.mockReset();
      navigation.navigateToLayoutRegionRow.mockReset();
    });

    it("lands on this provider's own row in the Profiles list when only the provider is hidden", () => {
      hideProvider();
      renderOnProvidersPage();

      fireEvent.click(screen.getByRole("button", { name: "Open Layout" }));

      expect(
        navigation.navigateToLayoutRegionRow,
      ).toHaveBeenCalledExactlyOnceWith("usageLimits", PROVIDER);
      expect(navigation.navigateToLayoutRegion).not.toHaveBeenCalled();
    });

    it("lands on the Usage limits row itself when the readings are hidden as a whole", () => {
      hideUsageLimits();
      renderOnProvidersPage();

      fireEvent.click(screen.getByRole("button", { name: "Open Layout" }));

      expect(navigation.navigateToLayoutRegion).toHaveBeenCalledExactlyOnceWith(
        "usageLimits",
      );
      expect(navigation.navigateToLayoutRegionRow).not.toHaveBeenCalled();
    });

    it("names the readings, not the provider, when both are hidden: the switch above decides first", () => {
      hideProvider();
      hideUsageLimits();
      renderOnProvidersPage();

      expect(
        screen.getByText("Usage limits are hidden in Layout."),
      ).toBeTruthy();
      expect(screen.queryByText(/Hidden in Layout > Usage limits/)).toBeNull();
    });
  });

  it("draws no reason and leaves the controls operable while the provider and the readings are shown", () => {
    render(<ProviderLimitsControl providerId={PROVIDER} />);

    const group = screen
      .getByRole("radiogroup", { name: "Limits" })
      .closest("fieldset");
    expect(group?.disabled).toBe(false);
    expect(screen.queryByText(/Hidden in Layout|hidden in Layout/)).toBeNull();
  });
});
