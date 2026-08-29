import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClockSkewBanner } from "@/components/layout/clock-skew-banner";
import { appServerClock } from "@/lib/clock/app-server-clock";

const SEVEN_HOURS_MS = 7 * 3_600_000;

/**
 * Feeds the app-wide tracker a synthetic server time. The banner reads the real
 * singleton - the same instance every stream transport parks on - so these
 * assertions are about the wiring, not about a stand-in.
 */
function recordOffset(offsetMs: number): void {
  act(() => {
    appServerClock.recordServerTimeMs(Date.now() + offsetMs, Date.now());
  });
}

describe("ClockSkewBanner", () => {
  afterEach(() => {
    cleanup();
    // Return the shared tracker to `ok` so the next test starts from a known
    // verdict; there is deliberately no reset API on the tracker itself.
    recordOffset(0);
  });

  it("renders nothing before any server-time sample has landed", () => {
    render(<ClockSkewBanner />);
    expect(screen.queryByTestId("clock-skew-banner")).toBeNull();
  });

  it("renders nothing for an offset a 15-minute token tolerates", () => {
    render(<ClockSkewBanner />);
    recordOffset(60_000);
    expect(screen.queryByTestId("clock-skew-banner")).toBeNull();
  });

  it("names magnitude and direction while the clock is wrong", () => {
    render(<ClockSkewBanner />);
    // Local clock 7h AHEAD, so the server reads earlier than we do.
    recordOffset(-SEVEN_HOURS_MS);
    const banner = screen.getByTestId("clock-skew-banner");
    expect(banner.textContent).toContain("~7h ahead");
    expect(banner.textContent).toContain("Traycer can't connect");
  });

  it("still speaks for a clock running BEHIND, but does not claim connections are blocked", () => {
    // Detection is deliberately NOT narrowed to the direction that parks
    // sessions - a clock hours slow is worth telling the user about. What the
    // banner must not do is repeat the fast-clock CLAIM, because a slow clock
    // makes bearers look more valid rather than expired and blocks nothing;
    // saying otherwise sends the user after the wrong cause.
    render(<ClockSkewBanner />);
    recordOffset(SEVEN_HOURS_MS);
    const banner = screen.getByTestId("clock-skew-banner");
    expect(banner.textContent).toContain("~7h behind");
    expect(banner.textContent).not.toContain("Traycer can't connect");
  });

  it("self-clears once the clock is corrected, with nothing to dismiss", () => {
    render(<ClockSkewBanner />);
    recordOffset(-SEVEN_HOURS_MS);
    expect(screen.getByTestId("clock-skew-banner")).not.toBeNull();
    // The same edge that resumes every parked stream session.
    recordOffset(0);
    expect(screen.queryByTestId("clock-skew-banner")).toBeNull();
  });

  it("stays up across the hysteresis band so it cannot flicker", () => {
    render(<ClockSkewBanner />);
    recordOffset(-SEVEN_HOURS_MS);
    // Three minutes: under the 5-minute enter bound, over the 2-minute exit
    // bound.
    recordOffset(-180_000);
    expect(screen.queryByTestId("clock-skew-banner")).not.toBeNull();
  });
});
