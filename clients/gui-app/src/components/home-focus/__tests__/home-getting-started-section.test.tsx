import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeGettingStartedSection } from "@/components/home-focus/home-getting-started-section";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { setupGuideLength } from "@/stores/onboarding/setup-guides";

const navigateMock = vi.hoisted(() => vi.fn());
const setSectionMock = vi.hoisted(() => vi.fn());
const openSettingsMock = vi.hoisted(() => vi.fn());
const isOverlayActiveMock = vi.hoisted(() => vi.fn(() => false));

interface MockBrowserView {
  readonly kind: "mock-browser-view";
}

/** Switchable in place of a fixed `null`, so one suite can cover both the
 * 3-guide and 4-guide shells. */
const runnerHost = vi.hoisted(() => ({
  browserView: null as MockBrowserView | null,
}));

interface MockHostBinding {
  readonly hostId: string;
}

const hostBinding = vi.hoisted(() => ({
  value: null as MockHostBinding | null,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("@/lib/host", () => ({
  useHostBinding: () => hostBinding.value,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () =>
    runnerHost.browserView === null
      ? null
      : { browserView: runnerHost.browserView },
}));

vi.mock("@/stores/tabs/system-tab-modal-bridge", () => ({
  getSystemTabModalApi: () => ({
    isOverlayActive: isOverlayActiveMock,
    setSection: setSectionMock,
    openSettings: openSettingsMock,
  }),
}));

vi.mock("@/lib/mobile-app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mobile-app")>();
  return { ...actual, isMobileApp: () => false };
});

describe("HomeGettingStartedSection", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    setSectionMock.mockReset();
    openSettingsMock.mockReset();
    isOverlayActiveMock.mockReset();
    isOverlayActiveMock.mockReturnValue(false);
    runnerHost.browserView = null;
    hostBinding.value = null;
    useOnboardingStore.setState({
      completedAt: null,
      step: 0,
      setupProgress: { agents: -1, appearance: -1, cookies: -1 },
      activeSetup: null,
      setupReminderDismissed: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders open with the heading, the count, and the cards as buttons while guides are incomplete", () => {
    render(<HomeGettingStartedSection />);

    expect(
      screen.getByRole("heading", { name: "Getting started" }),
    ).toBeTruthy();
    expect(screen.getByText("0 of 3 complete")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Agent selection, Not started" }),
    ).toBeTruthy();

    for (const button of screen.getAllByRole("button")) {
      expect(button.hasAttribute("aria-expanded")).toBe(false);
    }
    expect(
      screen.queryByRole("button", { name: /Getting started/ }),
    ).toBeNull();
  });

  it("leaves out the Browser sign-ins card and counts out of 3 without a browserView", () => {
    render(<HomeGettingStartedSection />);

    expect(
      screen.queryByRole("button", { name: /Browser sign-ins/ }),
    ).toBeNull();
    expect(screen.getByText("0 of 3 complete")).toBeTruthy();
  });

  it("offers the Browser sign-ins card and counts out of 4 with a browserView", () => {
    runnerHost.browserView = { kind: "mock-browser-view" };
    render(<HomeGettingStartedSection />);

    expect(
      screen.getByRole("button", { name: /Browser sign-ins/ }),
    ).toBeTruthy();
    expect(screen.getByText("0 of 4 complete")).toBeTruthy();
  });

  it("collapses behind a trigger once every offered guide is complete, and expands on click", () => {
    runnerHost.browserView = { kind: "mock-browser-view" };
    useOnboardingStore.setState({
      completedAt: Date.now(),
      setupProgress: {
        agents: setupGuideLength("agents"),
        appearance: setupGuideLength("appearance"),
        cookies: setupGuideLength("cookies"),
      },
    });
    render(<HomeGettingStartedSection />);

    const trigger = screen.getByRole("button", { name: /Getting started/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("4 of 4 complete")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Agent selection/ }),
    ).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByRole("button", { name: /Agent selection/ }),
    ).toBeTruthy();
  });

  it("carries no settings-only markers on the home cards", () => {
    const { container } = render(<HomeGettingStartedSection />);

    expect(container.querySelector("[data-settings-anchor]")).toBeNull();
    expect(screen.queryByTestId("settings-replay-onboarding")).toBeNull();
  });

  it("starts the agents setup guide and opens Settings there on click", () => {
    render(<HomeGettingStartedSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Agent selection, Not started" }),
    );

    expect(useOnboardingStore.getState().activeSetup?.id).toBe("agents");
    expect(setSectionMock).not.toHaveBeenCalled();
    expect(openSettingsMock).toHaveBeenCalledWith({
      section: "agents",
      resetToGeneral: false,
      tab: null,
      draft: null,
      hostId: null,
    });
  });
});
