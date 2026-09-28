import { StrictMode, useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSetupGuide } from "@/components/settings/settings-setup-guide";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { setupGuideLength } from "@/stores/onboarding/setup-guides";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

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
    useLayoutEditorStore.setState({ session: null });
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
    expect(progress.getAttribute("aria-valuemax")).toBe("6");

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 3,
    });
    expect(navigateMock).toHaveBeenCalledWith("layout");
  });

  it("does not navigate when Continue stays within the same section", () => {
    useOnboardingStore.setState({ activeSetup: { id: "appearance", step: 0 } });
    render(<Harness section="appearance" />);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 1,
    });
    expect(navigateMock).not.toHaveBeenCalled();
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

  it("runs to the end on Layout and finishes at Getting started", async () => {
    useOnboardingStore.setState({ activeSetup: { id: "appearance", step: 5 } });
    render(<Harness section="layout" />);
    await screen.findByTestId("guide-coachmark");
    const progress = screen.getByTestId("guide-coachmark-progress");
    expect(progress.getAttribute("aria-valuenow")).toBe("6");
    expect(progress.getAttribute("aria-valuemax")).toBe("6");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(useOnboardingStore.getState().activeSetup).toBeNull();
    expect(useOnboardingStore.getState().setupProgress.appearance).toBe(
      setupGuideLength("appearance"),
    );
    expect(navigateMock).toHaveBeenCalledWith("getting-started");
  });

  // L-50: the last step SHOWS the canvas signal on the real chrome instead of
  // entering the editor, and closing the step puts the chrome back.
  it("lights the chrome around Settings on the final step only", async () => {
    useOnboardingStore.setState({ activeSetup: { id: "appearance", step: 4 } });
    const { unmount } = render(<Harness section="layout" />);
    await screen.findByTestId("guide-coachmark");
    expect(document.documentElement.hasAttribute("data-layout-lit")).toBe(
      false,
    );
    unmount();

    useOnboardingStore.setState({ activeSetup: { id: "appearance", step: 5 } });
    render(<Harness section="layout" />);
    await screen.findByTestId("guide-coachmark");

    expect(document.documentElement.getAttribute("data-layout-lit")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(document.documentElement.hasAttribute("data-layout-lit")).toBe(
      false,
    );
  });

  it("does not light the chrome while the final step's section is elsewhere", () => {
    useOnboardingStore.setState({ activeSetup: { id: "appearance", step: 5 } });
    render(<Harness section="appearance" />);

    expect(screen.queryByTestId("guide-coachmark")).toBeNull();
    expect(document.documentElement.hasAttribute("data-layout-lit")).toBe(
      false,
    );
  });

  it("draws nothing while a layout-editor session is running, and resumes after", async () => {
    useOnboardingStore.setState({
      activeSetup: { id: "appearance", step: 3 },
    });
    useLayoutEditorStore.setState({
      session: {
        entry: "pointer",
        source: "direct_ui",
        startedAt: Date.now(),
        origin: { kind: "tab" },
      },
    });

    const { unmount } = render(<Harness section="layout" />);
    expect(screen.queryByTestId("guide-coachmark")).toBeNull();
    unmount();

    useLayoutEditorStore.setState({ session: null });
    render(<Harness section="layout" />);
    expect(await screen.findByTestId("guide-coachmark")).toBeTruthy();
    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 3,
    });
  });
});
