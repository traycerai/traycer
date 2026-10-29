import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HarnessModelPickerModelSettingsFooter } from "@/components/home/pickers/harness-model-picker-footers";
import { HarnessModelTrigger } from "@/components/home/pickers/harness-model-trigger";
import type { HarnessModelSelection } from "@/components/home/data/landing-options";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

const SELECTION: HarnessModelSelection = {
  harnessId: "cursor",
  modelSlug: "example",
  profileId: null,
};

function renderTrigger(maxModeRequired: boolean) {
  render(
    <HarnessModelTrigger
      ultracodeRequested={false}
      selection={SELECTION}
      label="Example"
      reasoningLabel="High"
      reasoningStep={{ index: 2, count: 3 }}
      reasoningIndicator="text"
      serviceTierLabel={null}
      serviceTierActive={false}
      maxModeRequired={maxModeRequired}
      profileLabel={null}
      profileAccentDot={null}
      isLoading={false}
      disabled={false}
      labelDisplay="responsive"
    />,
  );
}

describe("<HarnessModelTrigger /> Max Mode marker", () => {
  afterEach(() => cleanup());

  it("shows the Max marker and names Max Mode in the accessible summary when required", () => {
    renderTrigger(true);
    const trigger = screen.getByRole("button");
    expect(trigger.getAttribute("aria-label")).toContain("Max Mode");
    expect(trigger.textContent).toContain("Max");
  });

  it("shows neither when not required", () => {
    renderTrigger(false);
    const trigger = screen.getByRole("button");
    expect(trigger.getAttribute("aria-label")).not.toContain("Max Mode");
    expect(trigger.textContent).not.toContain("Max");
  });
});

describe("<HarnessModelPickerModelSettingsFooter /> Max Mode badge", () => {
  beforeEach(() => {
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  });
  afterEach(() => {
    cleanup();
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  });

  it("shows the badge for a Max-only row with no Fast and no efforts", () => {
    render(
      <HarnessModelPickerModelSettingsFooter
        pickerOpen
        reasoning={null}
        serviceTier={null}
        maxMode
      />,
    );
    expect(screen.getByTestId("model-max-mode-badge").textContent).toBe(
      "Max Mode",
    );
  });

  it("renders nothing when neither controls nor Max Mode apply", () => {
    const { container } = render(
      <HarnessModelPickerModelSettingsFooter
        pickerOpen
        reasoning={null}
        serviceTier={null}
        maxMode={false}
      />,
    );
    expect(screen.queryByTestId("model-max-mode-badge")).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
