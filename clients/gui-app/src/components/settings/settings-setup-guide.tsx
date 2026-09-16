import { lazy, Suspense, useEffect, type RefObject } from "react";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import {
  useOnboardingStore,
  SETUP_GUIDE_LENGTHS,
  type SetupGuideId,
} from "@/stores/onboarding/onboarding-store";
import { APPEARANCE } from "./panels/appearance-settings.definitions";
import { scrollPaneToCenter } from "@/components/settings/use-settings-anchor-reveal";

const Coachmark = lazy(() =>
  import("@/components/onboarding/onboarding-coachmark").then((module) => ({
    default: module.OnboardingCoachmark,
  })),
);

const GUIDES = {
  agents: {
    section: "agents",
    steps: [
      {
        selector: "[data-agent-selection-guide-editor-shell]",
        title: "Agent selection",
        content:
          "Guide how agents choose providers, models, and reasoning effort for delegated tasks.",
      },
    ],
  },
  appearance: {
    section: "appearance",
    steps: [
      {
        selector: `[data-settings-anchor="${APPEARANCE.definitions.themeMode.anchor}"] [role="group"]`,
        title: "Choose a theme",
        content: "Changes apply immediately.",
      },
      {
        selector: `[data-settings-anchor="${APPEARANCE.definitions.wallpaper.anchor}"] button`,
        title: "Customize your start page",
        content:
          "Choose a wallpaper, then adjust the greeting and recent tasks below.",
      },
      {
        selector: `[data-settings-anchor="${APPEARANCE.definitions.uiFont.anchor}"] button`,
        title: "Adjust your fonts",
        content:
          "Set the interface font and size. Code and prompt fonts are below.",
      },
    ],
  },
  cookies: {
    section: "general",
    steps: [
      {
        selector: '[data-testid="settings-saved-logins"]',
        title: "Bring your browser sign-ins",
        content:
          "Enable saving, then choose a source. You’ll review the sites before importing any cookies.",
      },
    ],
  },
} as const satisfies Record<
  SetupGuideId,
  {
    section: SettingsSectionId;
    steps: readonly { selector: string; title: string; content: string }[];
  }
>;

export function SettingsSetupGuide(props: {
  readonly section: SettingsSectionId;
  readonly rootRef: RefObject<HTMLElement | null>;
}) {
  const active = useOnboardingStore((state) => state.activeSetup);
  const pause = useOnboardingStore((state) => state.pauseSetup);
  useEffect(() => () => pause(), [pause]);
  const guide = active === null ? null : GUIDES[active.id];
  const step = active === null ? null : (guide?.steps[active.step] ?? null);
  const visible = guide?.section === props.section;
  if (!visible || active === null || step === null) return null;
  const last = active.step + 1 === SETUP_GUIDE_LENGTHS[active.id];
  return (
    <Suspense fallback={null}>
      <Coachmark
        id={`${active.id}-${active.step}`}
        title={step.title}
        content={step.content}
        progress={
          SETUP_GUIDE_LENGTHS[active.id] > 1
            ? `${active.step + 1} of ${SETUP_GUIDE_LENGTHS[active.id]}`
            : null
        }
        rootRef={props.rootRef}
        selector={step.selector}
        onClose={pause}
        onTarget={revealSetting}
        back={
          active.step > 0 ? useOnboardingStore.getState().retreatSetup : null
        }
        action={
          active.id === "cookies"
            ? null
            : {
                label: last ? "Done" : "Continue",
                onClick: () => {
                  useOnboardingStore.getState().advanceSetup();
                  if (last) navigateToSettingsSection("getting-started");
                },
              }
        }
      />
    </Suspense>
  );
}

function revealSetting(target: HTMLElement, keyboard: boolean): void {
  scrollPaneToCenter(target, keyboard ? "instant" : null);
}
