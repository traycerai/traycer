import { lazy, Suspense, type RefObject } from "react";
import { useLayoutLitMoment } from "@/components/layout-editor/lit-moment";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { setupGuide } from "@/stores/onboarding/setup-guides";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
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
  const guide = active === null ? null : setupGuide(active.id);
  const step =
    guide === null || active === null ? null : guide.steps[active.step];
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
  if (active === null || guide === null || step === null) return null;
  if (customizing) return null;
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
        // Escape and the card's X are a skip, and a skipped card is done:
        // the person has been shown the guide and declined it, so leaving it
        // half-finished on the checklist would nag them for a decision they
        // have already made.
        onClose={() => complete(active.id)}
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
