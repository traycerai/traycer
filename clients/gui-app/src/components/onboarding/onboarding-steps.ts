import { isMobileApp } from "@/lib/mobile-app";

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
const MOBILE_STEPS: ReadonlyArray<OnboardingStep> = [
  {
    ...ONBOARDING_STEPS[0],
    subtitle:
      "Find tasks in the menu. Use the tab switcher for chats, browsers, and files.",
  },
  ONBOARDING_STEPS[1],
];

export function onboardingStepsFor(
  sessionImportAvailable: boolean,
): ReadonlyArray<OnboardingStep> {
  if (isMobileApp()) return MOBILE_STEPS;
  return sessionImportAvailable ? ONBOARDING_STEPS : WITHOUT_IMPORT;
}
