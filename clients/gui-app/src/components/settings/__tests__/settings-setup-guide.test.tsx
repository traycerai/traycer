import { StrictMode, useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSetupGuide } from "@/components/settings/settings-setup-guide";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { setupGuideLength } from "@/stores/onboarding/setup-guides";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateMock,
}));

vi.mock("@/components/onboarding/onboarding-coachmark", () => ({
  OnboardingCoachmark: (props: {
    readonly progress: { readonly step: number; readonly total: number } | null;
    readonly onClose: () => void;
    readonly action: {
      readonly label: string;
      readonly onClick: () => void;
    } | null;
  }) => (
    <div data-testid="guide-coachmark">
      {props.progress === null ? null : (
        <div
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={props.progress.total}
          aria-valuenow={props.progress.step}
          data-testid="guide-coachmark-progress"
        />
      )}
      {/* The real card closes on its X and on Escape; both are this prop. */}
      <button type="button" onClick={props.onClose}>
        Dismiss
      </button>
      {props.action === null ? null : (
        <button type="button" onClick={props.action.onClick}>
          {props.action.label}
        </button>
      )}
    </div>
  ),
}));

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

function Harness(props: { readonly section: SettingsSectionId }) {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef}>
      <SettingsSetupGuide section={props.section} rootRef={rootRef} />
    </div>
  );
}

