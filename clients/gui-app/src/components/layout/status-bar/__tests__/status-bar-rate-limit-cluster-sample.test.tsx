import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Popover } from "@/components/ui/popover";
import type {
  StatusBarProviderSegmentModel,
  StatusBarProviderSegmentState,
  StatusBarRateLimitCluster as StatusBarRateLimitClusterModel,
  StatusBarRateLimitRefreshModel,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { RateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { SampleSceneContext } from "@/components/sample-workspace/sample-scene-context";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { useRateLimitPopoverStore } from "@/stores/rate-limits/rate-limit-popover-store";

interface MockState {
  cluster: StatusBarRateLimitClusterModel;
  refresh: StatusBarRateLimitRefreshModel;
}

const mocks = vi.hoisted<MockState>(() => ({
  cluster: { kind: "no-providers" },
  refresh: { queueTargets: [], httpRefetches: [], httpFetching: false },
}));

vi.mock(
  "@/hooks/rate-limits/use-status-bar-rate-limit-segments",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/rate-limits/use-status-bar-rate-limit-segments")
      >();
    return {
      ...actual,
      useStatusBarRateLimitSegments: () => ({
        cluster: mocks.cluster,
        mountTargets: [],
        refresh: mocks.refresh,
      }),
    };
  },
);
vi.mock("@/hooks/rate-limits/use-rate-limit-queue-scope", () => ({
  useRateLimitQueueScope: () => null,
}));
vi.mock("@/hooks/rate-limits/use-rate-limit-queue-target-phase", () => ({
  useAnyRateLimitQueueTargetFetching: () => false,
}));
vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-mount", () => ({
  useRefreshProviderRateLimitsOnMount: () => undefined,
}));

import { StatusBarRateLimitCluster } from "@/components/layout/status-bar/status-bar-rate-limit-cluster";

const PROFILE_SELECTION: RateLimitProfileSelection = {
  shownProfiles: {},
  lastProfileByHarness: {},
};

function segment(
  providerId: StatusBarProviderSegmentModel["providerId"],
  state: StatusBarProviderSegmentState,
): StatusBarProviderSegmentModel {
  const live = state === "live";
  const reading = {
    windowKey: `${providerId}:real`,
    label: "5h",
    labelIsDuration: true,
    kind: "session",
    usedPercent: 33,
    resetsAt: null,
    severity: "healthy",
  } as const;
  return {
    providerId,
    profileId: null,
    account: null,
    hidden: false,
    state,
    reason: null,
    windows: live ? [reading] : [],
    shown: live ? [reading] : [],
    tightest: live ? reading : null,
  };
}

function renderCluster(inSampleScene: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SampleSceneContext.Provider value={inSampleScene}>
          <Popover>
            <StatusBarRateLimitCluster
              hostId="host-a"
              providers={[]}
              profileSelection={PROFILE_SELECTION}
              editing={false}
            />
          </Popover>
        </SampleSceneContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function trigger(): HTMLElement {
  return screen.getByTestId("status-bar-rate-limit-trigger");
}

beforeEach(() => {
  useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
});

afterEach(() => {
  cleanup();
  useRateLimitPopoverStore.setState({
    activeTab: "overview",
    revealProfile: null,
  });
  mocks.cluster = { kind: "no-providers" };
  mocks.refresh = { queueTargets: [], httpRefetches: [], httpFetching: false };
});

describe("StatusBarRateLimitCluster in the sample scene", () => {
  it("shows the labelled sample reading for cold providers, and says so in the accessible name", () => {
    mocks.cluster = {
      kind: "segments",
      segments: [segment("claude-code", "cold"), segment("codex", "cold")],
    };
    renderCluster(true);

    expect(
      trigger().getAttribute("aria-label")?.startsWith("Sample readings · "),
    ).toBe(true);
    // The invented 57% / 82% readings are what the strip now describes.
    expect(trigger().getAttribute("aria-label")).toMatch(/57/);
    expect(screen.getByText("Sample")).not.toBeNull();
  });

  it("shows nothing invented outside the sample scene (a normal chat)", () => {
    mocks.cluster = {
      kind: "segments",
      segments: [segment("claude-code", "cold"), segment("codex", "cold")],
    };
    renderCluster(false);

    expect(
      trigger().getAttribute("aria-label")?.startsWith("Sample readings"),
    ).toBe(false);
    expect(trigger().getAttribute("aria-label")).not.toMatch(/57/);
    expect(screen.queryByText("Sample")).toBeNull();
  });

  it("leaves real readings alone even in the sample scene", () => {
    mocks.cluster = {
      kind: "segments",
      segments: [segment("claude-code", "cold"), segment("codex", "live")],
    };
    renderCluster(true);

    expect(
      trigger().getAttribute("aria-label")?.startsWith("Sample readings"),
    ).toBe(false);
    expect(screen.queryByText("Sample")).toBeNull();
    expect(trigger().getAttribute("aria-label")).toMatch(/33/);
  });

  it("does not sample providers that answered 'unavailable'", () => {
    mocks.cluster = {
      kind: "segments",
      segments: [
        segment("claude-code", "unavailable"),
        segment("codex", "unavailable"),
      ],
    };
    renderCluster(true);

    expect(
      trigger().getAttribute("aria-label")?.startsWith("Sample readings"),
    ).toBe(false);
    expect(screen.queryByText("Sample")).toBeNull();
  });

  it("labels a no-providers strip with a sample usage figure only in the sample scene", () => {
    mocks.cluster = { kind: "no-providers" };
    renderCluster(true);

    expect(screen.getByText("Sample")).not.toBeNull();
    expect(screen.getByText(/Usage · (57% used|43% left)/)).not.toBeNull();

    cleanup();
    renderCluster(false);

    expect(screen.queryByText("Sample")).toBeNull();
    expect(
      screen.getByText("Connect a supported provider to see usage here."),
    ).not.toBeNull();
  });
});
