export type OnboardingStepId = "task-tabs" | "providers" | "session-import";

export interface OnboardingStep {
  readonly id: OnboardingStepId;
  readonly label: string;
  readonly title: string;
  readonly subtitle: string;
}

export const ONBOARDING_STEPS: ReadonlyArray<OnboardingStep> = [
  {
    id: "task-tabs",
    label: "Workspace",
    title: "A home for all your work.",
    subtitle: "Tasks, agents, browsers and artifacts, side by side.",
  },
  {
    id: "providers",
    label: "Providers",
    title: "Choose your agents.",
    subtitle: "Keep your accounts, skills and plugins.",
  },
  {
    id: "session-import",
    label: "Import",
    title: "Pick up where you left off.",
    subtitle: "Bring your Claude Code, Codex and OpenCode chats.",
  },
];

const WITHOUT_IMPORT = ONBOARDING_STEPS.slice(0, 2);

/**
 * Act 1 is the one act whose copy differs on a phone - the workspace it
 * describes is a drawer and a tab switcher rather than tiles side by side, and
 * the phone layout renders no subtitle at all past act 1, so this is the only
 * one that has to read on both. The title is shared with the desktop.
 *
 * Every other act, the import one included, is the desktop act under the same
 * availability gate: a phone that can reach a host that scans sessions can
 * import from it, and dropping the act there stranded the feature on a device
 * whose host supported it perfectly well.
 */
const PHONE_TASK_TABS: OnboardingStep = {
  ...ONBOARDING_STEPS[0],
  subtitle: "Tasks in the menu. Swipe for the rest.",
};

function withPhoneCopy(
  steps: ReadonlyArray<OnboardingStep>,
): ReadonlyArray<OnboardingStep> {
  return steps.map((step) =>
    step.id === "task-tabs" ? PHONE_TASK_TABS : step,
  );
}

/**
 * `phone` is the VIEWPORT's answer (`useIsMobileViewport`), not the installed
 * app's: the copy belongs to the layout that renders it, so a narrow desktop
 * window - which gets the phone shell and the phone scenes - gets the phone
 * line too.
 */
export function onboardingStepsFor(
  sessionImportAvailable: boolean,
  phone: boolean,
): ReadonlyArray<OnboardingStep> {
  const steps = sessionImportAvailable ? ONBOARDING_STEPS : WITHOUT_IMPORT;
  return phone ? withPhoneCopy(steps) : steps;
}