describe("SettingsSetupGuide", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    useOnboardingStore.setState({
      setupProgress: { agents: -1, appearance: 2, cookies: -1 },
      activeSetup: { id: "appearance", step: 2 },
    });
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });
    useCustomizeStore.setState({ session: null });
    setViewportWidth(1024);
  });

  it("keeps the guide running through StrictMode's mount probe", async () => {
    render(
      <StrictMode>
        <Harness section="appearance" />
      </StrictMode>,
    );

    // The card is lazy, so it lands after the probe has already run.
    expect(await screen.findByTestId("guide-coachmark")).toBeTruthy();
    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 2,
    });
  });

  it("hides a step whose section is not the mounted one", () => {
    useOnboardingStore.setState({ activeSetup: { id: "appearance", step: 3 } });

    render(<Harness section="appearance" />);

    expect(screen.queryByTestId("guide-coachmark")).toBeNull();
  });

  it("navigates to the next step's section when it continues across sections", async () => {
    render(<Harness section="appearance" />);

    await screen.findByTestId("guide-coachmark");
    const progress = screen.getByTestId("guide-coachmark-progress");
    expect(progress.getAttribute("aria-valuenow")).toBe("3");
    expect(progress.getAttribute("aria-valuemax")).toBe("5");

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 3,
    });
    expect(navigateMock).toHaveBeenCalledWith("layout");
  });

  // A skip is a decision, not a pause: the person has been shown the guide and
  // declined it, so the card must not keep asking.
  it("completes the guide when the card is dismissed part-way through", async () => {
    render(<Harness section="appearance" />);
    await screen.findByTestId("guide-coachmark");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(useOnboardingStore.getState().activeSetup).toBeNull();
    expect(useOnboardingStore.getState().setupProgress.appearance).toBe(
      setupGuideLength("appearance"),
    );
  });

  describe("with the Customize editor available", () => {
    beforeEach(() => {
      useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    });

    it("shows the density step on Appearance, where its twin points", async () => {
      useOnboardingStore.setState({
        activeSetup: { id: "appearance", step: 3 },
      });

      render(<Harness section="appearance" />);

      expect(await screen.findByTestId("guide-coachmark")).toBeTruthy();
    });

    it("no longer shows it on Layout, whose rows are withheld", () => {
      useOnboardingStore.setState({
        activeSetup: { id: "appearance", step: 3 },
      });

      render(<Harness section="layout" />);

      expect(screen.queryByTestId("guide-coachmark")).toBeNull();
    });

    it("continues from the font step to the density step without navigating", async () => {
      render(<Harness section="appearance" />);
      await screen.findByTestId("guide-coachmark");

      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      expect(useOnboardingStore.getState().activeSetup).toEqual({
        id: "appearance",
        step: 3,
      });
      expect(navigateMock).not.toHaveBeenCalled();
    });

    it("runs to the end on Appearance and finishes at Getting started", async () => {
      useOnboardingStore.setState({
        activeSetup: { id: "appearance", step: 4 },
      });
      render(<Harness section="appearance" />);
      await screen.findByTestId("guide-coachmark");
      const progress = screen.getByTestId("guide-coachmark-progress");
      expect(progress.getAttribute("aria-valuenow")).toBe("5");
      expect(progress.getAttribute("aria-valuemax")).toBe("5");

      fireEvent.click(screen.getByRole("button", { name: "Done" }));

      expect(useOnboardingStore.getState().activeSetup).toBeNull();
      expect(useOnboardingStore.getState().setupProgress.appearance).toBe(
        setupGuideLength("appearance"),
      );
      expect(navigateMock).toHaveBeenCalledWith("getting-started");
    });

    // The step is shown in the twin's section, so the switch moving under a
    // reader parks the coachmark in a section that no longer shows it. The guide
    // follows its step, and only from the section it was being shown in.
    it("follows a density step to Layout when the switch goes off mid-guide", () => {
      useOnboardingStore.setState({
        activeSetup: { id: "appearance", step: 3 },
      });
      render(<Harness section="appearance" />);
      expect(navigateMock).not.toHaveBeenCalled();

      act(() => {
        useSettingsStore.setState({ visualLayoutEditorEnabled: false });
      });

      expect(navigateMock).toHaveBeenCalledTimes(1);
      expect(navigateMock).toHaveBeenCalledWith("layout");
      // Progress is the guide's, not the section's.
      expect(useOnboardingStore.getState().activeSetup).toEqual({
        id: "appearance",
        step: 3,
      });
    });

    it("follows a density step to Appearance when the switch goes on mid-guide", () => {
      useSettingsStore.setState({ visualLayoutEditorEnabled: false });
      useOnboardingStore.setState({
        activeSetup: { id: "appearance", step: 3 },
      });
      render(<Harness section="layout" />);
      expect(navigateMock).not.toHaveBeenCalled();

      act(() => {
        useSettingsStore.setState({ visualLayoutEditorEnabled: true });
      });

      expect(navigateMock).toHaveBeenCalledTimes(1);
      expect(navigateMock).toHaveBeenCalledWith("appearance");
      expect(useOnboardingStore.getState().activeSetup).toEqual({
        id: "appearance",
        step: 3,
      });
    });

    it("follows the step when the window narrows below md", () => {
      // The viewport hook listens to the media query, so the test owns that
      // listener and fires it the way the browser does on a resize.
      const listeners = new Set<() => void>();
      const original = window.matchMedia;
      window.matchMedia = (query: string): MediaQueryList => {
        const list = original.call(window, query);
        list.addEventListener = (
          _type: string,
          listener: EventListenerOrEventListenerObject,
        ): void => {
          listeners.add(() => {
            if (typeof listener === "function") listener(new Event("change"));
            else listener.handleEvent(new Event("change"));
          });
        };
        return list;
      };
      try {
        setViewportWidth(1280);
        useOnboardingStore.setState({
          activeSetup: { id: "appearance", step: 3 },
        });
        render(<Harness section="appearance" />);

        act(() => {
          setViewportWidth(500);
          for (const listener of listeners) listener();
        });

        expect(navigateMock).toHaveBeenCalledTimes(1);
        expect(navigateMock).toHaveBeenCalledWith("layout");
      } finally {
        window.matchMedia = original;
      }
    });

    it("does not pull back a reader who wandered to another section", () => {
      useOnboardingStore.setState({
        activeSetup: { id: "appearance", step: 3 },
      });
      // Mounted on a section that never showed the step.
      render(<Harness section="general" />);

      act(() => {
        useSettingsStore.setState({ visualLayoutEditorEnabled: false });
      });

      expect(navigateMock).not.toHaveBeenCalled();
    });

    it("does not navigate for a step that lives in the same section either way", () => {
      useOnboardingStore.setState({
        activeSetup: { id: "appearance", step: 2 },
      });
      render(<Harness section="appearance" />);

      act(() => {
        useSettingsStore.setState({ visualLayoutEditorEnabled: false });
      });

      expect(navigateMock).not.toHaveBeenCalled();
    });

    it("draws nothing while a Customize session is running, and resumes after", async () => {
      useOnboardingStore.setState({
        activeSetup: { id: "appearance", step: 3 },
      });
      useCustomizeStore.setState({
        session: {
          scene: "in-place",
          opener: { kind: "none" },
          startedAt: Date.now(),
        },
      });

      const { unmount } = render(<Harness section="appearance" />);
      expect(screen.queryByTestId("guide-coachmark")).toBeNull();
      unmount();

      useCustomizeStore.setState({ session: null });
      render(<Harness section="appearance" />);
      expect(await screen.findByTestId("guide-coachmark")).toBeTruthy();
      expect(useOnboardingStore.getState().activeSetup).toEqual({
        id: "appearance",
        step: 3,
      });
    });
  });
});
