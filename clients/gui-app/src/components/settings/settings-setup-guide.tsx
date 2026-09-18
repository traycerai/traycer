import { lazy, Suspense, useEffect, useRef, type RefObject } from "react";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import {
  resolveSetupGuideStep,
  setupGuide,
} from "@/stores/onboarding/setup-guides";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { useCustomizeStore } from "@/stores/customize/customize-store";
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
  const availability = useSettingsAvailabilityContext();
  // No guide step runs inside a Customize session: the editor owns the screen
  // and its Escape, and a coachmark pointing into Settings would float over it.
  // The guide resumes at the same step when the session ends.
  const customizing = useCustomizeStore((state) => state.session !== null);
  // A step whose twin applies is shown in the twin's section, so when the
  // editor's availability flips (the switch, or the window crossing `md`) the
  // step the reader is looking at can move to another section under them. The
  // guide follows it, the way Continue would - but only from the section the
  // step was being shown in, so a reader who wandered to another section by
  // hand is not pulled back, and never on a render that changed nothing.
  const editor = availability.customizeEditor;
  const previousEditor = useRef(editor);
  useEffect(() => {
    const before = previousEditor.current;
    previousEditor.current = editor;
    if (before === editor || active === null || customizing) return;
    const raw = setupGuide(active.id).steps[active.step];
    const was = resolveSetupGuideStep(raw, {
      ...availability,
      customizeEditor: before,
    });
    const now = resolveSetupGuideStep(raw, availability);
    if (was.section === props.section && now.section !== props.section) {
      navigateToSettingsSection(now.section);
    }
  }, [editor, availability, active, customizing, props.section]);
  // Nothing on unmount: development roots render under StrictMode, whose mount
  // probe runs every effect's cleanup once, which would clear the guide the
  // moment it started. `activeSetup` is session-local presence, so a closed
  // Settings simply resumes the same step when it reopens - and closing the
  // surface is not a user skip, so it must not finish the card either.
  if (active === null || customizing) return null;
  const guide = setupGuide(active.id);
  const step = resolveSetupGuideStep(guide.steps[active.step], availability);
  if (step.section !== props.section) return null;
  const last = active.step + 1 === guide.steps.length;
  const go = (index: number): void => {
    const target = resolveSetupGuideStep(guide.steps[index], availability);
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
