import { describe, expect, it, vi } from "vitest";

// MODE === "test" in vitest, so analytics is disabled and posthog never boots.
describe("analytics", () => {
  it("is a no-op when MODE is test", async () => {
    const posthog = await import("posthog-js");
    const initSpy = vi.spyOn(posthog.default, "init");
    const identifySpy = vi.spyOn(posthog.default, "identify");
    const captureSpy = vi.spyOn(posthog.default, "capture");

    const { Analytics, AnalyticsEvent } = await import("@/lib/analytics");
    const analytics = Analytics.getInstance();

    analytics.identify("user-1", null);
    analytics.track(AnalyticsEvent.TaskCreated, null);

    expect(initSpy).not.toHaveBeenCalled();
    expect(identifySpy).not.toHaveBeenCalled();
    expect(captureSpy).not.toHaveBeenCalled();
  });
});
