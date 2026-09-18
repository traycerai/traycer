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

function startSession(): void {
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    history: { past: [], future: [] },
    announcement: "",
  });
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
          parts={{ modeWord: true, timer: false, bar: true }}
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
    expect(options?.control?.kind).toBe("toggle");
    act(() => {
      if (options?.control?.kind === "toggle") options.control.change(true);
    });
    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
    ).not.toContain("codex");
  });
});
