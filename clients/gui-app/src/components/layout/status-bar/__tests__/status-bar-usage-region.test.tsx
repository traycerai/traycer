import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StatusBarProviderSegment } from "@/components/layout/status-bar/status-bar-provider-segment";
import { StatusBarUsageScroller } from "@/components/layout/status-bar/status-bar-usage-scroller";
import type { StatusBarUsageParts } from "@/components/layout/status-bar/status-bar-usage-display";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitCluster,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

/**
 * Usage limits is ONE region, however many accounts it draws (C-02).
 *
 * Every provider segment used to register its own instance of `usageLimits`.
 * The editor stamps `data-selected` on every instance of a region by design
 * (L-23), so selecting the cluster drew the travelling ring around the first
 * account and a static white box around each of the others - where the
 * approved artifact draws one ring around the whole cluster. The registration
 * now lives once, on the cluster's row.
 */

const PARTS: StatusBarUsageParts = {
  modeWord: true,
  timer: false,
  bar: false,
  percent: true,
};

function segment(
  providerId: RateLimitProviderId,
): StatusBarProviderSegmentModel {
  const limit: StatusBarRateLimitWindow = {
    windowKey: `${providerId}:five-hour`,
    kind: "session",
    label: "5h",
    labelIsDuration: true,
    usedPercent: 40,
    severity: "healthy",
    resetsAt: null,
  };
  return {
    providerId,
    profileId: null,
    account: null,
    hidden: false,
    state: "live",
    reason: null,
    windows: [limit],
    shown: [limit],
    tightest: limit,
  };
}

function cluster(): StatusBarRateLimitCluster {
  return {
    kind: "segments",
    segments: [segment("codex"), segment("claude-code")],
  };
}

function renderCluster(): void {
  render(
    <TooltipProvider>
      <StatusBarUsageScroller
        hostId="host-a"
        cluster={cluster()}
        testId="scroller"
      >
        <StatusBarProviderSegment
          segment={segment("codex")}
          parts={PARTS}
          percentMode="used"
        />
        <StatusBarProviderSegment
          segment={segment("claude-code")}
          parts={PARTS}
          percentMode="used"
        />
      </StatusBarUsageScroller>
    </TooltipProvider>,
  );
}

/**
 * The editor's own registry, not the DOM. `data-layout-region` is the region's
 * NAME and is on the element at rest too since L-129, because a right-click
 * has to be able to resolve a region while the user is only using the app;
 * what these tests are about is the REGISTRATION, which is still the one thing
 * a session decides.
 */
function registered(): ReadonlyArray<Element> {
  const instances = [...useLayoutEditorStore.getState().instances.values()];
  return instances
    .filter((instance) => instance.regionId === "usageLimits")
    .map((instance) => instance.node);
}

beforeEach(() => {
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.setState({ instances: new Map() });
});

afterEach(() => {
  cleanup();
  useLayoutEditorStore.getState().endSession();
});

describe("the usage cluster as one region", () => {
  it("registers the row that holds every segment exactly once, not a segment", () => {
    renderCluster();
    act(() => {
      useLayoutEditorStore.getState().beginSession({
        entry: "pointer",
        source: "direct_ui",
        startedAt: 0,
        origin: { kind: "tab" },
      });
    });

    expect(registered()).toHaveLength(1);
    const node = registered()[0];
    const segments = [...document.querySelectorAll("[data-provider-id]")];

    expect(segments).toHaveLength(2);
    segments.forEach((one) => {
      expect(one.hasAttribute("data-layout-region")).toBe(false);
      expect(node.contains(one)).toBe(true);
    });
  });

  it("selects as one region, so no instance wears the static outline (L-23)", () => {
    // The outline `layout-editor.css` draws on the instances the travelling
    // ring is NOT on is what the segments were wearing. One instance means
    // one anchor and nothing else selected beside it.
    renderCluster();
    act(() => {
      useLayoutEditorStore.getState().beginSession({
        entry: "pointer",
        source: "direct_ui",
        startedAt: 0,
        origin: { kind: "tab" },
      });
      useLayoutEditorStore.getState().select("usageLimits");
    });

    const selected = [...document.querySelectorAll('[data-selected="1"]')];

    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute("data-layout-anchor")).toBe("selected");
  });
});
