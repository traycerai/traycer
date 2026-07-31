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

describe("<HostConnectionDegradedBanner />", () => {
  afterEach(() => cleanup());

  it("says the connection is degraded while a compatible verdict is held", () => {
    const retry = vi.fn();
    renderBanner({ status: "compatible", degraded: true, retry });

    expect(screen.getByTestId("host-connection-degraded-banner")).toBeTruthy();
    fireEvent.click(screen.getByTestId("host-connection-degraded-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("stays out of the way on a live connection", () => {
    renderBanner({
      status: "compatible",
      degraded: false,
      retry: () => undefined,
    });

    expect(screen.queryByTestId("host-connection-degraded-banner")).toBeNull();
  });

  it("renders nothing while the probe is still checking, and outside the provider", () => {
    renderBanner({ status: "checking", retry: () => undefined });
    expect(screen.queryByTestId("host-connection-degraded-banner")).toBeNull();

    cleanup();
    // No provider: the dev preview and unit harnesses mount surfaces without
    // one, and a banner is never worth throwing over.
    renderBanner(null);
    expect(screen.queryByTestId("host-connection-degraded-banner")).toBeNull();
  });
});
