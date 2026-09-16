import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GettingStartedSettingsPanel } from "@/components/settings/panels/getting-started-settings-panel";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
}));

describe("GettingStartedSettingsPanel", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    useOnboardingStore.setState({
      completedAt: null,
      step: 0,
      setupProgress: { agents: -1, appearance: -1, cookies: -1 },
      activeSetup: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows initial tour progress and replays a completed tour", () => {
    const { rerender } = render(<GettingStartedSettingsPanel />);

    expect(screen.getByRole("status").textContent).toBe("0 of 4 complete");
    expect(
      screen.getByRole("button", { name: "Initial tour, Not started" }),
    ).toBeTruthy();

    useOnboardingStore.setState({ completedAt: 123, step: 4 });
    rerender(<GettingStartedSettingsPanel />);

    expect(screen.getByRole("status").textContent).toBe("1 of 4 complete");
    fireEvent.click(
      screen.getByRole("button", { name: "Initial tour, Complete" }),
    );

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/onboarding",
      search: { replay: true },
    });
    expect(useOnboardingStore.getState().completedAt).toBe(123);
    expect(useOnboardingStore.getState().step).toBe(0);
  });
});
