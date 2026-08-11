import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HostConnectionDegradedBanner } from "@/components/layout/host-connection-degraded-banner";
import {
  HostCompatibilityContext,
  type HostCompatibility,
} from "@/lib/host/compatibility-state";

function renderBanner(compatibility: HostCompatibility | null): void {
  render(
    <HostCompatibilityContext.Provider value={compatibility}>
      <HostConnectionDegradedBanner />
    </HostCompatibilityContext.Provider>,
  );
}

// Queried by role, not by test id: the role carries the accessible name, so
// these also fail if the `aria-label` or the button label is dropped - which is
// what a user relying on a screen reader would actually notice.
function queryBanner(): HTMLElement | null {
  return screen.queryByRole("status", {
    name: "Traycer Host connection degraded",
  });
}

describe("<HostConnectionDegradedBanner />", () => {
  afterEach(() => cleanup());

  it("says the connection is degraded while a compatible verdict is held", () => {
    const retry = vi.fn();
    renderBanner({
      status: "compatible",
      degraded: true,
      retry,
      hostStatus: {
        busy: false,
        busySessionCount: 0,
        hostVersion: "1.0.0",
      },
    });

    expect(queryBanner()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("stays out of the way on a live connection", () => {
    renderBanner({
      status: "compatible",
      degraded: false,
      retry: () => undefined,
      hostStatus: {
        busy: false,
        busySessionCount: 0,
        hostVersion: "1.0.0",
      },
    });

    expect(queryBanner()).toBeNull();
  });

  it("renders nothing while the probe is still checking, and outside the provider", () => {
    renderBanner({ status: "checking", retry: () => undefined });
    expect(queryBanner()).toBeNull();

    cleanup();
    // No provider: the dev preview and unit harnesses mount surfaces without
    // one, and a banner is never worth throwing over.
    renderBanner(null);
    expect(queryBanner()).toBeNull();
  });
});
