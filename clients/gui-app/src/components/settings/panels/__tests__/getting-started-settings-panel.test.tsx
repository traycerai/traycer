import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GettingStartedSettingsPanel } from "@/components/settings/panels/getting-started-settings-panel";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";

const navigateMock = vi.hoisted(() => vi.fn());
const mobileApp = vi.hoisted(() => ({ value: false }));

const activateTabIntentMock = vi.hoisted(() =>
  vi.fn((_navigate: unknown, _intent: unknown, _options: unknown) => true),
);

vi.mock("@/lib/tab-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tab-navigation")>();
  return { ...actual, activateTabIntent: activateTabIntentMock };
});

vi.mock("@/lib/mobile-app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mobile-app")>();
  return { ...actual, isMobileApp: () => mobileApp.value };
});

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

const setSectionMock = vi.hoisted(() => vi.fn());

vi.mock("@/stores/tabs/system-tab-modal-bridge", () => ({
  getSystemTabModalApi: () => ({
    isOverlayActive: () => true,
    setSection: setSectionMock,
    openSettings: vi.fn(),
  }),
}));

describe("GettingStartedSettingsPanel", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    activateTabIntentMock.mockClear();
    setSectionMock.mockReset();
    useOnboardingStore.setState({
      completedAt: null,
      step: 0,
      setupProgress: { agents: -1, appearance: -1, cookies: -1 },
      activeSetup: null,
    });
  });

  afterEach(() => {
    cleanup();
    mobileApp.value = false;
  });

  it("starts the guided tour from the card on the mobile app", () => {
    mobileApp.value = true;
    useOnboardingStore.setState({ completedAt: 123 });
    useFirstTaskGuideStore.getState().dismiss();
    render(<GettingStartedSettingsPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: "Guided tour, Complete" }),
    );

    // Not the welcome replay: the phone's tour is the guided one on the start
    // page, so the card arms it and goes there.
    expect(useFirstTaskGuideStore.getState().status).toBe("active");
    // Through the tab controller: Settings is a tab on the phone, and a route
    // navigation alone left the user sitting on it.
    expect(activateTabIntentMock).toHaveBeenCalledOnce();
    expect(activateTabIntentMock.mock.calls[0]?.[0]).toBe(navigateMock);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("shows initial tour progress and replays a completed tour", () => {
    const { rerender } = render(<GettingStartedSettingsPanel />);

    // No runner host here, so the browser guide is not on offer and is no
    // part of the denominator either.
    expect(screen.getByRole("status").textContent).toBe("0 of 3 complete");
    expect(
      screen.getByRole("button", { name: "Initial tour, Not started" }),
    ).toBeTruthy();

    useOnboardingStore.setState({ completedAt: 123, step: 4 });
    rerender(<GettingStartedSettingsPanel />);

    expect(screen.getByRole("status").textContent).toBe("1 of 3 complete");
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

  it("meters the steps already completed, so the last one is not a full bar", () => {
    useOnboardingStore.setState({
      setupProgress: { agents: -1, appearance: 4, cookies: -1 },
    });
    const { container } = render(<GettingStartedSettingsPanel />);

    expect(
      screen.getByRole("button", {
        name: "Appearance and layout, Step 5 of 5",
      }),
    ).toBeTruthy();
    const meter = container.querySelector("progress");
    expect(meter?.getAttribute("value")).toBe("4");
    expect(meter?.getAttribute("max")).toBe("5");
  });

  it("names the step a started guide is on and resumes it there", () => {
    useOnboardingStore.setState({
      setupProgress: { agents: -1, appearance: 3, cookies: -1 },
    });
    render(<GettingStartedSettingsPanel />);

    const card = screen.getByRole("button", {
      name: "Appearance and layout, Step 4 of 5",
    });
    fireEvent.click(card);

    // The fourth appearance step lives on Layout, so a resume goes there.
    expect(setSectionMock).toHaveBeenCalledWith("layout");
    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 3,
    });
  });

  // This suite's `useRunnerHostOrNull` stub returns null, so the browser
  // sign-ins guide is one this shell cannot offer at all - which is exactly the
  // case the phone collapses.
  it("collapses a guide this shell cannot offer into one footnote on a phone", () => {
    const desktopWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 393,
    });
    try {
      render(<GettingStartedSettingsPanel />);

      expect(
        screen.queryByRole("button", { name: /Browser sign-ins/ }),
      ).toBeNull();
      expect(
        screen.getByTestId("getting-started-unavailable-note").textContent,
      ).toBe("Browser sign-ins: available in the desktop app.");
      // The denominator never counted it, so collapsing the card changes
      // nothing the panel reports.
      expect(screen.getByRole("status").textContent).toBe("0 of 3 complete");
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: desktopWidth,
      });
    }
  });

  it("keeps the disabled card on a pointer viewport", () => {
    render(<GettingStartedSettingsPanel />);

    expect(
      screen.getByRole("button", {
        name: /Browser sign-ins.*Available in the desktop app/,
      }),
    ).toBeTruthy();
    expect(screen.queryByTestId("getting-started-unavailable-note")).toBeNull();
  });
});
