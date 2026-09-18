import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettingsPanel } from "@/components/settings/panels/appearance-settings-panel";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import {
  resolveSetupGuideStep,
  setupGuide,
  setupGuideStepSection,
  SETUP_GUIDE_IDS,
} from "@/stores/onboarding/setup-guides";
import { useSettingsStore } from "@/stores/settings/settings-store";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/hooks/runner/use-desktop-zoom-bridge", () => ({
  useDesktopZoomBridge: () => null,
}));
vi.mock("@/lib/appearance/curated-wallpapers", () => ({
  fetchCuratedWallpaperManifest: () => Promise.resolve([]),
}));

const OFF: SettingsAvailabilityContext = {
  runnerHost: null,
  featureSettings: null,
  mobileApp: false,
  mobileFooter: false,
  customizeEditor: false,
};
const ON: SettingsAvailabilityContext = { ...OFF, customizeEditor: true };

const DENSITY_STEP = 3;
const ARRANGE_STEP = 4;

describe("appearance setup guide twins", () => {
  it("is untouched with the editor off, and keeps its five steps", () => {
    // A twin replaces a step in place, so an index means the same step in both
    // states and stored progress survives a flip of the switch.
    expect(setupGuide("appearance").steps).toHaveLength(5);
    for (const step of setupGuide("appearance").steps) {
      expect(resolveSetupGuideStep(step, OFF)).toBe(step);
    }
    const steps = setupGuide("appearance").steps;
    expect(steps[DENSITY_STEP].section).toBe("layout");
    expect(steps[ARRANGE_STEP].title).toBe("Arrange the sidebar");
  });

  it("points the last two steps at Appearance with the editor on", () => {
    const steps = setupGuide("appearance").steps;

    const density = resolveSetupGuideStep(steps[DENSITY_STEP], ON);
    const open = resolveSetupGuideStep(steps[ARRANGE_STEP], ON);

    expect(density.section).toBe("appearance");
    expect(density.title).toBe("Choose a density");
    expect(open.section).toBe("appearance");
    expect(open.title).toBe("Open Customize");
    expect(open.content).toBe(
      "Drag the rail's tiles to reorder them once you are in.",
    );
  });

  it("changes no other step, and no step's completion rule", () => {
    for (const guide of SETUP_GUIDE_IDS) {
      setupGuide(guide).steps.forEach((step, index) => {
        const on = resolveSetupGuideStep(step, ON);
        expect(on.advanceOn).toBe(step.advanceOn);
        expect(on.completesOn).toBe(step.completesOn);
        if (guide !== "appearance" || index < DENSITY_STEP) {
          expect(on).toBe(step);
        }
      });
    }
  });

  it("resumes on the section the shell shows the step in", () => {
    expect(setupGuideStepSection("appearance", DENSITY_STEP, OFF)).toBe(
      "layout",
    );
    expect(setupGuideStepSection("appearance", DENSITY_STEP, ON)).toBe(
      "appearance",
    );
    expect(setupGuideStepSection("appearance", 0, ON)).toBe("appearance");
  });
});

describe("the twins' selectors against the real Appearance page", () => {
  beforeEach(() => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });
  });

  it("each one finds the control it names, and only in the right shell", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <AppearanceSettingsPanel />
      </QueryClientProvider>,
    );
    const steps = setupGuide("appearance").steps;

    const density = container.querySelector(
      resolveSetupGuideStep(steps[DENSITY_STEP], ON).selector,
    );
    const open = container.querySelector(
      resolveSetupGuideStep(steps[ARRANGE_STEP], ON).selector,
    );

    expect(density?.getAttribute("aria-label")).toBe("Layout preset");
    expect(open?.textContent).toBe("Customize layout");
    // The un-twinned selectors point at rows this shell no longer draws.
    expect(container.querySelector(steps[DENSITY_STEP].selector)).toBeNull();
    expect(container.querySelector(steps[ARRANGE_STEP].selector)).toBeNull();
  });
});
