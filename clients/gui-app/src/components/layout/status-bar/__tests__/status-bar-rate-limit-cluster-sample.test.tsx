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
import { SAMPLE_USAGE_USED_PERCENT } from "@/components/sample-workspace/sample-workspace-scene";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useRateLimitPopoverStore } from "@/stores/rate-limits/rate-limit-popover-store";

interface MockState {
  cluster: StatusBarRateLimitClusterModel;
  refresh: StatusBarRateLimitRefreshModel;
  /** What the cluster last asked the segments hook for - the `sample` wiring. */
  lastSample: boolean | null;
}

const mocks = vi.hoisted<MockState>(() => ({
  cluster: { kind: "no-providers" },
  refresh: {
    ephemeralTargets: [],
    ephemeralFetching: false,
    httpRefetches: [],
    httpFetching: false,
  },
  lastSample: null,
}));

// The substitution that used to live in the cluster component (reading the
// hook's cluster, then swapping in invented numbers) now lives INSIDE
// `useStatusBarRateLimitSegments` itself (C12): the cluster component only
// forwards `sample` to it and trusts back whatever cluster it returns. So this
// mock stands in for an ALREADY-SUBSTITUTED cluster - the readings substitution
// itself is covered by the hook's own tests - and records the `sample` flag
// the component wired through, to prove that plumbing still holds.
vi.mock(
  "@/hooks/rate-limits/use-status-bar-rate-limit-segments",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/rate-limits/use-status-bar-rate-limit-segments")
      >();
    return {
      ...actual,
      useStatusBarRateLimitSegments: (args: { readonly sample: boolean }) => {
        mocks.lastSample = args.sample;
        return {
          cluster: mocks.cluster,
          mountTargets: [],
          refresh: mocks.refresh,
        };
      },
    };
  },
);
vi.mock("@/hooks/rate-limits/use-provider-rate-limit-fetch-scope", () => ({
  useProviderRateLimitFetchScope: () => null,
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
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

afterEach(() => {
  cleanup();
  useRateLimitPopoverStore.setState({
    activeTab: "overview",
    revealProfile: null,
  });
  mocks.cluster = { kind: "no-providers" };
  mocks.refresh = {
    ephemeralTargets: [],
    ephemeralFetching: false,
    httpRefetches: [],
    httpFetching: false,
  };
  mocks.lastSample = null;
});

describe("StatusBarRateLimitCluster in the sample scene", () => {
  it("labels an already-sampled segments cluster, and says so in the accessible name", () => {
    mocks.cluster = {
      kind: "segments",
      segments: [segment("claude-code", "live"), segment("codex", "live")],
    };
    renderCluster(true);

    // The readings themselves are the sample scene's own.
    expect(mocks.lastSample).toBe(true);
    expect(
      trigger().getAttribute("aria-label")?.startsWith("Sample readings · "),
    ).toBe(true);
    expect(screen.getByText("Sample")).not.toBeNull();
  });

  it("shows nothing labelled as sample outside the sample scene", () => {
    mocks.cluster = {
      kind: "segments",
      segments: [segment("claude-code", "live"), segment("codex", "live")],
    };
    renderCluster(false);

    expect(mocks.lastSample).toBe(false);
    expect(
      trigger().getAttribute("aria-label")?.startsWith("Sample readings"),
    ).toBe(false);
    expect(screen.queryByText("Sample")).toBeNull();
  });

  it("gives no sample label to a hidden cluster even inside the sample scene", () => {
    mocks.cluster = { kind: "hidden" };
    renderCluster(true);

    expect(
      trigger().getAttribute("aria-label")?.startsWith("Sample readings"),
    ).toBe(false);
    expect(screen.queryByText("Sample")).toBeNull();
  });

  it("labels a no-providers strip with the fallback sample usage figure only in the sample scene", () => {
    mocks.cluster = { kind: "no-providers" };
    renderCluster(true);

    expect(screen.getByText("Sample")).not.toBeNull();
    expect(
      screen.getByText(
        new RegExp(
          `Usage · (${SAMPLE_USAGE_USED_PERCENT}% used|${100 - SAMPLE_USAGE_USED_PERCENT}% left)`,
        ),
      ),
    ).not.toBeNull();

    cleanup();
    renderCluster(false);

    expect(screen.queryByText("Sample")).toBeNull();
    expect(
      screen.getByText("Connect a supported provider to see usage here."),
    ).not.toBeNull();
  });
});
