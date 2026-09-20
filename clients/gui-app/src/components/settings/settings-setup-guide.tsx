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
import {
  usePaneFocused,
  usePaneVisible,
} from "@/components/epic-tabs/pane-visibility-context";

const Coachmark = lazy(() =>
  import("@/components/onboarding/onboarding-coachmark").then((module) => ({
    default: module.OnboardingCoachmark,
  })),
);

export function SettingsSetupGuide(props: {
  readonly section: SettingsSectionId;
  readonly rootRef: RefObject<HTMLElement | null>;
  // The host's own non-activating write - see `SettingsPanelForSection`.
  readonly writeSection: (section: SettingsSectionId) => boolean;
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
  //
  // Only while Settings is actually presented: a Settings tab stays mounted
  // behind a task tab, and `navigateToSettingsSection` re-activates it, which
  // would steal the route from the task the reader is in. The comparison
  // baseline is left untouched while hidden, so the flip is still seen - and
  // followed - the moment the surface is shown again. The modal has no pane
  // around it, and the context's default (`true`) counts that as presented.
  const presented = usePaneVisible();
  // Presented is not focused: in a split, Settings can be on screen beside a
  // focused task. Following the step there must not be a command - focusing
  // Settings would take the partner's focus and route - so it moves only what
  // Settings itself shows, through the host's own writer. The tab has one when
  // a partner owns the route (its remembered path is what the pane draws) and
  // none when Settings still owns the route (a focused EMPTY slot leaves it
  // there, and a route change re-focuses Settings). No writer means DEFER, like
  // the hidden case: the baseline stays put and the follow happens when
  // Settings regains focus. The modal has no pane, and counts as focused.
  const focused = usePaneFocused();
  const editor = availability.customizeEditor;
  const { writeSection } = props;
  const previousEditor = useRef(editor);
  useEffect(() => {
    if (!presented) return;
    const before = previousEditor.current;
    if (before !== editor && active !== null && !customizing) {
      const raw = setupGuide(active.id).steps[active.step];
      const was = resolveSetupGuideStep(raw, {
        ...availability,
        customizeEditor: before,
      });
      const now = resolveSetupGuideStep(raw, availability);
      if (was.section === props.section && now.section !== props.section) {
        if (focused) navigateToSettingsSection(now.section);
        else if (!writeSection(now.section)) return;
      }
    }
    previousEditor.current = editor;
  }, [
    editor,
    availability,
    active,
    customizing,
    presented,
    focused,
    props.section,
    writeSection,
  ]);
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
