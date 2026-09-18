import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Popover } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StatusBarUsageTrigger } from "@/components/layout/status-bar/status-bar-rate-limit-cluster";
import { StatusBarResourceSegment } from "@/components/layout/status-bar/status-bar-resource-segment";
import { useStatusBarUsageDisplay } from "@/components/layout/status-bar/status-bar-usage-display";
import { StatusBarUsageScroller } from "@/components/layout/status-bar/status-bar-usage-scroller";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { StatusBarPreviewFrame } from "@/components/settings/panels/layout/status-bar-preview";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitCluster,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import "@/index.css";

/**
 * Real-layout fixture for the status bar's usage cluster: does it OVERFLOW
 * and scroll when it holds more readings than the strip is wide, does the
 * fade land on the edge that hides something, does the resource readout to
 * its right stay fully on screen while it does - and does the Settings
 * preview's frame, drawn at its Narrow width, scroll under a real wheel and a
 * real swipe rather than merely clipping?
 *
 * jsdom lays nothing out - `scrollWidth` and `clientWidth` are 0 there, and
 * the mask class the fade hook picks is a string it cannot see the effect of
 * - so every one of those is a claim only a real layout engine can settle.
 * This renders the strip's row with the production pieces that carry its
 * layout: the same scroller, the same trigger, the same readings and the same
 * resource segment the strip mounts, against the real stylesheet. What it
 * does NOT mount is the hooks that resolve a host's readings - it has no host
 * - so the cluster is hand-built here, in the shape those hooks produce.
 *
 * `?accounts=N` chooses how many account segments the cluster holds; the
 * driver sets the viewport width. The strip's row and the slot around the
 * scroller mirror `ScopedAppStatusBar`, the refresh control's box is the same
 * placeholder the Settings preview draws, and the resource segment is the
 * real one with no stream behind it - dashes, at the width dashes take. The
 * preview below the strip is the real `StatusBarPreviewFrame` at `narrow`,
 * so its inert boundary is the one the preview draws.
 */
const PROVIDERS = ["codex", "claude-code", "grok"] as const;
const FIXTURE_HOST_ID = "fixture-host";

function windowFor(
  providerId: (typeof PROVIDERS)[number],
  usedPercent: number,
): StatusBarRateLimitWindow {
  return {
    windowKey: `${providerId}:primary`,
    label: "5h",
    labelIsDuration: true,
    kind: "session",
    usedPercent,
    // Six hours out: a countdown that reads `5h 59m`-ish and does not cross
    // an hour boundary while the driver measures.
    resetsAt: Date.now() + 6 * 60 * 60_000 - 30_000,
    severity: usedPercent >= 80 ? "limited" : "healthy",
  };
}

function accountSegment(index: number): StatusBarProviderSegmentModel {
  const providerId = PROVIDERS[index % PROVIDERS.length];
  const profileId = index % 2 === 0 ? "work" : "personal";
  const window = windowFor(providerId, 17 + index * 13);
  return {
    providerId,
    profileId,
    hidden: false,
    account: { profileId, accentColor: "#5b8def", label: profileId },
    state: "live",
    reason: null,
    windows: [window],
    shown: [window],
    tightest: window,
  };
}

function clusterOf(accountCount: number): StatusBarRateLimitCluster {
  return {
    kind: "segments",
    segments: Array.from({ length: accountCount }, (_unused, index) =>
      accountSegment(index),
    ),
  };
}

export function StatusBarUsageScrollFixture(props: {
  readonly cluster: StatusBarRateLimitCluster;
}): React.ReactElement {
  const display = useStatusBarUsageDisplay();
  return (
    <div
      data-testid="app-status-bar"
      className="shrink-0 border-t border-border/90 bg-canvas text-canvas-foreground"
    >
      <div className="flex h-6 items-center gap-2 px-2 text-ui-xs tabular-nums">
        <Popover>
          <span
            data-testid="status-bar-rate-limit-slot"
            className="flex min-w-0 flex-1 items-center gap-1"
          >
            <StatusBarUsageScroller
              hostId={FIXTURE_HOST_ID}
              cluster={props.cluster}
              testId="status-bar-rate-limit-scroller"
            >
              <StatusBarUsageTrigger
                cluster={props.cluster}
                display={display}
                onRevealProfile={() => undefined}
              />
            </StatusBarUsageScroller>
            <span className="flex shrink-0 items-center pl-1">
              <span className="block size-5" />
            </span>
          </span>
        </Popover>
        <StatusBarResourceSegment
          hostId={FIXTURE_HOST_ID}
          hostLabel="Fixture"
          hasExplicitPick={false}
          interactive={false}
        />
      </div>
    </div>
  );
}

/**
 * The Settings preview's frame at its Narrow width, well below the strip so
 * the driver can point a wheel and a swipe at one and not the other.
 */
export function StatusBarPreviewScrollFixture(props: {
  readonly cluster: StatusBarRateLimitCluster;
}): React.ReactElement {
  const display = useStatusBarUsageDisplay();
  return (
    <div data-testid="preview-fixture" className="mt-24 px-4">
      <StatusBarPreviewFrame
        width="narrow"
        dimmed={false}
        scope={hostScopeFixture({ hostLabel: "Fixture" })}
        hasExplicitPick={false}
        cluster={props.cluster}
        display={display}
      />
    </div>
  );
}

const accountCount = Number(
  new URLSearchParams(window.location.search).get("accounts") ?? "6",
);
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <StatusBarUsageScrollFixture cluster={clusterOf(accountCount)} />
      <StatusBarPreviewScrollFixture cluster={clusterOf(accountCount)} />
    </TooltipProvider>
  </QueryClientProvider>,
);
