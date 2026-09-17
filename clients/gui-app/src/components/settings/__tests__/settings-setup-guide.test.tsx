import { StrictMode, useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSetupGuide } from "@/components/settings/settings-setup-guide";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import type { SettingsSectionId } from "@/lib/settings-sections";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateMock,
}));

vi.mock("@/components/onboarding/onboarding-coachmark", () => ({
  OnboardingCoachmark: (props: {
    readonly progress: { readonly step: number; readonly total: number } | null;
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

  afterEach(cleanup);

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
});
