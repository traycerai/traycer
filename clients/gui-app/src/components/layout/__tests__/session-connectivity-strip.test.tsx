import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HostSessionConnectivity } from "@/lib/host/session-connectivity";
import { SessionConnectivityStrip } from "@/components/layout/session-connectivity-strip";

interface StripMocks {
  readonly wake: Mock;
}

const mocks = vi.hoisted((): StripMocks => ({
  wake: vi.fn(),
}));

vi.mock("@/lib/host/session-connectivity", async () => ({
  ...(await vi.importActual<typeof import("@/lib/host/session-connectivity")>(
    "@/lib/host/session-connectivity",
  )),
  useHostSessionWake: () => mocks.wake,
}));

function renderStrip(connectivity: HostSessionConnectivity): void {
  render(<SessionConnectivityStrip connectivity={connectivity} />);
}

function strip(): HTMLElement {
  return screen.getByTestId("session-connectivity-strip");
}

function bar(): HTMLElement | null {
  return screen.queryByTestId("session-connectivity-strip-bar");
}

describe("<SessionConnectivityStrip />", () => {
  afterEach(() => {
    cleanup();
    mocks.wake.mockReset();
  });

  // The un-announced verdicts must render NOTHING: `settling` is inside the
  // announce window (most drops heal on the first redial), `dialing` has never
  // been ready, and `unknown` is not the mobile app at all. A strip that
  // painted any of them would cry wolf on every tunnel.
  for (const quiet of ["ready", "settling", "dialing", "unknown"] as const) {
    it(`renders nothing on the un-announced '${quiet}' verdict`, () => {
      renderStrip(quiet);
      expect(screen.queryByTestId("session-connectivity-strip")).toBeNull();
    });
  }

  it("says the ordinary interruption with a bar and no words at all", () => {
    // Most of what this reports heals in a second or two. A row of words that
    // appears and vanishes in that time reads as an alarm and teaches people to
    // distrust the row; the bar says "something is happening" without making a
    // sentence of it.
    renderStrip("interrupted");
    expect(bar()).not.toBeNull();
    expect(strip().textContent).toBe("");
    expect(screen.queryByTestId("session-connectivity-strip-retry")).toBeNull();
  });

  it("keeps announcing the interruption even with no words on screen", () => {
    // What a screen reader hears must not depend on whether the visual form
    // happens to spend words. The accessible name still names the CONNECTION:
    // the verdict cannot distinguish our leg down from the relay's host uplink
    // gone, so a host claim would be a guess that is wrong half the time it
    // matters.
    renderStrip("interrupted");
    expect(strip().tagName).toBe("OUTPUT");
    expect(strip().getAttribute("aria-label")).toBe(
      "Connection interrupted - reconnecting",
    );
  });

  it("keeps the calm tone in the ordinary state", () => {
    // Alarm colouring is reserved for something the user must act on. This
    // state resolves itself in a second or two, and a warning that fires on
    // every app switch is one people stop reading. Asserted as the tone it
    // MUST carry, so a swap to any other alarm palette fails here too.
    renderStrip("interrupted");
    expect(strip().className).toContain("bg-background");
    expect(strip().className).toContain("text-muted-foreground");
  });

  it("travels while the interruption is still ordinary", () => {
    renderStrip("interrupted");
    expect(bar()?.classList.contains("stream-syncing-sweep")).toBe(true);
  });

  it("spends words and offers Retry once the outage has run long", () => {
    renderStrip("interrupted-prolonged");
    expect(strip().textContent).toContain("Still reconnecting");
    expect(screen.getByTestId("session-connectivity-strip-retry")).toBeTruthy();
    // Never a claim about the machine: the verdict cannot tell this device's
    // leg from the relay's host uplink, and a host is not necessarily a Mac.
    expect(strip().textContent).not.toMatch(/Mac|host|your machine/i);
    // Still calm. The escalation changes how much is said, not the palette.
    expect(strip().className).toContain("bg-background");
    expect(strip().className).toContain("text-muted-foreground");
  });

  it("stops the bar travelling once it has escalated", () => {
    // A bar still sweeping under "Still reconnecting" promises "any moment now"
    // about a retry just described as not converging - and it bounds the
    // animation of a reconnect that never converges.
    renderStrip("interrupted-prolonged");
    expect(bar()).not.toBeNull();
    expect(bar()?.classList.contains("stream-syncing-sweep")).toBe(false);
    expect(bar()?.classList.contains("w-full")).toBe(true);
  });

  it("wakes exactly the bound session when Retry is clicked, and not before", async () => {
    renderStrip("interrupted-prolonged");
    expect(mocks.wake).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByTestId("session-connectivity-strip-retry"),
    );
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });
});
