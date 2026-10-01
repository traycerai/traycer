import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { AppTelemetryBridge } from "@/providers/app-telemetry-bridge";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

const LAYOUT_SNAPSHOT_KEY = persistKey(STORE_KEYS.layoutSnapshot);

// The periodic sampler is exercised by its own suite; this one is about the
// second effect this bridge owns, `layout_snapshot`'s firing site.
vi.mock("@/lib/resources/resource-telemetry", () => ({
  startResourceTelemetry: () => () => undefined,
}));

beforeEach(() => {
  window.localStorage.removeItem(LAYOUT_SNAPSHOT_KEY);
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<AppTelemetryBridge /> layout_snapshot firing (tech-plan section 7)", () => {
  it("fires layout_snapshot for the current layout on mount", () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");

    render(<AppTelemetryBridge />);

    expect(trackSpy).toHaveBeenCalledExactlyOnceWith(
      AnalyticsEvent.LayoutSnapshot,
      expect.objectContaining({ base_preset: "default" }),
    );
  });

  it("does not fire a second time within the same 24h window on a remount", () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");

    const first = render(<AppTelemetryBridge />);
    first.unmount();
    render(<AppTelemetryBridge />);

    expect(trackSpy).toHaveBeenCalledOnce();
  });

  // A day of the denominator per device per launch is what a claimed-but-unsent
  // window costs, and the only symptom is a PostHog number that is quietly too
  // small (G3-04, L-83).
  it("gives the 24h window back when the event does not go out", () => {
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockReturnValue(false);

    const first = render(<AppTelemetryBridge />);
    first.unmount();

    expect(window.localStorage.getItem(LAYOUT_SNAPSHOT_KEY)).toBeNull();

    trackSpy.mockReturnValue(true);
    render(<AppTelemetryBridge />);

    expect(trackSpy).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(LAYOUT_SNAPSHOT_KEY)).not.toBeNull();
  });
});
