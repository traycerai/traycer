import { lazy, Suspense, type RefObject } from "react";
import { useLayoutLitMoment } from "@/components/layout-editor/lit-moment";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { setupGuideStepsFor } from "@/stores/onboarding/setup-guides";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { isLayoutEditorAvailable } from "@/lib/settings/settings-availability";
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
  const complete = useOnboardingStore((state) => state.completeSetup);
  // No guide step runs inside a layout-editor session: the editor owns the
  // screen and its Escape, and a coachmark pointing into Settings would float
  // over it. The guide resumes at the same step when the session ends.
  const customizing = useLayoutEditorStore((state) => state.session !== null);
  // Where the editor can never open, the guide ends on the page before its
  // door (`requiresLayoutEditor`) rather than pointing at a missing control.
  const availability = useSettingsAvailabilityContext();
  const editorAvailable = isLayoutEditorAvailable(availability);
  const steps =
    active === null
      ? []
      : setupGuideStepsFor(active.id, { layoutEditor: editorAvailable });
  // Resumed progress is stored against the guide's FULL step count
  // (`setupGuideLength`), but a shell that cannot open the layout editor
  // filters that door's trailing step out of `steps`. A step persisted at or
  // past that point clamps to the last step this shell actually shows,
  // rather than indexing past the filtered array and vanishing.
  const displayStep =
    active === null || steps.length === 0
      ? 0
      : Math.min(active.step, steps.length - 1);
  const step = active === null ? null : (steps[displayStep] ?? null);
  // Resolved above the early returns, because it is a hook: the lit moment
  // belongs to the step that asked for it and ends when that step does,
  // however it ends - Continue, Escape, or the surface closing (L-50).
  useLayoutLitMoment(
    !customizing &&
      step !== null &&
      step.litChrome === true &&
      step.section === props.section,
  );
  // Nothing on unmount: development roots render under StrictMode, whose mount
  // probe runs every effect's cleanup once, which would clear the guide the
  // moment it started. `activeSetup` is session-local presence, so a closed
  // Settings simply resumes the same step when it reopens - and closing the
  // surface is not a user skip, so it must not finish the card either.
  if (active === null || step === null) return null;
  if (customizing) return null;
  if (step.section !== props.section) return null;
  const last = displayStep + 1 === steps.length;
  const go = (index: number): void => {
    const target = steps[index];
    if (target.section !== step.section)
      navigateToSettingsSection(target.section);
  };
  return (
    <Suspense fallback={null}>
      <Coachmark
        id={`${active.id}-${displayStep}`}
        title={step.title}
        content={step.content}
        progress={{
          step: displayStep + 1,
          total: steps.length,
        }}
        rootRef={props.rootRef}
        selector={step.selector}
        // Escape and the card's X are a skip, and a skipped card is done:
        // the person has been shown the guide and declined it, so leaving it
        // half-finished on the checklist would nag them for a decision they
        // have already made.
        onClose={() => complete(active.id)}
        onTarget={revealSetting}
        back={
          displayStep > 0
            ? () => {
                useOnboardingStore.getState().retreatSetup();
                go(displayStep - 1);
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
                  // Completing rather than advancing: the last step SHOWN
                  // is not the stored last one where a step was left out.
                  if (last) {
                    complete(active.id);
                    navigateToSettingsSection("getting-started");
                  } else {
                    useOnboardingStore.getState().advanceSetup();
                    go(displayStep + 1);
                  }
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
