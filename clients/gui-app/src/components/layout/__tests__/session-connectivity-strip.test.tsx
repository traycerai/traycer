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

  it("states the ordinary interruption calmly, without blaming the host", () => {
    mocks.connectivity = "interrupted";
    render(<SessionConnectivityStrip />);
    const strip = screen.getByTestId("session-connectivity-strip");
    expect(strip.textContent).toContain("Reconnecting…");
    // The accessible name still names the CONNECTION: the verdict cannot
    // distinguish our leg down from the relay's host uplink gone, so a host
    // claim would be a guess that is wrong half the time it matters.
    expect(strip.getAttribute("aria-label")).toBe(
      "Connection interrupted - reconnecting",
    );
    // Never a claim about the machine: the verdict cannot tell this device's
    // leg from the relay's host uplink, and a host is not necessarily a Mac.
    expect(strip.textContent).not.toMatch(/Mac|host|your machine/i);
    // Alarm colouring is reserved for something the user must act on. This
    // state resolves itself in a second or two, and a warning that fires on
    // every app switch is one people stop reading. Asserted as the tone it
    // MUST carry, so a swap to any other alarm palette fails here too.
    expect(strip.className).toContain("bg-background");
    expect(strip.className).toContain("text-muted-foreground");
  });

  it("offers no Retry while the transport is still on its expected first attempt", () => {
    mocks.connectivity = "interrupted";
    render(<SessionConnectivityStrip />);
    expect(screen.queryByTestId("session-connectivity-strip-retry")).toBeNull();
    // The spinner is the pending signal in both announced states.
    expect(
      screen.getByTestId("session-connectivity-strip-spinner"),
    ).toBeTruthy();
  });

  it("escalates to the second rung once the outage has run long", () => {
    mocks.connectivity = "interrupted-prolonged";
    render(<SessionConnectivityStrip />);
    const strip = screen.getByTestId("session-connectivity-strip");
    expect(strip.textContent).toContain("Still reconnecting. Retrying…");
    // The accessible name escalates with the visible line: a static label
    // would keep announcing the first rung to a screen reader after the row
    // had moved on.
    expect(strip.getAttribute("aria-label")).toBe(
      "Connection interrupted - still reconnecting",
    );
    expect(strip.className).toContain("bg-background");
    expect(strip.className).toContain("text-muted-foreground");
  });

  it("wakes exactly the bound session when Retry is clicked, and not before", async () => {
    mocks.connectivity = "interrupted-prolonged";
    render(<SessionConnectivityStrip />);
    expect(mocks.wake).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByTestId("session-connectivity-strip-retry"),
    );
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });
});
