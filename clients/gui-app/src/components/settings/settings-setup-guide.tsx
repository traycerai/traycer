import { lazy, Suspense, useEffect, type RefObject } from "react";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { setupGuide } from "@/stores/onboarding/setup-guides";
import { scrollPaneToCenter } from "@/components/settings/use-settings-anchor-reveal";

const Coachmark = lazy(() =>
  import("@/components/onboarding/onboarding-coachmark").then((module) => ({
    default: module.OnboardingCoachmark,
  })),
);

export function SettingsSetupGuide(props: {
  readonly section: SettingsSectionId;
  readonly rootRef: RefObject<HTMLElement | null>;
}) {
  const active = useOnboardingStore((state) => state.activeSetup);
  const pause = useOnboardingStore((state) => state.pauseSetup);
  useEffect(() => () => pause(), [pause]);
  if (active === null) return null;
  const guide = setupGuide(active.id);
  const step = guide.steps[active.step];
  if (step.section !== props.section) return null;
  const last = active.step + 1 === guide.steps.length;
  const go = (index: number): void => {
    const target = guide.steps[index];
    if (target.section !== step.section)
      navigateToSettingsSection(target.section);
  };
  return (
    <Suspense fallback={null}>
      <Coachmark
        id={`${active.id}-${active.step}`}
        title={step.title}
        content={step.content}
        progress={{
          step: active.step + 1,
          total: guide.steps.length,
        }}
        rootRef={props.rootRef}
        selector={step.selector}
        onClose={pause}
        onTarget={revealSetting}
        back={
          active.step > 0
            ? () => {
                useOnboardingStore.getState().retreatSetup();
                go(active.step - 1);
              }
            : null
        }
        action={
          // A step the product finishes is the user's to perform, so the card
          // focuses the real control and waits instead of offering Done.
          step.completesOn !== undefined
            ? null
            : {
                label: last ? "Done" : "Continue",
                onClick: () => {
                  useOnboardingStore.getState().advanceSetup();
                  if (last) navigateToSettingsSection("getting-started");
                  else go(active.step + 1);
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
