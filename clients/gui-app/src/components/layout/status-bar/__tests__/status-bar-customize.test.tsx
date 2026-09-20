import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StatusBarGhost } from "@/components/layout/status-bar/status-bar-ghost";
import { StatusBarProviderSegment } from "@/components/layout/status-bar/status-bar-provider-segment";
import type { StatusBarProviderSegmentModel } from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { getCustomizeOptions } from "@/lib/customize/customize-options";
import { registerStatusBarCustomizeOptions } from "@/lib/customize/options/status-bar-options";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { useCustomizeStore } from "@/stores/customize/customize-store";

/**
 * DROP-IN REPLACEMENT for
 * components/layout/status-bar/__tests__/status-bar-customize.test.tsx.
 *
 * Wave-3 fixup regression (review w3):
 * - Should-fix 7 ("multiple accounts collide on a provider hotspot key") -
 *   `StatusBarProviderSegment` now keys its hotspot's tileId on
 *   `statusBarSegmentKey(segment)` (providerId + profileId), not the bare
 *   providerId. New describe block below proves two accounts of the same
 *   provider register two independent instances and that unmounting one
 *   does not delete the other's key.
 * - `statusBar.provider`'s control is now a "composite" (toggle primary +
 *   a "Limits" `more` leaf, `providerControls()` in status-bar-options.ts)
 *   instead of a bare "toggle". The original assertion
 *   `expect(options?.control?.kind).toBe("toggle")` is now false and the
 *   `options.control.change(true)` call below it would throw (no `change`
 *   on a composite control) - fixed to read `.primary`.
 */

registerStatusBarCustomizeOptions();

function segmentFixture(
  overrides: Partial<StatusBarProviderSegmentModel>,
): StatusBarProviderSegmentModel {
  return {
    providerId: "codex",
    profileId: null,
    account: null,
    hidden: false,
    state: "live",
    reason: null,
    windows: [],
    shown: [],
    tightest: null,
    ...overrides,
  };
}

const PARTS = { modeWord: true, timer: false, bar: true } as const;

function startSession(): void {
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    history: { past: [], future: [] },
    announcement: "",
  });
}

function providerInstances() {
  return [...useCustomizeStore.getState().instances.values()].filter(
    (candidate) => candidate.settingId === "statusBar.provider",
  );
}

beforeEach(() => {
  useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  useCustomizeStore.setState({ session: null, instances: new Map() });
});
afterEach(cleanup);

describe("StatusBarGhost", () => {
  it("renders nothing outside a Customize session", () => {
    render(<StatusBarGhost />);
    expect(screen.queryByTestId("status-bar-ghost")).toBeNull();
  });

  it("renders and registers a hotspot while editing", () => {
    startSession();
    render(<StatusBarGhost />);
    const ghost = screen.getByTestId("status-bar-ghost");
    expect(ghost).not.toBeNull();
    const instance = [...useCustomizeStore.getState().instances.values()].find(
      (candidate) => candidate.settingId === "statusBar.placement",
    );
    expect(instance).toBeDefined();
    expect(instance?.ghost).toBe(true);
  });
});

describe("StatusBarProviderSegment ghosting + options", () => {
  it("ghosts a hidden provider and its option toggle restores it", () => {
    startSession();
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        rateLimits: {
          ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
          hiddenProviders: ["codex"],
        },
      },
    });
    render(
      <TooltipProvider>
        <StatusBarProviderSegment
          segment={segmentFixture({ hidden: true })}
          parts={PARTS}
          percentMode="used"
          interactive
        />
      </TooltipProvider>,
    );
    const instance = [...useCustomizeStore.getState().instances.values()].find(
      (candidate) => candidate.settingId === "statusBar.provider",
    );
    expect(instance).toBeDefined();
    expect(instance?.ghost).toBe(true);
    expect(instance?.condition).toBe("Hidden from the status bar");

    const options = instance ? getCustomizeOptions(instance) : null;
    // Was: expect(options?.control?.kind).toBe("toggle") - the provider
    // control is now a "composite" (toggle primary + "Limits" more-leaf),
    // so the toggle to exercise is `.control.primary`.
    expect(options?.control?.kind).toBe("composite");
    const primary =
      options?.control?.kind === "composite" ? options.control.primary : null;
    expect(primary?.kind).toBe("toggle");
    act(() => {
      if (primary?.kind === "toggle") primary.change(true);
    });
    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
    ).not.toContain("codex");
  });
});

describe("StatusBarProviderSegment per-account registration (review w3, should-fix 7)", () => {
  it("registers one hotspot instance per account sharing a provider, distinct by tileId", () => {
    startSession();
    render(
      <TooltipProvider>
        <StatusBarProviderSegment
          segment={segmentFixture({ profileId: "acct-a" })}
          parts={PARTS}
          percentMode="used"
          interactive
        />
        <StatusBarProviderSegment
          segment={segmentFixture({ profileId: "acct-b" })}
          parts={PARTS}
          percentMode="used"
          interactive
        />
      </TooltipProvider>,
    );

    const instances = providerInstances();
    expect(instances).toHaveLength(2);
    expect(new Set(instances.map((instance) => instance.tileId))).toEqual(
      new Set(["codex:acct-a", "codex:acct-b"]),
    );
  });

  it("unregistering one account's segment leaves its sibling account registered", () => {
    startSession();
    const segmentA = (
      <StatusBarProviderSegment
        segment={segmentFixture({ profileId: "acct-a" })}
        parts={PARTS}
        percentMode="used"
        interactive
      />
    );
    const segmentB = (
      <StatusBarProviderSegment
        segment={segmentFixture({ profileId: "acct-b" })}
        parts={PARTS}
        percentMode="used"
        interactive
      />
    );
    const { rerender } = render(
      <TooltipProvider>
        {segmentA}
        {segmentB}
      </TooltipProvider>,
    );
    expect(providerInstances()).toHaveLength(2);

    // Drop only account A's segment (e.g. it was unchecked in the account
    // picker). The pre-fix bug: both accounts shared a bare-providerId
    // tileId, so the last registrant "won" the key and unmounting either one
    // could delete it out from under the other. With per-account keys,
    // account B's own entry must survive untouched.
    rerender(<TooltipProvider>{segmentB}</TooltipProvider>);

    const remaining = providerInstances();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.tileId).toBe("codex:acct-b");
  });
});
