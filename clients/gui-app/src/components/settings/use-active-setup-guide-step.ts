import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { isLayoutEditorAvailable } from "@/lib/settings/settings-availability";
import {
  clampOnboardingStep,
  useOnboardingStore,
} from "@/stores/onboarding/onboarding-store";
import {
  setupGuideStepsFor,
  type SetupGuideId,
  type SetupGuideStep,
} from "@/stores/onboarding/setup-guides";

export interface ActiveSetupGuideStep {
  readonly id: SetupGuideId;
  /** The steps this shell walks, the layout editor's door left out where it cannot open. */
  readonly steps: ReadonlyArray<SetupGuideStep>;
  /** The step's index in `steps`. */
  readonly index: number;
  readonly step: SetupGuideStep;
}

/**
 * The setup guide step that is up right now, or `null` when no guide is
 * running. The one place a stored step is resolved to the step a shell shows:
 * the guide card (`SettingsSetupGuide`) draws it, and a master-detail page
 * reads it to pick the area the step points into.
 */
export function useActiveSetupGuideStep(): ActiveSetupGuideStep | null {
  const active = useOnboardingStore((state) => state.activeSetup);
  // Where the editor can never open, the guide ends on the page before its
  // door (`requiresLayoutEditor`) rather than pointing at a missing control.
  const availability = useSettingsAvailabilityContext();
  if (active === null) return null;
  const steps = setupGuideStepsFor(active.id, {
    layoutEditor: isLayoutEditorAvailable(availability),
  });
  // Resumed progress is stored against the guide's FULL step count
  // (`setupGuideLength`), but a shell that cannot open the layout editor
  // filters that door's trailing step out of `steps`. A step persisted at or
  // past that point clamps to the last step this shell actually shows,
  // rather than indexing past the filtered array and vanishing.
  const index = clampOnboardingStep(active.step, steps.length);
  const step = steps.at(index);
  if (step === undefined) return null;
  return { id: active.id, steps, index, step };
}
