import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HostSessionConnectivity } from "@/lib/host/session-connectivity";
import { SessionConnectivityStrip } from "@/components/layout/session-connectivity-strip";

interface StripMocks {
  connectivity: HostSessionConnectivity;
  readonly wake: Mock;
}

const mocks = vi.hoisted((): StripMocks => ({
  connectivity: "ready",
  wake: vi.fn(),
}));

vi.mock("@/lib/host/session-connectivity", async () => ({
  ...(await vi.importActual<typeof import("@/lib/host/session-connectivity")>(
    "@/lib/host/session-connectivity",
  )),
  useHostSessionConnectivity: () => mocks.connectivity,
  useHostSessionWake: () => mocks.wake,
}));

describe("<SessionConnectivityStrip />", () => {
  afterEach(() => {
    cleanup();
    mocks.connectivity = "ready";
    mocks.wake.mockReset();
  });

  // The un-announced verdicts must render NOTHING: `settling` is inside the
  // announce window (most drops heal on the first redial), `dialing` has never
  // been ready, and `unknown` is not the mobile app at all. A strip that
  // painted any of them would cry wolf on every tunnel.
  for (const quiet of ["ready", "settling", "dialing", "unknown"] as const) {
    it(`renders nothing on the un-announced '${quiet}' verdict`, () => {
      mocks.connectivity = quiet;
      render(<SessionConnectivityStrip />);
      expect(screen.queryByTestId("session-connectivity-strip")).toBeNull();
    });
  }

  it("announces an interruption without blaming the host", () => {
    mocks.connectivity = "interrupted";
    render(<SessionConnectivityStrip />);
    const strip = screen.getByTestId("session-connectivity-strip");
    expect(strip.textContent).toContain(
      "Connection interrupted - reconnecting…",
    );
    // The copy and the accessible name both name the CONNECTION: the verdict
    // cannot distinguish our leg down from the relay's host uplink gone, so a
    // host claim would be a guess that is wrong half the time it matters.
    expect(strip.getAttribute("aria-label")).toBe(
      "Connection to Traycer Host interrupted",
    );
    expect(strip.textContent).not.toContain("host is unavailable");
  });

  it("escalates to the second rung once the outage has run long", () => {
    mocks.connectivity = "interrupted-prolonged";
    render(<SessionConnectivityStrip />);
    expect(
      screen.getByTestId("session-connectivity-strip").textContent,
    ).toContain("Still can't connect - retrying.");
  });

  it("wakes exactly the bound session when Retry is clicked, and not before", async () => {
    mocks.connectivity = "interrupted";
    render(<SessionConnectivityStrip />);
    expect(mocks.wake).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByTestId("session-connectivity-strip-retry"),
    );
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });
});
