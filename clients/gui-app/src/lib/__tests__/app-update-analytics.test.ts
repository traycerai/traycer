import { beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  __resetAppUpdateAnalyticsForTests,
  settleUpdateDownloadOutcome,
  trackUpdateDownloadStarted,
} from "@/lib/app-update-analytics";

describe("app-update-analytics", () => {
  beforeEach(() => {
    __resetAppUpdateAnalyticsForTests();
  });

  it("tracks a start followed by a ready settle as succeeded", () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();

    trackUpdateDownloadStarted("direct_ui");
    settleUpdateDownloadOutcome("ready", null);

    expect(track).toHaveBeenNthCalledWith(
      1,
      AnalyticsEvent.UpdateDownloadStarted,
      { source: "direct_ui" },
    );
    expect(track).toHaveBeenNthCalledWith(
      2,
      AnalyticsEvent.UpdateDownloadSucceeded,
      null,
    );
  });

  it("tracks a start followed by an error settle as failed", () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();

    trackUpdateDownloadStarted("system_tray");
    settleUpdateDownloadOutcome("error", "network timeout");

    expect(track).toHaveBeenNthCalledWith(
      1,
      AnalyticsEvent.UpdateDownloadStarted,
      { source: "system_tray" },
    );
    expect(track).toHaveBeenNthCalledWith(2, AnalyticsEvent.UpdateFailed, {
      blocker: "timeout",
    });
  });

  it("is a no-op when settling without a matching start", () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();

    settleUpdateDownloadOutcome("ready", null);

    expect(track).not.toHaveBeenCalled();
  });

  it("only tracks the first terminal outcome on a double settle", () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    track.mockClear();

    trackUpdateDownloadStarted("direct_ui");
    settleUpdateDownloadOutcome("ready", null);
    settleUpdateDownloadOutcome("error", "should be ignored");

    expect(track).toHaveBeenCalledTimes(2);
    expect(track).toHaveBeenNthCalledWith(
      2,
      AnalyticsEvent.UpdateDownloadSucceeded,
      null,
    );
  });
});
